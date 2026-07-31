/**
 * decode -> canonical -> encode, composed (PLAN.md §8, §5).
 *
 * The individual codec halves are covered in decode/encode tests. What matters
 * here is that they compose: a tool call encoded to the wire, replayed back as
 * client history, must decode to the same canonical content — otherwise a
 * multi-turn agent loop drifts a little on every turn.
 */

import { describe, expect, it } from "vitest";
import type { CanonicalContent, CanonicalEvent } from "@bosanda/protocol";
import {
  DONE_FRAME,
  decodeChatCompletion,
  encodeCompletion,
  encodeStream,
  type OpenAIChunk,
} from "@bosanda/openai";
import { fixedClock } from "@bosanda/shared";

const options = { model: "bosanda-sonnet", id: "chatcmpl_rt", clock: fixedClock(0) };

const toolTurn: CanonicalEvent[] = [
  { type: "message_start", id: "m", model: "upstream" },
  { type: "tool_start", index: 0, id: "call_rt1", name: "get_weather" },
  { type: "tool_input_delta", index: 0, partialJson: '{"city"' },
  { type: "tool_input_delta", index: 0, partialJson: ':"Jakarta"}' },
  { type: "tool_stop", index: 0 },
  { type: "finish", reason: "tool_use" },
];

describe("streaming and non-streaming agree", () => {
  it("reassembles the same tool arguments either way", () => {
    const streamed = encodeStream(toolTurn, options)
      .filter((f) => f !== DONE_FRAME)
      .map((f) => JSON.parse(f.slice(6, -2)) as OpenAIChunk)
      .flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((c) => c.function.arguments ?? "")
      .join("");

    const completed = encodeCompletion(toolTurn, options).choices[0]?.message.tool_calls?.[0];

    expect(streamed).toBe('{"city":"Jakarta"}');
    expect(completed?.function.arguments).toBe(streamed);
  });

  it("agrees on finish_reason and tool identity", () => {
    const lastChunk = encodeStream(toolTurn, options)
      .filter((f) => f !== DONE_FRAME)
      .map((f) => JSON.parse(f.slice(6, -2)) as OpenAIChunk)
      .at(-1);
    const completion = encodeCompletion(toolTurn, options);

    expect(lastChunk?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(completion.choices[0]?.finish_reason).toBe("tool_calls");
    expect(completion.choices[0]?.message.tool_calls?.[0]?.id).toBe("call_rt1");
  });
});

describe("an encoded tool call replays as decodable history", () => {
  it("survives the round trip unchanged", () => {
    // Turn 1: the assistant asks for a tool.
    const completion = encodeCompletion(toolTurn, options);
    const assistantMessage = completion.choices[0]?.message;

    // Turn 2: the client sends that message back, plus the tool result.
    const request = decodeChatCompletion({
      model: "bosanda-sonnet",
      messages: [
        { role: "user", content: "Weather in Jakarta?" },
        {
          role: "assistant",
          content: assistantMessage?.content ?? null,
          tool_calls: assistantMessage?.tool_calls,
        },
        { role: "tool", tool_call_id: "call_rt1", content: '{"temp_c":31}' },
      ],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ],
    });

    // The tool_use that comes back out matches what the encoder put on the wire,
    // with `arguments` parsed back into structured input.
    expect(request.messages[1]?.content[0]).toEqual({
      type: "tool_use",
      id: "call_rt1",
      name: "get_weather",
      input: { city: "Jakarta" },
    });

    const result = request.messages[2]?.content[0] as Extract<
      CanonicalContent,
      { type: "tool_result" }
    >;
    expect(result.toolUseId).toBe("call_rt1");
    expect(result.content).toBe('{"temp_c":31}');
  });

  it("keeps the tool_call_id stable so the result correlates to the call", () => {
    const completion = encodeCompletion(toolTurn, options);
    const callId = completion.choices[0]?.message.tool_calls?.[0]?.id;

    const request = decodeChatCompletion({
      model: "m",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          tool_calls: completion.choices[0]?.message.tool_calls,
        },
        { role: "tool", tool_call_id: callId, content: "ok" },
      ],
    });

    const toolUse = request.messages[1]?.content[0] as Extract<
      CanonicalContent,
      { type: "tool_use" }
    >;
    const toolResult = request.messages[2]?.content[0] as Extract<
      CanonicalContent,
      { type: "tool_result" }
    >;
    expect(toolResult.toolUseId).toBe(toolUse.id);
  });

  it("round-trips a text answer as assistant history", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "m", model: "u" },
        { type: "text_delta", text: "It is 31C." },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );

    const request = decodeChatCompletion({
      model: "m",
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: completion.choices[0]?.message.content },
        { role: "user", content: "Thanks" },
      ],
    });

    expect(request.messages[1]?.content).toEqual([{ type: "text", text: "It is 31C." }]);
  });
});

describe("the codec never carries provider identity across a turn", () => {
  it("drops upstream IDs on encode so they cannot be replayed back in", () => {
    const completion = encodeCompletion(
      [
        { type: "message_start", id: "upstream-conv-42", model: "KIRO_INTERNAL" },
        { type: "text_delta", text: "hi" },
        { type: "finish", reason: "end_turn" },
      ],
      options,
    );
    // §16/§6: a fresh upstream conversation per request; nothing provider-side
    // may round-trip through the client.
    const json = JSON.stringify(completion);
    expect(json).not.toContain("upstream-conv-42");
    expect(json).not.toContain("KIRO_INTERNAL");
    expect(completion.model).toBe("bosanda-sonnet");
  });
});
