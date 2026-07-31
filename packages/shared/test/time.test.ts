import { describe, expect, it } from "vitest";
import {
  KEY_VALIDITY_MS,
  DAY_MS,
  addMs,
  isExpired,
  secondsUntil,
  backoffMs,
  fixedClock,
  systemClock,
} from "@bosanda/shared";

describe("key validity", () => {
  it("is exactly 24 hours (PLAN.md §11)", () => {
    expect(KEY_VALIDITY_MS).toBe(DAY_MS);
    expect(KEY_VALIDITY_MS).toBe(86_400_000);
  });
});

describe("clocks", () => {
  it("fixedClock is stable and returns defensive copies", () => {
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("systemClock advances", () => {
    expect(systemClock.now().getTime()).toBeGreaterThan(1_700_000_000_000);
  });
});

describe("expiry", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("treats a null expiry as never expiring", () => {
    expect(isExpired(null, now)).toBe(false);
  });

  it("treats the exact expiry instant as expired", () => {
    expect(isExpired(new Date(now), now)).toBe(true);
  });

  it("distinguishes past from future", () => {
    expect(isExpired(addMs(now, -1), now)).toBe(true);
    expect(isExpired(addMs(now, 1), now)).toBe(false);
  });

  it("floors remaining seconds and never goes negative", () => {
    expect(secondsUntil(addMs(now, 90_500), now)).toBe(90);
    expect(secondsUntil(addMs(now, -5_000), now)).toBe(0);
  });

  it("computes a 24h window from payment confirmation", () => {
    const paidAt = new Date("2026-03-04T09:15:00.000Z");
    expect(addMs(paidAt, KEY_VALIDITY_MS).toISOString()).toBe("2026-03-05T09:15:00.000Z");
  });
});

describe("backoffMs", () => {
  it("starts at the 30s default cooldown (PLAN.md §7)", () => {
    expect(backoffMs(1, 30_000, 900_000, () => 1)).toBe(30_000);
  });

  it("escalates exponentially and caps at the maximum", () => {
    const full = () => 1;
    expect(backoffMs(2, 30_000, 900_000, full)).toBe(60_000);
    expect(backoffMs(3, 30_000, 900_000, full)).toBe(120_000);
    expect(backoffMs(20, 30_000, 900_000, full)).toBe(900_000);
  });

  it("applies jitter within [50%, 100%] of the exponential value", () => {
    expect(backoffMs(1, 30_000, 900_000, () => 0)).toBe(15_000);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const value = backoffMs(attempt, 30_000, 900_000);
      const exponential = Math.min(900_000, 30_000 * 2 ** (attempt - 1));
      expect(value).toBeGreaterThanOrEqual(Math.floor(exponential * 0.5));
      expect(value).toBeLessThanOrEqual(exponential);
    }
  });

  it("clamps non-positive attempts to the base delay", () => {
    expect(backoffMs(0, 30_000, 900_000, () => 1)).toBe(30_000);
  });
});
