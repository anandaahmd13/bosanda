/**
 * Circuit breaker tests — PLAN.md §7 "Circuit breaker", §3 (automatic circuit
 * opening), §19 ("Circuit open/half-open/closed behavior").
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import {
  CircuitBreakerRegistry,
  CooldownRegistry,
  Scheduler,
  circuitStateValue,
} from "@bosanda/provider-core";
import { account, controllableClock } from "./fake-adapter.js";

const incompatible = () =>
  new BosandaError("upstream_incompatible", { internalDetail: "bad frame" });

const build = (
  options: {
    failureThreshold?: number;
    failureWindowMs?: number;
    openMs?: number;
    halfOpenMaxTrials?: number;
  } = {},
) => {
  const clock = controllableClock();
  const breakers = new CircuitBreakerRegistry({
    clock,
    failureThreshold: options.failureThreshold ?? 3,
    failureWindowMs: options.failureWindowMs ?? 60_000,
    openMs: options.openMs ?? 30_000,
    halfOpenMaxTrials: options.halfOpenMaxTrials ?? 1,
  });
  return { clock, breakers };
};

describe("CircuitBreakerRegistry state machine (§7)", () => {
  it("starts closed and allows requests", () => {
    const { breakers } = build();
    expect(breakers.stateOf("acct-01")).toBe("closed");
    expect(breakers.allowsRequest("acct-01")).toBe(true);
  });

  it("opens after the consecutive failure threshold", () => {
    const { breakers } = build({ failureThreshold: 3 });

    expect(breakers.recordFailure("acct-01", incompatible())).toBe("closed");
    expect(breakers.recordFailure("acct-01", incompatible())).toBe("closed");
    expect(breakers.recordFailure("acct-01", incompatible())).toBe("open");

    expect(breakers.stateOf("acct-01")).toBe("open");
    expect(breakers.allowsRequest("acct-01")).toBe(false);
    expect(breakers.snapshot("acct-01").reason).toContain("3 consecutive failures");
  });

  it("a success resets the consecutive counter, so the threshold is truly consecutive", () => {
    const { breakers } = build({ failureThreshold: 3 });
    breakers.recordFailure("acct-01", incompatible());
    breakers.recordFailure("acct-01", incompatible());
    breakers.recordSuccess("acct-01");

    // Two more failures must NOT open it — the streak was broken.
    breakers.recordFailure("acct-01", incompatible());
    breakers.recordFailure("acct-01", incompatible());
    expect(breakers.stateOf("acct-01")).toBe("closed");
  });

  it("failures spread beyond the window do not accumulate", () => {
    const { clock, breakers } = build({ failureThreshold: 3, failureWindowMs: 10_000 });
    breakers.recordFailure("acct-01", incompatible());
    breakers.recordFailure("acct-01", incompatible());

    // Next failure lands outside the window: a new burst begins at 1.
    clock.advance(10_001);
    expect(breakers.recordFailure("acct-01", incompatible())).toBe("closed");
    expect(breakers.snapshot("acct-01").consecutiveFailures).toBe(1);
  });

  it("becomes half-open after openMs and admits a trial", () => {
    const { clock, breakers } = build({ failureThreshold: 1, openMs: 30_000 });
    breakers.recordFailure("acct-01", incompatible());
    expect(breakers.stateOf("acct-01")).toBe("open");

    clock.advance(29_999);
    expect(breakers.stateOf("acct-01")).toBe("open");
    expect(breakers.allowsRequest("acct-01")).toBe(false);

    clock.advance(1);
    expect(breakers.stateOf("acct-01")).toBe("half_open");
    expect(breakers.allowsRequest("acct-01")).toBe(true);
  });

  it("half-open trial SUCCEEDS -> closed", () => {
    const { clock, breakers } = build({ failureThreshold: 1, openMs: 30_000 });
    breakers.recordFailure("acct-01", incompatible());
    clock.advance(30_000);
    expect(breakers.stateOf("acct-01")).toBe("half_open");

    expect(breakers.tryAcquireTrial("acct-01")).toBe(true);
    breakers.recordSuccess("acct-01");

    expect(breakers.stateOf("acct-01")).toBe("closed");
    expect(breakers.snapshot("acct-01").reason).toContain("half-open trial succeeded");
  });

  it("half-open trial FAILS -> open again immediately, with a fresh window", () => {
    const { clock, breakers } = build({ failureThreshold: 3, openMs: 30_000 });
    for (let i = 0; i < 3; i += 1) breakers.recordFailure("acct-01", incompatible());
    clock.advance(30_000);
    expect(breakers.stateOf("acct-01")).toBe("half_open");

    breakers.tryAcquireTrial("acct-01");
    // A single failure re-opens; it does not need the threshold again.
    expect(breakers.recordFailure("acct-01", incompatible())).toBe("open");
    expect(breakers.snapshot("acct-01").reason).toContain("half-open trial failed");

    // The full open window restarts from now.
    clock.advance(29_999);
    expect(breakers.stateOf("acct-01")).toBe("open");
    clock.advance(1);
    expect(breakers.stateOf("acct-01")).toBe("half_open");
  });

  it("half-open admits only halfOpenMaxTrials concurrent probes (§7)", () => {
    const { clock, breakers } = build({
      failureThreshold: 1,
      openMs: 30_000,
      halfOpenMaxTrials: 2,
    });
    breakers.recordFailure("acct-01", incompatible());
    clock.advance(30_000);

    expect(breakers.tryAcquireTrial("acct-01")).toBe(true);
    expect(breakers.tryAcquireTrial("acct-01")).toBe(true);
    // Third concurrent probe refused: a recovering upstream is not flooded.
    expect(breakers.tryAcquireTrial("acct-01")).toBe(false);

    breakers.releaseTrial("acct-01");
    expect(breakers.tryAcquireTrial("acct-01")).toBe(true);
  });

  it("reopensAt reports when the next trial is allowed", () => {
    const { clock, breakers } = build({ failureThreshold: 1, openMs: 30_000 });
    const at = clock.now();
    breakers.recordFailure("acct-01", incompatible());
    expect(breakers.reopensAt("acct-01")?.getTime()).toBe(at.getTime() + 30_000);

    clock.advance(30_000);
    // Half-open: nothing to wait for.
    expect(breakers.reopensAt("acct-01")).toBeNull();
  });

  it("maps state to the §17 gauge encoding", () => {
    expect(circuitStateValue("closed")).toBe(0);
    expect(circuitStateValue("half_open")).toBe(1);
    expect(circuitStateValue("open")).toBe(2);
  });

  it("reset() is an operator override back to closed", () => {
    const { breakers } = build({ failureThreshold: 1 });
    breakers.recordFailure("acct-01", incompatible());
    expect(breakers.stateOf("acct-01")).toBe("open");
    breakers.reset("acct-01");
    expect(breakers.stateOf("acct-01")).toBe("closed");
  });
});

/**
 * The documented all-tripped behaviour (see the module header in
 * circuit-breaker.ts): the breaker must never permanently open the whole pool.
 * `open` is time-bounded, so a total outage self-heals without operator action.
 */
describe("all accounts tripped — self-healing, never permanent", () => {
  const buildPool = () => {
    const clock = controllableClock();
    const cooldowns = new CooldownRegistry({ clock });
    const breakers = new CircuitBreakerRegistry({
      clock,
      failureThreshold: 1,
      openMs: 30_000,
      halfOpenMaxTrials: 1,
    });
    const scheduler = new Scheduler({ clock, cooldowns, breakers });
    const accounts = [account("a"), account("b"), account("c")];
    return { clock, cooldowns, breakers, scheduler, accounts };
  };

  it("while every breaker is open the pool yields no_healthy_provider (503)", () => {
    const { breakers, scheduler, accounts } = buildPool();
    for (const a of accounts) breakers.recordFailure(a.accountId, incompatible());

    try {
      scheduler.candidates(accounts, { model: "model-a" });
      expect.unreachable("expected no_healthy_provider");
    } catch (error) {
      const bosandaError = error as BosandaError;
      expect(bosandaError.code).toBe("no_healthy_provider");
      expect(bosandaError.status).toBe(503);
      expect(bosandaError.internalDetail).toContain("circuit_open=3");
    }
  });

  it("recovers with NO operator action once openMs elapses", () => {
    const { clock, breakers, scheduler, accounts } = buildPool();
    for (const a of accounts) breakers.recordFailure(a.accountId, incompatible());

    clock.advance(30_000);

    // Every account is half-open and offers a probe, so capacity is back.
    for (const a of accounts) {
      expect(breakers.stateOf(a.accountId)).toBe("half_open");
    }
    expect(
      scheduler
        .candidates(accounts, { model: "model-a" })
        .map((a) => a.accountId)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("one successful probe fully restores that account", () => {
    const { clock, breakers, scheduler, accounts } = buildPool();
    for (const a of accounts) breakers.recordFailure(a.accountId, incompatible());
    clock.advance(30_000);

    const lease = scheduler.reserveBest(accounts, { model: "model-a" });
    breakers.recordSuccess(lease.accountId);
    lease.release();

    expect(breakers.stateOf(lease.accountId)).toBe("closed");
  });

  it("a still-broken upstream re-opens every account rather than latching", () => {
    const { clock, breakers, scheduler, accounts } = buildPool();
    for (const a of accounts) breakers.recordFailure(a.accountId, incompatible());

    // Three failed recovery rounds.
    for (let round = 0; round < 3; round += 1) {
      clock.advance(30_000);
      for (const a of accounts) {
        expect(breakers.stateOf(a.accountId)).toBe("half_open");
        breakers.tryAcquireTrial(a.accountId);
        breakers.recordFailure(a.accountId, incompatible());
        expect(breakers.stateOf(a.accountId)).toBe("open");
      }
    }

    // Still not latched: the next window still offers probes.
    clock.advance(30_000);
    expect(scheduler.candidates(accounts, { model: "model-a" }).length).toBe(3);
  });

  it("only an auth failure marks an account credential_invalid (admin action)", () => {
    const { breakers, scheduler } = buildPool();
    // §7: auth/revocation disables until admin action — that is account STATUS,
    // not a breaker state, so the breaker itself stays non-latching.
    breakers.recordFailure(
      "a",
      new BosandaError("authentication_error", {
        internalDetail: "revoked",
      }),
    );
    const revoked = [account("a", { health: { status: "credential_invalid" } })];
    const { rejected } = scheduler.classify(revoked, { model: "model-a" });
    expect(rejected[0]?.reason).toBe("credential_invalid");
  });
});
