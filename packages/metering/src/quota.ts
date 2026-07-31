/**
 * Quota decision logic (PLAN.md §10 "Quota behavior", §11 key lifecycle).
 *
 * SIDE-EFFECT FREE BY DESIGN. The database writes live in @bosanda/database, because
 * §10 requires the ledger row and the balance update to happen in ONE transaction and
 * only the database layer can guarantee that. This module decides; the caller executes.
 * Keeping it pure is also what makes the overage bound and the expiry arithmetic
 * testable without a server.
 */

import { BosandaError } from "@bosanda/protocol";
import { type Clock, KEY_VALIDITY_MS, addMs, isExpired } from "@bosanda/shared";
import { weightedFromTokens } from "./weighted.js";
import type { ResolvedUsage } from "./usage.js";

/** Maximum quota one key may ever hold, in weighted tokens (PLAN.md §11: 100M cap). */
export const MAX_KEY_QUOTA = 100_000_000;

/** Package sizes are 10M increments from 10M to 100M (PLAN.md §11). */
export const PACKAGE_INCREMENT = 10_000_000;

/** Price per 10M increment, integer rupiah (PLAN.md §11: linear at Rp9.500 per 10M). */
export const PRICE_PER_INCREMENT_IDR = 9_500;

export type KeyStatus = "active" | "revoked" | "expired";

/** The subset of an api_keys row this module reasons about. */
export type KeyQuotaState = {
  keyId: string;
  status: KeyStatus;
  /** Weighted tokens remaining. May be negative after bounded overage (§10). */
  remaining: number;
  /** Total weighted tokens ever granted to this key. */
  quotaLimit: number;
  /** null before first activation. */
  expiresAt: Date | null;
};

export type StartDecision = { allowed: true } | { allowed: false; error: BosandaError };

/**
 * May a NEW request start? (§10: "A request can start only when the key is active and
 * has positive remaining quota." / "Once remaining quota is zero or negative,
 * subsequent requests are rejected.")
 *
 * Note the asymmetry with `allowStreamToFinish` below — it is deliberate and is the
 * whole point of §10's quota behaviour.
 */
export function canStartRequest(state: KeyQuotaState, clock: Clock): StartDecision {
  const now = clock.now();

  if (state.status === "revoked") {
    return {
      allowed: false,
      error: new BosandaError("authentication_error", {
        internalDetail: `key ${state.keyId} is revoked`,
      }),
    };
  }

  if (state.status === "expired" || isExpired(state.expiresAt, now)) {
    return {
      allowed: false,
      error: new BosandaError("authentication_error", {
        internalDetail: `key ${state.keyId} expired`,
      }),
    };
  }

  if (state.remaining <= 0) {
    return {
      allowed: false,
      error: new BosandaError("quota_exhausted", {
        internalDetail: `key ${state.keyId} has ${state.remaining} weighted tokens remaining`,
      }),
    };
  }

  return { allowed: true };
}

/**
 * An already-started stream ALWAYS finishes, even across zero (§10: "Bosanda does not
 * cut text or a tool call in the middle").
 *
 * This is a named function returning a constant rather than an inlined `true`, so the
 * rule is greppable and so a future change has to argue with the comment.
 */
export function allowStreamToFinish(): true {
  return true;
}

/**
 * Worst-case negative overage bound (§10: "Bounded negative overage is possible with
 * up to five concurrent streams").
 *
 * Derivation: a request may start whenever remaining > 0, so in the limit each of the
 * `maxConcurrent` streams starts when remaining is 1 weighted token. Each then runs to
 * completion and settles its full cost. All concurrently admitted streams can settle
 * after that shared observation, so the floor is:
 *
 *   remaining_min = 1 - maxConcurrent × maxCostPerStream
 *
 * With maxOutputTokens capped by LIMITS and the model multiplier known, this is finite
 * and computable — which is what makes the overage "bounded" rather than open-ended.
 */
export function worstCaseOverage(maxConcurrent: number, maxWeightedCostPerStream: number): number {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(
      `maxConcurrent must be a positive safe integer, received ${maxConcurrent}`,
    );
  }
  if (!Number.isSafeInteger(maxWeightedCostPerStream) || maxWeightedCostPerStream < 0) {
    throw new RangeError(
      `maxWeightedCostPerStream must be a non-negative safe integer, received ${maxWeightedCostPerStream}`,
    );
  }

  const floor = 1 - maxConcurrent * maxWeightedCostPerStream;
  if (!Number.isSafeInteger(floor)) {
    throw new RangeError("worst-case overage exceeds the safe integer range");
  }
  return floor;
}

export type SettlementInput = {
  state: KeyQuotaState;
  usage: ResolvedUsage;
  /** The multiplier version stamped on the request when it STARTED (§9). */
  multiplier: number;
  multiplierVersion: number;
  model: string;
};

export type Settlement = {
  keyId: string;
  /** Weighted tokens to deduct. Always >= 0; a turn never credits quota back. */
  weightedTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Balance after applying the deduction. May be negative (bounded overage). */
  remainingAfter: number;
  estimated: boolean;
  source: ResolvedUsage["source"];
  meterVersion: string;
  multiplier: number;
  multiplierVersion: number;
  model: string;
};

/**
 * Compute the ledger delta for a completed OR partially-completed turn (§10:
 * "Partial/error turns are charged for usage actually reported or estimated").
 *
 * The caller writes { ledger row, balance = remainingAfter } in one transaction.
 */
export function settle(input: SettlementInput): Settlement {
  const { state, usage, multiplier, multiplierVersion, model } = input;

  const weighted = weightedFromTokens(usage.inputTokens, usage.outputTokens, multiplier);

  return {
    keyId: state.keyId,
    weightedTokens: weighted,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    remainingAfter: state.remaining - weighted,
    estimated: usage.estimated,
    source: usage.source,
    meterVersion: usage.meterVersion,
    multiplier,
    multiplierVersion,
    model,
  };
}

export type TopUpDecision =
  | {
      accepted: true;
      /** Quota after the top-up. */
      remainingAfter: number;
      quotaLimitAfter: number;
      /** Validity restarts at 24h from confirmed payment (§11). */
      expiresAt: Date;
    }
  | { accepted: false; error: BosandaError };

/**
 * Validate a top-up against §11: the 100M cap applies to REMAINING + purchased, an
 * expired or exhausted key cannot be topped up, and successful payment resets validity
 * to 24 hours.
 *
 * The cap is checked against `remaining`, not `quotaLimit`, because the cap in §11 is
 * "maximum active quota on one key" — a key that has consumed 90M of a 100M package
 * has 10M live and can legitimately hold 90M more.
 */
export function validateTopUp(
  state: KeyQuotaState,
  purchasedWeightedTokens: number,
  clock: Clock,
): TopUpDecision {
  const now = clock.now();

  if (
    !Number.isInteger(purchasedWeightedTokens) ||
    purchasedWeightedTokens <= 0 ||
    purchasedWeightedTokens % PACKAGE_INCREMENT !== 0 ||
    purchasedWeightedTokens > MAX_KEY_QUOTA
  ) {
    return {
      accepted: false,
      error: new BosandaError("invalid_request", {
        internalDetail: `purchased quota must be a 10M increment up to ${MAX_KEY_QUOTA}, received ${purchasedWeightedTokens}`,
      }),
    };
  }

  if (state.status === "revoked") {
    return {
      accepted: false,
      error: new BosandaError("conflict", {
        internalDetail: `key ${state.keyId} is revoked and cannot be topped up`,
      }),
    };
  }

  if (state.status === "expired" || isExpired(state.expiresAt, now)) {
    return {
      accepted: false,
      error: new BosandaError("conflict", {
        internalDetail: `key ${state.keyId} is expired and cannot be topped up`,
      }),
    };
  }

  // "Exhausted" includes the negative-overage case: there is nothing left to extend.
  if (state.remaining <= 0) {
    return {
      accepted: false,
      error: new BosandaError("conflict", {
        internalDetail: `key ${state.keyId} is exhausted (${state.remaining}) and cannot be topped up`,
      }),
    };
  }

  const remainingAfter = state.remaining + purchasedWeightedTokens;
  if (remainingAfter > MAX_KEY_QUOTA) {
    return {
      accepted: false,
      error: new BosandaError("conflict", {
        internalDetail: `top-up would exceed the ${MAX_KEY_QUOTA} weighted-token cap (${state.remaining} + ${purchasedWeightedTokens})`,
      }),
    };
  }

  return {
    accepted: true,
    remainingAfter,
    quotaLimitAfter: state.quotaLimit + purchasedWeightedTokens,
    expiresAt: addMs(now, KEY_VALIDITY_MS),
  };
}

/** Price for a package size, integer rupiah (§11, linear at Rp9.500 per 10M). */
export function priceForQuota(weightedTokens: number): number {
  if (
    !Number.isInteger(weightedTokens) ||
    weightedTokens <= 0 ||
    weightedTokens % PACKAGE_INCREMENT !== 0 ||
    weightedTokens > MAX_KEY_QUOTA
  ) {
    throw new RangeError(
      `quota must be a 10M increment up to ${MAX_KEY_QUOTA}, received ${weightedTokens}`,
    );
  }
  return (weightedTokens / PACKAGE_INCREMENT) * PRICE_PER_INCREMENT_IDR;
}
