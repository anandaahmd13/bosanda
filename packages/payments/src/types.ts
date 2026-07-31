/**
 * Order and payment types (PLAN.md §13 "Pakasir payment flow", §14 `orders` /
 * `payment_events`).
 *
 * These mirror the immutable columns the database layer owns. Every module in this
 * package treats an `OrderSnapshot` as READ-ONLY server-created truth: §13 "Webhook
 * requirements" forbids trusting price, package, username, or quota from webhook data,
 * so the snapshot is the only thing amount/currency validation may compare against.
 */

/** Order lifecycle from §13 "Order states". */
export type OrderStatus =
  "draft" | "pending_payment" | "paid" | "activated" | "expired" | "cancelled" | "review_required";

/** §11 "New key versus top-up". */
export type OrderType = "new_key" | "top_up";

export type PaymentProvider = "pakasir";

/**
 * The purchase snapshot frozen onto the order at checkout (§11: "Existing paid orders
 * retain their purchase snapshot"). Prices are admin-managed, so nothing downstream may
 * recompute the price from the quota — it compares against this instead.
 */
export type PackageSnapshot = {
  readonly packageId: string;
  /** Weighted tokens purchased. A 10M increment, 10M..100M (§11). */
  readonly weightedTokenQuota: number;
  /** Integer rupiah. Never a float (§14). */
  readonly priceIdr: number;
  /** Per-key quota ceiling in force when the order was created (§11: 100M). */
  readonly maxKeyQuota: number;
  /** Validity window granted on activation, seconds (§11: 24h). */
  readonly durationSeconds: number;
};

/** The subset of an `orders` row this package reasons about (§14). */
export type OrderSnapshot = {
  readonly orderId: string;
  readonly userId: string;
  readonly type: OrderType;
  /** The key being topped up. Always null for a `new_key` order. */
  readonly targetApiKeyId: string | null;
  readonly packageSnapshot: PackageSnapshot;
  /** Integer rupiah actually charged. Must equal `packageSnapshot.priceIdr`. */
  readonly amountIdr: number;
  /** Version 1 sells in rupiah only. */
  readonly currency: "IDR";
  readonly status: OrderStatus;
  /** §11: stock is reserved while payment is pending, for a configured period. */
  readonly stockReservationExpiresAt: Date | null;
  readonly provider: PaymentProvider;
  readonly providerTransactionId: string | null;
  readonly paidAt: Date | null;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
};

/** Normalized payment state, mapped from provider vocabulary. */
export type PaymentStatus = "pending" | "paid" | "failed" | "expired" | "cancelled";

/**
 * Guard for §14's "integer rupiah, never a float". Rejects NaN, Infinity, negatives,
 * zero, and anything with a fractional part.
 */
export function isIntegerRupiah(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
