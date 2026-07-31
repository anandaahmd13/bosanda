/**
 * Anthropic `POST /v1/messages` -> CanonicalRequest (PLAN.md §8 surface, §5 canonical).
 *
 * This is a pure codec: no HTTP, no provider, no state. The gateway owns
 * authentication, model authorization and quota; this module only proves the
 * body is a well-formed Anthropic request and projects it onto the frozen
 * canonical shape.
 *
 * Two rules shape the design:
 *
 *  1. Fidelity over leniency for *structure*, leniency for *decoration*. Claude
 *     Code sends fields Bosanda does not model (`cache_control`, `metadata`,
 *     `container`, …). Rejecting them would break the client for no safety gain,
 *     so object schemas are loose and unmodelled keys are dropped. But a block
 *     whose *semantics* we cannot honour (a `document`, a server-side tool) is
 *     rejected loudly with `unsupported_capability` — silently ignoring it would
 *     answer a different question than the one asked.
 *
 *  2. Nothing here logs or returns prompt text. Every `internalDetail` below
 *     names a JSON path and a type, never content (PLAN.md §12/§16).
 */

import { z } from "zod";
import {
  BosandaError,
  assertWithinLimits,
  type CanonicalContent,
  type CanonicalMessage,
  type CanonicalRequest,
  type CanonicalTool,
  type CanonicalToolChoice,
} from "@bosanda/protocol";
import { requestId as newRequestId } from "@bosanda/shared";

/**
 * `anthropic-version` values Bosanda accepts. Anthropic dates its API; an
 * unknown date means the client expects semantics we have not verified, so it is
 * rejected rather than guessed at (§8: the header is required and recorded).
 */
export const SUPPORTED_ANTHROPIC_VERSIONS: readonly string[] = [
  "2023-06-01",
  "2023-01-01",
] as const;

export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/** Header bag as a web/Node server exposes it; lookup is case-insensitive. */
export type HeaderLike =
  Headers | Record<string, string | string[] | undefined> | ReadonlyMap<string, string>;

function headerValue(headers: HeaderLike, name: string): string | null {
  const wanted = name.toLowerCase();

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(wanted);
  }
  if (headers instanceof Map) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === wanted) return value;
    }
    return null;
  }

  const record = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = record[key];
    if (value === undefined) return null;
    // Node lower-cases and may array-ify repeated headers; first wins.
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

/**
 * Validates `anthropic-version` (PLAN.md §8: required and recorded). Returns the
 * version so the caller can record it on the usage row.
 */
export function requireAnthropicVersion(headers: HeaderLike): string {
  const value = headerValue(headers, "anthropic-version");

  if (value === null || value.trim().length === 0) {
    throw new BosandaError("invalid_request", {
      internalDetail: "missing required header: anthropic-version",
    });
  }

  const version = value.trim();
  if (!SUPPORTED_ANTHROPIC_VERSIONS.includes(version)) {
    // The header is a fixed vocabulary, not user prose, so echoing it is safe
    // and it is the single most useful field for debugging a client mismatch.
    throw new BosandaError("invalid_request", {
      internalDetail: `unsupported anthropic-version: ${version}`,
    });
  }
  return version;
}

// --- Wire schemas ---------------------------------------------------------
//
// `looseObject` keeps unmodelled decoration (cache_control, citations, …)
// instead of failing; unknown *block types* are still caught, because the
// discriminator itself is validated.

const textBlock = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

const toolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  // `.optional()` is load-bearing: in zod 4 a bare `z.unknown()` still requires
  // the key to be present. A no-argument tool call omits `input` entirely.
  input: z.unknown().optional(),
});

const thinkingBlock = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
});

/**
 * `tool_result.content` is either a plain string or a block array. The block
 * array form is what Claude Code actually sends, and each element may itself be
 * text or an image. Inner blocks stay loose for the same reason as outer ones —
 * see `contentBlock`.
 */
const toolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]).optional(),
  is_error: z.boolean().optional(),
});

/**
 * A content block is validated in TWO stages, and the split is deliberate.
 *
 * Stage 1 (here) checks only that the block is an object carrying a string
 * `type`. Stage 2 (`decodeBlock`) parses the schema for that specific kind.
 *
 * A single union of the per-kind schemas would conflate two very different
 * failures: `{type:"text", text:42}` (a known kind, malformed -> 400
 * invalid_request) and `{type:"document"}` (a kind we cannot honour -> 400
 * unsupported_capability). In a union both simply "fail to match", and the
 * fallback member would swallow the first case and mislabel it as unsupported.
 * Splitting the stages keeps each failure in its own vocabulary.
 */
const contentBlock = z.looseObject({ type: z.string() });

const message = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(contentBlock)]),
});

const tool = z.looseObject({
  name: z.string().min(1),
  description: z.string().nullish(),
  input_schema: z.looseObject({ type: z.string().optional() }).optional(),
});

const toolChoice = z.union([
  z.looseObject({ type: z.literal("auto") }),
  z.looseObject({ type: z.literal("any") }),
  z.looseObject({ type: z.literal("none") }),
  z.looseObject({ type: z.literal("tool"), name: z.string().min(1) }),
]);

export const messagesRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(message),
  system: z.union([z.string(), z.array(contentBlock)]).nullish(),
  max_tokens: z.number().int().positive().nullish(),
  metadata: z.looseObject({}).nullish(),
  stop_sequences: z.array(z.string()).nullish(),
  stream: z.boolean().nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  top_k: z.number().int().nullish(),
  tools: z.array(tool).nullish(),
  tool_choice: toolChoice.nullish(),
  thinking: z.looseObject({ type: z.string() }).nullish(),
});

export type AnthropicMessagesRequest = z.infer<typeof messagesRequestSchema>;

type WireBlock = z.infer<typeof contentBlock>;

function parseBody(body: unknown): AnthropicMessagesRequest {
  const result = messagesRequestSchema.safeParse(body);
  if (result.success) return result.data;

  // Report the path and expectation only. Zod's `message` can echo a received
  // value, so it is deliberately not forwarded (§16).
  const issue = result.error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join(".") : "<root>";
  const code = issue?.code ?? "invalid";
  throw new BosandaError("invalid_request", {
    internalDetail: `malformed /v1/messages body at ${path}: ${code}`,
  });
}

const unsupported = (detail: string): never => {
  throw new BosandaError("unsupported_capability", { internalDetail: detail });
};

const malformed = (detail: string): never => {
  throw new BosandaError("invalid_request", { internalDetail: detail });
};

/**
 * Stage-2 parse for one block kind (see `contentBlock`).
 *
 * A known kind that fails its own schema is `invalid_request`, never
 * `unsupported_capability` — the client asked for something we DO support and
 * simply sent it wrong, and conflating the two sends a misleading error.
 * The zod path is appended so the failing field is identifiable; no received
 * value is echoed (§16).
 */
function parseBlock<T>(schema: z.ZodType<T>, block: WireBlock, path: string, kind: string): T {
  const parsed = schema.safeParse(block);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  const field = issue && issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
  return malformed(`${path}${field} is a malformed ${kind} block: ${issue?.code ?? "invalid"}`);
}

/**
 * Server-side tool kinds Anthropic defines that Bosanda must refuse outright.
 *
 * PLAN.md §16: tools execute CLIENT-SIDE only. The server never executes a tool,
 * never reads a filesystem on a client's behalf and never injects one. Accepting
 * a server-executed tool would silently promise execution that will not happen.
 */
const SERVER_SIDE_TOOL_TYPES = new Set([
  "computer",
  "bash",
  "text_editor",
  "code_execution",
  "web_search",
  "web_fetch",
  "mcp",
]);

function toolTypeOf(candidate: z.infer<typeof tool>): string | null {
  const value = (candidate as Record<string, unknown>)["type"];
  return typeof value === "string" ? value : null;
}

/** Flattens block-array content down to the plain text canonical `system` holds. */
function systemToText(system: string | readonly WireBlock[]): string {
  if (typeof system === "string") return system;

  const parts: string[] = [];
  for (const [index, block] of system.entries()) {
    const text = (block as { text?: unknown }).text;
    if (block.type === "text" && typeof text === "string") {
      parts.push(text);
      continue;
    }
    unsupported(`system[${index}] block type "${block.type}" is not supported (text only)`);
  }
  // Anthropic renders a system block array as concatenated text.
  return parts.join("\n\n");
}

function toolResultText(block: z.infer<typeof toolResultBlock>): string {
  const { content } = block;
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const inner of content) {
    const text = (inner as { text?: unknown }).text;
    if (inner.type === "text" && typeof text === "string") {
      parts.push(text);
      continue;
    }
    // An image inside a tool result is real (a screenshot from a client-side
    // tool) but the canonical protocol carries text only. A placeholder keeps
    // the turn structurally valid instead of dropping the result silently, and
    // keeps the tool_use_id paired with *something* so the upstream turn is
    // well-formed.
    parts.push("[image]");
  }
  return parts.join("\n");
}

function decodeBlock(block: WireBlock, path: string): CanonicalContent | null {
  switch (block.type) {
    case "text": {
      const parsed = parseBlock(textBlock, block, path, "text");
      return { type: "text", text: parsed.text };
    }

    case "image":
      // Kiro's surface is text-only today (PLAN.md §6). Refusing is the honest
      // answer: an accepted-then-ignored image changes the user's question.
      return unsupported(`${path} image blocks are not supported by this endpoint`);

    case "tool_use": {
      const parsed = parseBlock(toolUseBlock, block, path, "tool_use");
      return {
        type: "tool_use",
        id: parsed.id,
        name: parsed.name,
        // A no-argument tool call is legitimate; canonical carries {} for it.
        input: parsed.input ?? {},
      };
    }

    case "tool_result": {
      const parsed = parseBlock(toolResultBlock, block, path, "tool_result");
      return {
        type: "tool_result",
        toolUseId: parsed.tool_use_id,
        content: toolResultText(parsed),
        isError: parsed.is_error ?? false,
      };
    }

    case "thinking": {
      const parsed = parseBlock(thinkingBlock, block, path, "thinking");
      return { type: "reasoning", text: parsed.thinking };
    }

    case "redacted_thinking":
      // Opaque ciphertext from a previous turn. It cannot be replayed upstream
      // and carries no text we may reveal, so it is dropped, not rejected —
      // rejecting would break multi-turn extended thinking outright.
      return null;

    default:
      return unsupported(`${path} unsupported content block type "${block.type}"`);
  }
}

function decodeMessage(wire: z.infer<typeof message>, index: number): CanonicalMessage {
  const path = `messages[${index}]`;

  if (typeof wire.content === "string") {
    return { role: wire.role, content: [{ type: "text", text: wire.content }] };
  }

  const content: CanonicalContent[] = [];
  for (const [blockIndex, block] of wire.content.entries()) {
    const decoded = decodeBlock(block, `${path}.content[${blockIndex}]`);
    if (decoded !== null) content.push(decoded);
  }
  return { role: wire.role, content };
}

function decodeTool(wire: z.infer<typeof tool>, index: number): CanonicalTool {
  const declaredType = toolTypeOf(wire);
  if (declaredType !== null && declaredType !== "custom") {
    const family = declaredType.split("_")[0] ?? declaredType;
    if (SERVER_SIDE_TOOL_TYPES.has(declaredType) || SERVER_SIDE_TOOL_TYPES.has(family)) {
      return unsupported(
        `tools[${index}] "${declaredType}" is a server-executed tool; tools run client-side only`,
      );
    }
  }

  const schema = wire.input_schema;
  if (schema === undefined) {
    throw new BosandaError("invalid_request", {
      internalDetail: `tools[${index}] is missing input_schema`,
    });
  }

  return {
    name: wire.name,
    description: wire.description ?? null,
    inputSchema: schema as Record<string, unknown>,
  };
}

function decodeToolChoice(
  wire: z.infer<typeof toolChoice> | null | undefined,
): CanonicalToolChoice | null {
  if (wire === null || wire === undefined) return null;
  switch (wire.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: wire.name };
  }
}

export type DecodeOptions = {
  /** Correlation ID; generated when the gateway has not already assigned one. */
  requestId?: string;
};

type InternalDecodeOptions = DecodeOptions & {
  /**
   * Anthropic requires `max_tokens` on /v1/messages but not on count_tokens, so
   * the shared decoder is told which endpoint it is serving.
   */
  requireMaxTokens: boolean;
};

/**
 * Decodes a validated Anthropic body into a CanonicalRequest.
 *
 * `assertWithinLimits` runs before returning, so a hostile body is rejected
 * before any provider work (PLAN.md §16, and the frozen contract's requirement
 * that every surface decoder calls it).
 */
function decodeRequest(
  body: unknown,
  headers: HeaderLike,
  options: InternalDecodeOptions,
): CanonicalRequest {
  requireAnthropicVersion(headers);

  const wire = parseBody(body);

  if (options.requireMaxTokens && (wire.max_tokens === null || wire.max_tokens === undefined)) {
    throw new BosandaError("invalid_request", {
      internalDetail: "max_tokens is required on /v1/messages",
    });
  }

  const messages = wire.messages.map(decodeMessage);
  const tools = (wire.tools ?? []).map(decodeTool);

  const request: CanonicalRequest = {
    requestId: options.requestId ?? newRequestId(),
    surface: "anthropic",
    model: wire.model,
    system: wire.system === null || wire.system === undefined ? null : systemToText(wire.system),
    messages,
    tools,
    toolChoice: decodeToolChoice(wire.tool_choice),
    stream: wire.stream ?? false,
    maxTokens: wire.max_tokens ?? null,
    temperature: wire.temperature ?? null,
    topP: wire.top_p ?? null,
    stopSequences: wire.stop_sequences ?? [],
    // Anthropic always reports usage in message_delta, unlike OpenAI's opt-in.
    includeUsage: true,
  };

  assertWithinLimits(request);
  return request;
}

/**
 * Decodes a validated Anthropic body into a CanonicalRequest.
 *
 * `assertWithinLimits` runs before returning, so a hostile body is rejected
 * before any provider work (PLAN.md §16, and the frozen contract's requirement
 * that every surface decoder calls it).
 */
export function decodeMessagesRequest(
  body: unknown,
  headers: HeaderLike,
  options: DecodeOptions = {},
): CanonicalRequest {
  return decodeRequest(body, headers, { ...options, requireMaxTokens: true });
}

/**
 * Decode for `/v1/messages/count_tokens`, which takes the same body shape minus
 * `max_tokens` — there is nothing to generate, so no output budget is needed.
 */
export function decodeCountTokensRequest(
  body: unknown,
  headers: HeaderLike,
  options: DecodeOptions = {},
): CanonicalRequest {
  return decodeRequest(body, headers, { ...options, requireMaxTokens: false });
}
