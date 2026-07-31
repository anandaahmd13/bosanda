import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { MultiplierRegistry, type MultiplierRecord, weightedTokens } from "@bosanda/metering";

const JAN = new Date("2026-01-01T00:00:00.000Z");
const FEB = new Date("2026-02-01T00:00:00.000Z");
const MAR = new Date("2026-03-01T00:00:00.000Z");

function record(overrides: Partial<MultiplierRecord> = {}): MultiplierRecord {
  return {
    model: "bosanda-sonnet",
    version: 1,
    multiplier: 1.3,
    effectiveAt: JAN,
    ...overrides,
  };
}

describe("MultiplierRegistry.current", () => {
  it("returns the highest version already effective", () => {
    const registry = new MultiplierRegistry([
      record({ version: 1, multiplier: 1.3, effectiveAt: JAN }),
      record({ version: 2, multiplier: 1.5, effectiveAt: FEB }),
    ]);

    expect(registry.current("bosanda-sonnet", new Date("2026-01-15T00:00:00Z")).version).toBe(1);
    expect(registry.current("bosanda-sonnet", new Date("2026-02-15T00:00:00Z")).version).toBe(2);
  });

  it("ignores a staged future version (§9 staged updates)", () => {
    const registry = new MultiplierRegistry([
      record({ version: 1, multiplier: 1.3, effectiveAt: JAN }),
      record({ version: 2, multiplier: 9.9, effectiveAt: MAR }),
    ]);

    const resolved = registry.current("bosanda-sonnet", FEB);
    expect(resolved.version).toBe(1);
    expect(resolved.multiplier).toBe(1.3);
  });

  it("treats effectiveAt as inclusive at the exact instant", () => {
    const registry = new MultiplierRegistry([
      record({ version: 1, effectiveAt: JAN }),
      record({ version: 2, multiplier: 1.5, effectiveAt: FEB }),
    ]);
    expect(registry.current("bosanda-sonnet", FEB).version).toBe(2);
    expect(registry.current("bosanda-sonnet", new Date(FEB.getTime() - 1)).version).toBe(1);
  });

  it("rejects an unknown model rather than guessing a multiplier", () => {
    const registry = new MultiplierRegistry([record()]);
    expect(() => registry.current("nope", JAN)).toThrow(BosandaError);
    try {
      registry.current("nope", JAN);
    } catch (error) {
      expect((error as BosandaError).code).toBe("model_not_allowed");
    }
  });

  it("rejects a model whose only version is not yet effective", () => {
    const registry = new MultiplierRegistry([record({ effectiveAt: MAR })]);
    expect(() => registry.current("bosanda-sonnet", JAN)).toThrow(BosandaError);
  });

  it("resolves independently per model", () => {
    const registry = new MultiplierRegistry([
      record({ model: "a", version: 1, multiplier: 1.3 }),
      record({ model: "b", version: 1, multiplier: 2.2 }),
    ]);
    expect(registry.current("a", JAN).multiplier).toBe(1.3);
    expect(registry.current("b", JAN).multiplier).toBe(2.2);
  });
});

describe("MultiplierRegistry.atVersion — historical usage is never rewritten (§9)", () => {
  it("returns the exact version recorded on a past request", () => {
    const registry = new MultiplierRegistry([
      record({ version: 1, multiplier: 1.3, effectiveAt: JAN }),
      record({ version: 2, multiplier: 2.2, effectiveAt: FEB }),
    ]);

    expect(registry.atVersion("bosanda-sonnet", 1).multiplier).toBe(1.3);
    expect(registry.atVersion("bosanda-sonnet", 2).multiplier).toBe(2.2);
  });

  it("re-settling a January request after a February increase uses the January rate", () => {
    // This is the property §9 actually cares about: raising a multiplier must not
    // retroactively increase what an old request cost.
    const registry = new MultiplierRegistry([
      record({ version: 1, multiplier: 1.3, effectiveAt: JAN }),
      record({ version: 2, multiplier: 2.2, effectiveAt: FEB }),
    ]);

    const stampedVersion = registry.current(
      "bosanda-sonnet",
      new Date("2026-01-10T00:00:00Z"),
    ).version;

    // Later, in March, recompute that request's cost.
    const historical = registry.atVersion("bosanda-sonnet", stampedVersion);
    expect(weightedTokens(1_000_000, historical.multiplier)).toBe(1_300_000);

    // Whereas a request starting in March would cost the new rate.
    const currentNow = registry.current("bosanda-sonnet", MAR);
    expect(weightedTokens(1_000_000, currentNow.multiplier)).toBe(2_200_000);
  });

  it("fails loudly on an unknown version instead of falling back to current", () => {
    // Silently substituting the current multiplier would corrupt the commercial record,
    // so an unexplainable ledger row must be an error, not a guess.
    const registry = new MultiplierRegistry([record({ version: 1 })]);
    expect(() => registry.atVersion("bosanda-sonnet", 7)).toThrow(BosandaError);
    try {
      registry.atVersion("bosanda-sonnet", 7);
    } catch (error) {
      expect((error as BosandaError).code).toBe("internal_error");
    }
  });

  it("fails loudly on an unknown model", () => {
    const registry = new MultiplierRegistry([record()]);
    expect(() => registry.atVersion("nope", 1)).toThrow(BosandaError);
  });
});

describe("MultiplierRegistry construction", () => {
  it("rejects duplicate versions for one model", () => {
    expect(
      () => new MultiplierRegistry([record({ version: 1 }), record({ version: 1, multiplier: 2 })]),
    ).toThrow(/duplicate multiplier version/);
  });

  it("allows the same version number across different models", () => {
    expect(
      () =>
        new MultiplierRegistry([
          record({ model: "a", version: 1 }),
          record({ model: "b", version: 1 }),
        ]),
    ).not.toThrow();
  });

  it("rejects a non-positive or fractional version", () => {
    expect(() => new MultiplierRegistry([record({ version: 0 })])).toThrow(RangeError);
    expect(() => new MultiplierRegistry([record({ version: -1 })])).toThrow(RangeError);
    expect(() => new MultiplierRegistry([record({ version: 1.5 })])).toThrow(RangeError);
  });

  it("returns history ascending regardless of input order", () => {
    const registry = new MultiplierRegistry([
      record({ version: 3, effectiveAt: MAR }),
      record({ version: 1, effectiveAt: JAN }),
      record({ version: 2, effectiveAt: FEB }),
    ]);
    expect(registry.history("bosanda-sonnet").map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("reports an empty history for an unknown model", () => {
    expect(new MultiplierRegistry([]).history("nope")).toEqual([]);
  });

  it("lists configured models", () => {
    const registry = new MultiplierRegistry([record({ model: "a" }), record({ model: "b" })]);
    expect([...registry.models()].sort()).toEqual(["a", "b"]);
  });
});
