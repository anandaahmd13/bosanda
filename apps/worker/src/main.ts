/**
 * Worker entrypoint. This is the path `deploy/systemd/bosanda-worker.service` invokes:
 *
 *   ExecStart=/usr/bin/env node --enable-source-maps \
 *     ./node_modules/.bin/tsx apps/worker/src/main.ts
 *
 * Nothing here is reachable by a unit test, and that is the point — signal handling,
 * process-level failure, and the job schedule live here; every decision they drive lives in
 * `jobs/` where the suite can reach it without a database.
 *
 * ── THE DRAIN (bosanda-worker.service: TimeoutStopSec=90) ──────────────────
 * SIGTERM aborts the runner, which interrupts any sleeping loop immediately and lets an
 * in-flight pass finish. A pass is bounded by its batch limit, so "finish" is a bounded wait
 * rather than an open one — that is what keeps the drain inside 90 seconds without having to
 * kill a transaction mid-commit. Cutting a pass off in the middle would risk exactly the
 * split write the transactions exist to prevent.
 *
 * ── WHY THE INTERVALS DIFFER ───────────────────────────────────────────────
 * They are set by how much a delay COSTS, not by symmetry:
 *
 *  - Reconciliation (60s): a customer who paid and is waiting for a key is the most
 *    expensive delay in the system, and `ACTIVATION_GRACE_MS` is 15 minutes, so the pass has
 *    to run many times inside that window to be worth having.
 *  - Reservations (60s): a held unit is a unit nobody can buy. Same urgency, cheap query.
 *  - Key expiry (60s): §11 sells 24h validity. A key that outlives its window by minutes is
 *    quota given away; a minute is tight enough to be honest without hammering the table.
 *  - Cooldowns (5min): serving already ignores elapsed cooldowns in memory, so this only
 *    corrects the persisted view for the admin console. Nothing breaks while it is stale.
 *  - Retention (1h): §17 housekeeping. Nothing depends on it being timely, and it is the one
 *    job that can touch a large number of rows.
 */

import { loadEnv } from "@bosanda/config";
import { createLogger } from "@bosanda/observability";
import { createWorkerDependencies } from "./dependencies.js";
import { startRunner, type Job } from "./loop.js";
import { reconcileJob } from "./jobs/reconcile.js";
import { expireKeysJob } from "./jobs/expire-keys.js";
import { reservationCleanupJob } from "./jobs/reservations.js";
import { clearCooldownsJob, retentionJob } from "./jobs/maintenance.js";
import type { WorkerDeps } from "./deps.js";

export const RECONCILE_INTERVAL_MS = 60_000;
export const RESERVATION_INTERVAL_MS = 60_000;
export const EXPIRE_KEYS_INTERVAL_MS = 60_000;
export const COOLDOWN_INTERVAL_MS = 300_000;
export const RETENTION_INTERVAL_MS = 3_600_000;

/**
 * The job table.
 *
 * Exported and built from `deps` so a test can assert the schedule without starting a
 * process — the names and intervals ARE the contract with §13 and §17, and a silent change
 * to one is exactly the kind of regression that only shows up as a support ticket.
 */
export function workerJobs(deps: WorkerDeps): Job[] {
  return [
    { name: "reconcile", intervalMs: RECONCILE_INTERVAL_MS, run: reconcileJob(deps) },
    { name: "reservations", intervalMs: RESERVATION_INTERVAL_MS, run: reservationCleanupJob(deps) },
    { name: "expire-keys", intervalMs: EXPIRE_KEYS_INTERVAL_MS, run: expireKeysJob(deps) },
    { name: "cooldowns", intervalMs: COOLDOWN_INTERVAL_MS, run: clearCooldownsJob(deps) },
    { name: "retention", intervalMs: RETENTION_INTERVAL_MS, run: retentionJob(deps) },
  ];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: "worker", level: env.LOG_LEVEL });
  const deps = createWorkerDependencies({ env, logger });

  /**
   * Fail fast on an unreachable database rather than starting five loops that will each log
   * a connection error every interval. `Restart=always` with `RestartSec=10s` turns this into
   * a clean retry, and the journal shows one clear reason instead of a repeating storm.
   */
  await deps.checkDatabase();

  const runner = startRunner({ jobs: workerJobs(deps), logger, metrics: deps.metrics });
  logger.info({ jobs: workerJobs(deps).map((job) => job.name) }, "worker started");

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    /**
     * A second signal is ignored rather than escalating. An operator running `systemctl
     * restart` twice must not abort a pass that is mid-transaction; systemd's
     * `TimeoutStopSec=90` is the escalation path and it ends in SIGKILL.
     */
    if (shuttingDown) {
      logger.warn({ signal }, "shutdown already in progress; ignoring signal");
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, "draining: stopping job loops");
    runner.stop();

    try {
      await runner.finished;
      logger.info("draining: all job loops stopped");
    } catch (error) {
      /**
       * Logged and then deliberately not fatal: the pool still has to close. `startRunner`
       * catches per-pass failures itself, so reaching here means something outside a pass
       * failed, and leaking a pool on top of it would help nobody.
       */
      logger.error({ err: error }, "error while stopping job loops; continuing to close pool");
    }

    try {
      await deps.close();
      logger.info("shutdown complete");
    } catch (error) {
      logger.error({ err: error }, "error while closing dependencies");
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  /**
   * A rejection that reached the top is a bug: process state is unknown, and a worker that
   * keeps running in that state can write wrong ledger rows. Exit and let systemd restart a
   * clean process. Per-pass failures never arrive here — `startRunner` catches them.
   */
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection; exiting");
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "uncaught exception; exiting");
    process.exit(1);
  });

  // Hold the process open. The runner's loops are what keep the event loop alive; awaiting
  // them here means `main` resolves only after a drain completes.
  await runner.finished;
}

/**
 * `console.error` rather than the logger: the likeliest startup failures are a missing env
 * file and an invalid `ConfigError`, both of which happen before a logger exists. A silent
 * exit here would look identical to a successful start in the journal.
 */
main().catch((error: unknown) => {
  console.error("worker failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
