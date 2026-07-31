/**
 * Model registry tests (PLAN.md §9 "Model registry", §3 G1, §14).
 *
 * The module is small, but two of its properties are launch-blocking and both
 * are the kind that a well-meaning edit breaks silently:
 *
 *  - NOTHING IS PUBLISHED. Every seed entry ships `published: false` /
 *    `compatibilityStatus: "unknown"` because §3's compatibility gate has NOT
 *    been executed. If someone flips a flag to make a staging environment work,
 *    an unverified model becomes purchasable. So the invariant is asserted over
 *    the whole catalog rather than per-entry, and it is asserted twice — once on
 *    the flags, once as the CHECK constraint's own rule (published implies
 *    passing), so adding a fourth model cannot skip it.
 *  - upstreamId NEVER REACHES A CLIENT. §9 keeps the upstream identifier
 *    internal. resolveModel's error message is the one place a lookup miss could
 *    echo it back, so the public message is checked for every upstream ID in the
 *    catalog.
 *
 * The multipliers are deliberately NOT asserted against specific numbers beyond
 * their bounds: §3 G1 lists them as evidence still to be gathered, and a test
 * pinning 1.3 would turn a placeholder into a fixed expectation that later reads
 * as intentional.
 */

import { describe, expect, it } from "vitest";
import { BosandaError, publicMessageForCode } from "@bosanda/protocol";
import type { ProviderModel } from "@bosanda/provider-core";
import { DEFAULT_KIRO_MODELS, MODEL_CATALOG_VERSION, resolveModel } from "../src/models.js";

describe("DEFAULT_KIRO_MODELS — the unpublished invariant (§3 G1, §14)", () => {
  it("ships no published model, because the compatibility gate has not run", () => {
    // Asserted over the whole catalog so a newly added entry is covered too.
    const published = DEFAULT_KIRO_MODELS.filter((model) => model.published);
    expect(published.map((model) => model.publicId)).toEqual([]);
  });

  it("reports no model as compatibility-passing", () => {
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(model.compatibilityStatus, model.publicId).toBe("unknown");
    }
  });

  it("satisfies models_published_requires_passing for every entry", () => {
    // The database CHECK expressed in code: publishing without passing evidence
    // is the failure this guards, whatever the current flag values happen to be.
    for (const model of DEFAULT_KIRO_MODELS) {
      if (model.published) {
        expect(model.compatibilityStatus, `${model.publicId} is published`).toBe("passing");
      }
    }
  });

  it("is frozen, so a caller cannot mutate the shared seed", () => {
    expect(Object.isFrozen(DEFAULT_KIRO_MODELS)).toBe(true);
    expect(() => {
      (DEFAULT_KIRO_MODELS as ProviderModel[]).push(DEFAULT_KIRO_MODELS[0]!);
    }).toThrow();
  });
});

describe("DEFAULT_KIRO_MODELS — catalog shape", () => {
  it("uses unique public IDs", () => {
    // A duplicate would make resolveModel silently prefer the first entry.
    const ids = DEFAULT_KIRO_MODELS.map((model) => model.publicId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses unique upstream IDs", () => {
    const ids = DEFAULT_KIRO_MODELS.map((model) => model.upstreamId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every public ID the bosanda- prefix and no vendor name", () => {
    // §9: the public catalog must not advertise which upstream serves it.
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(model.publicId, model.publicId).toMatch(/^bosanda-[a-z0-9-]+$/);
      expect(model.publicId.toLowerCase()).not.toContain("claude");
      expect(model.publicId.toLowerCase()).not.toContain("kiro");
      expect(model.publicId.toLowerCase()).not.toContain("anthropic");
      expect(model.publicId.toLowerCase()).not.toContain("aws");
    }
  });

  it("keeps the upstream ID out of the public label", () => {
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(model.label).not.toContain(model.upstreamId);
      expect(model.label.toLowerCase(), model.publicId).not.toContain("claude");
    }
  });

  it("carries a positive multiplier with a version, so §10 pricing is traceable", () => {
    // Bounds only: §3 G1 has not measured these, and pinning the values would
    // record a placeholder as an expectation.
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(model.multiplier, model.publicId).toBeGreaterThan(0);
      expect(Number.isFinite(model.multiplier)).toBe(true);
      expect(Number.isInteger(model.multiplierVersion)).toBe(true);
      expect(model.multiplierVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it("declares a positive integer context window", () => {
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(Number.isInteger(model.contextWindow), model.publicId).toBe(true);
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  it("lists at least one region per model", () => {
    // An empty region list makes a model unroutable while still appearing in
    // the catalog.
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(model.regions.length, model.publicId).toBeGreaterThan(0);
      for (const region of model.regions) expect(region).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
    }
  });

  it("gives each entry its own regions array", () => {
    // A shared array would let one model's region edit change every model.
    const arrays = DEFAULT_KIRO_MODELS.map((model) => model.regions);
    for (let i = 0; i < arrays.length; i += 1) {
      for (let j = i + 1; j < arrays.length; j += 1) {
        expect(arrays[i], `${i} and ${j} share an array`).not.toBe(arrays[j]);
      }
    }
  });

  it("pins a catalog version so §3 evidence can name what it tested", () => {
    expect(MODEL_CATALOG_VERSION).toMatch(/^kiro-models-\d+/);
    // Still a draft: the gate has not been executed against it.
    expect(MODEL_CATALOG_VERSION).toContain("draft");
  });
});

describe("resolveModel", () => {
  it("returns the catalog entry for a known public ID", () => {
    const model = resolveModel("bosanda-sonnet-4-5");
    expect(model.publicId).toBe("bosanda-sonnet-4-5");
    expect(model.upstreamId).toBe("CLAUDE_SONNET_4_5_20250929_V1_0");
  });

  it("resolves every seeded ID", () => {
    for (const seeded of DEFAULT_KIRO_MODELS) {
      expect(resolveModel(seeded.publicId)).toBe(seeded);
    }
  });

  it("raises model_not_allowed for an unknown ID", () => {
    // §8 names `model_unavailable`, which is not in the frozen ErrorCode union.
    // This pins the actual behaviour so the open discrepancy stays visible
    // rather than being papered over by a loose assertion.
    try {
      resolveModel("bosanda-does-not-exist");
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).code).toBe("model_not_allowed");
      expect((error as BosandaError).status).toBe(403);
    }
  });

  it("does not resolve an upstream ID passed as if it were public", () => {
    // Accepting the upstream ID would leak the mapping to anyone who guessed it.
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(() => resolveModel(model.upstreamId), model.upstreamId).toThrow(BosandaError);
    }
  });

  it("rejects an unknown ID from an injected catalog too", () => {
    const catalog: ProviderModel[] = [{ ...DEFAULT_KIRO_MODELS[0]!, publicId: "only-one" }];
    expect(resolveModel("only-one", catalog).publicId).toBe("only-one");
    expect(() => resolveModel("bosanda-sonnet-4", catalog)).toThrow(BosandaError);
  });

  it("rejects everything when the injected catalog is empty", () => {
    // The database-backed catalog can legitimately be empty before an operator
    // publishes anything; it must fail closed, not fall back to the seed.
    expect(() => resolveModel("bosanda-sonnet-4", [])).toThrow(BosandaError);
  });

  it("matches exactly, with no case folding or trimming", () => {
    for (const near of [
      "BOSANDA-SONNET-4",
      "Bosanda-Sonnet-4",
      " bosanda-sonnet-4",
      "bosanda-sonnet-4 ",
      "bosanda-sonnet-4\n",
      "bosanda-sonnet",
      "bosanda-sonnet-40",
    ]) {
      expect(() => resolveModel(near), JSON.stringify(near)).toThrow(BosandaError);
    }
  });

  it("is not confused by inherited or prototype keys", () => {
    for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(() => resolveModel(hostile), hostile).toThrow(BosandaError);
    }
  });

  it("puts no upstream ID in the public message (§9)", () => {
    // The public message is generic by construction, but this asserts it against
    // every upstream ID rather than trusting that construction.
    const error = captureError(() => resolveModel("bosanda-nope"));
    expect(error.publicMessage).toBe(publicMessageForCode("model_not_allowed"));
    for (const model of DEFAULT_KIRO_MODELS) {
      expect(error.publicMessage).not.toContain(model.upstreamId);
    }
    expect(error.publicMessage.toLowerCase()).not.toContain("claude");
    expect(error.publicMessage.toLowerCase()).not.toContain("kiro");
  });

  it("names the requested ID in internal detail only", () => {
    // The operator needs to know what was asked for; the client does not.
    const error = captureError(() => resolveModel("bosanda-nope"));
    expect(error.internalDetail).toContain("bosanda-nope");
    expect(error.publicMessage).not.toContain("bosanda-nope");
  });

  it("does not echo a hostile requested ID into the public message", () => {
    // Reflecting client input in a client-visible string is how an injection
    // reaches a dashboard or a log viewer.
    const hostile = '"><script>alert(1)</script>';
    const error = captureError(() => resolveModel(hostile));
    expect(error.publicMessage).not.toContain("script");
  });

  it("returns the shared entry rather than a copy, so no field is dropped", () => {
    // A spread here would silently omit a field added to ProviderModel later.
    const model = resolveModel("bosanda-haiku-4-5");
    expect(model).toBe(DEFAULT_KIRO_MODELS.find((entry) => entry.publicId === "bosanda-haiku-4-5"));
  });
});

function captureError(run: () => unknown): BosandaError {
  try {
    run();
  } catch (error) {
    if (error instanceof BosandaError) return error;
    throw error;
  }
  throw new Error("expected a BosandaError");
}
