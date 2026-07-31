/**
 * New-key versus top-up activation decision (PLAN.md §11 "New key versus top-up",
 * §11 "Validity", and §13 "Checkout" step 8).
 *
 * Pure decision functions. §10 requires the ledger row and the balance update to happen in
 * ONE transaction, and only @bosanda/database can guarantee that, so this module decides
 * and the caller executes — the same split @bosanda/metering already uses.
 *
 * The 100M cap and the top-up eligibility rules are NOT reimplemented here:
 * `validateTopUp` in @bosanda/metering already owns them, including the subtlety that the
 * cap applies to REMAINING + purchased rather than to the lifetime limit. This module adds
 * what §11 asks for on top: which of the two paths applies, and the validity window
 * measured from confirmed payment.
 *
 * VALIDITY WINDOW, and a deliberate choice about delayed webhooks.
 * §11 says a key is valid "exactly 24 hours from confirmed payment", and a top-up resets
 * expiry to "24 hours from the successful top-up payment". Both are measured from the
 * PAYMENT instant, not from the activation instant — those differ whenever a webhook is
 * delayed or reconciliation activates the order later (§13). So:
 *   - eligibility is judged at `clock.now()`, because a key that has expired by now must
 *     not be topped up no matter when the money arrived;
 *   - the granted window is measured from the payment instant, because that is what §11
 *     says and what the customer bought;
 *   - if that window has ALREADY fully elapsed by `clock.now()`, activation would hand
 *     over a key that is dead on arrival, so the order is routed to review instead. §13
 *     sends money-versus-state disagreements to `review_required`, never to a silent fix.
 */

import { BosandaError } from "@bosanda/protocol";
import { MAX_KEY_QUOTA, type KeyQuotaState, validateTopUp } from "@bosanda/metering";
import { type Clock, KEY_VALIDITY_MS, addMs } from "@bosanda/shared";
import type { OrderSnapshot } from "./types.js";

/** Grant for a brand-new key (§11 "Create a new API key"). */
export type NewKeyGrant = {
  readonly kind: "new_key";
  readonly userId: string;
  readonly orderId: string;
  /** Weighted tokens granted. Never above the snapshot's cap. */
  readonly quota: number;
  readonly quotaLimit: number;
  /** 24h from confirmed payment (§11 "Validity"). */
  readonly expiresAt: Date;
};

/** Grant that credits an existing active key (§11 "Top-up rules"). */
export type TopUpGrant = {
  readonly kind: "top_up";
  readonly userId: string;
  readonly orderId: string;
  readonly apiKeyId: string;
  /** Weighted tokens added by this order. */
  readonly purchased: number;
  /** Remaining quota after crediting. */
  readonly remainingAfter: number;
  /** Lifetime granted total after crediting. */
  readonly quotaLimitAfter: number;
  /** Reset to 24h from the successful top-up payment (§11). */
  readonly expiresAt: Date;
};

export type ActivationGrant = NewKeyGrant | TopUpGrant;

export type ActivationDecision =
  | { activate: true; grant: ActivationGrant }
  /** Route to `review_required` (§13); a human resolves it. */
  | { activate: false; review: true; error: BosandaError }
  /** Reject outright — a malformed order that should never have been created. */
  | { activate: false; review: false; error: BosandaError };

const reject = (detail: string): ActivationDecision => ({
  activate: false,
  review: false,
  error: new BosandaError("invalid_request", { internalDetail: detail }),
});

const review = (code: "conflict" | "invalid_request", detail: string): ActivationDecision => ({
  activate: false,
  review: true,
  error: new BosandaError(code, { internalDetail: detail }),
});

/**
 * The validity window a snapshot grants, in milliseconds.
 *
 * Read from the frozen snapshot rather than from the current constant, because §11 keeps
 * packages admin-managed and "existing paid orders retain their purchase snapshot" — a
 * later change to the sold duration must not retroactively alter this order. Falls back to
 * `KEY_VALIDITY_MS` only when the snapshot carries no usable duration.
 */
export function validityMsFor(order: OrderSnapshot): number {
  const seconds = order.packageSnapshot.durationSeconds;
  if (!Number.isInteger(seconds) || seconds <= 0) return KEY_VALIDITY_MS;
  return seconds * 1000;
}

/**
 * The instant §11 measures validity from: confirmed payment.
 *
 * Falls back to `now` when the order carries no `paidAt`, which happens only on a path that
 * has just established payment and not yet written the column.
 */
export function paymentInstant(order: OrderSnapshot, now: Date): Date {
  return order.paidAt !== null && Number.isFinite(order.paidAt.getTime()) ? order.paidAt : now;
}

/**
 * Decides the §11 new-key-versus-top-up path for a PAID order and computes the grant.
 *
 * `targetKey` is the current state of the key named by a top-up order, and must be null for
 * a new-key order. The caller reads it under the same row lock it will write through
 * (§16 invariant 5), so the numbers here match what the transaction commits.
 */
export function decideActivation(
  order: OrderSnapshot,
  targetKey: KeyQuotaState | null,
  clock: Clock,
): ActivationDecision {
  const now = clock.now();

  // §14 constraint `orders_paid_before_activated`, restated as a guard: nothing activates
  // that has not been established as paid.
  if (order.status !== "paid" && order.status !== "activated") {
    return reject(`order ${order.orderId} is ${order.status}, not paid`);
  }
  if (order.status === "activated" || order.activatedAt !== null) {
    return reject(`order ${order.orderId} is already activated`);
  }

  const quota = order.packageSnapshot.weightedTokenQuota;
  const cap = Number.isInteger(order.packageSnapshot.maxKeyQuota)
    ? order.packageSnapshot.maxKeyQuota
    : MAX_KEY_QUOTA;

  if (!Number.isInteger(quota) || quota <= 0) {
    return reject(`order ${order.orderId} snapshot quota is not a positive integer`);
  }
  if (quota > cap) {
    // The order was created above the cap in force at the time. Money may already have
    // moved, so a human decides rather than silently truncating what was sold.
    return review("conflict", `order ${order.orderId} quota ${quota} exceeds cap ${cap}`);
  }

  const paidAt = paymentInstant(order, now);
  const expiresAt = addMs(paidAt, validityMsFor(order));

  // A window that has already fully elapsed would hand over a dead key (see the file
  // header). §13 routes that to review.
  if (expiresAt.getTime() <= now.getTime()) {
    return review(
      "conflict",
      `order ${order.orderId} validity window already elapsed (paid ${paidAt.toISOString()})`,
    );
  }

  if (order.type === "new_key") {
    if (order.targetApiKeyId !== null) {
      return reject(`new_key order ${order.orderId} must not name a target key`);
    }
    if (targetKey !== null) {
      return reject(`new_key order ${order.orderId} was given a target key state`);
    }

    return {
      activate: true,
      grant: {
        kind: "new_key",
        userId: order.userId,
        orderId: order.orderId,
        quota,
        quotaLimit: quota,
        expiresAt,
      },
    };
  }

  // top_up
  if (order.targetApiKeyId === null) {
    return reject(`top_up order ${order.orderId} must name a target key`);
  }
  if (targetKey === null) {
    return review("conflict", `top_up order ${order.orderId} target key was not found`);
  }
  if (targetKey.keyId !== order.targetApiKeyId) {
    return reject(`top_up order ${order.orderId} target key state does not match the order`);
  }

  // §11's cap and eligibility rules, judged at `now` — delegated, not reimplemented.
  const decision = validateTopUp(targetKey, quota, clock);
  if (!decision.accepted) {
    // Paid but not creditable (expired, exhausted, revoked, or over the cap). §11 says the
    // user must create a new key instead, which is an admin/refund decision, not a silent
    // downgrade — so this goes to review with the reason preserved for the operator.
    return { activate: false, review: true, error: decision.error };
  }

  return {
    activate: true,
    grant: {
      kind: "top_up",
      userId: order.userId,
      orderId: order.orderId,
      apiKeyId: order.targetApiKeyId,
      purchased: quota,
      remainingAfter: decision.remainingAfter,
      quotaLimitAfter: decision.quotaLimitAfter,
      // §11 measures the reset from the successful top-up PAYMENT, which is not
      // necessarily `now` when a webhook was delayed.
      expiresAt,
    },
  };
}

/**
 * Whether a key is eligible to be offered as a top-up target at checkout (§11: "an
 * existing **active and non-exhausted** key").
 *
 * Used by the storefront to build the picker, so an ineligible key is never offered in the
 * first place. `decideActivation` re-checks at activation time regardless — this is a UX
 * filter, not the enforcement point.
 */
export function isTopUpEligible(
  key: KeyQuotaState,
  purchasedWeightedTokens: number,
  clock: Clock,
): boolean {
  return validateTopUp(key, purchasedWeightedTokens, clock).accepted;
}
