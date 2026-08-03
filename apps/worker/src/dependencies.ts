/**
 * Wires the worker's production dependency graph (PLAN.md §13, §18).
 *
 * SAME SHAPE AS THE GATEWAY'S `createDependencies`, deliberately: one function that turns
 * validated env into a plain object of ports, so `main.ts` holds only process concerns and
 * every job is reachable in a test with an object literal.
 *
 * WHY THE PAKASIR LOOKUP IS COLLAPSED TO `PakasirTransaction | null` HERE. §13's policy for
 * "no provider view available" is identical whether the lookup 404'd, timed out, or the
 * provider is down: a paid order escalates once past the grace window, anything else waits
 * for the next pass. Deciding that once, at the edge, keeps the reconciliation loop a pure
 * dispatch over `decideReconcileAction` with no error handling threaded through it.
 *
 * `PAKASIR_API_KEY` is optional in the schema and is passed straight through as `null` when
 * absent. It is never logged and never placed in an error — `@bosanda/payments` documents
 * the same contract on `PakasirConfig.apiKey`, and `redactPakasirUrl` exists for the URLs.
 */

import type { Env } from "@bosanda/config";
import {
  apiKeysRepository,
  auditRepository,
  checkConnection,
  closeClient,
  createClientFromEnv,
  ordersRepository,
  packagesRepository,
  providerAccountsRepository,
  quotaRepository,
  sessionsRepository,
  withTransaction,
  type Sql,
} from "@bosanda/database";
import { createLogger, createRegistry, type Logger, type Registry } from "@bosanda/observability";
import {
  fetchPakasirTransaction,
  type OrderSnapshot,
  type PakasirConfig,
  type PakasirTransaction,
  type PakasirTransport,
} from "@bosanda/payments";
import { systemClock, type Clock } from "@bosanda/shared";
import { registerWorkerMetrics } from "./metrics.js";
import type { WorkerDeps } from "./deps.js";

export type CreateWorkerDependenciesOptions = {
  env: Env;
  /** Injected in tests; production uses the system clock. */
  clock?: Clock;
  logger?: Logger;
  metrics?: Registry;
  /** Supplied by tests that want to skip the real pool. */
  sql?: Sql;
  /** Supplied by tests so no network is touched. */
  transport?: PakasirTransport;
};

/**
 * Adapts `globalThis.fetch` to the `PakasirTransport` port.
 *
 * Separate from the gateway's `createUpstreamTransport` because the two ports differ: this
 * one returns `text()` for a JSON body, the gateway's returns a byte stream for SSE. Sharing
 * one function would mean a union return type that both callers then narrow.
 */
export function createPakasirTransport(fetchImpl: typeof fetch = fetch): PakasirTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
    return {
      status: response.status,
      text: () => response.text(),
    };
  };
}

export function createWorkerDependencies(options: CreateWorkerDependenciesOptions): WorkerDeps {
  const { env } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger({ service: "worker", level: env.LOG_LEVEL });
  const metrics = options.metrics ?? createRegistry();
  const sql = options.sql ?? createClientFromEnv(env);
  const transport = options.transport ?? createPakasirTransport();

  registerWorkerMetrics(metrics);

  const pakasir: PakasirConfig = {
    baseUrl: env.PAKASIR_BASE_URL,
    project: env.PAKASIR_PROJECT,
    apiKey: env.PAKASIR_API_KEY ?? null,
  };

  const checkTransaction = async (order: OrderSnapshot): Promise<PakasirTransaction | null> => {
    try {
      return await fetchPakasirTransaction(order, pakasir, { transport, clock });
    } catch (error) {
      /**
       * Collapsed to null, and counted. The order id is safe to log; the error is logged as
       * `err` so a stack reaches the journal, and nothing from `pakasir` (project slug or
       * api key) is included.
       */
      metrics.increment("bosanda_payment_events_total", { outcome: "lookup_failed" });
      logger.warn({ orderId: order.orderId, err: error }, "pakasir status lookup failed");
      return null;
    }
  };

  return {
    env,
    clock,
    logger,
    metrics,
    checkTransaction,

    orders: ordersRepository(sql),
    apiKeys: apiKeysRepository(sql),
    providerAccounts: providerAccountsRepository(sql),
    sessions: sessionsRepository(sql),

    /**
     * Every repository in the bundle is built from the SAME `tx`, which is what makes the
     * §16 invariant-4 pairs (balance + ledger row, terminal status + stock release) commit
     * atomically. Building any one of them from `sql` instead would silently escape the
     * transaction.
     */
    transact: (fn) =>
      withTransaction(sql, (tx) =>
        fn({
          orders: ordersRepository(tx),
          packages: packagesRepository(tx),
          apiKeys: apiKeysRepository(tx),
          quota: quotaRepository(tx),
          audit: auditRepository(tx),
        }),
      ),

    checkDatabase: () => checkConnection(sql),
    close: () => closeClient(sql),
  };
}
