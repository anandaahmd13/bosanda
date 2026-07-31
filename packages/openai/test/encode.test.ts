/**
 * CanonicalEvent[] -> OpenAI SSE chunks and the non-streaming completion
 * (PLAN.md §8 "OpenAI-compatible surface", §5).
 *
 * A fixedClock makes `created` deterministic and an explicit `id` makes the
 * completion ID assertable, so every frame is compared literally.
 */

import { describe, expect, it } from "vitest";
import type { CanonicalEvent, FinishReason } from "@bosanda/protocol";
import {
  DONE_FRAME,
  OpenAIStreamEncoder,
  encodeCompletion,
  encodeStream,
  openAIFinishReason,
  type OpenAIChunk,
} from "@bosanda/openai";
import { fixedClock } from "@bosanda/shared";

const CLOCK = fixedClock("2026-03-01T00:00:00.000Z");
/** 2026-03-01T00:00:00Z in Unix seconds. */
const CREATED = 1772323200;
const ID = "chatcmpl_test123";
const MODEL = "bosanda-sonnet";

const options = { model: MODEL, id: ID, clock: CLOCK };

/** Parse one `data: {...}` frame back to an object. */
function parseFrame(frame: string): OpenAIChunk {
  expect(frame.startsWith("data: ")).toBe(true);
  expect(frame.endsWith("\n\n")).toBe(true);
  return JSON.parse(frame.slice("data: ".length, -2)) as OpenAIChunk;
}

describe("encodeStream — a plain text turn, chunk by chunk", () => {
  const events: CanonicalEvent[] = [
    { type: "message_start", id: "upstream-msg-1", model: "kiro-internal-id" },
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
    { type: "finish", reason: "end_turn" },
  ];

  const frames = encodeStream(events, options);

  it("emits one frame per event plus [DONE]", () => {
    expect(frames).toHaveLength(5);
  });

  it("opens with a role delta and empty content", () => {
    expect(parseFrame(frames[0] ?? "")).toEqual({
      id: ID,
      object: "chat.completion.chunk",
      created: CREATED,
      model: MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    });
  });

  it("sends the role on the first chunk only", () => {
    const first = parseFrame(frames[0] ?? "");
    expect(first.choices[0]?.delta.role).toBe("assistant");
    for (const frame of frames.slice(1, 4)) {
      expect(parseFrame(frame).choices[0]?.delta.role).toBeUndefined();
    }
  });

  it("streams each text delta verbatim", () => {
    expect(parseFrame(frames[1] ?? "").choices[0]?.delta).toEqual({ content: "Hello" });
    expect(parseFrame(frames[2] ?? "").choices[0]?.delta).toEqual({ content: " world" });
  });

  it("closes with an empty delta carrying finish_reason", () => {
    const final = parseFrame(frames[3] ?? "");
    expect(final.choices[0]).toEqual({
      index: 0,
      delta: {},
      finish_reason: "stop",
      logprobs: null,
    });
  });

  it("terminates with data: [DONE]", () => {
    expect(frames[4]).toBe("data: [DONE]\n\n");
    expect(DONE_FRAME).toBe("data: [DONE]\n\n");
  });

  it("uses one stable completion ID across every chunk (§8)", () => {
    const ids = frames.slice(0, 4).map((f) => parseFrame(f).id);
    expect(new Set(ids)).toEqual(new Set([ID]));
  });

  it("never echoes the upstream message ID or upstream model ID", () => {
    const joined = frames.join("");
    expect(joined).not.toContain("upstream-msg-1");
    expect(joined).not.toContain("kiro-internal-id");
    expect(joined).toContain(MODEL);
  });

  it("declares the chunk object type on every chunk", () => {
    for (const frame of frames.slice(0, 4)) {
      expect(parseFrame(frame).object).toBe("chat.completion.chunk");
    }
  });

  it("omits usage when include_usage was not requested", () => {
    for (const frame of frames.slice(0, 4)) {
      expect(parseFrame(frame).usage).toBeUndefined();
    }
    expect(frames.filter((f) => f.includes('"usage"'))).toHaveLength(0);
  });
});

describe("encodeStream — a tool-call turn with fragmented arguments", () => {
  // The model streams JSON in fragments that are individually invalid.
  const fragments = ['{"ci', 'ty":"Jak', 'arta","units":', '"c"}'];

  const events: CanonicalEvent[] = [
    { type: "message_start", id: "m1", model: "up" },
    { type: "tool_start", index: 0, id: "toolu_abc", name: "get_weather" },
    ...fragments.map((partialJson): CanonicalEvent => ({
      type: "tool_input_delta",
      index: 0,
      partialJson,
    })),
    { type: "tool_stop", index: 0 },
    { type: "finish", reason: "tool_use" },
  ];

  const frames = encodeStream(events, options);

  it("emits no frame for tool_stop, which has no OpenAI equivalent", () => {
    // message_start + tool_start + 4 fragments + finish + [DONE] = 8
    expect(frames).toHaveLength(8);
  });

  it("opens the tool call with index, id, type, and name", () => {
    const chunk = parseFrame(frames[1] ?? "");
    expect(chunk.choices[0]?.delta.tool_calls).toEqual([
      {
        index: 0,
        id: "toolu_abc",
        type: "function",
        function: { name: "get_weather", arguments: "" },
      },
    ]);
  });

  it("streams argument fragments with an index and no repeated id or name", () => {
    for (const [i, fragment] of fragments.entries()) {
      const delta = parseFrame(frames[2 + i] ?? "").choices[0]?.delta;
      expect(delta?.tool_calls).toEqual([{ index: 0, function: { arguments: fragment } }]);
      // Re-sending id/name would make a naive accumulator duplicate them.
      expect(delta?.tool_calls?.[0]?.id).toBeUndefined();
      expect(delta?.tool_calls?.[0]?.function.name).toBeUndefined();
    }
  });

  it("reassembles client-side to exactly the JSON the model emitted", () => {
    const assembled = frames
      .map(parseFrameSafe)
      .flatMap((chunk) => chunk?.choices[0]?.delta.tool_calls ?? [])
      .map((call) => call.function.arguments ?? "")
      .join("");
    expect(assembled).toBe('{"city":"Jakarta","units":"c"}');
    expect(JSON.parse(assembled)).toEqual({ city: "Jakarta", units: "c" });
  });

  it("finishes with tool_calls", () => {
    expect(parseFrame(frames[6] ?? "").choices[0]?.finish_reason).toBe("tool_calls");
    expect(frames[7]).toBe(DONE_FRAME);
  });

  it("keeps parallel tool calls on distinct indices", () => {
    const parallel = encodeStream(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "tool_start", index: 0, id: "t0", name: "a" },
        { type: "tool_start", index: 1, id: "t1", name: "b" },
        { type: "tool_input_delta", index: 1, partialJson: '{"x":1}' },
        { type: "tool_input_delta", index: 0, partialJson: '{"y":2}' },
        { type: "finish", reason: "tool_use" },
      ],
      options,
    );
    const indices = parallel
      .map(parseFrameSafe)
      .flatMap((chunk) => chunk?.choices[0]?.delta.tool_calls ?? [])
      .map((call) => call.index);
    expect(indices).toEqual([0, 1, 1, 0]);
  });
});

/** [DONE] is not JSON; skip it when scanning frames generically. */
function parseFrameSafe(frame: string): OpenAIChunk | null {
  if (frame === DONE_FRAME) return null;
  return parseFrame(frame);
}

describe("encodeStream — reasoning deltas", () => {
  it("keeps reasoning out of content so a client ignoring it still sees the answer", () => {
    const frames = encodeStream(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "reasoning_delta", text: "thinking..." },
        { type: "text_delta", text: "answer" },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );
    const reasoning = parseFrame(frames[1] ?? "").choices[0]?.delta;
    expect(reasoning?.reasoning_content).toBe("thinking...");
    expect(reasoning?.content).toBeUndefined();
    expect(parseFrame(frames[2] ?? "").choices[0]?.delta.content).toBe("answer");
  });
});

describe("encodeStream — include_usage", () => {
  const events: CanonicalEvent[] = [
    { type: "message_start", id: "m", model: "u" },
    { type: "text_delta", text: "hi" },
    { type: "usage", inputTokens: 11, outputTokens: 3, estimated: false },
    { type: "finish", reason: "end_turn" },
  ];

  it("appends a usage chunk with empty choices before [DONE] when requested", () => {
    const frames = encodeStream(events, { ...options, includeUsage: true });
    // message_start + text + finish + usage + [DONE]; the usage EVENT emits no frame.
    expect(frames).toHaveLength(5);

    const usageChunk = parseFrame(frames[3] ?? "");
    expect(usageChunk).toEqual({
      id: ID,
      object: "chat.completion.chunk",
      created: CREATED,
      model: MODEL,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    });
    expect(frames[4]).toBe(DONE_FRAME);
  });

  it("omits the usage chunk entirely when not requested", () => {
    const frames = encodeStream(events, { ...options, includeUsage: false });
    expect(frames).toHaveLength(4);
    expect(frames.some((f) => f.includes('"usage"'))).toBe(false);
    expect(frames.at(-1)).toBe(DONE_FRAME);
  });

  it("emits no usage chunk when requested but no usage event arrived", () => {
    const frames = encodeStream(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "finish", reason: "end_turn" },
      ],
      { ...options, includeUsage: true },
    );
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)).toBe(DONE_FRAME);
  });

  it("reports cached tokens in prompt_tokens_details when present", () => {
    const frames = encodeStream(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "usage", inputTokens: 100, outputTokens: 5, cachedTokens: 80, estimated: false },
        { type: "finish", reason: "end_turn" },
      ],
      { ...options, includeUsage: true },
    );
    const usage = parseFrame(frames[2] ?? "").usage;
    expect(usage?.prompt_tokens_details).toEqual({ cached_tokens: 80 });
  });

  it("never puts the internal `estimated` flag on the wire", () => {
    // OpenAI's usage object has no such field; §10 keeps it on the ledger row.
    const frames = encodeStream(events, { ...options, includeUsage: true });
    expect(frames.join("")).not.toContain("estimated");
  });
});

describe("OpenAIStreamEncoder", () => {
  it("is idempotent on finish so no second [DONE] can be emitted", () => {
    const encoder = new OpenAIStreamEncoder(options);
    encoder.encode({ type: "message_start", id: "m", model: "u" });
    expect(encoder.finish()).toEqual([DONE_FRAME]);
    expect(encoder.finish()).toEqual([]);
  });

  it("mints a shared-package completion ID when none is supplied", () => {
    const encoder = new OpenAIStreamEncoder({ model: MODEL, clock: CLOCK });
    const chunk = parseFrame(
      encoder.encode({ type: "message_start", id: "m", model: "u" })[0] ?? "",
    );
    // @bosanda/shared messageId("openai") shape — not an ad hoc ID.
    expect(chunk.id).toMatch(/^chatcmpl_[\w-]{16}$/);
  });

  it("gives two encoders distinct IDs", () => {
    const a = new OpenAIStreamEncoder({ model: MODEL, clock: CLOCK });
    const b = new OpenAIStreamEncoder({ model: MODEL, clock: CLOCK });
    const idOf = (e: OpenAIStreamEncoder) =>
      parseFrame(e.encode({ type: "message_start", id: "m", model: "u" })[0] ?? "").id;
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it("stamps created from the injected clock, never Date.now()", () => {
    const encoder = new OpenAIStreamEncoder({
      model: MODEL,
      clock: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    const chunk = parseFrame(
      encoder.encode({ type: "message_start", id: "m", model: "u" })[0] ?? "",
    );
    expect(chunk.created).toBe(1577836800);
  });
});

describe("finish_reason mapping — every FinishReason", () => {
  const expected: Record<FinishReason, string> = {
    end_turn: "stop",
    tool_use: "tool_calls",
    max_tokens: "length",
    refusal: "content_filter",
  };

  it("maps all four canonical reasons", () => {
    // Exhaustive by construction: the table is keyed by FinishReason, so a new
    // canonical reason breaks the typecheck here.
    for (const [reason, wire] of Object.entries(expected) as [FinishReason, string][]) {
      expect(openAIFinishReason(reason)).toBe(wire);
    }
  });

  it("emits each reason in the streaming finish chunk", () => {
    for (const [reason, wire] of Object.entries(expected) as [FinishReason, string][]) {
      const frames = encodeStream(
        [
          { type: "message_start", id: "m", model: "u" },
          { type: "finish", reason },
        ],
        options,
      );
      expect(parseFrame(frames[1] ?? "").choices[0]?.finish_reason).toBe(wire);
    }
  });

  it("emits each reason in the non-streaming completion", () => {
    for (const [reason, wire] of Object.entries(expected) as [FinishReason, string][]) {
      const completion = encodeCompletion(
        [
          { type: "message_start", id: "m", model: "u" },
          { type: "text_delta", text: "x" },
          { type: "finish", reason },
        ],
        options,
      );
      expect(completion.choices[0]?.finish_reason).toBe(wire);
    }
  });
});

describe("encodeCompletion — the non-streaming shape", () => {
  it("returns a chat.completion object with joined text and usage", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
        { type: "usage", inputTokens: 9, outputTokens: 2, estimated: false },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );

    expect(completion).toEqual({
      id: ID,
      object: "chat.completion",
      created: CREATED,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    });
  });

  it("is a chat.completion, never a chat.completion.chunk", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );
    expect(completion.object).toBe("chat.completion");
  });

  it("reassembles fragmented tool arguments into valid JSON", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "tool_start", index: 0, id: "toolu_1", name: "get_weather" },
        { type: "tool_input_delta", index: 0, partialJson: '{"ci' },
        { type: "tool_input_delta", index: 0, partialJson: 'ty":"Jakarta"}' },
        { type: "tool_stop", index: 0 },
        { type: "finish", reason: "tool_use" },
      ],
      options,
    );

    const call = completion.choices[0]?.message.tool_calls?.[0];
    expect(call).toEqual({
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Jakarta"}' },
    });
    expect(JSON.parse(call?.function.arguments ?? "")).toEqual({ city: "Jakarta" });
  });

  it("reports null content when the turn was purely tool calls", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "tool_start", index: 0, id: "t", name: "f" },
        { type: "tool_input_delta", index: 0, partialJson: "{}" },
        { type: "finish", reason: "tool_use" },
      ],
      options,
    );
    expect(completion.choices[0]?.message.content).toBeNull();
  });

  it("reports empty-string content for an empty text turn with no tool calls", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );
    expect(completion.choices[0]?.message.content).toBe("");
  });

  it("sorts parallel tool calls by index regardless of arrival order", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "tool_start", index: 1, id: "t1", name: "second" },
        { type: "tool_start", index: 0, id: "t0", name: "first" },
        { type: "tool_input_delta", index: 1, partialJson: '{"b":2}' },
        { type: "tool_input_delta", index: 0, partialJson: '{"a":1}' },
        { type: "finish", reason: "tool_use" },
      ],
      options,
    );
    const calls = completion.choices[0]?.message.tool_calls ?? [];
    expect(calls.map((c) => c.index)).toEqual([0, 1]);
    expect(calls.map((c) => c.function.name)).toEqual(["first", "second"]);
    expect(calls[0]?.function.arguments).toBe('{"a":1}');
  });

  it("always includes usage, reporting zeros when no usage event arrived", () => {
    // The OpenAI non-streaming schema requires the field.
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );
    expect(completion.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("ignores include_usage, which is a streaming-only concern", () => {
    const events: CanonicalEvent[] = [
      { type: "message_start", id: "m", model: "u" },
      { type: "usage", inputTokens: 4, outputTokens: 1, estimated: true },
      { type: "finish", reason: "end_turn" },
    ];
    const off = encodeCompletion(events, { ...options, includeUsage: false });
    const on = encodeCompletion(events, { ...options, includeUsage: true });
    expect(off.usage).toEqual(on.usage);
    expect(off.usage.total_tokens).toBe(5);
  });

  it("carries reasoning separately from content", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "reasoning_delta", text: "step 1" },
        { type: "text_delta", text: "answer" },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );
    expect(completion.choices[0]?.message.content).toBe("answer");
    expect(completion.choices[0]?.message.reasoning_content).toBe("step 1");
  });

  it("defaults finish_reason to stop when the stream carried none", () => {
    const completion = encodeCompletion([{ type: "text_delta", text: "x" }], options);
    expect(completion.choices[0]?.finish_reason).toBe("stop");
  });

  it("never echoes upstream identifiers", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "upstream-secret", model: "kiro-internal" },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );
    const json = JSON.stringify(completion);
    expect(json).not.toContain("upstream-secret");
    expect(json).not.toContain("kiro-internal");
  });

  it("mints an ID via @bosanda/shared when none is supplied", () => {
    const completion = encodeCompletion([{ type: "finish", reason: "end_turn" }], {
      model: MODEL,
      clock: CLOCK,
    });
    expect(completion.id).toMatch(/^chatcmpl_[\w-]{16}$/);
  });
});
