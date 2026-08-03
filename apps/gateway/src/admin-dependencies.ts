/**
 * Production wiring for the admin surface (PLAN.md §15).
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `dependencies.ts` ────────────────────
 * `createDependencies` builds the inference hot path: the scheduler, the breakers, the
 * credential manager, the adapter. None of that is needed to answer
 * `GET /admin/v1/users`, and the admin surface needs ten repositories the metered surface
 * does not. Keeping the two factories apart means `dependencies.ts` grows by nothing at
 * all, and a deployment that does not mount the console pays for none of this.
 *
 * ── THE RAW SQL HERE IS DELIBERATE, AND IS THE EXCEPTION ──────────────────
 * Five queries below are written against `Executor` directly rather than through a
 * repository. Every one implements a port declared in `routes/admin/deps.ts` because the
 * frozen `packages/database` has no method for it — a cross-user key page, per-user
 * aggregates, per-order payment events, order free-text search, and the traffic window.
 * The alternative was a route that reports zeroes and calls it done.
 *
 * They belong here rather than in a route for two reasons: a handler that builds SQL is a
 * handler that can be made to build the wrong SQL, and when these queries move into
 * `@bosanda/database` (where they belong) this file shrinks and nothing else changes.
 *
 * Every one is parameterized through the `postgres` tagged template — the library sends
 * values out of band, so an operator-supplied search term cannot become SQL. `prefix` and
 * `q` are interpolated into a LIKE pattern as VALUES, never as fragments.
 */

import { keyringFromEnv, type Env, type SecretKeyring } from "@bosanda/config";
import {
  apiKeysRepository,
  auditRepository,
  bigintToNumber,
  checkConnection,
  executeActivation,
  flagsRepository,
  killSwitchesFrom,
  modelsRepository,
  ordersRepository,
  packagesRepository,
  providerAccountsRepository,
  quotaRepository,
  sessionsRepository,
  usageRepository,
  usersRepository,
  withTransaction,
  type Executor,
  type Sql,
} from "@bosanda/database";
import { createLogger, type Logger } from "@bosanda/observability";
import { killSwitchesFromEnv } from "@bosanda/provider-core";
import { systemClock, type Clock } from "@bosanda/shared";
import { BosandaError } from "@bosanda/protocol";
import { sealCredentials } from "@bosanda/provider-kiro";
import type {
  AdminApiKeyFilter,
  AdminApiKeyRow,
  AdminDeps,
  AdminPaymentEventRow,
  AdminReconciliationSnapshot,
  AdminTrafficBucket,
  AdminTrafficWindow,
  AdminUserAggregates,
} from "./routes/admin/index.js";
import { PROVIDER_TYPE } from "./dependencies.js";

export type CreateAdminDependenciesOptions = {
  env: Env;
  /**
   * The pool to share with the metered surface.
   *
   * Passed in rather than created: one process should hold ONE pool, and
   * `createDependencies` already accepts an `sql` for the same reason. Two pools in one
   * process would double the connection count against `max_connections` for no benefit.
   */
  sql: Sql;
  clock?: Clock;
  logger?: Logger;
  keyring?: SecretKeyring;
  /**
   * Probes a stored credential against the live provider.
   *
   * Injected because the probe needs the credential manager and the adapter, both of which
   * `createDependencies` builds. Keeping it a parameter means this file never holds a
   * decrypted credential — see `AdminDeps.validateAccount`.
   */
  validateAccount?: (accountId: string) => Promise<void>;
  /**
   * Streams this process is currently serving.
   *
   * Injected because the counter lives in the metered surface's observability plugin. An
   * admin-only process has none and reports zero — see `AdminDeps.activeStreams`.
   */
  activeStreams?: () => number;
};

export function createAdminDependencies(options: CreateAdminDependenciesOptions): AdminDeps {
  const { env, sql } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger({ service: "admin", level: env.LOG_LEVEL });
  const keyring = options.keyring ?? keyringFromEnv(env);

  return {
    env,
    clock,
    logger,
    keyring,

    killSwitches: async () => {
      const flags = await flagsRepository(sql).readAll();
      const baseline = killSwitchesFromEnv(env);
      return killSwitchesFrom(
        {
          adapterEnabled: baseline.adapterEnabled,
          toolUseEnabled: baseline.toolUseEnabled,
          disabledRegions: baseline.disabledRegions,
          disabledModels: baseline.disabledModels,
        },
        flags,
        baseline.disabledAccounts,
      );
    },

    sessions: sessionsRepository(sql),
    users: usersRepository(sql),
    apiKeys: apiKeysRepository(sql),
    quota: quotaRepository(sql),
    orders: ordersRepository(sql),
    packages: packagesRepository(sql),
    models: modelsRepository(sql),
    providerAccounts: providerAccountsRepository(sql),
    flags: flagsRepository(sql),
    usage: usageRepository(sql),
    audit: auditRepository(sql),

    apiKeyQuery: adminApiKeyQuery(sql),
    userQuery: adminUserQuery(sql),
    orderQuery: adminOrderQuery(sql),
    traffic: adminTrafficQuery(sql),
    reconciliation: adminReconciliationQuery(sql),

    /**
     * Live per-account counters are held in the provider-core registries, which belong to
     * the metered surface's dependency graph. An admin-only process has none, so this
     * reports an empty list and the provider table renders zeroes for `activeRequests`
     * and `errorScore` — the same values `toPersistedHealth` hardcodes. Wire the real
     * registries in by passing them through when the console runs in the gateway process.
     */
    liveAccounts: () => [],

    /**
     * In-flight streams are counted by the observability plugin on the metered surface,
     * which an admin-only process does not run. Zero is then accurate for THIS process
     * rather than a guess about the fleet, and `/overview` labels the figure as
     * process-local. Pass the real counter through when the console shares the gateway
     * process.
     */
    activeStreams: options.activeStreams ?? (() => 0),

    checkDatabase: () => checkConnection(sql),

    validateAccount:
      options.validateAccount ??
      (async () => {
        throw new BosandaError("internal_error", {
          internalDetail:
            "credential validation is not wired: createAdminDependencies was built without validateAccount",
        });
      }),

    /**
     * Seals an already-parsed credential.
     *
     * A thin pass-through to the frozen `sealCredentials`, kept as a port so no route
     * imports the keyring: a handler holding a keyring is a handler that could seal or open
     * anything. `profileArn` is lifted out because `provider_accounts.profile_arn` is its own
     * column — the scheduler reads it without opening the envelope, and an ARN is an
     * identifier rather than a secret.
     */
    sealCredential: (credentials) => {
      const sealed = sealCredentials(credentials, keyring);
      return {
        envelope: sealed.envelope,
        keyVersion: sealed.keyVersion,
        profileArn: credentials.profileArn,
      };
    },

    /**
     * One transaction, handing out the write-side repositories as a set.
     *
     * `providerAccounts` is the frozen repository PLUS the `update` writer the contract
     * needs and the repository lacks — spread together so a handler sees one object and
     * cannot tell which methods came from where.
     */
    transact: (fn) =>
      withTransaction(sql, (tx) =>
        fn({
          // Bound to THIS transaction, so the activation's ledger row, key row, stock
          // commit, and the admin audit row all commit together or not at all.
          // `executeActivation` detects a transaction handle and issues a SAVEPOINT rather
          // than a second BEGIN, so this is still one commit.
          activate: (input) => executeActivation(tx, input),
          audit: auditRepository(tx),
          users: usersRepository(tx),
          sessions: sessionsRepository(tx),
          apiKeys: apiKeysRepository(tx),
          quota: quotaRepository(tx),
          orders: ordersRepository(tx),
          packages: packagesRepository(tx),
          models: modelsRepository(tx),
          flags: flagsRepository(tx),
          providerAccounts: {
            ...providerAccountsRepository(tx),
            ...providerAccountWriter(tx),
          },
        }),
      ),
  };
}

/* ─────────────────────── ports the repositories lack ─────────────────────── */

/**
 * `label`, `region`, and `persona` are written once by `insert` and never updated.
 *
 * `POST /admin/v1/provider-accounts/:id` changes exactly those three. `rotateCredentials`
 * touches only credential columns and there is no other writer, so this is the missing
 * UPDATE. `updated_at` is advanced because every other writer in the repository does.
 */
function providerAccountWriter(sql: Executor) {
  return {
    async update(input: {
      accountId: string;
      label: string;
      region: string | null;
      persona: string | null;
      at: Date;
    }): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE provider_accounts
        SET label = ${input.label},
            region = ${input.region},
            persona = ${input.persona},
            updated_at = ${input.at}
        WHERE id = ${input.accountId}
        RETURNING id
      `;
      return rows.length > 0;
    },
  };
}

/**
 * The cross-user key page.
 *
 * `api_keys` is joined to `users` for the username the contract requires. No `encrypted_key`
 * and no `lookup_digest` are selected — the digest is a filter INPUT only, so a caller who
 * already holds one can identify its owner, and one that is not held cannot be harvested.
 */
function adminApiKeyQuery(sql: Executor) {
  const where = (filter: AdminApiKeyFilter) => ({
    // `LIKE` with the pattern passed as a VALUE. `prefix` is operator input; the library
    // parameterizes it, so a `%` inside it widens the match and can do nothing else.
    prefixPattern: filter.prefix === undefined ? null : `${filter.prefix}%`,
    lookupDigest: filter.lookupDigest ?? null,
  });

  return {
    async list(
      filter: AdminApiKeyFilter,
      paging: { limit: number; offset: number },
    ): Promise<AdminApiKeyRow[]> {
      const { prefixPattern, lookupDigest } = where(filter);
      const rows = await sql<
        {
          id: string;
          user_id: string;
          username: string;
          label: string | null;
          prefix: string;
          status: string;
          quota_limit: string;
          quota_remaining: string;
          expires_at: Date;
          created_at: Date;
          last_used_at: Date | null;
        }[]
      >`
        SELECT k.id, k.user_id, u.username, k.label, k.prefix, k.status,
               k.quota_limit, k.quota_remaining, k.expires_at, k.created_at, k.last_used_at
        FROM api_keys k
        JOIN users u ON u.id = k.user_id
        WHERE (${prefixPattern}::text IS NULL OR k.prefix LIKE ${prefixPattern})
          AND (${lookupDigest}::text IS NULL OR k.lookup_digest = ${lookupDigest})
        ORDER BY k.created_at DESC, k.id DESC
        LIMIT ${paging.limit} OFFSET ${paging.offset}
      `;

      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        label: row.label,
        prefix: row.prefix,
        status: row.status,
        // `bigint` arrives as a string from `postgres`; converted through the same helper
        // the repositories use so an out-of-range value throws instead of silently
        // losing precision.
        quotaLimit: bigintToNumber(row.quota_limit, "api_keys.quota_limit"),
        quotaRemaining: bigintToNumber(row.quota_remaining, "api_keys.quota_remaining"),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }));
    },

    async count(filter: AdminApiKeyFilter): Promise<number> {
      const { prefixPattern, lookupDigest } = where(filter);
      const rows = await sql<{ total: string }[]>`
        SELECT count(*)::text AS total
        FROM api_keys k
        WHERE (${prefixPattern}::text IS NULL OR k.prefix LIKE ${prefixPattern})
          AND (${lookupDigest}::text IS NULL OR k.lookup_digest = ${lookupDigest})
      `;
      return bigintToNumber(rows[0]?.total ?? "0", "count");
    },
  };
}

/**
 * Per-user aggregates.
 *
 * One query for a whole page rather than one per user: the route calls this with the page's
 * ids, so the cost tracks the page and not the table. `lastLoginAt` is the newest session
 * `created_at` — §12 rotates the session on login, so that IS the last login for as long as
 * the row is retained.
 */
function adminUserQuery(sql: Executor) {
  return {
    async aggregatesFor(userIds: readonly string[]): Promise<AdminUserAggregates[]> {
      if (userIds.length === 0) return [];

      const rows = await sql<
        {
          user_id: string;
          active_key_count: string;
          total_weighted_remaining: string;
          last_login_at: Date | null;
        }[]
      >`
        SELECT u.id AS user_id,
               coalesce(k.active_key_count, 0)::text AS active_key_count,
               coalesce(k.total_weighted_remaining, 0)::text AS total_weighted_remaining,
               s.last_login_at
        FROM users u
        LEFT JOIN LATERAL (
          SELECT count(*) AS active_key_count,
                 sum(quota_remaining) AS total_weighted_remaining
          FROM api_keys
          WHERE user_id = u.id AND status = 'active'
        ) k ON true
        LEFT JOIN LATERAL (
          SELECT max(created_at) AS last_login_at FROM sessions WHERE user_id = u.id
        ) s ON true
        WHERE u.id = ANY(${sql.array([...userIds])})
      `;

      return rows.map((row) => ({
        userId: row.user_id,
        activeKeyCount: bigintToNumber(row.active_key_count, "active_key_count"),
        totalWeightedRemaining: bigintToNumber(
          row.total_weighted_remaining,
          "total_weighted_remaining",
        ),
        lastLoginAt: row.last_login_at,
      }));
    },
  };
}

/** Order labels, payment events, and the `q` resolution. */
function adminOrderQuery(sql: Executor) {
  return {
    async paymentEventsFor(orderId: string): Promise<AdminPaymentEventRow[]> {
      /**
       * `payment_events` has no `order_id` column — it is keyed by
       * `(provider, provider_event_key)` because a webhook arrives before the order is
       * known. The join is therefore through the order's `provider_transaction_id`, which
       * is what the provider echoes as its event key.
       */
      const rows = await sql<
        {
          id: string;
          status: string;
          received_at: Date;
          processed_at: Date | null;
          error_code: string | null;
        }[]
      >`
        SELECT e.id, e.status, e.received_at, e.processed_at, e.error_code
        FROM payment_events e
        JOIN orders o
          ON o.provider = e.provider
         AND o.provider_transaction_id = e.provider_event_key
        WHERE o.id = ${orderId}
        ORDER BY e.received_at ASC, e.id ASC
      `;

      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        receivedAt: row.received_at,
        processedAt: row.processed_at,
        errorCode: row.error_code,
      }));
    },

    /**
     * Resolves `q` to order ids.
     *
     * Matches an order id prefix, a provider transaction id prefix, or a username
     * substring — the three things an operator has in front of them when a customer writes
     * in. All three are passed as VALUES.
     */
    async searchIds(term: string, limit: number): Promise<string[]> {
      const pattern = `${term}%`;
      const contains = `%${term}%`;
      const rows = await sql<{ id: string }[]>`
        SELECT o.id
        FROM orders o
        JOIN users u ON u.id = o.user_id
        WHERE o.id LIKE ${pattern}
           OR o.provider_transaction_id LIKE ${pattern}
           OR u.username ILIKE ${contains}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${limit}
      `;
      return rows.map((row) => row.id);
    },

    async labelsFor(
      orderIds: readonly string[],
    ): Promise<{ orderId: string; username: string; packageName: string | null }[]> {
      if (orderIds.length === 0) return [];
      const rows = await sql<{ order_id: string; username: string; package_name: string | null }[]>`
        SELECT o.id AS order_id, u.username, p.name AS package_name
        FROM orders o
        JOIN users u ON u.id = o.user_id
        LEFT JOIN packages p ON p.id = o.package_id
        WHERE o.id = ANY(${sql.array([...orderIds])})
      `;
      return rows.map((row) => ({
        orderId: row.order_id,
        username: row.username,
        packageName: row.package_name,
      }));
    },
  };
}

/**
 * Traffic aggregates for `/overview`.
 *
 * ── WHY PERCENTILES COME FROM `usage_events` AND NOT FROM `deps.metrics` ──
 * `Registry` exposes `read` (a counter) and `readHistogram` (sum and count) — no bucket
 * counts, so a p95 cannot be recovered from it. `usage_events.duration_ms` is a per-request
 * column, so `percentile_cont` over the window gives the real distribution. The cost is
 * that it only covers SETTLED requests; an in-flight one is not in the table yet. For an
 * operator looking at the last hour that is the right answer anyway.
 */
/**
 * A `percentile_cont` result to whole milliseconds.
 *
 * NOT `numericToNumber`: that helper rejects anything `<= 0` because the columns it was
 * written for (`models.multiplier`, `quota_ledger.multiplier`) carry `CHECK (> 0)`, so a
 * zero there means a corrupt row. Here zero is a legitimate reading and null is the normal
 * result of `percentile_cont` over an empty window. Both render as 0, which is the honest
 * answer for "no requests in this window" rather than a fabricated latency.
 */
function percentileMs(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function adminTrafficQuery(sql: Executor) {
  return {
    async window(from: Date, to: Date): Promise<AdminTrafficWindow> {
      const rows = await sql<
        {
          request_count: string;
          error_count: string;
          weighted_tokens: string;
          p50: string | null;
          p95: string | null;
          p99: string | null;
        }[]
      >`
        SELECT count(*)::text AS request_count,
               count(*) FILTER (WHERE status <> 'ok')::text AS error_count,
               coalesce(sum(weighted_tokens), 0)::text AS weighted_tokens,
               percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)::text AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95,
               percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::text AS p99
        FROM usage_events
        WHERE created_at >= ${from} AND created_at < ${to}
      `;
      const row = rows[0];
      return {
        requestCount: bigintToNumber(row?.request_count ?? "0", "request_count"),
        errorCount: bigintToNumber(row?.error_count ?? "0", "error_count"),
        weightedTokens: bigintToNumber(row?.weighted_tokens ?? "0", "weighted_tokens"),
        latencyMs: {
          p50: percentileMs(row?.p50 ?? null),
          p95: percentileMs(row?.p95 ?? null),
          p99: percentileMs(row?.p99 ?? null),
        },
      };
    },

    async series(from: Date, to: Date, bucketSeconds: number): Promise<AdminTrafficBucket[]> {
      const rows = await sql<
        { bucket: Date; requests: string; errors: string; weighted_tokens: string }[]
      >`
        SELECT to_timestamp(
                 floor(extract(epoch FROM created_at) / ${bucketSeconds}) * ${bucketSeconds}
               ) AS bucket,
               count(*)::text AS requests,
               count(*) FILTER (WHERE status <> 'ok')::text AS errors,
               coalesce(sum(weighted_tokens), 0)::text AS weighted_tokens
        FROM usage_events
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY bucket
        ORDER BY bucket ASC
      `;
      return rows.map((row) => ({
        at: row.bucket,
        requests: bigintToNumber(row.requests, "requests"),
        errors: bigintToNumber(row.errors, "errors"),
        weightedTokens: bigintToNumber(row.weighted_tokens, "weighted_tokens"),
      }));
    },

    async revenueIdr(from: Date, to: Date): Promise<number> {
      /**
       * Counted on `paid_at`, not `created_at`: revenue is recognized when the money
       * arrives. `status IN ('paid','activated')` excludes an order that was refunded into
       * `review_required`, so the figure does not overstate.
       */
      const rows = await sql<{ total: string }[]>`
        SELECT coalesce(sum(amount_idr), 0)::text AS total
        FROM orders
        WHERE paid_at IS NOT NULL
          AND paid_at >= ${from} AND paid_at < ${to}
          AND status IN ('paid', 'activated')
      `;
      return bigintToNumber(rows[0]?.total ?? "0", "total");
    },

    async weightedByAccount(
      from: Date,
      to: Date,
    ): Promise<{ accountId: string; weightedTokens: number }[]> {
      const rows = await sql<{ provider_account_id: string; weighted_tokens: string }[]>`
        SELECT provider_account_id, coalesce(sum(weighted_tokens), 0)::text AS weighted_tokens
        FROM usage_events
        WHERE created_at >= ${from} AND created_at < ${to}
          AND provider_account_id IS NOT NULL
        GROUP BY provider_account_id
      `;
      return rows.map((row) => ({
        accountId: row.provider_account_id,
        weightedTokens: bigintToNumber(row.weighted_tokens, "weighted_tokens"),
      }));
    },
  };
}

/**
 * Reconciliation lag for `/health`.
 *
 * There is no `reconciliation_runs` table, so "last run" is inferred from the newest
 * `processed_at` on a payment event — the reconciliation pass is what sets it. That is an
 * inference, not a record, and it reads as "never run" on a system that has processed no
 * payments. Both are noted here rather than papered over: a real run table is the fix, and
 * it belongs in the worker that does the running.
 */
function adminReconciliationQuery(sql: Executor) {
  return {
    async snapshot(now: Date): Promise<AdminReconciliationSnapshot> {
      const rows = await sql<
        { last_run_at: Date | null; pending_orders: string; review_required_orders: string }[]
      >`
        SELECT (SELECT max(processed_at) FROM payment_events) AS last_run_at,
               (SELECT count(*) FROM orders WHERE status = 'pending')::text AS pending_orders,
               (SELECT count(*) FROM orders WHERE status = 'review_required')::text
                 AS review_required_orders
      `;
      const row = rows[0];
      const lastRunAt = row?.last_run_at ?? null;
      return {
        lastRunAt,
        lagSeconds:
          lastRunAt === null
            ? null
            : Math.max(0, Math.floor((now.getTime() - lastRunAt.getTime()) / 1000)),
        pendingOrders: bigintToNumber(row?.pending_orders ?? "0", "pending_orders"),
        reviewRequiredOrders: bigintToNumber(
          row?.review_required_orders ?? "0",
          "review_required_orders",
        ),
      };
    },
  };
}

/** Re-exported so a caller does not need to reach into `dependencies.ts` for it. */
export { PROVIDER_TYPE };
