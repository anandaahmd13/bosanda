import { describe, expect, it } from "vitest";
import { fixedClock } from "@bosanda/shared";
import {
  ACTIVATION_GRACE_MS,
  decideReconcileAction,
  detectActivatedWithoutPayment,
  detectStaleReservation,
  exceededGrace,
  isReconcilable,
  needsProviderCheck,
  planReconcilePass,
} from "../src/reconcile.js";
import type { PakasirTransaction } from "../src/pakasir.js";
import { NOW, clock, order, packageSnapshot, paidOrder } from "./fixtures.js";

const transaction = (overrides: Partial<PakasirTransaction> = {}): PakasirTransaction => ({
  orderId: "01JQORDER00000000000000001",
  status: "paid",
  amountIdr: 9_500,
  providerTransactionId: "trx_synthetic_1",
  paidAt: NOW,
  ...overrides,
});

/** A clock past the activation grace window. */
const afterGrace = fixedClock(new Date(NOW.getTime() + ACTIVATION_GRACE_MS + 1_000));

describe("isReconcilable", () => {
  it("covers pending_payment and paid only", () => {
    expect(isReconcilable(order({ status: "pending_payment" }))).toBe(true);
    expect(isReconcilable(order({ status: "paid" }))).toBe(true);
    for (const status of [
      "draft",
      "activated",
      "expired",
      "cancelled",
      "review_required",
    ] as const) {
      expect(isReconcilable(order({ status }))).toBe(false);
    }
  });
});

describe("detectActivatedWithoutPayment", () => {
  it("flags an activation with no payment behind it", () => {
    const action = detectActivatedWithoutPayment(
      order({ status: "activated", activatedAt: NOW, paidAt: null }),
    );
    expect(action).toMatchObject({ kind: "review_required", reason: "activated_without_payment" });
  });

  it("flags an activatedAt with no status change", () => {
    expect(
      detectActivatedWithoutPayment(order({ status: "paid", activatedAt: NOW, paidAt: null })),
    ).not.toBeNull();
  });

  it("returns null for a properly paid activation", () => {
    expect(
      detectActivatedWithoutPayment(order({ status: "activated", activatedAt: NOW, paidAt: NOW })),
    ).toBeNull();
  });

  it("returns null for a non-activated order", () => {
    expect(detectActivatedWithoutPayment(order())).toBeNull();
  });
});

describe("detectStaleReservation", () => {
  it("flags a pending order past its reservation deadline", () => {
    const stale = order({ stockReservationExpiresAt: new Date(NOW.getTime() - 1) });
    const action = detectStaleReservation(stale, clock);
    expect(action?.kind).toBe("release_stale_reservation");
    expect(action).toMatchObject({ release: { units: 1, weightedTokenQuota: 10_000_000 } });
  });

  it("does not flag a live reservation", () => {
    expect(detectStaleReservation(order(), clock)).toBeNull();
  });

  it("does not flag an order with no reservation deadline", () => {
    expect(detectStaleReservation(order({ stockReservationExpiresAt: null }), clock)).toBeNull();
  });

  it("does not flag a non-pending order", () => {
    expect(
      detectStaleReservation(
        order({ status: "paid", stockReservationExpiresAt: new Date(NOW.getTime() - 1) }),
        clock,
      ),
    ).toBeNull();
  });
});

describe("exceededGrace", () => {
  it("is false inside the window and true past it", () => {
    expect(exceededGrace(paidOrder(), clock)).toBe(false);
    expect(exceededGrace(paidOrder(), afterGrace)).toBe(true);
  });

  it("falls back to createdAt when paidAt is absent", () => {
    const created = order({ status: "paid", paidAt: null, createdAt: new Date(NOW.getTime() - 1) });
    expect(exceededGrace(created, clock)).toBe(false);
    expect(exceededGrace(created, afterGrace)).toBe(true);
  });
});

describe("decideReconcileAction — paid but not activated", () => {
  it("activates a genuinely paid order when the webhook was lost", () => {
    const action = decideReconcileAction(paidOrder(), transaction(), clock);
    expect(action).toMatchObject({ kind: "activate" });
  });

  it("activates a pending order the provider reports as paid", () => {
    const action = decideReconcileAction(
      order({ status: "pending_payment" }),
      transaction(),
      clock,
    );
    expect(action.kind).toBe("activate");
  });

  it("routes an amount mismatch to review instead of activating", () => {
    const action = decideReconcileAction(paidOrder(), transaction({ amountIdr: 1 }), clock);
    expect(action).toMatchObject({ kind: "review_required", reason: "amount_mismatch" });
  });

  it("treats an absent provider amount as unstated, not as a mismatch", () => {
    const action = decideReconcileAction(paidOrder(), transaction({ amountIdr: null }), clock);
    expect(action.kind).toBe("activate");
  });

  it("routes a snapshot price mismatch to review", () => {
    const action = decideReconcileAction(paidOrder({ amountIdr: 1_000 }), transaction(), clock);
    expect(action).toMatchObject({ kind: "review_required", reason: "snapshot_price_mismatch" });
  });

  it("escalates a paid order with no provider view once grace has passed", () => {
    expect(decideReconcileAction(paidOrder(), null, clock)).toEqual({
      kind: "none",
      reason: "within_grace",
    });
    expect(decideReconcileAction(paidOrder(), null, afterGrace)).toMatchObject({
      kind: "review_required",
      reason: "paid_but_not_activated",
    });
  });

  it("escalates when we say paid but the provider still says pending", () => {
    const stillPending = transaction({ status: "pending" });
    expect(decideReconcileAction(paidOrder(), stillPending, clock)).toEqual({
      kind: "none",
      reason: "within_grace",
    });
    expect(decideReconcileAction(paidOrder(), stillPending, afterGrace)).toMatchObject({
      kind: "review_required",
      reason: "paid_but_not_activated",
    });
  });
});

describe("decideReconcileAction — activated but not paid", () => {
  it("outranks whatever the provider reports", () => {
    const orphan = order({ status: "activated", activatedAt: NOW, paidAt: null });
    const action = decideReconcileAction(orphan, transaction({ status: "paid" }), clock);
    expect(action).toMatchObject({ kind: "review_required", reason: "activated_without_payment" });
  });
});

describe("decideReconcileAction — terminal and expiry branches", () => {
  it("does nothing for an already-activated, properly paid order", () => {
    const action = decideReconcileAction(
      paidOrder({ status: "activated", activatedAt: NOW }),
      transaction(),
      clock,
    );
    expect(action).toEqual({ kind: "none", reason: "already_activated" });
  });

  it("does nothing for a terminal order", () => {
    for (const status of ["expired", "cancelled", "review_required", "draft"] as const) {
      expect(decideReconcileAction(order({ status }), transaction(), clock)).toEqual({
        kind: "none",
        reason: "terminal",
      });
    }
  });

  it("releases a stale reservation before consulting the provider", () => {
    const stale = order({ stockReservationExpiresAt: new Date(NOW.getTime() - 1) });
    const action = decideReconcileAction(stale, transaction({ status: "paid" }), clock);
    expect(action.kind).toBe("release_stale_reservation");
  });

  it("expires and releases stock when the provider says expired", () => {
    const action = decideReconcileAction(order(), transaction({ status: "expired" }), clock);
    expect(action).toMatchObject({
      kind: "expire_and_release_stock",
      release: { units: 1 },
    });
  });

  it("cancels and releases stock on failed or cancelled", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const action = decideReconcileAction(order(), transaction({ status }), clock);
      expect(action.kind).toBe("cancel_and_release_stock");
    }
  });

  it("waits on a pending order the provider also calls pending", () => {
    expect(decideReconcileAction(order(), transaction({ status: "pending" }), clock)).toEqual({
      kind: "none",
      reason: "still_pending",
    });
  });

  it("waits on a pending order with no provider view", () => {
    expect(decideReconcileAction(order(), null, clock)).toEqual({
      kind: "none",
      reason: "still_pending",
    });
  });

  it("reports no release for a stock-exempt top-up", () => {
    const topUp = order({ type: "top_up", targetApiKeyId: "01JQKEY1" });
    const action = decideReconcileAction(topUp, transaction({ status: "expired" }), clock);
    expect(action).toMatchObject({ kind: "expire_and_release_stock" });
    if (action.kind !== "expire_and_release_stock") return;
    // Default policy consumes stock, so a release IS expected here.
    expect(action.release).not.toBeNull();
  });
});

describe("needsProviderCheck", () => {
  it("is true for a live pending or paid order", () => {
    expect(needsProviderCheck(order(), clock)).toBe(true);
    expect(needsProviderCheck(paidOrder(), clock)).toBe(true);
  });

  it("is false when the answer is already known locally", () => {
    expect(needsProviderCheck(order({ status: "cancelled" }), clock)).toBe(false);
    expect(
      needsProviderCheck(order({ stockReservationExpiresAt: new Date(NOW.getTime() - 1) }), clock),
    ).toBe(false);
    expect(
      needsProviderCheck(order({ status: "activated", activatedAt: NOW, paidAt: null }), clock),
    ).toBe(false);
  });
});

describe("planReconcilePass", () => {
  it("splits locally-decidable orders from those needing a lookup", () => {
    const stale = order({
      orderId: "01JQORDER00000000000000002",
      stockReservationExpiresAt: new Date(NOW.getTime() - 1),
    });
    const orphan = order({
      orderId: "01JQORDER00000000000000003",
      status: "activated",
      activatedAt: NOW,
      paidAt: null,
    });
    const live = order({ orderId: "01JQORDER00000000000000004" });
    const terminal = order({ orderId: "01JQORDER00000000000000005", status: "cancelled" });

    const plan = planReconcilePass([stale, orphan, live, terminal], clock);

    expect(plan.needsCheck.map((o) => o.orderId)).toEqual(["01JQORDER00000000000000004"]);
    expect(plan.local.map((a) => a.kind).sort()).toEqual(
      ["release_stale_reservation", "review_required"].sort(),
    );
  });

  it("returns nothing for an empty batch", () => {
    expect(planReconcilePass([], clock)).toEqual({ local: [], needsCheck: [] });
  });

  it("omits no-op orders from the local action list", () => {
    const plan = planReconcilePass([order({ status: "expired" })], clock);
    expect(plan.local).toEqual([]);
    expect(plan.needsCheck).toEqual([]);
  });

  it("uses the snapshot quota for the release size", () => {
    const stale = order({
      packageSnapshot: packageSnapshot({ weightedTokenQuota: 50_000_000 }),
      stockReservationExpiresAt: new Date(NOW.getTime() - 1),
    });
    const plan = planReconcilePass([stale], clock);
    const action = plan.local[0];
    expect(action?.kind).toBe("release_stale_reservation");
    if (action?.kind !== "release_stale_reservation") return;
    expect(action.release?.weightedTokenQuota).toBe(50_000_000);
  });
});
