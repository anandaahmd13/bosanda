/**
 * Status chip. One component for every status surface (DESIGN.md §4.3) so an
 * operator reads state by color consistently across pages.
 *
 * The color is never the ONLY carrier of meaning: the label text always states
 * the status, which is what a screen-reader user and a colorblind operator rely
 * on.
 */

import type { ReactNode } from "react";
import type { AccountStatus, OrderStatus } from "../lib/schemas";

export type ChipTone = "success" | "warning" | "danger" | "info" | "neutral";

export function Chip({
  tone,
  children,
  title,
}: {
  tone: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} {...(title === undefined ? {} : { title })}>
      <span className="chip-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

const ACCOUNT_TONES: Record<AccountStatus, ChipTone> = {
  active: "success",
  cooling_down: "warning",
  credential_invalid: "danger",
  disabled: "neutral",
};

const ACCOUNT_LABELS: Record<AccountStatus, string> = {
  active: "Active",
  cooling_down: "Cooling down",
  credential_invalid: "Credential invalid",
  disabled: "Disabled",
};

export function AccountStatusChip({ status }: { status: AccountStatus }) {
  return <Chip tone={ACCOUNT_TONES[status]}>{ACCOUNT_LABELS[status]}</Chip>;
}

const ORDER_TONES: Record<OrderStatus, ChipTone> = {
  draft: "neutral",
  pending_payment: "warning",
  paid: "info",
  activated: "success",
  expired: "danger",
  cancelled: "neutral",
  review_required: "danger",
};

const ORDER_LABELS: Record<OrderStatus, string> = {
  draft: "Draft",
  pending_payment: "Pending payment",
  paid: "Paid",
  activated: "Activated",
  expired: "Expired",
  cancelled: "Cancelled",
  review_required: "Review required",
};

export function OrderStatusChip({ status }: { status: OrderStatus }) {
  return <Chip tone={ORDER_TONES[status]}>{ORDER_LABELS[status]}</Chip>;
}

export function BooleanChip({
  value,
  trueLabel = "Yes",
  falseLabel = "No",
  trueTone = "success",
  falseTone = "neutral",
}: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
  trueTone?: ChipTone;
  falseTone?: ChipTone;
}) {
  return <Chip tone={value ? trueTone : falseTone}>{value ? trueLabel : falseLabel}</Chip>;
}

export function CompatibilityChip({ status }: { status: "unknown" | "passing" | "failing" }) {
  const tone: ChipTone =
    status === "passing" ? "success" : status === "failing" ? "danger" : "neutral";
  const label = status === "passing" ? "Passing" : status === "failing" ? "Failing" : "Unknown";
  return <Chip tone={tone}>{label}</Chip>;
}

export function HealthStateChip({ state }: { state: "healthy" | "degraded" | "down" }) {
  const tone: ChipTone =
    state === "healthy" ? "success" : state === "degraded" ? "warning" : "danger";
  const label = state === "healthy" ? "Healthy" : state === "degraded" ? "Degraded" : "Down";
  return <Chip tone={tone}>{label}</Chip>;
}

export function KeyStatusChip({
  status,
}: {
  status: "active" | "revoked" | "expired" | "exhausted";
}) {
  const tone: ChipTone =
    status === "active"
      ? "success"
      : status === "exhausted"
        ? "warning"
        : status === "expired"
          ? "neutral"
          : "danger";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Chip tone={tone}>{label}</Chip>;
}
