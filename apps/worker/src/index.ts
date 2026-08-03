/**
 * `@bosanda/worker` public surface.
 *
 * `main.ts` is deliberately NOT exported: importing it executes `main()`, which loads env and
 * opens a pool. The job table lives here instead via a re-export of the pure pieces, so a test
 * can build and inspect the schedule without starting a process.
 */

export { registerWorkerMetrics, PASS_BUCKETS_MS } from "./metrics.js";

export {
  abortableSleep,
  startRunner,
  type Job,
  type JobResult,
  type Runner,
  type RunnerOptions,
} from "./loop.js";

export {
  createPakasirTransport,
  createWorkerDependencies,
  type CreateWorkerDependenciesOptions,
} from "./dependencies.js";

export type { WorkerDeps, WorkerRepositories, WorkerTx, WorkerExecutor } from "./deps.js";

export {
  reconcileJob,
  RECONCILE_BATCH,
  RECONCILE_MIN_AGE_MS,
  type ReconcileDeps,
} from "./jobs/reconcile.js";

export { expireKeysJob, EXPIRE_BATCH, type ExpireKeysDeps } from "./jobs/expire-keys.js";

export {
  reservationCleanupJob,
  RESERVATION_BATCH,
  type ReservationDeps,
} from "./jobs/reservations.js";

export {
  clearCooldownsJob,
  retentionJob,
  COOLDOWN_BATCH,
  HEALTH_EVENT_BATCH,
  HEALTH_EVENT_RETENTION_MS,
  SESSION_BATCH,
  type CooldownDeps,
  type RetentionDeps,
} from "./jobs/maintenance.js";
