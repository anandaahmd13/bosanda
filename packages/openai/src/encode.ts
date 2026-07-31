/**
 * CanonicalEvent[] -> OpenAI wire format (PLAN.md §8 "OpenAI-compatible surface",
 * §5 canonical protocol).
 *
 * Two outputs from one event stream:
 *
 *  - `OpenAIStreamEncoder` / `encodeStream` produce `data: ` SSE frames of
 *    `chat.completion.chunk` objects, terminated by `data: [DONE]`.
 *  - `encodeCompletion` produces the single non-streaming `chat.completion` object.
 *
 * Pure: no HTTP, no provider, no state beyond one response's own accumulation.
 *
 * PLAN.md §8 requires "a stable completion ID ... throughout one response", so the ID
 * is minted once per encoder via @bosanda/shared and reused on every chunk. The
 * upstream `message_start.id` is deliberately NOT echoed — it is a provider-side
 * identifier and clients have no business seeing it.
 *
 * `created` comes from an injectable Clock; business logic never calls Date.now().
 */

import type { CanonicalEvent, CanonicalUsage, FinishReason } from "@bosanda/protocol";
import { type Clock, messageId, systemClock } from "@bosanda/shared";

/** OpenAI's finish_reason vocabulary. */
export type OpenAIFinishReason = "stop" | "tool_calls" | "length" | "content_filter";

/**
 * FinishReason -> finish_reason. `refusal` maps to `content_filter` because that is
 * the only OpenAI value meaning "the model declined"; there is no `refusal` value in
 * the chat-completions schema.
 */
const FINISH_REASON: Record<FinishReason, OpenAIFinishReason> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

export function openAIFinishReason(reason: FinishReason): OpenAIFinishReason {
  return FINISH_REASON[reason];
}

export type OpenAIToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments?: string };
};

export type OpenAIDelta = {
  role?: "assistant";
  content?: string | null;
  /**
   * Reasoning text. NOT part of OpenAI's published schema — it is the de-facto
   * field name used across compatible servers. Reasoning is kept out of `content`
   * so a client that ignores this field still sees exactly the answer text.
   */
  reasoning_content?: string;
  tool_calls?: OpenAIToolCallDelta[];
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
};

export type OpenAIChunkChoice = {
  index: number;
  delta: OpenAIDelta;
  finish_reason: OpenAIFinishReason | null;
  logprobs: null;
};

export type OpenAIChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChunkChoice[];
  usage?: OpenAIUsage;
};

export type OpenAIToolCall = {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIMessage = {
  role: "assistant";
  /** null when the turn produced only tool calls, matching OpenAI. */
  content: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
};

export type OpenAICompletionChoice = {
  index: number;
  message: OpenAIMessage;
  finish_reason: OpenAIFinishReason;
  logprobs: null;
};

export type OpenAICompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAICompletionChoice[];
  usage: OpenAIUsage;
};

export type EncodeOptions = {
  /** Public model ID the client asked for. Never an upstream provider ID. */
  model: string;
  /** Emit the trailing usage chunk (from `stream_options.include_usage`). */
  includeUsage?: boolean;
  clock?: Clock;
  /** Override the completion ID. For deterministic tests only. */
  id?: string;
};

/**
 * `estimated` is intentionally dropped on the wire: OpenAI's usage object has no
 * such field, and inventing one risks breaking strict client parsers. The flag still
 * travels with the ledger row, which is where §10 requires it.
 */
function encodeUsage(usage: CanonicalUsage): OpenAIUsage {
  const encoded: OpenAIUsage = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
  if (usage.cachedTokens !== undefined) {
    encoded.prompt_tokens_details = { cached_tokens: usage.cachedTokens };
  }
  return encoded;
}

/** One SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The terminator required by PLAN.md §8. */
export const DONE_FRAME = "data: [DONE]\n\n";

/**
 * Incremental encoder for one streaming response.
 *
 * `chunk(event)` returns zero or more SSE frames — zero is normal, since
 * `tool_stop` has no OpenAI equivalent and `usage` is buffered until the end.
 * Call `finish()` once the canonical stream is exhausted to get the trailing usage
 * chunk (when requested) and `[DONE]`.
 */
export class OpenAIStreamEncoder {
  private readonly id: string;
  private readonly model: string;
  private readonly includeUsage: boolean;
  private readonly clock: Clock;

  private roleSent = false;
  private usage: CanonicalUsage | null = null;
  private doneSent = false;

  constructor(options: EncodeOptions) {
    this.id = options.id ?? messageId("openai");
    this.model = options.model;
    this.includeUsage = options.includeUsage === true;
    this.clock = options.clock ?? systemClock;
  }

  /** Unix seconds, stamped once per chunk from the injected clock. */
  private created(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  private chunkFrame(delta: OpenAIDelta, finishReason: OpenAIFinishReason | null = null): string {
    const chunk: OpenAIChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created(),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    };
    return frame(chunk);
  }

  /**
   * The role appears on the first chunk only. Later chunks carry content alone,
   * which is what OpenAI does and what SDKs assume when they accumulate deltas.
   */
  private withRole(delta: OpenAIDelta): OpenAIDelta {
    if (this.roleSent) return delta;
    this.roleSent = true;
    return { role: "assistant", ...delta };
  }

  encode(event: CanonicalEvent): string[] {
    switch (event.type) {
      case "message_start":
        // Opening chunk: role and an empty content string, no payload yet.
        return [this.chunkFrame(this.withRole({ content: "" }))];

      case "text_delta":
        return [this.chunkFrame(this.withRole({ content: event.text }))];

      case "reasoning_delta":
        return [this.chunkFrame(this.withRole({ reasoning_content: event.text }))];

      case "tool_start":
        return [
          this.chunkFrame(
            this.withRole({
              tool_calls: [
                {
                  index: event.index,
                  id: event.id,
                  type: "function",
                  function: { name: event.name, arguments: "" },
                },
              ],
            }),
          ),
        ];

      case "tool_input_delta":
        // Argument fragments stream verbatim; concatenating them client-side
        // reproduces the exact JSON the model emitted.
        return [
          this.chunkFrame({
            tool_calls: [{ index: event.index, function: { arguments: event.partialJson } }],
          }),
        ];

      case "tool_stop":
        // No OpenAI equivalent: a tool call ends when the next index starts or the
        // turn finishes. Emitting anything here would be inventing wire format.
        return [];

      case "usage":
        this.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cachedTokens === undefined ? {} : { cachedTokens: event.cachedTokens }),
          estimated: event.estimated,
        };
        return [];

      case "finish":
        return [this.chunkFrame({}, FINISH_REASON[event.reason])];
    }
  }

  /**
   * Trailing frames: the usage chunk when `include_usage` was requested, then
   * `[DONE]`. The usage chunk carries an empty `choices` array, per OpenAI.
   * Idempotent — calling it twice will not emit a second `[DONE]`.
   */
  finish(): string[] {
    if (this.doneSent) return [];
    this.doneSent = true;

    const frames: string[] = [];
    if (this.includeUsage && this.usage !== null) {
      const chunk: OpenAIChunk = {
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created(),
        model: this.model,
        choices: [],
        usage: encodeUsage(this.usage),
      };
      frames.push(frame(chunk));
    }
    frames.push(DONE_FRAME);
    return frames;
  }
}

/** Encode a complete canonical event list to SSE frames, `[DONE]` included. */
export function encodeStream(events: readonly CanonicalEvent[], options: EncodeOptions): string[] {
  const encoder = new OpenAIStreamEncoder(options);
  const frames: string[] = [];
  for (const event of events) {
    frames.push(...encoder.encode(event));
  }
  frames.push(...encoder.finish());
  return frames;
}

/**
 * Non-streaming `chat.completion`.
 *
 * Tool-call argument fragments are joined in arrival order per index, so the result
 * is the same JSON a streaming client would have reassembled.
 *
 * `usage` is always present here (unlike the stream, where it is opt-in), because the
 * OpenAI non-streaming schema requires it. With no usage event, zeros are reported
 * rather than the field being omitted.
 */
export function encodeCompletion(
  events: readonly CanonicalEvent[],
  options: EncodeOptions,
): OpenAICompletion {
  const clock = options.clock ?? systemClock;
  const id = options.id ?? messageId("openai");

  let text = "";
  let reasoning = "";
  let finishReason: OpenAIFinishReason = "stop";
  let usage: CanonicalUsage | null = null;

  // Keyed by canonical tool index so out-of-order fragments still land correctly.
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  for (const event of events) {
    switch (event.type) {
      case "message_start":
        break;
      case "text_delta":
        text += event.text;
        break;
      case "reasoning_delta":
        reasoning += event.text;
        break;
      case "tool_start":
        toolCalls.set(event.index, { id: event.id, name: event.name, args: "" });
        break;
      case "tool_input_delta": {
        const existing = toolCalls.get(event.index);
        if (existing) existing.args += event.partialJson;
        break;
      }
      case "tool_stop":
        break;
      case "usage":
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cachedTokens === undefined ? {} : { cachedTokens: event.cachedTokens }),
          estimated: event.estimated,
        };
        break;
      case "finish":
        finishReason = FINISH_REASON[event.reason];
        break;
    }
  }

  const message: OpenAIMessage = {
    role: "assistant",
    // OpenAI reports null, not "", when the turn was purely tool calls.
    content: text.length > 0 || toolCalls.size === 0 ? text : null,
  };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        index,
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.args },
      }));
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(clock.now().getTime() / 1000),
    model: options.model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: encodeUsage(usage ?? { inputTokens: 0, outputTokens: 0, estimated: true }),
  };
}
