/**
 * Stale stock reservation cleanup (PLAN.md §11).
 *
 * This job's whole reason for existing is the orders reconciliation cannot see: an order that
 * held a unit and then died before a checkout was created has no `provider_transaction_id`,
 * so `listReconcilable` skips it forever. The tests that matter here are the ones proving it
 * releases a hold without ending the order, and that it re-checks state under the row lock
 * before decrementing anything.
 */

import { describe, expect, it } from "vitest";
import { RESERVATION_BATCH, reservationCleanupJob } from "../src/jobs/reservations.js";
import {
  FIXED_NOW,
  immediateTransact,
  makeOrder,
  recordingLogger,
  testClock,
  testRegistry,
  txRecorder,
  type TxRecorder,
} from "./harness.js";

type Deps = Parameters<typeof reservationCleanupJob>[0];

function build(
  stale: ReturnType<typeof makeOrder>[],
  recorder: TxRecorder,
): { deps: Deps; logger: ReturnType<typeof recordingLogger>; listArgs: unknown[] } {
  const logger = recordingLogger();
  const listArgs: unknown[] = [];
  return {
    logger,
    listArgs,
    deps: {
      orders: {
        listStaleReservations: async (now: Date, limit: number) => {
          listArgs.push({ now, limit });
          return stale;
        },
      },
      clock: testClock(),
      logger: logger as never,
      metrics: testRegistry(),
      transact: immediateTransact(recorder),
    } as Deps,
  };
}

describe("reservationCleanupJob", () => {
  it("does nothing and opens no transaction when no reservation has lapsed", async () => {
    const recorder = txRecorder();
    const { deps } = build([], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(recorder.calls).toEqual([]);
  });

  it("queries with the current time so the database picks the lapsed rows", async () => {
    const recorder = txRecorder();
    const { deps, listArgs } = build([], recorder);

    await reservationCleanupJob(deps)();

    expect(listArgs).toEqual([{ now: FIXED_NOW, limit: RESERVATION_BATCH }]);
  });

  it("releases the held unit and leaves the order pending_payment", async () => {
    /**
     * The load-bearing assertion of this file. A lapsed reservation is a stock problem, not
     * an order outcome: the customer may still pay. Ending the order here would cancel a
     * sale that is still live.
     */
    const order = makeOrder();
    const recorder = txRecorder({ orders: [order] });
    const { deps } = build([order], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.processed).toBe(1);
    expect(recorder.calls).toContain("releaseStock:pkg-small:1:v3");
    expect(recorder.calls.some((c) => c.startsWith("markExpired"))).toBe(false);
    expect(recorder.calls.some((c) => c.startsWith("markCancelled"))).toBe(false);
    expect(recorder.calls.some((c) => c.startsWith("markActivated"))).toBe(false);
    expect(recorder.audits).toEqual([
      {
        action: "order.reservation_released",
        targetId: order.id,
        metadata: { releasedUnits: 1, packageId: "pkg-small" },
      },
    ]);
  });

  it("re-reads the order under a row lock before touching stock", async () => {
    const order = makeOrder();
    const recorder = txRecorder({ orders: [order] });
    const { deps } = build([order], recorder);

    await reservationCleanupJob(deps)();

    expect(recorder.calls.indexOf(`lockById:${order.id}`)).toBeLessThan(
      recorder.calls.indexOf("lockStock:pkg-small"),
    );
  });

  it("skips the release when the order was activated between the read and the lock", async () => {
    /**
     * The reason the re-read exists. An activation that committed in between already turned
     * the hold into a real decrement; releasing now would decrement `reserved` for a unit
     * that is no longer reserved, driving the counter under its CHECK constraint and aborting
     * some later, unrelated transaction.
     */
    const listed = makeOrder();
    const committed = makeOrder({ status: "activated", activatedAt: FIXED_NOW, paidAt: FIXED_NOW });
    const recorder = txRecorder({ orders: [committed] });
    const { deps } = build([listed], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(recorder.calls.some((c) => c.startsWith("releaseStock"))).toBe(false);
  });

  it("skips the release when the order disappeared before the lock", async () => {
    const order = makeOrder();
    const recorder = txRecorder({ orders: [] });
    const { deps } = build([order], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.processed).toBe(0);
    expect(recorder.calls.some((c) => c.startsWith("releaseStock"))).toBe(false);
  });

  it("skips the release when the hold is already gone", async () => {
    const order = makeOrder({ stockReservationExpiresAt: null });
    const recorder = txRecorder({ orders: [order] });
    const { deps } = build([order], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.processed).toBe(0);
    expect(recorder.calls.some((c) => c.startsWith("lockStock"))).toBe(false);
  });

  it("skips a package that is not stock-managed", async () => {
    const order = makeOrder();
    const recorder = txRecorder({ orders: [order], stock: null });
    const { deps } = build([order], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(recorder.calls.some((c) => c.startsWith("releaseStock"))).toBe(false);
    expect(recorder.audits).toEqual([]);
  });

  it("treats a failed stock CAS as already released rather than an error", async () => {
    /**
     * Failed CAS under a lock means `reserved < units` — reconciliation or another replica
     * got there first. Throwing would only make the next pass retry the same no-op.
     */
    const order = makeOrder();
    const recorder = txRecorder({
      orders: [order],
      releaseOutcome: { ok: false, reason: "conflict" } as TxRecorder["releaseOutcome"],
    });
    const { deps, logger } = build([order], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(recorder.audits).toEqual([]);
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("counts a malformed row as failed and keeps processing the rest of the batch", async () => {
    const broken = makeOrder({
      id: "01HQORDER0000000000000002",
      packageSnapshot: null as never,
    });
    const good = makeOrder({ id: "01HQORDER0000000000000003" });
    const recorder = txRecorder({ orders: [good] });
    const { deps, logger } = build([broken, good], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
  });

  it("reports saturation when the batch came back full", async () => {
    const rows = Array.from({ length: RESERVATION_BATCH }, (_, index) =>
      makeOrder({ id: `01HQORDER${String(index).padStart(16, "0")}` }),
    );
    const recorder = txRecorder({ orders: rows });
    const { deps } = build(rows, recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.saturated).toBe(true);
    expect(result.processed).toBe(RESERVATION_BATCH);
  });

  it("does not report saturation on a partial batch", async () => {
    const order = makeOrder();
    const recorder = txRecorder({ orders: [order] });
    const { deps } = build([order], recorder);

    const result = await reservationCleanupJob(deps)();

    expect(result.saturated).toBe(false);
  });

  it("counts a release action for the metric that drives the reservations dashboard", async () => {
    const order = makeOrder();
    const recorder = txRecorder({ orders: [order] });
    const { deps } = build([order], recorder);
    const registry = deps.metrics;

    await reservationCleanupJob(deps)();

    const rendered = registry.render();
    expect(rendered).toContain("bosanda_worker_actions_total");
    expect(rendered).toContain("release_stale_reservation");
  });
});
