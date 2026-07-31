/**
 * ProviderModel -> /v1/models list and retrieve shapes (PLAN.md §8, §9).
 *
 * The negative assertions matter most: internal cost and operations data
 * (upstream ID, multiplier, regions, compatibility status) must never appear in a
 * client response, per the frozen `ProviderModel` contract and §16.
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import type { ProviderModel } from "@bosanda/provider-core";
import { OWNED_BY, encodeModel, encodeModelList, encodeModelRetrieve } from "@bosanda/openai";
import { fixedClock } from "@bosanda/shared";

const CLOCK = fixedClock("2026-03-01T00:00:00.000Z");
const CREATED = 1772323200;
const options = { clock: CLOCK };

/** A full registry row, including the internal fields that must not be published. */
function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    publicId: "bosanda-sonnet",
    upstreamId: "CLAUDE_SONNET_4_5_INTERNAL",
    label: "Bosanda Sonnet",
    contextWindow: 200_000,
    multiplier: 1.25,
    multiplierVersion: 3,
    supportsTools: true,
    supportsReasoning: true,
    regions: ["ap-southeast-1", "us-east-1"],
    published: true,
    compatibilityStatus: "passing",
    ...overrides,
  };
}

describe("encodeModel", () => {
  it("encodes the client-visible model object", () => {
    expect(encodeModel(model(), options)).toEqual({
      id: "bosanda-sonnet",
      object: "model",
      created: CREATED,
      owned_by: OWNED_BY,
      context_window: 200_000,
      supports_tools: true,
      supports_reasoning: true,
      label: "Bosanda Sonnet",
    });
  });

  it("publishes the public ID, never the upstream ID", () => {
    const encoded = encodeModel(model(), options);
    expect(encoded.id).toBe("bosanda-sonnet");
    expect(JSON.stringify(encoded)).not.toContain("CLAUDE_SONNET_4_5_INTERNAL");
  });

  it("omits every internal cost and operations field", () => {
    const encoded = encodeModel(model(), options);
    const keys = Object.keys(encoded);
    for (const internal of [
      "upstreamId",
      "upstream_id",
      "multiplier",
      "multiplierVersion",
      "multiplier_version",
      "regions",
      "compatibilityStatus",
      "compatibility_status",
      "published",
    ]) {
      expect(keys).not.toContain(internal);
    }
    const json = JSON.stringify(encoded);
    expect(json).not.toContain("1.25");
    expect(json).not.toContain("ap-southeast-1");
    expect(json).not.toContain("passing");
  });

  it("reports owned_by as bosanda", () => {
    expect(encodeModel(model(), options).owned_by).toBe("bosanda");
  });

  it("stamps created from the injected clock", () => {
    const encoded = encodeModel(model(), { clock: fixedClock("2020-01-01T00:00:00.000Z") });
    expect(encoded.created).toBe(1577836800);
  });

  it("carries capability flags through", () => {
    const encoded = encodeModel(model({ supportsTools: false, supportsReasoning: false }), options);
    expect(encoded.supports_tools).toBe(false);
    expect(encoded.supports_reasoning).toBe(false);
  });
});

describe("encodeModelList", () => {
  it("returns an object: list envelope", () => {
    const list = encodeModelList([model()], options);
    expect(list.object).toBe("list");
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.id).toBe("bosanda-sonnet");
  });

  it("encodes an empty registry as an empty list, not an error", () => {
    expect(encodeModelList([], options)).toEqual({ object: "list", data: [] });
  });

  it("sorts by public ID so insertion order does not leak", () => {
    const list = encodeModelList(
      [
        model({ publicId: "bosanda-sonnet" }),
        model({ publicId: "bosanda-haiku" }),
        model({ publicId: "bosanda-opus" }),
      ],
      options,
    );
    expect(list.data.map((m) => m.id)).toEqual(["bosanda-haiku", "bosanda-opus", "bosanda-sonnet"]);
  });

  it("is stable across calls", () => {
    const models = [model({ publicId: "b" }), model({ publicId: "a" })];
    expect(encodeModelList(models, options)).toEqual(encodeModelList(models, options));
  });

  it("does not mutate the caller's array", () => {
    const models = [model({ publicId: "z" }), model({ publicId: "a" })];
    encodeModelList(models, options);
    expect(models.map((m) => m.publicId)).toEqual(["z", "a"]);
  });

  it("encodes exactly the list it is handed, doing no visibility filtering", () => {
    // Kill switches (§3) and package scope (§9) decide visibility upstream of
    // this encoder; it must not second-guess them.
    const list = encodeModelList(
      [model({ published: false, compatibilityStatus: "failing" })],
      options,
    );
    expect(list.data).toHaveLength(1);
  });

  it("leaks no internal field for any model in the list", () => {
    const json = JSON.stringify(
      encodeModelList([model({ publicId: "a" }), model({ publicId: "b" })], options),
    );
    expect(json).not.toContain("CLAUDE_SONNET_4_5_INTERNAL");
    expect(json).not.toContain("us-east-1");
    expect(json).not.toContain("multiplier");
  });
});

describe("encodeModelRetrieve", () => {
  const models = [model({ publicId: "bosanda-sonnet" }), model({ publicId: "bosanda-haiku" })];

  it("returns the single model object", () => {
    const found = encodeModelRetrieve(models, "bosanda-haiku", options);
    expect(found.id).toBe("bosanda-haiku");
    expect(found.object).toBe("model");
  });

  it("raises not_found for an ID outside the visible set", () => {
    try {
      encodeModelRetrieve(models, "bosanda-opus", options);
      throw new Error("expected not_found");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      const bosanda = error as BosandaError;
      expect(bosanda.code).toBe("not_found");
      expect(bosanda.status).toBe(404);
    }
  });

  it("cannot be used to distinguish hidden from nonexistent models", () => {
    // Same code and same public message either way, so /v1/models/{id} is not a
    // way to enumerate unpublished models.
    const hidden = (() => {
      try {
        encodeModelRetrieve([], "bosanda-sonnet", options);
      } catch (error) {
        return error as BosandaError;
      }
      throw new Error("expected a throw");
    })();
    const missing = (() => {
      try {
        encodeModelRetrieve(models, "totally-made-up", options);
      } catch (error) {
        return error as BosandaError;
      }
      throw new Error("expected a throw");
    })();

    expect(hidden.code).toBe(missing.code);
    expect(hidden.publicMessage).toBe(missing.publicMessage);
  });

  it("matches the public ID exactly, never the upstream ID", () => {
    // Looking a model up by its upstream ID must not resolve.
    expect(() => encodeModelRetrieve(models, "CLAUDE_SONNET_4_5_INTERNAL", options)).toThrow(
      BosandaError,
    );
  });

  it("is case-sensitive on the public ID", () => {
    expect(() => encodeModelRetrieve(models, "BOSANDA-SONNET", options)).toThrow(BosandaError);
  });
});
