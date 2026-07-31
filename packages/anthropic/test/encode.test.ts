import { describe, expect, it } from "vitest";
import { BosandaError, type CanonicalEvent, type FinishReason } from "@bosanda/protocol";
import {
  AnthropicStreamEncoder,
  anthropicStopReason,
  encodeMessage,
  encodeStream,
  encodeStreamText,
  formatSse,
  type SseFrame,
} from "@bosanda/anthropic";

const ID = "msg_fixed";
const opts = { messageId: ID };

/** ["event name", parsed data] per frame — the shape assertions read against. */
function pairs(frames: readonly SseFrame[]): Array<[string, unknown]> {
  return frames.map((frame) => [frame.event, JSON.parse(frame.data)]);
}

function eventNames(frames: readonly SseFrame[]): string[] {
  return frames.map((frame) => frame.event);
}

const start: CanonicalEvent = { type: "message_start", id: "upstream-1", model: "bosanda-sonnet" };

describe("SSE framing (§8)", () => {
  it("emits both an event: and a data: line, terminated by a blank line", () => {
    expect(formatSse({ event: "ping", data: '{"type":"ping"}' })).toBe(
      'event: ping\ndata: {"type":"ping"}\n\n',
    );
  });

  it("every frame in a real stream carries both lines", () => {
    const text = encodeStreamText(
      [start, { type: "text_delta", text: "hi" }, { type: "finish", reason: "end_turn" }],
      opts,
    );
    const frames = text.trimEnd().split("\n\n");
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).toMatch(/^event: /);
      expect(frame).toContain("\ndata: ");
    }
  });

  it("never emits a [DONE] sentinel: that is the OpenAI surface's marker", () => {
    const text = encodeStreamText(
      [start, { type: "text_delta", text: "hi" }, { type: "finish", reason: "end_turn" }],
      opts,
    );
    expect(text).not.toContain("[DONE]");
  });

  it("splits a multi-line payload across data: lines rather than truncating", () => {
    // JSON never contains a raw newline, so this is belt-and-braces on framing.
    expect(formatSse({ event: "x", data: "a\nb" })).toBe("event: x\ndata: a\ndata: b\n\n");
  });
});

describe("full streaming sequence, asserted event by event (§8)", () => {
  const events: CanonicalEvent[] = [
    start,
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
    { type: "usage", inputTokens: 12, outputTokens: 3, estimated: false },
    { type: "finish", reason: "end_turn" },
  ];

  it("produces exactly the documented order", () => {
    expect(eventNames(encodeStream(events, opts))).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("carries the right payload in every frame", () => {
    expect(pairs(encodeStream(events, opts))).toEqual([
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: ID,
            type: "message",
            role: "assistant",
            model: "bosanda-sonnet",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 12, output_tokens: 3 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
  });

  it("reports known input tokens in message_start before generation", () => {
    const frames = encodeStream(events, { ...opts, inputTokens: 12 });
    const first = JSON.parse(frames[0]?.data ?? "{}");
    expect(first.message.usage).toEqual({ input_tokens: 12, output_tokens: 0 });
  });

  it("keeps a run of text deltas inside ONE block", () => {
    const frames = encodeStream(events, opts);
    expect(frames.filter((f) => f.event === "content_block_start")).toHaveLength(1);
    for (const [, data] of pairs(frames).filter(([name]) => name.startsWith("content_block"))) {
      expect((data as { index: number }).index).toBe(0);
    }
  });
});

describe("block indices advance across a two-block turn", () => {
  const events: CanonicalEvent[] = [
    start,
    { type: "text_delta", text: "Let me look." },
    { type: "tool_start", index: 0, id: "toolu_1", name: "read_file" },
    { type: "tool_input_delta", index: 0, partialJson: '{"path"' },
    { type: "tool_input_delta", index: 0, partialJson: ':"a.ts"}' },
    { type: "tool_stop", index: 0 },
    { type: "finish", reason: "tool_use" },
  ];

  it("closes the text block before opening the tool block", () => {
    expect(eventNames(encodeStream(events, opts))).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("uses index 0 for the text block and index 1 for the tool block", () => {
    const indexed = pairs(encodeStream(events, opts))
      .filter(([name]) => name.startsWith("content_block"))
      .map(([name, data]) => [name, (data as { index: number }).index]);

    expect(indexed).toEqual([
      ["content_block_start", 0],
      ["content_block_delta", 0],
      ["content_block_stop", 0],
      ["content_block_start", 1],
      ["content_block_delta", 1],
      ["content_block_delta", 1],
      ["content_block_stop", 1],
    ]);
  });

  it("starts a tool block with an empty input object and its id and name", () => {
    const frames = encodeStream(events, opts);
    const toolStart = frames.filter((f) => f.event === "content_block_start")[1];
    expect(JSON.parse(toolStart?.data ?? "{}")).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
    });
  });

  it("distinguishes input_json_delta from text_delta", () => {
    const deltas = pairs(encodeStream(events, opts))
      .filter(([name]) => name === "content_block_delta")
      .map(([, data]) => (data as { delta: { type: string } }).delta);

    expect(deltas).toEqual([
      { type: "text_delta", text: "Let me look." },
      { type: "input_json_delta", partial_json: '{"path"' },
      { type: "input_json_delta", partial_json: ':"a.ts"}' },
    ]);
  });

  it("indexes three tool blocks 0,1,2 when there is no leading text", () => {
    const frames = encodeStream(
      [
        start,
        { type: "tool_start", index: 0, id: "t0", name: "a" },
        { type: "tool_stop", index: 0 },
        { type: "tool_start", index: 1, id: "t1", name: "b" },
        { type: "tool_stop", index: 1 },
        { type: "tool_start", index: 2, id: "t2", name: "c" },
        { type: "tool_stop", index: 2 },
        { type: "finish", reason: "tool_use" },
      ],
      opts,
    );
    const starts = pairs(frames)
      .filter(([name]) => name === "content_block_start")
      .map(([, data]) => (data as { index: number }).index);
    expect(starts).toEqual([0, 1, 2]);
  });

  it("maps a non-zero canonical tool ordinal onto the right block index", () => {
    // An adapter may number tools from 1, or non-contiguously; the Anthropic
    // block index is ours, not the adapter's.
    const frames = encodeStream(
      [
        start,
        { type: "text_delta", text: "x" },
        { type: "tool_start", index: 7, id: "t7", name: "seven" },
        { type: "tool_input_delta", index: 7, partialJson: "{}" },
        { type: "tool_stop", index: 7 },
        { type: "finish", reason: "tool_use" },
      ],
      opts,
    );
    const toolFrames = pairs(frames).filter(
      ([name, data]) => name.startsWith("content_block") && (data as { index: number }).index === 1,
    );
    expect(toolFrames).toHaveLength(3);
  });
});

describe("reasoning blocks (canonical carries them, §5)", () => {
  it("emits a thinking block with thinking_delta, then a separate text block", () => {
    const frames = encodeStream(
      [
        start,
        { type: "reasoning_delta", text: "considering" },
        { type: "reasoning_delta", text: " options" },
        { type: "text_delta", text: "Answer." },
        { type: "finish", reason: "end_turn" },
      ],
      opts,
    );

    expect(eventNames(frames)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const blockStarts = pairs(frames)
      .filter(([name]) => name === "content_block_start")
      .map(([, data]) => data as { index: number; content_block: unknown });
    expect(blockStarts[0]).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    expect(blockStarts[1]).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    });

    const firstDelta = pairs(frames).filter(([name]) => name === "content_block_delta")[0];
    expect((firstDelta?.[1] as { delta: unknown }).delta).toEqual({
      type: "thinking_delta",
      thinking: "considering",
    });
  });
});

describe("stop_reason for every FinishReason (§5)", () => {
  const reasons: FinishReason[] = ["end_turn", "tool_use", "max_tokens", "refusal"];

  it.each(reasons)("maps %s onto the Anthropic name", (reason) => {
    expect(anthropicStopReason(reason)).toBe(reason);
  });

  it.each(reasons)("carries %s in message_delta", (reason) => {
    const frames = encodeStream(
      [start, { type: "text_delta", text: "x" }, { type: "finish", reason }],
      opts,
    );
    const delta = frames.find((f) => f.event === "message_delta");
    expect(JSON.parse(delta?.data ?? "{}").delta).toEqual({
      stop_reason: reason,
      stop_sequence: null,
    });
  });

  it("covers the whole union: every FinishReason has a mapping", () => {
    // Guards against a FinishReason being added without a stop_reason.
    const mapped = new Set(reasons.map((r) => anthropicStopReason(r)));
    expect(mapped.size).toBe(reasons.length);
  });
});

describe("usage in message_delta", () => {
  it("passes cachedTokens through as cache_read_input_tokens", () => {
    const frames = encodeStream(
      [
        start,
        { type: "text_delta", text: "x" },
        { type: "usage", inputTokens: 10, outputTokens: 2, cachedTokens: 7, estimated: false },
        { type: "finish", reason: "end_turn" },
      ],
      opts,
    );
    const delta = frames.find((f) => f.event === "message_delta");
    expect(JSON.parse(delta?.data ?? "{}").usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 7,
    });
  });

  it("omits the cache field when the adapter reported none", () => {
    const frames = encodeStream(
      [
        start,
        { type: "usage", inputTokens: 1, outputTokens: 1, estimated: true },
        { type: "finish", reason: "end_turn" },
      ],
      opts,
    );
    const usage = JSON.parse(frames.find((f) => f.event === "message_delta")?.data ?? "{}").usage;
    expect(usage).toEqual({ input_tokens: 1, output_tokens: 1 });
    expect("cache_read_input_tokens" in usage).toBe(false);
  });

  it("does NOT leak the internal `estimated` flag onto the wire", () => {
    // Anthropic's usage object has no such field; it lives on the internal
    // usage row instead (§10).
    const text = encodeStreamText(
      [
        start,
        { type: "usage", inputTokens: 1, outputTokens: 1, estimated: true },
        { type: "finish", reason: "end_turn" },
      ],
      opts,
    );
    expect(text).not.toContain("estimated");
  });

  it("emits no frame of its own for a usage event", () => {
    const encoder = new AnthropicStreamEncoder(opts);
    encoder.encode(start);
    expect(
      encoder.encode({ type: "usage", inputTokens: 1, outputTokens: 1, estimated: true }),
    ).toEqual([]);
  });
});

describe("ping handling", () => {
  it("is a fully-formed typed frame, not a bare comment", () => {
    const encoder = new AnthropicStreamEncoder(opts);
    expect(encoder.ping()).toEqual({ event: "ping", data: '{"type":"ping"}' });
    expect(formatSse(encoder.ping())).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });

  it("does not disturb block indices", () => {
    const encoder = new AnthropicStreamEncoder(opts);
    encoder.encode(start);
    encoder.encode({ type: "text_delta", text: "a" });
    encoder.ping();
    encoder.ping();
    const after = encoder.encode({ type: "text_delta", text: "b" });
    expect(JSON.parse(after[0]?.data ?? "{}").index).toBe(0);
  });
});

describe("stream robustness", () => {
  it("terminates a stream that ended without a finish event", () => {
    const frames = encodeStream([start, { type: "text_delta", text: "cut off" }], opts);
    expect(eventNames(frames).slice(-3)).toEqual([
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const delta = frames.find((f) => f.event === "message_delta");
    expect(JSON.parse(delta?.data ?? "{}").delta.stop_reason).toBe("end_turn");
  });

  it("does not double-terminate when finish already arrived", () => {
    const encoder = new AnthropicStreamEncoder(opts);
    encoder.encode(start);
    encoder.encode({ type: "finish", reason: "end_turn" });
    expect(encoder.finalize()).toEqual([]);
  });

  it("closes an unclosed tool block on finish", () => {
    const frames = encodeStream(
      [
        start,
        { type: "tool_start", index: 0, id: "t", name: "n" },
        { type: "finish", reason: "tool_use" },
      ],
      opts,
    );
    expect(eventNames(frames)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("rejects a tool delta with no preceding tool_start as upstream_incompatible", () => {
    const encoder = new AnthropicStreamEncoder(opts);
    encoder.encode(start);
    try {
      encoder.encode({ type: "tool_input_delta", index: 3, partialJson: "{}" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).code).toBe("upstream_incompatible");
    }
  });

  it("rejects content before message_start", () => {
    const encoder = new AnthropicStreamEncoder(opts);
    try {
      encoder.encode({ type: "text_delta", text: "early" });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as BosandaError).code).toBe("internal_error");
    }
  });

  it("rejects a second message_start", () => {
    const encoder = new AnthropicStreamEncoder(opts);
    encoder.encode(start);
    try {
      encoder.encode(start);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as BosandaError).code).toBe("internal_error");
    }
  });

  it("mints a msg_-prefixed id when the caller supplies none", () => {
    const encoder = new AnthropicStreamEncoder();
    expect(encoder.messageId).toMatch(/^msg_/);
  });
});

describe("non-streaming Message object", () => {
  it("assembles accumulated text, stop_reason and usage", () => {
    const message = encodeMessage(
      [
        start,
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
        { type: "usage", inputTokens: 5, outputTokens: 2, estimated: false },
        { type: "finish", reason: "end_turn" },
      ],
      opts,
    );

    expect(message).toEqual({
      id: ID,
      type: "message",
      role: "assistant",
      model: "bosanda-sonnet",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it("parses accumulated tool JSON into a real input object", () => {
    const message = encodeMessage(
      [
        start,
        { type: "text_delta", text: "Looking." },
        { type: "tool_start", index: 0, id: "toolu_1", name: "read_file" },
        { type: "tool_input_delta", index: 0, partialJson: '{"path":' },
        { type: "tool_input_delta", index: 0, partialJson: '"a.ts"}' },
        { type: "tool_stop", index: 0 },
        { type: "finish", reason: "tool_use" },
      ],
      opts,
    );

    expect(message.content).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(message.stop_reason).toBe("tool_use");
  });

  it("treats an empty tool accumulation as a no-argument call", () => {
    const message = encodeMessage(
      [
        start,
        { type: "tool_start", index: 0, id: "t", name: "now" },
        { type: "tool_stop", index: 0 },
        { type: "finish", reason: "tool_use" },
      ],
      opts,
    );
    expect(message.content[0]).toMatchObject({ input: {} });
  });

  it("classifies unparseable tool JSON as upstream_incompatible without echoing it", () => {
    const garbage = "{unparseable-model-output";
    try {
      encodeMessage(
        [
          start,
          { type: "tool_start", index: 0, id: "t", name: "broken" },
          { type: "tool_input_delta", index: 0, partialJson: garbage },
          { type: "tool_stop", index: 0 },
          { type: "finish", reason: "tool_use" },
        ],
        opts,
      );
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      const bosanda = error as BosandaError;
      expect(bosanda.code).toBe("upstream_incompatible");
      // Model output must not appear in an operator log line either (§16).
      expect(bosanda.internalDetail).not.toContain(garbage);
      expect(bosanda.internalDetail).toContain("broken");
    }
  });

  it("keeps a thinking block in the assembled content", () => {
    const message = encodeMessage(
      [
        start,
        { type: "reasoning_delta", text: "hmm" },
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "end_turn" },
      ],
      opts,
    );
    expect(message.content).toEqual([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "done" },
    ]);
  });

  it("reports max_tokens truncation", () => {
    const message = encodeMessage(
      [start, { type: "text_delta", text: "cut" }, { type: "finish", reason: "max_tokens" }],
      opts,
    );
    expect(message.stop_reason).toBe("max_tokens");
  });
});
