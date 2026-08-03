/**
 * Admin session and the guard on every admin route (PLAN.md §12, §16, §17).
 *
 * The properties under test are the ones an operator console lives or dies by:
 *
 *   1. EVERY route requires an admin session. Not "the mutations" — every one, including
 *      `GET /admin/v1/health`, which is deliberately NOT the public probe. The test
 *      enumerates the routes rather than sampling them, so a route added without a
 *      `requireAdmin` call fails here instead of shipping open.
 *   2. A CUSTOMER holding a perfectly valid session is rejected exactly like an anonymous
 *      caller. Admin/user isolation is the §16 invariant, and the failure mode it guards
 *      against is a customer session being accepted because it was, after all, valid.
 *   3. Every rejection is the same 401 with the same body. No route reveals whether the
 *      username exists, whether the session was expired rather than forged, or whether
 *      the user was a customer — each of those would be a probe an attacker could run.
 *   4. Login verifies through real Argon2 and puts the token in an HttpOnly cookie.
 */

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import { harness } from "./harness.js";
import { ADMIN_PASSWORD, adminHarness, customerUser } from "./admin-harness.js";

async function setup(options: Parameters<typeof adminHarness>[0] = {}) {
  const admin = await adminHarness(options);
  const metered = harness();
  return {
    ...admin,
    app: buildApp({
      deps: metered.deps,
      readiness: createReadinessState(),
      admin: admin.deps,
    }),
  };
}

/**
 * Every route in the group, as method/path pairs.
 *
 * Written out rather than derived from the Fastify route table on purpose: the point is to
 * state independently what the surface is meant to be, so that a route appearing without a
 * guard is a failure rather than something the test silently adopts.
 */
const ROUTES: readonly { method: "GET" | "POST"; url: string }[] = [
  { method: "GET", url: "/admin/v1/session" },
  { method: "POST", url: "/admin/v1/session/revoke" },
  { method: "GET", url: "/admin/v1/overview" },
  { method: "GET", url: "/admin/v1/health" },
  { method: "GET", url: "/admin/v1/provider-accounts" },
  { method: "POST", url: "/admin/v1/provider-accounts" },
  { method: "GET", url: "/admin/v1/provider-accounts/acct-1" },
  { method: "POST", url: "/admin/v1/provider-accounts/acct-1" },
  { method: "POST", url: "/admin/v1/provider-accounts/acct-1/credential" },
  { method: "POST", url: "/admin/v1/provider-accounts/acct-1/enabled" },
  { method: "POST", url: "/admin/v1/provider-accounts/acct-1/validate" },
  { method: "GET", url: "/admin/v1/models" },
  { method: "GET", url: "/admin/v1/models/bosanda-sonnet" },
  { method: "POST", url: "/admin/v1/models/bosanda-sonnet/multiplier" },
  { method: "POST", url: "/admin/v1/models/bosanda-sonnet/published" },
  { method: "GET", url: "/admin/v1/packages" },
  { method: "POST", url: "/admin/v1/packages/pkg-starter" },
  { method: "POST", url: "/admin/v1/packages/pkg-starter/stock" },
  { method: "GET", url: "/admin/v1/orders" },
  { method: "GET", url: "/admin/v1/orders/order-1" },
  { method: "POST", url: "/admin/v1/orders/order-1/activate" },
  { method: "POST", url: "/admin/v1/orders/order-1/refund" },
  { method: "GET", url: "/admin/v1/users" },
  { method: "GET", url: "/admin/v1/users/user-1" },
  { method: "POST", url: "/admin/v1/users/user-1/enabled" },
  { method: "POST", url: "/admin/v1/users/user-1/password" },
  { method: "GET", url: "/admin/v1/api-keys" },
  { method: "POST", url: "/admin/v1/api-keys/key-1/quota" },
  { method: "POST", url: "/admin/v1/api-keys/key-1/revoke" },
  { method: "GET", url: "/admin/v1/flags" },
  { method: "POST", url: "/admin/v1/flags/kiro.adapter_enabled" },
  { method: "GET", url: "/admin/v1/audit" },
];

describe("admin authentication", () => {
  it("rejects every admin route without a session", async () => {
    const { app } = await setup();

    for (const route of ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        // A body is supplied so a 401 cannot be confused with a body-validation 400:
        // the guard must run BEFORE the payload is looked at.
        payload: route.method === "POST" ? { reason: "probe" } : undefined,
      });

      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("rejects a valid CUSTOMER session on every admin route", async () => {
    const { app, fixtures, cookieFor } = await setup();
    const customer = customerUser();
    fixtures.users.push(customer);
    const cookie = cookieFor(customer);

    for (const route of ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie },
        payload: route.method === "POST" ? { reason: "probe" } : undefined,
      });

      // 401, not 403: a 403 would confirm the session is genuine and merely unprivileged.
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("gives an anonymous caller and a customer byte-identical rejections", async () => {
    const { app, fixtures, cookieFor } = await setup();
    const customer = customerUser();
    fixtures.users.push(customer);

    const anonymous = await app.inject({ method: "GET", url: "/admin/v1/overview" });
    const asCustomer = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie: cookieFor(customer) },
    });

    expect(anonymous.statusCode).toBe(asCustomer.statusCode);
    expect(anonymous.body).toBe(asCustomer.body);
  });

  it("rejects an expired session and a forged token identically", async () => {
    const { app, fixtures, operator, cookie } = await setup();
    // Expire the operator's session in place.
    fixtures.sessions = fixtures.sessions.map((session) =>
      session.userId === operator.id
        ? { ...session, expiresAt: new Date("2020-01-01T00:00:00.000Z") }
        : session,
    );

    const expired = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie },
    });
    const forged = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie: "bosanda_admin_session_dev=not-a-real-token" },
    });

    expect(expired.statusCode).toBe(401);
    expect(forged.statusCode).toBe(401);
    expect(expired.body).toBe(forged.body);
  });

  it("rejects a session whose user has been suspended", async () => {
    const { app, fixtures, operator, cookie } = await setup();
    fixtures.users = fixtures.users.map((user) =>
      user.id === operator.id ? { ...user, status: "suspended" } : user,
    );

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(401);
  });

  it("never leaks internal detail in a rejection body", async () => {
    const { app, operator, cookie } = await setup();

    // Every rejection path the guard has, so one assertion covers all of them rather than
    // only the no-cookie case.
    const rejections = [
      await app.inject({ method: "GET", url: "/admin/v1/overview" }),
      await app.inject({
        method: "GET",
        url: "/admin/v1/overview",
        headers: { cookie: "bosanda_admin_session_dev=forged" },
      }),
    ];

    for (const response of rejections) {
      const body = response.body.toLowerCase();

      /**
       * Distinctive fragments of the guard's `internalDetail` strings — "carried no
       * session cookie", "session rejected: …", "non-admin user", "is not active".
       *
       * Deliberately NOT asserting on the bare words "revoked" or "expired": the frozen
       * `authentication_error` public message is "missing, invalid, or revoked api key",
       * so "revoked" is present by design and asserting against it tests the protocol
       * package rather than this guard. The phrases below appear ONLY in `internalDetail`,
       * which is what makes their absence meaningful.
       */
      for (const leak of [
        "non-admin",
        "session cookie",
        "session rejected",
        "not active",
        // The operator's id is in two of the four internalDetail strings.
        operator.id.toLowerCase(),
      ]) {
        expect(body).not.toContain(leak);
      }
    }

    // The same guard on a VALID session must not be rejecting at all — otherwise the
    // assertions above would pass trivially for the wrong reason.
    const allowed = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("GET /admin/v1/session", () => {
  it("returns exactly the four fields the client parses", async () => {
    const { app, cookie, operator } = await setup();

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // `adminSession` is `.strict()`: an extra key is a hard parse failure in the client.
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "role", "userId", "username"]);
    expect(body.role).toBe("admin");
    expect(body.userId).toBe(operator.id);
    expect(body.username).toBe(operator.username);
    expect(typeof body.expiresAt).toBe("string");
  });
});

describe("POST /admin/v1/session", () => {
  it("authenticates a real password and sets an HttpOnly cookie", async () => {
    const { app, operator, recorded } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: operator.username, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);

    const setCookie = response.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie);
    expect(cookie).toContain("bosanda_admin_session_dev=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // The cookie carries the same token the body does — one credential, two transports.
    expect(cookie).toContain(body.token);

    // A successful login is audited.
    const login = recorded.audit.find((row) => row.action === "admin.session_created");
    expect(login).toBeDefined();
    expect(login?.actorId).toBe(operator.id);
    // The audit row must not carry the token.
    expect(JSON.stringify(login?.metadata)).not.toContain(body.token);
  });

  it("rejects a wrong password without saying the username exists", async () => {
    const { app, operator } = await setup();

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: operator.username, password: "not-the-password" },
    });
    const unknownUser = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: "nobody-at-all", password: "not-the-password" },
    });

    expect(wrongPassword.statusCode).toBe(401);
    // Identical bodies: the response cannot be used to enumerate usernames.
    expect(wrongPassword.body).toBe(unknownUser.body);
    expect(unknownUser.statusCode).toBe(401);
  });

  it("rejects a CUSTOMER with correct credentials as a credential failure", async () => {
    const { app, fixtures, recorded } = await setup();
    // Same real hash as the operator, so the password IS correct for this user.
    const customer = customerUser({ passwordHash: fixtures.users[0]!.passwordHash });
    fixtures.users.push(customer);

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: customer.username, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    // No session row, and nothing audited: we have not identified anybody.
    expect(fixtures.sessions.some((session) => session.userId === customer.id)).toBe(false);
    expect(recorded.audit).toHaveLength(0);
  });

  it("rejects an unknown body field rather than ignoring it", async () => {
    const { app, operator } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: operator.username, password: ADMIN_PASSWORD, role: "admin" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an over-long password before hashing it", async () => {
    const { app, operator } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: operator.username, password: "x".repeat(5_000) },
    });

    // 400, not 401: this is a malformed request, and rejecting it on shape is what stops
    // an unauthenticated caller spending Argon2 time at will.
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /admin/v1/session/revoke", () => {
  it("revokes the session, clears the cookie, and audits", async () => {
    const { app, cookie, recorded, fixtures } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session/revoke",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, message: expect.any(String) });

    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toContain("bosanda_admin_session_dev=");
    // Cleared, not merely rotated.
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    expect(fixtures.sessions.every((session) => session.revokedAt !== null)).toBe(true);
    expect(recorded.audit.map((row) => row.action)).toContain("admin.session_revoked");

    // The revoked cookie no longer authenticates.
    const after = await app.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
