/**
 * The job runner (PLAN.md §13, §17).
 *
 * WHY A HAND-WRITTEN LOOP AND NOT A CRON LIBRARY. Three requirements, none of which a
 * cron expression gives you:
 *
 *  1. A job must never overlap itself. A reconciliation pass that takes longer than its
 *     interval must not have a second copy start behind it — two passes over the same
 *     order would both try to activate it. `setInterval` fires regardless of whether the
 *     previous tick finished; this loop schedules the NEXT run only after the current one
 *     settles.
 *  2. A crashing job must not kill the process. A worker that exits on one bad order stops
 *     doing the other four jobs too, so every tick is wrapped and a failure is logged,
 *     counted, and retried on the next interval.
 *  3. Shutdown must be able to interrupt the sleep. With `setInterval`, SIGTERM waits out
 *     the remainder of the interval before the process can exit; systemd's
 *     `TimeoutStopSec=90` would then be the thing that ends a 5-minute retention sleep.
 *
 * THE SLEEP IS ABORTABLE AND THE TIMER IS UNREF'D. `unref()` means a pending sleep does
 * not by itself hold the event loop open, so a worker whose jobs are all idle still exits
 * promptly when told to.
 */

import type { Logger, Registry } from "@bosanda/observability";

/**
 * What one pass reported. Returned rather than logged by the job so the runner owns all
 * logging and metrics in one place, and so a test can assert on the numbers directly.
 *
 * `processed` is how many items the pass handled; `failed` is how many it could not.
 * A pass that handled nothing is normal and is logged at debug, not info — an idle worker
 * must not fill the journal.
 */
export type JobResult = {
  readonly processed: number;
  readonly failed: number;
  /** Set when the pass hit its batch limit, so the runner knows to come back immediately. */
  readonly saturated?: boolean;
};

export type Job = {
  readonly name: string;
  readonly intervalMs: number;
  run: () => Promise<JobResult>;
};

export type RunnerOptions = {
  readonly jobs: readonly Job[];
  readonly logger: Logger;
  readonly metrics: Registry;
  /** Injected in tests so a pass can be driven without real time. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/**
 * A sleep that resolves early when the signal aborts.
 *
 * Resolves rather than rejects on abort: the caller's next act is to re-check its
 * stop condition, so an exception here would be a control-flow detour with no
 * different outcome.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    // Do not hold the event loop open on account of an idle interval.
    timer.unref?.();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }

    signal.addEventListener("abort", finish, { once: true });
  });
}

export type Runner = {
  /** Resolves when every job loop has stopped. */
  readonly finished: Promise<void>;
  /** Idempotent. Interrupts any in-flight sleep; an in-flight pass runs to completion. */
  stop: () => void;
};

/**
 * Starts every job on its own independent loop.
 *
 * INDEPENDENT, NOT SEQUENCED. A slow reconciliation pass must not delay the key-expiry
 * sweep — they touch different tables and have different urgency. Running them on one
 * shared tick would couple their latencies, so each gets its own loop and its own
 * interval, and `Promise.all` over the loops is what "the worker has stopped" means.
 */
export function startRunner(options: RunnerOptions): Runner {
  const { jobs, logger, metrics } = options;
  const sleep = options.sleep ?? abortableSleep;
  const controller = new AbortController();

  const loops = jobs.map(async (job) => {
    while (!controller.signal.aborted) {
      const startedAt = Date.now();
      try {
        const result = await job.run();
        const durationMs = Date.now() - startedAt;

        metrics.increment("bosanda_worker_passes_total", { job: job.name, outcome: "ok" });
        metrics.observe("bosanda_worker_pass_ms", durationMs, { job: job.name });
        if (result.failed > 0) {
          metrics.increment("bosanda_worker_items_failed_total", { job: job.name }, result.failed);
        }

        /**
         * An idle pass logs at debug so a healthy worker is quiet. A pass that did
         * something logs at info, because that is the record an operator reconstructs a
         * night's activity from.
         */
        const line = { job: job.name, ...result, durationMs };
        if (result.processed === 0 && result.failed === 0) {
          logger.debug(line, "worker pass idle");
        } else {
          logger.info(line, "worker pass complete");
        }

        /**
         * A saturated pass comes back immediately instead of waiting out its interval:
         * it stopped because it hit the batch cap, not because there was no work left, and
         * a backlog should drain at the speed of the database rather than the clock.
         */
        if (result.saturated === true) continue;
      } catch (error) {
        /**
         * The catch is the point of this whole file. One malformed order, one lost
         * connection, one constraint violation must not stop the other four jobs or exit
         * the process — systemd would restart it into the same bad row and flap.
         *
         * `err` carries the stack for the journal. Nothing from the failing item is logged
         * here: a job that wants to name what it was working on does so itself, with the
         * ids §16 permits and nothing else.
         */
        metrics.increment("bosanda_worker_passes_total", { job: job.name, outcome: "error" });
        logger.error({ job: job.name, err: error }, "worker pass failed");
      }

      await sleep(job.intervalMs, controller.signal);
    }

    logger.info({ job: job.name }, "worker loop stopped");
  });

  return {
    finished: Promise.all(loops).then(() => undefined),
    stop: () => controller.abort(),
  };
}
