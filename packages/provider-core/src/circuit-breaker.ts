/**
 * Per-account circuit breaker (PLAN.md §7 "Circuit breaker", §3 "automatic
 * circuit opening when compatibility errors exceed a threshold").
 *
 * States and transitions:
 *
 *   closed  --N consecutive failures within failureWindowMs-->  open
 *   open    --openMs elapsed-------------------------------->   half_open
 *   half_open --trial succeeds------------------------------->  closed
 *   half_open --trial fails--------------------------------->   open (immediately)
 *
 * Two decisions worth spelling out:
 *
 *  1. The failure counter is CONSECUTIVE and also window-bounded. Consecutive
 *     alone would let an account that fails every other request stay closed
 *     forever. A window alone would count failures spread across an hour as if
 *     they were a burst. Requiring N failures with no success between them AND
 *     within `failureWindowMs` targets the actual signal: a burst of failures
 *     right now.
 *
 *  2. Half-open admits at most `halfOpenMaxTrials` concurrent probes (default 1).
 *     §7: "half-open probes admit only a small number of test requests". Without
 *     a cap, the moment an account becomes half-open every queued request pours
 *     into a provider that is probably still broken.
 *
 * ALL-ACCOUNTS-TRIPPED BEHAVIOUR (required by the assignment, and the reason
 * this breaker is per-account rather than global):
 *
 *   This breaker never permanently opens the pool by itself. `open` is not a
 *   terminal state — it is bounded by `openMs`, after which the account becomes
 *   half-open and admits a trial. So if every account trips at once (a total
 *   upstream outage, the realistic case), the pool self-heals: after `openMs`
 *   every account offers a probe, and the first success closes that account and
 *   restores capacity.
 *
 *   While every account is open, `SchedulerAndFriends` have no candidates and
 *   the gateway returns `no_healthy_provider` (503) — the correct answer per §8,
 *   and it recovers on its own without operator action. What the breaker must
 *   NOT do is latch: only an auth/revocation failure disables an account until
 *   admin action (§7), and that is `credential_invalid` on the account record,
 *   not a breaker state. See `test/circuit-breaker.test.ts`
 *   ("all accounts tripped").
 */

import { addMs, type Clock } from "@bosanda/shared";
import type { BosandaError } from "@bosanda/protocol";

export type CircuitState = "closed" | "open" | "half_open";

export type CircuitBreakerOptions = {
  clock: Clock;
  /** Consecutive failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /**
   * Failures older than this no longer count toward the threshold.
   * Default 60s.
   */
  failureWindowMs?: number;
  /** How long `open` lasts before a half-open trial is allowed. Default 30s. */
  openMs?: number;
  /** Concurrent trials permitted in half_open. Default 1. */
  halfOpenMaxTrials?: number;
};

type Entry = {
  state: CircuitState;
  consecutiveFailures: number;
  firstFailureAt: Date | null;
  lastFailureAt: Date | null;
  /** When `open` began; null in other states. */
  openedAt: Date | null;
  /** Trials currently in flight while half_open. */
  trialsInFlight: number;
  /** Operator-facing. */
  reason: string;
};

export type CircuitSnapshot = {
  accountId: string;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: Date | null;
  reason: string;
};

const freshEntry = (): Entry => ({
  state: "closed",
  consecutiveFailures: 0,
  firstFailureAt: null,
  lastFailureAt: null,
  openedAt: null,
  trialsInFlight: 0,
  reason: "closed: no recent failures",
});

export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly openMs: number;
  private readonly halfOpenMaxTrials: number;

  constructor(options: CircuitBreakerOptions) {
    this.clock = options.clock;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
    this.openMs = options.openMs ?? 30_000;
    this.halfOpenMaxTrials = options.halfOpenMaxTrials ?? 1;
  }

  /**
   * Current state, applying the time-based open -> half_open transition.
   *
   * Reading advances the state machine because there is no timer: a breaker
   * driven by setTimeout would need cleanup on shutdown and would not respect an
   * injected clock. Deriving the state on read keeps it purely a function of
   * (stored state, now).
   */
  stateOf(accountId: string, now: Date = this.clock.now()): CircuitState {
    const entry = this.entries.get(accountId);
    if (!entry) return "closed";

    if (
      entry.state === "open" &&
      entry.openedAt !== null &&
      now.getTime() - entry.openedAt.getTime() >= this.openMs
    ) {
      entry.state = "half_open";
      entry.trialsInFlight = 0;
      entry.reason = "half_open: open window elapsed, admitting trial";
    }
    return entry.state;
  }

  /**
   * Whether a request may be sent to this account right now.
   *
   * `closed` -> yes. `open` -> no. `half_open` -> only while trial slots remain,
   * which is what keeps a recovering upstream from being flooded.
   */
  allowsRequest(accountId: string, now: Date = this.clock.now()): boolean {
    const state = this.stateOf(accountId, now);
    if (state === "closed") return true;
    if (state === "open") return false;
    const entry = this.entries.get(accountId);
    if (!entry) return true;
    return entry.trialsInFlight < this.halfOpenMaxTrials;
  }

  /**
   * Claims a half-open trial slot. Returns false when no slot is free.
   *
   * The scheduler calls this as part of reserving a slot so that two concurrent
   * requests cannot both believe they are "the" probe.
   */
  tryAcquireTrial(accountId: string, now: Date = this.clock.now()): boolean {
    const state = this.stateOf(accountId, now);
    if (state === "closed") return true;
    if (state === "open") return false;
    const entry = this.entries.get(accountId);
    if (!entry) return true;
    if (entry.trialsInFlight >= this.halfOpenMaxTrials) return false;
    entry.trialsInFlight += 1;
    return true;
  }

  /** Releases a trial slot without recording an outcome (e.g. client abort). */
  releaseTrial(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    if (entry.trialsInFlight > 0) entry.trialsInFlight -= 1;
  }

  /**
   * Records a success: closes the circuit and clears failure history.
   *
   * A success in `half_open` closes it — that is the whole point of the probe.
   * A success in `closed` resets the consecutive counter, which is what makes
   * the threshold "consecutive" rather than cumulative.
   */
  recordSuccess(accountId: string, now: Date = this.clock.now()): void {
    // Read the state BEFORE overwriting the entry, so the reason string can say
    // whether this was a recovery probe or an ordinary success.
    const wasHalfOpen = this.stateOf(accountId, now) === "half_open";
    this.entries.set(accountId, {
      ...freshEntry(),
      reason: wasHalfOpen ? "closed: half-open trial succeeded" : "closed: success",
    });
  }

  /**
   * Records a failure.
   *
   * In `half_open` a single failure re-opens immediately and restarts the full
   * `openMs` window — the probe existed precisely to answer "is it better yet",
   * and the answer was no. Counting toward the threshold again would need N more
   * probes against a provider we already know is failing.
   */
  recordFailure(
    accountId: string,
    error: BosandaError,
    now: Date = this.clock.now(),
  ): CircuitState {
    const state = this.stateOf(accountId, now);
    const entry = this.entries.get(accountId) ?? freshEntry();

    if (entry.trialsInFlight > 0) entry.trialsInFlight -= 1;

    if (state === "half_open") {
      const reopened: Entry = {
        ...entry,
        state: "open",
        openedAt: now,
        lastFailureAt: now,
        consecutiveFailures: entry.consecutiveFailures + 1,
        trialsInFlight: 0,
        reason: `open: half-open trial failed with ${error.code}`,
      };
      this.entries.set(accountId, reopened);
      return "open";
    }

    // Window handling: a failure long after the previous one starts a new burst.
    const withinWindow =
      entry.firstFailureAt !== null &&
      now.getTime() - entry.firstFailureAt.getTime() <= this.failureWindowMs;

    const consecutiveFailures = withinWindow ? entry.consecutiveFailures + 1 : 1;
    const firstFailureAt = withinWindow ? entry.firstFailureAt : now;

    const next: Entry = {
      ...entry,
      consecutiveFailures,
      firstFailureAt,
      lastFailureAt: now,
      state: entry.state,
      reason: `closed: ${consecutiveFailures}/${this.failureThreshold} failures (${error.code})`,
    };

    if (consecutiveFailures >= this.failureThreshold) {
      next.state = "open";
      next.openedAt = now;
      next.trialsInFlight = 0;
      next.reason =
        `open: ${consecutiveFailures} consecutive failures ` +
        `within ${this.failureWindowMs}ms (latest ${error.code})`;
    }

    this.entries.set(accountId, next);
    return next.state;
  }

  snapshot(accountId: string, now: Date = this.clock.now()): CircuitSnapshot {
    const state = this.stateOf(accountId, now);
    const entry = this.entries.get(accountId);
    return {
      accountId,
      state,
      consecutiveFailures: entry?.consecutiveFailures ?? 0,
      openedAt: entry?.openedAt ?? null,
      reason: entry?.reason ?? "closed: no recent failures",
    };
  }

  /** For the admin dashboard (§15) and the §17 circuit-state gauge. */
  snapshotAll(now: Date = this.clock.now()): CircuitSnapshot[] {
    return [...this.entries.keys()].map((id) => this.snapshot(id, now));
  }

  /** Operator override: force back to closed. */
  reset(accountId: string): void {
    this.entries.delete(accountId);
  }

  /** When the account will next admit a trial; null when it already can. */
  reopensAt(accountId: string, now: Date = this.clock.now()): Date | null {
    const state = this.stateOf(accountId, now);
    if (state !== "open") return null;
    const entry = this.entries.get(accountId);
    if (!entry || entry.openedAt === null) return null;
    return addMs(entry.openedAt, this.openMs);
  }
}

/** Numeric encoding for the `bosanda_provider_circuit_state` gauge (§17). */
export function circuitStateValue(state: CircuitState): 0 | 1 | 2 {
  switch (state) {
    case "closed":
      return 0;
    case "half_open":
      return 1;
    case "open":
      return 2;
  }
}
