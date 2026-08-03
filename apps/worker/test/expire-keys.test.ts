/**
 * API key expiry sweep (PLAN.md §11, §16 invariant: every balance change has a ledger row).
 *
 * The property under test is the read-then-sweep-then-write ORDER. `sweepExpired` returns
 * ids only, so a pass that swept before capturing balances would have no delta to write and
 * the ledger would stop reconciling. Several of these tests exist specifically to fail if
 * someone reorders those three steps.
 */

import { describe, expect, it } from "vitest";
import { expireKeysJob, EXPIRE_BATCH } from "../src/jobs/expire-keys.js";
import {
  immediateTransact,
  makeApiKey,
  recordingLogger,
  testClock,
  testRegistry,
  txRecorder,
  type TxRecorder,
} from "./harness.js";

type Deps = Parameters<typeof expireKeysJob>[0];

function build(
  expiring: ReturnType<typeof makeApiKey>[],
  recorder: TxRecorder,
): { deps: Deps; logger: ReturnType<typeof recordingLogger> } {
  const logger = recordingLogger();
  return {
    logger,
    deps: {
      apiKeys: { listExpiring: async () => expiring },
      clock: testClock(),
      logger: logger as never,
      metrics: testRegistry(),
      transact: immediateTransact(recorder),
    } satisfies Deps,
  };
}

describe("expireKeysJob", () => {
  it("does nothing and opens no transaction when nothing is expiring", async () => {
    const recorder = txRecorder();
    const { deps } = build([], recorder);

    const result = await expireKeysJob(deps)();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(recorder.calls).toEqual([]);
  });

  it("writes one expiry ledger row per swept key, with the balance captured before the sweep", async () => {
    const key = makeApiKey({ quotaRemaining: 250_000 });
    const recorder = txRecorder({ sweepIds: [key.id] });
    const { deps } = build([key], recorder);

    const result = await expireKeysJob(deps)();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    // Negative: the balance is being withdrawn. `recordExpiry` forces balanceAfter to 0, so
    // the delta is the only thing preserving what was taken.
    expect(recorder.expiries).toEqual([{ apiKeyId: key.id, weightedTokensDelta: -250_000 }]);
  });

  it("sweeps before writing, and writes only for ids the sweep actually claimed", async () => {
    /**
     * `listExpiring` has no `FOR UPDATE` and `sweepExpired` uses `SKIP LOCKED`, so the read
     * set and the swept set can differ. The swept set is authoritative — a key another
     * replica claimed must not get a second expiry row from this pass.
     */
    const mine = makeApiKey({ id: "01HQKEY000000000000000001", quotaRemaining: 100 });
    const theirs = makeApiKey({ id: "01HQKEY000000000000000002", quotaRemaining: 200 });
    const recorder = txRecorder({ sweepIds: [mine.id] });
    const { deps } = build([mine, theirs], recorder);

    await expireKeysJob(deps)();

    expect(recorder.expiries.map((e) => e.apiKeyId)).toEqual([mine.id]);
    expect(recorder.calls.indexOf("sweepExpired")).toBeLessThan(
      recorder.calls.indexOf(`recordExpiry:${mine.id}`),
    );
  });

  it("re-reads a key the sweep claimed that this pass had not seen", async () => {
    /**
     * Another replica's read saw it, or it crossed `expires_at` in between. Re-reading is
     * correct rather than assuming zero: a wrong delta in the ledger is worse than a slower
     * pass, because the ledger is what a billing dispute is settled from.
     */
    const unseen = makeApiKey({ id: "01HQKEY000000000000000009", quotaRemaining: 4_242 });
    const recorder = txRecorder({
      sweepIds: [unseen.id],
      keysById: new Map([[unseen.id, unseen]]),
    });

    /**
     * An empty `listExpiring` exits before the transaction opens, so the read set has to be
     * non-empty for this path to be reachable at all: one key read, a different key swept.
     */
    const seen = makeApiKey({ id: "01HQKEY000000000000000001", quotaRemaining: 1 });
    const { deps } = build([seen], recorder);

    const result = await expireKeysJob(deps)();

    expect(recorder.calls).toContain(`findById:${unseen.id}`);
    expect(recorder.expiries).toEqual([{ apiKeyId: unseen.id, weightedTokensDelta: -4_242 }]);
    expect(result.failed).toBe(0);
  });

  it("counts a swept-but-unreadable key as failed instead of fabricating a zero row", async () => {
    const seen = makeApiKey({ id: "01HQKEY000000000000000001" });
    const recorder = txRecorder({
      sweepIds: ["01HQKEY000000000000000099"],
      keysById: new Map(),
    });
    const { deps, logger } = build([seen], recorder);

    const result = await expireKeysJob(deps)();

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
    expect(recorder.expiries).toEqual([]);
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
  });

  it("still writes a ledger row for a key that expires with a zero balance", async () => {
    /**
     * One insert, and it makes "why did this key stop working" answerable from the ledger
     * alone rather than by inferring absence.
     */
    const key = makeApiKey({ quotaRemaining: 0 });
    const recorder = txRecorder({ sweepIds: [key.id] });
    const { deps } = build([key], recorder);

    const result = await expireKeysJob(deps)();

    expect(result.processed).toBe(1);
    expect(recorder.expiries).toHaveLength(1);
    expect(recorder.expiries[0]?.apiKeyId).toBe(key.id);
    // `-0` and `0` are both correct; negating zero is an artifact, not a distinction.
    expect(recorder.expiries[0]?.weightedTokensDelta === 0).toBe(true);
  });

  it("appends an audit row naming the withdrawn amount", async () => {
    const key = makeApiKey({ quotaRemaining: 777 });
    const recorder = txRecorder({ sweepIds: [key.id] });
    const { deps } = build([key], recorder);

    await expireKeysJob(deps)();

    expect(recorder.audits).toEqual([
      {
        action: "api_key.expired",
        targetId: key.id,
        metadata: { withdrawnWeightedTokens: 777 },
      },
    ]);
  });

  it("never puts key material in a log or an audit row", async () => {
    /**
     * §16: no plaintext key, ciphertext, or lookup digest may be logged or stored outside the
     * keys table. The sweep handles whole key rows, so this is the job most able to leak one.
     */
    const key = makeApiKey({
      encryptedKey: "SECRET-CIPHERTEXT-VALUE",
      lookupDigest: "SECRET-DIGEST-VALUE",
      prefix: "bsk_live_SECRETPREFIX",
    });
    const recorder = txRecorder({ sweepIds: [key.id] });
    const { deps, logger } = build([key], recorder);

    await expireKeysJob(deps)();

    const serialized = JSON.stringify({ logs: logger.entries, audits: recorder.audits });
    expect(serialized).not.toContain("SECRET-CIPHERTEXT-VALUE");
    expect(serialized).not.toContain("SECRET-DIGEST-VALUE");
    expect(serialized).not.toContain("SECRETPREFIX");
  });

  it("reports saturation when the sweep filled its batch", async () => {
    const keys = Array.from({ length: EXPIRE_BATCH }, (_, index) =>
      makeApiKey({ id: `01HQKEY${String(index).padStart(19, "0")}`, quotaRemaining: 1 }),
    );
    const recorder = txRecorder({ sweepIds: keys.map((k) => k.id) });
    const { deps } = build(keys, recorder);

    const result = await expireKeysJob(deps)();

    expect(result.saturated).toBe(true);
    expect(result.processed).toBe(EXPIRE_BATCH);
  });

  it("returns zero when the sweep claimed nothing despite candidates being visible", async () => {
    // Every candidate was taken by another replica between the read and the sweep.
    const recorder = txRecorder({ sweepIds: [] });
    const { deps } = build([makeApiKey()], recorder);

    const result = await expireKeysJob(deps)();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(recorder.expiries).toEqual([]);
  });
});
