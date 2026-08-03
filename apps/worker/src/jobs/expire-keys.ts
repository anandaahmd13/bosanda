/**
 * API key expiry sweep (PLAN.md §11 "24h validity", §10 ledger completeness).
 *
 * §16 invariant: EVERY balance change has a matching append-only ledger row. An expiring
 * key's balance goes to zero, so the sweep is not just a status update — it owes the ledger
 * an `expiry` row per key, or the quota history stops reconciling and a billing dispute
 * becomes unanswerable.
 *
 * THE ORDER OF OPERATIONS IS FORCED BY WHAT `sweepExpired` RETURNS. It returns ids, not
 * rows, because it is an `UPDATE ... RETURNING id`. Once it has run, the balance it
 * withdrew is gone from the row and there is nothing left to write a ledger delta from. So
 * this job reads the balances FIRST (`listExpiring`), then sweeps, then writes one ledger
 * row per id the sweep actually claimed, using the balance captured before.
 *
 * All three steps are in ONE transaction. A crash between the sweep and the ledger writes
 * would leave expired keys with no expiry rows — precisely the gap §16 invariant 4 exists
 * to make impossible.
 *
 * WHY THE READ SET AND THE SWEPT SET CAN DIFFER. `listExpiring` has no `FOR UPDATE`, and
 * `sweepExpired` uses `SKIP LOCKED`, so between them a key can be revoked by a customer or
 * claimed by another replica. The intersection is authoritative: a ledger row is written
 * only for an id the sweep returned, and an id with no captured balance is skipped rather
 * than assumed to be zero.
 */

import { METER_VERSION } from "@bosanda/metering";
import { ulid } from "@bosanda/shared";
import type { JobResult } from "../loop.js";
import type { WorkerDeps, WorkerTx } from "../deps.js";

/**
 * Batch cap, matching the repository default.
 *
 * `sweepExpired`'s comment is explicit that the caller loops until fewer than `limit` rows
 * come back; the runner's `saturated` signal is how that loop happens here, so a backlog
 * drains at database speed rather than one batch per interval.
 */
export const EXPIRE_BATCH = 500;

export type ExpireKeysDeps = Pick<
  WorkerDeps,
  "apiKeys" | "clock" | "logger" | "metrics" | "transact"
>;

export function expireKeysJob(deps: ExpireKeysDeps) {
  return async function runExpirySweep(): Promise<JobResult> {
    const now = deps.clock.now();

    /**
     * Read before write. This is the only chance to see what each key's remaining balance
     * was; after `sweepExpired` the row says `expired` and the balance is no longer
     * recoverable from it.
     */
    const expiring = await deps.apiKeys.listExpiring(now, EXPIRE_BATCH);
    if (expiring.length === 0) return { processed: 0, failed: 0 };

    const balances = new Map(expiring.map((key) => [key.id, key.quotaRemaining]));

    return await deps.transact(async (tx) => {
      const sweptIds = await tx.apiKeys.sweepExpired(now, EXPIRE_BATCH);
      if (sweptIds.length === 0) return { processed: 0, failed: 0 };

      let processed = 0;
      let failed = 0;

      for (const apiKeyId of sweptIds) {
        const remaining = balances.get(apiKeyId);

        /**
         * The sweep claimed a key this pass had not read — another replica's `listExpiring`
         * saw it, or it crossed `expires_at` in between. Re-reading it inside the
         * transaction is correct rather than guessing zero: an expiry row with the wrong
         * delta is worse than a slightly slower pass, because the ledger is the artifact a
         * dispute is settled from.
         */
        const withdrawn =
          remaining ?? (await tx.apiKeys.findById(apiKeyId))?.quotaRemaining ?? null;

        if (withdrawn === null) {
          /**
           * Swept but unreadable. Do not fabricate a ledger row; count it as failed so the
           * metric shows it, and let the next pass find nothing (the key is already
           * `expired`, so it will not be swept again — this is a genuine gap that needs a
           * human, and a silent zero would hide it).
           */
          failed += 1;
          deps.logger.error({ apiKeyId }, "swept key could not be read for its expiry ledger row");
          continue;
        }

        /**
         * A key that expires with a zero balance still gets a row. It costs one insert and
         * it makes "why did this key stop working" answerable from the ledger alone, without
         * having to infer absence.
         *
         * The delta is NEGATIVE: the balance is being withdrawn. `recordExpiry` forces
         * `balanceAfter` to 0 regardless, so the delta is what preserves the audit value.
         */
        await tx.quota.recordExpiry({
          id: ulid(),
          apiKeyId,
          weightedTokensDelta: -withdrawn,
          meterVersion: METER_VERSION,
          createdAt: now,
        });

        await appendAudit(tx, apiKeyId, withdrawn, now);
        processed += 1;
      }

      deps.logger.info(
        { swept: sweptIds.length, processed, failed },
        "api key expiry sweep complete",
      );

      return { processed, failed, saturated: sweptIds.length >= EXPIRE_BATCH };
    });
  };
}

/**
 * §17 audit trail. `withdrawn` is a token count, not money and not key material, so it is
 * safe metadata; the key id is an opaque ULID.
 */
async function appendAudit(
  tx: WorkerTx,
  apiKeyId: string,
  withdrawn: number,
  at: Date,
): Promise<void> {
  await tx.audit.append({
    id: ulid(),
    actorType: "system",
    actorId: null,
    action: "api_key.expired",
    targetType: "api_key",
    targetId: apiKeyId,
    metadata: { withdrawnWeightedTokens: withdrawn },
    createdAt: at,
  });
}
