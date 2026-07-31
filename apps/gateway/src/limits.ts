/**
 * Per-key concurrency and RPM enforcement (PLAN.md §7 "Concurrency decisions").
 *
 * §7 fixes two numbers per CUSTOMER API KEY (not per user, not per IP):
 *   - at most 5 active requests   → `concurrency_limit` (429)
 *   - at most 100 requests/minute → `rate_limit` (429)
 *
 * WHY THIS IS NOT `@fastify/rate-limit`. That plugin keys on IP by default and
 * counts requests, not concurrency. Both of §7's limits are per-key, and the
 * concurrency one is a gauge that must fall when a stream ENDS — which for an SSE
 * turn is minutes after the request was accepted. A request-counting plugin
 * cannot express "5 in flight", so the concurrency half would silently not exist.
 * `@fastify/rate-limit` still guards the unauthenticated surface (a caller with
 * no valid key never reaches this file), which is a different job.
 *
 * WHY A SLIDING WINDOW AND NOT A FIXED ONE. A fixed 60s bucket lets a caller send
 * 100 requests at 11:59.9 and 100 more at 12:00.1 — 200 in 200ms, twice the
 * documented ceiling, which is exactly the burst that hurts the provider pool.
 * Timestamps are kept per key and pruned by age, so the limit holds across any
 * 60-second span.
 *
 * The clock is injected (`Clock`) so tests are deterministic; §"Conventions"
 * forbids `Date.now()` in business logic and this is business logic.
 */

import { BosandaError } from "@bosanda/protocol";
import { MINUTE_MS, type Clock } from "@bosanda/shared";

export type LimiterOptions = {
  clock: Clock;
  /** §7: 5. */
  maxActive: number;
  /** §7: 100. */
  maxPerMinute: number;
  /**
   * Sliding window width. 60s per §7; configurable only so tests can use a
   * short window without sleeping.
   */
  windowMs?: number;
};

/** Released when the request finishes, whether it succeeded, failed, or aborted. */
export type Slot = {
  readonly keyId: string;
  /** Idempotent: double-release must not drive the gauge negative. */
  release(): void;
  readonly released: boolean;
};

type KeyState = {
  active: number;
  /** Ascending request timestamps within the window. */
  recent: number[];
};

export class KeyLimiter {
  private readonly clock: Clock;
  private readonly maxActive: number;
  private readonly maxPerMinute: number;
  private readonly windowMs: number;
  private readonly keys = new Map<string, KeyState>();

  constructor(options: LimiterOptions) {
    this.clock = options.clock;
    this.maxActive = options.maxActive;
    this.maxPerMinute = options.maxPerMinute;
    this.windowMs = options.windowMs ?? MINUTE_MS;
  }

  /** In-flight requests for one key. */
  activeCount(keyId: string): number {
    return this.keys.get(keyId)?.active ?? 0;
  }

  /** In-flight requests across every key — the §17 `bosanda_active_requests` gauge. */
  totalActive(): number {
    let total = 0;
    for (const state of this.keys.values()) total += state.active;
    return total;
  }

  /** Requests recorded in the current window for one key. */
  windowCount(keyId: string): number {
    const state = this.keys.get(keyId);
    if (!state) return 0;
    this.prune(state, this.clock.now().getTime());
    return state.recent.length;
  }

  /**
   * Reserves one slot, or throws the §8-mapped 429.
   *
   * ORDER MATTERS. RPM is checked BEFORE concurrency: a caller hammering the API
   * with instantly-failing requests is rate-limited rather than being told it has
   * too many in flight, which would be a confusing (and wrong) diagnosis. Both
   * are 429 but the codes differ, and §17 counts them separately.
   *
   * The RPM timestamp is recorded only when the slot is actually granted. A
   * rejected request must not consume window budget, or a caller that is already
   * over its concurrency cap would extend its own rate-limit penalty by retrying.
   */
  acquire(keyId: string): Slot {
    const now = this.clock.now().getTime();
    const state = this.keys.get(keyId) ?? { active: 0, recent: [] };

    this.prune(state, now);

    if (state.recent.length >= this.maxPerMinute) {
      const oldest = state.recent[0];
      // Seconds until the window frees a slot — safe to expose (it is derived
      // from the caller's own traffic, not from any other tenant's).
      const retryAfterMs = oldest === undefined ? this.windowMs : oldest + this.windowMs - now;
      throw new BosandaError("rate_limit", {
        internalDetail:
          `key ${keyId} sent ${state.recent.length} requests in the last ` +
          `${this.windowMs}ms (limit ${this.maxPerMinute})`,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      });
    }

    if (state.active >= this.maxActive) {
      throw new BosandaError("concurrency_limit", {
        internalDetail: `key ${keyId} has ${state.active} active requests (limit ${this.maxActive})`,
      });
    }

    state.active += 1;
    state.recent.push(now);
    this.keys.set(keyId, state);

    let released = false;
    return {
      keyId,
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        const current = this.keys.get(keyId);
        if (!current) return;
        current.active = Math.max(0, current.active - 1);
        // Drop the entry once a key is idle AND has no window history, so a
        // long-lived process does not accumulate a map entry per key seen.
        // Keeping it while `recent` is non-empty is required for correctness:
        // forgetting the timestamps would reset the RPM window.
        if (current.active === 0 && current.recent.length === 0) this.keys.delete(keyId);
      },
    };
  }

  /**
   * Drops timestamps older than the window.
   *
   * `recent` is append-only in ascending order, so everything expired is a
   * prefix and one splice removes it.
   */
  private prune(state: KeyState, now: number): void {
    const cutoff = now - this.windowMs;
    let keep = 0;
    while (keep < state.recent.length) {
      const at = state.recent[keep];
      if (at === undefined || at > cutoff) break;
      keep += 1;
    }
    if (keep > 0) state.recent.splice(0, keep);
  }

  /**
   * Drops window history for idle keys — for a periodic sweep so an unbounded
   * key space cannot grow the map forever. Keys with active requests are never
   * removed.
   */
  sweep(): number {
    const now = this.clock.now().getTime();
    let removed = 0;
    for (const [keyId, state] of this.keys) {
      this.prune(state, now);
      if (state.active === 0 && state.recent.length === 0) {
        this.keys.delete(keyId);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test-only reset. */
  reset(): void {
    this.keys.clear();
  }
}
