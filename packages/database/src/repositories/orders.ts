/**
 * `orders` + `payment_events` (PLAN.md §13 Pakasir flow).
 *
 * ── STATE TRANSITIONS ARE GUARDED IN SQL ───────────────────────────────────
 * §13's state machine is `draft → pending_payment → paid → activated`, with
 * `expired`, `cancelled`, and `review_required` as exits. Every transition helper
 * below carries its legal predecessors in the WHERE clause and returns `null` when
 * nothing matched.
 *
 * That null is the design, not an oversight. A webhook may be delivered twice, and
 * reconciliation may race a webhook for the same order (§13: "Accept duplicate and
 * out-of-order callbacks safely"). Guarding in the UPDATE makes the database the
 * arbiter — the loser of the race sees `null`, which means "already in that state
 * or past it", and acknowledges. Reading, deciding in TypeScript, then writing
 * would leave a window for both callers to believe they won.
 *
 * The decisions themselves are NOT here: `decideWebhookAction` and
 * `decideReconcileAction` in `@bosanda/payments` own them. This file executes.
 */

import { BosandaError } from "@bosanda/protocol";
import { type Executor, firstRow, requireRow } from "./executor.js";
import {
  type Order,
  type OrderRow,
  type OrderStatus,
  type OrderType,
  type PaymentEvent,
  type PaymentEventRow,
  type StoredPackageSnapshot,
  toOrder,
  toPaymentEvent,
} from "./rows.js";
import {
  type InsertOutcome,
  type NormalizedOrderFilter,
  type OrderFilter,
  type Pagination,
  decideInsertOutcome,
  normalizeOrderFilter,
  normalizePagination,
} from "./decisions.js";

/** Statuses the admin filter accepts. Anything else is dropped as noise. */
export const ORDER_STATUS_VALUES: readonly OrderStatus[] = [
  "draft",
  "pending_payment",
  "paid",
  "activated",
  "expired",
  "cancelled",
  "review_required",
];

export type CreateOrderInput = {
  id: string;
  userId: string;
  packageId: string;
  /** Frozen at checkout (§11). Never recomputed from webhook data (§13). */
  packageSnapshot: StoredPackageSnapshot;
  type: OrderType;
  /** Required for `top_up`, must be null for `new_key` (CHECK enforces it). */
  targetApiKeyId: string | null;
  amountIdr: number;
  status: Extract<OrderStatus, "draft" | "pending_payment">;
  stockReservationExpiresAt: Date | null;
  provider: string | null;
  providerTransactionId: string | null;
  createdAt: Date;
};

export type InsertPaymentEventInput = {
  id: string;
  provider: string;
  /** The provider's idempotency key. UNIQUE per provider (§13). */
  providerEventKey: string;
  payloadDigest: string;
  receivedAt: Date;
};

export type OrdersRepository = ReturnType<typeof ordersRepository>;

export function ordersRepository(sql: Executor) {
  return {
    /**
     * Create an order.
     *
     * `package_snapshot` is passed through `sql.json` so the driver sends it as
     * JSONB rather than a stringified TEXT that PostgreSQL would then have to cast.
     */
    async create(input: CreateOrderInput): Promise<Order> {
      const rows = await sql<OrderRow[]>`
        INSERT INTO orders (
          id, user_id, package_id, package_snapshot, type, target_api_key_id,
          amount_idr, status, stock_reservation_expires_at, provider,
          provider_transaction_id, paid_at, activated_at, created_at, updated_at
        ) VALUES (
          ${input.id}, ${input.userId}, ${input.packageId},
          ${sql.json(input.packageSnapshot)}, ${input.type}, ${input.targetApiKeyId},
          ${input.amountIdr}, ${input.status}, ${input.stockReservationExpiresAt},
          ${input.provider}, ${input.providerTransactionId}, NULL, NULL,
          ${input.createdAt}, ${input.createdAt}
        )
        RETURNING *
      `;
      return toOrder(requireRow(rows, "orders insert"));
    },

    async findById(id: string): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`SELECT * FROM orders WHERE id = ${id}`;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /**
     * Read an order FOR UPDATE.
     *
     * The activation transaction must lock the order before deciding, so a
     * concurrent webhook and reconciliation pass cannot both activate it (§13,
     * §16 invariant 5). Only meaningful inside a transaction.
     */
    async lockById(id: string): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`
        SELECT * FROM orders WHERE id = ${id} FOR UPDATE
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /**
     * Match a provider transaction to the server-created order (§13: "Match the
     * provider transaction to the server-created order").
     *
     * Hits `orders_provider_transaction_key (provider, provider_transaction_id)
     * WHERE provider_transaction_id IS NOT NULL`. Both columns are required because
     * the index is composite: a transaction id is only unique within its provider.
     */
    async findByProviderTransactionId(
      provider: string,
      providerTransactionId: string,
    ): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`
        SELECT * FROM orders
        WHERE provider = ${provider} AND provider_transaction_id = ${providerTransactionId}
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /** A user's order history, newest first. Matches `orders_user_id_created_at_idx`. */
    async listForUser(userId: string, paging: Pagination = {}): Promise<Order[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<OrderRow[]>`
        SELECT * FROM orders
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toOrder);
    },

    /**
     * The admin order list (§15 "View and reconcile Pakasir orders").
     *
     * WHY THE FILTER IS BUILT THIS WAY. Each optional predicate is expressed as
     * `(${value} IS NULL OR column = ${value})`, so the statement is ONE static
     * template with a fixed parameter list. No fragment concatenation, no dynamic
     * SQL, and therefore no path by which a filter value could become SQL — which
     * is the boundary client.ts documents.
     *
     * The cost is that PostgreSQL plans a query containing every branch. For an
     * admin listing over an order table this is immaterial, and it buys a
     * construction that is safe by inspection rather than by careful review.
     *
     * `statuses` uses `= ANY(...)` with an empty-array escape, since `IN ()` is not
     * valid SQL.
     */
    async list(
      filter: OrderFilter = {},
      paging: Pagination = {},
    ): Promise<{ orders: Order[]; filter: NormalizedOrderFilter }> {
      const normalized = normalizeOrderFilter(filter, ORDER_STATUS_VALUES);
      const { limit, offset } = normalizePagination(paging);
      const statuses = normalized.statuses;
      const hasStatuses = statuses.length > 0;

      const rows = await sql<OrderRow[]>`
        SELECT * FROM orders
        WHERE (${normalized.userId}::TEXT IS NULL OR user_id = ${normalized.userId})
          AND (${!hasStatuses} OR status = ANY(${sql.array(statuses)}::TEXT[]))
          AND (${normalized.type}::TEXT IS NULL OR type = ${normalized.type})
          AND (${normalized.provider}::TEXT IS NULL OR provider = ${normalized.provider})
          AND (
            ${normalized.providerTransactionId}::TEXT IS NULL
            OR provider_transaction_id = ${normalized.providerTransactionId}
          )
          AND (${normalized.createdAfter}::TIMESTAMPTZ IS NULL OR created_at >= ${normalized.createdAfter})
          AND (${normalized.createdBefore}::TIMESTAMPTZ IS NULL OR created_at < ${normalized.createdBefore})
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      // The normalized filter is returned so the caller can echo back what was
      // actually applied — a dropped status should be visible in the UI, not silent.
      return { orders: rows.map(toOrder), filter: normalized };
    },

    /** Count matching the same filter, for pagination controls. */
    async count(filter: OrderFilter = {}): Promise<number> {
      const normalized = normalizeOrderFilter(filter, ORDER_STATUS_VALUES);
      const statuses = normalized.statuses;
      const hasStatuses = statuses.length > 0;

      const rows = await sql<{ total: string }[]>`
        SELECT COUNT(*)::TEXT AS total FROM orders
        WHERE (${normalized.userId}::TEXT IS NULL OR user_id = ${normalized.userId})
          AND (${!hasStatuses} OR status = ANY(${sql.array(statuses)}::TEXT[]))
          AND (${normalized.type}::TEXT IS NULL OR type = ${normalized.type})
          AND (${normalized.provider}::TEXT IS NULL OR provider = ${normalized.provider})
          AND (
            ${normalized.providerTransactionId}::TEXT IS NULL
            OR provider_transaction_id = ${normalized.providerTransactionId}
          )
          AND (${normalized.createdAfter}::TIMESTAMPTZ IS NULL OR created_at >= ${normalized.createdAfter})
          AND (${normalized.createdBefore}::TIMESTAMPTZ IS NULL OR created_at < ${normalized.createdBefore})
      `;
      const row = firstRow(rows);
      return row === null ? 0 : Number(row.total);
    },

    /**
     * Record the provider transaction id once checkout has been created.
     *
     * Separate from `create` because §13 creates the order and reserves stock
     * (step 3) BEFORE creating the Pakasir transaction (step 4) — the id does not
     * exist yet at insert time.
     */
    async attachProviderTransaction(
      id: string,
      provider: string,
      providerTransactionId: string,
      at: Date,
    ): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`
        UPDATE orders
        SET provider = ${provider},
            provider_transaction_id = ${providerTransactionId},
            status = 'pending_payment',
            updated_at = ${at}
        WHERE id = ${id} AND status IN ('draft', 'pending_payment')
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /**
     * `pending_payment → paid`.
     *
     * Guarded so a duplicate webhook cannot rewrite `paid_at` to a later instant —
     * §11 measures the 24h validity window from confirmed payment, so moving that
     * timestamp would silently extend or shorten what the customer bought.
     *
     * Returns null when the order was already paid or beyond. The caller treats
     * that as success and proceeds to activation, which is itself idempotent.
     */
    async markPaid(id: string, paidAt: Date, at: Date): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`
        UPDATE orders
        SET status = 'paid', paid_at = ${paidAt}, updated_at = ${at}
        WHERE id = ${id} AND status IN ('draft', 'pending_payment')
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /**
     * `paid → activated`.
     *
     * Guarded on `status = 'paid' AND activated_at IS NULL`, which is what makes
     * double activation impossible: the second caller matches no row. Three CHECK
     * constraints also police this write —
     * `orders_paid_before_activated` (activated_at >= paid_at),
     * `orders_activated_implies_status`, and the NOT NULL on paid_at implied by the
     * first — so an out-of-order timestamp aborts rather than persists.
     *
     * Called inside the activation transaction alongside the key write, the ledger
     * row, and the stock commit (§13 step 8).
     */
    async markActivated(id: string, activatedAt: Date): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`
        UPDATE orders
        SET status = 'activated', activated_at = ${activatedAt}, updated_at = ${activatedAt}
        WHERE id = ${id} AND status = 'paid' AND activated_at IS NULL
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /**
     * Route to `review_required` (§13: money-versus-state disagreements go to a
     * human, never to a silent fix).
     *
     * Reachable from any non-terminal status, including `paid` — an amount mismatch
     * on a paid order is exactly what this state is for. `activated` is excluded:
     * once a key is handed over, unwinding is a refund decision recorded as a
     * compensating ledger entry (§13), not a status rewrite.
     *
     * The reason is NOT stored on the order — there is no column for it. The caller
     * must write an `audit_events` row; `auditRepository` exists for that, and
     * `reason` is accepted here only to force the call site to have one.
     */
    async markReviewRequired(id: string, reason: string, at: Date): Promise<Order | null> {
      if (reason.trim().length === 0) {
        throw new BosandaError("internal_error", {
          internalDetail: `order ${id} routed to review with no reason`,
        });
      }
      const rows = await sql<OrderRow[]>`
        UPDATE orders
        SET status = 'review_required', updated_at = ${at}
        WHERE id = ${id}
          AND status IN ('draft', 'pending_payment', 'paid', 'review_required')
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /**
     * `pending_payment → expired`, releasing the reservation marker.
     *
     * `stock_reservation_expires_at` is cleared so the order stops appearing in the
     * `orders_pending_reservation_idx` sweep. The actual stock release is a separate
     * CAS on `package_stock` — call `packagesRepository.releaseStock` in the same
     * transaction.
     */
    async markExpired(id: string, at: Date): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`
        UPDATE orders
        SET status = 'expired', stock_reservation_expires_at = NULL, updated_at = ${at}
        WHERE id = ${id} AND status IN ('draft', 'pending_payment')
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /** `pending_payment → cancelled`. Same reservation handling as `markExpired`. */
    async markCancelled(id: string, at: Date): Promise<Order | null> {
      const rows = await sql<OrderRow[]>`
        UPDATE orders
        SET status = 'cancelled', stock_reservation_expires_at = NULL, updated_at = ${at}
        WHERE id = ${id} AND status IN ('draft', 'pending_payment')
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toOrder(row);
    },

    /**
     * Pending orders whose reservation has lapsed (§11: "Expired/cancelled pending
     * orders release the reservation"; §13 reconciliation).
     *
     * Uses `orders_pending_reservation_idx (stock_reservation_expires_at) WHERE
     * status = 'pending_payment'` — the partial index exists for this scan.
     *
     * `FOR UPDATE SKIP LOCKED` so two worker instances split the batch instead of
     * blocking on each other.
     */
    async listStaleReservations(now: Date, limit = 200): Promise<Order[]> {
      const rows = await sql<OrderRow[]>`
        SELECT * FROM orders
        WHERE status = 'pending_payment'
          AND stock_reservation_expires_at IS NOT NULL
          AND stock_reservation_expires_at <= ${now}
        ORDER BY stock_reservation_expires_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
      return rows.map(toOrder);
    },

    /**
     * Orders the reconciliation worker should re-check against the provider (§13
     * "A worker polls/checks Pakasir status for pending or ambiguous orders").
     *
     * `paid` is included deliberately: a paid-but-not-activated order is the
     * delayed-webhook case reconciliation exists to finish.
     */
    async listReconcilable(olderThan: Date, limit = 200): Promise<Order[]> {
      const rows = await sql<OrderRow[]>`
        SELECT * FROM orders
        WHERE status IN ('pending_payment', 'paid')
          AND provider_transaction_id IS NOT NULL
          AND updated_at <= ${olderThan}
        ORDER BY updated_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
      return rows.map(toOrder);
    },

    // ─────────────────── payment_events (webhook idempotency) ───────────────────

    /**
     * Claim a webhook delivery. THE IDEMPOTENCY GATE for §13.
     *
     * `payment_events_provider_event_key UNIQUE (provider, provider_event_key)` is
     * what makes replay safe: `ON CONFLICT DO NOTHING` means the first delivery
     * gets `inserted` and every redelivery gets `duplicate`, so a duplicate can
     * never credit quota twice.
     *
     * This satisfies the `PaymentEventStore` contract in `@bosanda/payments`,
     * whose `claim` returns `"claimed" | "duplicate"`; `claimForStore` below adapts
     * the shape exactly.
     *
     * Call this FIRST, before doing any work, and pass the same `tx` used for
     * activation. If the claim and the activation were in different transactions, a
     * crash between them would leave the event claimed and the order unprocessed —
     * and the redelivery would then be rejected as a duplicate, losing the payment.
     */
    async insertPaymentEvent(input: InsertPaymentEventInput): Promise<InsertOutcome<PaymentEvent>> {
      const inserted = await sql<PaymentEventRow[]>`
        INSERT INTO payment_events (
          id, provider, provider_event_key, payload_digest, status,
          received_at, processed_at, error_code
        ) VALUES (
          ${input.id}, ${input.provider}, ${input.providerEventKey},
          ${input.payloadDigest}, 'received', ${input.receivedAt}, NULL, NULL
        )
        ON CONFLICT (provider, provider_event_key) DO NOTHING
        RETURNING *
      `;

      const insertedRow = firstRow(inserted);
      if (insertedRow !== null) {
        return decideInsertOutcome(toPaymentEvent(insertedRow), null, "payment_events insert");
      }

      const existing = await sql<PaymentEventRow[]>`
        SELECT * FROM payment_events
        WHERE provider = ${input.provider} AND provider_event_key = ${input.providerEventKey}
      `;
      const existingRow = firstRow(existing);
      return decideInsertOutcome(
        null,
        existingRow === null ? null : toPaymentEvent(existingRow),
        `payment_events insert for ${input.provider}`,
      );
    },

    /**
     * The `PaymentEventStore.claim` adapter for `handlePakasirWebhook`.
     *
     * Narrowed to `"pakasir"` on input because that is what the contract in
     * `@bosanda/payments` declares; v1 has one provider.
     */
    async claimForStore(input: {
      provider: "pakasir";
      eventKey: string;
      payloadDigest: string;
      receivedAt: Date;
      id: string;
    }): Promise<"claimed" | "duplicate"> {
      const outcome = await this.insertPaymentEvent({
        id: input.id,
        provider: input.provider,
        providerEventKey: input.eventKey,
        payloadDigest: input.payloadDigest,
        receivedAt: input.receivedAt,
      });
      return outcome.status === "inserted" ? "claimed" : "duplicate";
    },

    async findPaymentEventByKey(
      provider: string,
      providerEventKey: string,
    ): Promise<PaymentEvent | null> {
      const rows = await sql<PaymentEventRow[]>`
        SELECT * FROM payment_events
        WHERE provider = ${provider} AND provider_event_key = ${providerEventKey}
      `;
      const row = firstRow(rows);
      return row === null ? null : toPaymentEvent(row);
    },

    /**
     * Close out a claimed event.
     *
     * §13 requires returning success "only after durable processing", so the
     * handler marks `processed` in the same transaction as the activation. A
     * `failed` event keeps its `error_code` for the operator; the code is a
     * classified string, never a provider payload (§16).
     */
    async finishPaymentEvent(
      provider: string,
      providerEventKey: string,
      status: "processed" | "ignored" | "failed",
      at: Date,
      errorCode: string | null = null,
    ): Promise<PaymentEvent | null> {
      const rows = await sql<PaymentEventRow[]>`
        UPDATE payment_events
        SET status = ${status}, processed_at = ${at}, error_code = ${errorCode}
        WHERE provider = ${provider}
          AND provider_event_key = ${providerEventKey}
          AND status = 'received'
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toPaymentEvent(row);
    },

    /**
     * Events stuck in `received` — claimed but never finished, i.e. a crash
     * mid-processing. Uses `payment_events_status_idx (status, received_at)`.
     */
    async listUnprocessedEvents(olderThan: Date, limit = 200): Promise<PaymentEvent[]> {
      const rows = await sql<PaymentEventRow[]>`
        SELECT * FROM payment_events
        WHERE status = 'received' AND received_at <= ${olderThan}
        ORDER BY received_at
        LIMIT ${limit}
      `;
      return rows.map(toPaymentEvent);
    },
  };
}
