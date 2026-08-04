import type { CanonicalEvent } from "@bosanda/protocol";
import type { CodexRuntimeEvent } from "./runtime.js";

export function toCanonicalEvents(event: CodexRuntimeEvent, model: string): CanonicalEvent[] {
  const params = event.params ?? {};
  switch (event.method) {
    case "turn/started":
      return [
        {
          type: "message_start",
          id: typeof params.turnId === "string" ? params.turnId : "codex-turn",
          model,
        },
      ];
    case "item/agentMessage/delta":
      return typeof params.delta === "string" ? [{ type: "text_delta", text: params.delta }] : [];
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return typeof params.delta === "string"
        ? [{ type: "reasoning_delta", text: params.delta }]
        : [];
    case "thread/tokenUsage/updated": {
      const usage = params.last as Record<string, unknown> | undefined;
      if (!usage) return [];
      const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
      const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
      const cachedTokens =
        typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : undefined;
      return [
        {
          type: "usage",
          inputTokens,
          outputTokens,
          ...(cachedTokens === undefined ? {} : { cachedTokens }),
          estimated: false,
        },
      ];
    }
    case "turn/completed":
      return [{ type: "finish", reason: "end_turn" }];
    case "turn/interrupted":
      return [{ type: "finish", reason: "refusal" }];
    default:
      return [];
  }
}
