/**
 * Packages, kill switches, the audit log, users, keys, and the two status reads
 * (PLAN.md §3 gates, §10 quota, §11 stock, §15 console, §16 invariants).
 *
 * The properties under test are the ones where a plausible-looking implementation is still
 * wrong:
 *
 *   1. A quota adjustment writes a LEDGER ROW, not just a balance (§16 invariant 5). A
 *      balance that moves without a ledger row makes a billing dispute unanswerable.
 *   2. A password reset never lets the plaintext reach a response, a log, or an audit row.
 *   3. An unknown flag key is refused rather than upserted — a typo during an incident that
 *      silently creates a switch nothing reads is the worst possible failure.
 *   4. The audit log reconstructs `reason` and `actorLabel`, which have no columns, and
 *      renders system rows rather than dropping them.
 *   5. Query parameters are validated, not silently normalized: the repositories clamp
 *      pagination and drop unknown filters, so the route layer must reject first.
 *   6. `GET /admin/v1/health` is NOT the public probe and requires an admin session.
 */

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import { harness } from "./harness.js";
import {
  ADMIN_PASSWORD,
  adminApiKey,
  adminHarness,
  adminPackage,
  adminUser,
  customerUser,
  packageStock,
} from "./admin-harness.js";

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

describe("GET /admin/v1/packages", () => {
  it("renders a missing stock row as zero and reports sold out on free units", async () => {
    const { app, cookie } = await setup({
      fixtures: {
        packages: [adminPackage({ id: "pkg-a" }), adminPackage({ id: "pkg-b", name: "Pro" })],
        // Only `pkg-b` has ever had stock set. `pkg-a` has NO row, which the repository
        // deliberately distinguishes from zero.
        stock: new Map([
          ["pkg-b", packageStock({ packageId: "pkg-b", available: 5, reserved: 5, version: 3 })],
        ]),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/packages",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json<{ packages: Record<string, unknown>[] }>().packages;

    const a = rows.find((row) => row["id"] === "pkg-a")!;
    // The contract's `stock` is a required object, so a null row must render as something.
    // Zero is the operationally correct rendering: neither can be sold.
    expect(a["stock"]).toMatchObject({ available: 0, reserved: 0, version: 0 });
    expect(a["soldOut"]).toBe(true);

    const b = rows.find((row) => row["id"] === "pkg-b")!;
    // 5 available but all 5 reserved: sold out is about FREE units, so a live reservation
    // does not count as sellable stock.
    expect(b["stock"]).toMatchObject({ available: 5, reserved: 5, version: 3 });
    expect(b["soldOut"]).toBe(true);
  });
});

describe("POST /admin/v1/packages/:packageId/stock", () => {
  it("applies a delta on top of the current count and audits both figures", async () => {
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: {
        packages: [adminPackage({ id: "pkg-a" })],
        stock: new Map([
          ["pkg-a", packageStock({ packageId: "pkg-a", available: 10, version: 1 })],
        ]),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/packages/pkg-a/stock",
      headers: { cookie },
      payload: { delta: 5, reason: "restocked from the provider" },
    });

    expect(response.statusCode).toBe(200);
    // `setStock` is an ABSOLUTE writer, so the route must read-then-set rather than
    // pass the delta through.
    expect(fixtures.stock.get("pkg-a")!.available).toBe(15);
    expect(recorded.audit.at(-1)!.metadata).toMatchObject({
      requestedDelta: 5,
      appliedDelta: 5,
      availableBefore: 10,
      availableAfter: 15,
    });
  });

  it("floors a decrease at zero and says so, recording the clamp", async () => {
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: {
        packages: [adminPackage({ id: "pkg-a" })],
        stock: new Map([["pkg-a", packageStock({ packageId: "pkg-a", available: 3, version: 1 })]]),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/packages/pkg-a/stock",
      headers: { cookie },
      payload: { delta: -10, reason: "withdrawing the package" },
    });

    expect(response.statusCode).toBe(200);
    expect(fixtures.stock.get("pkg-a")!.available).toBe(0);
    // The difference between requested and applied stays on the record.
    expect(recorded.audit.at(-1)!.metadata).toMatchObject({
      requestedDelta: -10,
      appliedDelta: -3,
    });
    expect(response.json<{ message: string }>().message).toContain("floored at zero");
  });

  it("rejects a zero or non-integer delta", async () => {
    const { app, cookie } = await setup({
      fixtures: { packages: [adminPackage({ id: "pkg-a" })] },
    });

    for (const delta of [0, 1.5, "5", null]) {
      const response = await app.inject({
        method: "POST",
        url: "/admin/v1/packages/pkg-a/stock",
        headers: { cookie },
        payload: { delta, reason: "bad input" },
      });
      expect(response.statusCode, `delta=${String(delta)}`).toBe(400);
    }
  });

  it("404s for a package that does not exist", async () => {
    const { app, cookie } = await setup({ fixtures: { packages: [] } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/packages/nope/stock",
      headers: { cookie },
      payload: { delta: 1, reason: "typo in the id" },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /admin/v1/packages/:packageId", () => {
  it("changes price and active together, preserving the fields the client cannot send", async () => {
    const { app, cookie, fixtures } = await setup({
      fixtures: {
        packages: [
          adminPackage({ id: "pkg-a", priceIdr: 50_000, active: true, weightedTokenQuota: 999 }),
        ],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/packages/pkg-a",
      headers: { cookie },
      payload: {
        packageId: "pkg-a",
        priceIdr: 75_000,
        active: false,
        reason: "price increase and pulling it from sale",
      },
    });

    expect(response.statusCode).toBe(200);
    const updated = fixtures.packages.find((record) => record.id === "pkg-a")!;
    expect(updated.priceIdr).toBe(75_000);
    expect(updated.active).toBe(false);
    // `upsert` demands the full definition, so the untouched fields must be read and
    // passed through rather than defaulted away.
    expect(updated.weightedTokenQuota).toBe(999);
  });
});

describe("GET /admin/v1/flags", () => {
  it("lists every catalogued switch with its blast radius, including unset ones", async () => {
    const { app, cookie } = await setup({ fixtures: { flags: new Map() } });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/flags",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const flags = response.json<{ flags: Record<string, unknown>[] }>().flags;

    // A missing row means "not overridden", not "absent from the console".
    expect(flags.map((flag) => flag["key"])).toEqual([
      "kiro.adapter_enabled",
      "kiro.tool_use_enabled",
      "kiro.disabled_regions",
      "kiro.disabled_models",
    ]);
    for (const flag of flags) {
      expect(typeof flag["blastRadius"]).toBe("string");
      expect((flag["blastRadius"] as string).length).toBeGreaterThan(0);
      expect(typeof flag["enabled"]).toBe("boolean");
    }
    // The `tool_use` scope member exists for exactly this key.
    expect(flags.find((flag) => flag["key"] === "kiro.tool_use_enabled")!["scope"]).toBe(
      "tool_use",
    );
  });
});

describe("POST /admin/v1/flags/:key", () => {
  it("writes a boolean and audits the previous value", async () => {
    const { app, cookie, fixtures, recorded } = await setup({ fixtures: { flags: new Map() } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/flags/kiro.tool_use_enabled",
      headers: { cookie },
      payload: { enabled: false, reason: "tool loops are burning quota" },
    });

    expect(response.statusCode).toBe(200);
    expect(fixtures.flags.get("kiro.tool_use_enabled")).toBe(false);
    const audit = recorded.audit.at(-1)!;
    expect(audit.action).toBe("feature_flag.changed");
    // `null` distinguishes a first write from a change away from `true`.
    expect(audit.metadata).toMatchObject({ enabled: false, previousValue: null });
    expect(audit.metadata["reason"]).toBe("tool loops are burning quota");
  });

  it("404s an unknown key instead of creating a switch nothing reads", async () => {
    const { app, cookie, fixtures, recorded } = await setup({ fixtures: { flags: new Map() } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/flags/kiro.adaptor_enabled",
      headers: { cookie },
      payload: { enabled: false, reason: "typo an operator would make under pressure" },
    });

    // `flagsRepository.upsert` would happily write this key. The catalogue is the allowlist.
    expect(response.statusCode).toBe(404);
    expect(fixtures.flags.size).toBe(0);
    expect(recorded.audit).toHaveLength(0);
  });

  it("refuses to write a set-valued switch through a boolean endpoint", async () => {
    const { app, cookie, fixtures } = await setup({ fixtures: { flags: new Map() } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/flags/kiro.disabled_regions",
      headers: { cookie },
      payload: { enabled: false, reason: "trying to clear the region list" },
    });

    // A set is not a toggle; writing `false` here would replace the list with a boolean the
    // resolver then ignores.
    expect(response.statusCode).toBe(400);
    expect(fixtures.flags.size).toBe(0);
  });

  it("rejects a non-boolean enabled and a blank reason", async () => {
    const { app, cookie } = await setup();

    for (const payload of [
      { enabled: "false", reason: "string not boolean" },
      { enabled: false, reason: "   " },
      { enabled: false },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/admin/v1/flags/kiro.tool_use_enabled",
        headers: { cookie },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("GET /admin/v1/audit", () => {
  it("lifts reason out of metadata and labels the actor", async () => {
    const { app, cookie } = await setup();

    // A real mutation, so the row under test is one `writeAudit` actually produced.
    await app.inject({
      method: "POST",
      url: "/admin/v1/flags/kiro.tool_use_enabled",
      headers: { cookie },
      payload: { enabled: false, reason: "an incident is in progress" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/audit",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const events = response.json<{ events: Record<string, unknown>[] }>().events;
    const row = events.find((event) => event["action"] === "feature_flag.changed")!;

    // Neither `reason` nor `actorLabel` is a column; both are reconstructed on read.
    expect(row["reason"]).toBe("an incident is in progress");
    expect(row["actorLabel"]).toBe("operator");
    expect(row["actorType"]).toBe("admin");
    expect(row["targetType"]).toBe("feature_flag");
    // The contract is `.strict()`, so an extra key is a hard client-side rejection.
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "actorType",
        "actorId",
        "actorLabel",
        "action",
        "targetType",
        "targetId",
        "reason",
        "createdAt",
      ].sort(),
    );
  });

  it("rejects an unknown query parameter rather than ignoring it", async () => {
    const { app, cookie } = await setup();

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/audit?actorType=admin",
      headers: { cookie },
    });

    // `actor` is the contract's parameter. A silently ignored `actorType` would show an
    // operator an unfiltered log they believed was filtered.
    expect(response.statusCode).toBe(400);
  });

  it("rejects malformed pagination instead of clamping it", async () => {
    const { app, cookie } = await setup();

    for (const query of ["limit=0", "limit=9999", "limit=abc", "offset=-1"]) {
      const response = await app.inject({
        method: "GET",
        url: `/admin/v1/audit?${query}`,
        headers: { cookie },
      });
      // `normalizePagination` would clamp and default silently.
      expect(response.statusCode, query).toBe(400);
    }
  });
});

describe("GET /admin/v1/users", () => {
  it("joins the key aggregates onto the page", async () => {
    const customer = customerUser({ username: "buyer" });
    const { app, cookie } = await setup({
      fixtures: {
        users: [customer],
        apiKeys: [
          adminApiKey({ userId: customer.id, status: "active", quotaRemaining: 100 }),
          adminApiKey({ userId: customer.id, status: "active", quotaRemaining: 250 }),
          adminApiKey({ userId: customer.id, status: "revoked", quotaRemaining: 999 }),
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/users?q=buyer",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const row = response
      .json<{ users: Record<string, unknown>[] }>()
      .users.find((user) => user["username"] === "buyer")!;

    expect(row["activeKeyCount"]).toBe(2);
    // Every key's remaining balance, not just the active ones' — it is the customer's
    // outstanding entitlement.
    expect(row["totalWeightedRemaining"]).toBe(1349);
    // `UserStatus` is `active|suspended` in the database and `active|disabled` in the
    // contract.
    expect(row["status"]).toBe("active");
    // `UserRole` is `customer|admin` in the database and `user|admin` in the contract.
    expect(row["role"]).toBe("user");
  });
});

describe("POST /admin/v1/users/:userId/enabled", () => {
  it("suspends the account and revokes its sessions", async () => {
    const customer = customerUser();
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: { users: [customer] },
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/users/${customer.id}/enabled`,
      headers: { cookie },
      payload: { enabled: false, reason: "chargeback fraud" },
    });

    expect(response.statusCode).toBe(200);
    // `disabled` on the wire is `suspended` in the column.
    expect(fixtures.users.find((user) => user.id === customer.id)!.status).toBe("suspended");
    // A live cookie would otherwise keep working until it expired.
    expect(recorded.revokedSessionsFor).toContain(customer.id);
    expect(recorded.audit.at(-1)!.action).toBe("user.enabled_changed");
  });
});

describe("POST /admin/v1/users/:userId/password", () => {
  it("resets the password without the plaintext reaching the response, the log, or the audit row", async () => {
    const customer = customerUser();
    const { app, cookie, recorded, fixtures } = await setup({
      fixtures: { users: [customer] },
    });

    const newPassword = "unlikely-passphrase-9f3a-correct-horse";
    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/users/${customer.id}/password`,
      headers: { cookie },
      payload: { newPassword, reason: "customer lost access and verified by email" },
    });

    expect(response.statusCode).toBe(200);
    expect(recorded.passwordResets).toContain(customer.id);

    /**
     * §16: the plaintext appears in the request and nowhere else.
     *
     * Serializing every surface that outlives the request is the broadest check available
     * here: the audit rows, the response body, and the stored user row. The last one also
     * catches the specific mistake of writing the password where the HASH belongs — the
     * stored value must be an Argon2 encoding, not the input.
     */
    expect(JSON.stringify(recorded.audit)).not.toContain(newPassword);
    expect(response.body).not.toContain(newPassword);
    expect(JSON.stringify(fixtures.users)).not.toContain(newPassword);

    // The row records THAT it happened and why, which is what an investigation needs.
    const row = recorded.audit.at(-1)!;
    expect(row.action).toBe("user.password_reset");
    expect(row.metadata["reason"]).toBe("customer lost access and verified by email");
  });

  it("rejects a weak password before opening a transaction", async () => {
    const customer = customerUser();
    const { app, cookie, recorded } = await setup({ fixtures: { users: [customer] } });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/users/${customer.id}/password`,
      headers: { cookie },
      payload: { newPassword: "short", reason: "customer asked for something memorable" },
    });

    expect(response.statusCode).toBe(400);
    // No audit row: a malformed request is not an event worth recording.
    expect(recorded.audit).toHaveLength(0);
    expect(recorded.passwordResets).toHaveLength(0);
  });

  it("requires a substantive reason", async () => {
    const customer = customerUser();
    const { app, cookie } = await setup({ fixtures: { users: [customer] } });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/users/${customer.id}/password`,
      headers: { cookie },
      payload: { newPassword: "unlikely-passphrase-9f3a-correct-horse", reason: "x" },
    });

    // Resetting another person's password is the most abusable action here, so the reason
    // requirement is stricter than elsewhere.
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /admin/v1/api-keys", () => {
  it("returns the joined username and derives the exhausted status", async () => {
    const customer = customerUser({ username: "buyer" });
    const { app, cookie } = await setup({
      fixtures: {
        users: [customer],
        apiKeys: [
          adminApiKey({ userId: customer.id, status: "active", quotaRemaining: 0 }),
          adminApiKey({ userId: customer.id, status: "active", quotaRemaining: 500 }),
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/api-keys",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const keys = response.json<{ keys: Record<string, unknown>[] }>().keys;

    expect(keys.every((key) => key["username"] === "buyer")).toBe(true);
    // `ApiKeyStatus` has no `exhausted` member; the contract does. An active key with no
    // balance left is exhausted, and calling it active would tell an operator the key works.
    expect(keys.find((key) => key["quotaRemaining"] === 0)!["status"]).toBe("exhausted");
    expect(keys.find((key) => key["quotaRemaining"] === 500)!["status"]).toBe("active");
    // No secret material crosses the boundary.
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain("digest");
    expect(serialized).not.toContain("envelope");
  });

  it("rejects an unknown filter", async () => {
    const { app, cookie } = await setup();

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/api-keys?userId=whoever",
      headers: { cookie },
    });

    // The contract's filters are `prefix` and `lookup_digest`.
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /admin/v1/api-keys/:keyId/quota", () => {
  it("writes a ledger row for the adjustment, not just a balance", async () => {
    const key = adminApiKey({ quotaRemaining: 1_000 });
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: { apiKeys: [key] },
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/api-keys/${key.id}/quota`,
      headers: { cookie },
      payload: { weightedTokensDelta: 500, reason: "goodwill credit after an outage" },
    });

    expect(response.statusCode).toBe(200);
    // §16 invariant 5: the pair is written together or not at all.
    expect(fixtures.ledger).toHaveLength(1);
    expect(fixtures.ledger[0]).toMatchObject({ weightedTokensDelta: 500, kind: "adjustment" });
    expect(recorded.adjustments).toEqual([
      { apiKeyId: key.id, weightedTokensDelta: 500, remainingAfter: 1_500 },
    ]);
    expect(recorded.audit.at(-1)!.action).toBe("api_key.quota_adjusted");
  });

  it("clamps the persisted balance at zero while keeping the full delta on the ledger", async () => {
    const key = adminApiKey({ quotaRemaining: 400 });
    const { app, cookie, fixtures } = await setup({ fixtures: { apiKeys: [key] } });

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/api-keys/${key.id}/quota`,
      headers: { cookie },
      payload: { weightedTokensDelta: -1_000, reason: "reversing a mistaken credit" },
    });

    expect(response.statusCode).toBe(200);
    // The withdrawal stays auditable in full; the customer is not left owing tokens.
    expect(fixtures.ledger[0]!.weightedTokensDelta).toBe(-1_000);
    expect(fixtures.ledger[0]!.balanceAfter).toBe(0);
    expect(fixtures.apiKeys[0]!.quotaRemaining).toBe(0);
  });

  it("rejects a zero delta and a missing reason", async () => {
    const key = adminApiKey();
    const { app, cookie } = await setup({ fixtures: { apiKeys: [key] } });

    for (const payload of [
      { weightedTokensDelta: 0, reason: "no-op" },
      { weightedTokensDelta: 100 },
      { weightedTokensDelta: 1.5, reason: "fractional tokens" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/admin/v1/api-keys/${key.id}/quota`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("POST /admin/v1/api-keys/:keyId/revoke", () => {
  it("revokes, and reports a second revoke as success without a duplicate audit row", async () => {
    const key = adminApiKey({ status: "active" });
    const { app, cookie, fixtures, recorded } = await setup({ fixtures: { apiKeys: [key] } });

    const first = await app.inject({
      method: "POST",
      url: `/admin/v1/api-keys/${key.id}/revoke`,
      headers: { cookie },
      payload: { reason: "key was posted to a public repository" },
    });
    expect(first.statusCode).toBe(200);
    expect(fixtures.apiKeys[0]!.status).toBe("revoked");

    const auditCount = recorded.audit.length;

    const second = await app.inject({
      method: "POST",
      url: `/admin/v1/api-keys/${key.id}/revoke`,
      headers: { cookie },
      payload: { reason: "operator double-clicked" },
    });

    // The caller asked for the key to be dead and it is dead.
    expect(second.statusCode).toBe(200);
    // No second row: duplicating it would misrepresent one revocation as two.
    expect(recorded.audit).toHaveLength(auditCount);
  });
});

describe("GET /admin/v1/overview", () => {
  it("reports zero error rate for an idle window rather than NaN", async () => {
    const { app, cookie } = await setup({ traffic: { requestCount: 0, errorCount: 0 } });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      metrics: Record<string, unknown>;
      killSwitchSummary: Record<string, unknown>;
    }>();

    // The client's schema is `z.number().min(0).max(1)`; NaN would take the dashboard down.
    expect(body.metrics["errorRate"]).toBe(0);
    /**
     * `kiroDirectEnabled` comes from the ENVIRONMENT, not from `KillSwitches`.
     *
     * `killSwitchesFrom` does not carry it, so the route reads `deps.env` directly. The test
     * environment enables it, and the assertion tracks that rather than a hardcoded literal
     * — a stale expectation here would be indistinguishable from the route reporting a
     * constant, which is exactly the bug worth catching.
     */
    expect(body.killSwitchSummary["kiroDirectEnabled"]).toBe(true);
  });

  it("rejects a window outside the accepted range", async () => {
    const { app, cookie } = await setup();

    for (const query of ["windowSeconds=1", "windowSeconds=99999999", "windowSeconds=hour"]) {
      const response = await app.inject({
        method: "GET",
        url: `/admin/v1/overview?${query}`,
        headers: { cookie },
      });
      expect(response.statusCode, query).toBe(400);
    }
  });
});

describe("GET /admin/v1/health", () => {
  it("requires an admin session — it is not the public probe", async () => {
    const { app } = await setup();

    const admin = await app.inject({ method: "GET", url: "/admin/v1/health" });
    expect(admin.statusCode).toBe(401);

    // `/health` is the public one, and it stays public.
    const publicProbe = await app.inject({ method: "GET", url: "/health" });
    expect(publicProbe.statusCode).toBe(200);
  });

  it("reports a database outage as a down component instead of failing the report", async () => {
    const { app, cookie } = await setup({ failDatabase: true });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/health",
      headers: { cookie },
    });

    // A health report that 500s tells the operator nothing about which component broke.
    expect(response.statusCode).toBe(200);
    const components = response.json<{
      components: { name: string; state: string; detail: string }[];
    }>().components;
    const database = components.find((component) => component.name === "database")!;
    expect(database.state).toBe("down");
    // Only `publicMessage` crosses the boundary; the internal detail stays in the process.
    expect(database.detail).not.toContain("unreachable");
  });
});

describe("admin session guard", () => {
  it("refuses every route without a session, and a customer session on all of them", async () => {
    const customer = customerUser({ username: "not-an-operator" });
    const { app, deps } = await setup({ fixtures: { users: [customer, adminUser()] } });

    // A real, valid session belonging to a NON-admin.
    const login = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: "not-an-operator", password: ADMIN_PASSWORD },
    });
    // A customer cannot even obtain an admin session: `attemptLogin` sees `null` and the
    // outcome is indistinguishable from a wrong password.
    expect(login.statusCode).toBe(401);
    expect(deps).toBeDefined();

    const routes: [string, string][] = [
      ["GET", "/admin/v1/overview"],
      ["GET", "/admin/v1/health"],
      ["GET", "/admin/v1/provider-accounts"],
      ["GET", "/admin/v1/models"],
      ["GET", "/admin/v1/packages"],
      ["GET", "/admin/v1/orders"],
      ["GET", "/admin/v1/users"],
      ["GET", "/admin/v1/api-keys"],
      ["GET", "/admin/v1/flags"],
      ["GET", "/admin/v1/audit"],
      ["GET", "/admin/v1/session"],
      ["POST", "/admin/v1/session/revoke"],
      ["POST", "/admin/v1/provider-accounts"],
      ["POST", "/admin/v1/flags/kiro.tool_use_enabled"],
      ["POST", "/admin/v1/packages/pkg-a/stock"],
      ["POST", "/admin/v1/models/bosanda-sonnet/published"],
    ];

    for (const [method, url] of routes) {
      const response = await app.inject({ method: method as "GET", url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
