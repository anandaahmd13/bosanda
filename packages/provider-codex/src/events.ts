import { BosandaError, type CanonicalEvent, type FinishReason } from "@bosanda/protocol";
import type { CodexRuntimeEvent } from "./runtime.js";

export type ToolEventTracker = {
  nextIndex: number;
  byCallId: Map<string, number>;
};

export function createToolEventTracker(): ToolEventTracker {
  return { nextIndex: 0, byCallId: new Map() };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finishReason(value: unknown): FinishReason {
  if (value === "tool_use" || value === "max_tokens" || value === "refusal") return value;
  if (value === "interrupted" || value === "abort" || value === "cancelled") return "refusal";
  return "end_turn";
}

/**
 * Maps App Server notifications onto CanonicalEvent.
 * Unknown methods are ignored (compatibility telemetry is the adapter's job).
 */
export function toCanonicalEvents(
  event: CodexRuntimeEvent,
  model: string,
  tracker: ToolEventTracker = createToolEventTracker(),
): CanonicalEvent[] {
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
      return typeof params.delta === "string" && params.delta.length > 0
        ? [{ type: "text_delta", text: params.delta }]
        : [];

    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return typeof params.delta === "string" && params.delta.length > 0
        ? [{ type: "reasoning_delta", text: params.delta }]
        : [];

    case "item/toolCall/start":
    case "item/functionCall/start": {
      const callId = asString(params.callId) ?? asString(params.toolCallId) ?? asString(params.id);
      const name = asString(params.name) ?? asString(params.toolName);
      if (callId === null || name === null) {
        throw new BosandaError("upstream_incompatible", {
          internalDetail: "codex tool start missing callId or name",
        });
      }
      let index = tracker.byCallId.get(callId);
      if (index === undefined) {
        index = tracker.nextIndex++;
        tracker.byCallId.set(callId, index);
      }
      return [{ type: "tool_start", index, id: callId, name }];
    }

    case "item/toolCall/inputDelta":
    case "item/functionCall/inputDelta":
    case "item/toolCall/argumentsDelta": {
      const callId = asString(params.callId) ?? asString(params.toolCallId) ?? asString(params.id);
      const partial =
        asString(params.delta) ?? asString(params.partialJson) ?? asString(params.arguments) ?? "";
      if (callId === null || partial.length === 0) return [];
      let index = tracker.byCallId.get(callId);
      if (index === undefined) {
        index = tracker.nextIndex++;
        tracker.byCallId.set(callId, index);
      }
      return [{ type: "tool_input_delta", index, partialJson: partial }];
    }

    case "item/toolCall/complete":
    case "item/functionCall/complete":
    case "item/toolCall/end": {
      const callId = asString(params.callId) ?? asString(params.toolCallId) ?? asString(params.id);
      if (callId === null) return [];
      let index = tracker.byCallId.get(callId);
      if (index === undefined) {
        index = tracker.nextIndex++;
        tracker.byCallId.set(callId, index);
      }
      const events: CanonicalEvent[] = [];
      const args = params.arguments ?? params.input;
      if (typeof args === "string" && args.length > 0) {
        events.push({ type: "tool_input_delta", index, partialJson: args });
      } else if (args !== undefined && typeof args !== "string") {
        try {
          events.push({ type: "tool_input_delta", index, partialJson: JSON.stringify(args) });
        } catch {
          throw new BosandaError("upstream_incompatible", {
            internalDetail: "codex tool arguments are not JSON-serializable",
          });
        }
      }
      events.push({ type: "tool_stop", index });
      return events;
    }

    case "thread/tokenUsage/updated": {
      const usage = asRecord(params.last) ?? asRecord(params.usage) ?? params;
      const inputTokens =
        typeof usage["inputTokens"] === "number"
          ? usage["inputTokens"]
          : typeof usage["input_tokens"] === "number"
            ? usage["input_tokens"]
            : 0;
      const outputTokens =
        typeof usage["outputTokens"] === "number"
          ? usage["outputTokens"]
          : typeof usage["output_tokens"] === "number"
            ? usage["output_tokens"]
            : 0;
      const cachedTokens =
        typeof usage["cachedInputTokens"] === "number"
          ? usage["cachedInputTokens"]
          : typeof usage["cached_tokens"] === "number"
            ? usage["cached_tokens"]
            : undefined;
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
      return [{ type: "finish", reason: finishReason(params.reason ?? params.stopReason) }];

    case "turn/interrupted":
      return [{ type: "finish", reason: "refusal" }];

    case "turn/failed":
    case "error": {
      const reason = asString(params.reason) ?? asString(params.code) ?? "turn_failed";
      if (reason === "process_lost") {
        throw new BosandaError("upstream_incompatible", {
          internalDetail: "codex process lost during turn",
        });
      }
      throw new BosandaError("upstream_incompatible", {
        internalDetail: `codex turn failed: ${reason}`,
      });
    }

    default:
      return [];
  }
}
