/**
 * Usage settlement (PLAN.md §10 metering, §16 invariant 4).
 *
 * One turn produces two rows, written in ONE transaction:
 *
 *   quota_ledger  — the append-only debit, and the new balance
 *   usage_events  — the observability record (surface, retries, TTFB, duration)
 *
 * §16 invariant 4 is absolute: "no code path may adjust a balance without a matching
 * ledger row." `quotaRepository.recordDebit` already writes the ledger row and the
 * balance together, so the invariant holds inside that call; wrapping both repos in
 * one transaction extends it so a usage row can never exist for an unbilled turn or
 * the reverse.
 *
 * ── WHY SETTLEMENT NEVER THROWS INTO A ROUTE ──────────────────────────────
 * By the time this runs the response is already committed — headers sent, stream
 * over. A throw here cannot become an HTTP status; it can only turn a completed
 * customer response into a crashed handler and, on the streaming path, a truncated
 * body. So a settlement failure is logged at `error` and swallowed. That is a
 * deliberate trade: an unbilled request is a revenue loss the reconciliation worker
 * can detect from `usage_events` and the ledger diverging, whereas a crashed handler
 * is a customer-visible outage. The failure is loud in logs and in
 * `bosanda_usage_estimated_total`, never silent.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * Both writes key on `request.requestId`. `quota_ledger` has a partial unique index
 * on `(api_key_id, request_id) WHERE kind = 'debit'`, and `usage_events.request_id`
 * is UNIQUE. A retried settlement therefore reads back the ORIGINAL figures rather
 * than double-charging — which is why `recordDebit` refuses a debit that has no
 * request id at all rather than writing an unprotected row.
 */

import { BosandaError } from "@bosanda/protocol";
import type { CanonicalRequest, CanonicalUsage } from "@bosanda/protocol";
import { resolveUsage, settle } from "@bosanda/metering";
import { ulid } from "@bosanda/shared";
// No `@bosanda/database` import: the transaction and both repositories arrive
// through `deps.transact`, which is what lets settlement be tested without a pool.
import type { GatewayDeps } from "./dependencies.js";

/** Mirrors `usage_events.status`. */
export type TurnStatus = "succeeded" | "failed" | "cancelled" | "partial";

export type SettleRequestInput = {
  request: CanonicalRequest;
  state: { keyId: string; remaining: number };
  model: string;
  /** Parsed multiplier, for the metering arithmetic. */
  multiplier: number;
  /** Stored decimal string, for the ledger row (§9 byte-identical pricing). */
  multiplierExact: string;
  multiplierVersion: number;
  /** Text actually emitted to the client, for the counted fallback (§10). */
  outputSegments: readonly string[];
  /** Null when no upstream metricsEvent arrived at all. */
  upstreamUsage: CanonicalUsage | null;
  status: TurnStatus;
  providerAccountId: string | null;
  adapterVersion: string | null;
  retries: number;
  ttfbMs: number | null;
  durationMs: number | null;
  surface: "openai" | "anthropic";
};

/**
 * Settles one turn. Never throws.
 *
 * A turn that never reached an account (rejected at admission, empty pool) still
 * settles: §10 charges for "usage actually reported or estimated", and a request
 * that consumed no upstream tokens resolves to a zero-token estimate, which writes
 * a zero debit. Recording it keeps `usage_events` a complete picture of traffic
 * rather than only the successful part.
 */
export async function settleRequest(input: SettleRequestInput, deps: GatewayDeps): Promise<void> {
  const {
    request,
    state,
    model,
    multiplier,
    multiplierExact,
    multiplierVersion,
    outputSegments,
    upstreamUsage,
    status,
  } = input;

  try {
    const usage = resolveUsage({
      request,
      upstream:
        upstreamUsage === null
          ? null
          : { inputTokens: upstreamUsage.inputTokens, outputTokens: upstreamUsage.outputTokens },
      outputSegments,
      partialTurn: status !== "succeeded",
    });

    const settlement = settle({
      state: {
        keyId: state.keyId,
        // `settle` only reads `remaining` to compute `remainingAfter`; the status
        // and expiry gates were already applied by `canStartRequest` at admission.
        status: "active",
        remaining: state.remaining,
        quotaLimit: state.remaining,
        expiresAt: null,
      },
      usage,
      multiplier,
      multiplierVersion,
      model,
    });

    const now = deps.clock.now();

    await deps.transact(async (tx) => {
      const debit = await tx.quota.recordDebit({
        id: ulid(),
        apiKeyId: state.keyId,
        requestId: request.requestId,
        rawInputTokens: settlement.inputTokens,
        rawOutputTokens: settlement.outputTokens,
        // The exact stored decimal, so the ledger matches the catalogue row.
        multiplier: multiplierExact,
        weightedTokens: settlement.weightedTokens,
        remainingAfter: settlement.remainingAfter,
        estimated: settlement.estimated,
        meterVersion: settlement.meterVersion,
        createdAt: now,
      });

      if (debit.status === "duplicate") {
        // Already billed — a retry, or two settlement paths racing for the same
        // request. The original row is authoritative; do not write a second usage
        // row either, since `usage_events.request_id` is UNIQUE and would conflict.
        deps.logger.warn(
          { requestId: request.requestId, apiKeyId: state.keyId },
          "settlement already recorded; skipping duplicate",
        );
        return;
      }

      if (debit.clamped) {
        // §10 bounds overage: the balance floored at zero rather than going
        // negative. Operator-visible because it means a turn was under-billed.
        deps.logger.warn(
          { requestId: request.requestId, apiKeyId: state.keyId, model },
          "quota overage clamped to zero",
        );
      }

      await tx.usage.insert({
        id: ulid(),
        requestId: request.requestId,
        apiKeyId: state.keyId,
        providerAccountId: input.providerAccountId,
        modelPublicId: model,
        surface: input.surface,
        status,
        inputTokens: settlement.inputTokens,
        outputTokens: settlement.outputTokens,
        cachedTokens: upstreamUsage?.cachedTokens ?? 0,
        weightedTokens: settlement.weightedTokens,
        estimated: settlement.estimated,
        meterVersion: settlement.meterVersion,
        adapterVersion: input.adapterVersion,
        retries: input.retries,
        ttfbMs: input.ttfbMs,
        durationMs: input.durationMs,
        createdAt: now,
      });
    });

    // §17 counters. Labels are low-cardinality by construction: a model id and a
    // fixed enum, never a request id, key id, or account id.
    deps.metrics.increment(
      "bosanda_tokens_total",
      { model, kind: "input" },
      settlement.inputTokens,
    );
    deps.metrics.increment(
      "bosanda_tokens_total",
      { model, kind: "output" },
      settlement.outputTokens,
    );
    deps.metrics.increment(
      "bosanda_tokens_total",
      { model, kind: "weighted" },
      settlement.weightedTokens,
    );
    if (settlement.estimated) {
      deps.metrics.increment("bosanda_usage_estimated_total", { model, source: settlement.source });
    }
  } catch (error) {
    // See the header: this cannot be surfaced to the client, so it is logged as an
    // operator problem. `BosandaError.from` classifies it; `internalDetail` is safe
    // for logs (§16 forbids it crossing the response boundary, not the log one).
    const classified = BosandaError.from(error);
    deps.logger.error(
      {
        err: classified,
        code: classified.code,
        detail: classified.internalDetail,
        requestId: request.requestId,
        apiKeyId: state.keyId,
        model,
        status,
      },
      "settlement failed; request was served but not billed",
    );
  }
}
