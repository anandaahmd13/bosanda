/**
 * `POST /v1/messages` and `POST /v1/messages/count_tokens` (PLAN.md §8, §10).
 *
 * This is the surface Claude Code speaks, and the assertions are shaped by the two
 * ways it differs from the OpenAI suite rather than by re-testing the shared pipeline:
 *
 *   1. FRAMES ARE NAMED. Anthropic clients dispatch on the `event:` line, not on the
 *      JSON body, so the parser below reads both lines and the tests assert the event
 *      NAMES and their order. A body-only match would pass on a stream a conformant
 *      client silently ignores.
 *   2. THERE IS NO `[DONE]`. `message_stop` is the terminator, so its absence — and
 *      the absence of the OpenAI sentinel — is asserted rather than assumed.
 *
 * The error tests exist for the router in `plugins/security.ts`, which picks the
 * envelope by path prefix. A 401 rendered in the OpenAI shape on `/v1/messages` is a
 * response the Anthropic SDK cannot parse at all, and nothing else in the suite would
 * notice, because the status code would still be right.
 */

import { describe, expect, it } from "vitest";
import type { AnthropicMessage } from "@bosanda/anthropic";
import { BosandaError } from "@bosanda/protocol";
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

const VERSION = "2023-06-01";

function setup(options: Parameters<typeof harness>[0] = {}) {
  const key = testKey(testKeyring());
  // Built here rather than taken from `harness` so `attempts` is typed: the count_tokens
  // tests assert that no provider was ever leased, which needs the concrete fake.
  const adapter = fakeAdapter({ scripts: options.scripts ?? [textStream("Hello")] });
  const built = harness({ ...options, adapter, keys: [key] });
  return {
    ...built,
    key,
    adapter,
    app: buildApp({ deps: built.deps, readiness: createReadinessState() }),
  };
}

type Server = ReturnType<typeof setup>;

function post(
  server: Server,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return server.app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": server.key.plaintext, "anthropic-version": VERSION, ...headers },
    payload: {
      model: TEST_MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      ...payload,
    },
  });
}

function countTokens(
  server: Server,
  payload: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return server.app.inject({
    method: "POST",
    url: "/v1/messages/count_tokens",
    headers: { "x-api-key": server.key.plaintext, "anthropic-version": VERSION, ...headers },
    payload: { model: TEST_MODEL, messages: [{ role: "user", content: "hi" }], ...payload },
  });
}

/**
 * One parsed SSE frame. `event` is nullable on purpose: a frame that arrived with a
 * `data:` line and no `event:` line is a real defect on this surface, so the parser
 * has to be able to represent it in order for a test to catch it.
 */
type Frame = { event: string | null; data: Record<string, unknown> };

function sseFrames(body: string): Frame[] {
  const frames: Frame[] = [];

  for (const block of body.split("\n\n")) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;

    let event: string | null = null;
    const data: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).trim());
    }

    const joined = data.join("\n");
    frames.push({
      event,
      data: joined.length === 0 ? {} : (JSON.parse(joined) as Record<string, unknown>),
    });
  }

  return frames;
}

function eventNames(body: string): (string | null)[] {
  return sseFrames(body).map((frame) => frame.event);
}

function frameNamed(body: string, name: string): Frame {
  const found = sseFrames(body).find((frame) => frame.event === name);
  expect(found, `no ${name} frame in stream`).toBeDefined();
  // Narrowed by the expect above; re-read so the value is typed rather than asserted.
  if (found === undefined) throw new Error(`no ${name} frame`);
  return found;
}

function record(value: unknown, what: string): Record<string, unknown> {
  expect(typeof value, what).toBe("object");
  if (typeof value !== "object" || value === null) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}

describe("non-streaming /v1/messages", () => {
  it("returns a real Anthropic Message object", async () => {
    const server = setup({ scripts: [textStream("Hello there")] });

    const response = await post(server, { stream: false });

    expect(response.statusCode).toBe(200);
    const body = response.json<AnthropicMessage>();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(body.stop_reason).toBe("end_turn");
    // `stop_sequence` is present-and-null rather than absent: the field is part of the
    // documented shape and an SDK reading it off an absent key gets `undefined`.
    expect(body.stop_sequence).toBeNull();
    expect(body.usage.input_tokens).toBe(10);
    expect(body.usage.output_tokens).toBe(5);
  });

  /**
   * The public/upstream split (§6). `message_start` carries the public ID by contract in
   * the adapter, and the encoder copies it through — so this asserts BOTH that the
   * public id is echoed and that the catalogue's `upstreamId` never reaches the client,
   * including in a field nobody thought to check.
   */
  it("reports the public model id and never the upstream one", async () => {
    const server = setup({
      models: [modelRecord({ upstreamId: "secret-upstream-name" })],
      scripts: [textStream("hi")],
    });

    const response = await post(server, { stream: false });

    expect(response.json<AnthropicMessage>().model).toBe(TEST_MODEL);
    expect(response.body).not.toContain("secret-upstream-name");
  });

  it("settles exactly one ledger debit for the turn", async () => {
    const server = setup({ scripts: [textStream("hi")] });

    await post(server, { stream: false });

    // 10 input + 5 output raw, weighted at this model's 1.0x.
    expect(server.recorded.debits).toHaveLength(1);
    expect(server.recorded.debits[0]?.weightedTokens).toBe(15);
    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.status).toBe("succeeded");
    expect(server.recorded.usage[0]?.surface).toBe("anthropic");
  });

  /**
   * The multiplier is applied with `ceil`. 15 raw at 1.5x is 23 weighted, not 22:
   * fractional tokens favour the house, because the alternative is a systematic
   * under-bill that scales with traffic.
   */
  it("applies the model multiplier with ceiling rounding", async () => {
    const server = setup({
      models: [modelRecord({ multiplier: "1.5000", multiplierNumeric: 1.5 })],
      scripts: [textStream("hi")],
    });

    await post(server, { stream: false });

    expect(server.recorded.debits[0]?.weightedTokens).toBe(23);
  });

  it("projects a tool call into a tool_use content block", async () => {
    const script: ScriptStep[] = [
      { emit: { type: "message_start", id: "msg_1", model: TEST_MODEL } },
      { emit: { type: "tool_start", index: 0, id: "toolu_1", name: "get_weather" } },
      { emit: { type: "tool_input_delta", index: 0, partialJson: '{"city":' } },
      { emit: { type: "tool_input_delta", index: 0, partialJson: '"Jakarta"}' } },
      { emit: { type: "tool_stop", index: 0 } },
      { emit: { type: "usage", inputTokens: 20, outputTokens: 8, estimated: false } },
      { emit: { type: "finish", reason: "tool_use" } },
    ];
    const server = setup({ scripts: [script] });

    const response = await post(server, { stream: false });

    const body = response.json<AnthropicMessage>();
    expect(body.stop_reason).toBe("tool_use");
    // Anthropic delivers the parsed object, not the accumulated JSON string — the
    // fragments are a wire detail of the streaming form only.
    expect(body.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Jakarta" } },
    ]);
  });
});

describe("streaming /v1/messages", () => {
  it("emits the Anthropic event sequence in order", async () => {
    const server = setup({ scripts: [textStream("Hi")] });

    const response = await post(server, { stream: true });

    expect(response.statusCode).toBe(200);
    expect(eventNames(response.body)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  /**
   * A frame with a `data:` line and no `event:` line is dropped by a conformant
   * Anthropic client, so it would produce a stream that hangs rather than one that
   * errors — the worst failure mode to debug from the client side.
   */
  it("names every frame", async () => {
    const server = setup({ scripts: [textStream("Hi")] });

    const response = await post(server, { stream: true });

    const frames = sseFrames(response.body);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame.event === null)).toEqual([]);
    // Anthropic repeats the frame name inside the payload; a client that trusts the
    // body over the header must see the same value.
    for (const frame of frames) {
      expect(frame.data["type"]).toBe(frame.event);
    }
  });

  /**
   * `[DONE]` is the OpenAI sentinel and must not appear here. Sending it would be
   * harmless to a strict Anthropic parser and actively misleading to a permissive one,
   * and the reverse mistake — omitting `message_stop` — leaves the client waiting
   * forever, so both ends of the terminator contract are pinned.
   */
  it("terminates with message_stop and no [DONE] sentinel", async () => {
    const server = setup({ scripts: [textStream("Hi")] });

    const response = await post(server, { stream: true });

    expect(response.body).not.toContain("[DONE]");
    expect(eventNames(response.body).at(-1)).toBe("message_stop");
    expect(eventNames(response.body).filter((name) => name === "message_stop")).toHaveLength(1);
  });

  /**
   * The anti-buffering contract (§18).
   *
   * The route calls `reply.hijack()`, which makes Fastify stop managing the reply — so
   * `reply.header()` and the `onSend` hook both become no-ops and the headers can only
   * reach the wire through `raw.writeHead`. That is a silent failure: the body is
   * correct SSE, the status is 200, and every frame assertion above still passes while
   * nginx holds the whole response until its buffer fills. Asserted explicitly because
   * it cannot be reproduced on localhost.
   */
  it("sets the SSE and anti-buffering headers on the hijacked reply", async () => {
    const server = setup();

    const response = await post(server, { stream: true });

    expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["x-accel-buffering"]).toBe("no");
  });

  it("streams the text through content_block_delta frames", async () => {
    const server = setup({ scripts: [textStream("abc")] });

    const response = await post(server, { stream: true });

    const start = frameNamed(response.body, "content_block_start");
    expect(start.data["index"]).toBe(0);
    expect(record(start.data["content_block"], "content_block")).toEqual({
      type: "text",
      text: "",
    });

    const text = sseFrames(response.body)
      .filter((frame) => frame.event === "content_block_delta")
      .map((frame) => record(frame.data["delta"], "delta"))
      // `text_delta`, not `input_json_delta`: a client routes on the delta's own type.
      .map((delta) => (delta["type"] === "text_delta" ? String(delta["text"]) : ""))
      .join("");
    expect(text).toBe("abc");
  });

  /**
   * Anthropic reports input tokens on `message_start`, before upstream has said
   * anything, so the first figure is the local heuristic count and `message_delta`
   * carries the authoritative correction. A stream that repeated the local estimate in
   * the trailer would under-report what the customer was actually billed for.
   */
  it("corrects the locally counted input tokens in message_delta", async () => {
    const server = setup({ scripts: [textStream("hi")] });

    const response = await post(server, { stream: true });

    const started = record(frameNamed(response.body, "message_start").data["message"], "message");
    const startUsage = record(started["usage"], "message_start.usage");
    expect(startUsage["input_tokens"]).toBeGreaterThan(0);
    expect(startUsage["output_tokens"]).toBe(0);
    expect(started["stop_reason"]).toBeNull();

    const delta = frameNamed(response.body, "message_delta");
    expect(record(delta.data["delta"], "message_delta.delta")).toEqual({
      stop_reason: "end_turn",
      stop_sequence: null,
    });
    expect(record(delta.data["usage"], "message_delta.usage")).toEqual({
      input_tokens: 10,
      output_tokens: 5,
    });
  });

  it("settles once for a streamed turn", async () => {
    const server = setup({ scripts: [textStream("hello")] });

    await post(server, { stream: true });

    expect(server.recorded.debits).toHaveLength(1);
    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.surface).toBe("anthropic");
    expect(server.recorded.usage[0]?.status).toBe("succeeded");
  });

  /**
   * The other end of the terminator contract.
   *
   * A turn that breaks after the first byte has no status code left to change, so the
   * error goes in-band — and it must NOT be followed by `message_stop`, which would
   * tell Claude Code the message ended normally and have it render a truncated answer
   * as a complete one. The turn is still billed: §10 bills what was delivered, and
   * tokens that reached the customer cost the same as tokens in a turn that finished.
   */
  it("emits an in-band error frame with no message_stop when a stream breaks", async () => {
    const script: ScriptStep[] = [
      { emit: { type: "message_start", id: "msg_1", model: TEST_MODEL } },
      { emit: { type: "text_delta", text: "partial" } },
      { throw: new BosandaError("upstream_timeout", { internalDetail: "upstream went away" }) },
    ];
    const server = setup({ scripts: [script] });

    const response = await post(server, { stream: true });

    const names = eventNames(response.body);
    expect(names.at(-1)).toBe("error");
    expect(names).not.toContain("message_stop");
    expect(names).not.toContain("message_delta");
    expect(frameNamed(response.body, "error").data).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.any(String) },
    });
    expect(response.body).not.toContain("upstream went away");

    // `partial`, not `failed`: text reached the client before the break.
    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.status).toBe("partial");
    expect(server.recorded.debits).toHaveLength(1);
  });

  it("never sends the upstream model id in a streamed frame", async () => {
    const server = setup({
      models: [modelRecord({ upstreamId: "secret-upstream-name" })],
      scripts: [textStream("hi")],
    });

    const response = await post(server, { stream: true });

    expect(response.body).not.toContain("secret-upstream-name");
    const started = record(frameNamed(response.body, "message_start").data["message"], "message");
    expect(started["model"]).toBe(TEST_MODEL);
  });
});

describe("anthropic error envelope", () => {
  /**
   * The envelope router, proven.
   *
   * `plugins/security.ts` picks the shape from the `/v1/messages` path prefix. If that
   * inference broke, this surface would answer with OpenAI's
   * `{error: {message, type, param, code}}` — a body the Anthropic SDK raises a parse
   * error on, while the status code stays correct and every other test still passes.
   */
  it("returns 401 in the Anthropic shape for a missing api key", async () => {
    const server = setup();

    const response = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "anthropic-version": VERSION },
      payload: { model: TEST_MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Missing, invalid, or revoked API key." },
    });
  });

  it("returns the same 401 for a key that is not in the store", async () => {
    const server = setup({ keys: [] });

    const response = await post(server, {}, { "x-api-key": testKey(testKeyring()).plaintext });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Missing, invalid, or revoked API key." },
    });
  });

  /**
   * `anthropic-version` is required (§8) so a client can pin wire behaviour. Honouring
   * an unknown value would defeat the header's only purpose, so both the missing and
   * the unsupported case are a 400 rather than a best-effort attempt.
   */
  it("rejects a missing or unsupported anthropic-version with 400", async () => {
    const server = setup();

    const missing = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": server.key.plaintext },
      payload: { model: TEST_MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    });
    const unsupported = await post(server, {}, { "anthropic-version": "1999-01-01" });

    for (const response of [missing, unsupported]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        type: "error",
        error: { type: "invalid_request_error", message: expect.any(String) },
      });
    }
  });

  /**
   * A model the caller may not use is Anthropic's `permission_error`, not a 404: a 404
   * would let a client tell "does not exist" from "exists but is not yours", which is
   * the same enumeration leak the key-auth path avoids.
   */
  it("renders a forbidden model as a permission_error without leaking the internal detail", async () => {
    const server = setup({ models: [modelRecord({ published: false })] });

    const response = await post(server, {});

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      type: "error",
      error: { type: "permission_error", message: expect.any(String) },
    });
    // `internalDetail` is "model ... is unknown or unpublished" and is operator-only.
    expect(response.body).not.toContain("unpublished");
  });

  it("never echoes the api key or its prefix in an error body", async () => {
    const server = setup({ keys: [] });
    const presented = testKey(testKeyring());

    const response = await post(server, {}, { "x-api-key": presented.plaintext });

    expect(response.body).not.toContain(presented.plaintext);
    expect(response.body).not.toContain(presented.authenticated.key.prefix);
  });
});

describe("POST /v1/messages/count_tokens", () => {
  /**
   * The documented body is `{input_tokens}` and NOTHING else. `counterVersion()` exists
   * and is deliberately not on the wire — Anthropic's response has no such field, and
   * this surface's job is fidelity — so the key set is asserted rather than just the
   * one value.
   */
  it("returns only input_tokens", async () => {
    const server = setup();

    const response = await countTokens(server);

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(["input_tokens"]);
    expect(typeof body["input_tokens"]).toBe("number");
    expect(body["input_tokens"]).toBeGreaterThan(0);
  });

  it("does not require max_tokens and grows with the prompt", async () => {
    const server = setup();

    const short = await countTokens(server, { messages: [{ role: "user", content: "hi" }] });
    const long = await countTokens(server, {
      messages: [{ role: "user", content: "hi".repeat(500) }],
    });

    expect(short.statusCode).toBe(200);
    expect(long.statusCode).toBe(200);
    expect(long.json<{ input_tokens: number }>().input_tokens).toBeGreaterThan(
      short.json<{ input_tokens: number }>().input_tokens,
    );
  });

  it("requires authentication", async () => {
    const server = setup();

    const response = await server.app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { "anthropic-version": VERSION },
      payload: { model: TEST_MODEL, messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Missing, invalid, or revoked API key." },
    });
  });

  /**
   * Counting is authenticated but NOT metered (§10 bills tokens consumed upstream, and
   * this endpoint touches no provider). It is also the one place a client can size a
   * prompt before committing to spend, so charging for it would defeat its purpose.
   */
  it("never touches a provider or the ledger", async () => {
    const server = setup();

    await countTokens(server);

    expect(server.adapter.attempts).toEqual([]);
    expect(server.recorded.debits).toEqual([]);
    expect(server.recorded.usage).toEqual([]);
  });

  it("refuses to count against a model the caller may not use", async () => {
    const server = setup({ models: [modelRecord({ published: false })] });

    const response = await countTokens(server);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      type: "error",
      error: { type: "permission_error", message: expect.any(String) },
    });
  });
});
