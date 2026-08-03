/**
 * The job runner (PLAN.md §13, §17).
 *
 * Three properties are load-bearing and each has a test that fails loudly if it regresses:
 * a job never overlaps itself, a throwing job does not kill the process or its siblings, and
 * an abort interrupts an in-flight sleep rather than waiting the interval out (which is what
 * keeps a drain inside systemd's `TimeoutStopSec=90`).
 *
 * Every test injects `sleep`, so no test waits on real time. The injected sleep also gives a
 * precise seam for asserting the scheduling order — a recorded `sleep(ms)` call means "the
 * pass before it settled".
 */

import { describe, expect, it } from "vitest";
import { abortableSleep, startRunner, type Job, type JobResult } from "../src/loop.js";
import { recordingLogger, testRegistry } from "./harness.js";

/**
 * A sleep that never resolves on its own and only resolves on abort.
 *
 * This is what makes the tests deterministic: a loop that has called sleep is parked until
 * the runner is stopped, so "how many passes ran" is exactly "how many the test allowed".
 */
function abortOnlySleep(record: number[]) {
  return (ms: number, signal: AbortSignal): Promise<void> => {
    record.push(ms);
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

/**
 * A sleep that yields a REAL macrotask for its first `resolveFirst` calls and then parks
 * until abort.
 *
 * The real timer is not incidental. A fake sleep that resolves in a microtask, paired with a
 * job that also resolves in a microtask, means the `while` loop never yields to the macrotask
 * queue at all — the test's own `setImmediate` never fires and the loop spins until the heap
 * is gone. Yielding once per pass lets the loop make progress and stay observable.
 */
function steppedSleep(record: number[], resolveFirst: number) {
  return (ms: number, signal: AbortSignal): Promise<void> => {
    record.push(ms);
    if (signal.aborted) return Promise.resolve();
    if (record.length <= resolveFirst) {
      return new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

/** Polls until the predicate holds, so a test never depends on a fixed number of ticks. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

const idle: JobResult = { processed: 0, failed: 0 };

function job(overrides: Partial<Job> & { run: Job["run"] }): Job {
  return { name: "test-job", intervalMs: 60_000, ...overrides };
}

describe("abortableSleep", () => {
  it("resolves early when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();

    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await pending;

    // Would be ~60s if the abort were not wired up.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
  });

  it("resolves on its own when the interval elapses", async () => {
    const controller = new AbortController();

    await expect(abortableSleep(1, controller.signal)).resolves.toBeUndefined();
  });
});

describe("startRunner", () => {
  it("runs a pass, then stops when told, and resolves finished", async () => {
    const sleeps: number[] = [];
    let passes = 0;
    const runner = startRunner({
      jobs: [
        job({
          run: async () => {
            passes += 1;
            return idle;
          },
        }),
      ],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      sleep: abortOnlySleep(sleeps),
    });

    // Let the first pass land and park in sleep.
    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    expect(passes).toBe(1);
    expect(sleeps).toEqual([60_000]);
  });

  it("never overlaps a job with itself", async () => {
    /**
     * The reason this file exists rather than a `setInterval`. Two concurrent reconciliation
     * passes would both try to activate the same order. `inFlight` going above 1 at any point
     * is the failure.
     */
    let inFlight = 0;
    let peak = 0;
    let release: (() => void) | null = null;

    const runner = startRunner({
      jobs: [
        job({
          run: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            inFlight -= 1;
            return idle;
          },
        }),
      ],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      // Returns immediately, so the loop would spin as fast as it can if it could.
      sleep: async () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    // Give the event loop many turns while the single pass is deliberately stuck.
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(peak).toBe(1);
    expect(inFlight).toBe(1);

    runner.stop();
    release?.();
    await runner.finished;
  });

  it("keeps running after a job throws, and counts the pass as an error", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const logger = recordingLogger();
    const metrics = testRegistry();

    const runner = startRunner({
      jobs: [
        job({
          run: async () => {
            calls += 1;
            if (calls === 1) throw new Error("boom");
            return idle;
          },
        }),
      ],
      logger: logger as never,
      metrics,
      // One real sleep, so the second pass runs and then the loop parks.
      sleep: steppedSleep(sleeps, 1),
    });

    await waitUntil(() => calls > 1, "second pass after a throw");
    runner.stop();
    await runner.finished;

    expect(calls).toBeGreaterThan(1);
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
    expect(metrics.render()).toContain('outcome="error"');
    // It still slept after the failure rather than hot-looping on the bad pass.
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("does not let one failing job stop another job's loop", async () => {
    const sleeps: number[] = [];
    let healthy = 0;
    const runner = startRunner({
      jobs: [
        job({
          name: "broken",
          run: async () => {
            throw new Error("boom");
          },
        }),
        job({
          name: "healthy",
          run: async () => {
            healthy += 1;
            return idle;
          },
        }),
      ],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      sleep: abortOnlySleep(sleeps),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    expect(healthy).toBe(1);
  });

  it("gives each job its own loop and its own interval", async () => {
    /**
     * Independent, not sequenced: a slow reconciliation pass must not delay the key-expiry
     * sweep. Both intervals showing up means neither loop is waiting on the other's tick.
     */
    const sleeps: number[] = [];
    const runner = startRunner({
      jobs: [
        job({ name: "fast", intervalMs: 1_000, run: async () => idle }),
        job({ name: "slow", intervalMs: 3_600_000, run: async () => idle }),
      ],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      sleep: abortOnlySleep(sleeps),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    expect(sleeps.sort((a, b) => a - b)).toEqual([1_000, 3_600_000]);
  });

  it("skips the sleep entirely while a pass reports saturation", async () => {
    /**
     * A saturated pass stopped at its batch cap, not because the work ran out, so a backlog
     * drains at database speed rather than one batch per interval.
     */
    const sleeps: number[] = [];
    let calls = 0;
    const runner = startRunner({
      jobs: [
        job({
          run: async () => {
            calls += 1;
            return calls <= 3
              ? { processed: 500, failed: 0, saturated: true }
              : { processed: 1, failed: 0 };
          },
        }),
      ],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      sleep: abortOnlySleep(sleeps),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    // Four passes ran, but only the first non-saturated one reached a sleep.
    expect(calls).toBe(4);
    expect(sleeps).toEqual([60_000]);
  });

  it("stops without starting another pass once aborted mid-sleep", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const runner = startRunner({
      jobs: [
        job({
          run: async () => {
            calls += 1;
            return idle;
          },
        }),
      ],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      sleep: abortOnlySleep(sleeps),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    expect(calls).toBe(1);
  });

  it("lets an in-flight pass finish before finished resolves", async () => {
    /**
     * Stop is not a kill. A pass that is halfway through a transaction gets to commit or roll
     * back on its own terms; `finished` is the signal that it is safe to close the pool.
     */
    let settled = false;
    let release: (() => void) | null = null;

    const runner = startRunner({
      jobs: [
        job({
          run: async () => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            settled = true;
            return idle;
          },
        }),
      ],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      sleep: async () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    expect(settled).toBe(false);

    release?.();
    await runner.finished;
    expect(settled).toBe(true);
  });

  it("is idempotent on repeated stops", async () => {
    const runner = startRunner({
      jobs: [job({ run: async () => idle })],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
      sleep: abortOnlySleep([]),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    runner.stop();
    runner.stop();

    await expect(runner.finished).resolves.toBeUndefined();
  });

  it("resolves finished immediately when given no jobs", async () => {
    const runner = startRunner({
      jobs: [],
      logger: recordingLogger() as never,
      metrics: testRegistry(),
    });

    runner.stop();
    await expect(runner.finished).resolves.toBeUndefined();
  });

  it("logs an idle pass at debug and a working pass at info", async () => {
    /**
     * A healthy worker runs five loops around the clock. If an idle pass logged at info the
     * journal would be nothing but "processed 0" and the lines that matter would be
     * unfindable.
     */
    const logger = recordingLogger();
    const runner = startRunner({
      jobs: [
        job({ name: "quiet", run: async () => idle }),
        job({ name: "busy", run: async () => ({ processed: 2, failed: 0 }) }),
      ],
      logger: logger as never,
      metrics: testRegistry(),
      sleep: abortOnlySleep([]),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    const debug = logger.entries.filter((e) => e.level === "debug");
    const info = logger.entries.filter((e) => e.level === "info");
    expect(debug.some((e) => (e.obj as { job?: string }).job === "quiet")).toBe(true);
    expect(info.some((e) => (e.obj as { job?: string }).job === "busy")).toBe(true);
  });

  it("counts failed items against the job that reported them", async () => {
    const metrics = testRegistry();
    const runner = startRunner({
      jobs: [job({ name: "reconcile", run: async () => ({ processed: 1, failed: 3 }) })],
      logger: recordingLogger() as never,
      metrics,
      sleep: abortOnlySleep([]),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    const rendered = metrics.render();
    expect(rendered).toContain("bosanda_worker_items_failed_total");
    expect(rendered).toContain('job="reconcile"');
    expect(rendered).toContain("bosanda_worker_pass_ms");
  });

  it("observes pass duration even for an idle pass", async () => {
    const metrics = testRegistry();
    const runner = startRunner({
      jobs: [job({ run: async () => idle })],
      logger: recordingLogger() as never,
      metrics,
      sleep: abortOnlySleep([]),
    });

    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await runner.finished;

    expect(metrics.render()).toContain("bosanda_worker_pass_ms_count");
  });
});
