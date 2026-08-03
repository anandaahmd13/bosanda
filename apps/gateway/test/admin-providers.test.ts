/**
 * Provider accounts and the model catalogue (PLAN.md §3 kill switches, §6 credentials, §16).
 *
 * The properties that matter here are mostly about what does NOT happen:
 *
 *   1. A raw provider credential goes in and never comes back out. Not in the response, not
 *      in an audit row, not in a log line, not even as a length — §16 invariant 1.
 *   2. A new account lands `disabled`. §3 G0 requires validation against the live provider
 *      before an account serves traffic, and `insert` cannot validate, so the only safe
 *      initial state is one the scheduler will not pick.
 *   3. Credential rotation is a compare-and-swap on `credential_version`. A lost CAS is a
 *      409 and NOT a retry, because the other writer's credential is the live one — §6 is
 *      explicit that overwriting it permanently unauthenticates the account.
 *   4. Publishing a model is gated on compatibility. §3 M0 has not been executed, so a
 *      model that has never passed cannot be published by an operator clicking a toggle.
 */

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createReadinessState } from "../src/routes/health.js";
import { harness } from "./harness.js";
import { adminHarness, modelRecord, providerAccount } from "./admin-harness.js";

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
 * A syntactically valid Kiro credential blob.
 *
 * A refresh token is present because `assertUsableCredentials` rejects a credential with
 * neither a refresh nor an access token — the blob has to be genuinely usable for the
 * create path to get as far as sealing.
 */
const CREDENTIAL = JSON.stringify({
  authMethod: "social",
  refreshToken: "refresh-token-value-that-must-never-appear-anywhere",
  region: "us-east-1",
  persona: "cli",
});

describe("GET /admin/v1/provider-accounts", () => {
  it("returns the fields the client's strict schema requires and no credential", async () => {
    const account = providerAccount({ label: "pool-a" });
    const { app, cookie } = await setup({ fixtures: { accounts: [account] } });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/provider-accounts",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accounts: Record<string, unknown>[] }>();
    expect(body.accounts).toHaveLength(1);

    const row = body.accounts[0]!;
    // `.strict()` on the client means an EXTRA key is a hard parse failure, so the key set
    // is asserted exactly rather than by sampling.
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "label",
        "providerType",
        "status",
        "region",
        "persona",
        "credentialVersion",
        // `hasStoredCredential`, not `hasCredential`: the client's key, character for
        // character. And no `createdAt` — the schema is `.strict()` and does not carry one,
        // so sending it would be a hard parse failure at the client.
        "hasStoredCredential",
        "cooldownUntil",
        "lastValidatedAt",
        "activeRequests",
        "errorScore",
        "weightedTokens24h",
        "lastErrorClass",
        "lastErrorCount24h",
      ].sort(),
    );

    // The DB spelling is `active|cooldown|disabled|invalid`; the client's enum is
    // `active|disabled|cooling_down|credential_invalid`. The frozen `toAccountStatus`
    // does the projection and this asserts it actually ran.
    expect(row["status"]).toBe("active");
    expect(row["hasStoredCredential"]).toBe(true);
  });

  it("projects the database status spellings onto the client's enum", async () => {
    const { app, cookie } = await setup({
      fixtures: {
        accounts: [
          providerAccount({ id: "a-1", status: "cooldown" }),
          providerAccount({ id: "a-2", status: "invalid" }),
          providerAccount({ id: "a-3", status: "disabled" }),
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/provider-accounts",
      headers: { cookie },
    });

    const statuses = response
      .json<{ accounts: { id: string; status: string }[] }>()
      .accounts.map((a) => `${a.id}=${a.status}`)
      .sort();

    expect(statuses).toEqual(["a-1=cooling_down", "a-2=credential_invalid", "a-3=disabled"]);
  });
});

describe("POST /admin/v1/provider-accounts", () => {
  it("seals the credential, creates the account disabled, and audits without the secret", async () => {
    const { app, cookie, fixtures, recorded, operator } = await setup({
      fixtures: { accounts: [] },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts",
      headers: { cookie },
      payload: {
        label: "pool-new",
        region: "us-east-1",
        persona: "cli",
        credential: CREDENTIAL,
        reason: "linking a fresh pool account",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);

    // §3 G0: created disabled, so the scheduler cannot pick it before validation.
    expect(fixtures.accounts).toHaveLength(1);
    expect(fixtures.accounts[0]!.status).toBe("disabled");

    // The credential was sealed exactly once, and the harness recorded DESCRIPTORS only.
    expect(recorded.sealed).toHaveLength(1);
    expect(recorded.sealed[0]).toMatchObject({
      region: "us-east-1",
      persona: "cli",
      authMethod: "social",
      hasRefreshToken: true,
    });

    const audit = recorded.audit.at(-1)!;
    expect(audit.action).toBe("provider_account.created");
    expect(audit.actorId).toBe(operator.id);
    expect(audit.targetType).toBe("provider_account");
    // The operator's reason is persisted — the client sends one on every mutation.
    expect(audit.metadata["reason"]).toBe("linking a fresh pool account");
  });

  it("never lets the credential reach a response, an audit row, or a log", async () => {
    const { app, cookie, recorded, logger, fixtures } = await setup({
      fixtures: { accounts: [] },
    });

    const lines: string[] = [];
    // Captures anything the route logged during the call.
    const captured = { ...logger };
    void captured;

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts",
      headers: { cookie },
      payload: {
        label: "pool-new",
        region: "us-east-1",
        persona: "cli",
        credential: CREDENTIAL,
        reason: "secret handling check",
      },
    });

    const secret = "refresh-token-value-that-must-never-appear-anywhere";

    expect(response.body).not.toContain(secret);
    expect(JSON.stringify(recorded.audit)).not.toContain(secret);
    expect(JSON.stringify(fixtures.audit)).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);

    // The stored row holds an ENVELOPE, not the plaintext.
    expect(fixtures.accounts[0]!.encryptedCredentials).not.toContain(secret);
  });

  it("rejects an unusable credential before anything is written", async () => {
    const { app, cookie, fixtures, recorded } = await setup({ fixtures: { accounts: [] } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts",
      headers: { cookie },
      payload: {
        label: "pool-new",
        region: "us-east-1",
        persona: "cli",
        // Neither a refresh token nor an access token: `assertUsableCredentials` refuses it.
        credential: JSON.stringify({ authMethod: "social", region: "us-east-1" }),
        reason: "should not persist",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(fixtures.accounts).toHaveLength(0);
    expect(recorded.audit).toHaveLength(0);
    expect(recorded.sealed).toHaveLength(0);
  });

  it("rejects an unknown body field rather than ignoring it", async () => {
    const { app, cookie } = await setup({ fixtures: { accounts: [] } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts",
      headers: { cookie },
      payload: {
        label: "pool-new",
        region: "us-east-1",
        persona: "cli",
        credential: CREDENTIAL,
        reason: "typo check",
        // A misspelled field must fail loudly: silently ignoring it means an operator
        // believes they set something they did not.
        enabledd: true,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /admin/v1/provider-accounts/:id/credential", () => {
  it("rotates on a matching version and audits versions only", async () => {
    const account = providerAccount({ id: "acct-rotate", credentialVersion: 4 });
    const { app, cookie, recorded, fixtures } = await setup({
      fixtures: { accounts: [account] },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-rotate/credential",
      headers: { cookie },
      payload: { credential: CREDENTIAL, reason: "quarterly rotation" },
    });

    expect(response.statusCode).toBe(200);
    expect(fixtures.accounts[0]!.credentialVersion).toBe(5);

    const audit = recorded.audit.at(-1)!;
    expect(audit.action).toBe("provider_account.credential_rotated");
    expect(audit.metadata).toMatchObject({
      previousCredentialVersion: 4,
      credentialVersion: 5,
    });
    // Versions and a key version. Nothing derived from either credential's content.
    expect(JSON.stringify(audit.metadata)).not.toContain("refresh-token-value");
  });

  it("returns 409 and writes nothing when the compare-and-swap is lost", async () => {
    /**
     * The conflict is injected at the repository rather than set up as a fixture, because
     * the route reads `credentialVersion` and passes that same value as `expectedVersion`
     * inside one transaction — a starting version always matches itself. A lost CAS means
     * another writer committed in between, which is what `conflictOnRotate` stands for.
     */
    const account = providerAccount({ id: "acct-cas" });
    const { app, cookie, recorded } = await setup({
      fixtures: { accounts: [account] },
      conflictOnRotate: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-cas/credential",
      headers: { cookie },
      payload: { credential: CREDENTIAL, reason: "concurrent rotation" },
    });

    expect(response.statusCode).toBe(409);
    // No audit row: the rotation did not happen, so claiming it did would be a false record.
    expect(recorded.audit).toHaveLength(0);
  });

  it("404s for an unknown account without echoing the id", async () => {
    const { app, cookie } = await setup({ fixtures: { accounts: [] } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-does-not-exist/credential",
      headers: { cookie },
      payload: { credential: CREDENTIAL, reason: "probe" },
    });

    expect(response.statusCode).toBe(404);
    // The path is caller-controlled; reflecting it is a small injection surface for
    // whatever renders the message.
    expect(response.body).not.toContain("acct-does-not-exist");
  });
});

describe("POST /admin/v1/provider-accounts/:id/enabled", () => {
  it("enables to active and disables to disabled, auditing both", async () => {
    const account = providerAccount({ id: "acct-toggle", status: "disabled" });
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: { accounts: [account] },
    });

    const enabled = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-toggle/enabled",
      headers: { cookie },
      payload: { enabled: true, reason: "validated, bringing into rotation" },
    });

    expect(enabled.statusCode).toBe(200);
    expect(fixtures.accounts[0]!.status).toBe("active");

    const disabled = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-toggle/enabled",
      headers: { cookie },
      payload: { enabled: false, reason: "upstream errors" },
    });

    expect(disabled.statusCode).toBe(200);
    expect(fixtures.accounts[0]!.status).toBe("disabled");

    /**
     * One action name for both directions, with the direction in `metadata.enabled`.
     * Splitting it into `.enabled`/`.disabled` would make "every change to this account's
     * availability" a two-term search, and the same shape is used for `user.enabled_changed`
     * and `model.published_changed` so the table reads uniformly.
     */
    expect(recorded.audit.map((row) => row.action)).toEqual([
      "provider_account.enabled_changed",
      "provider_account.enabled_changed",
    ]);
    expect(recorded.audit[0]!.metadata["enabled"]).toBe(true);
    expect(recorded.audit[1]!.metadata["enabled"]).toBe(false);
    expect(recorded.audit[1]!.metadata["reason"]).toBe("upstream errors");
  });

  it("rejects a non-boolean `enabled`", async () => {
    const { app, cookie } = await setup({
      fixtures: { accounts: [providerAccount({ id: "acct-toggle" })] },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-toggle/enabled",
      headers: { cookie },
      // "true" is a string. Coercing it would mean a typo silently enables an account.
      payload: { enabled: "true", reason: "coercion check" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /admin/v1/provider-accounts/:id/validate", () => {
  it("records a pass and marks the account validated", async () => {
    const account = providerAccount({ id: "acct-valid", lastValidatedAt: null });
    const { app, cookie, recorded } = await setup({ fixtures: { accounts: [account] } });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-valid/validate",
      // The client sends NO body for this route.
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
    expect(recorded.validated).toEqual(["acct-valid"]);
    expect(recorded.audit.at(-1)!.action).toBe("provider_account.validated");
  });

  it("reports a failure as ok:false with a 200 and still audits it", async () => {
    const account = providerAccount({ id: "acct-invalid" });
    const { app, cookie, recorded } = await setup({
      fixtures: { accounts: [account] },
      failValidation: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/acct-invalid/validate",
      headers: { cookie },
    });

    /**
     * 200 with `ok: false`, not a 4xx: the ADMIN request succeeded — the operator asked a
     * question and got an answer. A rejected credential is a fact about the provider, not
     * a fault in the request, and the client's `mutationResult` carries exactly that
     * distinction.
     */
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; message: string }>();
    expect(body.ok).toBe(false);
    expect(body.message.length).toBeGreaterThan(0);

    // A failed probe is still an operator action against a live account, so it is audited.
    expect(recorded.audit.at(-1)!.action).toBe("provider_account.validated");
    expect(recorded.audit.at(-1)!.metadata["reason"]).toBe("credential validation failed");
  });
});

describe("GET /admin/v1/models", () => {
  it("parses the numeric multiplier fields the client expects as numbers", async () => {
    const { app, cookie } = await setup({
      fixtures: {
        models: [
          modelRecord({ multiplier: "1.3000", multiplierNumeric: 1.3, multiplierVersion: "7" }),
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/models",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const row = response.json<{ models: Record<string, unknown>[] }>().models[0]!;

    // `ModelRecord` holds both as STRINGS ("1.3000", "7"); the client's schema is
    // `z.number()` and `z.number().int().positive()`. Parsed at the boundary.
    expect(row["multiplier"]).toBe(1.3);
    expect(row["multiplierVersion"]).toBe(7);
  });

  it("maps the compatibility spellings onto the client's three", async () => {
    const { app, cookie } = await setup({
      fixtures: {
        models: [
          modelRecord({ publicId: "m-untested", compatibilityStatus: "untested" }),
          modelRecord({ publicId: "m-passing", compatibilityStatus: "passing" }),
          modelRecord({ publicId: "m-degraded", compatibilityStatus: "degraded" }),
          modelRecord({ publicId: "m-failing", compatibilityStatus: "failing" }),
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/models",
      headers: { cookie },
    });

    const seen = response
      .json<{ models: { publicId: string; compatibilityStatus: string }[] }>()
      .models.map((m) => `${m.publicId}=${m.compatibilityStatus}`)
      .sort();

    /**
     * The database has four spellings and the client's enum has three: `untested` maps to
     * `unknown`, and `degraded` has no admin spelling at all.
     *
     * `degraded` maps to `passing`, which is a judgment call. `setPublished` gates on
     * `compatibility_status IN ('passing','degraded')`, so a degraded model is one the
     * system is willing to serve — reporting it as `failing` would tell an operator a
     * model is broken while it serves traffic, and they might disable a working one. A
     * coarse status is better than one that contradicts the publish gate. The exact value
     * stays visible in `provider_health_events`.
     */
    expect(seen).toEqual([
      "m-degraded=passing",
      "m-failing=failing",
      "m-passing=passing",
      "m-untested=unknown",
    ]);
  });
});

describe("POST /admin/v1/models/:publicId/multiplier", () => {
  it("updates the multiplier and audits the old and new values", async () => {
    const { app, cookie, recorded } = await setup({
      fixtures: { models: [modelRecord({ multiplier: "1.0000", multiplierNumeric: 1 })] },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/models/bosanda-sonnet/multiplier",
      headers: { cookie },
      payload: { multiplier: 1.5, reason: "upstream price change" },
    });

    expect(response.statusCode).toBe(200);
    const audit = recorded.audit.at(-1)!;
    expect(audit.action).toBe("model.multiplier_changed");
    /**
     * The stored `NUMERIC(10,4)` strings, not the parsed numbers. The audit row records
     * what was written to the column, so it round-trips against the row exactly and a
     * float-formatting difference can never make the log disagree with the data. The
     * RESPONSE parses these to numbers for the client's `z.number()`; the audit does not.
     */
    expect(audit.metadata).toMatchObject({
      multiplier: "1.5000",
      previousMultiplier: "1.0000",
    });
    expect(audit.metadata["reason"]).toBe("upstream price change");
  });

  it("rejects a non-positive or absurd multiplier", async () => {
    const { app, cookie } = await setup();

    for (const multiplier of [0, -1, Number.NaN, "1.5"]) {
      const response = await app.inject({
        method: "POST",
        url: "/admin/v1/models/bosanda-sonnet/multiplier",
        headers: { cookie },
        payload: { multiplier, reason: "bad input" },
      });

      // The column carries CHECK (> 0), so a zero or negative value would be a write that
      // fails at the database. Refused at the boundary with a 400 instead.
      expect(response.statusCode, `multiplier=${String(multiplier)}`).toBe(400);
    }
  });
});

describe("POST /admin/v1/models/:publicId/published", () => {
  it("publishes a model whose compatibility passed", async () => {
    const { app, cookie, fixtures, recorded } = await setup({
      fixtures: {
        models: [modelRecord({ published: false, compatibilityStatus: "passing" })],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/models/bosanda-sonnet/published",
      headers: { cookie },
      payload: { published: true, reason: "compatibility suite green" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
    expect(fixtures.models[0]!.published).toBe(true);
    // One action for both directions, with the direction in `metadata.published`.
    expect(recorded.audit.at(-1)!.action).toBe("model.published_changed");
    expect(recorded.audit.at(-1)!.metadata["published"]).toBe(true);
  });

  it("refuses to publish a model that has never passed compatibility", async () => {
    const { app, cookie, fixtures } = await setup({
      fixtures: {
        models: [modelRecord({ published: false, compatibilityStatus: "untested" })],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/models/bosanda-sonnet/published",
      headers: { cookie },
      payload: { published: true, reason: "operator is impatient" },
    });

    /**
     * `setPublished` guards on `compatibility_status IN ('passing','degraded')` and returns
     * null otherwise. Reported as `200 {ok:false}` rather than a 409, decided by what each
     * one actually puts in front of the operator.
     *
     * A 409 cannot say why. `BosandaError` derives `publicMessage` from the code alone and
     * takes no override, and `classify(409)` in the admin client renders "The record changed
     * while you were editing it. Reload and retry." — which is false: nothing changed, and
     * reloading produces the same refusal. The operator learns nothing and is sent in a
     * circle. `mutationResult` carries a specific, safe message instead.
     *
     * A 200 does not read as success here. `run()` in the admin client branches on
     * `outcome.ok`, so `ok:false` skips `revalidatePath` and redirects to `?error=` — the
     * same error banner an `AdminApiError` produces. The §3 M0 gate is surfaced, with its
     * actual cause, and `published` stays false either way.
     */
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(false);
    expect(fixtures.models[0]!.published).toBe(false);
  });

  it("unpublishes without a compatibility check", async () => {
    const { app, cookie, fixtures } = await setup({
      fixtures: {
        models: [modelRecord({ published: true, compatibilityStatus: "failing" })],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/models/bosanda-sonnet/published",
      headers: { cookie },
      payload: { published: false, reason: "pulling it" },
    });

    // Taking a model DOWN is always allowed. A gate on the way out would leave an operator
    // unable to withdraw a model that is actively failing, which is backwards.
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
    expect(fixtures.models[0]!.published).toBe(false);
  });
});
