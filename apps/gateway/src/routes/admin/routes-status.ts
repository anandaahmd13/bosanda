/**
 * The operator dashboard and the operator health report (PLAN.md §15, §3, §13).
 *
 * ── WHY `GET /admin/v1/health` IS NOT THE PUBLIC HEALTH CHECK ──────────────
 * `/health` is the load balancer's probe: unauthenticated, and it says as little as
 * possible. This route is the operator's diagnostic view and reports how many provider
 * accounts hold an invalid credential, how far behind reconciliation is, and which
 * components are degraded — an inventory of exactly where the system is weak. It requires
 * an admin session for the same reason the rest of this surface does, and it lives under
 * `/admin/v1` so the distinction is visible in the URL rather than resting on a comment.
 *
 * ── EVERY NUMBER HERE IS PROCESS-LOCAL OR DATABASE-WIDE, NEVER A MIX ──────
 * `activeStreams` comes from the in-process registry: it counts what THIS gateway is
 * streaming, and no other replica's streams are visible. Request counts, latency
 * percentiles, weighted tokens, and revenue come from `usage_events` and `orders`, so they
 * are fleet-wide. The two are not combined into a single derived figure — an error rate
 * mixing one replica's numerator with the fleet's denominator would be meaningless.
 */

import type { FastifyInstance } from "fastify";
import type { AdminDeps } from "./deps.js";
import { iso, isoOrNull, readInt, readQuery } from "./contract.js";
import { requireAdmin } from "./session.js";

/** The default dashboard window: one hour, in seconds. */
const DEFAULT_WINDOW_SECONDS = 3_600;

/** A day. Beyond this the series would be too coarse to read and the scan too wide. */
const MAX_WINDOW_SECONDS = 86_400;

/** Roughly 60 buckets across the window, so the chart has usable resolution at any span. */
const TARGET_BUCKETS = 60;

export function registerStatusRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /**
   * The dashboard (§15).
   *
   * `windowSeconds` is accepted as a query parameter even though the client does not send
   * one: the default is one hour, and an operator investigating an incident can widen it
   * by hand. It is validated like every other parameter rather than clamped.
   */
  app.get("/admin/v1/overview", async (request, reply) => {
    await requireAdmin(request, deps);
    const query = readQuery(request.query, ["windowSeconds"]);
    const windowSeconds = readInt(
      query,
      "windowSeconds",
      DEFAULT_WINDOW_SECONDS,
      60,
      MAX_WINDOW_SECONDS,
    );

    const to = deps.clock.now();
    const from = new Date(to.getTime() - windowSeconds * 1000);
    const bucketSeconds = Math.max(60, Math.floor(windowSeconds / TARGET_BUCKETS));

    const [traffic, series, revenueIdr, accounts, switches] = await Promise.all([
      deps.traffic.window(from, to),
      deps.traffic.series(from, to, bucketSeconds),
      deps.traffic.revenueIdr(from, to),
      deps.providerAccounts.listByType(PROVIDER_TYPE),
      deps.killSwitches(),
    ]);

    const healthyAccounts = accounts.filter((account) => account.status === "active").length;

    return reply.status(200).send({
      metrics: {
        windowSeconds,
        requestCount: traffic.requestCount,
        errorCount: traffic.errorCount,
        /**
         * Guarded against 0/0.
         *
         * The client's schema is `z.number().min(0).max(1)`, and NaN fails it — an idle
         * window would otherwise take the whole dashboard down rather than showing zero.
         */
        errorRate:
          traffic.requestCount === 0 ? 0 : Math.min(1, traffic.errorCount / traffic.requestCount),
        latencyMs: {
          p50: traffic.latencyMs.p50,
          p95: traffic.latencyMs.p95,
          p99: traffic.latencyMs.p99,
        },
        weightedTokensServed: traffic.weightedTokens,
        // Process-local. See the module header.
        activeStreams: deps.activeStreams(),
        revenueIdr,
        healthyAccounts,
        totalAccounts: accounts.length,
      },
      series: series.map((bucket) => ({
        at: iso(bucket.at),
        requests: bucket.requests,
        errors: bucket.errors,
        weightedTokens: bucket.weightedTokens,
      })),
      killSwitchSummary: {
        adapterEnabled: switches.adapterEnabled,
        // Env-only; `KillSwitches` does not carry it. §3 keeps it false until M0 passes.
        kiroDirectEnabled: deps.env.KIRO_DIRECT_ENABLED,
        openaiCodexRuntimeEnabled: deps.env.OPENAI_CODEX_RUNTIME_ENABLED,
        openaiCodexCommercialEnabled: deps.env.OPENAI_CODEX_COMMERCIAL_ENABLED,
        toolUseEnabled: switches.toolUseEnabled,
        /**
         * Counts, not lists.
         *
         * These are the deny sets `killSwitchesFrom` resolved, which is why the flags
         * route does not expose region/model gates as booleans: a set is not a toggle. The
         * count is what tells an operator "something is gated" so they can look.
         */
        disabledRegionCount: switches.disabledRegions.size,
        disabledModelCount: switches.disabledModels.size,
        disabledAccountCount: switches.disabledAccounts.size,
      },
    });
  });

  /**
   * The operator health report (§13 reconciliation, §6 pool state).
   *
   * The database check is a real query rather than a cached flag: "can this process reach
   * PostgreSQL right now" is the question, and a stale answer is worse than none. Its
   * failure is caught and reported as a `down` component instead of throwing, because a
   * health report that 500s when a component is down tells the operator nothing about
   * which one.
   */
  app.get("/admin/v1/health", async (request, reply) => {
    await requireAdmin(request, deps);
    const checkedAt = deps.clock.now();

    const [database, accounts, reconciliation, switches] = await Promise.all([
      probeDatabase(deps),
      deps.providerAccounts.listByType(PROVIDER_TYPE),
      deps.reconciliation.snapshot(checkedAt),
      deps.killSwitches(),
    ]);

    const pool = {
      healthy: accounts.filter((account) => account.status === "active").length,
      coolingDown: accounts.filter((account) => account.status === "cooldown").length,
      credentialInvalid: accounts.filter((account) => account.status === "invalid").length,
      disabled: accounts.filter((account) => account.status === "disabled").length,
    };

    const components = [
      {
        name: "database",
        state: database.ok ? ("healthy" as const) : ("down" as const),
        // A classification, never the driver's error text: a connection error can carry a
        // DSN, and a DSN carries a password.
        detail: database.ok ? "Reachable." : "Unreachable from this gateway.",
        checkedAt: iso(checkedAt),
      },
      {
        name: "provider pool",
        state: providerPoolState(pool),
        detail: poolDetail(pool),
        checkedAt: iso(checkedAt),
      },
      {
        name: "kiro adapter",
        state: switches.adapterEnabled ? ("healthy" as const) : ("down" as const),
        detail: switches.adapterEnabled
          ? "Enabled."
          : "Disabled by kill switch. No completions are being served.",
        checkedAt: iso(checkedAt),
      },
      {
        name: "codex adapter",
        state:
          deps.env.OPENAI_CODEX_RUNTIME_ENABLED && deps.env.OPENAI_CODEX_COMMERCIAL_ENABLED
            ? ("healthy" as const)
            : ("down" as const),
        detail:
          deps.env.OPENAI_CODEX_RUNTIME_ENABLED && deps.env.OPENAI_CODEX_COMMERCIAL_ENABLED
            ? "Runtime and commercial gates enabled."
            : "Disabled by default until compatibility and commercial gates pass.",
        checkedAt: iso(checkedAt),
      },
      {
        name: "reconciliation",
        state: reconciliationState(reconciliation),
        detail: reconciliationDetail(reconciliation),
        checkedAt: iso(checkedAt),
      },
    ];

    return reply.status(200).send({
      components,
      providerPool: pool,
      reconciliation: {
        lastRunAt: isoOrNull(reconciliation.lastRunAt),
        lagSeconds: reconciliation.lagSeconds,
        pendingOrders: reconciliation.pendingOrders,
        reviewRequiredOrders: reconciliation.reviewRequiredOrders,
      },
    });
  });
}

const PROVIDER_TYPE = "kiro";

/** One real query. A thrown error becomes a `down` component, not a 500. */
async function probeDatabase(deps: AdminDeps): Promise<{ ok: boolean }> {
  try {
    await deps.checkDatabase();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

type Pool = { healthy: number; coolingDown: number; credentialInvalid: number; disabled: number };

/**
 * Pool state.
 *
 * `down` at zero healthy accounts because the scheduler has nothing to pick and every
 * request will fail (§6). Degraded when anything is cooling down or holds an invalid
 * credential — those are working-but-diminished. A `disabled` account is operator intent,
 * not a fault, so it does not degrade the report on its own.
 */
function providerPoolState(pool: Pool): "healthy" | "degraded" | "down" {
  if (pool.healthy === 0) return "down";
  if (pool.coolingDown > 0 || pool.credentialInvalid > 0) return "degraded";
  return "healthy";
}

function poolDetail(pool: Pool): string {
  if (pool.healthy === 0) {
    return "No account is available to serve traffic.";
  }
  const notes: string[] = [`${pool.healthy} available`];
  if (pool.coolingDown > 0) notes.push(`${pool.coolingDown} cooling down`);
  if (pool.credentialInvalid > 0)
    notes.push(`${pool.credentialInvalid} with an invalid credential`);
  if (pool.disabled > 0) notes.push(`${pool.disabled} disabled`);
  return `${notes.join(", ")}.`;
}

/** Orders held for review are the operator's queue, so they degrade the report (§13). */
function reconciliationState(snapshot: {
  lagSeconds: number | null;
  reviewRequiredOrders: number;
}): "healthy" | "degraded" | "down" {
  if (snapshot.reviewRequiredOrders > 0) return "degraded";
  // An hour behind means a paid order could sit unactivated for an hour.
  if (snapshot.lagSeconds !== null && snapshot.lagSeconds > 3_600) return "degraded";
  return "healthy";
}

function reconciliationDetail(snapshot: {
  lastRunAt: Date | null;
  lagSeconds: number | null;
  pendingOrders: number;
  reviewRequiredOrders: number;
}): string {
  if (snapshot.lastRunAt === null) return "Has not run yet.";
  const notes = [`${snapshot.pendingOrders} pending`];
  if (snapshot.reviewRequiredOrders > 0) {
    notes.push(`${snapshot.reviewRequiredOrders} awaiting review`);
  }
  if (snapshot.lagSeconds !== null) notes.push(`${snapshot.lagSeconds}s behind`);
  return `${notes.join(", ")}.`;
}
