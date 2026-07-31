/**
 * Model registry for the Kiro adapter (PLAN.md §9 "Model registry", §3 G1).
 *
 * Production reads models from PostgreSQL (`models` table, §14) so an operator
 * can stage and publish them. This file supplies the DEFAULT seed and the
 * public->upstream mapping the adapter needs when no database-backed catalog is
 * injected.
 *
 * Every entry ships `published: false` and `compatibilityStatus: "unknown"`,
 * matching the schema's `models_published_requires_passing` CHECK: nothing can be
 * published until §3's gate reports passing, and that gate has not been executed.
 * The multipliers are PLACEHOLDERS — §3 G1 lists "model-specific cost
 * multipliers" as evidence still to be gathered, so these must be replaced with
 * measured values before any pricing depends on them.
 */

import { BosandaError } from "@bosanda/protocol";
import type { ProviderModel } from "@bosanda/provider-core";

/** Bumped whenever this seed changes; recorded per §3 "Compatibility versioning". */
export const MODEL_CATALOG_VERSION = "kiro-models-1-draft";

const REGIONS = ["us-east-1"] as const;

/**
 * Seed catalog. `upstreamId` values are the identifiers the reference
 * architecture uses; §3 G1 must confirm them against live traffic.
 */
export const DEFAULT_KIRO_MODELS: readonly ProviderModel[] = Object.freeze([
  {
    publicId: "bosanda-sonnet-4",
    upstreamId: "CLAUDE_SONNET_4_20250514_V1_0",
    label: "Bosanda Sonnet 4",
    contextWindow: 200_000,
    multiplier: 1.3,
    multiplierVersion: 1,
    supportsTools: true,
    supportsReasoning: false,
    regions: [...REGIONS],
    published: false,
    compatibilityStatus: "unknown",
  },
  {
    publicId: "bosanda-sonnet-4-5",
    upstreamId: "CLAUDE_SONNET_4_5_20250929_V1_0",
    label: "Bosanda Sonnet 4.5",
    contextWindow: 200_000,
    multiplier: 1.3,
    multiplierVersion: 1,
    supportsTools: true,
    supportsReasoning: true,
    regions: [...REGIONS],
    published: false,
    compatibilityStatus: "unknown",
  },
  {
    publicId: "bosanda-haiku-4-5",
    upstreamId: "CLAUDE_HAIKU_4_5_20251001_V1_0",
    label: "Bosanda Haiku 4.5",
    contextWindow: 200_000,
    multiplier: 1.0,
    multiplierVersion: 1,
    supportsTools: true,
    supportsReasoning: false,
    regions: [...REGIONS],
    published: false,
    compatibilityStatus: "unknown",
  },
]);

/**
 * Resolves a PUBLIC model ID to its catalog entry.
 *
 * Raises `model_not_allowed` (403) for an unknown ID, matching the decision
 * recorded in docs/IMPLEMENTATION-STATUS.md: `model_unavailable` is named by §8
 * but is not in the frozen `ErrorCode` union, and that discrepancy is the owner's
 * to resolve — this adapter does not resolve it unilaterally.
 */
export function resolveModel(
  publicId: string,
  catalog: readonly ProviderModel[] = DEFAULT_KIRO_MODELS,
): ProviderModel {
  const model = catalog.find((entry) => entry.publicId === publicId);
  if (model === undefined) {
    throw new BosandaError("model_not_allowed", {
      internalDetail: `model "${publicId}" is not in the Kiro catalog`,
    });
  }
  return model;
}
