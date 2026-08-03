/**
 * The customer surface's port list and production composition (PLAN.md §4, §11–§13).
 *
 * Customer handlers receive narrow ports, never a pool or arbitrary secret operations. This
 * keeps ownership, audit, and transaction boundaries visible at the route composition edge.
 */

import { keyringFromEnv, type Env, type SecretKeyring } from "@bosanda/config";
import {
  apiKeysRepository,
  auditRepository,
  bigintToNumber,
  flagsRepository,
  modelsRepository,
  ordersRepository,
  packagesRepository,
  quotaRepository,
  sessionsRepository,
  usageRepository,
  usersRepository,
  withTransaction,
  type ApiKeysRepository,
  type AuditRepository,
  type Executor,
  type FlagsRepository,
  type ModelsRepository,
  type OrdersRepository,
  type PackagesRepository,
  type QuotaRepository,
  type SessionsRepository,
  type Sql,
  type UsageRepository,
  type UsersRepository,
  type Order,
} from "@bosanda/database";
import { createLogger, type Logger } from "@bosanda/observability";
import {
  createPakasirCheckout,
  type PakasirConfig,
  type PakasirTransport,
} from "@bosanda/payments";
import { killSwitchesFromEnv } from "@bosanda/provider-core";
import { killSwitchesFrom } from "@bosanda/database";
import { systemClock, type Clock } from "@bosanda/shared";

export type CustomerUsageBucket = { readonly at: Date; readonly weightedTokens: number };

export type CustomerUsageQuery = {
  seriesForUser(
    userId: string,
    from: Date,
    to: Date,
    bucketSeconds: number,
  ): Promise<CustomerUsageBucket[]>;
};

/** Activation's generated key id is recorded on the grant ledger, not the order row. */
export type CustomerOrderQuery = {
  activatedKeyIds(orderIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
};

export type CustomerTx = {
  readonly audit: Pick<AuditRepository, "append">;
  readonly sessions: Pick<SessionsRepository, "insert" | "revokeByTokenHash">;
  readonly users: Pick<UsersRepository, "insert" | "findByUsername">;
  readonly apiKeys: Pick<ApiKeysRepository, "findById" | "revoke">;
  readonly orders: Pick<
    OrdersRepository,
    "create" | "lockById" | "findById" | "markCancelled" | "attachProviderTransaction"
  >;
  readonly packages: Pick<
    PackagesRepository,
    "findById" | "readStock" | "lockStock" | "reserveStock" | "releaseStock"
  >;
};

export type CustomerDeps = {
  readonly env: Env;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly keyring: SecretKeyring;
  readonly killSwitches: () => Promise<ReturnType<typeof killSwitchesFrom>>;
  readonly sessions: Pick<
    SessionsRepository,
    "findWithUser" | "touchLastUsed" | "revokeByTokenHash"
  >;
  readonly users: Pick<UsersRepository, "findByUsername" | "findPublicById">;
  readonly apiKeys: Pick<ApiKeysRepository, "findById" | "listForUser" | "listActiveForUser">;
  readonly quota: Pick<QuotaRepository, "trueBalance">;
  readonly orders: Pick<OrdersRepository, "findById" | "listForUser">;
  readonly packages: Pick<PackagesRepository, "listActiveWithStock" | "findById" | "readStock">;
  readonly models: Pick<ModelsRepository, "listPublished">;
  readonly flags: Pick<FlagsRepository, "readAll">;
  readonly usage: Pick<UsageRepository, "totalsForUser">;
  readonly usageQuery: CustomerUsageQuery;
  readonly orderQuery: CustomerOrderQuery;
  readonly decoyHash: string;
  readonly transact: <T>(fn: (tx: CustomerTx) => Promise<T>) => Promise<T>;
  readonly checkout: (order: Order) => Promise<{
    paymentUrl: string;
    providerTransactionId: string | null;
  }>;
};

export type CreateCustomerDependenciesOptions = {
  env: Env;
  sql: Sql;
  decoyHash: string;
  clock?: Clock;
  logger?: Logger;
  keyring?: SecretKeyring;
  transport?: PakasirTransport;
};

export function createCustomerDependencies(
  options: CreateCustomerDependenciesOptions,
): CustomerDeps {
  const clock = options.clock ?? systemClock;
  const logger =
    options.logger ?? createLogger({ service: "gateway", level: options.env.LOG_LEVEL });
  const keyring = options.keyring ?? keyringFromEnv(options.env);
  const transport = options.transport ?? defaultPakasirTransport;
  const pakasir: PakasirConfig = {
    baseUrl: options.env.PAKASIR_BASE_URL,
    project: options.env.PAKASIR_PROJECT,
    apiKey: options.env.PAKASIR_API_KEY ?? null,
  };
  const baseline = killSwitchesFromEnv(options.env);

  return {
    env: options.env,
    clock,
    logger,
    keyring,
    decoyHash: options.decoyHash,
    killSwitches: async () => {
      const flags = await flagsRepository(options.sql).readAll();
      return killSwitchesFrom(baseline, flags, []);
    },
    sessions: sessionsRepository(options.sql),
    users: usersRepository(options.sql),
    apiKeys: apiKeysRepository(options.sql),
    quota: quotaRepository(options.sql),
    orders: ordersRepository(options.sql),
    packages: packagesRepository(options.sql),
    models: modelsRepository(options.sql),
    flags: flagsRepository(options.sql),
    usage: usageRepository(options.sql),
    usageQuery: customerUsageQuery(options.sql),
    orderQuery: customerOrderQuery(options.sql),
    transact: (fn) =>
      withTransaction(options.sql, (tx) =>
        fn({
          audit: auditRepository(tx),
          sessions: sessionsRepository(tx),
          users: usersRepository(tx),
          apiKeys: apiKeysRepository(tx),
          orders: ordersRepository(tx),
          packages: packagesRepository(tx),
        }),
      ),
    checkout: async (order) => {
      const result = await createPakasirCheckout(
        {
          orderId: order.id,
          userId: order.userId,
          type: order.type,
          targetApiKeyId: order.targetApiKeyId,
          packageSnapshot: order.packageSnapshot,
          amountIdr: order.amountIdr,
          currency: "IDR",
          status: order.status,
          stockReservationExpiresAt: order.stockReservationExpiresAt,
          provider: "pakasir",
          providerTransactionId: order.providerTransactionId,
          paidAt: order.paidAt,
          activatedAt: order.activatedAt,
          createdAt: order.createdAt,
        },
        pakasir,
        { transport, clock },
        `${options.env.PUBLIC_WEB_URL}/checkout/return`,
      );
      return { paymentUrl: result.paymentUrl, providerTransactionId: result.providerTransactionId };
    },
  };
}

function customerOrderQuery(sql: Executor): CustomerOrderQuery {
  return {
    async activatedKeyIds(orderIds) {
      if (orderIds.length === 0) return new Map();
      const rows = await sql<{ order_id: string; api_key_id: string }[]>`
        SELECT order_id, api_key_id
        FROM quota_ledger
        WHERE kind IN ('grant', 'top_up')
          AND order_id = ANY(${sql.array([...orderIds])})
      `;
      return new Map(rows.map((row) => [row.order_id, row.api_key_id]));
    },
  };
}

function customerUsageQuery(sql: Executor): CustomerUsageQuery {
  return {
    async seriesForUser(userId, from, to, bucketSeconds) {
      const rows = await sql<{ bucket: Date; weighted_tokens: string | null }[]>`
        SELECT to_timestamp(floor(extract(epoch FROM e.created_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
               coalesce(sum(e.weighted_tokens), 0)::text AS weighted_tokens
        FROM usage_events e
        JOIN api_keys k ON k.id = e.api_key_id
        WHERE k.user_id = ${userId} AND e.created_at >= ${from} AND e.created_at < ${to}
        GROUP BY bucket ORDER BY bucket ASC
      `;
      return rows.map((row) => ({
        at: row.bucket,
        weightedTokens: bigintToNumber(row.weighted_tokens ?? "0", "customer usage"),
      }));
    },
  };
}

const defaultPakasirTransport: PakasirTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
  return { status: response.status, text: () => response.text() };
};

export type { Order };
