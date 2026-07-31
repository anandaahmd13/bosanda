/**
 * Least-loaded account selection and slot leasing (PLAN.md §7 "Provider
 * selection", "Concurrency decisions").
 *
 * §7 sorts eligible accounts by:
 *   1. active request count ascending
 *   2. recent error score ascending
 *   3. last selected timestamp ascending
 *   4. stable account ID tie-breaker
 *
 * TIE-BREAK FAIRNESS. Keys 1 and 2 are the load signal; keys 3 and 4 decide
 * ties. Key 3 is what makes the tie-break FAIR rather than merely
 * deterministic: among accounts with equal load and equal error score, the
 * least-recently-selected one wins (LRU). A naive implementation that sorted
 * only by account ID would be deterministic but badly unfair — with an idle pool
 * every request has activeRequests 0, so account "a" would win every single
 * time and the rest of the pool would never be touched. LRU rotates through the
 * tied set instead, which is the behaviour `test/scheduler.test.ts` asserts by
 * distribution across many sequential calls, not by a single pick. Key 4 (ID)
 * only breaks the residual tie between accounts that have never been selected,
 * making the order reproducible in tests.
 *
 * SLOT LEASING. §7 requires an accurate active-request count even though v1 sets
 * no hard per-account cap ("Even without a hard provider limit, Bosanda must
 * track active requests so least-loaded routing works"). A leaked slot silently
 * poisons routing: the account looks permanently busy and drops out of
 * selection, so the pool shrinks with no error anywhere. That failure is
 * invisible, which is why the API is a lease that the scheduler itself releases
 * rather than a pair of increment/decrement calls a caller must remember to
 * balance. `withLease()` releases in a `finally`, covering success, throw, and
 * abort — including a consumer that abandons an async iterator mid-stream, since
 * `for await` runs the generator's `finally` on early `break`.
 */

import { BosandaError } from "@bosanda/protocol";
import type { Clock } from "@bosanda/shared";
import type { AccountHealth } from "./types.js";
import type { CooldownRegistry } from "./cooldown.js";
import type { CircuitBreakerRegistry } from "./circuit-breaker.js";

/**
 * One candidate account as the scheduler sees it. The gateway builds these from
 * `provider_accounts` joined with in-memory health; the scheduler never touches
 * the database itself.
 */
export type SchedulableAccount = {
  accountId: string;
  health: AccountHealth;
  /** Public model IDs this account can serve. */
  supportedModels: ReadonlySet<string>;
  /**
   * Per-account concurrency ceiling. §7/§22 set NO hard cap for Kiro in v1, so
   * this defaults to Infinity at the call site; it exists because §7 calls the
   * absence of a cap "a known operational risk" and an operator needs a lever
   * without a deploy.
   */
  maxConcurrent?: number;
};

export type SelectionContext = {
  /** Public model ID being requested. */
  model: string;
  /** Accounts already tried for THIS request — never revisited (§7 rule 5). */
  exclude?: ReadonlySet<string>;
};

/** Why an account was not eligible. Operator-facing only. */
export type RejectionReason =
  | "status_not_active"
  | "cooling_down"
  | "circuit_open"
  | "credential_invalid"
  | "model_unsupported"
  | "region_disabled"
  | "account_disabled"
  | "at_concurrency_ceiling"
  | "already_attempted";

export type Rejection = { accountId: string; reason: RejectionReason };

/**
 * A reserved slot. Release is idempotent so a defensive extra call in a
 * `finally` cannot drive the counter negative.
 */
export type Lease = {
  readonly accountId: string;
  readonly release: () => void;
  /** True once released — for assertions and leak detection. */
  readonly released: boolean;
};

export type SchedulerOptions = {
  clock: Clock;
  cooldowns: CooldownRegistry;
  breakers: CircuitBreakerRegistry;
  /** Regions disabled by kill switch (§3). */
  disabledRegions?: ReadonlySet<string>;
  /** Accounts disabled by operator (§3). */
  disabledAccounts?: ReadonlySet<string>;
};

export class Scheduler {
  /** accountId -> in-flight reservations held by THIS process. */
  private readonly active = new Map<string, number>();
  /** accountId -> when we last handed it out, for the LRU tie-break. */
  private readonly lastSelectedAt = new Map<string, number>();
  /** Monotonic counter: a stable ordering even within one clock millisecond. */
  private selectionSequence = 0;

  private readonly clock: Clock;
  private readonly cooldowns: CooldownRegistry;
  private readonly breakers: CircuitBreakerRegistry;
  private readonly disabledRegions: ReadonlySet<string>;
  private readonly disabledAccounts: ReadonlySet<string>;

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    this.cooldowns = options.cooldowns;
    this.breakers = options.breakers;
    this.disabledRegions = options.disabledRegions ?? new Set();
    this.disabledAccounts = options.disabledAccounts ?? new Set();
  }

  activeCount(accountId: string): number {
    return this.active.get(accountId) ?? 0;
  }

  totalActive(): number {
    let total = 0;
    for (const count of this.active.values()) total += count;
    return total;
  }

  /**
   * Partitions the pool into eligible candidates and rejections.
   *
   * Rejections are returned rather than dropped so the caller can log WHY a pool
   * was empty. "No healthy provider" with no further detail is close to
   * undebuggable at 3am.
   */
  classify(
    pool: readonly SchedulableAccount[],
    context: SelectionContext,
  ): { eligible: SchedulableAccount[]; rejected: Rejection[] } {
    const now = this.clock.now();
    const eligible: SchedulableAccount[] = [];
    const rejected: Rejection[] = [];
    const exclude = context.exclude ?? new Set<string>();

    for (const account of pool) {
      const { accountId, health } = account;

      const reject = (reason: RejectionReason): void => {
        rejected.push({ accountId, reason });
      };

      // Order matters only for the quality of the logged reason; every check is
      // independent. Cheapest and most specific first.
      if (exclude.has(accountId)) {
        reject("already_attempted");
        continue;
      }
      if (this.disabledAccounts.has(accountId)) {
        reject("account_disabled");
        continue;
      }
      if (health.status === "credential_invalid") {
        // §7: auth/revocation disables the account until admin action.
        reject("credential_invalid");
        continue;
      }
      if (health.status === "disabled") {
        reject("account_disabled");
        continue;
      }
      if (health.status !== "active") {
        // Covers "cooling_down" as recorded on the account record itself.
        reject("status_not_active");
        continue;
      }
      if (this.disabledRegions.has(health.region)) {
        reject("region_disabled");
        continue;
      }
      if (!account.supportedModels.has(context.model)) {
        reject("model_unsupported");
        continue;
      }
      if (this.cooldowns.isCoolingDown(accountId, now)) {
        reject("cooling_down");
        continue;
      }
      if (!this.breakers.allowsRequest(accountId, now)) {
        reject("circuit_open");
        continue;
      }
      const ceiling = account.maxConcurrent ?? Number.POSITIVE_INFINITY;
      if (this.activeCount(accountId) >= ceiling) {
        reject("at_concurrency_ceiling");
        continue;
      }

      eligible.push(account);
    }

    return { eligible, rejected };
  }

  /**
   * Orders eligible accounts by the §7 sort. Exposed because the retry loop
   * needs the whole ordered list ("Try each provider at most once, in
   * least-loaded order"), not just the head.
   */
  order(eligible: readonly SchedulableAccount[]): SchedulableAccount[] {
    return [...eligible].sort((a, b) => {
      // 1. active request count ascending
      const load = this.activeCount(a.accountId) - this.activeCount(b.accountId);
      if (load !== 0) return load;

      // 2. recent error score ascending
      const score = a.health.errorScore - b.health.errorScore;
      if (score !== 0) return score;

      // 3. last selected ascending (LRU) — never-selected sorts first.
      const aLast = this.lastSelectedAt.get(a.accountId) ?? -1;
      const bLast = this.lastSelectedAt.get(b.accountId) ?? -1;
      if (aLast !== bLast) return aLast - bLast;

      // 4. stable account ID
      return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
    });
  }

  /**
   * Distinguishes "temporarily unavailable" from "nothing can ever serve this".
   *
   * §8 has no `model_unavailable` code — the frozen ErrorCode union does not
   * contain one — so this maps to the closest correct frozen codes:
   *
   *  - No account in the pool supports the model at all: the request can never
   *    succeed by waiting, so it is a client-side mistake ->
   *    `model_not_allowed` (403). Returning 503 would tell the client to retry
   *    forever against a model that does not exist for them.
   *  - Everything is busy, cooling down, or open-circuited: transient ->
   *    `no_healthy_provider` (503).
   *
   * The deviation from the assignment's literal `model_unavailable` is reported
   * in the final output; adding a code would mean editing the frozen protocol
   * package.
   */
  private emptyPoolError(rejected: readonly Rejection[], context: SelectionContext): BosandaError {
    const counts = new Map<RejectionReason, number>();
    for (const { reason } of rejected) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    const breakdown = [...counts.entries()]
      .map(([reason, count]) => `${reason}=${count}`)
      .sort()
      .join(" ");

    // "No account supports this model" only when SOME account was rejected for
    // that reason and NONE was rejected for a transient one. If even one account
    // could serve the model but is merely busy, this is capacity, not capability.
    const transient: RejectionReason[] = [
      "cooling_down",
      "circuit_open",
      "at_concurrency_ceiling",
      "already_attempted",
      "status_not_active",
    ];
    const hasTransient = transient.some((reason) => counts.has(reason));
    const modelUnsupported = counts.get("model_unsupported") ?? 0;

    if (modelUnsupported > 0 && !hasTransient) {
      return new BosandaError("model_not_allowed", {
        internalDetail:
          `no provider account supports model "${context.model}" ` +
          `(pool=${rejected.length}: ${breakdown})`,
      });
    }

    return new BosandaError("no_healthy_provider", {
      internalDetail:
        `no eligible provider account for model "${context.model}" ` +
        `(pool=${rejected.length}: ${breakdown})`,
    });
  }

  /**
   * Ordered eligible accounts, or throws when there are none.
   * Throwing here rather than returning `[]` means a caller cannot accidentally
   * treat an empty pool as "nothing to do" and return a 200 with no content.
   */
  candidates(pool: readonly SchedulableAccount[], context: SelectionContext): SchedulableAccount[] {
    const { eligible, rejected } = this.classify(pool, context);
    if (eligible.length === 0) throw this.emptyPoolError(rejected, context);
    return this.order(eligible);
  }

  /**
   * Reserves a slot on `accountId`.
   *
   * Increments the active count, claims a half-open trial slot when the breaker
   * is half-open, and stamps the LRU marker. Prefer `withLease()`; call this
   * directly only when the release genuinely cannot be lexically scoped.
   */
  reserve(accountId: string): Lease {
    if (!this.breakers.tryAcquireTrial(accountId, this.clock.now())) {
      throw new BosandaError("no_healthy_provider", {
        internalDetail: `circuit breaker refused a trial slot for account "${accountId}"`,
        providerAccountId: accountId,
      });
    }

    this.active.set(accountId, this.activeCount(accountId) + 1);
    this.selectionSequence += 1;
    this.lastSelectedAt.set(accountId, this.selectionSequence);

    let released = false;
    const lease: Lease = {
      accountId,
      get released() {
        return released;
      },
      release: () => {
        // Idempotent: a double release must not decrement twice.
        if (released) return;
        released = true;
        const current = this.activeCount(accountId);
        // Math.max guards against a counter that was reset underneath us.
        this.active.set(accountId, Math.max(0, current - 1));
        this.breakers.releaseTrial(accountId);
      },
    };
    return lease;
  }

  /**
   * Selects the least-loaded eligible account and reserves it in one step, so
   * there is no window in which two concurrent requests both see the same
   * account as least-loaded.
   */
  reserveBest(pool: readonly SchedulableAccount[], context: SelectionContext): Lease {
    const ordered = this.candidates(pool, context);
    const best = ordered[0];
    if (!best) {
      // Unreachable: candidates() throws on empty. Narrows the index access for
      // noUncheckedIndexedAccess.
      throw new BosandaError("no_healthy_provider", {
        internalDetail: "candidate list unexpectedly empty",
      });
    }
    return this.reserve(best.accountId);
  }

  /**
   * Runs `fn` holding a slot, releasing it on every exit path.
   *
   * This is the interlock: the slot is released in `finally`, so success, throw,
   * and abort are all covered without the caller writing any cleanup. Use this
   * for non-streaming work.
   */
  async withLease<T>(accountId: string, fn: (lease: Lease) => Promise<T>): Promise<T> {
    const lease = this.reserve(accountId);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  /**
   * Streaming variant: holds the slot for the lifetime of the iteration.
   *
   * A generator's `finally` runs when the consumer completes it, throws into it,
   * or abandons it early (`break` out of `for await` calls `.return()`), so an
   * abandoned stream cannot leak a slot. That is the case the plain
   * increment/decrement API gets wrong most often, and the reason this exists.
   */
  async *streamWithLease<T>(
    accountId: string,
    fn: (lease: Lease) => AsyncIterable<T>,
  ): AsyncGenerator<T> {
    const lease = this.reserve(accountId);
    try {
      yield* fn(lease);
    } finally {
      lease.release();
    }
  }

  /** Test/operator hook: drop all counters. */
  resetCounters(): void {
    this.active.clear();
    this.lastSelectedAt.clear();
    this.selectionSequence = 0;
  }
}
