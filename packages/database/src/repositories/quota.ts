/**
 * `quota_ledger` + the `api_keys.quota_remaining` balance (PLAN.md §10).
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE. §10, verbatim: "All quota changes use
 * an append-only ledger plus a transactionally maintained balance. No application
 * code may update a balance without a corresponding ledger entry."
 *
 * Therefore every method here writes BOTH the ledger row and the balance, in one
 * transaction, or neither. `api_keys.quota_remaining` is never updated anywhere
 * else in this package — grep for `quota_remaining` and the only writes outside
 * this file are the initial value on insert (`api-keys.ts`, which creates the key
 * and its grant row in the caller's transaction) and nothing else.
 *
 * ── THE BALANCE CLAMP ──────────────────────────────────────────────────────
 * §10 permits bounded negative overage; the schema forbids storing it
 * (`CHECK (quota_remaining >= 0)`, `CHECK (balance_after >= 0)`). The persisted
 * balance is therefore `max(0, trueBalance)`. The FULL debit is still written to
 * `weighted_tokens_delta`, which has no non-negative CHECK, so the true balance
 * remains reconstructible by summing deltas. `clampBalance` in `decisions.ts`
 * carries the complete argument; `recordDebit` reports `clamped: true` when it
 * fired so the caller can log the overage.
 *
 * ── TRANSACTION NESTING ────────────────────────────────────────────────────
 * `recordDebit` opens its own transaction when handed a pool, because its
 * atomicity IS its contract. To make the debit part of a LARGER transaction —
 * activation, an admin adjustment plus audit — pass the `tx` instead: `atomically`
 * then issues a SAVEPOINT rather than a second transaction, so the write commits
 * with the enclosing unit of work. See `atomically` in `executor.ts` for why the
 * two cases must be dispatched rather than assumed.
 */

import { BosandaError } from "@bosanda/protocol";
import { type Executor, atomically, firstRow, requireRow } from "./executor.js";
import { type QuotaLedgerEntry, type QuotaLedgerRow, toQuotaLedgerEntry } from "./rows.js";
import {
  type DebitOutcome,
  type Pagination,
  clampBalance,
  debitIsIdempotent,
  decideDebitOutcome,
  normalizePagination,
  wasClamped,
} from "./decisions.js";

/**
 * A settled request, as produced by `settle()` in `@bosanda/metering`.
 *
 * `remainingAfter` is the TRUE balance and may be negative — pass it through
 * unmodified. The clamp happens here, once, so no caller has to know about it.
 */
export type RecordDebitInput = {
  id: string;
  apiKeyId: string;
  /** Required: the partial unique index only protects rows that have one. */
  requestId: string;
  rawInputTokens: number;
  rawOutputTokens: number;
  /**
   * The multiplier as stored, e.g. "1.3000". Pass the STRING from
   * `ModelRecord.multiplier` to keep the ledger byte-identical to the model row
   * it was priced from (§9). A number is accepted and stringified for callers
   * holding only the parsed form.
   */
  multiplier: string | number;
  /** Weighted tokens consumed, non-negative. Persisted negated. */
  weightedTokens: number;
  /** True balance after the debit. May be negative; clamped on write. */
  remainingAfter: number;
  estimated: boolean;
  meterVersion: string;
  createdAt: Date;
};

export type RecordGrantInput = {
  id: string;
  apiKeyId: string;
  /** Required by `quota_ledger_grant_has_order`. */
  orderId: string;
  /** Weighted tokens credited, positive. */
  weightedTokens: number;
  /** Balance after crediting. */
  remainingAfter: number;
  meterVersion: string;
  createdAt: Date;
};

export type RecordAdjustmentInput = {
  id: string;
  apiKeyId: string;
  orderId: string | null;
  /** Signed. Positive credits, negative debits. */
  weightedTokensDelta: number;
  remainingAfter: number;
  meterVersion: string;
  createdAt: Date;
};

export type RecordExpiryInput = {
  id: string;
  apiKeyId: string;
  /** Signed; normally the negative of the remaining balance being withdrawn. */
  weightedTokensDelta: number;
  meterVersion: string;
  createdAt: Date;
};

export type QuotaRepository = ReturnType<typeof quotaRepository>;

export function quotaRepository(sql: Executor) {
  /**
   * Write the balance and return the row.
   *
   * Guarded on `quota_remaining <= quota_limit` implicitly by the CHECK; a
   * caller-computed balance above the limit is a bug in the decision layer and
   * the constraint will abort the transaction, which is the correct outcome.
   */
  const setBalance = async (
    executor: Executor,
    apiKeyId: string,
    balance: number,
  ): Promise<void> => {
    const rows = await executor<{ id: string }[]>`
      UPDATE api_keys SET quota_remaining = ${balance} WHERE id = ${apiKeyId} RETURNING id
    `;
    if (firstRow(rows) === null) {
      throw new BosandaError("not_found", {
        internalDetail: `api key ${apiKeyId} does not exist; balance not written`,
      });
    }
  };

  const insertLedgerRow = async (
    executor: Executor,
    values: {
      id: string;
      apiKeyId: string;
      orderId: string | null;
      requestId: string | null;
      kind: string;
      rawInputTokens: number;
      rawOutputTokens: number;
      multiplier: string | null;
      weightedTokensDelta: number;
      balanceAfter: number;
      estimated: boolean;
      meterVersion: string;
      createdAt: Date;
    },
  ): Promise<QuotaLedgerEntry> => {
    const rows = await executor<QuotaLedgerRow[]>`
      INSERT INTO quota_ledger (
        id, api_key_id, order_id, request_id, kind,
        raw_input_tokens, raw_output_tokens, multiplier,
        weighted_tokens_delta, balance_after, estimated, meter_version, created_at
      ) VALUES (
        ${values.id}, ${values.apiKeyId}, ${values.orderId}, ${values.requestId},
        ${values.kind}, ${values.rawInputTokens}, ${values.rawOutputTokens},
        ${values.multiplier}, ${values.weightedTokensDelta}, ${values.balanceAfter},
        ${values.estimated}, ${values.meterVersion}, ${values.createdAt}
      )
      RETURNING *
    `;
    return toQuotaLedgerEntry(requireRow(rows, `quota_ledger ${values.kind} insert`));
  };

  /**
   * Ledger row + balance, in whatever transaction the caller is already in.
   *
   * Used by every credit-side method. Debits go through `recordDebit`, which adds
   * the idempotency handling on top.
   */
  const writeMovement = async (
    executor: Executor,
    values: Parameters<typeof insertLedgerRow>[1],
  ): Promise<QuotaLedgerEntry> => {
    const entry = await insertLedgerRow(executor, values);
    await setBalance(executor, values.apiKeyId, values.balanceAfter);
    return entry;
  };

  return {
    /**
     * THE CRITICAL METHOD. Settle one request: append a `debit` row and move the
     * balance, atomically and idempotently.
     *
     * IDEMPOTENCY. `quota_ledger_request_debit_key` is
     * `UNIQUE (api_key_id, request_id) WHERE kind = 'debit' AND request_id IS NOT
     * NULL`. The insert is `ON CONFLICT DO NOTHING RETURNING *`, so a retried
     * settle collides instead of charging twice; on collision the pre-existing row
     * is read and returned with `status: "duplicate"`, and — critically — THE
     * BALANCE IS NOT TOUCHED. Updating the balance on a duplicate would
     * double-charge even though the ledger stayed correct, which is precisely the
     * bug the index is meant to prevent.
     *
     * ON CONFLICT is written with the index predicate spelled out
     * (`WHERE kind = 'debit' AND request_id IS NOT NULL`) because PostgreSQL only
     * infers a partial unique index when the statement's predicate matches the
     * index's.
     *
     * ORDERING. The ledger row is inserted FIRST, then the balance is written. A
     * failure between them rolls both back. The reverse order would leave a window
     * in which a crash produces a moved balance with no ledger entry — the exact
     * state §10 forbids.
     *
     * A duplicate returns `entry` from the original row, so a retrying worker
     * reads back the figures that were actually billed rather than the ones it
     * just recomputed. If those disagree, the original wins: it is what the
     * balance reflects.
     */
    async recordDebit(input: RecordDebitInput): Promise<DebitOutcome<QuotaLedgerEntry>> {
      if (!debitIsIdempotent(input.requestId)) {
        // Without a request id the partial index does not cover the row and a
        // retry would silently double-charge. Refuse rather than write an
        // unprotected debit.
        throw new BosandaError("internal_error", {
          internalDetail: `debit for key ${input.apiKeyId} has no request id; refusing an unprotected debit`,
        });
      }
      if (!Number.isInteger(input.weightedTokens) || input.weightedTokens < 0) {
        throw new BosandaError("internal_error", {
          internalDetail: `weightedTokens must be a non-negative integer, received ${input.weightedTokens}`,
        });
      }

      const balanceAfter = clampBalance(input.remainingAfter);
      const clamped = wasClamped(input.remainingAfter);
      // `quota_ledger_debit_is_negative` requires delta <= 0 for a debit.
      const delta = -input.weightedTokens;
      const multiplier =
        typeof input.multiplier === "number" ? String(input.multiplier) : input.multiplier;

      return atomically(sql, async (tx) => {
        const inserted = await tx<QuotaLedgerRow[]>`
          INSERT INTO quota_ledger (
            id, api_key_id, order_id, request_id, kind,
            raw_input_tokens, raw_output_tokens, multiplier,
            weighted_tokens_delta, balance_after, estimated, meter_version, created_at
          ) VALUES (
            ${input.id}, ${input.apiKeyId}, NULL, ${input.requestId}, 'debit',
            ${input.rawInputTokens}, ${input.rawOutputTokens}, ${multiplier},
            ${delta}, ${balanceAfter}, ${input.estimated},
            ${input.meterVersion}, ${input.createdAt}
          )
          ON CONFLICT (api_key_id, request_id) WHERE kind = 'debit' AND request_id IS NOT NULL
          DO NOTHING
          RETURNING *
        `;

        const insertedRow = firstRow(inserted);
        if (insertedRow !== null) {
          await setBalance(tx, input.apiKeyId, balanceAfter);
          return decideDebitOutcome(toQuotaLedgerEntry(insertedRow), null, {
            apiKeyId: input.apiKeyId,
            requestId: input.requestId,
            clamped,
          });
        }

        // Conflict: a debit for this (key, request) already exists. Return it and
        // leave the balance alone.
        const existing = await tx<QuotaLedgerRow[]>`
          SELECT * FROM quota_ledger
          WHERE api_key_id = ${input.apiKeyId}
            AND request_id = ${input.requestId}
            AND kind = 'debit'
        `;
        const existingRow = firstRow(existing);
        return decideDebitOutcome(
          null,
          existingRow === null ? null : toQuotaLedgerEntry(existingRow),
          { apiKeyId: input.apiKeyId, requestId: input.requestId, clamped },
        );
      });
    },

    /**
     * The `grant` row for a newly activated key (§13 step 8).
     *
     * Almost always called with the activation `tx`: the key row, this ledger row,
     * the stock commit, and the order transition must commit together.
     * `executeActivation` in `activation.ts` does exactly that and is the intended
     * entry point.
     *
     * No balance write: `api_keys.insert` already set `quota_remaining` to the
     * granted figure in the same transaction, so writing it again would be
     * redundant. `balance_after` records it, which keeps the ledger self-describing.
     */
    async recordGrant(input: RecordGrantInput): Promise<QuotaLedgerEntry> {
      return insertLedgerRow(sql, {
        id: input.id,
        apiKeyId: input.apiKeyId,
        orderId: input.orderId,
        requestId: null,
        kind: "grant",
        rawInputTokens: 0,
        rawOutputTokens: 0,
        multiplier: null,
        weightedTokensDelta: input.weightedTokens,
        balanceAfter: clampBalance(input.remainingAfter),
        estimated: false,
        meterVersion: input.meterVersion,
        createdAt: input.createdAt,
      });
    },

    /**
     * The `top_up` row plus the new balance (§11 top-up rules).
     *
     * Unlike `recordGrant` this DOES write the balance: the key already exists and
     * its `quota_remaining` must move. `quota_limit` is the caller's to update in
     * the same transaction — `executeActivation` does so — because
     * `api_keys_remaining_within_limit` would otherwise reject a raised remaining
     * against an unchanged limit.
     */
    async recordTopUp(input: RecordGrantInput): Promise<QuotaLedgerEntry> {
      return writeMovement(sql, {
        id: input.id,
        apiKeyId: input.apiKeyId,
        orderId: input.orderId,
        requestId: null,
        kind: "top_up",
        rawInputTokens: 0,
        rawOutputTokens: 0,
        multiplier: null,
        weightedTokensDelta: input.weightedTokens,
        balanceAfter: clampBalance(input.remainingAfter),
        estimated: false,
        meterVersion: input.meterVersion,
        createdAt: input.createdAt,
      });
    },

    /**
     * A manual `adjustment` (§13: "revocation or quota adjustment is recorded as a
     * ledger entry, never by deleting history").
     *
     * The delta is unconstrained in sign — `quota_ledger_debit_is_negative` exempts
     * `adjustment` precisely so a compensating entry can go either way. The caller
     * supplies the resulting balance because only it knows the state it read under
     * the lock.
     */
    async recordAdjustment(input: RecordAdjustmentInput): Promise<QuotaLedgerEntry> {
      return writeMovement(sql, {
        id: input.id,
        apiKeyId: input.apiKeyId,
        orderId: input.orderId,
        requestId: null,
        kind: "adjustment",
        rawInputTokens: 0,
        rawOutputTokens: 0,
        multiplier: null,
        weightedTokensDelta: input.weightedTokensDelta,
        balanceAfter: clampBalance(input.remainingAfter),
        estimated: false,
        meterVersion: input.meterVersion,
        createdAt: input.createdAt,
      });
    },

    /**
     * The `expiry` row written when a key lapses (§11: 24h validity).
     *
     * Balance goes to 0 unconditionally: the key is dead, and leaving a positive
     * `quota_remaining` on an expired key would make the dashboard claim the
     * customer still has quota they cannot spend. The withdrawn amount is preserved
     * in `weighted_tokens_delta`, so the expiry is auditable.
     */
    async recordExpiry(input: RecordExpiryInput): Promise<QuotaLedgerEntry> {
      return writeMovement(sql, {
        id: input.id,
        apiKeyId: input.apiKeyId,
        orderId: null,
        requestId: null,
        kind: "expiry",
        rawInputTokens: 0,
        rawOutputTokens: 0,
        multiplier: null,
        weightedTokensDelta: input.weightedTokensDelta,
        balanceAfter: 0,
        estimated: false,
        meterVersion: input.meterVersion,
        createdAt: input.createdAt,
      });
    },

    /**
     * A key's ledger, newest first — the billing-dispute answer (§10: "every debit
     * and credit is reconstructible").
     *
     * Ordered to match `quota_ledger_api_key_id_idx (api_key_id, created_at DESC)`.
     */
    async ledgerForKey(apiKeyId: string, paging: Pagination = {}): Promise<QuotaLedgerEntry[]> {
      const { limit, offset } = normalizePagination(paging);
      const rows = await sql<QuotaLedgerRow[]>`
        SELECT * FROM quota_ledger
        WHERE api_key_id = ${apiKeyId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toQuotaLedgerEntry);
    },

    /** The existing debit for a (key, request), if a settle already landed. */
    async findDebit(apiKeyId: string, requestId: string): Promise<QuotaLedgerEntry | null> {
      const rows = await sql<QuotaLedgerRow[]>`
        SELECT * FROM quota_ledger
        WHERE api_key_id = ${apiKeyId} AND request_id = ${requestId} AND kind = 'debit'
      `;
      const row = firstRow(rows);
      return row === null ? null : toQuotaLedgerEntry(row);
    },

    /**
     * Sum of every delta for a key — the TRUE balance, unclamped.
     *
     * This is the reconciliation query the clamp makes necessary: it recovers the
     * real figure (possibly negative) that `quota_remaining` floors at 0. Returns 0
     * for a key with no ledger rows.
     */
    async trueBalance(apiKeyId: string): Promise<number> {
      const rows = await sql<{ total: string | null }[]>`
        SELECT COALESCE(SUM(weighted_tokens_delta), 0)::TEXT AS total
        FROM quota_ledger
        WHERE api_key_id = ${apiKeyId}
      `;
      const row = firstRow(rows);
      if (row === null || row.total === null) return 0;
      return Number(row.total);
    },

    /**
     * Read a key's quota columns FOR UPDATE.
     *
     * §16 invariant 5 and §11 ("quota and expiry changes are atomic with order
     * activation") require the read that a decision is based on to be locked
     * against a concurrent settle. `decideActivation` and `validateTopUp` both
     * document that the caller reads under the same lock it will write through —
     * this is that read. Only meaningful inside a transaction; on a pool handle the
     * lock releases immediately and the call is pointless.
     */
    async lockKeyForUpdate(apiKeyId: string): Promise<{
      keyId: string;
      status: string;
      remaining: number;
      quotaLimit: number;
      expiresAt: Date;
    } | null> {
      const rows = await sql<
        {
          id: string;
          status: string;
          quota_remaining: string;
          quota_limit: string;
          expires_at: Date;
        }[]
      >`
        SELECT id, status, quota_remaining, quota_limit, expires_at
        FROM api_keys
        WHERE id = ${apiKeyId}
        FOR UPDATE
      `;
      const row = firstRow(rows);
      if (row === null) return null;
      return {
        keyId: row.id,
        status: row.status,
        remaining: Number(row.quota_remaining),
        quotaLimit: Number(row.quota_limit),
        expiresAt: row.expires_at,
      };
    },
  };
}
