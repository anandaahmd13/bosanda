/**
 * Per-account health tracking and §17 metrics emission.
 *
 * Two jobs:
 *  1. Keep a rolling success/failure/latency record per provider account so the
 *     admin dashboard can show "active request count, recent failures, cooldown,
 *     region, and profile" (PLAN.md §15 "Kiro provider pool").
 *  2. Emit the PLAN.md §17 metric set through the observability Registry.
 *
 * METRIC NAMES ARE NOT INVENTED HERE. `createRegistry()` pre-registers every
 * name and `registry.increment/setGauge/observe` throw on an unregistered one,
 * which is a deliberate guard against typo-created series. This module uses only
 * pre-registered names. Two gaps found while wiring it up are reported in the
 * final output rather than patched into the observability package:
 *   - no counter for provider failures by error code (nearest available:
 *     `bosanda_adapter_compat_errors_total`, which is narrower);
 *   - `bosanda_healthy_providers` is a single gauge with no model label, so it
 *     is reported pool-wide rather than per model.
 *
 * The `errorScore` is a decaying score, not a raw count: §7 uses it as the
 * second sort key, and a raw lifetime count would permanently penalize an
 * account that had one bad hour on its first day. Each failure adds 1 and the
 * score halves every `errorScoreHalfLifeMs`, so recent failures dominate.
 *
 * REDACTION (§16/§17): only IDs, codes, counts, and durations are stored. No
 * prompt text, response text, tool payload, credential, or upstream identity
 * ever enters this module. `detail` strings come from
 * `BosandaError.internalDetail`, which is operator-only and must never be
 * returned to a client.
 */

import type { Registry } from "@bosanda/observability";
import type { BosandaError } from "@bosanda/protocol";
import { secondsUntil, type Clock } from "@bosanda/shared";
import type { AccountHealth, AccountStatus, Persona } from "./types.js";
import { circuitStateValue, type CircuitBreakerRegistry } from "./circuit-breaker.js";
import type { CooldownRegistry } from "./cooldown.js";
import type { Scheduler } from "./scheduler.js";

export type HealthTrackerOptions = {
  clock: Clock;
  registry: Registry;
  cooldowns: CooldownRegistry;
  breakers: CircuitBreakerRegistry;
  scheduler: Scheduler;
  /** Half-life of the decaying error score. Default 5 minutes. */
  errorScoreHalfLifeMs?: number;
  /** Rolling latency samples kept per account. Default 50. */
  latencySamples?: number;
};

type Record_ = {
  accountId: string;
  region: string;
  persona: Persona;
  status: AccountStatus;
  successes: number;
  failures: number;
  /** Decaying score; see module comment. */
  errorScore: number;
  errorScoreAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastValidatedAt: Date | null;
  /** Most recent failure code, for the dashboard. Operator-only. */
  lastErrorCode: string | null;
  detail: string | undefined;
  ttfbMs: number[];
  durationMs: number[];
};

/** One row of the admin health table (§15). */
export type AccountHealthSnapshot = {
  accountId: string;
  status: AccountStatus;
  region: string;
  persona: Persona;
  activeRequests: number;
  successes: number;
  failures: number;
  errorScore: number;
  circuitState: "closed" | "open" | "half_open";
  cooldownUntil: Date | null;
  cooldownSecondsRemaining: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastValidatedAt: Date | null;
  /** Operator-only. Never send to a client. */
  lastErrorCode: string | null;
  detail: string | undefined;
  p50TtfbMs: number | null;
  p95TtfbMs: number | null;
  p50DurationMs: number | null;
};

const percentile = (samples: readonly number[], p: number): number | null => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? null;
};

const push = (samples: number[], value: number, cap: number): void => {
  samples.push(value);
  if (samples.length > cap) samples.shift();
};

export class HealthTracker {
  private readonly records = new Map<string, Record_>();
  private readonly clock: Clock;
  private readonly registry: Registry;
  private readonly cooldowns: CooldownRegistry;
  private readonly breakers: CircuitBreakerRegistry;
  private readonly scheduler: Scheduler;
  private readonly halfLifeMs: number;
  private readonly latencySamples: number;

  constructor(options: HealthTrackerOptions) {
    this.clock = options.clock;
    this.registry = options.registry;
    this.cooldowns = options.cooldowns;
    this.breakers = options.breakers;
    this.scheduler = options.scheduler;
    this.halfLifeMs = options.errorScoreHalfLifeMs ?? 5 * 60_000;
    this.latencySamples = options.latencySamples ?? 50;
  }

  /** Registers an account so it appears in snapshots before its first request. */
  track(account: {
    accountId: string;
    region: string;
    persona: Persona;
    status?: AccountStatus;
  }): void {
    if (this.records.has(account.accountId)) return;
    const now = this.clock.now();
    this.records.set(account.accountId, {
      accountId: account.accountId,
      region: account.region,
      persona: account.persona,
      status: account.status ?? "active",
      successes: 0,
      failures: 0,
      errorScore: 0,
      errorScoreAt: now,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastValidatedAt: null,
      lastErrorCode: null,
      detail: undefined,
      ttfbMs: [],
      durationMs: [],
    });
  }

  /**
   * Records a completed request.
   *
   * `ttfbMs` is optional because a request that failed before producing output
   * has no time-to-first-byte, and recording 0 would corrupt the histogram with
   * a fake fast sample.
   */
  recordSuccess(accountId: string, timing: { ttfbMs?: number; durationMs: number }): void {
    const record = this.ensure(accountId);
    const now = this.clock.now();
    record.successes += 1;
    record.lastSuccessAt = now;
    record.lastErrorCode = null;
    record.detail = undefined;
    this.decay(record, now);

    if (timing.ttfbMs !== undefined) {
      push(record.ttfbMs, timing.ttfbMs, this.latencySamples);
      this.registry.observe("bosanda_ttfb_ms", timing.ttfbMs, {
        provider_account: accountId,
      });
    }
    push(record.durationMs, timing.durationMs, this.latencySamples);
    this.registry.observe("bosanda_duration_ms", timing.durationMs, {
      provider_account: accountId,
    });
  }

  recordFailure(accountId: string, error: BosandaError, timing?: { durationMs: number }): void {
    const record = this.ensure(accountId);
    const now = this.clock.now();
    this.decay(record, now);
    record.failures += 1;
    record.errorScore += 1;
    record.lastFailureAt = now;
    record.lastErrorCode = error.code;
    record.detail = error.internalDetail;

    // §7: auth/revocation errors disable the account until admin action.
    if (error.code === "authentication_error") {
      record.status = "credential_invalid";
    }

    if (timing !== undefined) {
      this.registry.observe("bosanda_duration_ms", timing.durationMs, {
        provider_account: accountId,
      });
    }

    // Closest pre-registered counter for an upstream-compatibility failure.
    if (error.code === "upstream_incompatible") {
      this.registry.increment("bosanda_adapter_compat_errors_total", {
        provider_account: accountId,
      });
    }
  }

  /** Counts one upstream attempt (§17 "upstream attempts and retries"). */
  recordAttempt(accountId: string): void {
    this.registry.increment("bosanda_upstream_attempts_total", {
      provider_account: accountId,
    });
  }

  /** Counts one failover onto another account. */
  recordRetry(accountId: string): void {
    this.registry.increment("bosanda_upstream_retries_total", {
      provider_account: accountId,
    });
  }

  recordValidation(accountId: string, health: AccountHealth): void {
    const record = this.ensure(accountId);
    record.status = health.status;
    record.region = health.region;
    record.persona = health.persona;
    record.lastValidatedAt = health.lastValidatedAt ?? this.clock.now();
    record.detail = health.detail;
  }

  setStatus(accountId: string, status: AccountStatus): void {
    this.ensure(accountId).status = status;
  }

  /**
   * Publishes the current gauges (§17: active requests per provider account,
   * cooldown, circuit state, healthy provider count).
   *
   * Called on a timer by the worker and after routing decisions. Gauges are
   * point-in-time, so they are pushed rather than accumulated.
   */
  publishGauges(): void {
    const now = this.clock.now();
    let healthy = 0;

    for (const record of this.records.values()) {
      const accountId = record.accountId;
      const labels = { provider_account: accountId };

      this.registry.setGauge(
        "bosanda_active_requests",
        this.scheduler.activeCount(accountId),
        labels,
      );

      const cooldown = this.cooldowns.stateOf(accountId, now);
      this.registry.setGauge(
        "bosanda_provider_cooldown_seconds",
        cooldown ? cooldown.secondsRemaining : 0,
        labels,
      );

      const state = this.breakers.stateOf(accountId, now);
      this.registry.setGauge("bosanda_provider_circuit_state", circuitStateValue(state), labels);

      const eligible = record.status === "active" && cooldown === undefined && state !== "open";
      if (eligible) healthy += 1;
    }

    // Pool-wide: the pre-registered gauge carries no model label.
    this.registry.setGauge("bosanda_healthy_providers", healthy);
  }

  /** One account's dashboard row. */
  snapshot(accountId: string): AccountHealthSnapshot {
    const record = this.ensure(accountId);
    const now = this.clock.now();
    this.decay(record, now);
    const cooldown = this.cooldowns.stateOf(accountId, now);

    return {
      accountId,
      status: record.status,
      region: record.region,
      persona: record.persona,
      activeRequests: this.scheduler.activeCount(accountId),
      successes: record.successes,
      failures: record.failures,
      // Rounded: the raw float is noise in a dashboard.
      errorScore: Math.round(record.errorScore * 1000) / 1000,
      circuitState: this.breakers.stateOf(accountId, now),
      cooldownUntil: cooldown?.until ?? null,
      cooldownSecondsRemaining: cooldown ? secondsUntil(cooldown.until, now) : 0,
      lastSuccessAt: record.lastSuccessAt,
      lastFailureAt: record.lastFailureAt,
      lastValidatedAt: record.lastValidatedAt,
      lastErrorCode: record.lastErrorCode,
      detail: record.detail,
      p50TtfbMs: percentile(record.ttfbMs, 50),
      p95TtfbMs: percentile(record.ttfbMs, 95),
      p50DurationMs: percentile(record.durationMs, 50),
    };
  }

  /** Whole-pool view for the admin dashboard (§15), stable by account ID. */
  snapshotAll(): AccountHealthSnapshot[] {
    return [...this.records.keys()].sort().map((accountId) => this.snapshot(accountId));
  }

  /**
   * The decaying error score the scheduler sorts on (§7 sort key 2). Callers
   * building `AccountHealth` should copy this in rather than counting failures.
   */
  errorScore(accountId: string): number {
    const record = this.records.get(accountId);
    if (!record) return 0;
    this.decay(record, this.clock.now());
    return record.errorScore;
  }

  private ensure(accountId: string): Record_ {
    const existing = this.records.get(accountId);
    if (existing) return existing;
    // Unknown account: create a placeholder rather than throwing. A metrics
    // path must never be the thing that fails a request.
    this.track({ accountId, region: "unknown", persona: "cli" });
    const created = this.records.get(accountId);
    if (!created) throw new Error("unreachable: record not created");
    return created;
  }

  /** Applies exponential decay to the error score. */
  private decay(record: Record_, now: Date): void {
    const elapsed = now.getTime() - record.errorScoreAt.getTime();
    if (elapsed <= 0) return;
    record.errorScore *= Math.pow(0.5, elapsed / this.halfLifeMs);
    if (record.errorScore < 0.001) record.errorScore = 0;
    record.errorScoreAt = now;
  }
}
