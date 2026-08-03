/**
 * What a client sees when a turn breaks (PLAN.md §7 rule 3, §8, §10).
 *
 * The other suites assert the happy path and the pre-flight rejections. This one covers
 * the case the product exists to get right and which is easiest to get subtly wrong:
 * an upstream failure that lands AFTER the response has been committed.
 *
 * Three invariants, each of which is a real incident if it breaks:
 *
 *   1. NO `[DONE]` AFTER AN ERROR. `[DONE]` is the OpenAI SDK's signal that the turn is
 *      complete. Emitting it after a failure converts "your answer was truncated at
 *      token 40" into "your answer was 40 tokens long" — the client renders a partial
 *      response as a finished one and nobody, on either side, learns anything went
 *      wrong. Silent truncation is worse than a visible error.
 *   2. THE ERROR RENDERING FOLLOWS THE BYTE LATCH. Before the first byte a failure is
 *      an ordinary HTTP error with a real status code. After it, the status line is
 *      already `200` and unchangeable, so the only channel left is an in-band error
 *      frame. Same failure, two renderings, chosen by whether anything was written.
 *   3. A BROKEN TURN STILL SETTLES. §10 bills what was delivered: tokens streamed
 *      before a failure cost real provider money. A gateway that only settles on
 *      success loses money on precisely the expensive requests, and its ledger stops
 *      being an audit trail. `status` distinguishes the cases — `failed` when nothing
 *      arrived, `partial` when output preceded the break.
 *
 * The failures are injected with `{throw}` steps in the adapter script, so they arrive
 * from where a real provider failure arrives: mid-iteration of the upstream stream,
 * after some events have already been forwarded.
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import {
  accountHealthRow,
  fakeAdapter,
  harness,
  testKey,
  testKeyring,
  TEST_MODEL,
  type ScriptStep,
} from "./harness.js";

/**
 * @param accounts how many provider accounts the pool holds. The default of one is
 *   right for the failure-rendering tests; the failover pair needs two, because a pool
 *   of one makes "did not retry" indistinguishable from "had nowhere to retry".
 */
function setup(scripts: ScriptStep[][], accounts = 1) {
  const key = testKey(testKeyring());
  const adapter = fakeAdapter({ scripts });
  const built = harness({
    adapter,
    keys: [key],
    accounts: Array.from({ length: accounts }, () => accountHealthRow()),
  });
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

/** `data:` payloads in order, `[DONE]` preserved as its own marker. */
function sseFrames(body: string): string[] {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => frame.slice("data:".length).trim());
}

/**
 * A script that streams `text` and then fails.
 *
 * Deliberately does NOT emit a `usage` event: a provider that dies mid-turn never sends
 * its usage trailer, which is what forces settlement onto the counted-tokens fallback.
 * Scripting a usage event here would test a path that cannot happen.
 */
function brokenAfterText(text: string, error: unknown): ScriptStep[] {
  return [
    { emit: { type: "message_start", id: "msg_broken", model: TEST_MODEL } },
    { emit: { type: "text_delta", text } },
    { throw: error },
  ];
}

/** A script that fails before producing anything — the zero-byte case. */
function brokenImmediately(error: unknown): ScriptStep[] {
  return [{ throw: error }];
}

describe("failure after the stream has started", () => {
  it("never sends [DONE] after an error frame", async () => {
    const server = setup([
      brokenAfterText("Partial ", new BosandaError("upstream_timeout", { internalDetail: "idle" })),
    ]);

    const response = await post(server, { stream: true });
    const frames = sseFrames(response.body);

    /**
     * The assertion is on the whole body, not just the last frame: `[DONE]` anywhere
     * after an error is the bug, and checking only the terminator would miss a writer
     * that emitted it before the error frame.
     */
    expect(frames).not.toContain("[DONE]");
    expect(response.body).not.toContain("[DONE]");
  });

  it("ends with exactly one error frame carrying the public message", async () => {
    const server = setup([
      brokenAfterText("Partial ", new BosandaError("upstream_timeout", { internalDetail: "idle" })),
    ]);

    const response = await post(server, { stream: true });
    const frames = sseFrames(response.body);

    const errorFrames = frames.filter((frame) => frame.includes('"error"'));
    expect(errorFrames).toHaveLength(1);

    const last = frames.at(-1);
    expect(last).toBeDefined();
    if (last === undefined) return;
    const parsed = JSON.parse(last) as { error?: { message?: unknown; type?: unknown } };
    expect(parsed.error?.type).toBe("api_error");
    // The frozen public message for `upstream_timeout`. Asserted as an exact string
    // because this is the text a customer pastes into a support ticket.
    expect(parsed.error?.message).toBe("The upstream provider timed out.");
  });

  it("keeps the status at 200 and preserves the text already delivered", async () => {
    const server = setup([
      brokenAfterText("Partial answer", new BosandaError("upstream_incompatible")),
    ]);

    const response = await post(server, { stream: true });

    /**
     * 200 is correct and not a defect: the header was written the moment admission
     * succeeded, long before the provider broke. Retroactively "fixing" this to a 5xx
     * is impossible on the wire, and a writer that tried would corrupt the body.
     */
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Partial answer");
  });

  it("never leaks internalDetail into the error frame", async () => {
    const secret = "kiro-account-a1b2c3 refresh failed at https://internal.example/token";
    const server = setup([
      brokenAfterText("x", new BosandaError("internal_error", { internalDetail: secret })),
    ]);

    const response = await post(server, { stream: true });

    // `BosandaError.message` is `${code}: ${internalDetail}` by construction, so a
    // writer that reached for `.message` instead of `.publicMessage` would put all of
    // this on the wire. Each fragment is asserted separately so a partial leak fails.
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("kiro-account-a1b2c3");
    expect(response.body).not.toContain("internal.example");
  });

  it("settles the delivered tokens as a partial turn", async () => {
    const server = setup([
      brokenAfterText("some delivered text", new BosandaError("upstream_timeout")),
    ]);

    await post(server, { stream: true });

    /**
     * `partial`, not `failed`: output reached the customer. The distinction is what an
     * operator reads to tell "the provider never answered" (refundable, our problem)
     * from "the provider answered and then died" (delivered, billable).
     */
    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.status).toBe("partial");
    expect(server.recorded.usage[0]?.surface).toBe("openai");

    // Balance moved, so there must be a matching ledger row. §10 admits no debit
    // without one — a balance change with no audit row is unreconcilable.
    expect(server.recorded.debits).toHaveLength(1);
    expect(server.recorded.debits[0]?.weightedTokens).toBeGreaterThan(0);
  });
});

describe("failure before any byte is written", () => {
  it("still answers 200 on the streaming surface because headers are already committed", async () => {
    const server = setup([brokenImmediately(new BosandaError("no_healthy_provider"))]);

    const response = await post(server, { stream: true });

    /**
     * `streamResponse` flushes headers at admission, before asking the provider for
     * anything — §8's "the client learns its request was accepted immediately". So even
     * a zero-event failure is rendered in-band on this surface. The non-streaming
     * counterpart below is where the real status code survives; keeping both in one
     * file is what makes the asymmetry legible.
     */
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"error"');
    expect(response.body).not.toContain("[DONE]");
  });

  it("records a failed turn with no delivered output", async () => {
    const server = setup([brokenImmediately(new BosandaError("no_healthy_provider"))]);

    await post(server, { stream: true });

    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.status).toBe("failed");
  });

  it("uses a real HTTP status on the non-streaming surface", async () => {
    const server = setup([
      brokenImmediately(new BosandaError("upstream_timeout", { internalDetail: "no bytes" })),
    ]);

    const response = await post(server, { stream: false });

    // Nothing was committed, so the status is available and must be used. 504 for
    // `upstream_timeout`, straight off the frozen taxonomy.
    expect(response.statusCode).toBe(504);
    const body = response.json();
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("The upstream provider timed out.");
    expect(response.body).not.toContain("no bytes");
  });

  it("settles the non-streaming failure exactly once", async () => {
    const server = setup([brokenImmediately(new BosandaError("upstream_timeout"))]);

    await post(server, { stream: false });

    expect(server.recorded.usage).toHaveLength(1);
    expect(server.recorded.usage[0]?.status).toBe("failed");
  });
});

describe("a non-Bosanda throwable", () => {
  it("is reported as a sanitized internal error, not as its own message", async () => {
    const server = setup([
      brokenAfterText("x", new TypeError("Cannot read properties of undefined (reading 'chunk')")),
    ]);

    const response = await post(server, { stream: true });

    /**
     * A programming error inside the adapter must not narrate our stack traces to a
     * customer. `BosandaError.from` maps an unknown throwable to `internal_error`, whose
     * public message says nothing about the cause; the original text belongs in the
     * operator log only.
     */
    expect(response.body).not.toContain("Cannot read properties");
    expect(response.body).not.toContain("TypeError");
    expect(response.body).toContain('"error"');
    expect(response.body).not.toContain("[DONE]");
  });
});

describe("retry boundary", () => {
  it("does not fail over once bytes have reached the client", async () => {
    /**
     * §7 rule 3, the absolute one. Two accounts are available and the first breaks
     * mid-stream — but it broke AFTER emitting text, so retrying on the second account
     * would replay a fresh `message_start` and a second answer into a body the client
     * is already parsing. The result would be two concatenated responses, which no SDK
     * can interpret and which double-bills the customer.
     *
     * The second script would succeed if it were ever used; asserting one attempt is
     * what proves the latch held rather than the pool being empty.
     */
    const server = setup(
      [
        brokenAfterText("first half", new BosandaError("upstream_timeout")),
        [
          { emit: { type: "message_start", id: "msg_second", model: TEST_MODEL } },
          { emit: { type: "text_delta", text: "second answer" } },
          { emit: { type: "finish", reason: "end_turn" } },
        ],
      ],
      2,
    );

    const response = await post(server, { stream: true });

    expect(server.adapter.attempts).toHaveLength(1);
    expect(response.body).toContain("first half");
    expect(response.body).not.toContain("second answer");
  });

  it("does fail over when the first account produced nothing", async () => {
    /**
     * The mirror image, and the reason the latch is about BYTES rather than about
     * whether an error occurred: nothing was written, so a retry is invisible to the
     * client and is exactly what a provider pool is for. A gateway that refused to
     * retry here would surface every single-account hiccup as a customer-visible error.
     */
    const server = setup(
      [
        brokenImmediately(new BosandaError("upstream_timeout")),
        [
          { emit: { type: "message_start", id: "msg_second", model: TEST_MODEL } },
          { emit: { type: "text_delta", text: "recovered answer" } },
          { emit: { type: "finish", reason: "end_turn" } },
        ],
      ],
      2,
    );

    const response = await post(server, { stream: true });

    expect(server.adapter.attempts.length).toBeGreaterThan(1);
    expect(response.body).toContain("recovered answer");
    // A recovered turn is a complete turn, so the terminator IS required here.
    expect(response.body).toContain("[DONE]");
  });
});
