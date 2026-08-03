/**
 * Users and API keys (PLAN.md §12 recovery, §15/§16 audit).
 *
 * Feature flags and the audit log live in `routes-catalog.ts` — they read the same
 * catalogue the package routes need, so keeping them together avoids two copies of it.
 *
 * ── THE PASSWORD RESET IS NOT IMPLEMENTED HERE ────────────────────────────
 * `resetPasswordAsAdmin` in `@bosanda/auth` already encodes all four §12 requirements —
 * admin authentication, revoke EVERY session, audit actor/target/time/reason, never
 * reveal the old password — and enforces the ordering that matters: the hash is written
 * first, sessions are revoked second, so there is no window where the old password is
 * dead but a stolen cookie still works. This route supplies a `ResetStore` and a
 * `ResetAuditSink` backed by the transaction and calls it. Hashing here instead would
 * duplicate the one path that must not be duplicated.
 *
 * The plaintext never leaves this handler: it goes from the parsed body straight into
 * `resetPasswordAsAdmin`, is never logged, never audited, and never echoed.
 *
 * ── THE KEY LIST IS THE ONE ROUTE WITH NO REPOSITORY BEHIND IT ────────────
 * `GET /admin/v1/api-keys` needs a cross-user page with a prefix filter and a count, and
 * `apiKeysRepository` has none of that. It goes through `deps.apiKeyQuery` instead — see
 * `AdminApiKeyQuery` in `deps.ts` for why that port exists rather than a faked response.
 */

import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import { ulid } from "@bosanda/shared";
import {
  MIN_RESET_REASON_LENGTH,
  assertPasswordAcceptable,
  resetPasswordAsAdmin,
} from "@bosanda/auth";
import { METER_VERSION } from "@bosanda/metering";
import type { ApiKey, PublicUser } from "@bosanda/database";
import type { AdminApiKeyRow, AdminDeps } from "./deps.js";
import { ADMIN_ACTIONS, auditActor, writeAudit } from "./audit.js";
import {
  invalid,
  iso,
  isoOrNull,
  ok,
  readBody,
  readBoolean,
  readInteger,
  readPaging,
  readParam,
  readQuery,
  readReason,
  readSearch,
  readString,
  toAdminKeyStatus,
  toAdminRole,
  toAdminUserStatus,
  fromAdminEnabled,
} from "./contract.js";
import { requireAdmin } from "./session.js";

export function registerAccountRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /* ───────────────────────────────── users ──────────────────────────────── */

  /**
   * The user list.
   *
   * Two calls are needed because `users.list` takes the `q` filter but returns
   * `PublicUser` only, while the aggregates the client requires (`activeKeyCount`,
   * `totalWeightedRemaining`, `lastLoginAt`) come from `userQuery.aggregatesFor`. The
   * aggregate call is scoped to the page's ids rather than run over the whole table, so
   * the cost tracks the page size and not the user count.
   */
  app.get("/admin/v1/users", async (request, reply) => {
    await requireAdmin(request, deps);
    const query = readQuery(request.query, ["limit", "offset", "q"]);
    const paging = readPaging(query);
    const search = readSearch(query);

    const filter = search === undefined ? {} : { search };
    const [users, total] = await Promise.all([
      deps.users.list(filter, paging),
      deps.users.count(filter),
    ]);

    const aggregates = await deps.userQuery.aggregatesFor(users.map((user) => user.id));
    return reply.status(200).send({
      users: users.map((user) => toAdminUser(user, aggregates)),
      total,
    });
  });

  /** One user with their keys — the account-support view. */
  app.get("/admin/v1/users/:userId", async (request, reply) => {
    await requireAdmin(request, deps);
    const userId = readParam(request.params, "userId");

    const user = await deps.users.findPublicById(userId);
    if (user === null) throw notFound("user");

    const [aggregates, keys] = await Promise.all([
      deps.userQuery.aggregatesFor([userId]),
      deps.apiKeys.listForUser(userId, { limit: 100, offset: 0 }),
    ]);

    return reply.status(200).send({
      user: toAdminUser(user, aggregates),
      keys: keys.map((key) => toAdminKeyFromRecord(key, user.username)),
    });
  });

  /**
   * Enable or disable an account.
   *
   * `enabled: false` writes `suspended` (the database spelling), which reads back as
   * `disabled`. The user's sessions are revoked on disable: leaving them live would let a
   * suspended user keep browsing until their cookie expired. Their API keys are left
   * alone — key authentication checks the key's own status, and `requireAuth` does not
   * re-read the user, so revoking keys would be a separate decision an operator makes
   * explicitly rather than a side effect of suspending a login.
   */
  app.post("/admin/v1/users/:userId/enabled", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const userId = readParam(request.params, "userId");
    const body = readBody(request.body, ["enabled", "reason"]);
    const enabled = readBoolean(body, "enabled");
    const reason = readReason(body);
    const at = deps.clock.now();

    const changed = await deps.transact(async (tx) => {
      const existing = await tx.users.findById(userId);
      if (existing === null) return false;

      await tx.users.setStatus(userId, fromAdminEnabled(enabled), at);
      // Returns the revoked ids; only the count is audited — a session id is a handle to
      // a live credential and has no place in an operator log.
      const revokedSessions = enabled ? 0 : (await tx.sessions.revokeAllForUser(userId, at)).length;

      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.userEnabled,
          targetType: "user",
          targetId: userId,
          reason,
          details: { enabled, previousStatus: existing.status, revokedSessions },
        },
        at,
      );
      return true;
    });

    if (!changed) throw notFound("user");
    return reply
      .status(200)
      .send(ok(enabled ? "Account enabled." : "Account disabled and signed out."));
  });

  /**
   * Reset a password (§12).
   *
   * The reason bound is `MIN_RESET_REASON_LENGTH` (8), stricter than the generic
   * `readReason`, because `resetPasswordAsAdmin` enforces it and a request that failed
   * inside the frozen function would still have written a "denied" audit row. Checking
   * first keeps the audit log free of rows that only record a malformed request.
   *
   * `assertPasswordAcceptable` runs before the transaction opens so a weak password does
   * not hold a write transaction open across an Argon2id hash.
   */
  app.post("/admin/v1/users/:userId/password", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const userId = readParam(request.params, "userId");
    const body = readBody(request.body, ["newPassword", "reason"]);

    // Read but never retained: not logged, not audited, not echoed.
    const newPassword = readString(body, "newPassword", { min: 1, max: 4096 });
    const reason = readReason(body);
    if (reason.length < MIN_RESET_REASON_LENGTH) {
      throw invalid("reason", `must be at least ${MIN_RESET_REASON_LENGTH} characters`);
    }

    // Throws `invalid_request` naming the rule, never the password.
    assertPasswordAcceptable(newPassword);

    const target = await deps.users.findPublicById(userId);
    if (target === null) throw notFound("user");

    const result = await deps.transact(async (tx) => {
      let revoked = 0;
      const reset = await resetPasswordAsAdmin({
        actor: {
          userId: actor.user.id,
          role: "admin",
          sessionId: actor.sessionId,
          // Recorded by the frozen function for traceability. `request.ip` respects
          // `trustProxy`; a missing user agent is null rather than a guess.
          ip: request.ip ?? null,
          userAgent: request.headers["user-agent"] ?? null,
        },
        targetUserId: userId,
        newPassword,
        reason,
        store: {
          setPasswordHash: async (id, passwordHash, at) => {
            await tx.users.setPasswordHash(id, passwordHash, at);
          },
          // `ResetStore` wants a count; the repository returns the revoked ids. Only the
          // count is kept — a session id is a handle to a live credential.
          revokeAllSessions: async (id, at) => {
            revoked = (await tx.sessions.revokeAllForUser(id, at)).length;
            return revoked;
          },
        },
        audit: {
          // The frozen entry is projected onto `audit_events`. Its fields are ids,
          // counts, and the reason — the password is not among them by construction.
          record: async (entry) => {
            await writeAudit(
              tx,
              auditActor(actor),
              {
                action: ADMIN_ACTIONS.userPasswordReset,
                targetType: "user",
                targetId: entry.targetUserId,
                reason: entry.reason,
                details: {
                  outcome: entry.outcome,
                  revokedSessionCount: entry.revokedSessionCount,
                  actorSessionId: entry.actorSessionId,
                },
              },
              entry.at,
            );
          },
        },
        clock: deps.clock,
      });
      return { revoked, at: reset.at };
    });

    return reply
      .status(200)
      .send(
        ok(
          `Password reset. ${result.revoked} session${result.revoked === 1 ? "" : "s"} signed out.`,
        ),
      );
  });

  /* ──────────────────────────────── api keys ────────────────────────────── */

  /**
   * Every key, across users.
   *
   * `apiKeysRepository` has no cross-user list and no `prefix`/`lookup_digest` filter, so
   * this goes through `apiKeyQuery` — the port that exists precisely because the frozen
   * repository does not cover the operator view. `lookup_digest` is accepted because
   * support needs to answer "which key is this" from a log line's digest; it is a filter
   * INPUT and no response field ever contains a digest, ciphertext, or plaintext (§12).
   */
  app.get("/admin/v1/api-keys", async (request, reply) => {
    await requireAdmin(request, deps);
    const query = readQuery(request.query, ["limit", "offset", "prefix", "lookup_digest"]);
    const paging = readPaging(query);

    const prefix = query.get("prefix");
    const lookupDigestFilter = query.get("lookup_digest");
    if (prefix !== undefined && prefix.length > 64) {
      throw invalid("prefix", "must be at most 64 characters");
    }
    if (lookupDigestFilter !== undefined && lookupDigestFilter.length > 128) {
      throw invalid("lookup_digest", "must be at most 128 characters");
    }

    const filter = {
      ...(prefix === undefined ? {} : { prefix }),
      ...(lookupDigestFilter === undefined ? {} : { lookupDigest: lookupDigestFilter }),
    };

    const [keys, total] = await Promise.all([
      deps.apiKeyQuery.list(filter, paging),
      deps.apiKeyQuery.count(filter),
    ]);

    return reply.status(200).send({ keys: keys.map(toAdminKey), total });
  });

  /**
   * Adjust a key's balance (§10).
   *
   * Goes through `recordAdjustment`, which writes the append-only `quota_ledger` row and
   * the new balance in one statement — the §10 invariant is that no balance moves without
   * a ledger row, and this is the only writer that guarantees the pair. `lockKeyForUpdate`
   * is held first so the arithmetic is on the same state that gets committed and cannot
   * interleave with a live request's settlement.
   *
   * The persisted balance is clamped at 0 by `recordAdjustment` (the CHECK constraint
   * forbids negative), while the full signed delta is preserved on the ledger row. So a
   * -1000 adjustment against a balance of 400 records -1000 and stores 0: the withdrawal
   * stays auditable and the customer is not left owing tokens.
   */
  app.post("/admin/v1/api-keys/:keyId/quota", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const keyId = readParam(request.params, "keyId");
    const body = readBody(request.body, ["weightedTokensDelta", "reason"]);
    const delta = readInteger(body, "weightedTokensDelta", -1_000_000_000, 1_000_000_000);
    if (delta === 0) throw invalid("weightedTokensDelta", "must not be zero");
    const reason = readReason(body);
    const at = deps.clock.now();

    const outcome = await deps.transact(async (tx) => {
      const key = await tx.quota.lockKeyForUpdate(keyId);
      if (key === null) return { kind: "missing" as const };

      const entry = await tx.quota.recordAdjustment({
        id: ulid(),
        apiKeyId: keyId,
        // Not tied to a purchase: an operator adjustment has no order.
        orderId: null,
        weightedTokensDelta: delta,
        remainingAfter: key.remaining + delta,
        meterVersion: METER_VERSION,
        createdAt: at,
      });

      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.keyQuotaAdjusted,
          targetType: "api_key",
          targetId: keyId,
          reason,
          details: {
            weightedTokensDelta: delta,
            previousRemaining: key.remaining,
            // The persisted (clamped) figure, so the row matches the column.
            balanceAfter: entry.balanceAfter,
            ledgerEntryId: entry.id,
          },
        },
        at,
      );
      return { kind: "adjusted" as const, balanceAfter: entry.balanceAfter };
    });

    if (outcome.kind === "missing") throw notFound("API key");
    return reply
      .status(200)
      .send(ok(`Quota adjusted. Balance is now ${outcome.balanceAfter} weighted tokens.`));
  });

  /**
   * Revoke a key.
   *
   * `revoke` is guarded on `status='active'` and returns null for an already-revoked key.
   * Reported as success rather than a conflict: the caller asked for the key to be dead
   * and it is dead. No audit row is written for the second call — there was no change to
   * record, and duplicating the row would misrepresent one revocation as two.
   */
  app.post("/admin/v1/api-keys/:keyId/revoke", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const keyId = readParam(request.params, "keyId");
    const reason = readReason(readBody(request.body, ["reason"]));
    const at = deps.clock.now();

    const outcome = await deps.transact(async (tx) => {
      const existing = await tx.apiKeys.findById(keyId);
      if (existing === null) return "missing" as const;

      const revoked = await tx.apiKeys.revoke(keyId, at);
      if (revoked === null) return "already" as const;

      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.keyRevoked,
          targetType: "api_key",
          targetId: keyId,
          reason,
          details: {
            userId: existing.userId,
            prefix: existing.prefix,
            remainingAtRevocation: existing.quotaRemaining,
          },
        },
        at,
      );
      return "revoked" as const;
    });

    if (outcome === "missing") throw notFound("API key");
    return reply
      .status(200)
      .send(ok(outcome === "already" ? "Key was already revoked." : "Key revoked."));
  });
}

/* ───────────────────────────── projections ───────────────────────────── */

function toAdminUser(
  user: PublicUser,
  aggregates: readonly {
    userId: string;
    activeKeyCount: number;
    totalWeightedRemaining: number;
    lastLoginAt: Date | null;
  }[],
): Record<string, unknown> {
  const totals = aggregates.find((entry) => entry.userId === user.id);
  return {
    id: user.id,
    username: user.username,
    role: toAdminRole(user.role),
    status: toAdminUserStatus(user.status),
    activeKeyCount: totals?.activeKeyCount ?? 0,
    totalWeightedRemaining: totals?.totalWeightedRemaining ?? 0,
    createdAt: iso(user.createdAt),
    /**
     * There is no `users.last_login_at` column.
     *
     * Derived from the newest session for the user, which is what a login creates — see
     * `aggregatesFor`. A user who has never logged in, or whose sessions have been
     * pruned, reports null, which the client's schema allows.
     */
    lastLoginAt: isoOrNull(totals?.lastLoginAt),
  };
}

/** The `apiKeyQuery` row (already joined to a username) → the client shape. */
function toAdminKey(key: AdminApiKeyRow): Record<string, unknown> {
  return {
    id: key.id,
    userId: key.userId,
    username: key.username,
    label: key.label,
    prefix: key.prefix,
    status: toAdminKeyStatus(key.status as ApiKey["status"], key.quotaRemaining),
    quotaLimit: key.quotaLimit,
    quotaRemaining: key.quotaRemaining,
    expiresAt: isoOrNull(key.expiresAt),
    createdAt: iso(key.createdAt),
    lastUsedAt: isoOrNull(key.lastUsedAt),
  };
}

/** The same shape from an `ApiKey` record, for the single-user view. */
function toAdminKeyFromRecord(key: ApiKey, username: string): Record<string, unknown> {
  return {
    id: key.id,
    userId: key.userId,
    username,
    label: key.label,
    prefix: key.prefix,
    status: toAdminKeyStatus(key.status, key.quotaRemaining),
    quotaLimit: key.quotaLimit,
    quotaRemaining: key.quotaRemaining,
    expiresAt: isoOrNull(key.expiresAt),
    createdAt: iso(key.createdAt),
    lastUsedAt: isoOrNull(key.lastUsedAt),
  };
}

/**
 * A 404 whose public text is the taxonomy's ("The requested resource was not found.").
 *
 * `BosandaError` does not let a caller override `publicMessage` — see `invalid()` in
 * `contract.ts` for why that is deliberate. `what` therefore only reaches the log.
 */
function notFound(what: string): BosandaError {
  return new BosandaError("not_found", {
    internalDetail: `admin ${what} lookup missed`,
  });
}
