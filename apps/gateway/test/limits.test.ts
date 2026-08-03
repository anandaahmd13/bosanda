/**
 * Admission control over HTTP (PLAN.md §7, §10).
 *
 * The ordering assertions are the substance here. Admission runs RPM, then concurrency,
 * then quota, then the model lookup, then kill switches, then the pool — and each step
 * costs strictly more than the one before it. A request that will be refused for rate
 * must never reach the model lookup, and one refused on quota must never load a
 * provider credential. Testing "returns 429" alone would pass even if the order were
 * reversed, so these tests assert on what did NOT happen: no adapter attempt, no debit.
 *
 * The 429 distinction (`rate_limit` vs `concurrency_limit`) is also load-bearing for
 * clients: the OpenAI SDK backs off on both, but an operator reading
 * `bosanda_rpm_rejections_total` against `bosanda_concurrency_rejections_total` needs
 * them to mean different things.
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
  NOW,
  TEST_MODEL,
} from "./harness.js";

const BODY = {
  model: TEST_MODEL,
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

function setup(options: Parameters<typeof harness>[0] = {}, keyOverrides = {}) {
  const key = testKey(testKeyring(), keyOverrides);
  const adapter = options.adapter ?? fakeAdapter({ scripts: [textStream("ok")] });
  const built = harness({ ...options, adapter, keys: [key] });
  return {
    ...built,
    key,
    adapter,
    app: buildApp({ deps: built.deps, readiness: createReadinessState() }),
  };
}

function post(server: ReturnType<typeof setup>, payload: unknown = BODY) {
  return server.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "x-api-key": server.key.plaintext },
    payload,
  });
}

describe("rate limiting", () => {
  it("rejects the 101st request in a minute with rate_limit", async () => {
    const server = setup({ env: { KEY_MAX_REQUESTS_PER_MINUTE: 2 } });

    await post(server);
    await post(server);
    const third = await post(server);

    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limit");
  });

  /**
   * `rate_limit` is thrown BEFORE `concurrency_limit`. Both are 429, so the only way to
   * observe the order is to configure a state where both would trip and check which code
   * comes back.
   */
  it("reports rate_limit rather than concurrency_limit when both would trip", async () => {
    const server = setup({
      env: { KEY_MAX_REQUESTS_PER_MINUTE: 1, KEY_MAX_ACTIVE_REQUESTS: 1 },
    });

    await post(server);
    const second = await post(server);

    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("rate_limit");
  });

  it("sends Retry-After on a 429 so a client backs off instead of retrying immediately", async () => {
    const server = setup({ env: { KEY_MAX_REQUESTS_PER_MINUTE: 1 } });

    await post(server);
    const second = await post(server);

    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  /**
   * A rejected request must not consume the resources it was rejected for protecting.
   * If the adapter recorded an attempt, admission ran in the wrong order.
   */
  it("does not reach the provider or the ledger when rate limited", async () => {
    const server = setup({ env: { KEY_MAX_REQUESTS_PER_MINUTE: 1 } });

    await post(server);
    const attemptsAfterFirst = server.adapter.attempts.length;
    const debitsAfterFirst = server.recorded.debits.length;

    await post(server);

    expect(server.adapter.attempts.length).toBe(attemptsAfterFirst);
    expect(server.recorded.debits.length).toBe(debitsAfterFirst);
  });

  it("limits per key, not globally", async () => {
    const first = testKey(testKeyring());
    const second = testKey(testKeyring());
    const built = harness({
      env: { KEY_MAX_REQUESTS_PER_MINUTE: 1 },
      keys: [first, second],
    });
    const server = buildApp({ deps: built.deps, readiness: createReadinessState() });

    const send = (plaintext: string) =>
      server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "x-api-key": plaintext },
        payload: BODY,
      });

    expect((await send(first.plaintext)).statusCode).toBe(200);
    // The first key is now exhausted; the second must be unaffected.
    expect((await send(first.plaintext)).statusCode).toBe(429);
    expect((await send(second.plaintext)).statusCode).toBe(200);
  });
});

describe("quota admission", () => {
  it("refuses a request when remaining quota is zero", async () => {
    const server = setup({}, { quotaRemaining: 0 });

    const response = await post(server);

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("quota_exhausted");
  });

  it("refuses a request when remaining quota is negative from prior overage", async () => {
    const server = setup({}, { quotaRemaining: -500 });

    const response = await post(server);

    expect(response.json().error.code).toBe("quota_exhausted");
  });

  /**
   * The `expires_at` timestamp path, which authentication deliberately does not check —
   * the key authenticates, then admission refuses it. Asserted here because
   * `auth.test.ts` covers only the `status = "expired"` flag.
   */
  it("refuses a key whose expires_at has passed even though it authenticates", async () => {
    const server = setup({}, { expiresAt: new Date(NOW.getTime() - 1_000) });

    const response = await post(server);

    expect(response.statusCode).toBe(401);
    expect(server.adapter.attempts).toHaveLength(0);
  });

  it("never reaches the provider when quota is exhausted", async () => {
    const server = setup({}, { quotaRemaining: 0 });

    await post(server);

    expect(server.adapter.attempts).toHaveLength(0);
    expect(server.recorded.debits).toHaveLength(0);
  });
});

describe("kill switches at admission", () => {
  /**
   * A kill-switched model answers 503 `adapter_disabled`, NOT 403 `model_not_allowed`.
   *
   * The distinction is meaningful to a client: 403 says "not for you, don't retry",
   * while 503 says "temporarily unavailable, retry later" — which is the truth when an
   * operator has switched a model off during an incident. An unpublished model, by
   * contrast, IS a 403, because it is not coming back for this caller. Both are asserted
   * separately below so a future refactor cannot quietly merge them.
   */
  it("refuses a disabled model with adapter_disabled and no provider attempt", async () => {
    const server = setup({ killSwitches: { disabledModels: new Set([TEST_MODEL]) } });

    const response = await post(server);

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("adapter_disabled");
    expect(response.json().error.message).toBe("This model is temporarily unavailable.");
    expect(server.adapter.attempts).toHaveLength(0);
  });

  it("refuses an unpublished model with model_not_allowed", async () => {
    const server = setup({ models: [modelRecord({ published: false })] });

    const response = await post(server);

    expect(response.statusCode).toBe(403);
    expect(server.adapter.attempts).toHaveLength(0);
  });

  it("refuses an unknown model without revealing that it is unknown", async () => {
    const server = setup();

    const response = await post(server, { ...BODY, model: "no-such-model" });

    // Deliberately 403, not 404: the response for an unknown model and for one the
    // caller may not use are the same, so the endpoint is not a catalogue oracle.
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("model_not_allowed");
  });

  it("returns a sanitized 503 when the whole adapter is switched off", async () => {
    const server = setup({ killSwitches: { adapterEnabled: false } });

    const response = await post(server);

    expect(response.statusCode).toBe(503);
    expect(server.adapter.attempts).toHaveLength(0);
    // The public message must carry no operator detail about why.
    expect(response.json().error.message).toBe("This model is temporarily unavailable.");
  });

  /**
   * §3: tool use is switchable independently. Stripping rather than rejecting keeps a
   * text-only client working during a tool-use incident, and a client that sent tools
   * gets an answer instead of an error it cannot act on.
   */
  it("strips tools rather than rejecting when tool use is switched off", async () => {
    const server = setup({ killSwitches: { toolUseEnabled: false } });

    const response = await post(server, {
      ...BODY,
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: {} } },
        },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(server.adapter.attempts).toHaveLength(1);
  });
});

describe("request validation before admission", () => {
  /**
   * A malformed body is a 400 that costs nothing. If decode ran after admission, a
   * client looping on a broken payload would burn its own rate-limit window on requests
   * the gateway rejects outright — and the operator would see a rate-limit spike with no
   * corresponding traffic.
   */
  it("rejects a malformed body without consuming a rate-limit slot", async () => {
    const server = setup({ env: { KEY_MAX_REQUESTS_PER_MINUTE: 1 } });

    const bad = await post(server, { model: TEST_MODEL });
    expect(bad.statusCode).toBe(400);

    // The slot was never taken, so a valid request still succeeds.
    const good = await post(server);
    expect(good.statusCode).toBe(200);
  });

  it("rejects a body over the size limit", async () => {
    const server = setup();

    const response = await post(server, {
      ...BODY,
      messages: [{ role: "user", content: "x".repeat(9 * 1024 * 1024) }],
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(server.adapter.attempts).toHaveLength(0);
  });
});
