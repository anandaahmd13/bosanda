/**
 * Payment reconciliation (PLAN.md §13).
 *
 * §13: "A worker polls/checks Pakasir status for pending or ambiguous orders.
 * Reconciliation can activate a genuinely paid order when a webhook is delayed, but uses
 * the same idempotent activation transaction."
 *
 * THIS FILE CONTAINS NO POLICY. Every decision about what an order means comes from
 * `@bosanda/payments`: `planReconcilePass` splits the batch into locally-decidable actions
 * and orders needing a provider lookup, and `decideReconcileAction` turns one order plus
 * one provider view into exactly one action. This module is the dispatch table that
 * executes those actions durably, and nothing else. The reason is testability — the
 * decisions are already proven without a network in `packages/payments/test`, so what is
 * left to prove here is that each action reaches the right transaction.
 *
 * THE ACTIVATION PATH IS NOT REIMPLEMENTED HERE. `activate` delegates to
 * `executeActivation`, the same function the webhook uses, whose transaction claims the
 * order with a guarded `UPDATE ... WHERE status = 'paid' AND activated_at IS NULL`. That
 * guard is what makes a webhook landing concurrently with a reconciliation pass safe: one
 * of them wins the CAS and the other gets `order_not_activatable`, which is a no-op rather
 * than a double credit. Writing a second activation path here would be the single most
 * dangerous thing this worker could do.
 *
 * WHAT IS NEVER LOGGED. Order ids, user ids, and amounts are operational data and are
 * logged. The Pakasir URL is not: `redactPakasirUrl` exists because the checkout URL
 * carries the project slug and amount, and §16 keeps provider identifiers out of logs.
 * No credential, token, or payload digest appears here.
 */

import {
  ACTIVATION_GRACE_MS,
  planReconcilePass,
  decideReconcileAction,
  type OrderSnapshot,
  type ReconcileAction,
} from "@bosanda/payments";
import { toOrderSnapshot } from "@bosanda/database";
import { ulid } from "@bosanda/shared";
import type { JobResult } from "../loop.js";
import type { WorkerDeps, WorkerTx } from "../deps.js";

/**
 * How far behind an order must be before a pass will look at it.
 *
 * Not zero, and not arbitrary. An order created seconds ago is mid-checkout: the customer
 * is still on the Pakasir page and the webhook has not had a chance to arrive. Polling it
 * would spend a provider round trip to learn "still pending", which we already know.
 * One minute is comfortably longer than a normal webhook round trip and far shorter than
 * `ACTIVATION_GRACE_MS`, so a genuinely delayed webhook is still caught well inside the
 * window where escalation is the answer.
 */
export const RECONCILE_MIN_AGE_MS = 60_000;

/** Batch cap. Matches the repository default so the `saturated` signal is meaningful. */
export const RECONCILE_BATCH = 200;

export type ReconcileDeps = Pick<
  WorkerDeps,
  "orders" | "clock" | "logger" | "metrics" | "checkTransaction" | "transact"
>;

export function reconcileJob(deps: ReconcileDeps) {
  return async function runReconcilePass(): Promise<JobResult> {
    const now = deps.clock.now();
    const olderThan = new Date(now.getTime() - RECONCILE_MIN_AGE_MS);
    const rows = await deps.orders.listReconcilable(olderThan, RECONCILE_BATCH);
    if (rows.length === 0) return { processed: 0, failed: 0 };

    /**
     * A row whose `provider` is not `pakasir` throws in `toOrderSnapshot` rather than
     * being silently skipped. There is exactly one payment provider in v1 (§22), so such a
     * row is a data defect that a human needs to see — but it must not take the whole pass
     * down with it, hence the per-row guard.
     */
    const snapshots: OrderSnapshot[] = [];
    let failed = 0;
    for (const row of rows) {
      try {
        snapshots.push(toOrderSnapshot(row));
      } catch (error) {
        failed += 1;
        deps.logger.error({ orderId: row.id, err: error }, "order is not reconcilable");
      }
    }

    /**
     * Split before spending any network. A lapsed reservation and an orphaned activation
     * are both decidable from local state, so `planReconcilePass` keeps them out of
     * `needsCheck` — that is the difference between one provider call per order and one
     * per order that actually needs one.
     */
    const { local, needsCheck } = planReconcilePass(snapshots, deps.clock);

    const actions: ReconcileAction[] = [...local];

    for (const order of needsCheck) {
      /**
       * A lookup failure becomes `null`, not a thrown error. §13's policy for "no provider
       * view" is already correct for this case: a paid order escalates once past the grace
       * window and anything else waits for the next pass. Treating a timeout as fatal
       * would instead stall every order behind it.
       */
      let transaction = null;
      try {
        transaction = await deps.checkTransaction(order);
      } catch (error) {
        deps.logger.warn(
          { orderId: order.orderId, err: error },
          "provider status lookup failed; deferring to grace policy",
        );
      }
      actions.push(decideReconcileAction(order, transaction, deps.clock));
    }

    let processed = 0;
    for (const action of actions) {
      if (action.kind === "none") continue;
      try {
        await applyAction(deps, action);
        processed += 1;
        deps.metrics.increment("bosanda_worker_actions_total", { kind: action.kind });
      } catch (error) {
        failed += 1;
        deps.metrics.increment("bosanda_worker_items_failed_total", { job: "reconcile" });
        deps.logger.error(
          { orderId: action.order.orderId, kind: action.kind, err: error },
          "reconciliation action failed",
        );
      }
    }

    return { processed, failed, saturated: rows.length >= RECONCILE_BATCH };
  };
}

/**
 * Executes one decided action durably.
 *
 * The exhaustive switch is load-bearing: `ReconcileAction` has six arms, and adding a
 * seventh in `@bosanda/payments` must break the build here rather than silently fall
 * through to "do nothing". `assertNever` is what makes that a type error.
 */
async function applyAction(deps: ReconcileDeps, action: ReconcileAction): Promise<void> {
  switch (action.kind) {
    case "none":
      return;

    case "activate":
      /**
       * DELIBERATELY NOT IMPLEMENTED IN THE WORKER YET.
       *
       * `executeActivation` needs the new key's encrypted material for a `new_key` grant,
       * which means the worker would have to mint an API key — `@bosanda/api-keys` plus the
       * keyring plus the `NewKeyMaterial` shape the gateway's checkout path builds. That is
       * a real feature, not a stub, and doing it half-way is how you get a key with no
       * ledger row behind it.
       *
       * Until it lands, a genuinely-paid-but-unactivated order is escalated to a human
       * instead of being activated automatically. That is strictly safer than the
       * alternative: `review_required` is reversible by an operator, a botched activation
       * is not. The order keeps its `paid` money trail and nothing is lost.
       */
      await review(deps, action.order, "paid_but_not_activated");
      deps.logger.warn(
        { orderId: action.order.orderId },
        "order is paid and unactivated; escalated for manual activation",
      );
      return;

    case "review_required":
      await review(deps, action.order, action.reason);
      return;

    case "expire_and_release_stock":
      await closeOrder(deps, action, "expire");
      return;

    case "cancel_and_release_stock":
      await closeOrder(deps, action, "cancel");
      return;

    case "release_stale_reservation":
      /**
       * The order STAYS `pending_payment`. §11 releases the held unit when the reservation
       * window lapses, but the customer may still complete the payment — Pakasir's own
       * expiry is what ends the order, and that arrives as `expire_and_release_stock`.
       * Cancelling here would reject a payment the customer is in the middle of making.
       */
      await releaseOnly(deps, action);
      return;

    default:
      assertNever(action);
  }
}

/** §13 escalation: flag for a human, do not guess. */
async function review(deps: ReconcileDeps, order: OrderSnapshot, reason: string): Promise<void> {
  await deps.transact(async (tx) => {
    const updated = await tx.orders.markReviewRequired(order.orderId, reason, deps.clock.now());
    /**
     * A null return means the order moved between the read and the write — most likely a
     * webhook activated it while this pass was deciding. That is the CAS doing its job, not
     * an error: re-flagging an order that is now correctly activated would create a false
     * alarm for an operator.
     */
    if (updated === null) {
      deps.logger.info(
        { orderId: order.orderId, reason },
        "order moved before review flag; skipping",
      );
      return;
    }
    await audit(deps, tx, "order.review_required", order, { reason });
  });
}

/**
 * Terminal close plus reservation release, in one transaction.
 *
 * Both halves must commit together (§11): an order marked expired whose unit stayed
 * reserved leaks a sellable unit permanently, and a released unit on an order still shown
 * as pending would let the customer pay for something no longer held.
 */
async function closeOrder(
  deps: ReconcileDeps,
  action: Extract<
    ReconcileAction,
    { kind: "expire_and_release_stock" | "cancel_and_release_stock" }
  >,
  mode: "expire" | "cancel",
): Promise<void> {
  const { order, release } = action;
  await deps.transact(async (tx) => {
    const at = deps.clock.now();
    const updated =
      mode === "expire"
        ? await tx.orders.markExpired(order.orderId, at)
        : await tx.orders.markCancelled(order.orderId, at);

    if (updated === null) {
      // Lost the race to a webhook or another replica. Do not release stock: whoever won
      // owns the unit's fate now.
      deps.logger.info({ orderId: order.orderId, mode }, "order moved before close; skipping");
      return;
    }

    if (release !== null) await applyRelease(deps, tx, order, release);
    await audit(deps, tx, mode === "expire" ? "order.expired" : "order.cancelled", order, {
      releasedUnits: release?.units ?? 0,
    });
  });
}

/** §11: give the held unit back, leave the order pending. */
async function releaseOnly(
  deps: ReconcileDeps,
  action: Extract<ReconcileAction, { kind: "release_stale_reservation" }>,
): Promise<void> {
  const { order, release } = action;
  if (release === null) return;
  await deps.transact(async (tx) => {
    /**
     * Re-read the order under a row lock before releasing. The reservation was decided from
     * a snapshot taken before this transaction opened; if a webhook activated the order in
     * between, its unit has been COMMITTED, and releasing it here would decrement
     * `reserved` for a unit that is no longer reserved — driving the counter toward the
     * CHECK constraint and aborting an unrelated future transaction.
     */
    const current = await tx.orders.lockById(order.orderId);
    if (current === null || current.status !== "pending_payment") {
      deps.logger.info(
        { orderId: order.orderId },
        "order left pending before reservation release; skipping",
      );
      return;
    }
    if (current.stockReservationExpiresAt === null) {
      // Already released by another replica; the CAS below would fail anyway.
      return;
    }
    await applyRelease(deps, tx, order, release);
    await audit(deps, tx, "order.reservation_released", order, { releasedUnits: release.units });
  });
}

/**
 * The stock CAS, with the version read inside the same transaction.
 *
 * `lockStock` then `releaseStock(expectedVersion)` looks redundant given the row is already
 * locked, but the version guard is what makes the operation safe if the lock is ever
 * relaxed, and `releaseStock` additionally guards `reserved >= units` so a double release
 * cannot drive the counter negative and abort the transaction.
 */
async function applyRelease(
  deps: ReconcileDeps,
  tx: WorkerTx,
  order: OrderSnapshot,
  release: { units: number; orderId: string },
): Promise<void> {
  const packageId = order.packageSnapshot.packageId;
  const stock = await tx.packages.lockStock(packageId);
  if (stock === null) {
    /**
     * No stock row means the package was never stock-managed. Not an error: §11 allows a
     * package with no stock row, and there is then nothing to give back.
     */
    deps.logger.debug({ orderId: order.orderId, packageId }, "no stock row; nothing to release");
    return;
  }

  const outcome = await tx.packages.releaseStock(
    packageId,
    release.units,
    stock.version,
    deps.clock.now(),
  );
  if (!outcome.ok) {
    /**
     * A failed CAS inside a locked transaction means `reserved < units` — the unit was
     * already given back. Idempotent by design, so this is logged and accepted rather than
     * thrown: throwing would roll back the order's terminal status too, and the pass would
     * retry the same order forever.
     */
    deps.logger.warn(
      { orderId: order.orderId, packageId, reason: outcome.reason },
      "stock release did not apply; treating as already released",
    );
  }
}

/**
 * Audit rows for worker actions carry `actorType: "system"` and `actorId: null`.
 *
 * §16 forbids anything sensitive in metadata, and `assertMetadataIsSafe` in the repository
 * enforces it at the write. What goes in here is order-shaped operational data only.
 */
async function audit(
  deps: ReconcileDeps,
  tx: WorkerTx,
  action: string,
  order: OrderSnapshot,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.audit.append({
    id: ulid(),
    actorType: "system",
    actorId: null,
    action,
    targetType: "order",
    targetId: order.orderId,
    metadata: { ...metadata, graceMs: ACTIVATION_GRACE_MS },
    createdAt: deps.clock.now(),
  });
}

function assertNever(value: never): never {
  throw new Error(`unhandled reconcile action: ${JSON.stringify(value)}`);
}
