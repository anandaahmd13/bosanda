/**
 * Stock reservation decisions (PLAN.md §11 "Stock").
 *
 * §11 in full: stock is managed per package SIZE; a successful new-key order consumes one
 * unit of that size; stock is reserved while payment is pending for a configured period;
 * expired or cancelled pending orders release the reservation; webhook processing is
 * idempotent and never decrements twice; and top-up policy is explicit in the package
 * configuration, defaulting to consuming one unit of the purchased size.
 *
 * Pure decisions again — §16 invariant 5 requires the actual decrement to happen under a
 * row lock or compare-and-swap inside a transaction, which belongs to @bosanda/database.
 * This module answers "may we?" and "how much?"; the caller answers "commit".
 */

import { BosandaError } from "@bosanda/protocol";
import { type Clock, addMs, isExpired } from "@bosanda/shared";
import type { OrderSnapshot, OrderType } from "./types.js";

/** Default reservation window while payment is pending (§11 "configured period"). */
export const DEFAULT_RESERVATION_MS = 30 * 60 * 1000;

/**
 * Per-size stock state, as read under a row lock.
 *
 * `available` is the physical count. `reserved` is how many of those are currently held by
 * pending orders. Both are tracked because §11 needs "reserved while payment is pending"
 * to be releasable without losing the underlying unit.
 */
export type StockState = {
  /** Package size in weighted tokens — stock is per SIZE, not per package row (§11). */
  readonly weightedTokenQuota: number;
  readonly available: number;
  readonly reserved: number;
};

/** Whether a top-up consumes stock. §11: explicit in package config, defaults to true. */
export type TopUpStockPolicy = "consume" | "exempt";

export const DEFAULT_TOP_UP_STOCK_POLICY: TopUpStockPolicy = "consume";

/** Units still sellable right now. */
export function freeStock(state: StockState): number {
  return Math.max(0, state.available - state.reserved);
}

/**
 * Does an order of this type consume a stock unit?
 *
 * A new-key order always does. A top-up follows the package's policy, defaulting to
 * consuming one unit of the purchased size (§11).
 */
export function consumesStock(
  type: OrderType,
  policy: TopUpStockPolicy = DEFAULT_TOP_UP_STOCK_POLICY,
): boolean {
  return type === "new_key" || policy === "consume";
}

export type ReservationDecision =
  | {
      reserved: true;
      /** Units to hold. 0 when this order type is exempt. */
      units: number;
      /** Null when nothing is held, so no release job is needed. */
      expiresAt: Date | null;
    }
  | { reserved: false; error: BosandaError };

/**
 * May we reserve stock for this order, and until when? (§11 "Stock is reserved while
 * payment is pending for a configured period.")
 *
 * Out-of-stock is `conflict` (409) rather than `invalid_request`: the request is well-formed
 * and would succeed later, which is exactly what §8 maps 409 to.
 */
export function reserveStock(
  state: StockState,
  type: OrderType,
  clock: Clock,
  options: { policy?: TopUpStockPolicy; reservationMs?: number } = {},
): ReservationDecision {
  const policy = options.policy ?? DEFAULT_TOP_UP_STOCK_POLICY;
  const reservationMs = options.reservationMs ?? DEFAULT_RESERVATION_MS;

  if (!consumesStock(type, policy)) {
    return { reserved: true, units: 0, expiresAt: null };
  }

  if (!Number.isInteger(state.available) || !Number.isInteger(state.reserved)) {
    return {
      reserved: false,
      error: new BosandaError("internal_error", {
        internalDetail: `stock counts for size ${state.weightedTokenQuota} are not integers`,
      }),
    };
  }

  if (freeStock(state) < 1) {
    return {
      reserved: false,
      error: new BosandaError("conflict", {
        internalDetail: `no stock for size ${state.weightedTokenQuota} (available ${state.available}, reserved ${state.reserved})`,
      }),
    };
  }

  return { reserved: true, units: 1, expiresAt: addMs(clock.now(), reservationMs) };
}

/**
 * Has a pending order's reservation lapsed? (§11 "Expired/cancelled pending orders release
 * the reservation.")
 *
 * Only `pending_payment` orders hold a reservation, so nothing else can be swept. An order
 * with no expiry recorded is treated as not lapsed — a missing deadline must not become a
 * reason to release stock out from under a live checkout.
 */
export function isReservationExpired(order: OrderSnapshot, clock: Clock): boolean {
  if (order.status !== "pending_payment") return false;
  if (order.stockReservationExpiresAt === null) return false;
  return isExpired(order.stockReservationExpiresAt, clock.now());
}

export type StockRelease = {
  /** Units to return to the free pool. */
  readonly units: number;
  readonly weightedTokenQuota: number;
  readonly orderId: string;
};

/**
 * The release for a lapsed or cancelled pending order.
 *
 * Returns null when there is nothing to release, which keeps the sweeper's call site free
 * of "did this one actually hold anything" branching.
 */
export function releaseReservation(
  order: OrderSnapshot,
  options: { policy?: TopUpStockPolicy } = {},
): StockRelease | null {
  if (!consumesStock(order.type, options.policy ?? DEFAULT_TOP_UP_STOCK_POLICY)) return null;
  if (order.status !== "pending_payment") return null;

  return {
    units: 1,
    weightedTokenQuota: order.packageSnapshot.weightedTokenQuota,
    orderId: order.orderId,
  };
}

export type ConsumptionDecision =
  { consume: true; units: number } | { consume: false; reason: "exempt" | "already_consumed" };

/**
 * Convert a held reservation into a real decrement at activation (§13 step 8: "consumes
 * stock" inside the one idempotent transaction).
 *
 * `alreadyConsumed` is the caller's read of whether this order's stock was already taken —
 * §11 requires that webhook processing "never decrements stock twice", and the honest way
 * to express that here is to let the caller pass what it observed under the lock rather
 * than to keep state in this module.
 */
export function consumeStock(
  order: OrderSnapshot,
  alreadyConsumed: boolean,
  options: { policy?: TopUpStockPolicy } = {},
): ConsumptionDecision {
  if (!consumesStock(order.type, options.policy ?? DEFAULT_TOP_UP_STOCK_POLICY)) {
    return { consume: false, reason: "exempt" };
  }
  if (alreadyConsumed) return { consume: false, reason: "already_consumed" };
  return { consume: true, units: 1 };
}
