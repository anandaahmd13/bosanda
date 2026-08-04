import type { ProviderModel } from "@bosanda/provider-core";

const DEFAULT_CONTEXT_WINDOW = 128_000;

export function publicModelId(upstreamId: string): string {
  const safe = upstreamId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (safe.length === 0) throw new Error("Codex model id is empty");
  return `bosanda-codex-${safe}`;
}

export function mapCodexModel(raw: Record<string, unknown>): ProviderModel {
  const upstreamId =
    typeof raw.id === "string" ? raw.id : typeof raw.model === "string" ? raw.model : "";
  if (upstreamId.length === 0) throw new Error("Codex model response omitted id");
  const label =
    typeof raw.displayName === "string" && raw.displayName.length > 0
      ? raw.displayName
      : upstreamId;
  const contextWindow =
    typeof raw.modelContextWindow === "number" && raw.modelContextWindow > 0
      ? raw.modelContextWindow
      : DEFAULT_CONTEXT_WINDOW;
  return {
    publicId: publicModelId(upstreamId),
    upstreamId,
    label,
    contextWindow,
    multiplier: 1,
    multiplierVersion: 1,
    supportsTools: false,
    supportsReasoning: true,
    regions: ["global"],
    published: false,
    compatibilityStatus: "unknown",
  };
}
