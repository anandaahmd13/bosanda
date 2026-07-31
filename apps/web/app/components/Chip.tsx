/**
 * Status chip (DESIGN.md §4.3).
 *
 * The color mapping is standardized across every surface so an operator or user
 * reads state by color instantly:
 *   healthy/paid/active -> success, pending/degraded -> warning,
 *   expired/error/revoked -> danger, neutral/info -> info.
 *
 * Color is never the only signal: the label text always states the status too,
 * which is what makes this readable for a colorblind user and in grayscale.
 */

import type { KeyStatus, OrderStatus } from "../lib/schemas";

export type ChipTone = "success" | "warning" | "danger" | "info" | "neutral";

export function Chip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}

const KEY_STATUS: Record<KeyStatus, { tone: ChipTone; label: string }> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "danger", label: "Expired" },
  revoked: { tone: "danger", label: "Revoked" },
  exhausted: { tone: "warning", label: "Exhausted" },
};

export function KeyStatusChip({ status }: { status: KeyStatus }) {
  const entry = KEY_STATUS[status];
  return <Chip tone={entry.tone}>{entry.label}</Chip>;
}

/** Order states are exactly PLAN.md §13's machine. */
const ORDER_STATUS: Record<OrderStatus, { tone: ChipTone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  pending_payment: { tone: "warning", label: "Awaiting payment" },
  paid: { tone: "info", label: "Paid" },
  activated: { tone: "success", label: "Activated" },
  expired: { tone: "danger", label: "Expired" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  review_required: { tone: "warning", label: "Under review" },
};

export function OrderStatusChip({ status }: { status: OrderStatus }) {
  const entry = ORDER_STATUS[status];
  return <Chip tone={entry.tone}>{entry.label}</Chip>;
}

/** Human sentence for an order state, used under the chip on the status page. */
export function orderStatusExplanation(status: OrderStatus): string {
  switch (status) {
    case "draft":
      return "This order has not been sent for payment yet.";
    case "pending_payment":
      return "Waiting for your payment to complete. Stock is reserved until it expires.";
    case "paid":
      return "Payment received. Activating your key now.";
    case "activated":
      return "Done. Quota and expiry are on your key.";
    case "expired":
      return "The payment window closed before payment arrived. The reserved stock was released.";
    case "cancelled":
      return "This order was cancelled and the reserved stock was released.";
    case "review_required":
      return "This order needs a manual check by an operator. Contact support with the order ID.";
    default:
      return "";
  }
}
