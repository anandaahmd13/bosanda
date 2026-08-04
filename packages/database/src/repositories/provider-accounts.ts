/**
 * `provider_accounts` + `provider_health_events` (PLAN.md §6 credentials, §7
 * routing and cooldown).
 *
 * ── CREDENTIAL MATERIAL IS QUARANTINED TO ONE METHOD ───────────────────────
 * §16 forbids logging or returning a provider credential. `ProviderAccount` (see
 * `rows.ts`) deliberately has NO `encryptedCredentials` field, so the ordinary
 * reads — selection, admin listing, health — cannot leak ciphertext even by
 * accident. Exactly one method hands it out, `readCredentials`, named so that
 * `grep readCredentials` enumerates every place credential material is touched.
 *
 * The ciphertext is never decrypted here. Sealing and opening belong to
 * `@bosanda/api-keys`; this file moves opaque strings.
 *
 * ── ROTATION IS A COMPARE-AND-SWAP ─────────────────────────────────────────
 * §6 requires a single-flight refresh. Two workers may both notice an expiring
 * token; both mint a replacement; the slower one must NOT overwrite the newer
 * credential with its older one, or every request afterwards presents a token the
 * upstream has already rotated away from.
 *
 * `rotateCredentials` therefore guards on the `credential_version` the caller read
 * and bumps it on success. The loser gets `{ ok: false, reason:
 * "version_conflict", currentVersion }` — a returned outcome, matching
 * `packagesRepository`'s stock CAS, because losing is expected and the correct
 * response is "re-read and use the credential the winner wrote", not an exception.
 *
 * ── THE STATUS SPELLING MISMATCH ───────────────────────────────────────────
 * The schema says `cooldown`/`invalid`; the frozen `@bosanda/provider-core`
 * contract says `cooling_down`/`credential_invalid`. Neither may change — the
 * schema is immutable after release (§14), the adapter contract is frozen (§6).
 * `toAccountStatus`/`fromAccountStatus` in `rows.ts` translate at this boundary and
 * are unit-tested for round-trip fidelity. Methods here accept the DATABASE
 * spelling; `toHealth` below emits the CONTRACT spelling.
 */

import { type Executor, firstRow, requireRow } from "./executor.js";
import {
  type ProviderAccount,
  type ProviderAccountCredentials,
  type ProviderAccountRow,
  type ProviderAccountStatus,
  type ProviderHealthEvent,
  type ProviderHealthEventRow,
  type SchedulerAccountStatus,
  bigintToNumber,
  toAccountStatus,
  toProviderAccount,
  toProviderHealthEvent,
} from "./rows.js";
import {
  type Pagination,
  type RotateOutcome,
  classifyRotateFailure,
  normalizePagination,
} from "./decisions.js";

export type InsertProviderAccountInput = {
  id: string;
  providerType: string;
  label: string;
  status: ProviderAccountStatus;
  region: string | null;
  persona: string | null;
  /** Sealed envelope. Null for an App Server-managed account. */
  encryptedCredentials: string | null;
  encryptionKeyVersion: number | null;
  profileArn: string | null;
  createdAt: Date;
};

export type RotateCredentialsInput = {
  accountId: string;
  /** The version read before minting the replacement. The CAS operand (§6). */
  expectedVersion: number;
  encryptedCredentials: string;
  encryptionKeyVersion: number;
  /** Present when the refresh returned a new profile ARN; null leaves it unchanged. */
  profileArn?: string | null;
  at: Date;
};

export type InsertHealthEventInput = {
  id: string;
  providerAccountId: string;
  /** Public model ID, when the event is model-specific. */
  modelId: string | null;
  /** Classified event name, e.g. "throttled", "credential_refreshed" (§17). */
  eventType: string;
  /** Classified error class. NEVER an upstream payload or message (§16). */
  errorClass: string | null;
  cooldownUntil: Date | null;
  adapterVersion: string | null;
  createdAt: Date;
};

/**
 * The `AccountHealth` shape the scheduler consumes, built from a row.
 *
 * `errorScore` and `activeRequests` are 0 here and NOT read from the database: §7
 * scores them from in-memory recent-error and in-flight counters
 * (`HealthTracker`, `CooldownRegistry` in `@bosanda/provider-core`), which are
 * per-process and intentionally not persisted. The caller merges its live figures
 * over this. Returning 0 rather than inventing a value keeps the source of truth
 * where §7 puts it.
 */
export type PersistedAccountHealth = {
  accountId: string;
  status: SchedulerAccountStatus;
  cooldownUntil: Date | null;
  lastValidatedAt: Date | null;
  errorScore: number;
  activeRequests: number;
  region: string;
  persona: string;
};

export function toPersistedHealth(account: ProviderAccount): PersistedAccountHealth {
  return {
    accountId: account.id,
    status: toAccountStatus(account.status),
    cooldownUntil: account.cooldownUntil,
    lastValidatedAt: account.lastValidatedAt,
    errorScore: 0,
    activeRequests: 0,
    // `AccountHealth.region` and `.persona` are non-null in the frozen contract but
    // nullable in the schema. Empty string marks "unset" without a cast; the
    // scheduler treats an unmatched region as ineligible, which is the safe default.
    region: account.region ?? "",
    persona: account.persona ?? "",
  };
}

export type ProviderAccountsRepository = ReturnType<typeof providerAccountsRepository>;

export function providerAccountsRepository(sql: Executor) {
  return {
    /**
     * THE SELECTION QUERY (§7 "Provider account selection").
     *
     * Written to match `provider_accounts_selection_idx (provider_type, status,
     * cooldown_until)` exactly: equality on the first two columns, a range on the
     * third, so the index satisfies the whole predicate.
     *
     * "Eligible" means active AND not cooling down. A `cooldown_until` in the past
     * still counts as eligible even if the status has not yet been flipped back by a
     * sweep — the timestamp is the authority, so a lagging status column cannot
     * strand capacity.
     *
     * Returns accounts WITHOUT credentials. The scheduler picks one, and only then
     * does the caller fetch its credential via `readCredentials`.
     */
    async listEligible(providerType: string, now: Date): Promise<ProviderAccount[]> {
      const rows = await sql<ProviderAccountRow[]>`
        SELECT * FROM provider_accounts
        WHERE provider_type = ${providerType}
          AND status = 'active'
          AND (cooldown_until IS NULL OR cooldown_until <= ${now})
        ORDER BY last_validated_at ASC NULLS FIRST, id
      `;
      return rows.map(toProviderAccount);
    },

    /**
     * Eligible accounts as `AccountHealth`-shaped records, ready to merge with the
     * in-memory health the scheduler holds. See `toPersistedHealth` for why
     * `errorScore`/`activeRequests` are zero.
     */
    async listEligibleHealth(providerType: string, now: Date): Promise<PersistedAccountHealth[]> {
      const accounts = await this.listEligible(providerType, now);
      return accounts.map(toPersistedHealth);
    },

    /** Every account of a type, any status — the admin health table (§15). */
    async listByType(providerType: string): Promise<ProviderAccount[]> {
      const rows = await sql<ProviderAccountRow[]>`
        SELECT * FROM provider_accounts
        WHERE provider_type = ${providerType}
        ORDER BY label, id
      `;
      return rows.map(toProviderAccount);
    },

    async findById(id: string): Promise<ProviderAccount | null> {
      const rows = await sql<ProviderAccountRow[]>`
        SELECT * FROM provider_accounts WHERE id = ${id}
      `;
      const row = firstRow(rows);
      return row === null ? null : toProviderAccount(row);
    },

    /**
     * Account ids an operator has taken out of rotation — the `disabledAccounts` set
     * `killSwitchesFromEnv` asks the caller to supply (§3).
     *
     * `disabled` and `invalid` only. A cooling-down account is not disabled: it is
     * temporarily unavailable and recovers on its own, whereas these two need
     * operator action.
     */
    async listDisabledIds(providerType: string): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM provider_accounts
        WHERE provider_type = ${providerType} AND status IN ('disabled', 'invalid')
      `;
      return rows.map((row) => row.id);
    },

    async insert(input: InsertProviderAccountInput): Promise<ProviderAccount> {
      const rows = await sql<ProviderAccountRow[]>`
        INSERT INTO provider_accounts (
          id, provider_type, label, status, region, persona,
          encrypted_credentials, encryption_key_version, profile_arn,
          credential_version, cooldown_until, last_validated_at,
          created_at, updated_at
        ) VALUES (
          ${input.id}, ${input.providerType}, ${input.label}, ${input.status},
          ${input.region}, ${input.persona}, ${input.encryptedCredentials},
          ${input.encryptionKeyVersion}, ${input.profileArn},
          0, NULL, NULL, ${input.createdAt}, ${input.createdAt}
        )
        RETURNING *
      `;
      return toProviderAccount(requireRow(rows, "provider_accounts insert"));
    },

    // ─────────────────────── credentials (§6, §16) ───────────────────────

    /**
     * THE ONLY METHOD THAT RETURNS CREDENTIAL MATERIAL.
     *
     * The caller decrypts with the `@bosanda/api-keys` envelope, uses the result,
     * and must not retain, log, or serialize either the ciphertext or the plaintext
     * (§6, §16). `credentialVersion` comes back because a refresh must present it to
     * `rotateCredentials`.
     */
    async readCredentials(accountId: string): Promise<ProviderAccountCredentials | null> {
      const rows = await sql<
        {
          id: string;
          encrypted_credentials: string | null;
          encryption_key_version: number | null;
          credential_version: string;
          region: string | null;
          persona: string | null;
          profile_arn: string | null;
        }[]
      >`
        SELECT id, encrypted_credentials, encryption_key_version, credential_version,
               region, persona, profile_arn
        FROM provider_accounts
        WHERE id = ${accountId}
      `;
      const row = firstRow(rows);
      if (row === null || row.encrypted_credentials === null || row.encryption_key_version === null) return null;
      return {
        accountId: row.id,
        encryptedCredentials: row.encrypted_credentials,
        encryptionKeyVersion: row.encryption_key_version,
        credentialVersion: bigintToNumber(
          row.credential_version,
          "provider_accounts.credential_version",
        ),
        region: row.region,
        persona: row.persona,
        profileArn: row.profile_arn,
      };
    },

    /**
     * Rotate a refresh token, bumping `credential_version` (§6 single-flight).
     *
     * THE CAS: guarded on `credential_version = expectedVersion`. The winner's write
     * applies and the version advances; the loser matches no row, re-reads, and is
     * told the current version so it can adopt the winner's credential instead of
     * clobbering it.
     *
     * `last_validated_at` moves too: a successful refresh IS a validation, and §7
     * uses that timestamp to order selection.
     *
     * `profileArn` is only written when explicitly supplied. `undefined` means
     * "unchanged" while `null` means "clear it" — distinguished because an ARN that
     * a refresh did not report is not the same as an ARN that was removed.
     */
    async rotateCredentials(input: RotateCredentialsInput): Promise<RotateOutcome> {
      const rows =
        input.profileArn === undefined
          ? await sql<{ credential_version: string }[]>`
              UPDATE provider_accounts
              SET encrypted_credentials = ${input.encryptedCredentials},
                  encryption_key_version = ${input.encryptionKeyVersion},
                  credential_version = credential_version + 1,
                  last_validated_at = ${input.at},
                  updated_at = ${input.at}
              WHERE id = ${input.accountId} AND credential_version = ${input.expectedVersion}
              RETURNING credential_version
            `
          : await sql<{ credential_version: string }[]>`
              UPDATE provider_accounts
              SET encrypted_credentials = ${input.encryptedCredentials},
                  encryption_key_version = ${input.encryptionKeyVersion},
                  profile_arn = ${input.profileArn},
                  credential_version = credential_version + 1,
                  last_validated_at = ${input.at},
                  updated_at = ${input.at}
              WHERE id = ${input.accountId} AND credential_version = ${input.expectedVersion}
              RETURNING credential_version
            `;

      const row = firstRow(rows);
      if (row !== null) {
        return {
          ok: true,
          credentialVersion: bigintToNumber(
            row.credential_version,
            "provider_accounts.credential_version",
          ),
        };
      }

      // Lost the race, or the account is gone. Re-read to tell the two apart and
      // report the current version so the caller can adopt it.
      const observed = await sql<{ credential_version: string }[]>`
        SELECT credential_version FROM provider_accounts WHERE id = ${input.accountId}
      `;
      const observedRow = firstRow(observed);
      return classifyRotateFailure(
        observedRow === null
          ? null
          : {
              credentialVersion: bigintToNumber(
                observedRow.credential_version,
                "provider_accounts.credential_version",
              ),
            },
      );
    },

    // ─────────────────────── status and cooldown (§7) ───────────────────────

    /**
     * Put an account in cooldown after a throttle or upstream failure (§7).
     *
     * Status moves to `cooldown` alongside the timestamp, so the selection query's
     * `status = 'active'` predicate excludes it immediately rather than relying on
     * every reader to also compare the timestamp.
     *
     * `GREATEST` never shortens an existing cooldown: §7 escalates the backoff on
     * repeated failures, and a later small failure must not undo a long penalty
     * imposed by an earlier severe one.
     */
    async setCooldown(accountId: string, until: Date, at: Date): Promise<ProviderAccount | null> {
      const rows = await sql<ProviderAccountRow[]>`
        UPDATE provider_accounts
        SET status = 'cooldown',
            cooldown_until = GREATEST(${until}, COALESCE(cooldown_until, ${until})),
            updated_at = ${at}
        WHERE id = ${accountId} AND status IN ('active', 'cooldown')
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toProviderAccount(row);
    },

    /**
     * Set status explicitly — the operator's disable/enable lever (§3, §15) and how
     * a refresh reports `invalid` when a credential is unrecoverable (§7).
     *
     * Returning to `active` clears `cooldown_until`, since a stale timestamp would
     * make the account look ineligible to a reader that checks it.
     */
    async setStatus(
      accountId: string,
      status: ProviderAccountStatus,
      at: Date,
    ): Promise<ProviderAccount | null> {
      const rows = await sql<ProviderAccountRow[]>`
        UPDATE provider_accounts
        SET status = ${status},
            cooldown_until = CASE WHEN ${status} = 'active' THEN NULL ELSE cooldown_until END,
            updated_at = ${at}
        WHERE id = ${accountId}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toProviderAccount(row);
    },

    /**
     * Return cooled-down accounts to service once their penalty has elapsed.
     *
     * The sweep exists because `listEligible` treats a lapsed timestamp as eligible
     * regardless of status; this keeps the status column honest for the admin view.
     * Returns the ids it reactivated.
     */
    async clearElapsedCooldowns(now: Date, limit = 200): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        UPDATE provider_accounts
        SET status = 'active', cooldown_until = NULL, updated_at = ${now}
        WHERE id IN (
          SELECT id FROM provider_accounts
          WHERE status = 'cooldown'
            AND cooldown_until IS NOT NULL
            AND cooldown_until <= ${now}
          ORDER BY cooldown_until
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `;
      return rows.map((row) => row.id);
    },

    /** Record a successful validation without touching credentials. */
    async markValidated(accountId: string, at: Date): Promise<void> {
      await sql`
        UPDATE provider_accounts
        SET last_validated_at = ${at}, updated_at = ${at}
        WHERE id = ${accountId}
      `;
    },

    // ─────────────────────── health events (§7, §17) ───────────────────────

    /**
     * Append a health event.
     *
     * Append-only by construction: there is no update or delete for this table.
     * §7 wants "provider exhaustion or error history" preserved, and §16 requires
     * `errorClass` to be a CLASSIFIED string — never an upstream message, which can
     * echo prompt content or credential fragments.
     */
    async insertHealthEvent(input: InsertHealthEventInput): Promise<ProviderHealthEvent> {
      const rows = await sql<ProviderHealthEventRow[]>`
        INSERT INTO provider_health_events (
          id, provider_account_id, model_id, event_type, error_class,
          cooldown_until, adapter_version, created_at
        ) VALUES (
          ${input.id}, ${input.providerAccountId}, ${input.modelId}, ${input.eventType},
          ${input.errorClass}, ${input.cooldownUntil}, ${input.adapterVersion},
          ${input.createdAt}
        )
        RETURNING *
      `;
      return toProviderHealthEvent(requireRow(rows, "provider_health_events insert"));
    },

    /**
     * Recent history for one account, newest first. Matches
     * `provider_health_events_account_idx (provider_account_id, created_at DESC)`.
     */
    async recentHealthEvents(
      providerAccountId: string,
      paging: Pagination = {},
    ): Promise<ProviderHealthEvent[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<ProviderHealthEventRow[]>`
        SELECT * FROM provider_health_events
        WHERE provider_account_id = ${providerAccountId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toProviderHealthEvent);
    },

    /**
     * Error counts per account over a window — the §15 health dashboard.
     *
     * Only rows carrying an `error_class` are counted; a `credential_refreshed`
     * event is history, not an error.
     */
    async errorCountsSince(
      providerType: string,
      since: Date,
    ): Promise<{ providerAccountId: string; errorClass: string; count: number }[]> {
      const rows = await sql<{ provider_account_id: string; error_class: string; total: string }[]>`
        SELECT e.provider_account_id, e.error_class, COUNT(*)::TEXT AS total
        FROM provider_health_events e
        JOIN provider_accounts a ON a.id = e.provider_account_id
        WHERE a.provider_type = ${providerType}
          AND e.created_at >= ${since}
          AND e.error_class IS NOT NULL
        GROUP BY e.provider_account_id, e.error_class
        ORDER BY COUNT(*) DESC, e.provider_account_id
      `;
      return rows.map((row) => ({
        providerAccountId: row.provider_account_id,
        errorClass: row.error_class,
        count: bigintToNumber(row.total, "provider health error count"),
      }));
    },

    /**
     * Trim health history (§14 retention). Batched so one pass cannot hold locks
     * across the whole table; the worker loops while the count equals `limit`.
     */
    async deleteHealthEventsOlderThan(before: Date, limit = 1000): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM provider_health_events
        WHERE id IN (
          SELECT id FROM provider_health_events
          WHERE created_at < ${before}
          ORDER BY created_at
          LIMIT ${limit}
        )
        RETURNING id
      `;
      return rows.length;
    },
  };
}
