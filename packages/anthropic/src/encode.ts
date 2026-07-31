/**
 * CanonicalEvent[] -> the Anthropic wire format (PLAN.md §8 "Anthropic stream
 * order", §5 canonical protocol).
 *
 * Event order, exactly as Anthropic specifies it and Claude Code expects it:
 *
 *   message_start
 *   ( content_block_start content_block_delta* content_block_stop )*
 *   message_delta          <- carries stop_reason and usage
 *   message_stop
 *
 * `ping` may appear anywhere after `message_start` and never affects indices.
 * There is no `[DONE]` sentinel on this surface (§8).
 *
 * The interesting problem is index bookkeeping. Canonical text and reasoning
 * deltas carry no index — a run of them *is* one block — while canonical tool
 * events carry the adapter's tool ordinal, which is NOT the Anthropic content
 * block index (text blocks occupy indices too). So this encoder assigns block
 * indices itself and maps tool ordinal -> block index.
 */

import {
  BosandaError,
  type CanonicalEvent,
  type CanonicalUsage,
  type FinishReason,
} from "@bosanda/protocol";
import { messageId as newMessageId } from "@bosanda/shared";
import { formatSseStream, pingFrame, type SseFrame } from "./sse.js";

/** Anthropic's `stop_reason` vocabulary. Every FinishReason maps 1:1. */
export type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use" | "refusal";

const STOP_REASON: Record<FinishReason, AnthropicStopReason> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

export function anthropicStopReason(reason: FinishReason): AnthropicStopReason {
  return STOP_REASON[reason];
}

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
};

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type AnthropicMessage = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
};

/**
 * CanonicalUsage -> Anthropic usage.
 *
 * The canonical `estimated` flag is deliberately NOT serialized: Anthropic's
 * usage object has no such field and this surface's job is fidelity. Whether a
 * count was estimated is recorded on the internal usage row by @bosanda/metering
 * (PLAN.md §10), which is where it belongs.
 */
function toWireUsage(usage: CanonicalUsage): AnthropicUsage {
  const wire: AnthropicUsage = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedTokens !== undefined) {
    wire.cache_read_input_tokens = usage.cachedTokens;
  }
  return wire;
}

export type EncoderOptions = {
  /** Stable message ID for the whole response. Generated when omitted. */
  messageId?: string;
  /**
   * Input tokens known before generation starts (the gateway already computes
   * this for quota admission), reported in `message_start`. A later canonical
   * `usage` event supersedes it in `message_delta`.
   */
  inputTokens?: number;
};

type OpenBlock =
  | { kind: "text"; index: number }
  | { kind: "thinking"; index: number }
  | { kind: "tool_use"; index: number; id: string; name: string };

const frame = (type: string, payload: Record<string, unknown>): SseFrame => ({
  event: type,
  data: JSON.stringify({ type, ...payload }),
});

/**
 * Stateful streaming encoder. Feed canonical events in order; collect frames.
 *
 * Stateful by necessity — block indices, the open block, and accumulated tool
 * JSON all span events — so one instance encodes exactly one response.
 */
export class AnthropicStreamEncoder {
  readonly messageId: string;

  private model = "";
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private open: OpenBlock | null = null;
  /** Canonical tool ordinal -> Anthropic content block index. */
  private readonly toolIndexes = new Map<number, number>();
  private usage: CanonicalUsage | null = null;
  private stopReason: AnthropicStopReason | null = null;
  private readonly initialInputTokens: number;

  /** Accumulated per block, for the non-streaming Message projection only. */
  private readonly blocks: AnthropicContentBlock[] = [];
  private readonly toolJson = new Map<number, string>();

  constructor(options: EncoderOptions = {}) {
    this.messageId = options.messageId ?? newMessageId("anthropic");
    this.initialInputTokens = options.inputTokens ?? 0;
  }

  /** Keep-alive. Safe at any point after message_start; does not touch indices. */
  ping(): SseFrame {
    return pingFrame();
  }

  /** Frames for one canonical event, in order. */
  encode(event: CanonicalEvent): SseFrame[] {
    switch (event.type) {
      case "message_start":
        return this.onMessageStart(event.id, event.model);

      case "text_delta":
        return this.onTextDelta(event.text);

      case "reasoning_delta":
        return this.onReasoningDelta(event.text);

      case "tool_start":
        return this.onToolStart(event.index, event.id, event.name);

      case "tool_input_delta":
        return this.onToolInputDelta(event.index, event.partialJson);

      case "tool_stop":
        return this.onToolStop(event.index);

      case "usage":
        // Usage is reported in message_delta, so nothing goes on the wire here.
        this.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cachedTokens === undefined ? {} : { cachedTokens: event.cachedTokens }),
          estimated: event.estimated,
        };
        return [];

      case "finish":
        return this.onFinish(event.reason);
    }
  }

  /** Trailing frames if the adapter ended without a `finish` event. */
  finalize(): SseFrame[] {
    if (this.finished) return [];
    // A stream that stops without a reason is treated as a completed turn
    // rather than left unterminated, so the client is never hung.
    return this.onFinish("end_turn");
  }

  private onMessageStart(id: string, model: string): SseFrame[] {
    if (this.started) {
      throw new BosandaError("internal_error", {
        internalDetail: "anthropic encoder received a second message_start",
      });
    }
    this.started = true;
    this.model = model;
    void id; // The client-facing ID is ours, not the adapter's.

    return [
      frame("message_start", {
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.initialInputTokens, output_tokens: 0 },
        },
      }),
    ];
  }

  private requireStarted(what: string): void {
    if (!this.started) {
      throw new BosandaError("internal_error", {
        internalDetail: `anthropic encoder received ${what} before message_start`,
      });
    }
  }

  /** Closes whatever block is open, unless it is already the wanted kind. */
  private closeUnless(kind: OpenBlock["kind"]): SseFrame[] {
    if (this.open === null || this.open.kind === kind) return [];
    return this.closeOpen();
  }

  private closeOpen(): SseFrame[] {
    const open = this.open;
    if (open === null) return [];
    this.open = null;
    return [frame("content_block_stop", { index: open.index })];
  }

  private onTextDelta(text: string): SseFrame[] {
    this.requireStarted("text_delta");
    const frames = this.closeUnless("text");

    if (this.open === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.open = { kind: "text", index };
      this.blocks.push({ type: "text", text: "" });
      frames.push(
        frame("content_block_start", { index, content_block: { type: "text", text: "" } }),
      );
    }

    this.appendText("text", text);
    frames.push(
      // text_delta, NOT input_json_delta — the two are distinguished by the
      // delta's own `type` and a client routes on it.
      frame("content_block_delta", {
        index: this.openIndex(),
        delta: { type: "text_delta", text },
      }),
    );
    return frames;
  }

  private onReasoningDelta(text: string): SseFrame[] {
    this.requireStarted("reasoning_delta");
    const frames = this.closeUnless("thinking");

    if (this.open === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.open = { kind: "thinking", index };
      this.blocks.push({ type: "thinking", thinking: "" });
      frames.push(
        frame("content_block_start", {
          index,
          content_block: { type: "thinking", thinking: "" },
        }),
      );
    }

    this.appendText("thinking", text);
    frames.push(
      frame("content_block_delta", {
        index: this.openIndex(),
        delta: { type: "thinking_delta", thinking: text },
      }),
    );
    return frames;
  }

  private onToolStart(toolIndex: number, id: string, name: string): SseFrame[] {
    this.requireStarted("tool_start");
    const frames = this.closeOpen();

    const index = this.nextIndex;
    this.nextIndex += 1;
    this.toolIndexes.set(toolIndex, index);
    this.toolJson.set(toolIndex, "");
    this.open = { kind: "tool_use", index, id, name };
    this.blocks.push({ type: "tool_use", id, name, input: {} });

    frames.push(
      frame("content_block_start", {
        index,
        // Anthropic starts a tool block with an empty input object; the
        // arguments arrive as input_json_delta fragments.
        content_block: { type: "tool_use", id, name, input: {} },
      }),
    );
    return frames;
  }

  private onToolInputDelta(toolIndex: number, partialJson: string): SseFrame[] {
    this.requireStarted("tool_input_delta");
    const index = this.blockIndexForTool(toolIndex, "tool_input_delta");

    this.toolJson.set(toolIndex, (this.toolJson.get(toolIndex) ?? "") + partialJson);

    return [
      frame("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: partialJson },
      }),
    ];
  }

  private onToolStop(toolIndex: number): SseFrame[] {
    this.requireStarted("tool_stop");
    const index = this.blockIndexForTool(toolIndex, "tool_stop");

    if (this.open !== null && this.open.index === index) this.open = null;
    return [frame("content_block_stop", { index })];
  }

  private onFinish(reason: FinishReason): SseFrame[] {
    this.requireStarted("finish");
    if (this.finished) return [];

    const frames = this.closeOpen();
    this.finished = true;
    this.stopReason = anthropicStopReason(reason);

    const usage: AnthropicUsage =
      this.usage === null
        ? { input_tokens: this.initialInputTokens, output_tokens: 0 }
        : toWireUsage(this.usage);

    frames.push(
      frame("message_delta", {
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage,
      }),
      frame("message_stop", {}),
    );
    return frames;
  }

  private openIndex(): number {
    const open = this.open;
    if (open === null) {
      throw new BosandaError("internal_error", {
        internalDetail: "anthropic encoder lost its open content block",
      });
    }
    return open.index;
  }

  private blockIndexForTool(toolIndex: number, what: string): number {
    const index = this.toolIndexes.get(toolIndex);
    if (index === undefined) {
      throw new BosandaError("upstream_incompatible", {
        internalDetail: `${what} for unknown tool index ${toolIndex} (no preceding tool_start)`,
      });
    }
    return index;
  }

  private appendText(kind: "text" | "thinking", text: string): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last === undefined) return;
    if (kind === "text" && last.type === "text") last.text += text;
    else if (kind === "thinking" && last.type === "thinking") last.thinking += text;
  }

  /**
   * The non-streaming Message object. Call after feeding every event.
   *
   * Tool arguments are parsed here rather than per fragment, because a single
   * fragment is not valid JSON on its own.
   */
  toMessage(): AnthropicMessage {
    const content: AnthropicContentBlock[] = [];
    let toolOrdinal = 0;

    for (const block of this.blocks) {
      if (block.type !== "tool_use") {
        content.push(block);
        continue;
      }
      const raw = this.toolJson.get(this.toolOrdinalForBlock(toolOrdinal)) ?? "";
      toolOrdinal += 1;
      content.push({ ...block, input: parseToolInput(raw, block.name) });
    }

    return {
      id: this.messageId,
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: this.stopReason,
      stop_sequence: null,
      usage:
        this.usage === null
          ? { input_tokens: this.initialInputTokens, output_tokens: 0 }
          : toWireUsage(this.usage),
    };
  }

  /**
   * Canonical tool ordinals are whatever the adapter used and need not start at
   * 0 or be contiguous, so they are resolved by encounter order.
   */
  private toolOrdinalForBlock(ordinal: number): number {
    const keys = [...this.toolIndexes.keys()];
    return keys[ordinal] ?? ordinal;
  }
}

/**
 * A tool's accumulated `partial_json`, parsed.
 *
 * An empty accumulation means a no-argument tool call, which is legitimate.
 * Anything else that will not parse is an upstream framing failure, classified
 * `upstream_incompatible` (502) so the scheduler may fail over. The unparseable
 * text is NOT included in the detail — it is model output (§16).
 */
function parseToolInput(raw: string, toolName: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BosandaError("upstream_incompatible", {
      internalDetail: `tool "${toolName}" produced unparseable input JSON (${raw.length} chars)`,
    });
  }
}

/** Convenience: the whole frame sequence for a finished canonical event list. */
export function encodeStream(
  events: readonly CanonicalEvent[],
  options: EncoderOptions = {},
): SseFrame[] {
  const encoder = new AnthropicStreamEncoder(options);
  const frames: SseFrame[] = [];
  for (const event of events) {
    frames.push(...encoder.encode(event));
  }
  frames.push(...encoder.finalize());
  return frames;
}

/** The same sequence as SSE wire text. */
export function encodeStreamText(
  events: readonly CanonicalEvent[],
  options: EncoderOptions = {},
): string {
  return formatSseStream(encodeStream(events, options));
}

/** Non-streaming `POST /v1/messages` response body. */
export function encodeMessage(
  events: readonly CanonicalEvent[],
  options: EncoderOptions = {},
): AnthropicMessage {
  const encoder = new AnthropicStreamEncoder(options);
  for (const event of events) {
    encoder.encode(event);
  }
  encoder.finalize();
  return encoder.toMessage();
}
