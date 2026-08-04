/**
 * The vertical slice, once (PLAN.md §7 selection, §8 surfaces, §9/§10 metering).
 *
 * Both surfaces run the SAME admission sequence and the same provider stream. The
 * only thing that differs between `/v1/chat/completions` and `/v1/messages` is the
 * codec at each end, so the middle lives here and the routes stay thin. That is not
 * merely deduplication: a rule enforced in one place cannot hold on one surface and
 * quietly not on the other.
 *
 * ── ADMISSION ORDER IS FIXED, AND THE ORDER IS THE SECURITY PROPERTY ──────
 *   1. authenticate            → 401, no oracle (§12) — done by the route
 *   2. limiter.acquire         → 429 rate_limit before concurrency_limit (§7)
 *   3. canStartRequest         → 429 quota_exhausted (§10)
 *   4. resolve model + pin the multiplier version (§9)
 *   5. evaluateKillSwitches    → 503 adapter_disabled, sanitized (§3)
 *   6. load pool               → 503 no_healthy_provider (§7)
 *   7. streamWithFailover      → retry only at zero bytes (§7 rule 3)
 *   8. settle                  → on every exit path (§10)
 *
 * Cheap rejections come first, so an unauthenticated flood costs one regex rather
 * than a database round trip and a provider lease. The kill switch is evaluated
 * BEFORE any credential is touched, so a disabled adapter never decrypts a token —
 * that is what makes `KIRO_DIRECT_ENABLED=false` a real boundary and not just a 503
 * bolted onto the end of a pipeline that already did the work.
 *
 * ── WHY THE SLOT IS RELEASED IN A `finally` ───────────────────────────────
 * A concurrency slot leaked on an abort permanently shrinks a customer's ceiling
 * until the process restarts. §7's limit is a gauge, and a gauge that only rises is
 * a slow outage. Admission releases the slot itself on any throw; the caller owns
 * the success path, where the slot must outlive admission and end with the stream.
 */

import { BosandaError } from "@bosanda/protocol";
import type { CanonicalEvent, CanonicalRequest, CanonicalUsage } from "@bosanda/protocol";
import { canStartRequest } from "@bosanda/metering";
import { evaluateKillSwitches, streamWithFailover } from "@bosanda/provider-core";
import type { ProviderModel, SchedulableAccount } from "@bosanda/provider-core";
import { toKeyQuotaState, type AuthenticatedApiKey } from "@bosanda/database";
import type { Logger } from "@bosanda/observability";
import { narrowProviderType, toSchedulable, type GatewayDeps } from "./dependencies.js";
import { settleRequest, type TurnStatus } from "./settlement.js";
import type { Slot } from "./limits.js";

/**
 * A resolved model plus the pricing pinned at request start (§9).
 *
 * `multiplierExact` is the stored decimal STRING (e.g. "1.3000") and is what the
 * ledger row records, so the audit trail is byte-identical to the catalogue row the
 * request was priced from. `multiplier` is the parsed number the metering
 * arithmetic needs. Keeping both avoids a float round-trip deciding what a customer
 * was charged.
 */
export type ResolvedModel = {
  model: ProviderModel;
  providerType: "kiro" | "openai_codex";
  multiplier: number;
  multiplierExact: string;
  multiplierVersion: number;
};

/**
 * Loads the catalogue entry for a requested public model ID.
 *
 * `model_not_allowed` (403) for unknown OR unpublished, deliberately not 404: the
 * frozen `ErrorCode` union has no `model_unavailable`, and a 404 would let a client
 * distinguish "does not exist" from "exists but you may not use it" — the same
 * enumeration leak the key-auth path avoids. (PLAN §8 names `model_unavailable`
 * while the frozen union lacks it. That mismatch is the owner's open question; this
 * code stays with the existing packages' behaviour rather than resolving it.)
 *
 * `multiplierVersion` is TEXT in the schema. A row that does not parse as a
 * positive integer is a malformed catalogue, not something to paper over with a
 * default: settling against version 1 when the row says otherwise would misprice a
 * request and leave a ledger entry that cannot be explained.
 */
export async function resolveRequestModel(
  publicId: string,
  deps: Pick<GatewayDeps, "models">,
): Promise<ResolvedModel> {
  const record = await deps.models.findByPublicId(publicId);
  if (record === null || !record.published) {
    throw new BosandaError("model_not_allowed", {
      internalDetail: `model ${publicId} is unknown or unpublished`,
    });
  }

  const version = Number(record.multiplierVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new BosandaError("internal_error", {
      internalDetail: `model ${publicId} has a non-integer multiplier_version ${record.multiplierVersion}`,
    });
  }

  return {
    providerType: narrowProviderType(record.providerType),
    model: {
      publicId: record.publicId,
      upstreamId: record.upstreamId,
      label: record.label,
      contextWindow: record.contextWindow,
      multiplier: record.multiplierNumeric,
      multiplierVersion: version,
      supportsTools: record.supportsTools,
      supportsReasoning: record.supportsReasoning,
      regions: record.regions,
      published: record.published,
      // `ModelRecord.compatibilityStatus` has a "degraded" state the frozen
      // `ProviderModel` does not; a degraded model is still serving, so it maps to
      // "passing" for the adapter's purposes.
      compatibilityStatus:
        record.compatibilityStatus === "failing"
          ? "failing"
          : record.compatibilityStatus === "untested"
            ? "unknown"
            : "passing",
    },
    multiplier: record.multiplierNumeric,
    multiplierExact: record.multiplier,
    multiplierVersion: version,
  };
}

/**
 * Builds the schedulable pool for one model.
 *
 * Throws `no_healthy_provider` (503) on an empty pool rather than returning `[]`,
 * because every caller would otherwise repeat the same check and one would forget.
 * The scheduler's own `candidates()` throws the same code once everything is
 * cooling down, so both empty cases report identically.
 */
export async function loadPool(
  model: string,
  providerType: ResolvedModel["providerType"],
  deps: Pick<GatewayDeps, "providerAccounts" | "clock" | "health">,
): Promise<SchedulableAccount[]> {
  const rows = await deps.providerAccounts.listEligibleHealth(providerType, deps.clock.now());
  const supported: ReadonlySet<string> = new Set([model]);
  const pool = rows.map((row) => toSchedulable(row, supported));

  // Register every account so §17 gauges cover accounts this process has not yet
  // served a request for. `track` is a no-op for an account already known.
  for (const account of pool) {
    deps.health.track({
      accountId: account.accountId,
      region: account.health.region,
      persona: account.health.persona,
      status: account.health.status,
    });
  }

  if (pool.length === 0) {
    throw new BosandaError("no_healthy_provider", {
      internalDetail: `no eligible ${providerType} accounts for model ${model}`,
    });
  }
  return pool;
}

export type AdmissionInput = {
  authenticated: AuthenticatedApiKey;
  request: CanonicalRequest;
};

export type Admitted = {
  slot: Slot;
  resolved: ResolvedModel;
  pool: SchedulableAccount[];
  state: ReturnType<typeof toKeyQuotaState>;
};

/**
 * Steps 2–6: everything between "we know who you are" and "we are about to stream".
 *
 * Returns a request that may have been rewritten (tools stripped when §3's tool-use
 * switch is off). Rewriting a copy rather than mutating the caller's object keeps
 * `CanonicalRequest` effectively immutable through the pipeline, so a route cannot
 * accidentally settle against different content than it streamed.
 */
export async function admit(
  input: AdmissionInput,
  deps: GatewayDeps,
): Promise<{ admitted: Admitted; request: CanonicalRequest }> {
  const { authenticated } = input;
  let request = input.request;
  const state = toKeyQuotaState(authenticated.key);

  // 2. Per-key RPM then concurrency (§7). Throws 429 carrying which one tripped.
  const slot = deps.limiter.acquire(authenticated.key.id);

  try {
    // 3. Quota (§10), against the state read at authentication time — the same
    //    numbers the settlement will be computed from.
    const start = canStartRequest(state, deps.clock);
    if (!start.allowed) throw start.error;

    // 4. Model + pinned pricing (§9).
    const resolved = await resolveRequestModel(request.model, deps);

    // 5. Kill switches (§3), BEFORE any credential is loaded.
    const switches = await deps.killSwitches(resolved.providerType);
    const decision = evaluateKillSwitches(switches, { model: request.model });
    if (!decision.allowed) {
      // `decision.reason` is operator-facing and already sanitized. The client sees
      // only the frozen public message on `decision.error`.
      deps.logger.warn(
        { model: request.model, reason: decision.reason },
        "request blocked by kill switch",
      );
      throw decision.error;
    }
    if (decision.stripTools && request.tools.length > 0) {
      // §3: tool use switches off independently of the adapter. Stripping rather
      // than rejecting keeps text-only clients working during an incident.
      deps.logger.warn({ model: request.model, reason: decision.reason }, "tools stripped");
      request = { ...request, tools: [], toolChoice: null };
    }

    // 6. Pool.
    const pool = await loadPool(request.model, resolved.providerType, deps);

    return { admitted: { slot, resolved, pool, state }, request };
  } catch (error) {
    slot.release();
    throw error;
  }
}

export type StreamOutcome = {
  providerAccountId: string | null;
  retries: number;
  ttfbMs: number | null;
  durationMs: number;
  upstreamUsage: CanonicalUsage | null;
  status: TurnStatus;
  /** Set when the turn failed; already classified. */
  error?: BosandaError;
};

export type RunStreamInput = {
  request: CanonicalRequest;
  admitted: Admitted;
  signal: AbortSignal;
  /** Called for every event, in order. A throw here is terminal for the turn. */
  emit: (event: CanonicalEvent) => void | Promise<void>;
};

/**
 * Step 7: run the provider stream with failover, forwarding every event to `emit`.
 *
 * This function does NOT rethrow. A stream that breaks mid-flight cannot be turned
 * into an HTTP status — headers are long gone — so the outcome is returned and the
 * route decides between a status code and an in-band error frame. Returning rather
 * than throwing is what lets settlement run identically on both paths.
 *
 * `usage` events are captured for settlement and still forwarded, since both codecs
 * buffer usage into their own trailer and a surface may want to render it.
 */
export async function runStream(input: RunStreamInput, deps: GatewayDeps): Promise<StreamOutcome> {
  const { request, admitted, signal, emit } = input;
  const startedAt = deps.clock.now().getTime();
  const adapter = deps.adapters.get(admitted.resolved.providerType);

  let providerAccountId: string | null = null;
  let retries = 0;
  let ttfbMs: number | null = null;
  let upstreamUsage: CanonicalUsage | null = null;

  const events = streamWithFailover<CanonicalEvent>({
    scheduler: deps.scheduler,
    cooldowns: deps.cooldowns,
    breakers: deps.breakers,
    clock: deps.clock,
    pool: admitted.pool,
    context: { model: request.model },
    signal,
    attempt: async (account, sink, attemptSignal) => {
      providerAccountId = account.accountId;
      deps.health.recordAttempt(account.accountId);
      deps.metrics.increment("bosanda_upstream_attempts_total", { model: request.model });
      // `stream` throws SYNCHRONOUSLY for adapter_disabled / model_not_allowed /
      // unsupported_capability, so those surface here before any event is emitted.
      for await (const event of adapter.stream(request, account.accountId, attemptSignal)) {
        await sink.emit(event);
      }
    },
    onAttempt: (info) => {
      if (info.outcome === "retried") {
        retries += 1;
        deps.health.recordRetry(info.accountId);
        // Label with the error class only — never an account id (§17 cardinality).
        deps.metrics.increment("bosanda_upstream_retries_total", { code: info.code ?? "unknown" });
      }
    },
  });

  try {
    for await (const event of events) {
      if (ttfbMs === null) {
        ttfbMs = deps.clock.now().getTime() - startedAt;
        deps.metrics.observe("bosanda_ttfb_ms", ttfbMs, { model: request.model });
      }
      if (event.type === "usage") {
        upstreamUsage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cachedTokens === undefined ? {} : { cachedTokens: event.cachedTokens }),
          estimated: event.estimated,
        };
      }
      if (event.type === "tool_start") {
        deps.metrics.increment("bosanda_tool_use_turns_total", { model: request.model });
      }
      deps.metrics.increment("bosanda_stream_events_total", { surface: request.surface });
      await emit(event);
    }

    const durationMs = deps.clock.now().getTime() - startedAt;
    if (providerAccountId !== null) {
      deps.health.recordSuccess(providerAccountId, {
        ...(ttfbMs === null ? {} : { ttfbMs }),
        durationMs,
      });
    }
    deps.metrics.observe("bosanda_duration_ms", durationMs, { model: request.model });
    return { providerAccountId, retries, ttfbMs, durationMs, upstreamUsage, status: "succeeded" };
  } catch (rawError) {
    const durationMs = deps.clock.now().getTime() - startedAt;
    const error = BosandaError.from(rawError);
    if (providerAccountId !== null) {
      deps.health.recordFailure(providerAccountId, error, { durationMs });
    }
    deps.metrics.observe("bosanda_duration_ms", durationMs, { model: request.model });
    return {
      providerAccountId,
      retries,
      ttfbMs,
      durationMs,
      upstreamUsage,
      // A turn that produced output and then broke is `partial`, not `failed`: the
      // customer received tokens, and §10 bills for what was delivered.
      status: signal.aborted ? "cancelled" : ttfbMs === null ? "failed" : "partial",
      error,
    };
  }
}

export type SettleOutcomeInput = {
  request: CanonicalRequest;
  admitted: Admitted;
  outcome: StreamOutcome;
  outputSegments: readonly string[];
  surface: "openai" | "anthropic";
};

/** Step 8. Supplies the pinned pricing and adapter version to the settlement. */
export async function settleOutcome(input: SettleOutcomeInput, deps: GatewayDeps): Promise<void> {
  const { request, admitted, outcome } = input;
  await settleRequest(
    {
      request,
      state: admitted.state,
      model: request.model,
      multiplier: admitted.resolved.multiplier,
      multiplierExact: admitted.resolved.multiplierExact,
      multiplierVersion: admitted.resolved.multiplierVersion,
      outputSegments: input.outputSegments,
      upstreamUsage: outcome.upstreamUsage,
      status: outcome.status,
      providerAccountId: outcome.providerAccountId,
      adapterVersion: deps.adapters.tryGet(admitted.resolved.providerType)?.adapterVersion ?? null,
      retries: outcome.retries,
      ttfbMs: outcome.ttfbMs,
      durationMs: outcome.durationMs,
      surface: input.surface,
    },
    deps,
  );
}

/**
 * Records that a key was used, without letting bookkeeping fail a request.
 *
 * This is the call site `last_used_at` has been waiting for: the gateway is where a
 * customer key is actually exercised. Fire-and-forget with a logged failure,
 * because a customer's stream must not depend on a timestamp write.
 */
export function touchKey(keyId: string, deps: GatewayDeps, logger: Logger): void {
  void deps.apiKeys.touchLastUsed(keyId, deps.clock).catch((error: unknown) => {
    logger.warn({ err: error, apiKeyId: keyId }, "failed to update api key last_used_at");
  });
}
