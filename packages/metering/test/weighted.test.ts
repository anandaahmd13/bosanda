import { describe, expect, it } from "vitest";
import { rawTokens, weightedFromTokens, weightedTokens } from "@bosanda/metering";

describe("rawTokens", () => {
  it("sums input and output (PLAN.md §10)", () => {
    expect(rawTokens(1000, 500)).toBe(1500);
  });

  it("handles a zero-token turn", () => {
    expect(rawTokens(0, 0)).toBe(0);
  });

  it("rejects negative and fractional counts", () => {
    expect(() => rawTokens(-1, 0)).toThrow(RangeError);
    expect(() => rawTokens(0, -1)).toThrow(RangeError);
    expect(() => rawTokens(1.5, 0)).toThrow(RangeError);
  });
});

describe("weightedTokens", () => {
  it("matches the PLAN.md §10 worked examples", () => {
    // 1M raw tokens on a 1.3x model = 1.3M weighted tokens
    expect(weightedTokens(1_000_000, 1.3)).toBe(1_300_000);
    // 1M raw tokens on a 2.2x model = 2.2M weighted tokens
    expect(weightedTokens(1_000_000, 2.2)).toBe(2_200_000);
  });

  it("is identity at a 1.0 multiplier", () => {
    expect(weightedTokens(12_345, 1)).toBe(12_345);
  });

  it("returns zero for a zero-token turn", () => {
    expect(weightedTokens(0, 2.2)).toBe(0);
  });

  it("always returns an integer", () => {
    for (const raw of [1, 7, 33, 999, 1001, 123_457]) {
      for (const multiplier of [1.1, 1.3, 1.75, 2.2, 3.333]) {
        expect(Number.isInteger(weightedTokens(raw, multiplier))).toBe(true);
      }
    }
  });

  it("rounds up, so splitting a turn is never cheaper than not splitting", () => {
    // The anti-gaming property: ceil means N small turns cost >= one big turn.
    const multiplier = 1.3;
    const whole = weightedTokens(1000, multiplier);
    let split = 0;
    for (let i = 0; i < 1000; i += 1) {
      split += weightedTokens(1, multiplier);
    }
    expect(split).toBeGreaterThanOrEqual(whole);
    // And concretely: 1 token at 1.3x ceils to 2, so 1000 splits cost 2000 vs 1300.
    expect(weightedTokens(1, 1.3)).toBe(2);
    expect(split).toBe(2000);
  });

  it("does not drift across many sequential settlements", () => {
    // Each settlement rounds once; the total must equal the sum of the rounded parts,
    // with no compounding error.
    const multiplier = 1.3;
    let total = 0;
    for (let i = 0; i < 10_000; i += 1) {
      total += weightedTokens(100, multiplier);
    }
    expect(total).toBe(10_000 * 130);
  });

  it("is immune to binary floating-point artefacts", () => {
    // 3 * 1.1 is 3.3000000000000003 in IEEE 754. Scaled integer maths must not let
    // that artefact change the billed amount.
    expect(weightedTokens(3, 1.1)).toBe(4);
    expect(weightedTokens(30, 1.1)).toBe(33);
    // 0.07 * 100 style artefacts
    expect(weightedTokens(100, 1.07)).toBe(107);
  });

  it("handles a sub-1.0 multiplier without returning zero for real usage", () => {
    expect(weightedTokens(100, 0.5)).toBe(50);
    // NUMERIC(10,4)'s smallest positive value still bills non-zero usage.
    expect(weightedTokens(1, 0.0001)).toBe(1);
  });

  it("rejects positive multipliers that NUMERIC(10,4) would round to zero", () => {
    expect(() => weightedTokens(1, 0.00001)).toThrow(RangeError);
  });

  it("rejects multipliers with excess precision or magnitude", () => {
    expect(() => weightedTokens(100, 1.00001)).toThrow(RangeError);
    expect(() => weightedTokens(100, 1_000_000)).toThrow(RangeError);
  });

  it("handles very large token counts exactly", () => {
    // 100M raw at 2.2x is well inside IEEE 754 integer safety, but assert it anyway
    // since this is the commercial record.
    expect(weightedTokens(100_000_000, 2.2)).toBe(220_000_000);
    expect(Number.isSafeInteger(weightedTokens(100_000_000, 2.2))).toBe(true);
  });

  it("rejects a non-positive or non-finite multiplier", () => {
    expect(() => weightedTokens(100, 0)).toThrow(RangeError);
    expect(() => weightedTokens(100, -1.3)).toThrow(RangeError);
    expect(() => weightedTokens(100, Number.NaN)).toThrow(RangeError);
    expect(() => weightedTokens(100, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("rejects a negative or fractional raw count", () => {
    expect(() => weightedTokens(-1, 1.3)).toThrow(RangeError);
    expect(() => weightedTokens(1.5, 1.3)).toThrow(RangeError);
  });
});

describe("weightedFromTokens", () => {
  it("composes rawTokens and weightedTokens", () => {
    expect(weightedFromTokens(600_000, 400_000, 1.3)).toBe(1_300_000);
  });

  it("propagates validation from both stages", () => {
    expect(() => weightedFromTokens(-1, 0, 1.3)).toThrow(RangeError);
    expect(() => weightedFromTokens(1, 1, 0)).toThrow(RangeError);
  });
});
