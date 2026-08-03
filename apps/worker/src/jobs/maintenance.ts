/**
 * Provider cooldown clearing and data retention (PLAN.md §6 pool health, §17 retention).
 *
 * Two jobs in one file because they share a shape: both are single bounded statements with
 * no cross-table invariant, so neither needs a transaction and neither can leave a partial
 * write behind. Anything that DID need a transaction (reconciliation, key expiry) lives in
 * its own file.
 *
 * ── WHY COOLDOWN CLEARING IS A JOB AND NOT JUST IN-MEMORY EXPIRY ──────────
 * `CooldownRegistry` in the gateway already treats an elapsed cooldown as over, so serving
 * does not depend on this job. What depends on it is everything that reads the DATABASE:
 * the admin console's account list, `listEligible`, and a gateway process that just
 * restarted with an empty in-memory registry. Without this sweep, `cooldown_until` stays in
 * the past forever and an operator sees accounts described as cooling down that are in fact
 * available. This job is what makes the persisted view agree with the served one.
 *
 * ── WHY RETENTION IS BOUNDED PER PASS ─────────────────────────────────────
 * `deleteHealthEventsOlderThan` and `deleteExpired` both take a `limit`. A single unbounded
 * `DELETE` over months of health events would hold locks long enough to be
 * indistinguishable from an outage, and on a table the gateway writes to on every provider
 * error that is a self-inflicted incident. Bounded batches plus the runner's `saturated`
 * signal drain a backlog at database speed while staying interruptible by SIGTERM.
 */

import type { JobResult } from "../loop.js";
import type { WorkerDeps } from "../deps.js";

/** Batch caps, matching the repository defaults so `saturated` is meaningful. */
export const COOLDOWN_BATCH = 200;
export const HEALTH_EVENT_BATCH = 1_000;
export const SESSION_BATCH = 1_000;

/**
 * How long a provider health event is kept (§17).
 *
 * 30 days is chosen against the thing the data is actually for: diagnosing whether an
 * account's failures are a pattern or an incident. That question is asked in the days after
 * a problem, not the months. Keeping more would grow the busiest-written table in the
 * schema without making any answer better.
 */
export const HEALTH_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type CooldownDeps = Pick<WorkerDeps, "providerAccounts" | "clock" | "logger">;

export function clearCooldownsJob(deps: CooldownDeps) {
  return async function runCooldownClear(): Promise<JobResult> {
    const cleared = await deps.providerAccounts.clearElapsedCooldowns(
      deps.clock.now(),
      COOLDOWN_BATCH,
    );
    if (cleared.length === 0) return { processed: 0, failed: 0 };

    /**
     * Account ids are logged; nothing else about the account is. A provider account id is an
     * opaque ULID, while the region, persona, and above all the credential are not this
     * job's business (§16).
     */
    deps.logger.info({ count: cleared.length }, "cleared elapsed provider cooldowns");

    return {
      processed: cleared.length,
      failed: 0,
      saturated: cleared.length >= COOLDOWN_BATCH,
    };
  };
}

export type RetentionDeps = Pick<WorkerDeps, "providerAccounts" | "sessions" | "clock" | "logger">;

/**
 * Deletes aged health events and expired sessions.
 *
 * Sessions are deleted rather than merely revoked because an EXPIRED session row has no
 * remaining purpose: `findWithUser` already refuses it, so keeping it serves neither auth
 * nor audit. The audit trail of who logged in lives in `audit_events`, which this job never
 * touches — §17's retention policy applies to operational tables, not to the audit log.
 */
export function retentionJob(deps: RetentionDeps) {
  return async function runRetention(): Promise<JobResult> {
    const now = deps.clock.now();
    const healthCutoff = new Date(now.getTime() - HEALTH_EVENT_RETENTION_MS);

    const healthEvents = await deps.providerAccounts.deleteHealthEventsOlderThan(
      healthCutoff,
      HEALTH_EVENT_BATCH,
    );
    const sessions = await deps.sessions.deleteExpired(now, SESSION_BATCH);

    const processed = healthEvents + sessions;
    if (processed === 0) return { processed: 0, failed: 0 };

    deps.logger.info({ healthEvents, sessions }, "retention sweep complete");

    return {
      processed,
      failed: 0,
      saturated: healthEvents >= HEALTH_EVENT_BATCH || sessions >= SESSION_BATCH,
    };
  };
}
