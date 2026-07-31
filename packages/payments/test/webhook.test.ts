import { describe, expect, it } from "vitest";
import {
  SIGNATURE_HEADER,
  decideWebhookAction,
  handlePakasirWebhook,
  parseWebhookEvent,
  payloadDigest,
  signPayload,
  verifySignature,
  type WebhookDeps,
} from "../src/webhook.js";
import { NOW, TEST_SECRET, clock, fakeEventStore, order, paidOrder } from "./fixtures.js";
import type { OrderSnapshot } from "../src/types.js";

const paidBody = JSON.stringify({
  order_id: "01JQORDER00000000000000001",
  status: "completed",
  amount: 9_500,
  transaction_id: "trx_synthetic_1",
  event_id: "evt_1",
});

const signed = (body: string): Record<string, string> => ({
  [SIGNATURE_HEADER]: signPayload(body, TEST_SECRET),
});

const deps = (found: OrderSnapshot | null = order({ status: "pending_payment" })): WebhookDeps => ({
  secret: TEST_SECRET,
  store: fakeEventStore(),
  clock,
  findOrder: async () => found,
});

describe("verifySignature", () => {
  it("accepts a correct HMAC over the raw body", () => {
    expect(verifySignature(paidBody, signPayload(paidBody, TEST_SECRET), TEST_SECRET)).toEqual({
      ok: true,
    });
  });

  it("accepts a sha256= prefix and mixed case", () => {
    const hex = signPayload(paidBody, TEST_SECRET);
    expect(verifySignature(paidBody, `sha256=${hex.toUpperCase()}`, TEST_SECRET).ok).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(verifySignature(paidBody, null, TEST_SECRET)).toEqual({
      ok: false,
      reason: "missing_signature",
    });
    expect(verifySignature(paidBody, "", TEST_SECRET).ok).toBe(false);
  });

  it("rejects a malformed signature", () => {
    expect(verifySignature(paidBody, "not-hex", TEST_SECRET)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
    // Right alphabet, wrong length.
    expect(verifySignature(paidBody, "abcdef", TEST_SECRET)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      verifySignature(paidBody, signPayload(paidBody, "another-secret-value"), TEST_SECRET),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered body — verification is over raw bytes", () => {
    const signature = signPayload(paidBody, TEST_SECRET);
    const tampered = paidBody.replace('"amount":9500', '"amount":1');
    expect(verifySignature(tampered, signature, TEST_SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a body that parses to the same object but differs by a byte", () => {
    const signature = signPayload(paidBody, TEST_SECRET);
    // Semantically identical JSON, different bytes (added whitespace).
    const reserialized = JSON.stringify(JSON.parse(paidBody), null, 2);
    expect(verifySignature(reserialized, signature, TEST_SECRET).ok).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("reads only order, status, amount, transaction, and event id", () => {
    const result = parseWebhookEvent(paidBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      orderId: "01JQORDER00000000000000001",
      status: "paid",
      amountIdr: 9_500,
      providerTransactionId: "trx_synthetic_1",
      eventKey: "evt_1",
    });
  });

  it("ignores quota, price, package, and username from the payload", () => {
    const hostile = JSON.stringify({
      order_id: "o1",
      status: "completed",
      quota: 100_000_000,
      price_idr: 1,
      package_id: "attacker",
      username: "admin",
    });
    const result = parseWebhookEvent(hostile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No field on the event can carry any of it.
    expect(Object.keys(result.event).sort()).toEqual(
      ["amountIdr", "eventKey", "orderId", "paidAt", "providerTransactionId", "status"].sort(),
    );
    expect(JSON.stringify(result.event)).not.toContain("attacker");
  });

  it("rejects malformed JSON", () => {
    expect(parseWebhookEvent("{not json")).toEqual({ ok: false, reason: "malformed_payload" });
  });

  it("rejects a payload missing required fields", () => {
    expect(parseWebhookEvent(JSON.stringify({ status: "paid" })).ok).toBe(false);
    expect(parseWebhookEvent(JSON.stringify({ order_id: "o1" })).ok).toBe(false);
    expect(parseWebhookEvent(JSON.stringify({ order_id: "", status: "paid" })).ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(parseWebhookEvent("[]").ok).toBe(false);
    expect(parseWebhookEvent('"a string"').ok).toBe(false);
  });

  it("derives a stable event key when the provider supplies none", () => {
    const body = JSON.stringify({ order_id: "o1", status: "completed", transaction_id: "t1" });
    const first = parseWebhookEvent(body);
    const second = parseWebhookEvent(body);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.event.eventKey).toBe(second.event.eventKey);
    // A different status for the same order is a different event.
    const other = parseWebhookEvent(
      JSON.stringify({ order_id: "o1", status: "expired", transaction_id: "t1" }),
    );
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.event.eventKey).not.toBe(first.event.eventKey);
  });
});

describe("payloadDigest", () => {
  it("is a stable sha256 hex of the raw body and contains none of it", () => {
    const digest = payloadDigest(paidBody);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(payloadDigest(paidBody));
    expect(digest).not.toContain("01JQORDER");
  });
});

describe("decideWebhookAction", () => {
  it("activates a paid order whose amount matches the snapshot", () => {
    const parsed = parseWebhookEvent(paidBody);
    if (!parsed.ok) throw new Error("fixture");
    const action = decideWebhookAction(order(), parsed.event);
    expect(action.kind).toBe("activate");
  });

  it("routes an amount mismatch to review instead of activating", () => {
    const body = JSON.stringify({ order_id: "o1", status: "completed", amount: 1, event_id: "e2" });
    const parsed = parseWebhookEvent(body);
    if (!parsed.ok) throw new Error("fixture");
    const action = decideWebhookAction(order(), parsed.event);
    expect(action).toMatchObject({ kind: "review_required", reason: "amount_mismatch" });
  });

  it("routes a snapshot price mismatch to review", () => {
    const parsed = parseWebhookEvent(paidBody);
    if (!parsed.ok) throw new Error("fixture");
    const action = decideWebhookAction(order({ amountIdr: 1_000 }), parsed.event);
    expect(action).toMatchObject({ kind: "review_required", reason: "snapshot_price_mismatch" });
  });

  it("is a no-op for an already-activated order", () => {
    const parsed = parseWebhookEvent(paidBody);
    if (!parsed.ok) throw new Error("fixture");
    const action = decideWebhookAction(
      order({ status: "activated", paidAt: NOW, activatedAt: NOW }),
      parsed.event,
    );
    expect(action).toEqual({ kind: "none", reason: "already_activated" });
  });

  it("expires and releases stock on an expired payment", () => {
    const parsed = parseWebhookEvent(
      JSON.stringify({ order_id: "o1", status: "expired", event_id: "e3" }),
    );
    if (!parsed.ok) throw new Error("fixture");
    expect(decideWebhookAction(order(), parsed.event).kind).toBe("expire_and_release_stock");
  });

  it("cancels and releases stock on a failed payment", () => {
    for (const status of ["failed", "cancelled"]) {
      const parsed = parseWebhookEvent(
        JSON.stringify({ order_id: "o1", status, event_id: status }),
      );
      if (!parsed.ok) throw new Error("fixture");
      expect(decideWebhookAction(order(), parsed.event).kind).toBe("cancel_and_release_stock");
    }
  });

  it("does nothing for a still-pending status", () => {
    const parsed = parseWebhookEvent(
      JSON.stringify({ order_id: "o1", status: "pending", event_id: "e4" }),
    );
    if (!parsed.ok) throw new Error("fixture");
    expect(decideWebhookAction(order(), parsed.event)).toEqual({
      kind: "none",
      reason: "not_paid",
    });
  });
});

describe("handlePakasirWebhook", () => {
  it("verifies, claims, matches, and returns an activate action", async () => {
    const outcome = await handlePakasirWebhook(paidBody, signed(paidBody), deps());
    expect(outcome.acknowledge).toBe(true);
    if (!outcome.acknowledge) return;
    expect(outcome.action.kind).toBe("activate");
    expect(outcome.eventKey).toBe("evt_1");
    expect(outcome.digest).toBe(payloadDigest(paidBody));
  });

  it("treats a replay as a no-op that still reports success", async () => {
    const shared = deps();
    const first = await handlePakasirWebhook(paidBody, signed(paidBody), shared);
    const second = await handlePakasirWebhook(paidBody, signed(paidBody), shared);

    expect(first.acknowledge).toBe(true);
    if (first.acknowledge) expect(first.action.kind).toBe("activate");

    expect(second.acknowledge).toBe(true);
    if (!second.acknowledge) return;
    expect(second.action).toEqual({ kind: "none", reason: "duplicate" });
  });

  it("does not acknowledge an unsigned delivery", async () => {
    const outcome = await handlePakasirWebhook(paidBody, {}, deps());
    expect(outcome).toMatchObject({ acknowledge: false, rejection: "missing_signature" });
  });

  it("does not acknowledge a mis-signed delivery", async () => {
    const outcome = await handlePakasirWebhook(
      paidBody,
      { [SIGNATURE_HEADER]: signPayload(paidBody, "wrong-secret-value") },
      deps(),
    );
    expect(outcome).toMatchObject({ acknowledge: false, rejection: "bad_signature" });
  });

  it("does not acknowledge a tampered body", async () => {
    const signature = signPayload(paidBody, TEST_SECRET);
    const tampered = paidBody.replace("9500", "1");
    const outcome = await handlePakasirWebhook(tampered, { [SIGNATURE_HEADER]: signature }, deps());
    expect(outcome).toMatchObject({ acknowledge: false, rejection: "bad_signature" });
  });

  it("never parses or claims an unverified body", async () => {
    const store = fakeEventStore();
    let lookups = 0;
    const outcome = await handlePakasirWebhook(
      paidBody,
      {},
      {
        secret: TEST_SECRET,
        store,
        clock,
        findOrder: async () => {
          lookups += 1;
          return order();
        },
      },
    );
    expect(outcome.acknowledge).toBe(false);
    expect(store.keys).toHaveLength(0);
    expect(lookups).toBe(0);
  });

  it("rejects a malformed payload that carries a valid signature", async () => {
    const body = "{not json";
    const outcome = await handlePakasirWebhook(body, signed(body), deps());
    expect(outcome).toMatchObject({ acknowledge: false, rejection: "malformed_payload" });
  });

  it("does not acknowledge an unknown order, so the provider retries", async () => {
    const outcome = await handlePakasirWebhook(paidBody, signed(paidBody), deps(null));
    expect(outcome).toMatchObject({ acknowledge: false, rejection: "unknown_order" });
  });

  it("acknowledges an order routed to review, so the provider stops redelivering", async () => {
    const outcome = await handlePakasirWebhook(
      paidBody,
      signed(paidBody),
      deps(order({ amountIdr: 1_000 })),
    );
    expect(outcome.acknowledge).toBe(true);
    if (!outcome.acknowledge) return;
    expect(outcome.action.kind).toBe("review_required");
  });

  it("accepts a header delivered as an array", async () => {
    const outcome = await handlePakasirWebhook(
      paidBody,
      { [SIGNATURE_HEADER]: [signPayload(paidBody, TEST_SECRET)] },
      deps(),
    );
    expect(outcome.acknowledge).toBe(true);
  });

  it("is a no-op when the matched order is already activated", async () => {
    const outcome = await handlePakasirWebhook(
      paidBody,
      signed(paidBody),
      deps(paidOrder({ status: "activated", activatedAt: NOW })),
    );
    expect(outcome.acknowledge).toBe(true);
    if (!outcome.acknowledge) return;
    expect(outcome.action).toEqual({ kind: "none", reason: "already_activated" });
  });
});
