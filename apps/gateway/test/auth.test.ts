/**
 * Authentication over real HTTP (PLAN.md §12).
 *
 * The unit tests in `auth.ts`'s own suite already cover `decideKeyAuth`. What these
 * assert is the property that only shows up at the HTTP boundary: **every failure
 * class is indistinguishable to the caller.** A revoked key, an expired key, a key
 * that never existed, a suspended user, and a missing header must produce byte-identical
 * responses. Any difference — a distinct code, a different message, a measurably
 * different latency — is an oracle that turns key enumeration into a guessing game the
 * attacker can win.
 *
 * So the tests below compare whole response bodies against each other, not against a
 * hand-written expectation. That way a future change which adds a helpful
 * "key expired" hint fails here rather than shipping.
 */

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import { harness, testKey, NOW } from "./harness.js";

/** A minimal valid OpenAI body — enough to get past decode, if auth ever let it. */
const BODY = { model: "bosanda-sonnet", messages: [{ role: "user", content: "hi" }] };

function app(options: Parameters<typeof harness>[0] = {}) {
  const built = harness(options);
  return { ...built, app: buildApp({ deps: built.deps, readiness: createReadinessState() }) };
}

describe("gateway authentication", () => {
  it("rejects a request with no credentials", async () => {
    const { app: server } = app();

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        message: "Missing, invalid, or revoked API key.",
        type: "authentication_error",
        param: null,
        code: "authentication_error",
      },
    });
  });

  /**
   * Both header forms must work, because the two official SDKs disagree: the Anthropic
   * client sends `x-api-key` and the OpenAI client sends `Authorization: Bearer`. A
   * gateway that accepted only one would fail for half its callers with a 401 that
   * looks like a bad key.
   */
  it("accepts the key via x-api-key and via Authorization: Bearer identically", async () => {
    const built = harness();
    const key = testKey(built.keyring);
    const withKey = app({ keys: [key] });

    const viaHeader = await withKey.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": key.plaintext },
    });
    const viaBearer = await withKey.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${key.plaintext}` },
    });

    expect(viaHeader.statusCode).toBe(200);
    expect(viaBearer.statusCode).toBe(200);
    expect(viaHeader.json()).toEqual(viaBearer.json());
  });

  /**
   * The no-oracle property, stated as one test.
   *
   * Each case is a DIFFERENT internal reason. If any of them produces a distinct
   * response, `new Set` grows past one entry and this fails with the differing bodies
   * visible in the diff.
   */
  it("returns an identical 401 for every failure class", async () => {
    const probe = harness();
    const valid = testKey(probe.keyring);

    const cases: { name: string; headers: Record<string, string>; keys: (typeof valid)[] }[] = [
      { name: "missing header", headers: {}, keys: [valid] },
      { name: "malformed header", headers: { authorization: "Token abc" }, keys: [valid] },
      { name: "not a bosanda key", headers: { "x-api-key": "sk-openai-style-key" }, keys: [valid] },
      {
        name: "unknown key",
        headers: { "x-api-key": testKey(probe.keyring).plaintext },
        keys: [],
      },
      {
        name: "revoked key",
        headers: { "x-api-key": valid.plaintext },
        keys: [testKey(probe.keyring, { status: "revoked", revokedAt: NOW }, {})],
      },
    ];

    const seen = new Map<string, string>();
    for (const testCase of cases) {
      const server = app({ keys: testCase.keys });
      const response = await server.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: testCase.headers,
      });
      expect(response.statusCode, testCase.name).toBe(401);
      seen.set(testCase.name, response.body);
    }

    expect(new Set(seen.values()).size, `differing bodies: ${JSON.stringify([...seen])}`).toBe(1);
  });

  /**
   * Expiry here means `status = "expired"`, which is the flag the worker's expiry sweep
   * sets. The `expires_at` TIMESTAMP is deliberately not checked at this layer —
   * `canStartRequest` in `@bosanda/metering` owns it, so a key whose expiry passed
   * seconds ago still authenticates and is then refused at admission. That split is
   * intentional (`decisions.ts`: "this layer does not duplicate it") and the
   * timestamp path is asserted in `limits.test.ts`, not here.
   */
  it("rejects an expired key and a suspended user with the same 401", async () => {
    const probe = harness();

    const expired = testKey(probe.keyring, { status: "expired" });
    const suspended = testKey(probe.keyring, {}, { userStatus: "suspended" });

    const first = await app({ keys: [expired] }).app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": expired.plaintext },
    });
    const second = await app({ keys: [suspended] }).app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": suspended.plaintext },
    });

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(first.body).toBe(second.body);
  });

  /**
   * An array-valued header is rejected rather than having its first element used.
   *
   * Header smuggling: a proxy that folds two `x-api-key` headers into an array would
   * otherwise let a caller send a valid key alongside a second value and control which
   * one is checked versus which one is logged.
   */
  it("rejects duplicated api key headers", async () => {
    const built = harness();
    const key = testKey(built.keyring);
    const server = app({ keys: [key] });

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": [key.plaintext, key.plaintext] as unknown as string },
    });

    expect(response.statusCode).toBe(401);
  });

  it("never echoes the api key in a response body", async () => {
    const built = harness();
    const key = testKey(built.keyring);
    const server = app({ keys: [] });

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": key.plaintext },
    });

    expect(response.body).not.toContain(key.plaintext);
    expect(response.body).not.toContain(key.authenticated.key.prefix);
  });

  it("records last-used for a successful authentication", async () => {
    const built = harness();
    const key = testKey(built.keyring);
    const server = app({ keys: [key] });

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": key.plaintext },
    });

    expect(response.statusCode).toBe(200);
    // Fire-and-forget, so yield once before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.recorded.touched).toContain(key.authenticated.key.id);
  });

  it("does not authenticate the health endpoint", async () => {
    const { app: server } = app();

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });
});
