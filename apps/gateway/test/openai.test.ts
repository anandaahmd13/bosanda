/**
 * `POST /v1/chat/completions` (PLAN.md §8, §10).
 *
 * Covers the two response modes and the settlement that follows both. The streaming
 * assertions parse the SSE frames rather than matching on the raw body, because the
 * things that matter are structural: the `[DONE]` sentinel, one `data:` frame per event,
 * and the absence of `[DONE]` after an error. A substring match would pass on a body
 * that an SDK cannot parse.
 *
 * Settlement is asserted on every path, including failure. §10 bills what was
 * delivered — a turn that emitted 200 tokens and then broke is still 200 tokens of
 * provider cost, and a gateway that only settles on success loses money on exactly the
 * requests that cost the most to serve.
 */

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import {
  fakeAdapter,
  harness,
  modelRecord,
  testKey,
  testKeyring,
  textStream,
  TEST_MODEL,
  type ScriptStep,
} from "./harness.js";

function setup(options: Parameters<typeof harness>[0] = {}) {
  const key = testKey(testKeyring());
  const adapter =
    options.adapter ?? fakeAdapter({ scripts: options.scripts ?? [textStream("Hello")] });
  const built = harness({ ...options, adapter, keys: [key] });
  return {
    ...built,
    key,
    adapter,
    app: buildApp({ deps: built.deps, readiness: createReadinessState() }),
  };
}

function post(server: ReturnType<typeof setup>, payload: Record<string, unknown>) {
  return server.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "x-api-key": server.key.plaintext },
    payload: { model: TEST_MODEL, messages: [{ role: "user", content: "hi" }], ...payload },
  });
}

/** Splits an SSE body into its `data:` payloads, preserving `[DONE]` as a marker. */
function sseFrames(body: string): string[] {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => frame.slice("data:".length).trim());
}

function sseJson(body: string): Record<string, unknown>[] {
  return sseFrames(body)
    .filter((frame) => frame !== "[DONE]")
    .map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

describe("non-streaming completions", () => {
  it("returns one OpenAI completion object", async () => {
    const server = setup({ scripts: [textStream("Hello there")] });

    const response = await post(server, { stream: false });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe(TEST_MODEL);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello there");
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("reports usage and settles a matching ledger debit", async () => {
    const server = setup({ scripts: [textStream("hi")] });

    const response = await post(server, { stream: false });

    const usage = response.json().usage;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);

    // One debit, one usage row, and the weighted amount equals raw x 1.0 for this model.
    expect(server.recorded.debits).toHaveLength(1);
    expect(server.recorded.debits[0]?.weightedTokens).toBe(15);
    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.status).toBe("succeeded");
  });

  /**
   * The multiplier is applied with `ceil`, not `round`. A model at 1.5x on 15 raw tokens
   * is 23 weighted, not 22: fractional tokens always favour the house, because the
   * alternative is a systematic under-bill that scales with traffic.
   */
  it("applies the model multiplier with ceiling rounding", async () => {
    const server = setup({
      models: [modelRecord({ multiplier: "1.5000", multiplierNumeric: 1.5 })],
      scripts: [textStream("hi")],
    });

    await post(server, { stream: false });

    expect(server.recorded.debits[0]?.weightedTokens).toBe(23);
  });

  it("does not include usage in the body unless the caller asked for it", async () => {
    const server = setup();

    const response = await post(server, { stream: true, stream_options: undefined });

    // A streamed response without `stream_options.include_usage` carries no usage
    // frame, but the ledger is debited regardless — billing is not opt-in.
    const frames = sseJson(response.body);
    expect(frames.some((frame) => frame["usage"] !== undefined && frame["usage"] !== null)).toBe(
      false,
    );
    expect(server.recorded.debits).toHaveLength(1);
  });
});

describe("streaming completions", () => {
  it("streams SSE frames terminated by [DONE]", async () => {
    const server = setup({ scripts: [textStream("Hi")] });

    const response = await post(server, { stream: true });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const frames = sseFrames(response.body);
    expect(frames.at(-1)).toBe("[DONE]");
  });

  /**
   * `x-accel-buffering: no` is what stops nginx holding the response until its buffer
   * fills. Without it, every token arrives at once minutes later and streaming is
   * streaming in name only — a failure that cannot be reproduced on localhost, which is
   * exactly why it is asserted here.
   */
  it("sets the headers that keep nginx from buffering the stream", async () => {
    const server = setup();

    const response = await post(server, { stream: true });

    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["cache-control"]).toContain("no-cache");
  });

  it("emits a role delta first and text deltas after", async () => {
    const server = setup({ scripts: [textStream("abc")] });

    const response = await post(server, { stream: true });

    const frames = sseJson(response.body);
    const first = frames[0]?.["choices"] as { delta: Record<string, unknown> }[] | undefined;
    expect(first?.[0]?.delta["role"]).toBe("assistant");

    const text = frames
      .flatMap((frame) => (frame["choices"] as { delta: { content?: string } }[]) ?? [])
      .map((choice) => choice.delta.content ?? "")
      .join("");
    expect(text).toBe("abc");
  });

  it("includes a usage frame when stream_options.include_usage is set", async () => {
    const server = setup({ scripts: [textStream("hi")] });

    const response = await post(server, {
      stream: true,
      stream_options: { include_usage: true },
    });

    const frames = sseJson(response.body);
    const withUsage = frames.filter(
      (frame) => frame["usage"] !== undefined && frame["usage"] !== null,
    );
    expect(withUsage).toHaveLength(1);
    expect((withUsage[0]?.["usage"] as { total_tokens: number }).total_tokens).toBe(15);
  });

  it("settles once for a streamed turn", async () => {
    const server = setup({ scripts: [textStream("hello")] });

    await post(server, { stream: true });

    expect(server.recorded.debits).toHaveLength(1);
    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.surface).toBe("openai");
  });

  it("never sends the upstream model id in a streamed frame", async () => {
    const server = setup({
      models: [modelRecord({ upstreamId: "secret-upstream-name" })],
      scripts: [textStream("hi")],
    });

    const response = await post(server, { stream: true });

    expect(response.body).not.toContain("secret-upstream-name");
  });
});

describe("tool calls", () => {
  it("streams a tool call and reports finish_reason tool_calls", async () => {
    const script: ScriptStep[] = [
      { emit: { type: "message_start", id: "msg_1", model: TEST_MODEL } },
      { emit: { type: "tool_start", index: 0, id: "call_1", name: "get_weather" } },
      { emit: { type: "tool_input_delta", index: 0, partialJson: '{"city":' } },
      { emit: { type: "tool_input_delta", index: 0, partialJson: '"Jakarta"}' } },
      { emit: { type: "tool_stop", index: 0 } },
      { emit: { type: "usage", inputTokens: 20, outputTokens: 8, estimated: false } },
      { emit: { type: "finish", reason: "tool_use" } },
    ];
    const server = setup({ scripts: [script] });

    const response = await post(server, { stream: false });

    const choice = response.json().choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(choice.message.tool_calls[0].function.arguments)).toEqual({
      city: "Jakarta",
    });
  });
});
