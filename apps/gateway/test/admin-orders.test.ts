/**
 * Admin order listing, manual activation, and refund (PLAN.md §11, §13, §16).
 *
 * These are the two admin mutations that move money and quota, so the properties under
 * test are the ones whose failure is unrecoverable rather than merely wrong:
 *
 *   1. Manual activation goes through `decideActivation` + `executeActivation`. Not a
 *      hand-rolled balance write — the row lock in `markActivated` IS the idempotency
 *      barrier, and a second activation must not grant a second key.
 *   2. A refund writes an append-only ledger row for the reversal (§16 invariant 5). A
 *      balance that moves without a ledger row makes a billing dispute unanswerable.
 *   3. A refund is idempotent, and it does NOT claim to have moved money at the provider.
 *   4. Query filters are validated, not silently normalized: `normalizePagination` clamps
 *      and `normalizeOrderFilter` drops unknown statuses, so the route layer has to reject
 *      before those run or an operator's typo becomes an unfiltered list.
 */

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import { harness } from "./harness.js";
import { adminApiKey, adminHarness, adminOrder, customerUser } from "./admin-harness.js";

async function setup(options: Parameters<typeof adminHarness>[0] = {}) {
  const admin = await adminHarness(options);
  const metered = harness();
  return {
    ...admin,
    app: buildApp({
      deps: metered.deps,
      readiness: createReadinessState(),
      admin: admin.deps,
    }),
  };
}

describe("GET /admin/v1/orders", () => {
  it("returns the strict summary fields with the username and package name joined in", async () => {
    const customer = customerUser({ username: "buyer" });
    const order = adminOrder({ userId: customer.id });
    const { app, cookie } = await setup({
      fixtures: { users: [customer], orders: [order] },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/orders",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ orders: Record<string, unknown>[]; total: number }>();
    expect(body.total).toBe(1);

    const row = body.orders[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "username",
        "userId",
        "packageName",
        "type",
        "amountIdr",
        "status",
        "provider",
        "providerTransactionId",
        "createdAt",
        "paidAt",
        "activatedAt",
      ].sort(),
    );

    // Neither lives on `orders`; both are joined for display.
    expect(row["username"]).toBe("buyer");
    expect(row["packageName"]).toBe("Starter");
  });

  it("filters by status", async () => {
    const paid = adminOrder({ status: "paid" });
    const activated = adminOrder({ status: "activated", activatedAt: new Date() });
    const { app, cookie } = await setup({ fixtures: { orders: [paid, activated] } });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/orders?status=activated",
      headers: { cookie },
    });

    const body = response.json<{ orders: { id: string }[] }>();
    expect(body.orders.map((order) => order.id)).toEqual([activated.id]);
  });

  it("rejects an unknown status instead of ignoring it", async () => {
    const { app, cookie } = await setup({ fixtures: { orders: [adminOrder()] } });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/orders?status=nonsense",
      headers: { cookie },
    });

    /**
     * `normalizeOrderFilter` silently DROPS an unrecognized status, which would return the
     * full unfiltered list. An operator reading that list would conclude those orders have
     * the status they filtered for. Rejected at the boundary instead.
     */
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown query parameter", async () => {
    const { app, cookie } = await setup();

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/orders?statuz=paid",
      headers: { cookie },
    });

    // A misspelled filter that returns everything is worse than an error.
    expect(response.statusCode).toBe(400);
  });

  it("rejects a malformed or over-large limit rather than clamping it", async () => {
    const { app, cookie } = await setup();

    for (const query of ["limit=abc", "limit=0", "limit=-5", "limit=100000", "offset=-1"]) {
      const response = await app.inject({
        method: "GET",
        url: `/admin/v1/orders?${query}`,
        headers: { cookie },
      });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it("resolves `q` to matching orders", async () => {
    const customer = customerUser({ username: "findme" });
    const mine = adminOrder({ userId: customer.id });
    const other = adminOrder();
    const { app, cookie } = await setup({
      fixtures: { users: [customer], orders: [mine, other] },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/orders?q=findme",
      headers: { cookie },
    });

    const body = response.json<{ orders: { id: string }[] }>();
    expect(body.orders.map((order) => order.id)).toEqual([mine.id]);
  });
});

describe("GET /admin/v1/orders/:orderId", () => {
  it("returns the detail view without any key material", async () => {
    const customer = customerUser();
    const key = adminApiKey({ userId: customer.id, prefix: "bsk_live_abcd" });
    const order = adminOrder({
      userId: customer.id,
      status: "activated",
      type: "top_up",
      targetApiKeyId: key.id,
      activatedAt: new Date(),
    });
    const { app, cookie } = await setup({
      fixtures: { users: [customer], orders: [order], apiKeys: [key] },
    });

    const response = await app.inject({
      method: "GET",
      url: `/admin/v1/orders/${order.id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      [
        "order",
        "packageSnapshot",
        "targetApiKeyPrefix",
        "stockReservationExpiresAt",
        "ledger",
        "paymentEvents",
      ].sort(),
    );

    // The display prefix only. The envelope, the lookup digest, and the plaintext are all
    // absent — §16 invariant 1 covers a stored key exactly as it covers a credential.
    expect(body["targetApiKeyPrefix"]).toBe("bsk_live_abcd");
    const raw = response.body;
    expect(raw).not.toContain("envelope");
    expect(raw).not.toContain("digest");
    expect(raw).not.toContain("encryptedKey");
    expect(raw).not.toContain("lookupDigest");
  });

  it("404s for an unknown order", async () => {
    const { app, cookie } = await setup({ fixtures: { orders: [] } });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/orders/order-nope",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /admin/v1/orders/:orderId/activate", () => {
  it("activates a paid new-key order through the frozen activation path", async () => {
    const customer = customerUser();
    const order = adminOrder({ userId: customer.id, status: "paid" });
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: { users: [customer], orders: [order] },
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/activate`,
      headers: { cookie },
      payload: { reason: "webhook lost, payment confirmed in the provider dashboard" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);

    const stored = fixtures.orders[0]!;
    expect(stored.status).toBe("activated");
    expect(stored.activatedAt).not.toBeNull();

    // A key now exists for the customer, and a grant ledger row backs its balance.
    expect(fixtures.apiKeys).toHaveLength(1);
    expect(fixtures.apiKeys[0]!.userId).toBe(customer.id);
    expect(fixtures.ledger).toHaveLength(1);
    expect(fixtures.ledger[0]!.weightedTokensDelta).toBe(1_000_000);

    /**
     * The plaintext key is NOT in the response. §12 gives the customer a one-time reveal on
     * their own key; the admin schema has no field for it and `.strict()` would reject one.
     * An operator who could read a customer's key would be a standing incident.
     */
    expect(response.body).not.toContain("bsk_");

    // Two audit rows: the system row from `executeActivation`, and the admin row recording
    // that a human forced it and why.
    const actions = recorded.audit.map((row) => row.action);
    expect(actions).toContain("order.activated_by_admin");
    const adminRow = recorded.audit.find((row) => row.action === "order.activated_by_admin")!;
    expect(adminRow.metadata["reason"]).toBe(
      "webhook lost, payment confirmed in the provider dashboard",
    );
    // No key material anywhere in the audit trail.
    expect(JSON.stringify(recorded.audit)).not.toContain("bsk_");
  });

  it("is idempotent: a second activation is a conflict and grants nothing further", async () => {
    const customer = customerUser();
    const order = adminOrder({ userId: customer.id, status: "paid" });
    const { app, cookie, fixtures } = await setup({
      fixtures: { users: [customer], orders: [order] },
    });

    const first = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/activate`,
      headers: { cookie },
      payload: { reason: "first" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/activate`,
      headers: { cookie },
      payload: { reason: "second" },
    });

    /**
     * `markActivated` is guarded on `status='paid' AND activated_at IS NULL`, so the second
     * call matches no row. Reported as a 409. The customer keeps exactly one key and one
     * grant — a double activation would hand out quota nobody paid for.
     */
    expect(second.statusCode).toBe(409);
    expect(fixtures.apiKeys).toHaveLength(1);
    expect(fixtures.ledger).toHaveLength(1);
  });

  it("refuses to activate an unpaid order", async () => {
    const order = adminOrder({ status: "pending", paidAt: null });
    const { app, cookie, fixtures } = await setup({ fixtures: { orders: [order] } });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/activate`,
      headers: { cookie },
      payload: { reason: "customer says they paid" },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(fixtures.apiKeys).toHaveLength(0);
    expect(fixtures.ledger).toHaveLength(0);
  });

  it("requires a reason", async () => {
    const order = adminOrder({ status: "paid" });
    const { app, cookie } = await setup({ fixtures: { orders: [order] } });

    for (const payload of [{}, { reason: "" }, { reason: "   " }]) {
      const response = await app.inject({
        method: "POST",
        url: `/admin/v1/orders/${order.id}/activate`,
        headers: { cookie },
        payload,
      });
      // §15 exists so an override has a recorded justification. A blank one defeats it.
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("writes nothing when the transaction fails", async () => {
    const order = adminOrder({ status: "paid" });
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: { orders: [order] },
      failTransaction: true,
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/activate`,
      headers: { cookie },
      payload: { reason: "rollback check" },
    });

    expect(response.statusCode).toBe(500);
    expect(recorded.rollbacks).toBe(1);
    // The audit row and the effect share one transaction, so neither survives.
    expect(recorded.audit).toHaveLength(0);
    expect(fixtures.orders[0]!.status).toBe("paid");
  });
});

describe("POST /admin/v1/orders/:orderId/refund", () => {
  it("reverses the granted quota with a ledger row and flags the order for review", async () => {
    const customer = customerUser();
    const key = adminApiKey({ userId: customer.id, quotaRemaining: 1_000_000 });
    const order = adminOrder({
      userId: customer.id,
      status: "activated",
      targetApiKeyId: key.id,
      activatedAt: new Date(),
    });
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: { users: [customer], orders: [order], apiKeys: [key] },
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/refund`,
      headers: { cookie },
      payload: { reason: "customer requested, duplicate purchase" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);

    /**
     * A ledger row for the reversal, written by `recordAdjustment` — the only method that
     * moves the balance and appends the row together. §16 invariant 5 is exactly this: a
     * balance change with no matching ledger row cannot be explained to a customer.
     */
    expect(recorded.adjustments).toHaveLength(1);
    expect(recorded.adjustments[0]!.weightedTokensDelta).toBe(-1_000_000);
    expect(recorded.adjustments[0]!.apiKeyId).toBe(key.id);

    // `review_required`, not `cancelled`: §13 wants a human to close the loop with the
    // payment provider, and this is the state the reconciliation pass surfaces.
    expect(fixtures.orders[0]!.status).toBe("review_required");

    const audit = recorded.audit.at(-1)!;
    expect(audit.action).toBe("order.refunded");
    expect(audit.metadata["reason"]).toBe("customer requested, duplicate purchase");
    // The operator must not believe the money moved on its own.
    expect(audit.metadata["providerRefundIssued"]).toBe(false);
    expect(response.json<{ message: string }>().message).toContain("did not");
  });

  it("is idempotent: a second refund reports success and writes no second reversal", async () => {
    const customer = customerUser();
    const key = adminApiKey({ userId: customer.id });
    const order = adminOrder({
      userId: customer.id,
      status: "activated",
      targetApiKeyId: key.id,
      activatedAt: new Date(),
    });
    const { app, cookie, recorded } = await setup({
      fixtures: { users: [customer], orders: [order], apiKeys: [key] },
    });

    const first = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/refund`,
      headers: { cookie },
      payload: { reason: "first" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/refund`,
      headers: { cookie },
      payload: { reason: "double click" },
    });

    expect(first.statusCode).toBe(200);
    // 200, not a 409: the order IS refunded, which is what the operator wanted. Reporting a
    // conflict would invite them to investigate a non-problem.
    expect(second.statusCode).toBe(200);
    // But exactly one reversal. A second would debit quota the customer never received.
    expect(recorded.adjustments).toHaveLength(1);
  });

  it("keeps the full negative delta on the ledger when the balance is already spent", async () => {
    const customer = customerUser();
    // The customer spent most of the grant before asking for a refund.
    const key = adminApiKey({ userId: customer.id, quotaRemaining: 200_000 });
    const order = adminOrder({
      userId: customer.id,
      status: "activated",
      targetApiKeyId: key.id,
      activatedAt: new Date(),
    });
    const { app, cookie, recorded } = await setup({
      fixtures: { users: [customer], orders: [order], apiKeys: [key] },
    });

    await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/refund`,
      headers: { cookie },
      payload: { reason: "partial usage refund" },
    });

    /**
     * The reversal is what the ORDER granted (1,000,000), not what the key has left. The
     * persisted balance clamps at zero; the full signed delta stays on the ledger row so
     * the arithmetic still reconciles. Reversing only the remaining balance would silently
     * write off the quota that was actually consumed.
     */
    expect(recorded.adjustments[0]!.weightedTokensDelta).toBe(-1_000_000);
    expect(recorded.adjustments[0]!.remainingAfter).toBeLessThan(0);
  });

  it("refuses to refund an order in a non-refundable state", async () => {
    const order = adminOrder({ status: "expired", paidAt: null });
    const { app, cookie, recorded } = await setup({ fixtures: { orders: [order] } });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/refund`,
      headers: { cookie },
      payload: { reason: "cleanup" },
    });

    expect(response.statusCode).toBe(409);
    expect(recorded.adjustments).toHaveLength(0);
    expect(recorded.audit).toHaveLength(0);
  });

  it("refunds a paid-but-unactivated order without touching a key", async () => {
    const order = adminOrder({ status: "paid", targetApiKeyId: null });
    const { app, cookie, fixtures, recorded } = await setup({ fixtures: { orders: [order] } });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/orders/${order.id}/refund`,
      headers: { cookie },
      payload: { reason: "paid but never activated" },
    });

    expect(response.statusCode).toBe(200);
    // Nothing was ever granted, so there is nothing to reverse — but the order still needs
    // provider-side reconciliation, so it is flagged and audited.
    expect(recorded.adjustments).toHaveLength(0);
    expect(fixtures.orders[0]!.status).toBe("review_required");
    expect(recorded.audit.at(-1)!.action).toBe("order.refunded");
  });

  it("404s for an unknown order", async () => {
    const { app, cookie } = await setup({ fixtures: { orders: [] } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/orders/order-nope/refund",
      headers: { cookie },
      payload: { reason: "probe" },
    });

    expect(response.statusCode).toBe(404);
  });
});
