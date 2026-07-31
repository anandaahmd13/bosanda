/**
 * Retry / failover policy (PLAN.md §7 "Retry policy", §21 criterion 7).
 *
 * THE ABSOLUTE RULE (§7 rule 3 and 7, restated in IMPLEMENTATION-STATUS.md
 * invariant 8): a request may be retried on a DIFFERENT account only while zero
 * bytes have reached the client. Once any output has been emitted, never fail
 * over — surface a stream error instead. Retrying after partial output would
 * duplicate or contradict text the client has already rendered, and if a
 * tool_use block was already emitted, Claude Code may have executed a tool on
 * the user's machine. That side effect cannot be taken back.
 *
 * WHY THIS IS A WRAPPER AND NOT A BOOLEAN. The obvious implementation gives the
 * caller a `hasEmitted` flag to set. That is a latch a caller can forget to
 * flip — and forgetting it is silent, produces correct-looking output in tests,
 * and only manifests as duplicated tokens under a mid-stream upstream failure in
 * production. So this module OWNS the emit path: `streamWithFailover` is the
 * thing that forwards each event to the consumer, and it flips the latch itself
 * as it forwards. The attempt callback receives a `Sink` and cannot emit any
 * other way. There is no caller-settable flag anywhere in this API.
 *
 * Additional §7 rules enforced here:
 *  - rule 2/5: each account is tried at most once per request (`attempted` set).
 *  - rule 6: stop when output begins, accounts run out, the client aborts, or
 *    the attempt cap is reached.
 *  - retry only when `BosandaError.isProviderRetryable` (frozen contract).
 */

import { BosandaError } from "@bosanda/protocol";
import type { CanonicalEvent } from "@bosanda/protocol";
import type { Clock } from "@bosanda/shared";
import type { Scheduler, SchedulableAccount, SelectionContext } from "./scheduler.js";
import type { CooldownRegistry } from "./cooldown.js";
import type { CircuitBreakerRegistry } from "./circuit-breaker.js";

/**
 * The only way an attempt can produce output. Handed to the attempt callback by
 * `streamWithFailover`; the callback cannot construct one.
 */
export type Sink<T> = {
  /** Forwards one event to the client. The first call ends retry eligibility. */
  emit(event: T): Promise<void>;
  /** True once anything has been forwarded. Read-only to the callback. */
  readonly hasEmitted: boolean;
};

export type Attempt<T> = (
  account: SchedulableAccount,
  sink: Sink<T>,
  signal: AbortSignal,
) => Promise<void>;

export type FailoverOptions<T> = {
  scheduler: Scheduler;
  cooldowns: CooldownRegistry;
  breakers: CircuitBreakerRegistry;
  clock: Clock;
  pool: readonly SchedulableAccount[];
  context: SelectionContext;
  signal: AbortSignal;
  /** §7: "Try each provider at most once". Default 3. */
  maxAttempts?: number;
  attempt: Attempt<T>;
  /** Observability hook; must not throw. */
  onAttempt?: (info: AttemptInfo) => void;
};

export type AttemptInfo = {
  accountId: string;
  attempt: number;
  outcome: "success" | "retried" | "failed";
  code?: string;
  /** True when the failure happened after output began (never retryable). */
  afterFirstByte: boolean;
};

/**
 * Runs attempts with failover, yielding every event the winning attempt emits.
 *
 * The generator IS the emit path. An event reaches the consumer only by being
 * yielded here, and the latch is set immediately before the yield, so by the
 * time any adapter code can throw, the latch already reflects reality.
 */
export async function* streamWithFailover<T = CanonicalEvent>(
  options: FailoverOptions<T>,
): AsyncGenerator<T> {
  const { scheduler, cooldowns, breakers, clock, pool, context, signal, attempt, onAttempt } =
    options;
  const maxAttempts = options.maxAttempts ?? 3;

  // §7 rule 5: never revisit an account within the same request. Seeded with any
  // exclusions the caller already knows about.
  const attempted = new Set<string>(context.exclude ?? []);

  let hasEmitted = false;
  let attemptNumber = 0;
  let lastError: BosandaError | undefined;

  for (;;) {
    if (signal.aborted) {
      // §7 rule 6: a client abort stops retrying. Nothing to report to a client
      // that has gone away, so surface the abort reason for logs.
      throw BosandaError.from(signal.reason ?? new Error("client aborted"));
    }

    if (attemptNumber >= maxAttempts) {
      throw (
        lastError ??
        new BosandaError("no_healthy_provider", {
          internalDetail: `attempt cap ${maxAttempts} reached with no attempt made`,
        })
      );
    }

    // Re-classify every round: an account that was busy a moment ago may now be
    // free, and one that just failed is now excluded or cooling down.
    // candidates() throws no_healthy_provider / model_not_allowed when empty,
    // which is the correct terminal error if we never emitted anything.
    let candidates: SchedulableAccount[];
    try {
      candidates = scheduler.candidates(pool, { ...context, exclude: attempted });
    } catch (error) {
      // Prefer the specific upstream failure over a generic "pool empty" when we
      // actually tried something: the operator wants to know WHY the accounts
      // died, not merely that none are left.
      throw lastError ?? BosandaError.from(error);
    }

    const account = candidates[0];
    if (!account) {
      throw (
        lastError ??
        new BosandaError("no_healthy_provider", {
          internalDetail: "candidate list unexpectedly empty",
        })
      );
    }

    attemptNumber += 1;
    attempted.add(account.accountId);

    // Buffer between the attempt and the consumer. The attempt pushes with
    // `emit`; this generator drains and yields. Keeping the queue here (rather
    // than yielding from inside the callback) is what lets the wrapper own the
    // latch.
    const queue: T[] = [];
    let done = false;
    let attemptError: unknown;
    let notify: (() => void) | undefined;

    const wake = (): void => {
      notify?.();
      notify = undefined;
    };

    const sink: Sink<T> = {
      get hasEmitted() {
        return hasEmitted;
      },
      emit: async (event: T) => {
        queue.push(event);
        wake();
        // Yield to the microtask queue so a fast producer cannot starve the
        // consumer and grow the buffer without bound.
        await Promise.resolve();
      },
    };

    const lease = scheduler.reserve(account.accountId);
    const running = (async () => {
      try {
        await attempt(account, sink, signal);
      } catch (error) {
        attemptError = error;
      } finally {
        done = true;
        wake();
      }
    })();

    try {
      // Drain loop: forward everything produced so far, then wait for more.
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (event === undefined) break;
          // THE LATCH. Set before the yield, so it is already true if the
          // consumer throws back into us or the attempt fails next.
          hasEmitted = true;
          yield event;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }

      await running;

      if (attemptError !== undefined) throw attemptError;

      // Success: clear the account's failure history.
      cooldowns.recordSuccess(account.accountId);
      breakers.recordSuccess(account.accountId, clock.now());
      onAttempt?.({
        accountId: account.accountId,
        attempt: attemptNumber,
        outcome: "success",
        afterFirstByte: hasEmitted,
      });
      return;
    } catch (error) {
      const bosandaError = BosandaError.from(error);

      // Record health regardless of whether we will retry: a failure is a
      // failure even when it is terminal for this request.
      cooldowns.recordFailure(account.accountId, bosandaError);
      breakers.recordFailure(account.accountId, bosandaError, clock.now());
      lastError = bosandaError;

      // THE INTERLOCK. Once anything reached the client, this is terminal.
      if (hasEmitted) {
        onAttempt?.({
          accountId: account.accountId,
          attempt: attemptNumber,
          outcome: "failed",
          code: bosandaError.code,
          afterFirstByte: true,
        });
        // Rethrown so the caller emits a protocol-shaped stream error and closes
        // the connection (§8: "After headers/events start, emit the closest
        // protocol-specific stream error"). No failover happens after this point.
        throw bosandaError;
      }

      if (!bosandaError.isProviderRetryable) {
        onAttempt?.({
          accountId: account.accountId,
          attempt: attemptNumber,
          outcome: "failed",
          code: bosandaError.code,
          afterFirstByte: false,
        });
        throw bosandaError;
      }

      if (signal.aborted) throw bosandaError;

      onAttempt?.({
        accountId: account.accountId,
        attempt: attemptNumber,
        outcome: "retried",
        code: bosandaError.code,
        afterFirstByte: false,
      });
      // Loop: pick a DIFFERENT account (this one is now in `attempted`).
    } finally {
      lease.release();
      // Never leave the attempt's rejection unobserved — it would surface as an
      // unhandled rejection and, under Node's default, could crash the gateway.
      void running.catch(() => undefined);
    }
  }
}

/**
 * Non-streaming convenience: collects the winning attempt's events.
 *
 * Retry semantics are IDENTICAL, because the same generator drives it. A
 * non-streaming response is buffered by the gateway and nothing reaches the
 * client until it completes, so in practice every failure here is pre-first-byte
 * — but the interlock still governs, which is exactly why this delegates instead
 * of reimplementing the loop.
 */
export async function collectWithFailover<T = CanonicalEvent>(
  options: FailoverOptions<T>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of streamWithFailover(options)) events.push(event);
  return events;
}
