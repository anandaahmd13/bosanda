/**
 * Retry / failover tests — PLAN.md §7 "Retry policy", §21 criterion 7,
 * IMPLEMENTATION-STATUS.md invariant 8.
 *
 * The load-bearing assertion in this file is the interlock: after ONE event has
 * reached the consumer, a mid-stream upstream failure must surface as a stream
 * error and must NOT touch a second account. Every test that exercises it also
 * asserts on `FakeAdapter.calls.streamedAccounts`, because "did it fail over?"
 * is only answerable by looking at which accounts were actually dialled.
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import type { CanonicalEvent, ErrorCode } from "@bosanda/protocol";
import {
  CircuitBreakerRegistry,
  CooldownRegistry,
  Scheduler,
  collectWithFailover,
  streamWithFailover,
} from "@bosanda/provider-core";
import type { AttemptInfo, SchedulableAccount, Sink } from "@bosanda/provider-core";
import { FakeAdapter, controllableClock, pool, request } from "./fake-adapter.js";

const retryable = (detail: string) =>
  new BosandaError("upstream_incompatible", { internalDetail: detail });

type Harness = {
  clock: ReturnType<typeof controllableClock>;
  scheduler: Scheduler;
  cooldowns: CooldownRegistry;
  breakers: CircuitBreakerRegistry;
  accounts: SchedulableAccount[];
  attempts: AttemptInfo[];
};

function harness(accountCount = 3): Harness {
  const clock = controllableClock();
  const cooldowns = new CooldownRegistry({ clock });
  const breakers = new CircuitBreakerRegistry({ clock });
  const scheduler = new Scheduler({ clock, cooldowns, breakers });
  return { clock, scheduler, cooldowns, breakers, accounts: pool(accountCount), attempts: [] };
}

/**
 * Wires a FakeAdapter into `streamWithFailover`. The attempt callback may ONLY
 * produce output through the sink it is handed — there is no flag to set.
 */
function run(
  h: Harness,
  adapter: FakeAdapter,
  options: { signal?: AbortSignal; maxAttempts?: number } = {},
): AsyncGenerator<CanonicalEvent> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  return streamWithFailover<CanonicalEvent>({
    scheduler: h.scheduler,
    cooldowns: h.cooldowns,
    breakers: h.breakers,
    clock: h.clock,
    pool: h.accounts,
    context: { model: "model-a" },
    signal,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    onAttempt: (info) => h.attempts.push(info),
    attempt: async (account, sink: Sink<CanonicalEvent>, attemptSignal) => {
      for await (const event of adapter.stream(request(), account.accountId, attemptSignal)) {
        await sink.emit(event);
      }
    },
  });
}

async function drain(stream: AsyncGenerator<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("failover before the first byte (§7 rule 3)", () => {
  it("retries a retryable pre-first-byte failure on a DIFFERENT account and succeeds", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter({
      behaviour: { "acct-01": retryable("first account is broken") },
    });

    const events = await drain(run(h, adapter));

    expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "finish"]);
    // Dialled acct-01, failed, then a *different* account served the request.
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01", "acct-02"]);
    expect(h.attempts).toEqual([
      {
        accountId: "acct-01",
        attempt: 1,
        outcome: "retried",
        code: "upstream_incompatible",
        afterFirstByte: false,
      },
      // afterFirstByte is literal: the winning attempt did emit output, so it is
      // true here. It only carries "retry was forbidden" meaning on a failure.
      { accountId: "acct-02", attempt: 2, outcome: "success", afterFirstByte: true },
    ]);
  });

  it("walks past several broken accounts within the cap", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter({
      behaviour: { "acct-01": retryable("down"), "acct-02": retryable("down") },
    });

    const events = await drain(run(h, adapter));

    expect(events).toHaveLength(3);
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01", "acct-02", "acct-03"]);
  });

  it("never retries the same account twice for one request (§7 rule 5)", async () => {
    const h = harness(5);
    const adapter = new FakeAdapter({
      behaviour: {
        "acct-01": retryable("down"),
        "acct-02": retryable("down"),
        "acct-03": retryable("down"),
        "acct-04": retryable("down"),
        "acct-05": retryable("down"),
      },
    });

    await expect(drain(run(h, adapter, { maxAttempts: 5 }))).rejects.toThrow(BosandaError);

    const dialled = adapter.calls.streamedAccounts;
    expect(new Set(dialled).size).toBe(dialled.length);
    expect(dialled).toEqual(["acct-01", "acct-02", "acct-03", "acct-04", "acct-05"]);
  });

  it("marks each failed account as cooling down, so a re-selection cannot happen", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter({ behaviour: { "acct-01": retryable("down") } });
    await drain(run(h, adapter));

    // upstream_incompatible is a shouldCooldownProvider code.
    expect(h.cooldowns.isCoolingDown("acct-01")).toBe(true);
    // The winner's history was cleared on success.
    expect(h.cooldowns.isCoolingDown("acct-02")).toBe(false);
  });
});

describe("THE INTERLOCK: no failover after the first byte (§7 rule 7)", () => {
  it("does NOT retry after one event has been emitted; client sees a stream error", async () => {
    const h = harness(3);
    const boom = retryable("died mid-stream");
    const adapter = new FakeAdapter({
      // Fails after exactly one event. That event has already reached the
      // consumer, so this is terminal even though the code IS retryable.
      behaviour: { "acct-01": { afterEvents: 1, error: boom } },
    });

    const received: CanonicalEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of run(h, adapter)) received.push(event);
    } catch (error) {
      caught = error;
    }

    // The consumer kept the bytes it already got...
    expect(received.map((e) => e.type)).toEqual(["message_start"]);
    // ...and then saw an error, rather than a silent truncation.
    expect(caught).toBeInstanceOf(BosandaError);
    expect((caught as BosandaError).code).toBe("upstream_incompatible");

    // THE ASSERTION THAT MATTERS: no second account was ever dialled.
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01"]);
    expect(h.attempts).toEqual([
      {
        accountId: "acct-01",
        attempt: 1,
        outcome: "failed",
        code: "upstream_incompatible",
        afterFirstByte: true,
      },
    ]);
  });

  it("holds even when other accounts are healthy and idle", async () => {
    const h = harness(8);
    const adapter = new FakeAdapter({
      behaviour: { "acct-01": { afterEvents: 2, error: retryable("late failure") } },
    });

    await expect(drain(run(h, adapter))).rejects.toThrow(BosandaError);
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01"]);
  });

  it("is not defeated by a retry that already happened: the latch is per-request", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter({
      behaviour: {
        // Pre-first-byte failure: retry allowed.
        "acct-01": retryable("cold failure"),
        // Then the replacement dies mid-stream: no third account.
        "acct-02": { afterEvents: 1, error: retryable("warm failure") },
      },
    });

    const received: CanonicalEvent[] = [];
    await expect(
      (async () => {
        for await (const event of run(h, adapter)) received.push(event);
      })(),
    ).rejects.toThrow(BosandaError);

    expect(received).toHaveLength(1);
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01", "acct-02"]);
  });

  it("releases the slot even when the failure is terminal mid-stream", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter({
      behaviour: { "acct-01": { afterEvents: 1, error: retryable("boom") } },
    });

    await expect(drain(run(h, adapter))).rejects.toThrow(BosandaError);
    expect(h.scheduler.activeCount("acct-01")).toBe(0);
  });

  it("releases the slot when the CONSUMER abandons the stream mid-iteration", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter();

    const stream = run(h, adapter);
    for await (const _event of stream) {
      break; // triggers generator .return() -> finally -> lease.release()
    }

    expect(h.scheduler.activeCount("acct-01")).toBe(0);
    expect(h.scheduler.totalActive()).toBe(0);
  });
});

describe("what is NOT retried", () => {
  it("does not retry a non-retryable code, even pre-first-byte", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter({
      behaviour: {
        "acct-01": new BosandaError("invalid_request", { internalDetail: "bad tool schema" }),
      },
    });

    await expect(drain(run(h, adapter))).rejects.toMatchObject({ code: "invalid_request" });
    // A client mistake is not fixed by another account.
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01"]);
  });

  it.each([
    ["invalid_request", false],
    ["authentication_error", false],
    ["rate_limit", false],
    ["quota_exhausted", false],
    ["concurrency_limit", false],
    ["unsupported_capability", false],
    ["model_not_allowed", false],
    ["adapter_disabled", false],
    ["upstream_incompatible", true],
    ["upstream_timeout", true],
  ] as ReadonlyArray<readonly [ErrorCode, boolean]>)(
    "code %s -> failover=%s matches isProviderRetryable",
    async (code, shouldRetry) => {
      const h = harness(3);
      const adapter = new FakeAdapter({
        behaviour: { "acct-01": new BosandaError(code, { internalDetail: "x" }) },
      });

      const result = await drain(run(h, adapter)).then(
        () => "ok" as const,
        () => "error" as const,
      );

      if (shouldRetry) {
        expect(result).toBe("ok");
        expect(adapter.calls.streamedAccounts).toEqual(["acct-01", "acct-02"]);
      } else {
        expect(result).toBe("error");
        expect(adapter.calls.streamedAccounts).toEqual(["acct-01"]);
      }
    },
  );

  it("respects the attempt cap and surfaces the LAST upstream error, not a generic one", async () => {
    const h = harness(6);
    const adapter = new FakeAdapter({
      behaviour: {
        "acct-01": retryable("down 1"),
        "acct-02": retryable("down 2"),
        "acct-03": retryable("down 3"),
        // acct-04 would have worked, but the cap of 3 stops us first.
      },
    });

    await expect(drain(run(h, adapter, { maxAttempts: 3 }))).rejects.toMatchObject({
      code: "upstream_incompatible",
      internalDetail: "down 3",
    });

    expect(adapter.calls.streamedAccounts).toHaveLength(3);
    expect(adapter.calls.streamedAccounts).not.toContain("acct-04");
  });

  it("defaults to a cap of 3 attempts", async () => {
    const h = harness(6);
    const adapter = new FakeAdapter({
      behaviour: {
        "acct-01": retryable("d"),
        "acct-02": retryable("d"),
        "acct-03": retryable("d"),
        "acct-04": retryable("d"),
      },
    });

    await expect(drain(run(h, adapter))).rejects.toThrow(BosandaError);
    expect(adapter.calls.streamedAccounts).toHaveLength(3);
  });

  it("stops retrying once the client aborts (§7 rule 6)", async () => {
    const h = harness(4);
    const controller = new AbortController();
    const adapter = new FakeAdapter({
      behaviour: { "acct-01": retryable("down"), "acct-02": retryable("down") },
    });

    // Abort as soon as the first attempt has failed.
    h.attempts.push = ((info: AttemptInfo) => {
      if (info.accountId === "acct-01") controller.abort(new Error("client hung up"));
      return 0;
    }) as typeof h.attempts.push;

    await expect(drain(run(h, adapter, { signal: controller.signal }))).rejects.toThrow();
    // acct-02 was never dialled: the abort ended the loop.
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01"]);
  });

  it("surfaces no_healthy_provider when the pool is exhausted with no attempt made", async () => {
    const h = harness(1);
    h.cooldowns.recordFailure("acct-01", retryable("cooling"));
    const adapter = new FakeAdapter();

    await expect(drain(run(h, adapter))).rejects.toMatchObject({
      code: "no_healthy_provider",
    });
    expect(adapter.calls.streamedAccounts).toEqual([]);
  });
});

describe("collectWithFailover", () => {
  it("shares the identical retry path", async () => {
    const h = harness(3);
    const adapter = new FakeAdapter({ behaviour: { "acct-01": retryable("down") } });
    const controller = new AbortController();

    const events = await collectWithFailover<CanonicalEvent>({
      scheduler: h.scheduler,
      cooldowns: h.cooldowns,
      breakers: h.breakers,
      clock: h.clock,
      pool: h.accounts,
      context: { model: "model-a" },
      signal: controller.signal,
      attempt: async (account, sink, signal) => {
        for await (const event of adapter.stream(request(), account.accountId, signal)) {
          await sink.emit(event);
        }
      },
    });

    expect(events).toHaveLength(3);
    expect(adapter.calls.streamedAccounts).toEqual(["acct-01", "acct-02"]);
    expect(h.scheduler.totalActive()).toBe(0);
  });
});
