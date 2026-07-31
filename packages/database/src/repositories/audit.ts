/**
 * `audit_events` — append-only (PLAN.md §13, §15, §16).
 *
 * ── THERE IS NO UPDATE AND NO DELETE, BY CONSTRUCTION ──────────────────────
 * §13: "revocation or quota adjustment is recorded as a ledger entry, never by
 * deleting history." §15 requires the admin surface to be auditable. So this
 * repository exposes `append`, reads, and nothing else. The absence of a mutator is
 * the enforcement — a caller cannot rewrite an audit row through this layer because
 * no method does it.
 *
 * Retention is the one exception and it is deliberately NOT here: §14 asks for a
 * documented retention policy, and a `deleteOlderThan` sitting next to `append`
 * would be too easy to reach for when a row is inconvenient. If retention trimming
 * is added it belongs in a separate, obviously-named maintenance module.
 *
 * ── WHAT MAY GO IN `metadata` ──────────────────────────────────────────────
 * §16: no prompt text, no response text, no tool arguments or results, no
 * credential material, no plaintext API key. `metadata` is for operator context —
 * ids, amounts, statuses, classified reasons. `assertMetadataIsSafe` below rejects
 * the obvious mistakes at runtime; it is a guardrail, not a guarantee, and the real
 * protection is that callers pass small explicit objects.
 */

import { BosandaError } from "@bosanda/protocol";
import { type Executor, firstRow, jsonParam, requireRow } from "./executor.js";
import {
  type ActorType,
  type AuditEvent,
  type AuditEventRow,
  bigintToNumber,
  toAuditEvent,
} from "./rows.js";
import {
  type AuditFilter,
  type NormalizedAuditFilter,
  type Pagination,
  normalizeAuditFilter,
  normalizePagination,
} from "./decisions.js";

export type AppendAuditInput = {
  id: string;
  actorType: ActorType;
  /** Null for `system`, which has no user row. */
  actorId: string | null;
  /** Dotted action name, e.g. "order.activated", "api_key.revoked". */
  action: string;
  targetType: string | null;
  /** Not a CHAR(26) column — may be a model public_id or a provider event key. */
  targetId: string | null;
  /** Operator context only. See the header on what §16 forbids. */
  metadata: Record<string, unknown>;
  createdAt: Date;
};

/**
 * Keys that must never appear in audit metadata.
 *
 * A blocklist catches the realistic accident — someone passing a whole request or
 * response object into an audit call — without pretending to be exhaustive. §16
 * compliance rests on callers passing narrow objects; this makes the common failure
 * loud instead of silent.
 */
const FORBIDDEN_METADATA_KEYS: readonly string[] = [
  "prompt",
  "messages",
  "response",
  "completion",
  "content",
  "text",
  "tools",
  "toolArguments",
  "tool_arguments",
  "toolResult",
  "tool_result",
  "apiKey",
  "api_key",
  "password",
  "passwordHash",
  "password_hash",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "credentials",
  "encryptedKey",
  "encrypted_key",
  "clientSecret",
  "client_secret",
];

/**
 * Reject metadata carrying a forbidden key.
 *
 * Top level only. Deep inspection of arbitrary nesting would be both slow on a
 * write path and still incomplete, and it would suggest a stronger guarantee than
 * this provides.
 */
export function assertMetadataIsSafe(metadata: Record<string, unknown>, action: string): void {
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.includes(key)) {
      throw new BosandaError("internal_error", {
        internalDetail: `audit metadata for ${action} contains forbidden key ${key} (PLAN.md §16)`,
      });
    }
  }
}

export type AuditRepository = ReturnType<typeof auditRepository>;

export function auditRepository(sql: Executor) {
  return {
    /**
     * Append one event.
     *
     * Pass the `tx` whenever the audited change is itself transactional: §13 wants
     * the record of an activation to commit with the activation, so a crash cannot
     * produce a state change with no audit trail.
     */
    async append(input: AppendAuditInput): Promise<AuditEvent> {
      assertMetadataIsSafe(input.metadata, input.action);
      const rows = await sql<AuditEventRow[]>`
        INSERT INTO audit_events (
          id, actor_type, actor_id, action, target_type, target_id, metadata, created_at
        ) VALUES (
          ${input.id}, ${input.actorType}, ${input.actorId}, ${input.action},
          ${input.targetType}, ${input.targetId},
          ${sql.json(jsonParam(input.metadata, "audit_events.metadata"))},
          ${input.createdAt}
        )
        RETURNING *
      `;
      return toAuditEvent(requireRow(rows, "audit_events insert"));
    },

    /**
     * The filtered admin audit view (§15).
     *
     * Same construction as `ordersRepository.list`: one static template, every
     * optional predicate expressed as `(${value} IS NULL OR column = ${value})`, so
     * there is no fragment concatenation and no path by which a filter value becomes
     * SQL. `auditFilterPredicates` in `decisions.ts` names the predicates a filter
     * implies, so a test can catch one silently dropped from this query.
     *
     * Ordered newest-first to match all three indexes
     * (`audit_events_action_idx`, `_target_idx`, `_actor_idx`), each of which carries
     * `created_at DESC`.
     */
    async list(
      filter: AuditFilter = {},
      paging: Pagination = {},
    ): Promise<{ events: AuditEvent[]; filter: NormalizedAuditFilter }> {
      const normalized = normalizeAuditFilter(filter);
      const { limit, offset } = normalizePagination(paging);

      const rows = await sql<AuditEventRow[]>`
        SELECT * FROM audit_events
        WHERE (${normalized.actorType}::TEXT IS NULL OR actor_type = ${normalized.actorType})
          AND (${normalized.actorId}::TEXT IS NULL OR actor_id = ${normalized.actorId})
          AND (${normalized.action}::TEXT IS NULL OR action = ${normalized.action})
          AND (${normalized.targetType}::TEXT IS NULL OR target_type = ${normalized.targetType})
          AND (${normalized.targetId}::TEXT IS NULL OR target_id = ${normalized.targetId})
          AND (
            ${normalized.createdAfter}::TIMESTAMPTZ IS NULL
            OR created_at >= ${normalized.createdAfter}
          )
          AND (
            ${normalized.createdBefore}::TIMESTAMPTZ IS NULL
            OR created_at < ${normalized.createdBefore}
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      // The normalized filter is echoed back so the UI can show what was actually
      // applied — a blank search box dropped to null should be visible, not silent.
      return { events: rows.map(toAuditEvent), filter: normalized };
    },

    /** Count matching the same filter, for pagination controls. */
    async count(filter: AuditFilter = {}): Promise<number> {
      const normalized = normalizeAuditFilter(filter);
      const rows = await sql<{ total: string }[]>`
        SELECT COUNT(*)::TEXT AS total FROM audit_events
        WHERE (${normalized.actorType}::TEXT IS NULL OR actor_type = ${normalized.actorType})
          AND (${normalized.actorId}::TEXT IS NULL OR actor_id = ${normalized.actorId})
          AND (${normalized.action}::TEXT IS NULL OR action = ${normalized.action})
          AND (${normalized.targetType}::TEXT IS NULL OR target_type = ${normalized.targetType})
          AND (${normalized.targetId}::TEXT IS NULL OR target_id = ${normalized.targetId})
          AND (
            ${normalized.createdAfter}::TIMESTAMPTZ IS NULL
            OR created_at >= ${normalized.createdAfter}
          )
          AND (
            ${normalized.createdBefore}::TIMESTAMPTZ IS NULL
            OR created_at < ${normalized.createdBefore}
          )
      `;
      const row = firstRow(rows);
      return row === null ? 0 : bigintToNumber(row.total, "audit_events count");
    },

    /**
     * Everything recorded about one target — "what happened to this order/key".
     *
     * Uses `audit_events_target_idx (target_type, target_id, created_at DESC)`.
     */
    async listForTarget(
      targetType: string,
      targetId: string,
      paging: Pagination = {},
    ): Promise<AuditEvent[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<AuditEventRow[]>`
        SELECT * FROM audit_events
        WHERE target_type = ${targetType} AND target_id = ${targetId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toAuditEvent);
    },

    /**
     * Everything one actor did — "what has this admin been doing".
     *
     * Uses `audit_events_actor_idx (actor_type, actor_id, created_at DESC)`.
     */
    async listForActor(
      actorType: ActorType,
      actorId: string,
      paging: Pagination = {},
    ): Promise<AuditEvent[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<AuditEventRow[]>`
        SELECT * FROM audit_events
        WHERE actor_type = ${actorType} AND actor_id = ${actorId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toAuditEvent);
    },
  };
}
