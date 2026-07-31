/**
 * Per-account cooldown (PLAN.md §7 "Retry policy" 4, "Circuit breaker").
 *
 * §7: "A failed provider enters a 30-second cooldown", escalating exponentially
 * to a configured maximum on repeated failures, and honouring upstream retry
 * metadata for rate-limit failures.
 *
 * Design notes:
 *
 *  - Whether a failure triggers cooldown is NOT decided here. It is decided by
 *    `BosandaError.shouldCooldownProvider` in @bosanda/protocol, which is the
 *    frozen contract. Duplicating that predicate would let the two drift.
 *
 *  - Time comes from an injected Clock. Cooldown is pure time arithmetic, so a
 *    direct Date.now() would make every test either slow or flaky.
 *
 *  - Escalation is tracked per account and decays: an account that failed once
 *    an hour ago should not be treated as a repeat offender. Without decay the
 *    escalation counter only ever climbs and a long-lived account eventually
 *    sits at the 15-minute maximum after a single bad afternoon.
 *
 *  - `backoffMs` from @bosanda/shared supplies the exponential-with-jitter
 *    curve. Jitter matters with a pool: without it, several accounts that failed
 *    on the same upstream incident all become eligible again in the same
 *    millisecond and stampede the recovering upstream.
 */

import { addMs, backoffMs, secondsUntil, SECOND_MS, type Clock } from "@bosanda/shared";
import type { BosandaError } from "@bosanda/protocol";

export type CooldownOptions = {
  clock: Clock;
  /** PROVIDER_COOLDOWN_MS — §7 default 30s. */
  baseMs?: number;
  /** PROVIDER_COOLDOWN_MAX_MS — default 15min. */
  maxMs?: number;
  /**
   * After this long without a failure, an account's escalation counter resets.
   * Defaults to `maxMs` so a fully-escalated account gets a clean slate once it
   * has been quiet for as long as its own longest penalty.
   */
  escalationDecayMs?: number;
  /** Injectable for deterministic jitter in tests. */
  random?: () => number;
};

type Entry = {
  until: Date;
  /** Consecutive cooldown-triggering failures, for escalation. */
  strikes: number;
  lastFailureAt: Date;
  /** Operator-facing; never client-facing. */
  reason: string;
};

export type CooldownState = {
  accountId: string;
  until: Date;
  secondsRemaining: number;
  strikes: number;
  reason: string;
};

export class CooldownRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly decayMs: number;
  private readonly random: () => number;

  constructor(options: CooldownOptions) {
    this.clock = options.clock;
    this.baseMs = options.baseMs ?? 30 * SECOND_MS;
    this.maxMs = options.maxMs ?? 15 * 60 * SECOND_MS;
    this.decayMs = options.escalationDecayMs ?? this.maxMs;
    this.random = options.random ?? Math.random;
  }

  /**
   * Records a failure and starts a cooldown when the error warrants one.
   * Returns the new state, or undefined when the error is not a cooldown cause.
   *
   * Delegating the decision to `shouldCooldownProvider` means an
   * `invalid_request` (the customer's fault) never penalizes a healthy account —
   * which would otherwise let one malformed client drain the whole pool.
   */
  recordFailure(accountId: string, error: BosandaError): CooldownState | undefined {
    if (!error.shouldCooldownProvider) return undefined;

    const now = this.clock.now();
    const previous = this.entries.get(accountId);

    // Decay: only count as a repeat offence if the last failure is recent.
    const isRepeat =
      previous !== undefined && now.getTime() - previous.lastFailureAt.getTime() < this.decayMs;
    const strikes = isRepeat ? previous.strikes + 1 : 1;

    const durationMs = this.durationFor(strikes, error);
    const until = addMs(now, durationMs);
    const reason =
      `${error.code} on attempt ${strikes}` +
      (error.retryAfterSeconds !== undefined
        ? `; upstream retry-after ${error.retryAfterSeconds}s`
        : "") +
      `; cooling down ${Math.round(durationMs / SECOND_MS)}s`;

    // Never shorten an existing, longer cooldown. Two concurrent requests can
    // both fail on the same account; the second (possibly milder) failure must
    // not release the account early.
    const until_ =
      previous !== undefined && previous.until.getTime() > until.getTime() ? previous.until : until;

    const entry: Entry = { until: until_, strikes, lastFailureAt: now, reason };
    this.entries.set(accountId, entry);
    return this.toState(accountId, entry, now);
  }

  /**
   * Cooldown length for this strike count.
   *
   * An upstream `retry-after` wins whenever it is LONGER than our own curve:
   * the upstream knows its own recovery window, and retrying earlier than it
   * asked is how a rate limit turns into a ban. We never shorten below our own
   * floor, because a cooperative `retry-after: 1` on a genuinely broken account
   * would otherwise put it straight back into rotation.
   */
  private durationFor(strikes: number, error: BosandaError): number {
    const escalated = backoffMs(strikes, this.baseMs, this.maxMs, this.random);
    const retryAfterMs =
      error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * SECOND_MS : 0;
    return Math.min(this.maxMs, Math.max(escalated, retryAfterMs));
  }

  /** True when the account is currently serving a cooldown. */
  isCoolingDown(accountId: string, now: Date = this.clock.now()): boolean {
    const entry = this.entries.get(accountId);
    if (!entry) return false;
    // Expiry restores eligibility. `<=` so a cooldown ending exactly now is over.
    if (entry.until.getTime() <= now.getTime()) return false;
    return true;
  }

  /** Current cooldown, or undefined when eligible. */
  stateOf(accountId: string, now: Date = this.clock.now()): CooldownState | undefined {
    const entry = this.entries.get(accountId);
    if (!entry || entry.until.getTime() <= now.getTime()) return undefined;
    return this.toState(accountId, entry, now);
  }

  /** Every account still cooling down — for the admin dashboard (§15). */
  active(now: Date = this.clock.now()): CooldownState[] {
    const out: CooldownState[] = [];
    for (const [accountId, entry] of this.entries) {
      if (entry.until.getTime() > now.getTime()) {
        out.push(this.toState(accountId, entry, now));
      }
    }
    return out;
  }

  /**
   * Clears a cooldown early. Two callers: an operator forcing an account back
   * into rotation from the admin dashboard, and a successful half-open probe.
   *
   * `resetStrikes` defaults to false so an operator un-sticking an account does
   * not also erase its escalation history — the next failure should still be
   * treated as a repeat, or a flapping account escapes escalation entirely by
   * being manually cleared each time.
   */
  clear(accountId: string, resetStrikes = false): void {
    if (resetStrikes) {
      this.entries.delete(accountId);
      return;
    }
    const entry = this.entries.get(accountId);
    if (!entry) return;
    // Keep strike history, but end the penalty now.
    this.entries.set(accountId, { ...entry, until: this.clock.now() });
  }

  /** Records a success: clears the penalty and the escalation counter. */
  recordSuccess(accountId: string): void {
    this.entries.delete(accountId);
  }

  private toState(accountId: string, entry: Entry, now: Date): CooldownState {
    return {
      accountId,
      until: entry.until,
      secondsRemaining: secondsUntil(entry.until, now),
      strikes: entry.strikes,
      reason: entry.reason,
    };
  }
}
