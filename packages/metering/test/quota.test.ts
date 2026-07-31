import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { KEY_VALIDITY_MS, fixedClock } from "@bosanda/shared";
import {
  MAX_KEY_QUOTA,
  PACKAGE_INCREMENT,
  allowStreamToFinish,
  canStartRequest,
  type KeyQuotaState,
  priceForQuota,
  type ResolvedUsage,
  settle,
  validateTopUp,
  worstCaseOverage,
} from "@bosanda/metering";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const clock = fixedClock(NOW);

function key(overrides: Partial<KeyQuotaState> = {}): KeyQuotaState {
  return {
    keyId: "key_01",
    status: "active",
    remaining: 10_000_000,
    quotaLimit: 10_000_000,
    expiresAt: new Date(NOW.getTime() + KEY_VALIDITY_MS),
    ...overrides,
  };
}

function usage(overrides: Partial<ResolvedUsage> = {}): ResolvedUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    estimated: false,
    source: "upstream",
    meterVersion: "meter-1/heuristic-1",
    ...overrides,
  };
}

describe("canStartRequest (§10 quota behavior)", () => {
  it("allows an active key with positive remaining quota", () => {
    expect(canStartRequest(key(), clock)).toEqual({ allowed: true });
  });

  it("allows a key with exactly 1 weighted token left", () => {
    expect(canStartRequest(key({ remaining: 1 }), clock).allowed).toBe(true);
  });

  it("rejects at exactly zero remaining", () => {
    const decision = canStartRequest(key({ remaining: 0 }), clock);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.error).toBeInstanceOf(BosandaError);
      expect(decision.error.code).toBe("quota_exhausted");
      expect(decision.error.status).toBe(429);
    }
  });

  it("rejects a negative balance left by bounded overage", () => {
    const decision = canStartRequest(key({ remaining: -50_000 }), clock);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.error.code).toBe("quota_exhausted");
  });

  it("rejects a revoked key as an auth failure, not a quota failure", () => {
    const decision = canStartRequest(key({ status: "revoked" }), clock);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.error.code).toBe("authentication_error");
      expect(decision.error.status).toBe(401);
    }
  });

  it("rejects a key flagged expired", () => {
    const decision = canStartRequest(key({ status: "expired" }), clock);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.error.code).toBe("authentication_error");
  });

  it("rejects a key whose expiresAt has passed even if still flagged active", () => {
    // The worker may not have swept it yet; the gateway must not trust the flag alone.
    const decision = canStartRequest(key({ expiresAt: new Date(NOW.getTime() - 1) }), clock);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.error.code).toBe("authentication_error");
  });

  it("treats the exact expiry instant as expired", () => {
    expect(canStartRequest(key({ expiresAt: NOW }), clock).allowed).toBe(false);
    expect(canStartRequest(key({ expiresAt: new Date(NOW.getTime() + 1) }), clock).allowed).toBe(
      true,
    );
  });

  it("allows a key with no expiry set", () => {
    expect(canStartRequest(key({ expiresAt: null }), clock).allowed).toBe(true);
  });

  it("checks revocation before quota, so a revoked empty key reports auth", () => {
    const decision = canStartRequest(key({ status: "revoked", remaining: 0 }), clock);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.error.code).toBe("authentication_error");
  });

  it("never leaks the key id into the client-visible message", () => {
    const decision = canStartRequest(key({ remaining: 0 }), clock);
    if (!decision.allowed) {
      expect(decision.error.publicMessage).not.toContain("key_01");
      expect(decision.error.internalDetail).toContain("key_01");
    }
  });
});

describe("allowStreamToFinish (§10: never cut mid-stream)", () => {
  it("always permits an in-flight stream to complete", () => {
    expect(allowStreamToFinish()).toBe(true);
  });
});

describe("settle (§10 atomic settlement)", () => {
  it("computes the weighted deduction and the resulting balance", () => {
    const result = settle({
      state: key({ remaining: 10_000_000 }),
      usage: usage({ inputTokens: 600_000, outputTokens: 400_000 }),
      multiplier: 1.3,
      multiplierVersion: 1,
      model: "bosanda-sonnet",
    });

    expect(result.weightedTokens).toBe(1_300_000);
    expect(result.remainingAfter).toBe(8_700_000);
  });

  it("lets the balance go negative when a stream finished across zero", () => {
    const result = settle({
      state: key({ remaining: 1 }),
      usage: usage({ inputTokens: 100_000, outputTokens: 100_000 }),
      multiplier: 2.2,
      multiplierVersion: 3,
      model: "bosanda-opus",
    });

    expect(result.weightedTokens).toBe(440_000);
    expect(result.remainingAfter).toBe(1 - 440_000);
    expect(result.remainingAfter).toBeLessThan(0);
  });

  it("charges an errored partial turn for estimated usage (§10)", () => {
    const result = settle({
      state: key(),
      usage: usage({ inputTokens: 5000, outputTokens: 120, estimated: true, source: "counted" }),
      multiplier: 1.3,
      multiplierVersion: 1,
      model: "bosanda-sonnet",
    });

    expect(result.weightedTokens).toBeGreaterThan(0);
    expect(result.estimated).toBe(true);
    expect(result.source).toBe("counted");
  });

  it("settles a zero-token turn to zero without error", () => {
    const result = settle({
      state: key(),
      usage: usage({ inputTokens: 0, outputTokens: 0 }),
      multiplier: 1.3,
      multiplierVersion: 1,
      model: "bosanda-sonnet",
    });
    expect(result.weightedTokens).toBe(0);
    expect(result.remainingAfter).toBe(key().remaining);
  });

  it("never credits quota back", () => {
    const result = settle({
      state: key(),
      usage: usage(),
      multiplier: 1.3,
      multiplierVersion: 1,
      model: "bosanda-sonnet",
    });
    expect(result.weightedTokens).toBeGreaterThanOrEqual(0);
    expect(result.remainingAfter).toBeLessThanOrEqual(key().remaining);
  });

  it("carries the provenance §10 requires on every ledger row", () => {
    const result = settle({
      state: key(),
      usage: usage({ estimated: true, source: "fallback", meterVersion: "meter-1/heuristic-1" }),
      multiplier: 2.2,
      multiplierVersion: 7,
      model: "bosanda-opus",
    });

    expect(result.estimated).toBe(true);
    expect(result.source).toBe("fallback");
    expect(result.meterVersion).toBe("meter-1/heuristic-1");
    expect(result.multiplier).toBe(2.2);
    expect(result.multiplierVersion).toBe(7);
    expect(result.model).toBe("bosanda-opus");
  });

  it("does not mutate the input state", () => {
    const state = key();
    settle({
      state,
      usage: usage(),
      multiplier: 1.3,
      multiplierVersion: 1,
      model: "bosanda-sonnet",
    });
    expect(state.remaining).toBe(10_000_000);
  });

  it("produces no drift across many sequential settlements", () => {
    let remaining = 10_000_000;
    for (let i = 0; i < 1000; i += 1) {
      const result = settle({
        state: key({ remaining }),
        usage: usage({ inputTokens: 100, outputTokens: 0 }),
        multiplier: 1.3,
        multiplierVersion: 1,
        model: "bosanda-sonnet",
      });
      remaining = result.remainingAfter;
    }
    // 100 raw at 1.3x = 130 weighted, exactly, 1000 times.
    expect(remaining).toBe(10_000_000 - 1000 * 130);
  });
});

describe("worstCaseOverage (§10 bounded negative overage)", () => {
  it("includes the admitted stream even when concurrency is one", () => {
    expect(worstCaseOverage(1, 500_000)).toBe(1 - 500_000);
  });

  it("bounds the floor for 5 concurrent streams", () => {
    // All five may observe remaining === 1 before any one of them settles.
    expect(worstCaseOverage(5, 500_000)).toBe(1 - 5 * 500_000);
  });

  it("is finite and computable, which is what 'bounded' means here", () => {
    const bound = worstCaseOverage(5, 128_000 * 2.2);
    expect(Number.isFinite(bound)).toBe(true);
    expect(bound).toBeLessThan(0);
  });

  it("scales linearly with concurrency", () => {
    expect(worstCaseOverage(3, 1000)).toBe(1 - 3000);
    expect(worstCaseOverage(5, 1000)).toBe(1 - 5000);
  });

  it("rejects an invalid concurrency ceiling or stream cost", () => {
    expect(() => worstCaseOverage(0, 1000)).toThrow(RangeError);
    expect(() => worstCaseOverage(2.5, 1000)).toThrow(RangeError);
    for (const cost of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => worstCaseOverage(5, cost)).toThrow(RangeError);
    }
  });

  it("matches an empirical 5-stream simulation", () => {
    // Admit while remaining > 0, then settle all five.
    const costPerStream = 200_000;
    let remaining = 1;
    let admitted = 0;
    for (let i = 0; i < 5; i += 1) {
      if (canStartRequest(key({ remaining }), clock).allowed) admitted += 1;
    }
    expect(admitted).toBe(5); // all five saw remaining === 1 before any settled
    remaining -= admitted * costPerStream;
    expect(remaining).toBe(worstCaseOverage(5, costPerStream));

    // And the next request is refused.
    expect(canStartRequest(key({ remaining }), clock).allowed).toBe(false);
  });
});

describe("validateTopUp (§11 caps and validity)", () => {
  it("accepts a valid top-up and resets validity to 24h from now", () => {
    const decision = validateTopUp(key({ remaining: 1_000_000 }), 10_000_000, clock);
    expect(decision.accepted).toBe(true);
    if (decision.accepted) {
      expect(decision.remainingAfter).toBe(11_000_000);
      expect(decision.quotaLimitAfter).toBe(20_000_000);
      expect(decision.expiresAt.getTime()).toBe(NOW.getTime() + KEY_VALIDITY_MS);
    }
  });

  it("accepts a top-up landing exactly on the 100M cap", () => {
    const decision = validateTopUp(key({ remaining: 10_000_000 }), 90_000_000, clock);
    expect(decision.accepted).toBe(true);
    if (decision.accepted) expect(decision.remainingAfter).toBe(MAX_KEY_QUOTA);
  });

  it("rejects a top-up one token over the cap", () => {
    const decision = validateTopUp(key({ remaining: 10_000_001 }), 90_000_000, clock);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.error.code).toBe("conflict");
  });

  it("rejects an expired key (§11)", () => {
    const decision = validateTopUp(
      key({ expiresAt: new Date(NOW.getTime() - 1) }),
      10_000_000,
      clock,
    );
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.error.code).toBe("conflict");
  });

  it("rejects an exhausted key at zero (§11)", () => {
    const decision = validateTopUp(key({ remaining: 0 }), 10_000_000, clock);
    expect(decision.accepted).toBe(false);
  });

  it("rejects a key left negative by overage", () => {
    const decision = validateTopUp(key({ remaining: -5 }), 10_000_000, clock);
    expect(decision.accepted).toBe(false);
  });

  it("rejects a revoked key", () => {
    const decision = validateTopUp(key({ status: "revoked" }), 10_000_000, clock);
    expect(decision.accepted).toBe(false);
  });

  it("rejects a non-10M-increment purchase", () => {
    for (const bad of [1, 999, 5_000_000, 15_000_000, 10_000_001]) {
      const decision = validateTopUp(key({ remaining: 1 }), bad, clock);
      expect(decision.accepted).toBe(false);
      if (!decision.accepted) expect(decision.error.code).toBe("invalid_request");
    }
  });

  it("rejects a purchase larger than the cap outright", () => {
    const decision = validateTopUp(key({ remaining: 1 }), 110_000_000, clock);
    expect(decision.accepted).toBe(false);
  });

  it("rejects zero and negative purchases", () => {
    expect(validateTopUp(key(), 0, clock).accepted).toBe(false);
    expect(validateTopUp(key(), -10_000_000, clock).accepted).toBe(false);
  });

  it("applies the cap to remaining, not to lifetime quotaLimit (§11)", () => {
    // A key that bought 100M and burned 90M has 10M live and may buy 90M more.
    const decision = validateTopUp(
      key({ remaining: 10_000_000, quotaLimit: 100_000_000 }),
      90_000_000,
      clock,
    );
    expect(decision.accepted).toBe(true);
    if (decision.accepted) expect(decision.quotaLimitAfter).toBe(190_000_000);
  });

  it("does not leak the key id publicly", () => {
    const decision = validateTopUp(key({ remaining: 0 }), 10_000_000, clock);
    if (!decision.accepted) {
      expect(decision.error.publicMessage).not.toContain("key_01");
    }
  });
});

describe("priceForQuota (§11 pricing table)", () => {
  it("matches every row of the published table", () => {
    const table: ReadonlyArray<readonly [number, number]> = [
      [10_000_000, 9_500],
      [20_000_000, 19_000],
      [30_000_000, 28_500],
      [40_000_000, 38_000],
      [50_000_000, 47_500],
      [60_000_000, 57_000],
      [70_000_000, 66_500],
      [80_000_000, 76_000],
      [90_000_000, 85_500],
      [100_000_000, 95_000],
    ];
    for (const [quota, price] of table) {
      expect(priceForQuota(quota)).toBe(price);
    }
  });

  it("is linear at Rp9.500 per 10M", () => {
    expect(priceForQuota(PACKAGE_INCREMENT * 4)).toBe(9_500 * 4);
  });

  it("returns integer rupiah", () => {
    for (let steps = 1; steps <= 10; steps += 1) {
      expect(Number.isInteger(priceForQuota(PACKAGE_INCREMENT * steps))).toBe(true);
    }
  });

  it("rejects a size outside the published range or off-increment", () => {
    expect(() => priceForQuota(0)).toThrow(RangeError);
    expect(() => priceForQuota(5_000_000)).toThrow(RangeError);
    expect(() => priceForQuota(110_000_000)).toThrow(RangeError);
    expect(() => priceForQuota(-10_000_000)).toThrow(RangeError);
  });
});
