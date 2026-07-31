/**
 * Health tracking and metrics tests — PLAN.md §15 (admin provider pool table),
 * §17 (metrics), §7 (error score as sort key 2).
 *
 * Every metric assertion reads back through the Registry, which throws on an
 * unregistered name. That is the guard: if this module ever invents a series,
 * these tests fail rather than silently creating a typo'd metric.
 */

import { describe, expect, it } from "vitest";
import { createRegistry } from "@bosanda/observability";
import { BosandaError } from "@bosanda/protocol";
import type { ErrorCode } from "@bosanda/protocol";
import {
  CircuitBreakerRegistry,
  CooldownRegistry,
  HealthTracker,
  Scheduler,
} from "@bosanda/provider-core";
import { account, controllableClock, noJitter } from "./fake-adapter.js";

function harness() {
  const clock = controllableClock();
  const registry = createRegistry();
  // noJitter pins the backoff multiplier to 1.0 so cooldown seconds are exact.
  const cooldowns = new CooldownRegistry({ clock, random: noJitter });
  const breakers = new CircuitBreakerRegistry({ clock, failureThreshold: 2, openMs: 30_000 });
  const scheduler = new Scheduler({ clock, cooldowns, breakers });
  const health = new HealthTracker({ clock, registry, cooldowns, breakers, scheduler });
  return { clock, registry, cooldowns, breakers, scheduler, health };
}

const boom = (code: ErrorCode = "upstream_incompatible") =>
  new BosandaError(code, { internalDetail: "operator-only detail" });

/** A rate limit carrying an upstream retry-after, which drives cooldown length. */
const retryAfter = (seconds: number) =>
  new BosandaError("rate_limit", {
    internalDetail: "operator-only detail",
    retryAfterSeconds: seconds,
  });

describe("recording outcomes", () => {
  it("counts successes and failures per account", () => {
    const { health } = harness();
    health.track({ accountId: "a", region: "us-east-1", persona: "cli" });

    health.recordSuccess("a", { ttfbMs: 120, durationMs: 900 });
    health.recordSuccess("a", { ttfbMs: 140, durationMs: 1100 });
    health.recordFailure("a", boom());

    const snapshot = health.snapshot("a");
    expect(snapshot.successes).toBe(2);
    expect(snapshot.failures).toBe(1);
    expect(snapshot.lastErrorCode).toBe("upstream_incompatible");
  });

  it("summarizes latency as percentiles for the dashboard", () => {
    const { health } = harness();
    for (const ttfb of [100, 200, 300, 400, 500]) {
      health.recordSuccess("a", { ttfbMs: ttfb, durationMs: ttfb * 5 });
    }

    const snapshot = health.snapshot("a");
    expect(snapshot.p50TtfbMs).toBe(300);
    expect(snapshot.p95TtfbMs).toBe(500);
    expect(snapshot.p50DurationMs).toBe(1500);
  });

  it("omits TTFB when the request produced no output, rather than logging a fake 0", () => {
    const { health, registry } = harness();
    health.recordSuccess("a", { durationMs: 400 });

    expect(health.snapshot("a").p50TtfbMs).toBeNull();
    expect(registry.readHistogram("bosanda_ttfb_ms", { provider_account: "a" })).toBeUndefined();
    expect(registry.readHistogram("bosanda_duration_ms", { provider_account: "a" })).toEqual({
      sum: 400,
      count: 1,
    });
  });

  it("a success clears the stale error code so the dashboard is not misleading", () => {
    const { health } = harness();
    health.recordFailure("a", boom());
    expect(health.snapshot("a").lastErrorCode).toBe("upstream_incompatible");

    health.recordSuccess("a", { ttfbMs: 90, durationMs: 500 });
    expect(health.snapshot("a").lastErrorCode).toBeNull();
    expect(health.snapshot("a").detail).toBeUndefined();
  });

  it("an auth failure marks the account credential_invalid (§7: until admin action)", () => {
    const { health, clock } = harness();
    health.recordFailure("a", boom("authentication_error"));
    expect(health.snapshot("a").status).toBe("credential_invalid");

    // It does NOT self-heal with time — only an admin re-validation clears it.
    clock.advance(60 * 60_000);
    expect(health.snapshot("a").status).toBe("credential_invalid");
  });

  it("other failure codes leave the status active", () => {
    const { health } = harness();
    health.recordFailure("a", boom("upstream_timeout"));
    expect(health.snapshot("a").status).toBe("active");
  });

  it("recordValidation refreshes status, region, persona, and timestamp", () => {
    const { health, clock } = harness();
    health.track({ accountId: "a", region: "unknown", persona: "cli" });
    const validatedAt = clock.now();

    health.recordValidation("a", {
      accountId: "a",
      status: "active",
      cooldownUntil: null,
      lastValidatedAt: validatedAt,
      errorScore: 0,
      activeRequests: 0,
      region: "eu-west-1",
      persona: "ide",
    });

    const snapshot = health.snapshot("a");
    expect(snapshot.region).toBe("eu-west-1");
    expect(snapshot.persona).toBe("ide");
    expect(snapshot.lastValidatedAt?.getTime()).toBe(validatedAt.getTime());
  });
});

describe("decaying error score (§7 sort key 2)", () => {
  it("adds 1 per failure", () => {
    const { health } = harness();
    health.recordFailure("a", boom());
    health.recordFailure("a", boom());
    expect(health.errorScore("a")).toBeCloseTo(2, 5);
  });

  it("halves every half-life, so an old bad hour stops penalizing the account", () => {
    const { clock, health } = harness();
    health.recordFailure("a", boom());
    health.recordFailure("a", boom());
    health.recordFailure("a", boom());
    health.recordFailure("a", boom());

    clock.advance(5 * 60_000); // one half-life
    expect(health.errorScore("a")).toBeCloseTo(2, 3);

    clock.advance(5 * 60_000);
    expect(health.errorScore("a")).toBeCloseTo(1, 3);
  });

  it("reaches exactly 0 eventually, not a lingering epsilon", () => {
    const { clock, health } = harness();
    health.recordFailure("a", boom());
    clock.advance(60 * 60_000);
    expect(health.errorScore("a")).toBe(0);
  });

  it("returns 0 for an account that was never seen", () => {
    const { health } = harness();
    expect(health.errorScore("never-seen")).toBe(0);
  });
});

describe("§17 gauges — pre-registered names only", () => {
  it("publishes active requests, cooldown seconds, and circuit state per account", () => {
    const { clock, registry, cooldowns, breakers, scheduler, health } = harness();
    const accounts = [account("a"), account("b")];
    for (const a of accounts)
      health.track({ accountId: a.accountId, region: "us-east-1", persona: "cli" });

    const lease = scheduler.reserve("a");
    cooldowns.recordFailure("b", retryAfter(60));
    breakers.recordFailure("b", boom(), clock.now());
    breakers.recordFailure("b", boom(), clock.now());

    health.publishGauges();

    expect(registry.read("bosanda_active_requests", { provider_account: "a" })).toBe(1);
    expect(registry.read("bosanda_active_requests", { provider_account: "b" })).toBe(0);
    expect(registry.read("bosanda_provider_cooldown_seconds", { provider_account: "a" })).toBe(0);
    expect(registry.read("bosanda_provider_cooldown_seconds", { provider_account: "b" })).toBe(60);
    // 0 closed, 1 half-open, 2 open.
    expect(registry.read("bosanda_provider_circuit_state", { provider_account: "a" })).toBe(0);
    expect(registry.read("bosanda_provider_circuit_state", { provider_account: "b" })).toBe(2);

    lease.release();
  });

  it("bosanda_healthy_providers counts only routable accounts", () => {
    const { clock, registry, cooldowns, breakers, health } = harness();
    for (const id of ["a", "b", "c", "d"]) {
      health.track({ accountId: id, region: "us-east-1", persona: "cli" });
    }

    cooldowns.recordFailure("b", boom());
    breakers.recordFailure("c", boom(), clock.now());
    breakers.recordFailure("c", boom(), clock.now());
    health.recordFailure("d", boom("authentication_error"));

    health.publishGauges();
    // Only "a" is active, uncooled, and closed.
    expect(registry.read("bosanda_healthy_providers")).toBe(1);
  });

  it("healthy count recovers as cooldowns and breakers expire", () => {
    const { clock, registry, cooldowns, health } = harness();
    for (const id of ["a", "b"]) {
      health.track({ accountId: id, region: "us-east-1", persona: "cli" });
    }
    cooldowns.recordFailure("b", boom());

    health.publishGauges();
    expect(registry.read("bosanda_healthy_providers")).toBe(1);

    clock.advance(30_000);
    health.publishGauges();
    expect(registry.read("bosanda_healthy_providers")).toBe(2);
  });

  it("counts upstream attempts and retries (§17)", () => {
    const { registry, health } = harness();
    health.recordAttempt("a");
    health.recordAttempt("a");
    health.recordAttempt("b");
    health.recordRetry("a");

    expect(registry.read("bosanda_upstream_attempts_total", { provider_account: "a" })).toBe(2);
    expect(registry.read("bosanda_upstream_attempts_total", { provider_account: "b" })).toBe(1);
    expect(registry.read("bosanda_upstream_retries_total", { provider_account: "a" })).toBe(1);
  });

  it("counts adapter compatibility errors on upstream_incompatible", () => {
    const { registry, health } = harness();
    health.recordFailure("a", boom("upstream_incompatible"));
    health.recordFailure("a", boom("upstream_timeout"));

    // Only the incompatibility increments this counter; the timeout does not.
    expect(registry.read("bosanda_adapter_compat_errors_total", { provider_account: "a" })).toBe(1);
  });

  it("every emitted series survives render(), proving each name is registered", () => {
    const { registry, health } = harness();
    health.track({ accountId: "a", region: "us-east-1", persona: "cli" });
    health.recordAttempt("a");
    health.recordRetry("a");
    health.recordSuccess("a", { ttfbMs: 100, durationMs: 800 });
    health.recordFailure("a", boom());
    health.publishGauges();

    const rendered = registry.render();
    for (const name of [
      "bosanda_upstream_attempts_total",
      "bosanda_upstream_retries_total",
      "bosanda_adapter_compat_errors_total",
      "bosanda_active_requests",
      "bosanda_provider_cooldown_seconds",
      "bosanda_provider_circuit_state",
      "bosanda_healthy_providers",
      "bosanda_ttfb_ms",
      "bosanda_duration_ms",
    ]) {
      expect(rendered).toContain(name);
    }
  });
});

describe("dashboard snapshot (§15)", () => {
  it("exposes the fields the provider pool table needs", () => {
    const { clock, cooldowns, scheduler, health } = harness();
    health.track({ accountId: "a", region: "ap-southeast-1", persona: "ide" });
    const lease = scheduler.reserve("a");
    cooldowns.recordFailure("a", retryAfter(45));
    health.recordFailure("a", boom(), { durationMs: 300 });

    const snapshot = health.snapshot("a");
    expect(snapshot).toMatchObject({
      accountId: "a",
      region: "ap-southeast-1",
      persona: "ide",
      activeRequests: 1,
      failures: 1,
      cooldownSecondsRemaining: 45,
    });
    expect(snapshot.cooldownUntil?.getTime()).toBe(clock.now().getTime() + 45_000);
    lease.release();
  });

  it("snapshotAll is sorted by account ID for a stable table", () => {
    const { health } = harness();
    for (const id of ["c", "a", "b"]) {
      health.track({ accountId: id, region: "us-east-1", persona: "cli" });
    }
    expect(health.snapshotAll().map((row) => row.accountId)).toEqual(["a", "b", "c"]);
  });

  it("keeps only operator-safe fields: no prompt, response, or credential data", () => {
    const { health } = harness();
    health.recordFailure("a", boom());
    const snapshot = health.snapshot("a");

    // detail comes from internalDetail, which the caller must not forward to a
    // client; everything else is IDs, counts, and durations.
    expect(snapshot.detail).toBe("operator-only detail");
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "accountId",
        "activeRequests",
        "circuitState",
        "cooldownSecondsRemaining",
        "cooldownUntil",
        "detail",
        "errorScore",
        "failures",
        "lastErrorCode",
        "lastFailureAt",
        "lastSuccessAt",
        "lastValidatedAt",
        "p50DurationMs",
        "p50TtfbMs",
        "p95TtfbMs",
        "persona",
        "region",
        "status",
        "successes",
      ].sort(),
    );
  });

  it("an unknown account produces a placeholder rather than throwing", () => {
    const { health } = harness();
    // A metrics path must never be the thing that fails a request.
    expect(() => health.recordAttempt("ghost")).not.toThrow();
    expect(health.snapshot("ghost").region).toBe("unknown");
  });

  it("setStatus lets the admin disable an account", () => {
    const { health } = harness();
    health.track({ accountId: "a", region: "us-east-1", persona: "cli" });
    health.setStatus("a", "disabled");
    expect(health.snapshot("a").status).toBe("disabled");
  });
});
