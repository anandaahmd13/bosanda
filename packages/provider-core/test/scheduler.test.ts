/**
 * Scheduler tests — PLAN.md §7 selection, §19 "Pool and retry".
 *
 * Covers: least-loaded ordering, tie-break FAIRNESS (by distribution, not one
 * pick), empty-pool error classification, slot release on success/throw/abort
 * including an abandoned stream, and concurrency ceilings.
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { CircuitBreakerRegistry, CooldownRegistry, Scheduler } from "@bosanda/provider-core";
import { account, controllableClock, pool } from "./fake-adapter.js";

const build = (
  options: {
    disabledRegions?: string[];
    disabledAccounts?: string[];
  } = {},
) => {
  const clock = controllableClock();
  const cooldowns = new CooldownRegistry({ clock });
  const breakers = new CircuitBreakerRegistry({ clock });
  const scheduler = new Scheduler({
    clock,
    cooldowns,
    breakers,
    disabledRegions: new Set(options.disabledRegions ?? []),
    disabledAccounts: new Set(options.disabledAccounts ?? []),
  });
  return { clock, cooldowns, breakers, scheduler };
};

describe("Scheduler selection (§7)", () => {
  it("picks the least-loaded account", () => {
    const { scheduler } = build();
    const accounts = pool(3);

    // Load acct-01 twice and acct-02 once, leaving acct-03 idle.
    scheduler.reserve("acct-01");
    scheduler.reserve("acct-01");
    scheduler.reserve("acct-02");

    const ordered = scheduler.candidates(accounts, { model: "model-a" });
    expect(ordered[0]?.accountId).toBe("acct-03");
    expect(ordered.map((a) => a.accountId)).toEqual(["acct-03", "acct-02", "acct-01"]);
  });

  it("uses error score as the second sort key when load is equal", () => {
    const { scheduler } = build();
    const accounts = [
      account("acct-a", { health: { errorScore: 5 } }),
      account("acct-b", { health: { errorScore: 0 } }),
    ];
    const ordered = scheduler.candidates(accounts, { model: "model-a" });
    expect(ordered[0]?.accountId).toBe("acct-b");
  });

  /**
   * The fairness property. An idle pool has every account at load 0 and error
   * score 0, so keys 1 and 2 cannot separate them. A scheduler that fell through
   * to the stable ID tie-break would return "acct-01" forever. LRU must rotate.
   */
  it("tie-break is FAIR across many calls, not just deterministic", () => {
    const { scheduler } = build();
    const accounts = pool(4);
    const picks = new Map<string, number>();

    // Reserve and immediately release, so load returns to 0 every round and only
    // the LRU key can order the tied set.
    for (let i = 0; i < 400; i += 1) {
      const lease = scheduler.reserveBest(accounts, { model: "model-a" });
      picks.set(lease.accountId, (picks.get(lease.accountId) ?? 0) + 1);
      lease.release();
    }

    expect(picks.size).toBe(4);
    // Perfect round-robin over a tied, equally-idle pool.
    for (const accountId of accounts.map((a) => a.accountId)) {
      expect(picks.get(accountId)).toBe(100);
    }
  });

  it("never returns an account excluded for this request (§7 rule 5)", () => {
    const { scheduler } = build();
    const accounts = pool(3);
    const ordered = scheduler.candidates(accounts, {
      model: "model-a",
      exclude: new Set(["acct-01", "acct-02"]),
    });
    expect(ordered.map((a) => a.accountId)).toEqual(["acct-03"]);
  });

  it("filters disabled, credential-invalid, region-disabled, and cooling accounts", () => {
    const { scheduler, cooldowns } = build({ disabledRegions: ["eu-west-1"] });
    const accounts = [
      account("ok", {}),
      account("disabled", { health: { status: "disabled" } }),
      account("revoked", { health: { status: "credential_invalid" } }),
      account("wrong-region", { region: "eu-west-1" }),
      account("cooling", {}),
    ];
    cooldowns.recordFailure(
      "cooling",
      new BosandaError("upstream_timeout", { internalDetail: "test" }),
    );

    const { eligible, rejected } = scheduler.classify(accounts, { model: "model-a" });
    expect(eligible.map((a) => a.accountId)).toEqual(["ok"]);
    expect(Object.fromEntries(rejected.map((r) => [r.accountId, r.reason]))).toEqual({
      disabled: "account_disabled",
      revoked: "credential_invalid",
      "wrong-region": "region_disabled",
      cooling: "cooling_down",
    });
  });

  it("respects the operator per-account disable kill switch (§3)", () => {
    const { scheduler } = build({ disabledAccounts: ["acct-02"] });
    const ordered = scheduler.candidates(pool(2), { model: "model-a" });
    expect(ordered.map((a) => a.accountId)).toEqual(["acct-01"]);
  });
});

describe("Scheduler empty-pool classification (§8)", () => {
  it("a fully-loaded pool yields no_healthy_provider (503)", () => {
    const { scheduler } = build();
    const accounts = [
      account("acct-01", { maxConcurrent: 1 }),
      account("acct-02", { maxConcurrent: 1 }),
    ];
    scheduler.reserve("acct-01");
    scheduler.reserve("acct-02");

    try {
      scheduler.candidates(accounts, { model: "model-a" });
      expect.unreachable("expected no_healthy_provider");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      const bosandaError = error as BosandaError;
      expect(bosandaError.code).toBe("no_healthy_provider");
      expect(bosandaError.status).toBe(503);
      expect(bosandaError.internalDetail).toContain("at_concurrency_ceiling=2");
      // The client-facing string must not leak account IDs or reasons.
      expect(bosandaError.publicMessage).toBe("No provider capacity is currently available.");
      expect(bosandaError.publicMessage).not.toContain("acct-01");
    }
  });

  it("an all-cooling pool is transient: no_healthy_provider, not model_not_allowed", () => {
    const { scheduler, cooldowns } = build();
    const accounts = pool(2);
    for (const a of accounts) {
      cooldowns.recordFailure(
        a.accountId,
        new BosandaError("upstream_timeout", { internalDetail: "test" }),
      );
    }
    expect(() => scheduler.candidates(accounts, { model: "model-a" })).toThrowError(
      expect.objectContaining({ code: "no_healthy_provider" }),
    );
  });

  /**
   * §8 has no `model_unavailable` code; the frozen ErrorCode union maps this to
   * `model_not_allowed` (403), because waiting will never make it succeed.
   */
  it("a model no account supports yields model_not_allowed (403), not 503", () => {
    const { scheduler } = build();
    const accounts = pool(3, ["model-a"]);

    try {
      scheduler.candidates(accounts, { model: "model-zzz" });
      expect.unreachable("expected model_not_allowed");
    } catch (error) {
      const bosandaError = error as BosandaError;
      expect(bosandaError.code).toBe("model_not_allowed");
      expect(bosandaError.status).toBe(403);
      expect(bosandaError.internalDetail).toContain("model-zzz");
      expect(bosandaError.internalDetail).toContain("model_unsupported=3");
    }
  });

  it("busy accounts that DO support the model stay transient (503)", () => {
    const { scheduler } = build();
    // One account supports the model but is full; another does not support it.
    const accounts = [
      account("supports-but-full", { models: ["model-a"], maxConcurrent: 1 }),
      account("other-model", { models: ["model-b"] }),
    ];
    scheduler.reserve("supports-but-full");

    // Capability exists in the pool, so this is capacity pressure, not a 403.
    expect(() => scheduler.candidates(accounts, { model: "model-a" })).toThrowError(
      expect.objectContaining({ code: "no_healthy_provider" }),
    );
  });
});

describe("Scheduler slot leasing — no leaks (§7)", () => {
  it("releases the slot on success", async () => {
    const { scheduler } = build();
    await scheduler.withLease("acct-01", async () => "done");
    expect(scheduler.activeCount("acct-01")).toBe(0);
    expect(scheduler.totalActive()).toBe(0);
  });

  it("holds the slot DURING the call, proving the counter is real", async () => {
    const { scheduler } = build();
    await scheduler.withLease("acct-01", async () => {
      expect(scheduler.activeCount("acct-01")).toBe(1);
    });
    expect(scheduler.activeCount("acct-01")).toBe(0);
  });

  it("releases the slot on throw", async () => {
    const { scheduler } = build();
    await expect(
      scheduler.withLease("acct-01", async () => {
        throw new BosandaError("upstream_incompatible", { internalDetail: "boom" });
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "upstream_incompatible" }));
    expect(scheduler.activeCount("acct-01")).toBe(0);
  });

  it("releases the slot on abort", async () => {
    const { scheduler } = build();
    const controller = new AbortController();
    await expect(
      scheduler.withLease("acct-01", async () => {
        controller.abort(new Error("client disconnected"));
        throw controller.signal.reason;
      }),
    ).rejects.toThrow("client disconnected");
    expect(scheduler.activeCount("acct-01")).toBe(0);
  });

  it("releases the slot when a stream completes normally", async () => {
    const { scheduler } = build();
    const seen: number[] = [];
    for await (const value of scheduler.streamWithLease("acct-01", async function* () {
      yield 1;
      yield 2;
    })) {
      seen.push(value);
    }
    expect(seen).toEqual([1, 2]);
    expect(scheduler.activeCount("acct-01")).toBe(0);
  });

  /**
   * The leak case that matters most: a client disconnects and the gateway stops
   * iterating. `break` triggers the generator's `finally`, so the slot returns.
   */
  it("releases the slot when the consumer ABANDONS the stream mid-iteration", async () => {
    const { scheduler } = build();
    let producedAfterBreak = 0;

    for await (const value of scheduler.streamWithLease("acct-01", async function* () {
      yield 1;
      producedAfterBreak += 1;
      yield 2;
      producedAfterBreak += 1;
    })) {
      expect(value).toBe(1);
      expect(scheduler.activeCount("acct-01")).toBe(1);
      break; // consumer walks away
    }

    expect(scheduler.activeCount("acct-01")).toBe(0);
    expect(producedAfterBreak).toBe(0);
  });

  it("releases the slot when a stream throws mid-iteration", async () => {
    const { scheduler } = build();
    await expect(
      (async () => {
        for await (const _value of scheduler.streamWithLease("acct-01", async function* () {
          yield 1;
          throw new BosandaError("upstream_timeout", { internalDetail: "stalled" });
        })) {
          // drain
        }
      })(),
    ).rejects.toThrowError(expect.objectContaining({ code: "upstream_timeout" }));
    expect(scheduler.activeCount("acct-01")).toBe(0);
  });

  it("release is idempotent — a double release cannot go negative", () => {
    const { scheduler } = build();
    const lease = scheduler.reserve("acct-01");
    expect(scheduler.activeCount("acct-01")).toBe(1);
    lease.release();
    lease.release();
    lease.release();
    expect(scheduler.activeCount("acct-01")).toBe(0);
    expect(lease.released).toBe(true);
  });
});

describe("Scheduler concurrency ceilings", () => {
  it("many simultaneous reservations never oversubscribe an account", async () => {
    const { scheduler } = build();
    const ceiling = 5;
    const accounts = [account("solo", { maxConcurrent: ceiling })];

    let peak = 0;
    let rejected = 0;

    // 50 concurrent attempts against a ceiling of 5.
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        let lease;
        try {
          lease = scheduler.reserveBest(accounts, { model: "model-a" });
        } catch (error) {
          expect((error as BosandaError).code).toBe("no_healthy_provider");
          rejected += 1;
          return;
        }
        peak = Math.max(peak, scheduler.activeCount("solo"));
        await Promise.resolve();
        lease.release();
      }),
    );

    expect(peak).toBeLessThanOrEqual(ceiling);
    expect(rejected).toBeGreaterThan(0);
    expect(scheduler.activeCount("solo")).toBe(0);
  });

  it("spreads concurrent load across a pool without exceeding any ceiling", async () => {
    const { scheduler } = build();
    const accounts = [
      account("a", { maxConcurrent: 2 }),
      account("b", { maxConcurrent: 2 }),
      account("c", { maxConcurrent: 2 }),
    ];

    const held: Array<{ accountId: string; release: () => void }> = [];
    // Exactly fill the pool: 3 accounts x 2 slots.
    for (let i = 0; i < 6; i += 1) {
      held.push(scheduler.reserveBest(accounts, { model: "model-a" }));
    }

    for (const accountId of ["a", "b", "c"]) {
      expect(scheduler.activeCount(accountId)).toBe(2);
    }
    // The 7th must be refused rather than oversubscribing.
    expect(() => scheduler.reserveBest(accounts, { model: "model-a" })).toThrowError(
      expect.objectContaining({ code: "no_healthy_provider" }),
    );

    for (const lease of held) lease.release();
    expect(scheduler.totalActive()).toBe(0);
  });

  it("treats an unset maxConcurrent as unlimited (§7: no hard cap in v1)", () => {
    const { scheduler } = build();
    const accounts = [account("unbounded")];
    for (let i = 0; i < 200; i += 1) scheduler.reserve("unbounded");
    expect(scheduler.activeCount("unbounded")).toBe(200);
    // Still eligible: least-loaded routing needs the count, not a cap.
    expect(scheduler.candidates(accounts, { model: "model-a" }).map((a) => a.accountId)).toEqual([
      "unbounded",
    ]);
  });
});
