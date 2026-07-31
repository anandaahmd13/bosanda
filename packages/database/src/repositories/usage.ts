/**
 * `usage_events` — one row per billable request (PLAN.md §10, §17).
 *
 * ── WHAT IS NOT STORED ─────────────────────────────────────────────────────
 * §16 and §14: "Prompt, response text, tool arguments, tool results, and source
 * code are not stored by default." The `usage_events` table has no column for any
 * of them, and this file adds none. The insert below names every column
 * explicitly, so a future caller cannot smuggle content through an object spread.
 * Token COUNTS are metadata, not content, and are what the ledger is reconciled
 * against.
 *
 * ── RELATIONSHIP TO quota_ledger ───────────────────────────────────────────
 * Two rows describe one request and they answer different questions.
 * `quota_ledger` is the commercial record — what was charged, on which balance.
 * `usage_events` is the operational record — which account served it, which
 * adapter version, how many retries, TTFB. They are written by the same settle
 * path and can be joined on `request_id`.
 *
 * They are NOT written in one statement, and the honest consequence is that a
 * crash between them can leave a debit with no usage row (or the reverse, if the
 * caller ordered it that way). Pass a `tx` to both if you need them to agree; the
 * gateway is expected to, and `usage_events.request_id` being UNIQUE means a retry
 * is safe either way.
 */

import { type Executor, firstRow } from "./executor.js";
import { type UsageEvent, type UsageEventRow, bigintToNumber, toUsageEvent } from "./rows.js";
import {
  type InsertOutcome,
  type Pagination,
  decideInsertOutcome,
  normalizePagination,
} from "./decisions.js";

export type InsertUsageEventInput = {
  id: string;
  /** Correlation id from `requestId()`. UNIQUE — this is the idempotency key. */
  requestId: string;
  apiKeyId: string;
  /** Null when the request never reached an account (rejected, no capacity). */
  providerAccountId: string | null;
  modelPublicId: string;
  surface: "openai" | "anthropic";
  status: "succeeded" | "failed" | "cancelled" | "partial";
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Weighted tokens billed. Non-negative (CHECK), unlike the ledger delta. */
  weightedTokens: number;
  /** True when counted locally rather than reported upstream (§10). */
  estimated: boolean;
  meterVersion: string;
  adapterVersion: string | null;
  retries: number;
  ttfbMs: number | null;
  durationMs: number | null;
  createdAt: Date;
};

/** Dashboard totals for one key over a window. */
export type UsageTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  weightedTokens: number;
  /** Requests whose token counts were estimated rather than reported (§10). */
  estimatedRequests: number;
};

/** Per-model breakdown, for the "where did my quota go" view. */
export type UsageByModel = {
  modelPublicId: string;
  requests: number;
  weightedTokens: number;
};

/** Per-day series for a usage chart. `day` is a UTC date at midnight. */
export type UsageByDay = {
  day: Date;
  requests: number;
  weightedTokens: number;
};

type TotalsRow = {
  requests: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cached_tokens: string | null;
  weighted_tokens: string | null;
  estimated_requests: string;
};

const toTotals = (row: TotalsRow | null): UsageTotals => {
  if (row === null) {
    return {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      weightedTokens: 0,
      estimatedRequests: 0,
    };
  }
  return {
    requests: bigintToNumber(row.requests, "usage totals requests"),
    inputTokens: bigintToNumber(row.input_tokens ?? 0, "usage totals input_tokens"),
    outputTokens: bigintToNumber(row.output_tokens ?? 0, "usage totals output_tokens"),
    cachedTokens: bigintToNumber(row.cached_tokens ?? 0, "usage totals cached_tokens"),
    weightedTokens: bigintToNumber(row.weighted_tokens ?? 0, "usage totals weighted_tokens"),
    estimatedRequests: bigintToNumber(row.estimated_requests, "usage totals estimated_requests"),
  };
};

export type UsageRepository = ReturnType<typeof usageRepository>;

export function usageRepository(sql: Executor) {
  return {
    /**
     * Record one request, idempotently.
     *
     * `request_id` is UNIQUE, so `ON CONFLICT DO NOTHING` makes a retried settle a
     * no-op that returns the row already stored. `status: "duplicate"` tells the
     * caller its retry was redundant, which is information worth logging but not an
     * error — §13 requires the settle path to tolerate replay.
     *
     * ON CONFLICT names the column rather than the constraint so the statement does
     * not depend on the generated constraint name.
     */
    async insert(input: InsertUsageEventInput): Promise<InsertOutcome<UsageEvent>> {
      const inserted = await sql<UsageEventRow[]>`
        INSERT INTO usage_events (
          id, request_id, api_key_id, provider_account_id, model_public_id,
          surface, status, input_tokens, output_tokens, cached_tokens,
          weighted_tokens, estimated, meter_version, adapter_version,
          retries, ttfb_ms, duration_ms, created_at
        ) VALUES (
          ${input.id}, ${input.requestId}, ${input.apiKeyId}, ${input.providerAccountId},
          ${input.modelPublicId}, ${input.surface}, ${input.status},
          ${input.inputTokens}, ${input.outputTokens}, ${input.cachedTokens},
          ${input.weightedTokens}, ${input.estimated}, ${input.meterVersion},
          ${input.adapterVersion}, ${input.retries}, ${input.ttfbMs},
          ${input.durationMs}, ${input.createdAt}
        )
        ON CONFLICT (request_id) DO NOTHING
        RETURNING *
      `;

      const insertedRow = firstRow(inserted);
      if (insertedRow !== null) {
        return decideInsertOutcome(toUsageEvent(insertedRow), null, "usage_events insert");
      }

      const existing = await sql<UsageEventRow[]>`
        SELECT * FROM usage_events WHERE request_id = ${input.requestId}
      `;
      const existingRow = firstRow(existing);
      return decideInsertOutcome(
        null,
        existingRow === null ? null : toUsageEvent(existingRow),
        `usage_events insert for request ${input.requestId}`,
      );
    },

    async findByRequestId(requestId: string): Promise<UsageEvent | null> {
      const rows = await sql<UsageEventRow[]>`
        SELECT * FROM usage_events WHERE request_id = ${requestId}
      `;
      const row = firstRow(rows);
      return row === null ? null : toUsageEvent(row);
    },

    /** A key's requests, newest first. Matches `usage_events_api_key_created_idx`. */
    async listForKey(apiKeyId: string, paging: Pagination = {}): Promise<UsageEvent[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<UsageEventRow[]>`
        SELECT * FROM usage_events
        WHERE api_key_id = ${apiKeyId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toUsageEvent);
    },

    /**
     * Totals for one key over `[from, to)`.
     *
     * Half-open so adjacent windows neither double-count nor drop a request landing
     * exactly on a boundary — the same convention the day series below uses.
     */
    async totalsForKey(apiKeyId: string, from: Date, to: Date): Promise<UsageTotals> {
      const rows = await sql<TotalsRow[]>`
        SELECT COUNT(*)::TEXT                                        AS requests,
               SUM(input_tokens)::TEXT                               AS input_tokens,
               SUM(output_tokens)::TEXT                              AS output_tokens,
               SUM(cached_tokens)::TEXT                              AS cached_tokens,
               SUM(weighted_tokens)::TEXT                            AS weighted_tokens,
               COUNT(*) FILTER (WHERE estimated)::TEXT               AS estimated_requests
        FROM usage_events
        WHERE api_key_id = ${apiKeyId}
          AND created_at >= ${from}
          AND created_at < ${to}
      `;
      return toTotals(firstRow(rows));
    },

    /** Totals across every key a user owns. */
    async totalsForUser(userId: string, from: Date, to: Date): Promise<UsageTotals> {
      const rows = await sql<TotalsRow[]>`
        SELECT COUNT(*)::TEXT                          AS requests,
               SUM(e.input_tokens)::TEXT               AS input_tokens,
               SUM(e.output_tokens)::TEXT              AS output_tokens,
               SUM(e.cached_tokens)::TEXT              AS cached_tokens,
               SUM(e.weighted_tokens)::TEXT            AS weighted_tokens,
               COUNT(*) FILTER (WHERE e.estimated)::TEXT AS estimated_requests
        FROM usage_events e
        JOIN api_keys k ON k.id = e.api_key_id
        WHERE k.user_id = ${userId}
          AND e.created_at >= ${from}
          AND e.created_at < ${to}
      `;
      return toTotals(firstRow(rows));
    },

    /** Weighted usage per model over a window. Uses `usage_events_model_idx`. */
    async totalsByModel(from: Date, to: Date): Promise<UsageByModel[]> {
      const rows = await sql<
        { model_public_id: string; requests: string; weighted_tokens: string | null }[]
      >`
        SELECT model_public_id,
               COUNT(*)::TEXT            AS requests,
               SUM(weighted_tokens)::TEXT AS weighted_tokens
        FROM usage_events
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY model_public_id
        ORDER BY SUM(weighted_tokens) DESC NULLS LAST, model_public_id
      `;
      return rows.map((row) => ({
        modelPublicId: row.model_public_id,
        requests: bigintToNumber(row.requests, "usage by model requests"),
        weightedTokens: bigintToNumber(row.weighted_tokens ?? 0, "usage by model weighted_tokens"),
      }));
    },

    /**
     * Weighted usage per provider account (§10 "Kiro credit reconciliation": the
     * admin dashboard shows "weighted usage attributed to each provider account").
     *
     * Rows whose account is null are excluded — a request that never reached an
     * account consumed no provider credit and would distort the attribution.
     */
    async totalsByProviderAccount(
      from: Date,
      to: Date,
    ): Promise<{ providerAccountId: string; requests: number; weightedTokens: number }[]> {
      const rows = await sql<
        { provider_account_id: string; requests: string; weighted_tokens: string | null }[]
      >`
        SELECT provider_account_id,
               COUNT(*)::TEXT             AS requests,
               SUM(weighted_tokens)::TEXT AS weighted_tokens
        FROM usage_events
        WHERE created_at >= ${from} AND created_at < ${to}
          AND provider_account_id IS NOT NULL
        GROUP BY provider_account_id
        ORDER BY SUM(weighted_tokens) DESC NULLS LAST, provider_account_id
      `;
      return rows.map((row) => ({
        providerAccountId: row.provider_account_id,
        requests: bigintToNumber(row.requests, "usage by account requests"),
        weightedTokens: bigintToNumber(
          row.weighted_tokens ?? 0,
          "usage by account weighted_tokens",
        ),
      }));
    },

    /**
     * Daily series for one key.
     *
     * Truncated in UTC explicitly (`date_trunc('day', created_at AT TIME ZONE
     * 'UTC')`) rather than relying on the session timezone: §14 requires UTC
     * everywhere, and a chart whose buckets shift with server configuration is
     * worse than no chart. Days with no traffic are absent rather than zero-filled —
     * the caller knows its own window and can fill.
     */
    async dailyForKey(apiKeyId: string, from: Date, to: Date): Promise<UsageByDay[]> {
      const rows = await sql<{ day: Date; requests: string; weighted_tokens: string | null }[]>`
        SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
               COUNT(*)::TEXT                                   AS requests,
               SUM(weighted_tokens)::TEXT                        AS weighted_tokens
        FROM usage_events
        WHERE api_key_id = ${apiKeyId}
          AND created_at >= ${from}
          AND created_at < ${to}
        GROUP BY 1
        ORDER BY 1
      `;
      return rows.map((row) => ({
        day: row.day,
        requests: bigintToNumber(row.requests, "usage daily requests"),
        weightedTokens: bigintToNumber(row.weighted_tokens ?? 0, "usage daily weighted_tokens"),
      }));
    },

    /**
     * Delete usage rows older than `before` (§14 "Usage and audit retention
     * policies are documented").
     *
     * Batched: an unbounded DELETE on the largest table in the schema would hold
     * locks for a long time. The worker loops until the returned count is below
     * `limit`. Returns the number deleted.
     */
    async deleteOlderThan(before: Date, limit = 1000): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM usage_events
        WHERE id IN (
          SELECT id FROM usage_events
          WHERE created_at < ${before}
          ORDER BY created_at
          LIMIT ${limit}
        )
        RETURNING id
      `;
      return rows.length;
    },
  };
}
