/**
 * Stale reservation cleanup (PLAN.md §11 "Expired/cancelled pending orders release the
 * reservation").
 *
 * WHY THIS EXISTS WHEN RECONCILIATION ALREADY RELEASES RESERVATIONS. The two jobs find
 * stale reservations by different paths and neither subsumes the other:
 *
 *  - `reconcile` scans `listReconcilable`, which requires `provider_transaction_id IS NOT
 *    NULL`. An order that reserved a unit and then failed before a checkout was created has
 *    no transaction id, so reconciliation will NEVER see it, and its unit would stay held
 *    forever.
 *  - This job scans `listStaleReservations`, which keys on
 *    `stock_reservation_expires_at <= now` with no transaction-id requirement, so it catches
 *    exactly that abandoned-before-checkout case.
 *
 * Running both means a unit is released whether the order got as far as a checkout or not.
 * The overlap is harmless: both paths go through the same guarded CAS, and a release that
 * already happened fails the `reserved >= units` guard and is logged as a no-op.
 *
 * THE ORDER STAYS PENDING. Releasing the hold is not cancelling the order — §11 separates
 * the reservation window from the payment window on purpose. A customer who pays after the
 * hold lapses is handled by activation, which re-checks stock at commit time; cancelling
 * here would reject a payment that is still legitimately in flight.
 */

import { releaseReservation, type OrderSnapshot } from "@bosanda/payments";
import { toOrderSnapshot } from "@bosanda/database";
import { ulid } from "@bosanda/shared";
import type { JobResult } from "../loop.js";
import type { WorkerDeps } from "../deps.js";

/** Batch cap, matching the repository default. */
export const RESERVATION_BATCH = 200;

export type ReservationDeps = Pick<
  WorkerDeps,
  "orders" | "clock" | "logger" | "metrics" | "transact"
>;

export function reservationCleanupJob(deps: ReservationDeps) {
  return async function runReservationCleanup(): Promise<JobResult> {
    const now = deps.clock.now();
    const rows = await deps.orders.listStaleReservations(now, RESERVATION_BATCH);
    if (rows.length === 0) return { processed: 0, failed: 0 };

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const snapshot = toOrderSnapshot(row);
        const release = releaseReservation(snapshot);

        /**
         * `releaseReservation` returning null means there is nothing held — the order type
         * does not consume stock, or the hold is already gone. Not an error, and not worth
         * a transaction.
         */
        if (release === null) continue;

        const applied = await releaseOne(deps, snapshot, release.units);
        if (applied) processed += 1;
      } catch (error) {
        failed += 1;
        deps.metrics.increment("bosanda_worker_items_failed_total", { job: "reservations" });
        deps.logger.error({ orderId: row.id, err: error }, "reservation release failed");
      }
    }

    return { processed, failed, saturated: rows.length >= RESERVATION_BATCH };
  };
}

/**
 * One release, in one transaction, re-checking state under a row lock.
 *
 * The re-read is not defensive padding. `listStaleReservations` uses `SKIP LOCKED` but its
 * rows were selected before this transaction opened, and in between an activation may have
 * COMMITTED the unit. Releasing then would decrement `reserved` for a unit that is no longer
 * reserved, pushing the counter toward its CHECK constraint and aborting some later,
 * unrelated transaction. Returns whether anything was actually released.
 */
async function releaseOne(
  deps: ReservationDeps,
  order: OrderSnapshot,
  units: number,
): Promise<boolean> {
  return await deps.transact(async (tx) => {
    const current = await tx.orders.lockById(order.orderId);
    if (current === null || current.status !== "pending_payment") {
      deps.logger.info({ orderId: order.orderId }, "order left pending before release; skipping");
      return false;
    }
    if (current.stockReservationExpiresAt === null) return false;

    const packageId = order.packageSnapshot.packageId;
    const stock = await tx.packages.lockStock(packageId);
    if (stock === null) {
      // Package is not stock-managed (§11 permits this); nothing to give back.
      return false;
    }

    const outcome = await tx.packages.releaseStock(
      packageId,
      units,
      stock.version,
      deps.clock.now(),
    );
    if (!outcome.ok) {
      /**
       * Failed CAS under a lock means `reserved < units`: already released, by the
       * reconciliation pass or another replica. Idempotent by design — log and accept rather
       * than throw, since throwing would only make the next pass retry the same no-op.
       */
      deps.logger.warn(
        { orderId: order.orderId, packageId, reason: outcome.reason },
        "stock release did not apply; treating as already released",
      );
      return false;
    }

    await tx.audit.append({
      id: ulid(),
      actorType: "system",
      actorId: null,
      action: "order.reservation_released",
      targetType: "order",
      targetId: order.orderId,
      metadata: { releasedUnits: units, packageId },
      createdAt: deps.clock.now(),
    });

    deps.metrics.increment("bosanda_worker_actions_total", { kind: "release_stale_reservation" });
    return true;
  });
}
