/**
 * Reconciliation dispatch (PLAN.md §13).
 *
 * WHAT THESE TESTS ARE FOR. The DECISIONS are already proven without a network in
 * `packages/payments/test/reconcile.test.ts`; re-asserting them here would duplicate that
 * coverage and couple this suite to policy it does not own. What is unproven until now is
 * the dispatch: that each of the six `ReconcileAction` arms reaches the right transaction
 * with the right arguments, that a lost CAS is a no-op rather than an error, and that one
 * bad order does not take the pass down.
 */

import { describe, expect, it } from "vitest";
import { reconcileJob, RECONCILE_BATCH, RECONCILE_MIN_AGE_MS } from "../src/jobs/reconcile.js";
import {
  FIXED_NOW,
  immediateTransact,
  makeOrder,
  makeTransaction,
  recordingLogger,
  testClock,
  testRegistry,
  txRecorder,
  type TxRecorder,
} from "./harness.js";

type Deps = Parameters<typeof reconcileJob>[0];

function build(
  orders: ReturnType<typeof makeOrder>[],
  options: {
    transaction?: ReturnType<typeof makeTransaction> | null;
    lookupThrows?: boolean;
    recorder?: TxRecorder;
  } = {},
): { deps: Deps; recorder: TxRecorder; logger: ReturnType<typeof recordingLogger> } {
  const recorder = options.recorder ?? txRecorder({ orders });
  const logger = recordingLogger();
  const deps = {
    orders: {
      listReconcilable: async () => orders,
      listStaleReservations: async () => [],
    },
    clock: testClock(),
    logger: logger as never,
    metrics: testRegistry(),
    checkTransaction: async () => {
      if (options.lookupThrows === true) throw new Error("network down");
      return options.transaction ?? null;
    },
    transact: immediateTransact(recorder),
  } satisfies Deps;
  return { deps, recorder, logger };
}

describe("reconcileJob", () => {
  it("does nothing and touches no transaction when there is no work", async () => {
    const { deps, recorder } = build([]);
    const result = await reconcileJob(deps)();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(recorder.calls).toEqual([]);
  });

  it("only considers orders older than the minimum age", async () => {
    let seen: Date | null = null;
    const deps = {
      ...build([]).deps,
      orders: {
        listReconcilable: async (olderThan: Date) => {
          seen = olderThan;
          return [];
        },
        listStaleReservations: async () => [],
      },
    } satisfies Deps;

    await reconcileJob(deps)();
    expect(seen).toEqual(new Date(FIXED_NOW.getTime() - RECONCILE_MIN_AGE_MS));
  });

  it("activates nothing automatically: a paid, unactivated order is escalated for review", async () => {
    /**
     * The safety property. `executeActivation` is not wired into the worker yet, so the
     * `activate` arm must escalate rather than half-activate. If someone later implements
     * activation here, this test is what tells them to also delete it deliberately rather
     * than discovering the change by accident.
     */
    const order = makeOrder({
      status: "paid",
      paidAt: new Date(FIXED_NOW.getTime() - 3_600_000),
      stockReservationExpiresAt: null,
    });
    const { deps, recorder, logger } = build([order], { transaction: makeTransaction() });

    const result = await reconcileJob(deps)();

    expect(result.processed).toBe(1);
    expect(recorder.calls).toContain(`markReviewRequired:${order.id}:paid_but_not_activated`);
    expect(recorder.calls).not.toContain(`markActivated:${order.id}`);
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("expires and releases stock when the provider says the transaction expired", async () => {
    const order = makeOrder();
    const { deps, recorder } = build([order], {
      transaction: makeTransaction({ status: "expired", paidAt: null }),
    });

    const result = await reconcileJob(deps)();

    expect(result.processed).toBe(1);
    expect(recorder.calls).toContain(`markExpired:${order.id}`);
    expect(recorder.calls).toContain("lockStock:pkg-small");
    expect(recorder.calls).toContain("releaseStock:pkg-small:1:v3");
    expect(recorder.audits.map((a) => a.action)).toContain("order.expired");
  });

  it("cancels and releases stock when the provider says the payment failed", async () => {
    const order = makeOrder();
    const { deps, recorder } = build([order], {
      transaction: makeTransaction({ status: "failed", paidAt: null }),
    });

    await reconcileJob(deps)();

    expect(recorder.calls).toContain(`markCancelled:${order.id}`);
    expect(recorder.calls).toContain("releaseStock:pkg-small:1:v3");
    expect(recorder.audits.map((a) => a.action)).toContain("order.cancelled");
  });

  it("does not release stock when the close lost its CAS", async () => {
    /**
     * A null return from `markExpired` means a webhook or another replica moved the order
     * first. Whoever won owns the unit's fate, so releasing here would give back a unit that
     * may since have been committed as a sale.
     */
    const order = makeOrder();
    const recorder = txRecorder({ orders: [order], markReturnsNull: true });
    const { deps } = build([order], {
      transaction: makeTransaction({ status: "expired", paidAt: null }),
      recorder,
    });

    await reconcileJob(deps)();

    expect(recorder.calls).toContain(`markExpired:${order.id}`);
    expect(recorder.calls.some((c) => c.startsWith("releaseStock"))).toBe(false);
    expect(recorder.audits).toEqual([]);
  });

  it("releases a lapsed reservation without ending the order", async () => {
    /**
     * §11 separates the reservation window from the payment window: the unit goes back, the
     * order stays `pending_payment` so a customer mid-payment is not rejected.
     */
    const order = makeOrder({
      stockReservationExpiresAt: new Date(FIXED_NOW.getTime() - 1_000),
    });
    const { deps, recorder } = build([order]);

    const result = await reconcileJob(deps)();

    expect(result.processed).toBe(1);
    expect(recorder.calls).toContain("releaseStock:pkg-small:1:v3");
    expect(recorder.calls.some((c) => c.startsWith("markExpired"))).toBe(false);
    expect(recorder.calls.some((c) => c.startsWith("markCancelled"))).toBe(false);
    expect(recorder.audits.map((a) => a.action)).toContain("order.reservation_released");
  });

  it("skips the release when the order left pending before the transaction opened", async () => {
    const order = makeOrder({
      stockReservationExpiresAt: new Date(FIXED_NOW.getTime() - 1_000),
    });
    // The locked read returns an activated order: an activation committed in between, so its
    // unit is sold, not reserved.
    const recorder = txRecorder({
      orders: [makeOrder({ ...order, status: "activated", activatedAt: FIXED_NOW })],
    });
    const { deps } = build([order], { recorder });

    await reconcileJob(deps)();

    expect(recorder.calls).toContain(`lockById:${order.id}`);
    expect(recorder.calls.some((c) => c.startsWith("releaseStock"))).toBe(false);
  });

  it("treats a failed stock CAS as already released rather than failing the pass", async () => {
    const order = makeOrder();
    const recorder = txRecorder({
      orders: [order],
      releaseOutcome: { ok: false, reason: "insufficient" },
    });
    const { deps, logger } = build([order], {
      transaction: makeTransaction({ status: "expired", paidAt: null }),
      recorder,
    });

    const result = await reconcileJob(deps)();

    // The order still closed; only the release was a no-op.
    expect(result.failed).toBe(0);
    expect(recorder.calls).toContain(`markExpired:${order.id}`);
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("handles a package with no stock row", async () => {
    const order = makeOrder();
    const recorder = txRecorder({ orders: [order], stock: null });
    const { deps } = build([order], {
      transaction: makeTransaction({ status: "expired", paidAt: null }),
      recorder,
    });

    const result = await reconcileJob(deps)();

    expect(result.failed).toBe(0);
    expect(recorder.calls).toContain("lockStock:pkg-small");
    expect(recorder.calls.some((c) => c.startsWith("releaseStock"))).toBe(false);
  });

  it("escalates an activation with no payment behind it", async () => {
    const order = makeOrder({
      status: "activated",
      activatedAt: FIXED_NOW,
      paidAt: null,
      stockReservationExpiresAt: null,
    });
    const { deps, recorder } = build([order]);

    await reconcileJob(deps)();

    expect(recorder.calls).toContain(`markReviewRequired:${order.id}:activated_without_payment`);
  });

  it("counts a malformed order as failed without stopping the pass", async () => {
    /**
     * `toOrderSnapshot` throws on a non-pakasir provider. One data defect must not prevent
     * the other orders in the batch from being reconciled.
     */
    const bad = makeOrder({ id: "01HQORDER0000000000000002", provider: "stripe" });
    const good = makeOrder({
      stockReservationExpiresAt: new Date(FIXED_NOW.getTime() - 1_000),
    });
    const recorder = txRecorder({ orders: [bad, good] });
    const { deps, logger } = build([bad, good], { recorder });

    const result = await reconcileJob(deps)();

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);
    expect(recorder.calls).toContain("releaseStock:pkg-small:1:v3");
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
  });

  it("defers to the grace policy when the provider lookup throws", async () => {
    /**
     * A lookup failure must not be fatal and must not be mistaken for a status. Inside the
     * grace window a paid order waits, which means no transaction at all.
     */
    const order = makeOrder({
      status: "paid",
      paidAt: FIXED_NOW,
      stockReservationExpiresAt: null,
    });
    const { deps, recorder, logger } = build([order], { lookupThrows: true });

    const result = await reconcileJob(deps)();

    expect(result).toEqual({ processed: 0, failed: 0, saturated: false });
    expect(recorder.calls).toEqual([]);
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("reports saturation when the batch came back full", async () => {
    const orders = Array.from({ length: RECONCILE_BATCH }, (_, index) =>
      makeOrder({
        id: `01HQORDER${String(index).padStart(17, "0")}`,
        status: "paid",
        paidAt: FIXED_NOW,
        stockReservationExpiresAt: null,
      }),
    );
    const { deps } = build(orders);

    const result = await reconcileJob(deps)();

    expect(result.saturated).toBe(true);
  });

  it("counts actions by kind on the metrics registry", async () => {
    const order = makeOrder({
      stockReservationExpiresAt: new Date(FIXED_NOW.getTime() - 1_000),
    });
    const metrics = testRegistry();
    const recorder = txRecorder({ orders: [order] });
    const base = build([order], { recorder }).deps;
    const deps = { ...base, metrics } satisfies Deps;

    await reconcileJob(deps)();

    expect(
      metrics.read("bosanda_worker_actions_total", { kind: "release_stale_reservation" }),
    ).toBe(1);
  });

  it("records the grace window on every audit row", async () => {
    /**
     * The audit metadata has to be enough to reconstruct why the worker acted, and the grace
     * constant is the one input to that decision an operator cannot see from the order row.
     */
    const order = makeOrder({
      status: "paid",
      paidAt: new Date(FIXED_NOW.getTime() - 3_600_000),
      stockReservationExpiresAt: null,
    });
    const { deps, recorder } = build([order], { transaction: makeTransaction() });

    await reconcileJob(deps)();

    expect(recorder.audits[0]?.metadata).toMatchObject({ graceMs: 900_000 });
  });
});
