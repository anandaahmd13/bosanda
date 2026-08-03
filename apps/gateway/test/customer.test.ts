import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import { harness } from "./harness.js";
import {
  customerHarness,
  customerKey,
  customerOrder,
  CUSTOMER_PASSWORD,
} from "./customer-harness.js";

async function setup() {
  const customer = await customerHarness();
  const app = buildApp({
    deps: harness().deps,
    readiness: createReadinessState(),
    customer: customer.deps,
  });
  return { ...customer, app };
}

describe("customer session and ownership", () => {
  it("rejects unauthenticated customer reads", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/v1/account" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the account for the session owner", async () => {
    const { app, cookie, user } = await setup();
    const response = await app.inject({ method: "GET", url: "/v1/account", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: user.id,
      username: user.username,
      role: "user",
    });
    expect(response.body).not.toContain("passwordHash");
  });

  it("registers and logs in without returning a session token in JSON", async () => {
    const { app } = await setup();
    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "new-user", password: CUSTOMER_PASSWORD },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toEqual({ ok: true });
    expect(String(registered.headers["set-cookie"])).toContain("HttpOnly");

    const loggedIn = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "new-user", password: CUSTOMER_PASSWORD },
    });
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json()).toEqual({ ok: true });
    expect(String(loggedIn.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("rejects wrong credentials without exposing account existence", async () => {
    const { app, user } = await setup();
    const known = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: user.username, password: "wrong-password" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "missing-user", password: "wrong-password" },
    });
    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(known.body).toBe(unknown.body);
  });
});

describe("customer catalogue and keys", () => {
  it("hides sales when no published model exists", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/v1/packages" });
    expect(response.statusCode).toBe(200);
    expect(response.json().salesEnabled).toBe(false);
  });

  it("returns masked keys only", async () => {
    const { app, cookie, fixtures, user } = await setup();
    const key = customerKey(user.id, { encryptedKey: "SECRET-CIPHERTEXT" });
    fixtures.keys.push(key);
    const response = await app.inject({ method: "GET", url: "/v1/keys", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("SECRET-CIPHERTEXT");
    expect(response.json().keys[0]).toMatchObject({ keyId: key.id, status: "active" });
  });

  it("does not reveal another user's key", async () => {
    const { app, cookie, fixtures } = await setup();
    const foreign = customerKey("01HQFOREIGNUSER00000000001");
    fixtures.keys.push(foreign);
    const response = await app.inject({
      method: "POST",
      url: `/v1/keys/${foreign.id}/reveal`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires a POST for key reveal", async () => {
    const { app, cookie } = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/v1/keys/key/reveal",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("customer orders", () => {
  it("creates an order from server-side package truth and audits it", async () => {
    const { app, cookie, fixtures } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { cookie },
      payload: { packageId: "pkg-starter", intent: "new_key", targetKeyId: null, priceIdr: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      packageId: "pkg-starter",
      priceIdr: 50_000,
      tokens: 1_000_000,
    });
    expect(fixtures.audits.map((row) => row.action)).toContain("order.created");
  });

  it("rejects a top-up without an owned target", async () => {
    const { app, cookie } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { cookie },
      payload: { packageId: "pkg-starter", intent: "top_up", targetKeyId: "foreign" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists and polls only the owner's orders", async () => {
    const { app, cookie, fixtures, user } = await setup();
    const mine = customerOrder(user.id);
    fixtures.orders.push(mine, customerOrder("01HQFOREIGNUSER00000000001"));
    const list = await app.inject({ method: "GET", url: "/v1/orders", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().orders).toHaveLength(1);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/orders/${mine.id}/status`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().orderId).toBe(mine.id);
  });

  it("cancels a pending order and releases its reservation", async () => {
    const { app, cookie, fixtures, user } = await setup();
    const order = customerOrder(user.id);
    fixtures.orders.push(order);
    const response = await app.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/cancel`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(fixtures.stock.get("pkg-starter")?.reserved).toBe(0);
    expect(fixtures.audits.map((row) => row.action)).toContain("order.cancelled");
  });
});
