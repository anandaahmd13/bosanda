/**
 * Cooldown clearing and data retention (PLAN.md §6 pool health, §17 retention).
 *
 * Neither job has a cross-table invariant to protect, so the tests here are about boundaries
 * rather than atomicity: the retention cutoff is computed from the clock and not hardcoded,
 * batches are bounded so a backlog drains across passes instead of in one lock-holding
 * DELETE, and neither job logs anything about a provider account beyond a count.
 */

import { describe, expect, it } from "vitest";
import {
  clearCooldownsJob,
  COOLDOWN_BATCH,
  HEALTH_EVENT_BATCH,
  HEALTH_EVENT_RETENTION_MS,
  retentionJob,
  SESSION_BATCH,
} from "../src/jobs/maintenance.js";
import { FIXED_NOW, recordingLogger, testClock } from "./harness.js";

type CooldownDeps = Parameters<typeof clearCooldownsJob>[0];
type RetentionDeps = Parameters<typeof retentionJob>[0];

type CooldownCall = { now: Date; limit: number };

function cooldownDeps(cleared: string[]): {
  deps: CooldownDeps;
  logger: ReturnType<typeof recordingLogger>;
  calls: CooldownCall[];
} {
  const logger = recordingLogger();
  const calls: CooldownCall[] = [];
  return {
    logger,
    calls,
    deps: {
      providerAccounts: {
        clearElapsedCooldowns: async (now: Date, limit: number) => {
          calls.push({ now, limit });
          return cleared;
        },
        deleteHealthEventsOlderThan: async () => 0,
      },
      clock: testClock(),
      logger: logger as never,
    } as CooldownDeps,
  };
}

function retentionDeps(
  healthEvents: number,
  sessions: number,
): {
  deps: RetentionDeps;
  logger: ReturnType<typeof recordingLogger>;
  healthCalls: { cutoff: Date; limit: number }[];
  sessionCalls: { now: Date; limit: number }[];
} {
  const logger = recordingLogger();
  const healthCalls: { cutoff: Date; limit: number }[] = [];
  const sessionCalls: { now: Date; limit: number }[] = [];
  return {
    logger,
    healthCalls,
    sessionCalls,
    deps: {
      providerAccounts: {
        clearElapsedCooldowns: async () => [],
        deleteHealthEventsOlderThan: async (cutoff: Date, limit: number) => {
          healthCalls.push({ cutoff, limit });
          return healthEvents;
        },
      },
      sessions: {
        deleteExpired: async (now: Date, limit: number) => {
          sessionCalls.push({ now, limit });
          return sessions;
        },
      },
      clock: testClock(),
      logger: logger as never,
    } as RetentionDeps,
  };
}

describe("clearCooldownsJob", () => {
  it("reports no work and logs nothing when no cooldown has elapsed", async () => {
    const { deps, logger } = cooldownDeps([]);

    const result = await clearCooldownsJob(deps)();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(logger.entries).toEqual([]);
  });

  it("clears elapsed cooldowns as of the current time, bounded by the batch cap", async () => {
    const { deps, calls } = cooldownDeps(["01HQACC000000000000000001"]);

    const result = await clearCooldownsJob(deps)();

    expect(calls).toEqual([{ now: FIXED_NOW, limit: COOLDOWN_BATCH }]);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("logs a count and never a provider account id", async () => {
    /**
     * §16: an account's credential, region, and persona are not this job's business, and the
     * ids themselves buy nothing here — the count is what an operator acts on.
     */
    const { deps, logger } = cooldownDeps([
      "01HQACC0SENTINELACCOUNT01",
      "01HQACC0SENTINELACCOUNT02",
    ]);

    await clearCooldownsJob(deps)();

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain("SENTINELACCOUNT");
    expect(serialized).toContain("2");
  });

  it("reports saturation when the batch came back full so the runner passes again immediately", async () => {
    const ids = Array.from({ length: COOLDOWN_BATCH }, (_, i) => `acc-${i}`);
    const { deps } = cooldownDeps(ids);

    const result = await clearCooldownsJob(deps)();

    expect(result.saturated).toBe(true);
  });

  it("does not report saturation on a partial batch", async () => {
    const { deps } = cooldownDeps(["acc-1"]);

    const result = await clearCooldownsJob(deps)();

    expect(result.saturated).toBe(false);
  });
});

describe("retentionJob", () => {
  it("reports no work when both tables are already clean", async () => {
    const { deps, logger } = retentionDeps(0, 0);

    const result = await retentionJob(deps)();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(logger.entries).toEqual([]);
  });

  it("derives the health event cutoff from the clock and the retention window", async () => {
    /**
     * Pinning the arithmetic rather than the literal: if the window is ever changed the
     * cutoff must move with it, and a hardcoded date here would hide that.
     */
    const { deps, healthCalls } = retentionDeps(3, 0);

    await retentionJob(deps)();

    expect(healthCalls).toEqual([
      {
        cutoff: new Date(FIXED_NOW.getTime() - HEALTH_EVENT_RETENTION_MS),
        limit: HEALTH_EVENT_BATCH,
      },
    ]);
    expect(healthCalls[0]?.cutoff.getTime()).toBeLessThan(FIXED_NOW.getTime());
  });

  it("deletes sessions that are expired as of now, not against the retention cutoff", async () => {
    /**
     * An expired session has no remaining purpose the moment it expires — `findWithUser`
     * already refuses it. Holding it for the health event window would keep dead auth rows
     * around for a month for no reason.
     */
    const { deps, sessionCalls } = retentionDeps(0, 5);

    await retentionJob(deps)();

    expect(sessionCalls).toEqual([{ now: FIXED_NOW, limit: SESSION_BATCH }]);
  });

  it("sums both deletions into the processed count", async () => {
    const { deps } = retentionDeps(7, 4);

    const result = await retentionJob(deps)();

    expect(result.processed).toBe(11);
    expect(result.failed).toBe(0);
  });

  it("saturates when either table filled its batch", async () => {
    const health = await retentionJob(retentionDeps(HEALTH_EVENT_BATCH, 0).deps)();
    const sessions = await retentionJob(retentionDeps(0, SESSION_BATCH).deps)();
    const neither = await retentionJob(retentionDeps(1, 1).deps)();

    expect(health.saturated).toBe(true);
    expect(sessions.saturated).toBe(true);
    expect(neither.saturated).toBe(false);
  });

  it("logs the two counts separately so a backlog can be attributed to a table", async () => {
    const { deps, logger } = retentionDeps(7, 4);

    await retentionJob(deps)();

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.obj).toEqual({ healthEvents: 7, sessions: 4 });
  });
});
