/**
 * The admin surface's port list (PLAN.md §4 composition, §15 operator console).
 *
 * ── WHY THIS IS A SEPARATE TYPE AND NOT MORE FIELDS ON `GatewayDeps` ──────
 * `dependencies.ts` documents its `Pick<>` lists as "the audit trail": the narrow types
 * are what let an HTTP test supply an object literal instead of PostgreSQL. The admin
 * surface needs ten repositories where the metered surface needs three, and inlining
 * them would put the operator console's needs in the middle of the inference hot path's
 * dependency list. Collecting them behind one optional `admin` field keeps both readable
 * and — the practical point — means `GatewayDeps` grows by exactly one line, so the
 * concurrent customer-surface work merges cleanly.
 *
 * ── WHY `admin` IS OPTIONAL ON `GatewayDeps` ──────────────────────────────
 * Every existing gateway test builds a complete `GatewayDeps` from `test/harness.ts`. A
 * required field would break all of them at the type level for a surface they do not
 * exercise. Optional, with `registerAdminRoutes` skipping registration when it is absent,
 * means the admin routes simply do not exist on an instance not configured for them —
 * which 404s rather than 500s, and is the honest answer for a process that has no admin
 * ports wired.
 *
 * ── WHAT IS DELIBERATELY NARROW ───────────────────────────────────────────
 * `providerAccounts` gets `readCredentials` NOWHERE in this list. It is the only method
 * that returns credential material (`provider-accounts.ts` says so explicitly), no admin
 * response contains a credential, and omitting it from the port means a future handler
 * cannot accidentally reach it — the call would not compile.
 */

import type {
  ActivationOutcome,
  ApiKeysRepository,
  AuditRepository,
  ExecuteActivationInput,
  FlagsRepository,
  ModelsRepository,
  OrdersRepository,
  PackagesRepository,
  ProviderAccountsRepository,
  QuotaRepository,
  SessionsRepository,
  UsageRepository,
  UsersRepository,
} from "@bosanda/database";
import type { Clock } from "@bosanda/shared";
import type { Logger } from "@bosanda/observability";
import type { SecretKeyring } from "@bosanda/config";
import type { Env } from "@bosanda/config";
import type { KillSwitches, ProviderCredentials } from "@bosanda/provider-core";

/**
 * A cross-user API key page.
 *
 * ── WHY THIS PORT EXISTS AT ALL ───────────────────────────────────────────
 * `GET /admin/v1/api-keys` is in the contract and `apiKeysRepository` has NO method that
 * can serve it: every read there is scoped to one user (`listForUser`,
 * `listActiveForUser`) or to one key (`findById`, `findByLookupDigest`), and none accepts
 * a prefix filter or returns a count. `packages/` is frozen, so the query cannot be added
 * where it belongs.
 *
 * Declaring it as a port rather than faking the endpoint keeps the shortfall honest and
 * localized: the route is fully implemented against a named interface, the interface has
 * a real implementation in `dependencies.ts` written against the same `Executor` the
 * repositories use, and when the method lands in `@bosanda/database` this type is deleted
 * and the route does not change.
 */
export type AdminApiKeyRow = {
  readonly id: string;
  readonly userId: string;
  readonly username: string;
  readonly label: string | null;
  readonly prefix: string;
  readonly status: string;
  readonly quotaLimit: number;
  readonly quotaRemaining: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
};

export type AdminApiKeyFilter = {
  /** Case-insensitive prefix match on `api_keys.prefix`. */
  readonly prefix?: string;
  /** Exact match on `api_keys.lookup_digest` — the "I have the key, whose is it" lookup. */
  readonly lookupDigest?: string;
};

export type AdminApiKeyQuery = {
  list(
    filter: AdminApiKeyFilter,
    paging: { limit: number; offset: number },
  ): Promise<AdminApiKeyRow[]>;
  count(filter: AdminApiKeyFilter): Promise<number>;
};

/**
 * Per-user aggregates the `adminUser` contract requires and no repository returns.
 *
 * `usersRepository.list` filters but returns `PublicUser` only; `listWithKeyCounts`
 * aggregates but takes no filter; neither sums remaining quota, and `last_login_at` is
 * not a column on `users` at all. Same reasoning as `AdminApiKeyQuery`: a named port with
 * a real SQL implementation, rather than a route that quietly reports zeroes.
 */
export type AdminUserAggregates = {
  readonly userId: string;
  readonly activeKeyCount: number;
  readonly totalWeightedRemaining: number;
  /**
   * Newest session `created_at` for the user.
   *
   * `users` has no `last_login_at` column and §12 rotates the session on login, so the
   * newest session row IS the last login within the retention window. Null when every
   * session has aged out — accurate, and the contract admits null.
   */
  readonly lastLoginAt: Date | null;
};

export type AdminUserQuery = {
  aggregatesFor(userIds: readonly string[]): Promise<AdminUserAggregates[]>;
};

/**
 * Traffic aggregates for `/overview` and the provider table.
 *
 * `usageRepository` has `totalsByProviderAccount` and `totalsByModel`, but nothing that
 * returns an overall window total, a status breakdown, latency percentiles, or a
 * timeseries. Percentiles cannot come from `deps.metrics` either: `Registry` exposes only
 * `read` and `readHistogram` (sum and count), not bucket counts, so a p95 is not
 * recoverable from it.
 */
export type AdminTrafficWindow = {
  readonly requestCount: number;
  readonly errorCount: number;
  readonly weightedTokens: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly p99: number };
};

export type AdminTrafficBucket = {
  readonly at: Date;
  readonly requests: number;
  readonly errors: number;
  readonly weightedTokens: number;
};

export type AdminTrafficQuery = {
  window(from: Date, to: Date): Promise<AdminTrafficWindow>;
  series(from: Date, to: Date, bucketSeconds: number): Promise<AdminTrafficBucket[]>;
  /** Sum of `orders.amount_idr` for orders that reached a paid state in the window. */
  revenueIdr(from: Date, to: Date): Promise<number>;
  /** Weighted tokens per provider account in the window, for the provider table. */
  weightedByAccount(from: Date, to: Date): Promise<{ accountId: string; weightedTokens: number }[]>;
};

/**
 * Payment events for one order, and the mutable fields of a provider account.
 *
 * Two more shortfalls in the same class as `AdminApiKeyQuery`:
 *
 *   * `orderDetail.paymentEvents` is a required array, but `ordersRepository` can only
 *     read a payment event by `(provider, providerEventKey)` or sweep unprocessed ones
 *     globally — there is no "events for this order" query.
 *   * `updateProviderAccount` changes `label`, `region`, and `persona`. `insert` writes
 *     them once and `rotateCredentials` touches only credential columns; nothing in the
 *     repository updates those three, so there is no writer for the endpoint.
 */
export type AdminPaymentEventRow = {
  readonly id: string;
  readonly status: string;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly errorCode: string | null;
};

export type AdminOrderQuery = {
  paymentEventsFor(orderId: string): Promise<AdminPaymentEventRow[]>;
  /**
   * Resolves the `q` free-text filter to order ids.
   *
   * `OrderFilter` has no search field, and filtering a page in the route would make
   * `total` disagree with the rows. Resolving the search to ids first keeps one source
   * of truth for both.
   */
  searchIds(term: string, limit: number): Promise<string[]>;
  /** Usernames and package names for a page of orders — `orderSummary` requires both. */
  labelsFor(
    orderIds: readonly string[],
  ): Promise<{ orderId: string; username: string; packageName: string | null }[]>;
};

export type AdminProviderAccountWrite = {
  update(input: {
    accountId: string;
    label: string;
    region: string | null;
    persona: string | null;
    at: Date;
  }): Promise<boolean>;
};

/** Reconciliation lag for `/health`. */
export type AdminReconciliationSnapshot = {
  readonly lastRunAt: Date | null;
  readonly lagSeconds: number | null;
  readonly pendingOrders: number;
  readonly reviewRequiredOrders: number;
};

export type AdminReconciliationQuery = {
  snapshot(now: Date): Promise<AdminReconciliationSnapshot>;
};

/**
 * The repositories an admin transaction hands out.
 *
 * A mutation that writes a row and its audit entry must commit both or neither (§16),
 * so the pair is only reachable through `transact` — the same discipline `SettlementTx`
 * uses for the ledger/usage pair, for the same reason.
 */
export type AdminTx = {
  /**
   * Runs the frozen `executeActivation` inside THIS transaction.
   *
   * ── WHY A PORT AND NOT THE RAW `Executor` ─────────────────────────────────
   * `executeActivation` takes an `Executor` and issues its own SQL. Handing the raw
   * executor to a route would make manual activation the one admin path that cannot be
   * exercised without PostgreSQL, while every other port here is satisfiable by an object
   * literal — and it would also hand every future handler a channel for arbitrary SQL that
   * bypasses the narrow `Pick<>` lists above, which is exactly what this file exists to
   * prevent.
   *
   * The signature is the frozen function's, minus its first parameter: `admin-dependencies.ts`
   * binds it to the live transaction, so production runs the real activation path (§13
   * forbids a hand-rolled balance mutation) and a test supplies the same contract.
   */
  readonly activate: (input: ExecuteActivationInput) => Promise<ActivationOutcome>;
  readonly audit: Pick<AuditRepository, "append">;
  readonly users: Pick<UsersRepository, "setPasswordHash" | "setStatus" | "findById">;
  readonly sessions: Pick<SessionsRepository, "revokeAllForUser" | "insert">;
  readonly apiKeys: Pick<ApiKeysRepository, "findById" | "revoke">;
  readonly quota: Pick<QuotaRepository, "recordAdjustment" | "lockKeyForUpdate">;
  readonly orders: Pick<
    OrdersRepository,
    "lockById" | "findById" | "markReviewRequired" | "markCancelled"
  >;
  readonly packages: Pick<
    PackagesRepository,
    "findById" | "upsert" | "setActive" | "readStock" | "lockStock" | "setStock"
  >;
  readonly models: Pick<
    ModelsRepository,
    "findByPublicId" | "setMultiplier" | "setPublished" | "upsert"
  >;
  readonly flags: Pick<FlagsRepository, "upsert" | "findByKey">;
  readonly providerAccounts: Pick<
    ProviderAccountsRepository,
    "insert" | "findById" | "rotateCredentials" | "setStatus" | "markValidated"
  > &
    AdminProviderAccountWrite;
};

/**
 * Everything the admin routes read or write.
 *
 * Read-only surfaces are listed directly; anything that mutates goes through `transact`.
 * That split is not cosmetic — it means a handler physically cannot write a row without
 * being inside the transaction that also writes its audit entry.
 */
export type AdminDeps = {
  readonly env: Env;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly keyring: SecretKeyring;

  /** Read per request so a flag flip shows in `/overview` without a deploy (§3). */
  readonly killSwitches: () => Promise<KillSwitches>;

  readonly sessions: Pick<
    SessionsRepository,
    "findWithUser" | "touchLastUsed" | "revokeByTokenHash" | "insert"
  >;
  readonly users: Pick<
    UsersRepository,
    "findByUsername" | "findById" | "findPublicById" | "list" | "count"
  >;
  readonly apiKeys: Pick<ApiKeysRepository, "findById" | "listForUser">;
  readonly quota: Pick<QuotaRepository, "ledgerForKey" | "trueBalance">;
  readonly orders: Pick<OrdersRepository, "list" | "count" | "findById">;
  readonly packages: Pick<PackagesRepository, "listAll" | "findById" | "readStock">;
  readonly models: Pick<ModelsRepository, "listAll" | "findByPublicId">;
  readonly providerAccounts: Pick<
    ProviderAccountsRepository,
    "listByType" | "findById" | "errorCountsSince" | "recentHealthEvents"
  >;
  readonly flags: Pick<FlagsRepository, "readAll">;
  readonly usage: Pick<UsageRepository, "totalsByProviderAccount">;
  /** Read-only: `AuditRepository` exposes no update or delete, by construction (§15). */
  readonly audit: Pick<AuditRepository, "list" | "count">;

  /** The ports the frozen repositories cannot serve. See each type. */
  readonly apiKeyQuery: AdminApiKeyQuery;
  readonly userQuery: AdminUserQuery;
  readonly orderQuery: AdminOrderQuery;
  readonly traffic: AdminTrafficQuery;
  readonly reconciliation: AdminReconciliationQuery;

  /** Live provider state — in-memory, not persisted. See `providerAccounts.ts`. */
  readonly liveAccounts: () => { accountId: string; activeRequests: number; errorScore: number }[];

  /**
   * Streams THIS process is currently serving.
   *
   * Process-local by nature: no other replica's in-flight streams are visible from here,
   * and `/overview` says so rather than presenting it as a fleet figure.
   */
  readonly activeStreams: () => number;

  /** One real query, for the health report. Rejects when the database is unreachable. */
  readonly checkDatabase: () => Promise<void>;

  /**
   * Probes one account's stored credential against the live provider (§3 G0.1).
   *
   * Injected rather than reached for directly because the probe needs the credential
   * manager and the adapter, and an admin route that could hold a decrypted credential
   * is a route that could log one. This returns nothing: the credential stays inside
   * provider-core, and the route learns only whether it worked.
   *
   * Rejects with a `BosandaError` when the provider refuses the credential.
   */
  validateAccount(accountId: string): Promise<void>;

  /**
   * Codex App Server admin ports. Credentials stay in the runtime state dir;
   * these methods never return token material.
   */
  readonly codex: {
    isRuntimeEnabled(): boolean;
    accountRead(accountId: string): Promise<{
      authenticated: boolean;
      email?: string;
      planType?: string;
    }>;
    loginStart(accountId: string): Promise<{
      state: string;
      authUrl?: string;
    }>;
    loginStatus(accountId: string): Promise<{
      state: string;
      authUrl?: string;
      message?: string;
    }>;
    loginCancel(accountId: string): Promise<{ state: string }>;
    logout(accountId: string): Promise<void>;
    listModels(accountId: string): Promise<readonly Record<string, unknown>[]>;
  };

  /** Runs `fn` in one transaction. The only write path. */
  transact<T>(fn: (tx: AdminTx) => Promise<T>): Promise<T>;

  /**
   * Seals a provider credential. Injected so no route touches the keyring directly.
   *
   * Takes the ALREADY-PARSED credential rather than the operator's raw string, for two
   * reasons. `sealCredentials` requires a `ProviderCredentials` anyway, so a string
   * parameter would only move the parse in here and parse the same blob twice. More
   * importantly the parsed value is where the account's `region` and `persona` have
   * already overridden whatever the blob claimed — sealing the raw string would store the
   * blob's version of those fields and give the scheduler a second source of truth.
   */
  sealCredential(credentials: ProviderCredentials): {
    envelope: string;
    keyVersion: number;
    profileArn: string | null;
  };
};
