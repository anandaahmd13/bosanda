/**
 * `users` (PLAN.md §12 accounts, §15 admin user list).
 *
 * ── NO CRYPTO HERE ─────────────────────────────────────────────────────────
 * `@bosanda/auth` owns hashing and verification. This file stores and returns an
 * opaque `passwordHash` string and never computes, compares, or validates one.
 * The caller does:
 *
 *   const hash = await hashPassword(password);            // @bosanda/auth
 *   await usersRepository(sql).insert({ ..., passwordHash: hash });
 *
 *   const user = await usersRepository(sql).findByUsername(name);
 *   const outcome = await attemptLogin({ username, password, user });  // @bosanda/auth
 *
 * `attemptLogin` needs the hash, which is why `User` carries it. It must never be
 * logged or serialized (§16); `toPublicUser` in `rows.ts` is the shape that may
 * cross an API boundary, and every method here that feeds an admin listing already
 * returns that.
 *
 * ── CASE-INSENSITIVE USERNAMES ─────────────────────────────────────────────
 * `users_username_lower_key` is UNIQUE on `lower(username)`: "Budi" and "budi" must
 * not be two accounts (§14). Lookups therefore compare `lower(username) =
 * lower($1)` so the index is used and the semantics match the constraint. Callers
 * should still pass the value through `normalizeUsername` from `@bosanda/auth`
 * before storing, so the display form is canonical too.
 */

import { type Executor, firstRow, requireRow } from "./executor.js";
import {
  type PublicUser,
  type User,
  type UserRole,
  type UserRow,
  type UserStatus,
  bigintToNumber,
  toPublicUser,
  toUser,
} from "./rows.js";
import { type Pagination, normalizePagination } from "./decisions.js";

export type InsertUserInput = {
  id: string;
  /** Store the value `normalizeUsername` produced (§12). */
  username: string;
  /** From `hashPassword` in `@bosanda/auth`. Opaque here. */
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
};

/** One row of the admin user list (§15), with key counts. */
export type AdminUserSummary = {
  user: PublicUser;
  activeKeys: number;
  totalKeys: number;
};

export type UsersRepository = ReturnType<typeof usersRepository>;

export type BootstrapAdminInput = InsertUserInput;

export function usersRepository(sql: Executor) {
  return {
    /**
     * Serialize first-admin bootstrap callers in the database transaction.
     *
     * `hasAdmin()` followed by `insert()` is not enough: two CLI processes can both
     * observe an empty table. The transaction-scoped advisory lock is intentionally
     * separate from migration locking, and the recheck happens on the transaction
     * executor supplied by the caller.
     */
    async bootstrapAdmin(input: InsertUserInput): Promise<User | null> {
      await sql`SELECT pg_advisory_xact_lock(48_205_317)`;
      const existing = await this.hasAdmin();
      if (existing) return null;
      return this.insert(input);
    },

    /**
     * THE LOGIN LOOKUP. Case-insensitive, matching `users_username_lower_key`.
     *
     * Returns the row INCLUDING the password hash, because `attemptLogin` needs it to
     * verify. Returns null for an unknown username — and the caller must not shortcut
     * on that: §12 requires a decoy verification so a missing account and a wrong
     * password take the same time. `attemptLogin` handles it when passed `user: null`,
     * which is why this returns null rather than throwing.
     */
    async findByUsername(username: string): Promise<User | null> {
      const rows = await sql<UserRow[]>`
        SELECT * FROM users WHERE lower(username) = lower(${username})
      `;
      const row = firstRow(rows);
      return row === null ? null : toUser(row);
    },

    async findById(id: string): Promise<User | null> {
      const rows = await sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
      const row = firstRow(rows);
      return row === null ? null : toUser(row);
    },

    /** Same lookup without the hash — for session context and anything outward-facing. */
    async findPublicById(id: string): Promise<PublicUser | null> {
      const user = await this.findById(id);
      return user === null ? null : toPublicUser(user);
    },

    /**
     * Create an account.
     *
     * A duplicate username violates `users_username_lower_key` and surfaces as the
     * driver's unique-violation error. It is NOT caught and converted here: the
     * registration path in `@bosanda/auth` decides what a taken username means to the
     * user, and swallowing it into a null return would make a genuine constraint bug
     * indistinguishable from normal contention.
     */
    async insert(input: InsertUserInput): Promise<User> {
      const rows = await sql<UserRow[]>`
        INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES (
          ${input.id}, ${input.username}, ${input.passwordHash},
          ${input.role}, ${input.status}, ${input.createdAt}, ${input.createdAt}
        )
        RETURNING *
      `;
      return toUser(requireRow(rows, "users insert"));
    },

    /**
     * Replace the password hash (§12 password change and admin-initiated reset).
     *
     * Sessions are NOT revoked here even though §12 requires it after a reset —
     * that is `sessionsRepository.revokeAllForUser`, and the two must be called in
     * ONE transaction so a crash between them cannot leave the old sessions live
     * against a new password. `resetPasswordAsAdmin` in `@bosanda/auth` describes the
     * same sequencing.
     */
    async setPasswordHash(id: string, passwordHash: string, at: Date): Promise<User | null> {
      const rows = await sql<UserRow[]>`
        UPDATE users
        SET password_hash = ${passwordHash}, updated_at = ${at}
        WHERE id = ${id}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toUser(row);
    },

    /**
     * Suspend or reactivate (§12: "a suspended account's keys must stop working").
     *
     * Enforcement is NOT here: the gateway's `findByLookupDigest` joins this status
     * and `decideKeyAuth` rejects on it, so suspension takes effect on the next
     * request without a second write. Revoking the keys as well is a separate,
     * deliberate choice — `apiKeysRepository.revokeAllForUser` exists for when an
     * operator wants suspension to be irreversible for existing keys.
     */
    async setStatus(id: string, status: UserStatus, at: Date): Promise<PublicUser | null> {
      const rows = await sql<UserRow[]>`
        UPDATE users SET status = ${status}, updated_at = ${at}
        WHERE id = ${id}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toPublicUser(toUser(row));
    },

    /** Promote or demote. Guarded by the `role` CHECK to the two known values. */
    async setRole(id: string, role: UserRole, at: Date): Promise<PublicUser | null> {
      const rows = await sql<UserRow[]>`
        UPDATE users SET role = ${role}, updated_at = ${at}
        WHERE id = ${id}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toPublicUser(toUser(row));
    },

    /**
     * The admin user list (§15), without password hashes.
     *
     * `search` matches a username substring, case-insensitively. This one does NOT
     * use `users_username_lower_key` — a leading-wildcard LIKE cannot — and that is
     * accepted: the admin list is a low-frequency human-driven query, and adding a
     * trigram index would mean a new migration for a page one operator uses.
     *
     * The filter is a single static template with `(${value} IS NULL OR ...)`
     * branches, the same construction `ordersRepository.list` documents: no fragment
     * concatenation, so no path by which a filter value becomes SQL.
     */
    async list(
      filter: { search?: string; status?: UserStatus; role?: UserRole } = {},
      paging: Pagination = {},
    ): Promise<PublicUser[]> {
      const { limit, offset } = normalizePagination(paging);
      const search =
        typeof filter.search === "string" && filter.search.trim().length > 0
          ? `%${filter.search.trim()}%`
          : null;
      const status = filter.status ?? null;
      const role = filter.role ?? null;

      const rows = await sql<UserRow[]>`
        SELECT * FROM users
        WHERE (${search}::TEXT IS NULL OR username ILIKE ${search})
          AND (${status}::TEXT IS NULL OR status = ${status})
          AND (${role}::TEXT IS NULL OR role = ${role})
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map((row) => toPublicUser(toUser(row)));
    },

    /** Count for the same filter, for pagination controls. */
    async count(
      filter: { search?: string; status?: UserStatus; role?: UserRole } = {},
    ): Promise<number> {
      const search =
        typeof filter.search === "string" && filter.search.trim().length > 0
          ? `%${filter.search.trim()}%`
          : null;
      const status = filter.status ?? null;
      const role = filter.role ?? null;

      const rows = await sql<{ total: string }[]>`
        SELECT COUNT(*)::TEXT AS total FROM users
        WHERE (${search}::TEXT IS NULL OR username ILIKE ${search})
          AND (${status}::TEXT IS NULL OR status = ${status})
          AND (${role}::TEXT IS NULL OR role = ${role})
      `;
      const row = firstRow(rows);
      return row === null ? 0 : bigintToNumber(row.total, "users count");
    },

    /**
     * The admin list enriched with key counts (§15 "customer list with key status").
     *
     * One query with a LATERAL aggregate rather than N+1 per user. `activeKeys`
     * counts only `status = 'active'`, which is the number an operator judges an
     * account by; `totalKeys` gives the history.
     */
    async listWithKeyCounts(paging: Pagination = {}): Promise<AdminUserSummary[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<(UserRow & { active_keys: string; total_keys: string })[]>`
        SELECT u.*, k.active_keys, k.total_keys
        FROM users u
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE status = 'active')::TEXT AS active_keys,
                 COUNT(*)::TEXT                                 AS total_keys
          FROM api_keys
          WHERE user_id = u.id
        ) k ON TRUE
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map((row) => ({
        user: toPublicUser(toUser(row)),
        activeKeys: bigintToNumber(row.active_keys, "user active key count"),
        totalKeys: bigintToNumber(row.total_keys, "user total key count"),
      }));
    },

    /**
     * Whether any admin exists — the bootstrap guard.
     *
     * `admin:bootstrap` in the root package.json creates the first admin, and it must
     * refuse to run twice. Exposed as a repository method so the CLI does not write
     * its own SQL.
     */
    async hasAdmin(): Promise<boolean> {
      const rows = await sql<{ present: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin') AS present
      `;
      const row = firstRow(rows);
      return row !== null && row.present;
    },
  };
}
