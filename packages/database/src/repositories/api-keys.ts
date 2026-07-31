/**
 * `api_keys` access (PLAN.md §11 key lifecycle, §12 customer API keys).
 *
 * NOTE ON WHAT THIS LAYER DOES NOT DO. It does not hash, generate, seal, or open
 * a key — `@bosanda/api-keys` owns all of that. Callers pass a `lookupDigest`
 * they computed with `lookupDigest()` and a ciphertext they built with `seal()`.
 * No plaintext key value ever reaches this file, which is what makes §12's
 * "never store plaintext" checkable by reading one package instead of two.
 */

import type { Clock } from "@bosanda/shared";
import { type Executor, firstRow, requireRow } from "./executor.js";
import {
  type ApiKey,
  type ApiKeyRow,
  type ApiKeyRowWithUser,
  type AuthenticatedApiKey,
  toApiKey,
  toAuthenticatedApiKey,
} from "./rows.js";
import { type Pagination, normalizePagination } from "./decisions.js";

export type InsertApiKeyInput = {
  id: string;
  userId: string;
  label: string | null;
  prefix: string;
  /** HMAC from `lookupDigest()`. The only value authentication looks up. */
  lookupDigest: string;
  /** Sealed envelope from `seal()`. Never logged (§12). */
  encryptedKey: string;
  encryptionKeyVersion: number;
  /** Weighted tokens granted at activation. */
  quotaLimit: number;
  quotaRemaining: number;
  expiresAt: Date;
  createdAt: Date;
};

export type ApiKeysRepository = ReturnType<typeof apiKeysRepository>;

export function apiKeysRepository(sql: Executor) {
  return {
    /**
     * THE GATEWAY HOT PATH. One indexed query per authenticated request.
     *
     * Hits `api_keys_lookup_digest_key` (the UNIQUE constraint on
     * `lookup_digest`) and joins `users` by primary key, so this is two index
     * lookups and no scan.
     *
     * The join is not optional: §12 requires a suspended account's keys to stop
     * working, and checking the user in a second round trip would double the
     * latency of every request and leave a window where a key is accepted
     * against a stale account state. The caller passes the result to
     * `decideKeyAuth` and then to `canStartRequest` — this method reports state
     * and enforces nothing itself.
     *
     * Returns null for an unknown digest. The caller must NOT distinguish that
     * from a revoked key in its response (§12: no probing oracle).
     */
    async findByLookupDigest(lookupDigest: string): Promise<AuthenticatedApiKey | null> {
      // Columns are spelled out rather than `k.*` so a column added by a later
      // migration cannot silently start flowing through the auth path.
      const rows = await sql<ApiKeyRowWithUser[]>`
        SELECT k.id, k.user_id, k.label, k.prefix, k.lookup_digest,
               k.encrypted_key, k.encryption_key_version, k.status,
               k.quota_limit, k.quota_remaining, k.expires_at, k.created_at,
               k.revoked_at, k.last_used_at,
               u.status AS user_status,
               u.role   AS user_role
        FROM api_keys k
        JOIN users u ON u.id = k.user_id
        WHERE k.lookup_digest = ${lookupDigest}
      `;
      const row = firstRow(rows);
      return row === null ? null : toAuthenticatedApiKey(row);
    },

    async findById(id: string): Promise<ApiKey | null> {
      const rows = await sql<ApiKeyRow[]>`
        SELECT * FROM api_keys WHERE id = ${id}
      `;
      const row = firstRow(rows);
      return row === null ? null : toApiKey(row);
    },

    /**
     * A user's keys, newest first — the customer dashboard listing.
     *
     * Ordered to match `api_keys_user_id_idx (user_id, created_at DESC)` so the
     * index satisfies both the filter and the sort.
     */
    async listForUser(userId: string, paging: Pagination = {}): Promise<ApiKey[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<ApiKeyRow[]>`
        SELECT * FROM api_keys
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toApiKey);
    },

    /** Keys eligible as top-up targets: active and not yet expired (§11). */
    async listActiveForUser(userId: string, now: Date): Promise<ApiKey[]> {
      const rows = await sql<ApiKeyRow[]>`
        SELECT * FROM api_keys
        WHERE user_id = ${userId}
          AND status = 'active'
          AND expires_at > ${now}
        ORDER BY created_at DESC
      `;
      return rows.map(toApiKey);
    },

    /**
     * Create a key.
     *
     * Normally called inside the activation transaction (pass the `tx`), because
     * §13 step 8 requires the key and its grant ledger row to commit together.
     */
    async insert(input: InsertApiKeyInput): Promise<ApiKey> {
      const rows = await sql<ApiKeyRow[]>`
        INSERT INTO api_keys (
          id, user_id, label, prefix, lookup_digest, encrypted_key,
          encryption_key_version, status, quota_limit, quota_remaining,
          expires_at, created_at, revoked_at, last_used_at
        ) VALUES (
          ${input.id}, ${input.userId}, ${input.label}, ${input.prefix},
          ${input.lookupDigest}, ${input.encryptedKey}, ${input.encryptionKeyVersion},
          'active', ${input.quotaLimit}, ${input.quotaRemaining},
          ${input.expiresAt}, ${input.createdAt}, NULL, NULL
        )
        RETURNING *
      `;
      return toApiKey(requireRow(rows, "api_keys insert"));
    },

    /**
     * Revoke a key (§12: "keys can be revoked and rotated").
     *
     * Sets `status` and `revoked_at` in one statement because
     * `api_keys_revoked_status_agrees` requires them to move together. Guarded on
     * `status = 'active'` so a second revoke is a no-op returning null rather
     * than an error or a rewritten timestamp — the customer double-clicking
     * "revoke" is not an incident.
     */
    async revoke(id: string, at: Date): Promise<ApiKey | null> {
      const rows = await sql<ApiKeyRow[]>`
        UPDATE api_keys
        SET status = 'revoked', revoked_at = ${at}
        WHERE id = ${id} AND status = 'active'
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toApiKey(row);
    },

    /**
     * Raise the lifetime limit and reset expiry for a top-up (§11 "Top-up rules").
     *
     * ORDERING MATTERS, and this is the reason the method exists separately from
     * `quotaRepository.recordTopUp`. `api_keys_remaining_within_limit` requires
     * `quota_remaining <= quota_limit`, and PostgreSQL evaluates a CHECK at the end
     * of each STATEMENT, not at commit. So the limit must be raised BEFORE the
     * balance is credited, or the credit aborts the transaction. `executeActivation`
     * calls this first and `recordTopUp` second for exactly that reason.
     *
     * This method deliberately does NOT touch `quota_remaining` — the ledger row and
     * the balance move together in `recordTopUp`, and splitting the balance write
     * across two places is how a ledger stops agreeing with its key.
     *
     * Guarded on `status = 'active'`: §11 only permits topping up an active key, and
     * `decideActivation` has already checked that against the state it read under the
     * lock. The guard is here in case the two disagree, in which case null is
     * returned and the caller routes the order to review rather than crediting a dead
     * key.
     */
    async applyTopUpWindow(
      id: string,
      quotaLimitAfter: number,
      expiresAt: Date,
    ): Promise<ApiKey | null> {
      const rows = await sql<ApiKeyRow[]>`
        UPDATE api_keys
        SET quota_limit = ${quotaLimitAfter}, expires_at = ${expiresAt}
        WHERE id = ${id} AND status = 'active' AND quota_limit <= ${quotaLimitAfter}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toApiKey(row);
    },

    /**
     * Mark one key expired.
     *
     * `revoked_at` stays NULL: the CHECK ties it to `status = 'revoked'` only, and
     * expiry is not revocation. `expires_at` already records when it lapsed.
     */
    async markExpired(id: string): Promise<ApiKey | null> {
      const rows = await sql<ApiKeyRow[]>`
        UPDATE api_keys
        SET status = 'expired'
        WHERE id = ${id} AND status = 'active'
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toApiKey(row);
    },

    /**
     * THE EXPIRY SWEEP (§11: 24h validity).
     *
     * Uses `api_keys_active_expiry_idx (expires_at) WHERE status = 'active'` —
     * the partial index exists for exactly this query, so the sweep never scans
     * keys that are already terminal.
     *
     * `limit` bounds the batch so one pass cannot lock a large fraction of the
     * table; the worker loops until fewer than `limit` rows come back.
     *
     * Returns the ids it expired so the caller can append `expiry` ledger rows and
     * audit entries. Pass a `tx` when you want those in the same transaction.
     */
    async sweepExpired(now: Date, limit = 500): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        UPDATE api_keys
        SET status = 'expired'
        WHERE id IN (
          SELECT id FROM api_keys
          WHERE status = 'active' AND expires_at <= ${now}
          ORDER BY expires_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `;
      return rows.map((row) => row.id);
    },

    /** Keys past `expires_at` but still marked active — what the sweep will take. */
    async listExpiring(now: Date, limit = 500): Promise<ApiKey[]> {
      const rows = await sql<ApiKeyRow[]>`
        SELECT * FROM api_keys
        WHERE status = 'active' AND expires_at <= ${now}
        ORDER BY expires_at
        LIMIT ${limit}
      `;
      return rows.map(toApiKey);
    },

    /**
     * Record that a key was just used.
     *
     * Deliberately NOT part of the authentication read: writing on every request
     * would turn a read-only hot path into a write and contend on the row with the
     * settle transaction. The gateway calls this out-of-band (or the worker does
     * when it settles), and `last_used_at` is therefore approximate — which is all
     * the dashboard needs it for.
     */
    async touchLastUsed(id: string, clock: Clock): Promise<void> {
      await sql`
        UPDATE api_keys SET last_used_at = ${clock.now()} WHERE id = ${id}
      `;
    },

    /** Admin: revoke every key belonging to a user, e.g. on account suspension. */
    async revokeAllForUser(userId: string, at: Date): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        UPDATE api_keys
        SET status = 'revoked', revoked_at = ${at}
        WHERE user_id = ${userId} AND status = 'active'
        RETURNING id
      `;
      return rows.map((row) => row.id);
    },
  };
}
