/**
 * The model catalogue endpoints (PLAN.md §8, §11).
 *
 * Three properties are worth testing here, and they are all about what the catalogue
 * does NOT say:
 *
 *   1. `upstreamId` never appears. It is the real provider model name, and publishing
 *      it tells a customer exactly which upstream Bosanda resells — the one piece of
 *      routing information the whole abstraction exists to keep private.
 *   2. An unpublished model, a model killed by a switch, and a model that never existed
 *      are indistinguishable. Otherwise the endpoint becomes a release calendar:
 *      poll it, and you learn what is coming before it ships.
 *   3. The multiplier is the exact stored decimal, not a float. `1.3000` must not print
 *      as `1.2999999999999998` — a customer reconciling their own bill against the
 *      published multiplier has to arrive at our number.
 */

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import { harness, modelRecord, testKey, testKeyring, TEST_MODEL } from "./harness.js";

/**
 * Builds a harness that already holds one valid key.
 *
 * `testKeyring` is deterministic, so the key can be minted before the harness that will
 * serve it — which avoids building the harness twice just to borrow its keyring.
 */
function setup(options: Parameters<typeof harness>[0] = {}) {
  const key = testKey(testKeyring());
  const built = harness({ ...options, keys: [key] });
  return {
    ...built,
    key,
    app: buildApp({ deps: built.deps, readiness: createReadinessState() }),
  };
}

describe("GET /v1/models", () => {
  it("lists published models in the OpenAI list shape", async () => {
    const server = setup();

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": server.key.plaintext },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(TEST_MODEL);
  });

  it("never exposes the upstream provider model id", async () => {
    const server = setup({
      models: [modelRecord({ upstreamId: "claude-sonnet-4-20250514-v1:0" })],
    });

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": server.key.plaintext },
    });

    expect(response.body).not.toContain("claude-sonnet-4-20250514-v1:0");
    expect(response.body).not.toContain("upstream");
  });

  it("omits unpublished models", async () => {
    const server = setup({
      models: [
        modelRecord({ publicId: "visible" }),
        modelRecord({ publicId: "draft", published: false }),
      ],
    });

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": server.key.plaintext },
    });

    const ids = response.json().data.map((model: { id: string }) => model.id);
    expect(ids).toEqual(["visible"]);
  });

  /**
   * A kill switch removes a model from the list without any database change. That is
   * the point of the switch: an operator disabling a broken model at 3am must not have
   * to run a migration, and the catalogue has to agree with what the request path will
   * actually accept.
   */
  it("omits models disabled by a kill switch", async () => {
    const server = setup({
      models: [modelRecord({ publicId: "ok" }), modelRecord({ publicId: "broken" })],
      killSwitches: { disabledModels: new Set(["broken"]) },
    });

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": server.key.plaintext },
    });

    const ids = response.json().data.map((model: { id: string }) => model.id);
    expect(ids).toEqual(["ok"]);
  });

  it("returns an empty list when the adapter is disabled entirely", async () => {
    const server = setup({ killSwitches: { adapterEnabled: false } });

    const response = await server.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": server.key.plaintext },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  it("requires authentication", async () => {
    const server = setup();

    const response = await server.app.inject({ method: "GET", url: "/v1/models" });

    expect(response.statusCode).toBe(401);
  });
});

describe("GET /v1/models/:id", () => {
  it("returns the model with its exact stored multiplier", async () => {
    const server = setup({
      models: [modelRecord({ multiplier: "1.3000", multiplierNumeric: 1.3 })],
    });

    const response = await server.app.inject({
      method: "GET",
      url: `/v1/models/${TEST_MODEL}`,
      headers: { "x-api-key": server.key.plaintext },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(TEST_MODEL);
    // The string, exactly as stored. A float round-trip is what this guards against.
    expect(body.multiplier).toBe("1.3000");
    expect(response.body).not.toContain("1.2999");
  });

  /**
   * The three-way indistinguishability, as one test.
   *
   * Unknown, unpublished, and switched-off must produce the same body. If they diverge,
   * `/v1/models/{guess}` becomes an oracle for unreleased model names.
   */
  it("answers 404 identically for unknown, unpublished, and disabled models", async () => {
    const server = setup({
      models: [
        modelRecord({ publicId: "published-model" }),
        modelRecord({ publicId: "draft-model", published: false }),
        modelRecord({ publicId: "killed-model" }),
      ],
      killSwitches: { disabledModels: new Set(["killed-model"]) },
    });

    const bodies: string[] = [];
    for (const id of ["never-existed", "draft-model", "killed-model"]) {
      const response = await server.app.inject({
        method: "GET",
        url: `/v1/models/${id}`,
        headers: { "x-api-key": server.key.plaintext },
      });
      expect(response.statusCode, id).toBe(404);
      bodies.push(response.body);
    }

    expect(new Set(bodies).size, `differing bodies: ${JSON.stringify(bodies)}`).toBe(1);
  });

  it("requires authentication before revealing whether a model exists", async () => {
    const server = setup();

    const response = await server.app.inject({
      method: "GET",
      url: `/v1/models/${TEST_MODEL}`,
    });

    expect(response.statusCode).toBe(401);
  });
});
