/**
 * `sessions` (PLAN.md §12 website sessions).
 *
 * ── NO CRYPTO HERE ─────────────────────────────────────────────────────────
 * `@bosanda/auth` mints the token and computes its keyed digest. This file stores
 * the digest and looks up by it. The plaintext cookie value never reaches this
 * layer, which is what makes "only a hash is stored" checkable by reading one
 * package:
 *
 *   const { token, record } = startSession(userId, keyring, clock);  // @bosanda/auth
 *   await sessionsRepository(sql).insert({ id: ulid(), ...record });
 *   // token.plaintext goes in the Set-Cookie header and nowhere else.
 *
 *   const digest = sessionDigest(cookieValue, keyring);              // @bosanda/auth
 *   const session = await sessionsRepository(sql).findByTokenHash(digest);
 *   const validity = evaluateSession(session, clock.now());          // @bosanda/auth
 *
 * The lookup is a plain equality on a UNIQUE indexed column. Constant-time
 * comparison (`digestsMatch`) is not applicable to an index probe and is not needed:
 * the value being compared is already an HMAC an attacker cannot compute without the
 * session secret.
 *
 * ── VALIDITY IS DECIDED BY @bosanda/auth, NOT HERE ─────────────────────────
 * `findByTokenHash` returns expired and revoked sessions rather than filtering them
 * out, because `evaluateSession` distinguishes `unknown`/`revoked`/`expired`/`idle`
 * and an operator debugging a logout needs to know which applied. A SQL predicate
 * would collapse all four into "not found". `touchLastUsed` advances the persisted
 * activity time only for a live session, which makes §12's three-day idle window
 * genuinely sliding once the HTTP session path calls it.
 */

import { type Executor, firstRow, requireRow } from "./executor.js";
import {
  type Session,
  type SessionRow,
  type PublicUser,
  type UserRow,
  toPublicUser,
  toSession,
  toUser,
} from "./rows.js";

export type InsertSessionInput = {
  id: string;
  userId: string;
  /** The keyed digest from `sessionDigest`. Never the plaintext token. */
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date;
};

/** A session plus its owner, as one round trip. */
export type SessionWithUser = {
  session: Session;
  user: PublicUser;
};

export type SessionsRepository = ReturnType<typeof sessionsRepository>;

export function sessionsRepository(sql: Executor) {
  return {
    /**
     * Create a session (§12: rotation on login AND after password reset).
     *
     * `sessions_expiry_after_creation` CHECKs that `expires_at > created_at`, so a
     * zero-or-negative lifetime aborts rather than persisting a session that is dead
     * on arrival.
     */
    async insert(input: InsertSessionInput): Promise<Session> {
      const rows = await sql<SessionRow[]>`
        INSERT INTO sessions (
          id, user_id, token_hash, expires_at, revoked_at, created_at, last_used_at
        )
        VALUES (
          ${input.id}, ${input.userId}, ${input.tokenHash},
          ${input.expiresAt}, NULL, ${input.createdAt}, ${input.lastUsedAt}
        )
        RETURNING *
      `;
      return toSession(requireRow(rows, "sessions insert"));
    },

    /**
     * Look up by digest — the per-request session read.
     *
     * Hits the UNIQUE constraint on `token_hash`. Returns revoked and expired rows;
     * `evaluateSession` decides (see the file header).
     */
    async findByTokenHash(tokenHash: string): Promise<Session | null> {
      const rows = await sql<SessionRow[]>`
        SELECT * FROM sessions WHERE token_hash = ${tokenHash}
      `;
      const row = firstRow(rows);
      return row === null ? null : toSession(row);
    },

    /**
     * THE WEBSITE HOT PATH: session and user in one query.
     *
     * Every authenticated page needs both — the session to validate and the user's
     * status and role to authorize. Two round trips would double the latency of every
     * request and admit a window where a suspended user's session still authorizes
     * (§12). The user comes back WITHOUT the password hash: nothing on the session
     * path has any use for it.
     */
    async findWithUser(tokenHash: string): Promise<SessionWithUser | null> {
      const rows = await sql<(SessionRow & { u_id: string } & UserColumns)[]>`
        SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.revoked_at, s.created_at,
               s.last_used_at,
               u.id         AS u_id,
               u.username   AS u_username,
               u.role       AS u_role,
               u.status     AS u_status,
               u.created_at AS u_created_at,
               u.updated_at AS u_updated_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${tokenHash}
      `;
      const row = firstRow(rows);
      if (row === null) return null;

      // Built explicitly rather than spread, so the password hash cannot arrive by
      // accident if this SELECT is ever widened.
      const userRow: UserRow = {
        id: row.u_id,
        username: row.u_username,
        // Never selected. `toPublicUser` drops it immediately; the placeholder exists
        // only to satisfy the row type and is not a real hash.
        password_hash: "",
        role: row.u_role,
        status: row.u_status,
        created_at: row.u_created_at,
        updated_at: row.u_updated_at,
      };

      return { session: toSession(row), user: toPublicUser(toUser(userRow)) };
    },

    async findById(id: string): Promise<Session | null> {
      const rows = await sql<SessionRow[]>`SELECT * FROM sessions WHERE id = ${id}`;
      const row = firstRow(rows);
      return row === null ? null : toSession(row);
    },

    /**
     * Advance the sliding-idle timestamp after a successfully validated request.
     *
     * The guards make the update monotonic and refuse revoked or expired sessions.
     * Clamping at `expires_at` keeps the schema constraint true at the exact absolute
     * deadline; the next validity check rejects that session as expired.
     */
    async touchLastUsed(id: string, at: Date): Promise<Session | null> {
      const rows = await sql<SessionRow[]>`
        UPDATE sessions
        SET last_used_at = LEAST(${at}, expires_at)
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND expires_at >= ${at}
          AND last_used_at < ${at}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toSession(row);
    },

    /** A user's sessions, newest first. Uses `sessions_user_id_idx`. */
    async listForUser(userId: string): Promise<Session[]> {
      const rows = await sql<SessionRow[]>`
        SELECT * FROM sessions WHERE user_id = ${userId} ORDER BY created_at DESC
      `;
      return rows.map(toSession);
    },

    /**
     * Log out one session.
     *
     * Guarded on `revoked_at IS NULL` so a second logout is a no-op returning null
     * rather than rewriting the timestamp — the audit trail should show when the
     * session was actually ended.
     */
    async revoke(id: string, at: Date): Promise<Session | null> {
      const rows = await sql<SessionRow[]>`
        UPDATE sessions SET revoked_at = ${at}
        WHERE id = ${id} AND revoked_at IS NULL
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toSession(row);
    },

    /** Log out by cookie digest, for a logout request that holds only the token. */
    async revokeByTokenHash(tokenHash: string, at: Date): Promise<Session | null> {
      const rows = await sql<SessionRow[]>`
        UPDATE sessions SET revoked_at = ${at}
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toSession(row);
    },

    /**
     * Revoke every live session for a user.
     *
     * REQUIRED by §12 after an admin-initiated password reset: "sessions are revoked
     * on admin-initiated password reset". Call it in the SAME transaction as
     * `usersRepository.setPasswordHash` — separate transactions leave a window in
     * which the old cookie still works against the new password.
     *
     * Returns the ids revoked, so the caller can record the count in `audit_events`.
     */
    async revokeAllForUser(userId: string, at: Date): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        UPDATE sessions SET revoked_at = ${at}
        WHERE user_id = ${userId} AND revoked_at IS NULL
        RETURNING id
      `;
      return rows.map((row) => row.id);
    },

    /**
     * Delete expired sessions.
     *
     * DELETE rather than mark: an expired session carries no audit value that
     * `audit_events` does not already hold, and the table would otherwise grow
     * without bound. Uses `sessions_expires_at_idx (expires_at) WHERE revoked_at IS
     * NULL`, the partial index that exists for this sweep; revoked rows are collected
     * by the same pass but reach it via a scan, which is acceptable because they are
     * comparatively rare.
     *
     * Batched, like the other sweeps: the worker loops while the count equals `limit`.
     */
    async deleteExpired(now: Date, limit = 1000): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM sessions
        WHERE id IN (
          SELECT id FROM sessions
          WHERE expires_at <= ${now}
          ORDER BY expires_at
          LIMIT ${limit}
        )
        RETURNING id
      `;
      return rows.length;
    },
  };
}

/** The aliased user columns in `findWithUser`. `password_hash` is deliberately absent. */
type UserColumns = {
  u_username: string;
  u_role: string;
  u_status: string;
  u_created_at: Date;
  u_updated_at: Date;
};
