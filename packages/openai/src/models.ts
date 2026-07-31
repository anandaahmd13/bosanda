/**
 * Model metadata -> the OpenAI `/v1/models` list and `/v1/models/{id}` retrieve
 * shapes (PLAN.md §8 "OpenAI-compatible surface", §9 model registry).
 *
 * SECURITY (PLAN.md §16, and the frozen `ProviderModel` comment "upstream provider
 * model ID — never surfaced to clients"): only `publicId` and client-relevant
 * capability metadata are encoded. `upstreamId`, `multiplier`, `multiplierVersion`,
 * `regions`, and `compatibilityStatus` are internal cost/operations data and are
 * never written to a client response.
 *
 * Visibility filtering is NOT done here. Whether a model may appear at all is decided
 * by `isModelPubliclyVisible` (kill switches, §3) plus package scope (§9); this module
 * encodes exactly the list it is handed.
 */

import { BosandaError } from "@bosanda/protocol";
import type { ProviderModel } from "@bosanda/provider-core";
import { type Clock, systemClock } from "@bosanda/shared";

/**
 * The fields this encoder reads. Structurally satisfied by the frozen `ProviderModel`,
 * so callers pass registry rows straight through, but narrowed to a `Pick` so adding a
 * field to `ProviderModel` can never silently start publishing it.
 */
export type OpenAIModelInput = Pick<
  ProviderModel,
  "publicId" | "label" | "contextWindow" | "supportsTools" | "supportsReasoning"
>;

export type OpenAIModel = {
  id: string;
  object: "model";
  /** Unix seconds. OpenAI clients only require presence, not accuracy. */
  created: number;
  owned_by: string;
  /**
   * Non-standard additive fields. OpenAI does not define these on the model object,
   * but they are the metadata §9 says the registry holds and clients routinely want.
   * Extra keys are ignored by every OpenAI SDK.
   */
  context_window: number;
  supports_tools: boolean;
  supports_reasoning: boolean;
  label: string;
};

export type OpenAIModelList = {
  object: "list";
  data: OpenAIModel[];
};

/** `owned_by` value on every model. Bosanda resells its own public IDs (§9). */
export const OWNED_BY = "bosanda";

export type EncodeModelOptions = {
  clock?: Clock;
};

export function encodeModel(
  model: OpenAIModelInput,
  options: EncodeModelOptions = {},
): OpenAIModel {
  const clock = options.clock ?? systemClock;
  return {
    id: model.publicId,
    object: "model",
    created: Math.floor(clock.now().getTime() / 1000),
    owned_by: OWNED_BY,
    context_window: model.contextWindow,
    supports_tools: model.supportsTools,
    supports_reasoning: model.supportsReasoning,
    label: model.label,
  };
}

/**
 * `GET /v1/models`. Sorted by public ID so the listing is stable across calls and
 * does not leak registry insertion order.
 */
export function encodeModelList(
  models: readonly OpenAIModelInput[],
  options: EncodeModelOptions = {},
): OpenAIModelList {
  return {
    object: "list",
    data: [...models]
      .sort((a, b) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0))
      .map((model) => encodeModel(model, options)),
  };
}

/**
 * `GET /v1/models/{id}`. Raises `not_found` (404) when the ID is not in the visible
 * set — the same code whether the model does not exist or is merely hidden, so this
 * endpoint cannot be used to enumerate unpublished models.
 */
export function encodeModelRetrieve(
  models: readonly OpenAIModelInput[],
  id: string,
  options: EncodeModelOptions = {},
): OpenAIModel {
  const found = models.find((model) => model.publicId === id);
  if (found === undefined) {
    throw new BosandaError("not_found", { internalDetail: `model ${id} is not visible` });
  }
  return encodeModel(found, options);
}
