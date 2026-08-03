/**
 * Orders: the list, the detail view, and the two money-moving mutations (PLAN.md §11, §13, §16).
 *
 * ── ACTIVATION GOES THROUGH `executeActivation`, NOT THROUGH A BALANCE WRITE ─
 * `POST /orders/:orderId/activate` is the operator's manual version of what the payment
 * webhook does automatically, and it uses the identical path: `decideActivation` to decide,
 * `executeActivation` to perform. That is not code reuse for its own sake. That function
 * owns four things this handler must not reimplement:
 *
 *   * the IDEMPOTENCY BARRIER — step 1 is `markActivated`, guarded on
 *     `status='paid' AND activated_at IS NULL`, so a double-click activates once and the
 *     second attempt reports `order_not_activatable` instead of granting a second key;
 *   * the ledger row and the balance in ONE statement (§16 invariant 4);
 *   * the stock CAS, so a manual activation cannot oversell a package;
 *   * its own audit row.
 *
 * A hand-rolled `recordTopUp` here would drift from the webhook path the first time either
 * changed, and the failure mode is a customer with quota that no ledger row explains.
 *
 * ── REFUND IS A COMPENSATING ENTRY, NOT A STATUS REWRITE ──────────────────
 * §13 says so, and `markReviewRequired` documents the reason: "once a key is handed over,
 * unwinding is a refund decision recorded as a compensating ledger entry, not a status
 * rewrite". So a refund debits the granted quota back off the key with
 * `recordAdjustment` — one append-only ledger row plus the balance, together — and moves
 * the order to `review_required` so a human closes the loop with the payment provider.
 * The gateway does not call Pakasir: money leaving the account is not an action a
 * dashboard button should take unattended, and §13 puts the provider-side refund in the
 * operator's hands.
 *
 * ── WHY REFUND IS IDEMPOTENT VIA THE ORDER STATUS ─────────────────────────
 * `quota_ledger` has no unique key that would stop a second identical adjustment (its
 * idempotency guard is `(api_key_id, request_id)`, and `recordAdjustment` takes no request
 * id). The barrier is therefore the ORDER: the row is locked FOR UPDATE, and an order
 * already in `review_required` is reported as refunded rather than debited again. That
 * makes the transaction the serialization point, which is the same discipline
 * `executeActivation` uses.
 */

import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import { ulid } from "@bosanda/shared";
import { METER_VERSION } from "@bosanda/metering";
import { decideActivation } from "@bosanda/payments";
import type { Order } from "@bosanda/database";
import { generateApiKey, lookupDigest, prefixOf, seal } from "@bosanda/api-keys";
import type { AdminDeps } from "./deps.js";
import { ADMIN_ACTIONS, auditActor, writeAudit } from "./audit.js";
import {
  iso,
  isoOrNull,
  ok,
  readBody,
  readOrderStatus,
  readPaging,
  readParam,
  readQuery,
  readReason,
  readSearch,
  toAdminLedgerKind,
} from "./contract.js";
import { requireAdmin } from "./session.js";

/**
 * `lockKeyForUpdate` returns `status: string`; `KeyQuotaState` wants the three-value union.
 *
 * Narrowed with a check rather than cast: an unrecognized status means the column holds
 * something no code in this repository writes, and letting that reach `decideActivation` as
 * an unknown state would produce a quota decision from a value nobody validated. Failing
 * with `internal_error` matches how `narrow()` in `rows.ts` treats the same situation.
 */
function narrowKeyStatus(status: string): "active" | "revoked" | "expired" {
  if (status === "active" || status === "revoked" || status === "expired") return status;
  throw new BosandaError("internal_error", {
    internalDetail: `api_keys.status holds an unrecognized value: ${status}`,
  });
}

/**
 * The one place an `Order` becomes an `orderSummary`.
 *
 * `provider` is `z.string().min(1)` and NON-nullable in the contract while
 * `orders.provider` is nullable — a draft order created before checkout has no provider
 * yet. `"none"` is rendered rather than the row being hidden, because an order stuck
 * without a provider is precisely the kind of thing an operator opens this page to find.
 */
function toSummary(
  order: Order,
  labels: { username: string; packageName: string | null },
): Record<string, unknown> {
  return {
    id: order.id,
    userId: order.userId,
    username: labels.username,
    // No `packageId`: `orderSummary` is `.strict()` and does not carry one, so including it
    // fails the client's parse outright rather than being ignored. `packageName` is the
    // package identity the summary exposes.
    packageName: labels.packageName ?? order.packageId,
    type: order.type,
    status: order.status,
    amountIdr: order.amountIdr,
    provider: order.provider ?? "none",
    providerTransactionId: order.providerTransactionId,
    createdAt: iso(order.createdAt),
    paidAt: isoOrNull(order.paidAt),
    activatedAt: isoOrNull(order.activatedAt),
  };
}

export function registerOrderRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /**
   * The order list.
   *
   * `q` is resolved to ids BEFORE the filter runs. Filtering the returned page in this
   * handler would be simpler and wrong: `total` would count unfiltered rows, so the
   * dashboard's pagination would offer pages that render empty, and an operator searching
   * for a transaction id would conclude the order does not exist because it sat on page 3
   * of the unfiltered set.
   *
   * `OrderFilter` has no id-set field either, so a resolved search is applied by fetching
   * the matched orders directly. The two paths (filtered list vs id lookup) are therefore
   * genuinely different queries rather than one query with an extra predicate — which is
   * what the frozen repository allows.
   */
  app.get("/admin/v1/orders", async (request, reply) => {
    await requireAdmin(request, deps);

    const query = readQuery(request.query, ["limit", "offset", "status", "q"]);
    const paging = readPaging(query);
    const status = readOrderStatus(query);
    const search = readSearch(query);

    let orders: Order[];
    let total: number;

    if (search !== undefined) {
      // Bounded by the same ceiling a page uses, so one search cannot pull the table.
      const ids = await deps.orderQuery.searchIds(search, paging.limit + paging.offset);
      const matched = await Promise.all(ids.map((id) => deps.orders.findById(id)));
      const present = matched.filter((order): order is Order => order !== null);
      const filtered =
        status === undefined ? present : present.filter((order) => order.status === status);
      total = filtered.length;
      orders = filtered.slice(paging.offset, paging.offset + paging.limit);
    } else {
      const filter = status === undefined ? {} : { status: [status] };
      const [listed, counted] = await Promise.all([
        deps.orders.list(filter, paging),
        deps.orders.count(filter),
      ]);
      orders = listed.orders;
      total = counted;
    }

    const labels = await deps.orderQuery.labelsFor(orders.map((order) => order.id));
    const byOrder = new Map(labels.map((row) => [row.orderId, row]));

    return reply.status(200).send({
      orders: orders.map((order) =>
        toSummary(order, {
          // A missing label row means the join found no user, which the foreign key makes
          // impossible — but the type is nullable and inventing a name would be worse.
          username: byOrder.get(order.id)?.username ?? "unknown",
          packageName: byOrder.get(order.id)?.packageName ?? null,
        }),
      ),
      total,
    });
  });

  /**
   * One order, with its ledger and payment events.
   *
   * `packageSnapshot.name` comes from the CURRENT package row, because
   * `StoredPackageSnapshot` carries no name — it stores the numbers that must not change
   * (`weightedTokenQuota`, `priceIdr`, `maxKeyQuota`, `durationSeconds`) and nothing
   * cosmetic. So a renamed package shows its new name against an old order, while every
   * figure stays as sold. That is the right trade: the numbers are what a dispute turns on.
   *
   * The ledger is read for the TARGET key. A `new_key` order has no target until it
   * activates, so an unactivated order shows an empty ledger — accurate, since no quota
   * has moved.
   */
  app.get<{ Params: { orderId: string } }>("/admin/v1/orders/:orderId", async (request, reply) => {
    await requireAdmin(request, deps);
    const orderId = readParam(request.params, "orderId");

    const order = await deps.orders.findById(orderId);
    if (order === null) {
      throw new BosandaError("not_found", { internalDetail: `order ${orderId} not found` });
    }

    const [labels, paymentEvents, packageRecord] = await Promise.all([
      deps.orderQuery.labelsFor([order.id]),
      deps.orderQuery.paymentEventsFor(order.id),
      deps.packages.findById(order.packageId),
    ]);

    const targetKeyId = order.targetApiKeyId;
    const [key, ledger] = await Promise.all([
      targetKeyId === null ? Promise.resolve(null) : deps.apiKeys.findById(targetKeyId),
      targetKeyId === null
        ? Promise.resolve([])
        : deps.quota.ledgerForKey(targetKeyId, { limit: 100 }),
    ]);

    const label = labels[0];

    return reply.status(200).send({
      order: toSummary(order, {
        username: label?.username ?? "unknown",
        packageName: label?.packageName ?? null,
      }),
      packageSnapshot: {
        name: packageRecord?.name ?? order.packageId,
        weightedTokenQuota: order.packageSnapshot.weightedTokenQuota,
        priceIdr: order.packageSnapshot.priceIdr,
        durationSeconds: order.packageSnapshot.durationSeconds,
      },
      // The display prefix only. Never the key, its ciphertext, or its lookup digest.
      targetApiKeyPrefix: key?.prefix ?? null,
      stockReservationExpiresAt: isoOrNull(order.stockReservationExpiresAt),
      ledger: ledger.map((entry) => ({
        id: entry.id,
        apiKeyId: entry.apiKeyId,
        orderId: entry.orderId,
        kind: toAdminLedgerKind(entry.kind),
        weightedTokensDelta: entry.weightedTokensDelta,
        balanceAfter: entry.balanceAfter,
        estimated: entry.estimated,
        createdAt: iso(entry.createdAt),
      })),
      paymentEvents: paymentEvents.map((event) => ({
        id: event.id,
        status: event.status,
        receivedAt: iso(event.receivedAt),
        processedAt: isoOrNull(event.processedAt),
        errorCode: event.errorCode,
      })),
    });
  });

  /**
   * Manual activation.
   *
   * The operator case this exists for: payment confirmed out of band (a webhook lost, a
   * provider outage reconciled by hand) and the customer is waiting for their key. §13
   * calls for exactly this override, and routing it through the same decision + execution
   * pair as the webhook is what keeps the two from diverging.
   *
   * Key material is generated here for a `new_key` order. The plaintext exists only inside
   * this handler and is NOT returned: §12 gives the customer a one-time reveal on their own
   * key, and the admin schema has no field for it (`.strict()` would reject one). The
   * operator's job is to make the key exist; the customer collects it from their dashboard.
   */
  app.post<{ Params: { orderId: string } }>(
    "/admin/v1/orders/:orderId/activate",
    async (request, reply) => {
      const actor = await requireAdmin(request, deps);
      const orderId = readParam(request.params, "orderId");
      const body = readBody(request.body, ["reason"]);
      const reason = readReason(body);
      const at = deps.clock.now();

      const outcome = await deps.transact(async (tx) => {
        // FOR UPDATE: the row is the serialization point against a webhook arriving for
        // the same order at the same moment.
        const order = await tx.orders.lockById(orderId);
        if (order === null) return { kind: "missing" as const };

        /**
         * The already-activated case is answered HERE, not by `decideActivation`.
         *
         * That function classifies an activated order as `invalid_request` — correct for the
         * webhook path it was written for, where a replayed event really is a malformed
         * request. For an operator pressing "activate" on an order a webhook already settled,
         * a 400 would read as "your request was wrong" when the truth is "someone else got
         * there first, and the customer has their key". `classify(409)` gives the console a
         * conflict to surface. The state check is the same one `markActivated` enforces in
         * SQL, so this cannot report a conflict the barrier would have allowed.
         */
        if (order.activatedAt !== null || order.status === "activated") {
          return {
            kind: "failed" as const,
            reason: "order_not_activatable" as const,
            detail: `order ${order.id} was already activated`,
          };
        }

        const targetKey =
          order.targetApiKeyId === null
            ? null
            : await tx.quota.lockKeyForUpdate(order.targetApiKeyId);

        const decision = decideActivation(
          {
            orderId: order.id,
            userId: order.userId,
            type: order.type,
            targetApiKeyId: order.targetApiKeyId,
            packageSnapshot: order.packageSnapshot,
            amountIdr: order.amountIdr,
            currency: "IDR",
            status: order.status,
            stockReservationExpiresAt: order.stockReservationExpiresAt,
            // `PaymentProvider` in the frozen types; a null provider on a paid order is a
            // data defect `decideActivation` does not inspect, so the cast is confined here.
            provider: (order.provider ?? "pakasir") as "pakasir",
            providerTransactionId: order.providerTransactionId,
            paidAt: order.paidAt,
            activatedAt: order.activatedAt,
            createdAt: order.createdAt,
          },
          targetKey === null
            ? null
            : {
                keyId: targetKey.keyId,
                // `lockKeyForUpdate` returns `status: string`; `KeyQuotaState` wants the
                // union. Narrowed rather than cast so an unrecognized value fails loudly
                // here instead of flowing into a quota decision as an unknown state.
                status: narrowKeyStatus(targetKey.status),
                remaining: targetKey.remaining,
                quotaLimit: targetKey.quotaLimit,
                expiresAt: targetKey.expiresAt,
              },
          deps.clock,
        );

        if (!decision.activate) {
          return { kind: "refused" as const, review: decision.review, error: decision.error };
        }

        const grant = decision.grant;

        /**
         * Stock is committed only for a new key (§11), and only when a stock row exists.
         * `executeActivation` defaults to REQUIRING stock for a new-key grant, so the
         * version must be read in this transaction to be a valid CAS operand.
         */
        const stock =
          grant.kind === "new_key" ? await tx.packages.lockStock(order.packageId) : null;

        /**
         * Generated inside the transaction so nothing is created if the activation is
         * refused. `generated.plaintext` is read three times here — prefix, digest, seal —
         * and never logged, audited, or returned. `seal` returns the envelope string; the
         * version it used is `keyring.currentVersion`, which is what the row records so a
         * future keyring rotation can still open it.
         */
        const generated = grant.kind === "new_key" ? generateApiKey() : null;

        const result = await tx.activate({
          grant,
          ledgerEntryId: ulid(),
          auditEventId: ulid(),
          meterVersion: METER_VERSION,
          ...(generated === null
            ? {}
            : {
                keyMaterial: {
                  id: ulid(),
                  label: null,
                  prefix: prefixOf(generated.plaintext),
                  lookupDigest: lookupDigest(generated.plaintext, deps.keyring),
                  encryptedKey: seal(generated.plaintext, deps.keyring),
                  encryptionKeyVersion: deps.keyring.currentVersion,
                },
              }),
          ...(stock === null
            ? {}
            : { stock: { packageId: order.packageId, units: 1, expectedVersion: stock.version } }),
          at,
        });

        if (!result.ok) {
          return { kind: "failed" as const, reason: result.reason, detail: result.detail };
        }

        // `executeActivation` writes its own `order.activated_*` row with actorType
        // `system`. This second row records that an OPERATOR forced it and why — §15 needs
        // the human decision on the record, and the system row cannot carry it.
        await writeAudit(
          tx,
          auditActor(actor),
          {
            action: ADMIN_ACTIONS.orderActivated,
            targetType: "order",
            targetId: order.id,
            reason,
            details: {
              grantKind: grant.kind,
              apiKeyId: result.apiKey.id,
              weightedTokensGranted: result.ledgerEntry.weightedTokensDelta,
              stockCommitted: stock !== null,
            },
          },
          at,
        );

        return { kind: "ok" as const, grantKind: grant.kind };
      });

      if (outcome.kind === "missing") {
        throw new BosandaError("not_found", { internalDetail: `order ${orderId} not found` });
      }
      if (outcome.kind === "refused") {
        // `decision.error` already carries a classified code and a safe public message; its
        // `internalDetail` names the order and stays inside the process.
        throw outcome.error;
      }
      if (outcome.kind === "failed") {
        // Every branch is a 409 with the taxonomy's conflict text — `BosandaError` derives
        // the public message from the code and takes no override. The distinguishing
        // information (which barrier fired, and the detail) goes to the log.
        throw new BosandaError("conflict", {
          internalDetail:
            outcome.reason === "order_not_activatable"
              ? // The idempotency barrier fired. Most likely a webhook won the race, which
                // is a success for the customer, so this is a conflict and not an error.
                `manual activation refused: ${outcome.detail}`
              : `manual activation failed (${outcome.reason}): ${outcome.detail}`,
        });
      }

      request.bosandaLog.warn({ orderId }, "order activated manually by an admin");

      return reply
        .status(200)
        .send(
          ok(
            outcome.grantKind === "new_key"
              ? "Order activated. The customer can collect the new key from their dashboard."
              : "Order activated. Quota was added to the existing key.",
          ),
        );
    },
  );

  /**
   * Refund.
   *
   * Two effects, one transaction: the granted quota is debited back off the key, and the
   * order moves to `review_required` so the operator's provider-side refund is tracked
   * rather than forgotten. The response says the provider was not called, because an
   * operator who believed the money had moved would not go and move it.
   *
   * The debit is `recordAdjustment` — the only method that writes a ledger row and the
   * balance together, which is what §16 invariant 5 requires of any balance change. The
   * amount is what the ORDER granted, read from the snapshot, not the key's current
   * balance: refunding a key that has already spent some quota should reverse the purchase,
   * and `clampBalance` (enforced by the column's CHECK inside `recordAdjustment`) keeps the
   * persisted balance at zero while the full negative delta stays on the ledger row.
   */
  app.post<{ Params: { orderId: string } }>(
    "/admin/v1/orders/:orderId/refund",
    async (request, reply) => {
      const actor = await requireAdmin(request, deps);
      const orderId = readParam(request.params, "orderId");
      const body = readBody(request.body, ["reason"]);
      const reason = readReason(body);
      const at = deps.clock.now();

      const outcome = await deps.transact(async (tx) => {
        const order = await tx.orders.lockById(orderId);
        if (order === null) return { kind: "missing" as const };

        // The idempotency barrier. A second refund on an order already routed to review
        // reports success without writing a second compensating entry.
        if (order.status === "review_required") return { kind: "already" as const };
        if (order.status !== "activated" && order.status !== "paid") {
          return { kind: "not_refundable" as const, status: order.status };
        }

        const keyId = order.targetApiKeyId;
        let reversed = 0;

        if (order.status === "activated" && keyId !== null) {
          const locked = await tx.quota.lockKeyForUpdate(keyId);
          if (locked === null) return { kind: "key_missing" as const };

          const granted = order.packageSnapshot.weightedTokenQuota;
          reversed = granted;

          await tx.quota.recordAdjustment({
            id: ulid(),
            apiKeyId: keyId,
            orderId: order.id,
            // Signed negative: this reverses a grant.
            weightedTokensDelta: -granted,
            remainingAfter: locked.remaining - granted,
            meterVersion: METER_VERSION,
            createdAt: at,
          });
        }

        // Not a status rewrite to `cancelled`: §13 wants a human to close the loop with the
        // payment provider, and `review_required` is the state the reconciliation pass and
        // the dashboard both surface for that.
        await tx.orders.markReviewRequired(order.id, reason, at);

        await writeAudit(
          tx,
          auditActor(actor),
          {
            action: ADMIN_ACTIONS.orderRefunded,
            targetType: "order",
            targetId: order.id,
            reason,
            details: {
              previousStatus: order.status,
              apiKeyId: keyId,
              weightedTokensReversed: reversed,
              amountIdr: order.amountIdr,
              providerRefundIssued: false,
            },
          },
          at,
        );

        return { kind: "ok" as const, reversed };
      });

      if (outcome.kind === "missing") {
        throw new BosandaError("not_found", { internalDetail: `order ${orderId} not found` });
      }
      if (outcome.kind === "already") {
        return reply
          .status(200)
          .send(ok("This order was already refunded and is awaiting provider reconciliation."));
      }
      if (outcome.kind === "not_refundable") {
        throw new BosandaError("conflict", {
          internalDetail: `refund refused: order ${orderId} is ${outcome.status}`,
        });
      }
      if (outcome.kind === "key_missing") {
        // The order says activated but its key is gone. A data defect, not operator error:
        // recorded as a conflict so nothing is written, and named in the log so it can be
        // investigated.
        throw new BosandaError("conflict", {
          internalDetail: `refund refused: order ${orderId} target key is missing`,
        });
      }

      request.bosandaLog.warn(
        { orderId, weightedTokensReversed: outcome.reversed },
        "order refunded by an admin",
      );

      return reply
        .status(200)
        .send(
          ok(
            "Quota reversed and the order flagged for review. Issue the refund with the payment provider — the gateway did not.",
          ),
        );
    },
  );
}
