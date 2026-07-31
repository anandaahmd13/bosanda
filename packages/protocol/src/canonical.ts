/**
 * Canonical, provider-neutral protocol (PLAN.md §5).
 *
 * OpenAI and Anthropic requests decode INTO these types; provider adapters emit
 * CanonicalEvent, which is encoded back into the caller's protocol.
 *
 * Hard rule: no client-specific serialization may leak into a provider adapter,
 * and no provider-specific field may leak into these types.
 */

export type Surface = "openai" | "anthropic";

export type CanonicalContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export type CanonicalMessage = {
  role: "user" | "assistant";
  content: CanonicalContent[];
};

export type CanonicalTool = {
  name: string;
  description: string | null;
  /** JSON Schema object describing the tool input. */
  inputSchema: Record<string, unknown>;
};

export type CanonicalToolChoice =
  { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string };

export type CanonicalRequest = {
  requestId: string;
  surface: Surface;
  /** Public Bosanda model ID, never an upstream provider ID. */
  model: string;
  system: string | null;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  toolChoice: CanonicalToolChoice | null;
  stream: boolean;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  stopSequences: string[];
  includeUsage: boolean;
};

export type FinishReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export type CanonicalUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** false only when upstream reported complete authoritative usage. */
  estimated: boolean;
};

export type CanonicalEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | { type: "tool_stop"; index: number }
  | ({ type: "usage" } & CanonicalUsage)
  | { type: "finish"; reason: FinishReason };

export type CanonicalEventType = CanonicalEvent["type"];
