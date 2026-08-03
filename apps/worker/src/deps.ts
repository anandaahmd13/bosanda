/**
 * The worker's dependency graph (PLAN.md §13 reconciliation, §11 expiry, §17 retention).
 *
 * SAME DISCIPLINE AS THE GATEWAY, SAME REASON. Every collaborator is listed as the
 * narrowest `Pick<...>` that satisfies the job that uses it, so a job test supplies an
 * object literal instead of PostgreSQL and `pnpm test` stays runnable on a machine with
 * no database. The `Pick` list is also the audit trail: a job that starts needing a new
 * table method shows up as a diff here, next to the comment explaining why it needs it.
 *
 * WHAT IS DELIBERATELY ABSENT. `providerAccounts` gets `clearElapsedCooldowns` and
 * `deleteHealthEventsOlderThan` and NOTHING ELSE. In particular it does not get
 * `readCredentials`: no worker job has any business decrypting a provider credential, and
 * leaving the method off the port means no job can do it even by mistake. This mirrors the
 * admin port in `apps/gateway/src/routes/admin/deps.ts`, and for the same reason — a
 * capability that is structurally absent cannot be misused by a later edit.
 *
 * WHY THE PAKASIR LOOKUP IS A FUNCTION AND NOT A CONFIG BLOB. `checkTransaction` hands
 * back a `PakasirTransaction | null`, so the reconciliation loop is a pure dispatch over
 * `decideReconcileAction` with no network knowledge in it. `null` means "no provider view
 * available", which §13 treats as "wait or escalate" rather than as a failure — the loop
 * cannot tell a 404 from a timeout, and must not, because both mean the same thing to the
 * decision.
 */

import type { Env } from "@bosanda/config";
import type {
  ApiKeysRepository,
  AuditRepository,
  OrdersRepository,
  PackagesRepository,
  ProviderAccountsRepository,
  QuotaRepository,
  SessionsRepository,
  Sql,
  Tx,
} from "@bosanda/database";
import type { Logger, Registry } from "@bosanda/observability";
import type { OrderSnapshot, PakasirTransaction } from "@bosanda/payments";
import type { Clock } from "@bosanda/shared";

/**
 * Repositories bound to ONE transaction, for the jobs that must move two tables together.
 *
 * §16 invariant 4 requires a balance change and its ledger row to commit together, and
 * §11 requires a released reservation and the order's terminal status to commit together.
 * Handing these out as a bundle from `transact` rather than exposing them on `WorkerDeps`
 * means a job cannot write half of either pair — there is no way to reach one without the
 * other.
 */
export type WorkerTx = {
  orders: Pick<
    OrdersRepository,
    "lockById" | "markExpired" | "markCancelled" | "markReviewRequired" | "markActivated"
  >;
  packages: Pick<PackagesRepository, "lockStock" | "releaseStock">;
  apiKeys: Pick<ApiKeysRepository, "sweepExpired" | "findById">;
  quota: Pick<QuotaRepository, "recordExpiry">;
  audit: Pick<AuditRepository, "append">;
};

export type WorkerRepositories = {
  /**
   * `listReconcilable` and `listStaleReservations` both use `FOR UPDATE SKIP LOCKED`, so
   * two worker replicas split a batch instead of blocking on each other. That is what
   * makes running more than one replica safe without a distributed lock.
   */
  orders: Pick<OrdersRepository, "listReconcilable" | "listStaleReservations">;
  apiKeys: Pick<ApiKeysRepository, "listExpiring">;
  providerAccounts: Pick<
    ProviderAccountsRepository,
    "clearElapsedCooldowns" | "deleteHealthEventsOlderThan"
  >;
  sessions: Pick<SessionsRepository, "deleteExpired">;
};

export type WorkerDeps = WorkerRepositories & {
  env: Env;
  clock: Clock;
  logger: Logger;
  metrics: Registry;

  /**
   * The provider's view of one order, or null when there is none to be had.
   *
   * Returning null rather than throwing is deliberate: §13 says a paid order with no
   * provider view waits inside the grace window and escalates outside it, and that is the
   * same correct behaviour whether the lookup 404'd, timed out, or the provider is down.
   * Collapsing all three to null keeps that policy in `decideReconcileAction` instead of
   * spreading it across error handling.
   */
  checkTransaction: (order: OrderSnapshot) => Promise<PakasirTransaction | null>;

  /** Runs `fn` inside one database transaction (§16 invariant 4). */
  transact: <T>(fn: (tx: WorkerTx) => Promise<T>) => Promise<T>;

  /** Liveness probe. Resolves when the database is reachable. */
  checkDatabase: () => Promise<void>;

  /** Released on drain. Idempotent. */
  close: () => Promise<void>;
};

/** Narrow the executor to the bundle a transaction hands a job. */
export type WorkerExecutor = Sql | Tx;
