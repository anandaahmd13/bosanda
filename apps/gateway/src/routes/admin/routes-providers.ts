/**
 * Provider accounts and models (PLAN.md §6 accounts, §9 multipliers, §15 console).
 *
 * ── THE CREDENTIAL NEVER COMES BACK OUT ───────────────────────────────────
 * Two routes here accept a raw provider credential in the body: create and rotate.
 * `deps.sealCredential` is the only thing either does with it — it goes into
 * `sealCredentials` (XChaCha20-Poly1305, `provider-credentials` keyring purpose) and the
 * envelope goes to the database. The raw string is never logged, never put in an error,
 * never written to an audit row, and there is no read path that could return it:
 * `readCredentials` is deliberately absent from `AdminDeps.providerAccounts`, so a
 * handler that tried would not compile. `hasStoredCredential: true` is all a GET reports.
 *
 * `assertUsableCredentials` runs BEFORE the seal. §3 G0.1/G0.2 wants an unusable
 * credential rejected by the operator action that introduced it rather than discovered on
 * a customer's request — and its error names the defect ("credential has neither a
 * refresh token nor an access token"), never the value.
 *
 * ── WHY ROTATION READS THE VERSION FIRST ──────────────────────────────────
 * `rotateCredentials` is a compare-and-swap on `credential_version`, and §6 requires it:
 * Kiro invalidates the old refresh token when it issues a new one, so two concurrent
 * writes would leave the loser's token stored and the account permanently dead. The
 * admin path reads the current version and passes it as `expectedVersion`; a lost CAS is
 * reported as a 409 conflict, not retried, because the other writer's credential is the
 * valid one and overwriting it is the failure being prevented.
 */

import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import { ulid } from "@bosanda/shared";
import { assertUsableCredentials } from "@bosanda/provider-kiro";
import type { ProviderAccount } from "@bosanda/database";
import type { AdminDeps } from "./deps.js";
import { ADMIN_ACTIONS, auditActor, writeAudit } from "./audit.js";
import {
  invalid,
  iso,
  isoOrNull,
  ok,
  readBody,
  readBoolean,
  readMultiplier,
  readParam,
  readReason,
  readString,
  toAdminAccountStatus,
  toAdminCompatibility,
} from "./contract.js";
import { requireAdmin } from "./session.js";

/** The one provider type v1 serves (§22). Mirrors `PROVIDER_TYPE` in `dependencies.ts`. */
const PROVIDER_TYPE = "kiro";

/**
 * A region/persona default for the response only.
 *
 * `provider_accounts.region` and `.persona` are NULLABLE, while the client's schema has
 * `region: z.string().min(1)` and `persona: z.enum(["cli","ide"])` — neither admits null,
 * so a null cannot be transmitted at all and `.strict()` would reject an omitted key.
 * The fallbacks are the §6 defaults, the same ones `narrowPersona` in `dependencies.ts`
 * applies for the scheduler, so the console and the router agree about what a null means.
 * Create and update both require a region, so a null can only come from a row written
 * before this surface existed.
 */
const DEFAULT_REGION = "us-east-1";

function accountPersona(account: ProviderAccount): "cli" | "ide" {
  return account.persona === "ide" ? "ide" : "cli";
}

export function registerProviderRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /**
   * The provider table.
   *
   * Four sources are joined here because no single one has the whole row: the database
   * has identity and credential state, `deps.liveAccounts()` has in-process counters
   * (`toPersistedHealth` hardcodes both to 0 — the real values live in provider-core's
   * registries and are NOT persisted), `errorCountsSince` has the 24h error breakdown,
   * and `usage.totalsByProviderAccount` has weighted tokens. An account missing from the
   * live map reports zeroes, which is accurate for this process: it has served nothing
   * here, whatever another replica is doing.
   */
  app.get("/admin/v1/provider-accounts", async (request, reply) => {
    await requireAdmin(request, deps);

    const now = deps.clock.now();
    const since = new Date(now.getTime() - 86_400_000);

    const [accounts, errorCounts, usageTotals] = await Promise.all([
      deps.providerAccounts.listByType(PROVIDER_TYPE),
      deps.providerAccounts.errorCountsSince(PROVIDER_TYPE, since),
      deps.usage.totalsByProviderAccount(since, now),
    ]);

    const live = new Map(deps.liveAccounts().map((entry) => [entry.accountId, entry]));
    const weighted = new Map(
      usageTotals.map((entry) => [entry.providerAccountId, entry.weightedTokens]),
    );

    // Highest count wins as "the" recent error class; the full breakdown stays in
    // `provider_health_events` for anyone who needs it.
    const worstError = new Map<string, { errorClass: string; count: number }>();
    for (const entry of errorCounts) {
      const current = worstError.get(entry.providerAccountId);
      if (current === undefined || entry.count > current.count) {
        worstError.set(entry.providerAccountId, {
          errorClass: entry.errorClass,
          count: entry.count,
        });
      }
    }

    return reply.status(200).send({
      accounts: accounts.map((account) => {
        const counters = live.get(account.id);
        const error = worstError.get(account.id);
        return {
          id: account.id,
          label: account.label,
          providerType: PROVIDER_TYPE,
          status: toAdminAccountStatus(account.status),
          region: account.region ?? DEFAULT_REGION,
          persona: accountPersona(account),
          activeRequests: counters?.activeRequests ?? 0,
          errorScore: counters?.errorScore ?? 0,
          cooldownUntil: isoOrNull(account.cooldownUntil),
          lastValidatedAt: isoOrNull(account.lastValidatedAt),
          credentialVersion: account.credentialVersion,
          // A row cannot exist without a sealed credential — `insert` requires one — so
          // this is true for every persisted account. Kept as a field because the client
          // schema requires it, and it is the honest answer to "is there a secret here".
          hasStoredCredential: true,
          lastErrorClass: error?.errorClass ?? null,
          lastErrorCount24h: error?.count ?? 0,
          weightedTokens24h: weighted.get(account.id) ?? 0,
        };
      }),
    });
  });

  /**
   * One account.
   *
   * The client resolves this with a `.find()` over the list rather than calling the
   * route, so the shape must match the list exactly or the two views would disagree.
   * Implemented by filtering the list for that reason — a separate projection here is a
   * second place for the four-source join to drift.
   */
  app.get("/admin/v1/provider-accounts/:id", async (request, reply) => {
    await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");

    const account = await deps.providerAccounts.findById(accountId);
    if (account === null) throw notFound("provider account");

    const now = deps.clock.now();
    const since = new Date(now.getTime() - 86_400_000);
    const [errorCounts, usageTotals] = await Promise.all([
      deps.providerAccounts.errorCountsSince(PROVIDER_TYPE, since),
      deps.usage.totalsByProviderAccount(since, now),
    ]);

    const counters = deps.liveAccounts().find((entry) => entry.accountId === accountId);
    const errors = errorCounts.filter((entry) => entry.providerAccountId === accountId);
    const worst = errors.reduce<{ errorClass: string; count: number } | null>(
      (best, entry) =>
        best === null || entry.count > best.count
          ? { errorClass: entry.errorClass, count: entry.count }
          : best,
      null,
    );

    return reply.status(200).send({
      id: account.id,
      label: account.label,
      providerType: PROVIDER_TYPE,
      status: toAdminAccountStatus(account.status),
      region: account.region ?? DEFAULT_REGION,
      persona: accountPersona(account),
      activeRequests: counters?.activeRequests ?? 0,
      errorScore: counters?.errorScore ?? 0,
      cooldownUntil: isoOrNull(account.cooldownUntil),
      lastValidatedAt: isoOrNull(account.lastValidatedAt),
      credentialVersion: account.credentialVersion,
      hasStoredCredential: true,
      lastErrorClass: worst?.errorClass ?? null,
      lastErrorCount24h: worst?.count ?? 0,
      weightedTokens24h:
        usageTotals.find((entry) => entry.providerAccountId === accountId)?.weightedTokens ?? 0,
    });
  });

  /**
   * Link a new provider account.
   *
   * The account is created `disabled`. §3 G0 requires a credential to be validated
   * against the live provider before it serves traffic, and `insert` cannot validate —
   * so the safe initial state is one the scheduler will not pick, and the operator
   * enables it after `POST .../validate` passes. Creating it `active` would put an
   * unverified credential into the rotation the moment the row committed.
   */
  app.post("/admin/v1/provider-accounts", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const body = readBody(request.body, ["label", "region", "persona", "credential", "reason"]);

    const label = readString(body, "label", { max: 120 });
    const region = readString(body, "region", { max: 64 });
    const persona = readPersona(body);
    // `max` is generous: a Kiro credential is a JSON blob containing tokens. The bound
    // exists so an unbounded body cannot be pushed through the sealing path, not to
    // validate shape — `parseCredentialInput` does that.
    const credential = readString(body, "credential", { min: 1, max: 16_384 });
    const reason = readReason(body);

    const parsed = parseCredentialInput(credential, region, persona);
    // Rejects an unusable credential before anything is written or encrypted. Its
    // message names the missing FIELD, never a value.
    assertUsableCredentials(parsed);

    const sealed = deps.sealCredential(parsed);
    const at = deps.clock.now();
    const accountId = ulid();

    await deps.transact(async (tx) => {
      await tx.providerAccounts.insert({
        id: accountId,
        providerType: PROVIDER_TYPE,
        label,
        status: "disabled",
        region,
        persona,
        encryptedCredentials: sealed.envelope,
        encryptionKeyVersion: sealed.keyVersion,
        profileArn: sealed.profileArn,
        createdAt: at,
      });

      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerAccountCreated,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          // Ids, a label, and enum values. No part of the credential, not even its
          // length — a length is a distinguisher between credential types.
          details: { label, region, persona, initialStatus: "disabled" },
        },
        at,
      );
    });

    return reply.status(200).send(ok("Provider account linked. Validate it before enabling."));
  });

  /** Rename / re-region / re-persona. No credential field: rotation is its own route. */
  app.post("/admin/v1/provider-accounts/:id", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    const body = readBody(request.body, ["accountId", "label", "region", "persona", "reason"]);

    // The client sends `accountId` in the body as well as the path. Cross-checked rather
    // than ignored: a mismatch means the form and the URL disagree about which account is
    // being edited, and picking either silently could rename the wrong account.
    const bodyAccountId = body["accountId"];
    if (typeof bodyAccountId === "string" && bodyAccountId !== accountId) {
      throw invalid("accountId", "must match the account in the request path");
    }

    const label = readString(body, "label", { max: 120 });
    const region = readString(body, "region", { max: 64 });
    const persona = readPersona(body);
    const reason = readReason(body);
    const at = deps.clock.now();

    const updated = await deps.transact(async (tx) => {
      const existing = await tx.providerAccounts.findById(accountId);
      if (existing === null) return false;

      await tx.providerAccounts.update({ accountId, label, region, persona, at });
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerAccountUpdated,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          details: {
            label,
            region,
            persona,
            previousLabel: existing.label,
            previousRegion: existing.region,
            previousPersona: existing.persona,
          },
        },
        at,
      );
      return true;
    });

    if (!updated) throw notFound("provider account");
    return reply.status(200).send(ok("Provider account updated."));
  });

  /**
   * Rotate the credential.
   *
   * The new credential replaces the old one wholesale. `credentialVersion` advances by
   * one, which is what invalidates any in-flight refresh holding the previous version —
   * that CAS is the whole mechanism described in the module header.
   */
  app.post("/admin/v1/provider-accounts/:id/credential", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    const body = readBody(request.body, ["credential", "reason"]);
    const credential = readString(body, "credential", { min: 1, max: 16_384 });
    const reason = readReason(body);

    const at = deps.clock.now();

    const outcome = await deps.transact(async (tx) => {
      const existing = await tx.providerAccounts.findById(accountId);
      if (existing === null) return { kind: "missing" as const };

      const parsed = parseCredentialInput(
        credential,
        existing.region ?? DEFAULT_REGION,
        accountPersona(existing),
      );
      assertUsableCredentials(parsed);

      const sealed = deps.sealCredential(parsed);
      const rotated = await tx.providerAccounts.rotateCredentials({
        accountId,
        expectedVersion: existing.credentialVersion,
        encryptedCredentials: sealed.envelope,
        encryptionKeyVersion: sealed.keyVersion,
        profileArn: sealed.profileArn,
        at,
      });

      if (!rotated.ok) return { kind: "conflict" as const, reason: rotated.reason };

      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerCredentialRotated,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          // THAT it happened and to which version. Never any part of either credential.
          details: {
            previousCredentialVersion: existing.credentialVersion,
            credentialVersion: existing.credentialVersion + 1,
            encryptionKeyVersion: sealed.keyVersion,
          },
        },
        at,
      );
      return { kind: "rotated" as const };
    });

    if (outcome.kind === "missing") throw notFound("provider account");
    if (outcome.kind === "conflict") {
      // 409, not a retry: the other writer's credential is the live one. The CAS reason
      // goes to the log — `BosandaError` takes no public message override.
      throw new BosandaError("conflict", {
        internalDetail: `provider credential rotation lost the CAS: ${outcome.reason}`,
      });
    }

    return reply
      .status(200)
      .send(ok("Credential rotated. The previous credential is no longer stored."));
  });

  /**
   * Enable / disable.
   *
   * `enabled: true` writes `active`, which `setStatus` treats specially — it clears
   * `cooldown_until`, so re-enabling an account does not leave it invisible to the
   * scheduler until an old cooldown elapses. `enabled: false` writes `disabled`, which is
   * the operator-intent state and distinct from `cooldown` (transient, set by the
   * breaker) and `invalid` (the credential itself is dead).
   */
  app.post("/admin/v1/provider-accounts/:id/enabled", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    const body = readBody(request.body, ["enabled", "reason"]);
    const enabled = readBoolean(body, "enabled");
    const reason = readReason(body);
    const at = deps.clock.now();

    const changed = await deps.transact(async (tx) => {
      const existing = await tx.providerAccounts.findById(accountId);
      if (existing === null) return false;

      await tx.providerAccounts.setStatus(accountId, enabled ? "active" : "disabled", at);
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerAccountEnabled,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          details: { enabled, previousStatus: existing.status },
        },
        at,
      );
      return true;
    });

    if (!changed) throw notFound("provider account");
    return reply
      .status(200)
      .send(ok(enabled ? "Provider account enabled." : "Provider account disabled."));
  });

  /**
   * Validate the credential against the live provider (§3 G0.1).
   *
   * Takes no body — including no reason — because the client sends none: a validation is
   * a read-only probe, not a change to explain. It still writes an audit row, with a
   * fixed reason, because the RESULT is operator-relevant history: "this account was
   * checked at this time and passed" is what makes a later failure interpretable.
   *
   * A failing probe records the failure and reports it, rather than throwing the
   * adapter's error through: the operator asked "does this work", and "no, because
   * upstream rejected the token" is the answer, not a 502.
   */
  app.post("/admin/v1/provider-accounts/:id/validate", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    // No allowed fields: the client sends no body, and a body here would mean the caller
    // expects something this route does not do.
    readBody(request.body, []);

    const account = await deps.providerAccounts.findById(accountId);
    if (account === null) throw notFound("provider account");

    const at = deps.clock.now();
    let passed = false;
    let failureClass: string | null = null;

    try {
      await deps.validateAccount(accountId);
      passed = true;
    } catch (error) {
      // The classification only. An upstream body could contain a token.
      failureClass = error instanceof BosandaError ? error.code : "internal_error";
      request.bosandaLog.warn(
        { providerAccountId: accountId, errorClass: failureClass },
        "admin provider validation failed",
      );
    }

    await deps.transact(async (tx) => {
      if (passed) await tx.providerAccounts.markValidated(accountId, at);
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerAccountValidated,
          targetType: "provider_account",
          targetId: accountId,
          reason: passed ? "credential validated" : "credential validation failed",
          details: { passed, errorClass: failureClass },
        },
        at,
      );
    });

    return reply
      .status(200)
      .send(
        passed
          ? ok("Credential validated against the provider.")
          : { ok: false, message: "Validation failed. The credential was not accepted." },
      );
  });

  /* ──────────────────────────────── models ──────────────────────────────── */

  /**
   * The model catalogue, published or not.
   *
   * `multiplier` and `multiplierVersion` are NUMBERS in the client schema and STRINGS in
   * `ModelRecord` — the columns are `NUMERIC(10,4)` and `TEXT`, kept as strings so an
   * operator-entered decimal round-trips byte-identically. `multiplierNumeric` is the
   * pre-parsed form the repository already provides for exactly this.
   */
  app.get("/admin/v1/models", async (request, reply) => {
    await requireAdmin(request, deps);
    const models = await deps.models.listAll();
    return reply.status(200).send({ models: models.map(toAdminModel) });
  });

  app.get("/admin/v1/models/:publicId", async (request, reply) => {
    await requireAdmin(request, deps);
    const publicId = readParam(request.params, "publicId");
    const model = await deps.models.findByPublicId(publicId);
    if (model === null) throw notFound("model");
    return reply.status(200).send(toAdminModel(model));
  });

  /**
   * Change a multiplier (§9).
   *
   * The version is advanced by the route, not supplied by the client, because
   * `setMultiplier` guards on `new > current` and a client-chosen version could stall
   * (two multipliers claiming one version breaks reproducibility) or leap. Historical
   * `quota_ledger` rows keep the multiplier they were priced with — §9 forbids rewriting
   * settled usage, and this path touches only `models`.
   */
  app.post("/admin/v1/models/:publicId/multiplier", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const publicId = readParam(request.params, "publicId");
    const body = readBody(request.body, ["multiplier", "reason"]);
    const multiplier = readMultiplier(body);
    const reason = readReason(body);
    const at = deps.clock.now();

    const outcome = await deps.transact(async (tx) => {
      const existing = await tx.models.findByPublicId(publicId);
      if (existing === null) return { kind: "missing" as const };

      const currentVersion = Number.parseInt(existing.multiplierVersion, 10);
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
        // A malformed stored version is a data defect, not caller error.
        throw new BosandaError("internal_error", {
          internalDetail: `model ${publicId} has a non-numeric multiplier_version`,
        });
      }
      const nextVersion = String(currentVersion + 1);

      // Exactly four decimals, matching NUMERIC(10,4), so what is stored is what the
      // operator typed and what the next page load shows.
      const updated = await tx.models.setMultiplier(
        publicId,
        multiplier.toFixed(4),
        nextVersion,
        at,
      );
      if (updated === null) return { kind: "conflict" as const };

      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.modelMultiplierChanged,
          targetType: "model",
          targetId: publicId,
          reason,
          details: {
            multiplier: updated.multiplier,
            multiplierVersion: nextVersion,
            previousMultiplier: existing.multiplier,
            previousMultiplierVersion: existing.multiplierVersion,
          },
        },
        at,
      );
      return { kind: "updated" as const };
    });

    if (outcome.kind === "missing") throw notFound("model");
    if (outcome.kind === "conflict") {
      throw new BosandaError("conflict", {
        internalDetail: `model ${publicId} multiplier version did not advance`,
      });
    }

    return reply.status(200).send(ok("Multiplier updated. Settled usage is unchanged."));
  });

  /**
   * Publish / unpublish (§3 per-model gate).
   *
   * Publishing is GUARDED in SQL on `compatibility_status IN ('passing','degraded')` and
   * returns null when the model is not eligible. That is reported as `200 {ok:false}`
   * rather than a 409, for a reason that comes out of the frozen error taxonomy:
   * `BosandaError` derives `publicMessage` from the code alone and takes no override, so a
   * 409 could only say "There is a conflict" — the operator would not learn that the model
   * has never passed compatibility, which is the entire content of the refusal. The
   * `mutationResult` envelope carries a specific message safely, and `run()` in the admin
   * client already routes `ok:false` to an error banner without revalidating. Same shape as
   * `POST .../validate`: the request was well-formed and the answer is no.
   *
   * Unpublishing is unconditional — turning something off must always be possible, which
   * is the §3 kill-switch principle.
   */
  app.post("/admin/v1/models/:publicId/published", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const publicId = readParam(request.params, "publicId");
    const body = readBody(request.body, ["published", "reason"]);
    const published = readBoolean(body, "published");
    const reason = readReason(body);
    const at = deps.clock.now();

    const outcome = await deps.transact(async (tx) => {
      const existing = await tx.models.findByPublicId(publicId);
      if (existing === null) return { kind: "missing" as const };

      const updated = await tx.models.setPublished(publicId, published, at);
      if (updated === null) {
        return { kind: "ineligible" as const, status: existing.compatibilityStatus };
      }

      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.modelPublishedChanged,
          targetType: "model",
          targetId: publicId,
          reason,
          details: {
            published,
            previousPublished: existing.published,
            compatibilityStatus: existing.compatibilityStatus,
          },
        },
        at,
      );
      return { kind: "updated" as const };
    });

    if (outcome.kind === "missing") throw notFound("model");
    if (outcome.kind === "ineligible") {
      // `setPublished` guards publishing on `compatibility_status IN ('passing','degraded')`
      // and returns null otherwise. Reported rather than thrown, per the header: a thrown
      // 409 could not name compatibility as the cause. The stored spelling stays in the log
      // — the message carries only the projected admin vocabulary the operator sees
      // elsewhere in the console.
      request.bosandaLog.warn(
        { publicId, compatibilityStatus: outcome.status },
        "admin model publish refused: compatibility gate",
      );
      return reply.status(200).send({
        ok: false,
        message:
          "Publish refused: this model has not passed the compatibility suite. Run it and publish once it passes.",
      });
    }

    return reply.status(200).send(ok(published ? "Model published." : "Model unpublished."));
  });
}

/** `ModelRecord` → the client's `model` schema. */
function toAdminModel(model: {
  publicId: string;
  upstreamId: string;
  label: string;
  contextWindow: number;
  multiplierNumeric: number;
  multiplierVersion: string;
  supportsTools: boolean;
  supportsReasoning: boolean;
  regions: string[];
  published: boolean;
  compatibilityStatus: Parameters<typeof toAdminCompatibility>[0];
  updatedAt: Date;
}): Record<string, unknown> {
  const version = Number.parseInt(model.multiplierVersion, 10);
  return {
    publicId: model.publicId,
    /**
     * The upstream model id.
     *
     * Present because the client schema requires it and `.strict()` rejects an omission.
     * It is a provider-internal identifier, not a secret, and §16 keeps it out of
     * CUSTOMER responses (`toPublicModel` on `/v1/models` omits it) — the operator
     * console is where it is legitimately useful for correlating a provider-side issue.
     */
    upstreamId: model.upstreamId,
    label: model.label,
    contextWindow: model.contextWindow,
    multiplier: model.multiplierNumeric,
    // `z.number().int().positive()` — a stored 0 or a malformed version would fail the
    // client's parse, so 1 is substituted for an unusable value rather than shipping
    // something that breaks the page.
    multiplierVersion: Number.isSafeInteger(version) && version > 0 ? version : 1,
    // No column records when a multiplier took effect; `updated_at` is the closest true
    // statement the row supports.
    multiplierEffectiveAt: iso(model.updatedAt),
    supportsTools: model.supportsTools,
    supportsReasoning: model.supportsReasoning,
    regions: model.regions,
    published: model.published,
    compatibilityStatus: toAdminCompatibility(model.compatibilityStatus),
  };
}

/** `persona`, validated against the two personas §6 defines. */
function readPersona(body: Record<string, unknown>): "cli" | "ide" {
  const value = body["persona"];
  if (value !== "cli" && value !== "ide") throw invalid("persona", "must be 'cli' or 'ide'");
  return value;
}

/**
 * Reads the operator-supplied credential JSON into a `ProviderCredentials`.
 *
 * Parsed only so `assertUsableCredentials` can check it (§3 G0.1/G0.2) — the value that
 * gets sealed is the ORIGINAL string, so nothing here can alter what is stored. Every
 * failure names a field and never echoes content: a parse error on a credential must not
 * quote the credential.
 */
function parseCredentialInput(
  raw: string,
  region: string,
  persona: "cli" | "ide",
): Parameters<typeof assertUsableCredentials>[0] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("credential", "must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("credential", "must be a JSON object");
  }
  const fields = parsed as Record<string, unknown>;

  const authMethod = fields["authMethod"];
  if (authMethod !== "social" && authMethod !== "idc" && authMethod !== "api_key") {
    throw invalid("credential.authMethod", "must be 'social', 'idc', or 'api_key'");
  }

  const optionalString = (key: string): string | null => {
    const value = fields[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length === 0) {
      throw invalid(`credential.${key}`, "must be a non-empty string when present");
    }
    return value;
  };

  const expiresAtRaw = optionalString("accessTokenExpiresAt");
  const expiresAt = expiresAtRaw === null ? null : new Date(expiresAtRaw);
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    throw invalid("credential.accessTokenExpiresAt", "must be an ISO-8601 instant");
  }

  return {
    authMethod,
    refreshToken: optionalString("refreshToken"),
    accessToken: optionalString("accessToken"),
    accessTokenExpiresAt: expiresAt,
    // The account's region/persona win over anything inside the blob: they are what the
    // scheduler routes on, and two sources of truth for one field is a bug waiting.
    region,
    profileArn: optionalString("profileArn"),
    clientId: optionalString("clientId"),
    clientSecret: optionalString("clientSecret"),
    persona,
    credentialVersion: 0,
  };
}

/** 404 without echoing the id — the path is caller-controlled. */
function notFound(what: string): BosandaError {
  return new BosandaError("not_found", {
    internalDetail: `admin ${what} lookup missed`,
  });
}
