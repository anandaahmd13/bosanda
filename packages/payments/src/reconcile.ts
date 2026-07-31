/**
 * Reconciliation decisions (PLAN.md §13 "Reconciliation").
 *
 * §13: "A worker polls/checks Pakasir status for pending or ambiguous orders.
 * Reconciliation can activate a genuinely paid order when a webhook is delayed, but uses
 * the same idempotent activation transaction."
 *
 * Three drift classes are in scope:
 *  1. paid-but-not-activated — money arrived, activation did not (delayed or lost webhook);
 *  2. activated-but-not-paid — activation exists with no payment behind it, which the §14
 *     CHECK constraints already forbid, so seeing it means something is wrong that a human
 *     must look at;
 *  3. a stale stock reservation on a pending order (§11).
 *
 * Every function here is a PURE decision over a snapshot returning an explicit action, so
 * the worker is a dispatch loop with no policy in it. The provider status is passed in
 * rather than fetched, so these branches are testable without a network.
 */

import { type Clock, isExpired } from "@bosanda/shared";
import type { OrderSnapshot } from "./types.js";
import type { PakasirTransaction } from "./pakasir.js";
import { isReservationExpired, releaseReservation, type StockRelease } from "./stock.js";

/** How long a paid order may sit un-activated before it is escalated rather than retried. */
export const ACTIVATION_GRACE_MS = 15 * 60 * 1000;

/**
 * What the worker should do about one order. Each variant names a single durable operation
 * so the dispatch loop cannot invent a combination §13 did not authorize.
 */
export type ReconcileAction =
  /** In step, or too early to judge. */
  | { kind: "none"; reason: NoneReason }
  /** Provider says paid; run the SAME idempotent activation transaction the webhook uses. */
  | { kind: "activate"; order: OrderSnapshot; transaction: PakasirTransaction }
  /** Provider says paid but our order does not agree about the money. */
  | { kind: "review_required"; order: OrderSnapshot; reason: ReviewReason }
  /** Pending order whose provider transaction expired: close it and free the unit. */
  | { kind: "expire_and_release_stock"; order: OrderSnapshot; release: StockRelease | null }
  /** Provider says the payment failed or was cancelled. */
  | { kind: "cancel_and_release_stock"; order: OrderSnapshot; release: StockRelease | null }
  /** Reservation window lapsed while still pending (§11). */
  | { kind: "release_stale_reservation"; order: OrderSnapshot; release: StockRelease | null };

export type NoneReason =
  "not_reconcilable" | "still_pending" | "already_activated" | "within_grace" | "terminal";

export type ReviewReason =
  | "amount_mismatch"
  | "currency_mismatch"
  | "snapshot_price_mismatch"
  | "activated_without_payment"
  | "paid_but_not_activated";

/** Order states the worker may act on at all. */
export function isReconcilable(order: OrderSnapshot): boolean {
  return order.status === "pending_payment" || order.status === "paid";
}

/**
 * Drift class 2: activation with no payment behind it.
 *
 * The §14 constraints `orders_paid_before_activated` and `orders_activated_implies_status`
 * make this unreachable through normal writes, so it can only come from a manual edit or a
 * restore. There is no safe automatic repair — revoking quota a customer is using and
 * fabricating a payment are both wrong — so it always goes to a human (§13 review).
 */
export function detectActivatedWithoutPayment(order: OrderSnapshot): ReconcileAction | null {
  const activated = order.status === "activated" || order.activatedAt !== null;
  if (!activated) return null;
  if (order.paidAt !== null) return null;

  return { kind: "review_required", order, reason: "activated_without_payment" };
}

/**
 * Drift class 3: a pending order whose reservation window has lapsed (§11 "Expired/cancelled
 * pending orders release the reservation").
 *
 * Checked before any provider call, because a lapsed reservation is decidable from local
 * state alone and holding a unit hostage to a network round trip would be wasteful.
 */
export function detectStaleReservation(order: OrderSnapshot, clock: Clock): ReconcileAction | null {
  if (!isReservationExpired(order, clock)) return null;
  return {
    kind: "release_stale_reservation",
    order,
    release: releaseReservation(order),
  };
}

/**
 * Amount and currency validation against the immutable snapshot, shared by the paid paths.
 * Returns a review reason, or null when the money agrees.
 *
 * A provider-reported amount of null means "not stated"; §13 forbids trusting provider price
 * data as authoritative anyway, so an absent amount is not treated as a mismatch. The order
 * snapshot remains the only source for what was actually owed.
 */
function moneyDisagreement(
  order: OrderSnapshot,
  transaction: PakasirTransaction,
): ReviewReason | null {
  if (order.currency !== "IDR") return "currency_mismatch";
  if (order.amountIdr !== order.packageSnapshot.priceIdr) return "snapshot_price_mismatch";
  if (transaction.amountIdr !== null && transaction.amountIdr !== order.amountIdr) {
    return "amount_mismatch";
  }
  return null;
}

/**
 * The main decision: what does the provider's view mean for this order?
 *
 * `transaction` is what a status lookup returned for this order. The caller has already
 * confirmed the ids correspond; this function decides policy only.
 */
export function decideReconcileAction(
  order: OrderSnapshot,
  transaction: PakasirTransaction | null,
  clock: Clock,
): ReconcileAction {
  // Drift class 2 first: it is decidable locally and outranks anything the provider says.
  const orphanedActivation = detectActivatedWithoutPayment(order);
  if (orphanedActivation !== null) return orphanedActivation;

  if (order.status === "activated") return { kind: "none", reason: "already_activated" };
  if (!isReconcilable(order)) return { kind: "none", reason: "terminal" };

  // Drift class 3, before consulting the provider.
  const stale = detectStaleReservation(order, clock);
  if (stale !== null) return stale;

  if (transaction === null) {
    // No provider view available. A paid order that has waited past the grace window is
    // escalated rather than retried forever; anything else waits for the next pass.
    if (order.status === "paid") {
      return exceededGrace(order, clock)
        ? { kind: "review_required", order, reason: "paid_but_not_activated" }
        : { kind: "none", reason: "within_grace" };
    }
    return { kind: "none", reason: "still_pending" };
  }

  switch (transaction.status) {
    case "paid": {
      // Drift class 1: genuinely paid, not yet activated. Same idempotent transaction as
      // the webhook path, so a webhook landing concurrently cannot double-credit.
      const disagreement = moneyDisagreement(order, transaction);
      if (disagreement !== null) return { kind: "review_required", order, reason: disagreement };
      return { kind: "activate", order, transaction };
    }

    case "expired":
      return {
        kind: "expire_and_release_stock",
        order,
        release: releaseReservation(order),
      };

    case "failed":
    case "cancelled":
      return {
        kind: "cancel_and_release_stock",
        order,
        release: releaseReservation(order),
      };

    case "pending": {
      // The provider still shows pending. If OUR record says paid, the two disagree about
      // money that has supposedly moved — escalate once the grace window has passed.
      if (order.status === "paid") {
        return exceededGrace(order, clock)
          ? { kind: "review_required", order, reason: "paid_but_not_activated" }
          : { kind: "none", reason: "within_grace" };
      }
      return { kind: "none", reason: "still_pending" };
    }
  }
}

/** Has a paid order waited past the activation grace window? */
export function exceededGrace(
  order: OrderSnapshot,
  clock: Clock,
  graceMs: number = ACTIVATION_GRACE_MS,
): boolean {
  const since = order.paidAt ?? order.createdAt;
  return isExpired(new Date(since.getTime() + graceMs), clock.now());
}

/**
 * Which orders a reconciliation pass should fetch a provider status for.
 *
 * A lapsed reservation and an orphaned activation are both decidable from local state, so
 * they are excluded — that keeps the pass from making a network call per order when the
 * answer is already known.
 */
export function needsProviderCheck(order: OrderSnapshot, clock: Clock): boolean {
  if (!isReconcilable(order)) return false;
  if (detectActivatedWithoutPayment(order) !== null) return false;
  if (isReservationExpired(order, clock)) return false;
  return true;
}

/**
 * Partitions a batch into locally-decidable actions and orders still needing a provider
 * lookup. Lets the worker resolve the cheap cases in one pass before spending any network.
 */
export function planReconcilePass(
  orders: readonly OrderSnapshot[],
  clock: Clock,
): { local: ReconcileAction[]; needsCheck: OrderSnapshot[] } {
  const local: ReconcileAction[] = [];
  const needsCheck: OrderSnapshot[] = [];

  for (const order of orders) {
    if (needsProviderCheck(order, clock)) {
      needsCheck.push(order);
      continue;
    }
    const action = decideReconcileAction(order, null, clock);
    if (action.kind !== "none") local.push(action);
  }

  return { local, needsCheck };
}
