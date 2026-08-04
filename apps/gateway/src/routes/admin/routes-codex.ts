/**
 * Codex App Server admin lifecycle (managed accounts, OAuth via runtime).
 *
 * Credentials never enter Postgres — migration 0002 allows null sealed credentials
 * for App Server-managed rows. Login is delegated to apps/codex-runtime; responses
 * carry only state + optional auth URL, never tokens.
 */

import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import { mapCodexModel } from "@bosanda/provider-codex";
import { ulid } from "@bosanda/shared";
import type { AdminDeps } from "./deps.js";
import { ADMIN_ACTIONS, auditActor, writeAudit } from "./audit.js";
import {
  invalid,
  iso,
  isoOrNull,
  ok,
  readBody,
  readParam,
  readReason,
  readString,
  toAdminAccountStatus,
  toAdminCompatibility,
} from "./contract.js";
import { requireAdmin } from "./session.js";

const CODEX_PROVIDER_TYPE = "openai_codex";
const DEFAULT_REGION = "global";

export function registerCodexProviderRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /**
   * Create a managed Codex account row (disabled, no sealed credential).
   * Operator must complete login + validate before enabling.
   */
  app.post("/admin/v1/provider-accounts/codex", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    if (!deps.codex.isRuntimeEnabled()) {
      throw new BosandaError("adapter_disabled", {
        internalDetail: "OPENAI_CODEX_RUNTIME_ENABLED is false",
      });
    }
    const body = readBody(request.body, ["label", "reason"]);
    const label = readString(body, "label", { max: 120 });
    const reason = readReason(body);
    const at = deps.clock.now();
    const accountId = ulid();

    await deps.transact(async (tx) => {
      await tx.providerAccounts.insert({
        id: accountId,
        providerType: CODEX_PROVIDER_TYPE,
        label,
        status: "disabled",
        region: DEFAULT_REGION,
        persona: "app_server",
        encryptedCredentials: null,
        encryptionKeyVersion: null,
        profileArn: null,
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
          details: {
            label,
            providerType: CODEX_PROVIDER_TYPE,
            persona: "app_server",
            initialStatus: "disabled",
            managed: true,
          },
        },
        at,
      );
    });

    return reply
      .status(200)
      .send(ok("Codex account created. Start login, then validate before enabling."));
  });

  app.get("/admin/v1/provider-accounts/codex", async (request, reply) => {
    await requireAdmin(request, deps);
    const now = deps.clock.now();
    const since = new Date(now.getTime() - 86_400_000);
    const [accounts, errorCounts, usageTotals] = await Promise.all([
      deps.providerAccounts.listByType(CODEX_PROVIDER_TYPE),
      deps.providerAccounts.errorCountsSince(CODEX_PROVIDER_TYPE, since),
      deps.usage.totalsByProviderAccount(since, now),
    ]);
    const live = new Map(deps.liveAccounts().map((entry) => [entry.accountId, entry]));
    const weighted = new Map(
      usageTotals.map((entry) => [entry.providerAccountId, entry.weightedTokens]),
    );
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

    const rows = await Promise.all(
      accounts.map(async (account) => {
        let authenticated = false;
        if (deps.codex.isRuntimeEnabled()) {
          try {
            const info = await deps.codex.accountRead(account.id);
            authenticated = info.authenticated;
          } catch {
            authenticated = false;
          }
        }
        const counters = live.get(account.id);
        const error = worstError.get(account.id);
        return {
          id: account.id,
          label: account.label,
          providerType: CODEX_PROVIDER_TYPE,
          status: toAdminAccountStatus(account.status),
          region: account.region ?? DEFAULT_REGION,
          persona: "app_server" as const,
          activeRequests: counters?.activeRequests ?? 0,
          errorScore: counters?.errorScore ?? 0,
          cooldownUntil: isoOrNull(account.cooldownUntil),
          lastValidatedAt: isoOrNull(account.lastValidatedAt),
          credentialVersion: account.credentialVersion,
          hasStoredCredential: authenticated,
          lastErrorClass: error?.errorClass ?? null,
          lastErrorCount24h: error?.count ?? 0,
          weightedTokens24h: weighted.get(account.id) ?? 0,
        };
      }),
    );

    return reply.status(200).send({ accounts: rows });
  });

  app.post("/admin/v1/provider-accounts/:id/codex/login/start", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    const body = readBody(request.body, ["reason"]);
    const reason = readReason(body);
    await assertCodexAccount(deps, accountId);
    if (!deps.codex.isRuntimeEnabled()) {
      throw new BosandaError("adapter_disabled", {
        internalDetail: "OPENAI_CODEX_RUNTIME_ENABLED is false",
      });
    }

    const status = await deps.codex.loginStart(accountId);
    const at = deps.clock.now();
    await deps.transact(async (tx) => {
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerCodexLoginStarted,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          details: { state: status.state },
        },
        at,
      );
    });

    return reply.status(200).send({
      ok: true,
      state: status.state,
      ...(status.authUrl === undefined ? {} : { authUrl: status.authUrl }),
      message:
        status.authUrl !== undefined
          ? "Open the auth URL to complete login. Remote: ssh -N -L 1455:127.0.0.1:1455 <host>."
          : "Login started.",
    });
  });

  app.get("/admin/v1/provider-accounts/:id/codex/login/status", async (request, reply) => {
    await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    await assertCodexAccount(deps, accountId);
    const status = await deps.codex.loginStatus(accountId);
    return reply.status(200).send({
      state: status.state,
      ...(status.authUrl === undefined ? {} : { authUrl: status.authUrl }),
      ...(status.message === undefined ? {} : { message: status.message }),
    });
  });

  app.post("/admin/v1/provider-accounts/:id/codex/login/cancel", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    const body = readBody(request.body, ["reason"]);
    const reason = readReason(body);
    await assertCodexAccount(deps, accountId);
    const status = await deps.codex.loginCancel(accountId);
    const at = deps.clock.now();
    await deps.transact(async (tx) => {
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerCodexLoginCancelled,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          details: { state: status.state },
        },
        at,
      );
    });
    return reply.status(200).send(ok("Codex login cancelled."));
  });

  app.post("/admin/v1/provider-accounts/:id/codex/logout", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    const body = readBody(request.body, ["reason"]);
    const reason = readReason(body);
    await assertCodexAccount(deps, accountId);
    await deps.codex.logout(accountId);
    const at = deps.clock.now();
    await deps.transact(async (tx) => {
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerCodexLoggedOut,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          details: { loggedOut: true },
        },
        at,
      );
    });
    return reply.status(200).send(ok("Codex account logged out in the runtime."));
  });

  app.post("/admin/v1/provider-accounts/:id/codex/models/sync", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const accountId = readParam(request.params, "id");
    const body = readBody(request.body, ["reason"]);
    const reason = readReason(body);
    await assertCodexAccount(deps, accountId);
    if (!deps.codex.isRuntimeEnabled()) {
      throw new BosandaError("adapter_disabled", {
        internalDetail: "OPENAI_CODEX_RUNTIME_ENABLED is false",
      });
    }

    const raw = await deps.codex.listModels(accountId);
    const models = raw.map((row) => mapCodexModel(row));
    const at = deps.clock.now();
    let upserted = 0;

    await deps.transact(async (tx) => {
      for (const model of models) {
        await tx.models.upsert({
          publicId: model.publicId,
          providerType: CODEX_PROVIDER_TYPE,
          upstreamId: model.upstreamId,
          label: model.label,
          contextWindow: model.contextWindow,
          multiplier: model.multiplier.toFixed(4),
          multiplierVersion: String(model.multiplierVersion),
          capabilities: {
            supportsTools: model.supportsTools,
            supportsReasoning: model.supportsReasoning,
          },
          regions: model.regions,
          published: false,
          compatibilityStatus: "untested",
          at,
        });
        upserted += 1;
      }
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.providerCodexModelsSynced,
          targetType: "provider_account",
          targetId: accountId,
          reason,
          details: { upserted, published: false },
        },
        at,
      );
    });

    return reply.status(200).send({
      ok: true,
      message: `Synced ${upserted} Codex model(s) as unpublished.`,
      models: models.map((model) => ({
        publicId: model.publicId,
        upstreamId: model.upstreamId,
        label: model.label,
        published: false,
        compatibilityStatus: toAdminCompatibility("untested"),
        updatedAt: iso(at),
      })),
    });
  });
}

async function assertCodexAccount(deps: AdminDeps, accountId: string): Promise<void> {
  const account = await deps.providerAccounts.findById(accountId);
  if (account === null) {
    throw new BosandaError("not_found", { internalDetail: "admin provider account lookup missed" });
  }
  if (account.providerType !== CODEX_PROVIDER_TYPE) {
    throw invalid("accountId", "not a Codex managed account");
  }
}
