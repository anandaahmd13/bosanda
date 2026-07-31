/**
 * Cooldown tests — PLAN.md §7 (30s default, retry-after, escalation), §19
 * ("30-second default cooldown", "No disabled/cooldown account selected").
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { CircuitBreakerRegistry, CooldownRegistry, Scheduler } from "@bosanda/provider-core";
import { account, controllableClock, noJitter } from "./fake-adapter.js";

const build = () => {
  const clock = controllableClock();
  // noJitter keeps backoffMs at its full exponential value so the window is
  // exactly assertable; jitter itself is exercised separately below.
  const cooldowns = new CooldownRegistry({ clock, random: noJitter });
  return { clock, cooldowns };
};

const timeout = (retryAfterSeconds?: number) =>
  new BosandaError("upstream_timeout", {
    internalDetail: "upstream stalled",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

describe("CooldownRegistry (§7)", () => {
  it("a shouldCooldownProvider failure removes the account for exactly 30s", () => {
    const { clock, cooldowns } = build();
    const error = timeout();
    expect(error.shouldCooldownProvider).toBe(true);

    const state = cooldowns.recordFailure("acct-01", error);
    expect(state?.secondsRemaining).toBe(30);
    expect(cooldowns.isCoolingDown("acct-01")).toBe(true);

    // One millisecond before expiry: still cooling.
    clock.advance(29_999);
    expect(cooldowns.isCoolingDown("acct-01")).toBe(true);

    // Exactly at expiry: eligible again.
    clock.advance(1);
    expect(cooldowns.isCoolingDown("acct-01")).toBe(false);
    expect(cooldowns.stateOf("acct-01")).toBeUndefined();
  });

  it("a non-cooldown error does NOT remove the account", () => {
    const { cooldowns } = build();
    // invalid_request is the customer's fault; penalizing the account would let
    // one malformed client drain the pool.
    const error = new BosandaError("invalid_request", { internalDetail: "bad json" });
    expect(error.shouldCooldownProvider).toBe(false);

    expect(cooldowns.recordFailure("acct-01", error)).toBeUndefined();
    expect(cooldowns.isCoolingDown("acct-01")).toBe(false);
  });

  it("only the codes in shouldCooldownProvider trigger a cooldown", () => {
    const { cooldowns } = build();
    const cooling = ["upstream_incompatible", "upstream_timeout", "rate_limit"] as const;
    const notCooling = [
      "invalid_request",
      "authentication_error",
      "model_not_allowed",
      "quota_exhausted",
      "internal_error",
    ] as const;

    for (const code of cooling) {
      const registry = new CooldownRegistry({ clock: controllableClock(), random: noJitter });
      expect(
        registry.recordFailure("x", new BosandaError(code, { internalDetail: "t" })),
      ).toBeDefined();
    }
    for (const code of notCooling) {
      expect(
        cooldowns.recordFailure("y", new BosandaError(code, { internalDetail: "t" })),
      ).toBeUndefined();
    }
  });

  it("an upstream retry-after EXTENDS the cooldown beyond the default", () => {
    const { clock, cooldowns } = build();
    // 120s retry-after must win over the 30s default.
    const state = cooldowns.recordFailure("acct-01", timeout(120));
    expect(state?.secondsRemaining).toBe(120);
    expect(state?.reason).toContain("retry-after 120s");

    clock.advance(119_999);
    expect(cooldowns.isCoolingDown("acct-01")).toBe(true);
    clock.advance(1);
    expect(cooldowns.isCoolingDown("acct-01")).toBe(false);
  });

  it("a retry-after SHORTER than our floor does not shorten the cooldown", () => {
    const { cooldowns } = build();
    // A cooperative "retry-after: 1" must not put a broken account straight back.
    const state = cooldowns.recordFailure("acct-01", timeout(1));
    expect(state?.secondsRemaining).toBe(30);
  });

  it("escalates exponentially on repeated failures and caps at maxMs", () => {
    const clock = controllableClock();
    const cooldowns = new CooldownRegistry({
      clock,
      baseMs: 30_000,
      maxMs: 240_000,
      // Escalation decay is exercised in the next test. Widen it here so waiting
      // out a 240s cooldown does not also reset the strike counter, which is the
      // default behaviour (decayMs defaults to maxMs).
      escalationDecayMs: 60 * 60_000,
      random: noJitter,
    });

    const seconds: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const state = cooldowns.recordFailure("acct-01", timeout());
      seconds.push(state?.secondsRemaining ?? -1);
      // Advance past the cooldown but stay inside the escalation window.
      clock.advance((state?.secondsRemaining ?? 0) * 1000 + 1);
    }

    // 30 -> 60 -> 120 -> 240 -> capped at 240.
    expect(seconds).toEqual([30, 60, 120, 240, 240]);
  });

  it("escalation DECAYS: a long-quiet account is not treated as a repeat offender", () => {
    const clock = controllableClock();
    const cooldowns = new CooldownRegistry({
      clock,
      baseMs: 30_000,
      maxMs: 240_000,
      escalationDecayMs: 60_000,
      random: noJitter,
    });

    expect(cooldowns.recordFailure("acct-01", timeout())?.strikes).toBe(1);
    clock.advance(30_001);
    expect(cooldowns.recordFailure("acct-01", timeout())?.strikes).toBe(2);

    // Quiet for longer than the decay window: back to strike 1 and the 30s base.
    clock.advance(120_000);
    const state = cooldowns.recordFailure("acct-01", timeout());
    expect(state?.strikes).toBe(1);
    expect(state?.secondsRemaining).toBe(30);
  });

  it("jitter keeps the cooldown inside the documented half-to-full band", () => {
    const clock = controllableClock();
    // random()=0.5 => backoffMs multiplies by 0.5 + 0.5*0.5 = 0.75.
    const cooldowns = new CooldownRegistry({ clock, baseMs: 40_000, random: () => 0.5 });
    const state = cooldowns.recordFailure("acct-01", timeout());
    expect(state?.secondsRemaining).toBe(30);
  });

  it("a second, milder failure never shortens an active longer cooldown", () => {
    const { cooldowns } = build();
    cooldowns.recordFailure("acct-01", timeout(300));
    const before = cooldowns.stateOf("acct-01")?.until.getTime();

    // Concurrent request fails on the same account with no retry-after.
    cooldowns.recordFailure("acct-01", timeout());
    const after = cooldowns.stateOf("acct-01")?.until.getTime();

    expect(after).toBe(before);
  });

  it("recordSuccess clears both the penalty and the escalation history", () => {
    const { clock, cooldowns } = build();
    cooldowns.recordFailure("acct-01", timeout());
    cooldowns.recordSuccess("acct-01");
    expect(cooldowns.isCoolingDown("acct-01")).toBe(false);

    clock.advance(1000);
    // Next failure starts from the base again, not escalated.
    expect(cooldowns.recordFailure("acct-01", timeout())?.secondsRemaining).toBe(30);
  });

  it("clear() ends the penalty but keeps strike history by default", () => {
    const { clock, cooldowns } = build();
    cooldowns.recordFailure("acct-01", timeout());
    cooldowns.clear("acct-01");
    expect(cooldowns.isCoolingDown("acct-01")).toBe(false);

    clock.advance(1000);
    // Still a repeat offence: escalated to 60s, so manually clearing a flapping
    // account cannot be used to escape escalation.
    expect(cooldowns.recordFailure("acct-01", timeout())?.secondsRemaining).toBe(60);
  });

  it("active() lists only accounts still cooling, for the admin dashboard (§15)", () => {
    const { clock, cooldowns } = build();
    cooldowns.recordFailure("short", timeout());
    cooldowns.recordFailure("long", timeout(300));

    expect(
      cooldowns
        .active()
        .map((s) => s.accountId)
        .sort(),
    ).toEqual(["long", "short"]);
    clock.advance(31_000);
    expect(cooldowns.active().map((s) => s.accountId)).toEqual(["long"]);
  });
});

describe("Cooldown integration with selection (§19)", () => {
  it("a cooling account is skipped, then returns after the window", () => {
    const clock = controllableClock();
    const cooldowns = new CooldownRegistry({ clock, random: noJitter });
    const breakers = new CircuitBreakerRegistry({ clock });
    const scheduler = new Scheduler({ clock, cooldowns, breakers });
    const accounts = [account("acct-01"), account("acct-02")];

    cooldowns.recordFailure("acct-01", timeout());
    expect(scheduler.candidates(accounts, { model: "model-a" }).map((a) => a.accountId)).toEqual([
      "acct-02",
    ]);

    clock.advance(30_000);
    expect(
      scheduler
        .candidates(accounts, { model: "model-a" })
        .map((a) => a.accountId)
        .sort(),
    ).toEqual(["acct-01", "acct-02"]);
  });
});
