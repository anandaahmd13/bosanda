/**
 * POST /v1/chat/completions -> CanonicalRequest (PLAN.md §8 "OpenAI-compatible
 * surface", §5 canonical protocol).
 *
 * Pure: no HTTP, no provider, no state. The gateway owns transport and auth.
 *
 * Three rules shape everything here:
 *
 *  1. The client's `model` string is NEVER trusted or interpreted. It is copied
 *     through verbatim for the model registry to resolve, so an unpublished or
 *     out-of-package model fails in ONE place with the right code (§9) instead of
 *     being silently normalized here.
 *  2. A parameter we recognise but cannot honour raises `unsupported_capability`
 *     (400) rather than being dropped. Silently ignoring `n: 4` would bill the
 *     caller for one completion while they believe they bought four.
 *  3. A shape we do not recognise at all raises `invalid_request` (400).
 *
 * `assertWithinLimits` runs after decoding and before returning, per the frozen
 * contract in @bosanda/protocol — so no oversized request reaches provider work.
 */

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
import { z } from "zod";

/**
 * These two carry an explicit `=> never` annotation on the DECLARATION, not just on
 * the arrow. TypeScript only applies never-returning-call narrowing to a `const`
 * whose type is annotated, so without it a caller after `invalid(...)` would still
 * see the pre-check type (e.g. `parsed.data` as possibly undefined).
 */
const invalid: (detail: string) => never = (detail) => {
  throw new BosandaError("invalid_request", { internalDetail: detail });
};

const unsupported: (detail: string) => never = (detail) => {
  throw new BosandaError("unsupported_capability", { internalDetail: detail });
};

/**
 * OpenAI accepts either a bare string or an array of typed parts for message
 * content. Parts we cannot serve (`image_url`, `input_audio`, `file`) are recognised
 * and rejected as unsupported rather than dropped, because dropping an image would
 * answer a question the user did not ask.
 */
const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const refusalPartSchema = z.object({
  type: z.literal("refusal"),
  refusal: z.string(),
});

const unsupportedPartSchema = z.object({
  type: z.enum(["image_url", "input_audio", "file", "video_url"]),
});

const contentPartSchema = z.union([textPartSchema, refusalPartSchema, unsupportedPartSchema]);

const contentSchema = z.union([z.string(), z.array(contentPartSchema)]);

/**
 * `function.arguments` is a JSON *string* on the wire, per OpenAI. It is parsed at
 * decode time so a malformed fragment fails as `invalid_request` here rather than
 * as an opaque upstream error later.
 */
const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().optional(),
  }),
});

const systemMessageSchema = z.object({
  role: z.enum(["system", "developer"]),
  content: contentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal("user"),
  content: contentSchema,
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  // Absent/null whenever the turn was purely tool calls.
  content: contentSchema.nullish(),
  refusal: z.string().nullish(),
  tool_calls: z.array(toolCallSchema).optional(),
  name: z.string().optional(),
});

const toolMessageSchema = z.object({
  role: z.enum(["tool", "function"]),
  content: contentSchema.nullish(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

const messageSchema = z.discriminatedUnion("role", [
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

const functionDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  parameters: z.record(z.string(), z.unknown()).nullish(),
  strict: z.boolean().nullish(),
});

const toolSchema = z.object({
  type: z.literal("function"),
  function: functionDefSchema,
});

const namedToolChoiceSchema = z.object({
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1) }),
});

const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required", "any"]),
  namedToolChoiceSchema,
]);

/**
 * `looseObject` keeps unrecognised keys instead of stripping them, so
 * `rejectUnsupported` below can see a parameter like `n` and refuse it. A strict
 * object would have thrown a zod error with the wrong code, and a stripping object
 * would have hidden it entirely.
 */
const bodySchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).nullish(),
  max_tokens: z.number().nullish(),
  max_completion_tokens: z.number().nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
  tools: z.array(toolSchema).nullish(),
  functions: z.array(functionDefSchema).nullish(),
  tool_choice: toolChoiceSchema.nullish(),
  function_call: z.union([z.enum(["auto", "none"]), z.object({ name: z.string() })]).nullish(),
  user: z.string().nullish(),
  n: z.number().nullish(),
  metadata: z.unknown().nullish(),
  store: z.boolean().nullish(),
});

/**
 * Recognised OpenAI parameters Bosanda cannot honour. Each would change the shape or
 * the price of the answer, so each is a 400 rather than a silent no-op.
 *
 * `n` is listed but special-cased below: `n: 1` is exactly what we do.
 */
const UNSUPPORTED_PARAMS = [
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
  "seed",
  "audio",
  "modalities",
  "prediction",
  "web_search_options",
  "parallel_tool_calls",
  "service_tier",
  "reasoning_effort",
] as const;

function rejectUnsupported(body: Record<string, unknown>): void {
  for (const key of UNSUPPORTED_PARAMS) {
    const value = body[key];
    if (value !== undefined && value !== null) {
      unsupported(`${key} is not supported`);
    }
  }

  // n > 1 would need multiple upstream generations and multiple choices in the
  // response; n < 1 is meaningless. Only the identity case is honoured.
  const n = body["n"];
  if (typeof n === "number" && n !== 1) {
    unsupported(`n must be 1, received ${n}`);
  }
}

/** Flatten OpenAI content (string | parts[]) to text, rejecting non-text parts. */
function contentToText(content: z.infer<typeof contentSchema>, where: string): string {
  if (typeof content === "string") return content;

  let text = "";
  for (const part of content) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    if (part.type === "refusal") {
      text += part.refusal;
      continue;
    }
    unsupported(`${where} contains an unsupported content part: ${part.type}`);
  }
  return text;
}

/**
 * Assistant `tool_calls` -> CanonicalContent. `arguments` is a JSON string on the
 * wire; canonical `tool_use.input` is the parsed value.
 *
 * An empty or whitespace-only string means "no arguments" and becomes `{}`, which is
 * what OpenAI clients emit for a zero-parameter tool. Anything else that fails to
 * parse is a client bug and is reported as such.
 */
function toolCallsToContent(
  toolCalls: readonly z.infer<typeof toolCallSchema>[],
): CanonicalContent[] {
  return toolCalls.map((call) => {
    const raw = call.function.arguments ?? "";
    let input: unknown = {};
    if (raw.trim().length > 0) {
      try {
        input = JSON.parse(raw);
      } catch {
        invalid(`tool_call ${call.id} has arguments that are not valid JSON`);
      }
    }
    return { type: "tool_use", id: call.id, name: call.function.name, input };
  });
}

/**
 * Map the OpenAI message list onto canonical messages.
 *
 * Two structural conversions matter:
 *
 *  - System/developer messages are hoisted out of the list into `system`, since
 *    canonical has a dedicated field and no "system" role. Several system messages
 *    concatenate in order rather than the last one winning, so no instruction is
 *    silently discarded.
 *  - A `tool` role message becomes a `tool_result` block on a USER message, because
 *    canonical only has user/assistant. Consecutive tool results collapse onto one
 *    user message, which is the shape providers expect for parallel tool calls.
 */
function mapMessages(parsed: readonly z.infer<typeof messageSchema>[]): {
  system: string | null;
  messages: CanonicalMessage[];
} {
  const systemParts: string[] = [];
  const messages: CanonicalMessage[] = [];

  const pushContent = (role: "user" | "assistant", content: CanonicalContent[]): void => {
    const last = messages.at(-1);
    if (last && last.role === role) {
      last.content.push(...content);
      return;
    }
    messages.push({ role, content });
  };

  for (const [index, message] of parsed.entries()) {
    switch (message.role) {
      case "system":
      case "developer": {
        systemParts.push(contentToText(message.content, `messages[${index}]`));
        break;
      }

      case "user": {
        const text = contentToText(message.content, `messages[${index}]`);
        pushContent("user", [{ type: "text", text }]);
        break;
      }

      case "assistant": {
        const content: CanonicalContent[] = [];
        const text =
          message.content === null || message.content === undefined
            ? ""
            : contentToText(message.content, `messages[${index}]`);
        if (text.length > 0) content.push({ type: "text", text });
        if (typeof message.refusal === "string" && message.refusal.length > 0) {
          content.push({ type: "text", text: message.refusal });
        }
        if (message.tool_calls && message.tool_calls.length > 0) {
          content.push(...toolCallsToContent(message.tool_calls));
        }
        // An assistant turn with no text and no tool calls carries no information;
        // dropping it keeps the history valid for providers that reject empty turns.
        if (content.length > 0) pushContent("assistant", content);
        break;
      }

      case "tool":
      case "function": {
        // The legacy `function` role has no tool_call_id and cannot be correlated to
        // a call. `tool` without an id is malformed.
        const toolUseId = message.tool_call_id;
        if (toolUseId === undefined || toolUseId.length === 0) {
          invalid(`messages[${index}] with role "${message.role}" requires tool_call_id`);
          break;
        }
        const text =
          message.content === null || message.content === undefined
            ? ""
            : contentToText(message.content, `messages[${index}]`);
        pushContent("user", [
          {
            type: "tool_result",
            toolUseId,
            content: text,
            // OpenAI has no error flag on a tool message. The client encodes failure
            // in the content, so we cannot infer it without guessing.
            isError: false,
          },
        ]);
        break;
      }
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : null, messages };
}

function mapTools(body: z.infer<typeof bodySchema>): CanonicalTool[] {
  // `tools` is current; `functions` is the deprecated spelling. Accepting both but
  // preferring `tools` matches OpenAI's own precedence.
  const defs: z.infer<typeof functionDefSchema>[] = body.tools
    ? body.tools.map((tool) => tool.function)
    : (body.functions ?? []);

  return defs.map((def) => ({
    name: def.name,
    description: def.description ?? null,
    // An absent schema means a no-argument tool. An empty object is the correct
    // JSON Schema for that, and providers reject a missing schema.
    inputSchema: def.parameters ?? { type: "object", properties: {} },
  }));
}

function mapToolChoice(body: z.infer<typeof bodySchema>): CanonicalToolChoice | null {
  const choice = body.tool_choice ?? body.function_call;
  if (choice === null || choice === undefined) return null;

  if (typeof choice === "string") {
    switch (choice) {
      case "auto":
        return { type: "auto" };
      case "none":
        return { type: "none" };
      // OpenAI's "required" and Anthropic's "any" both mean "call some tool".
      case "required":
      case "any":
        return { type: "any" };
    }
  }

  // Either { type: "function", function: { name } } or the legacy { name }.
  const name = "function" in choice ? choice.function.name : choice.name;
  if (name.length === 0) invalid("tool_choice names an empty tool");
  return { type: "tool", name };
}

/**
 * `max_completion_tokens` is the current spelling; `max_tokens` is deprecated but
 * still overwhelmingly what clients send. When both appear and disagree, that is a
 * contradiction we must not silently resolve.
 */
function mapMaxTokens(body: z.infer<typeof bodySchema>): number | null {
  const legacy = body.max_tokens ?? null;
  const current = body.max_completion_tokens ?? null;

  if (legacy !== null && current !== null && legacy !== current) {
    invalid(`max_tokens (${legacy}) and max_completion_tokens (${current}) disagree`);
  }
  // Range and integrality are enforced by assertWithinLimits.
  return current ?? legacy;
}

function mapStopSequences(body: z.infer<typeof bodySchema>): string[] {
  const stop = body.stop;
  if (stop === null || stop === undefined) return [];
  return typeof stop === "string" ? [stop] : [...stop];
}

export type DecodeOptions = {
  /** Correlation ID from the gateway. Generated when absent so the field is never empty. */
  requestId?: string;
};

/**
 * Decode an OpenAI chat-completions body into a CanonicalRequest.
 *
 * Throws BosandaError only: `invalid_request` for an unrecognised shape,
 * `unsupported_capability` for a recognised parameter we cannot honour. zod's own
 * error text is folded into `internalDetail` (operator-only) rather than returned to
 * the client, so a schema message can never leak request content.
 */
export function decodeChatCompletion(body: unknown, options: DecodeOptions = {}): CanonicalRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    invalid("request body must be a JSON object");
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first && first.path.length > 0 ? first.path.join(".") : "body";
    invalid(`${path}: ${first?.message ?? "failed validation"}`);
  }
  const data = parsed.data;

  rejectUnsupported(data);

  const { system, messages } = mapMessages(data.messages);

  const request: CanonicalRequest = {
    requestId: options.requestId ?? newRequestId(),
    surface: "openai",
    // Passed through verbatim: the registry resolves and authorizes it (§9).
    model: data.model,
    system,
    messages,
    tools: mapTools(data),
    toolChoice: mapToolChoice(data),
    stream: data.stream === true,
    maxTokens: mapMaxTokens(data),
    temperature: data.temperature ?? null,
    topP: data.top_p ?? null,
    stopSequences: mapStopSequences(data),
    // Usage in the stream is opt-in for OpenAI clients, and only meaningful while
    // streaming — the non-streaming body always carries usage.
    includeUsage: data.stream_options?.include_usage === true,
  };

  // Frozen contract: every surface decoder calls this before any provider work.
  assertWithinLimits(request);

  return request;
}
