import { describe, expect, it } from "vitest";
import { MAX_KEY_QUOTA, type KeyQuotaState } from "@bosanda/metering";
import { fixedClock } from "@bosanda/shared";
import {
  decideActivation,
  isTopUpEligible,
  paymentInstant,
  validityMsFor,
} from "../src/activate.js";
import { NOW, TEN_M, clock, order, packageSnapshot, paidOrder } from "./fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const key = (overrides: Partial<KeyQuotaState> = {}): KeyQuotaState => ({
  keyId: "01JQKEY0000000000000000001",
  status: "active",
  remaining: TEN_M,
  quotaLimit: TEN_M,
  expiresAt: new Date(NOW.getTime() + DAY_MS),
  ...overrides,
});

const topUpOrder = (overrides = {}) =>
  paidOrder({
    type: "top_up",
    targetApiKeyId: "01JQKEY0000000000000000001",
    ...overrides,
  });

describe("validityMsFor", () => {
  it("uses the frozen snapshot duration", () => {
    expect(validityMsFor(order())).toBe(DAY_MS);
    expect(
      validityMsFor(order({ packageSnapshot: packageSnapshot({ durationSeconds: 3_600 }) })),
    ).toBe(3_600_000);
  });

  it("falls back to 24h when the snapshot duration is unusable", () => {
    for (const durationSeconds of [0, -1, 1.5]) {
      expect(validityMsFor(order({ packageSnapshot: packageSnapshot({ durationSeconds }) }))).toBe(
        DAY_MS,
      );
    }
  });
});

describe("paymentInstant", () => {
  it("prefers paidAt over now", () => {
    const paidAt = new Date(NOW.getTime() - 60_000);
    expect(paymentInstant(order({ paidAt }), NOW).toISOString()).toBe(paidAt.toISOString());
  });

  it("falls back to now when paidAt is absent", () => {
    expect(paymentInstant(order({ paidAt: null }), NOW).toISOString()).toBe(NOW.toISOString());
  });
});

describe("decideActivation — new key", () => {
  it("grants quota and 24h from confirmed payment", () => {
    const decision = decideActivation(paidOrder(), null, clock);
    expect(decision.activate).toBe(true);
    if (!decision.activate) return;
    expect(decision.grant).toEqual({
      kind: "new_key",
      userId: "01JQUSER000000000000000001",
      orderId: "01JQORDER00000000000000001",
      quota: TEN_M,
      quotaLimit: TEN_M,
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
  });

  it("measures validity from payment, not from a later activation", () => {
    // Webhook delayed by 6h: the window still ends 24h after payment.
    const paidAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
    const decision = decideActivation(paidOrder({ paidAt }), null, clock);
    expect(decision.activate).toBe(true);
    if (!decision.activate) return;
    expect(decision.grant.expiresAt.toISOString()).toBe(
      new Date(paidAt.getTime() + DAY_MS).toISOString(),
    );
  });

  it("sends an already-elapsed window to review rather than issuing a dead key", () => {
    const paidAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const decision = decideActivation(paidOrder({ paidAt }), null, clock);
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
    expect(decision.error.internalDetail).toContain("validity window already elapsed");
  });

  it("rejects an unpaid order", () => {
    for (const status of ["draft", "pending_payment", "expired", "cancelled"] as const) {
      const decision = decideActivation(order({ status }), null, clock);
      expect(decision.activate).toBe(false);
      if (decision.activate) return;
      expect(decision.review).toBe(false);
    }
  });

  it("rejects an already-activated order", () => {
    const decision = decideActivation(
      paidOrder({ status: "activated", activatedAt: NOW }),
      null,
      clock,
    );
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.error.internalDetail).toContain("already activated");
  });

  it("rejects a new_key order that names a target key", () => {
    const decision = decideActivation(paidOrder({ targetApiKeyId: "01JQKEY1" }), null, clock);
    expect(decision.activate).toBe(false);
  });

  it("rejects a new_key order handed a target key state", () => {
    const decision = decideActivation(paidOrder(), key(), clock);
    expect(decision.activate).toBe(false);
  });

  it("sends a quota above the snapshot cap to review", () => {
    const decision = decideActivation(
      paidOrder({
        packageSnapshot: packageSnapshot({
          weightedTokenQuota: 200_000_000,
          maxKeyQuota: MAX_KEY_QUOTA,
        }),
      }),
      null,
      clock,
    );
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
  });

  it("rejects a non-integer snapshot quota", () => {
    const decision = decideActivation(
      paidOrder({ packageSnapshot: packageSnapshot({ weightedTokenQuota: 1.5 }) }),
      null,
      clock,
    );
    expect(decision.activate).toBe(false);
  });
});

describe("decideActivation — top up", () => {
  it("credits an active key and resets expiry from payment", () => {
    const decision = decideActivation(topUpOrder(), key(), clock);
    expect(decision.activate).toBe(true);
    if (!decision.activate) return;
    expect(decision.grant).toEqual({
      kind: "top_up",
      userId: "01JQUSER000000000000000001",
      orderId: "01JQORDER00000000000000001",
      apiKeyId: "01JQKEY0000000000000000001",
      purchased: TEN_M,
      remainingAfter: 2 * TEN_M,
      quotaLimitAfter: 2 * TEN_M,
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
  });

  it("routes an exhausted key to review (§11: user must create a new key)", () => {
    const decision = decideActivation(topUpOrder(), key({ remaining: 0 }), clock);
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
    expect(decision.error.code).toBe("conflict");
  });

  it("routes a negative-overage key to review", () => {
    const decision = decideActivation(topUpOrder(), key({ remaining: -5_000 }), clock);
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
  });

  it("routes an expired key to review", () => {
    const decision = decideActivation(
      topUpOrder(),
      key({ expiresAt: new Date(NOW.getTime() - 1) }),
      clock,
    );
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
  });

  it("routes a revoked key to review", () => {
    const decision = decideActivation(topUpOrder(), key({ status: "revoked" }), clock);
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
  });

  it("enforces the 100M cap against REMAINING plus purchased", () => {
    // 95M remaining + 10M purchased exceeds the cap.
    const decision = decideActivation(topUpOrder(), key({ remaining: 95_000_000 }), clock);
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
    expect(decision.error.internalDetail).toContain("cap");
  });

  it("allows a key that has consumed most of a large package to be topped up again", () => {
    // 10M live out of a 100M lifetime limit: 90M more is legitimate.
    const decision = decideActivation(
      topUpOrder(),
      key({ remaining: TEN_M, quotaLimit: 100_000_000 }),
      clock,
    );
    expect(decision.activate).toBe(true);
  });

  it("rejects a top_up order with no target key named", () => {
    const decision = decideActivation(
      paidOrder({ type: "top_up", targetApiKeyId: null }),
      key(),
      clock,
    );
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(false);
  });

  it("routes a missing target key state to review", () => {
    const decision = decideActivation(topUpOrder(), null, clock);
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(true);
  });

  it("rejects a target key state that does not match the order", () => {
    const decision = decideActivation(
      topUpOrder(),
      key({ keyId: "01JQOTHERKEY0000000000001" }),
      clock,
    );
    expect(decision.activate).toBe(false);
    if (decision.activate) return;
    expect(decision.review).toBe(false);
  });

  it("judges eligibility at now but grants the window from payment", () => {
    // Paid 2h ago, key still valid now: window runs 24h from payment.
    const paidAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const decision = decideActivation(topUpOrder({ paidAt }), key(), clock);
    expect(decision.activate).toBe(true);
    if (!decision.activate) return;
    expect(decision.grant.expiresAt.toISOString()).toBe(
      new Date(paidAt.getTime() + DAY_MS).toISOString(),
    );
  });
});

describe("isTopUpEligible", () => {
  it("is true for an active, non-exhausted key under the cap", () => {
    expect(isTopUpEligible(key(), TEN_M, clock)).toBe(true);
  });

  it("is false for exhausted, expired, revoked, and over-cap keys", () => {
    expect(isTopUpEligible(key({ remaining: 0 }), TEN_M, clock)).toBe(false);
    expect(isTopUpEligible(key({ status: "revoked" }), TEN_M, clock)).toBe(false);
    expect(isTopUpEligible(key({ expiresAt: new Date(NOW.getTime() - 1) }), TEN_M, clock)).toBe(
      false,
    );
    expect(isTopUpEligible(key({ remaining: 95_000_000 }), TEN_M, clock)).toBe(false);
  });

  it("tracks the injected clock rather than wall time", () => {
    const later = fixedClock(new Date(NOW.getTime() + 2 * DAY_MS));
    expect(isTopUpEligible(key(), TEN_M, clock)).toBe(true);
    expect(isTopUpEligible(key(), TEN_M, later)).toBe(false);
  });
});
