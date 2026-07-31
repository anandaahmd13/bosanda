/**
 * The decision logic the repositories execute, extracted so it is testable
 * without a PostgreSQL instance.
 *
 * Everything here is PURE. The repositories in this directory are thin: they
 * build a parameterized statement, call one of these functions to interpret the
 * result, and return. That split is what lets the rules below — the balance
 * clamp, the CAS outcomes, the idempotency verdicts, the admin filter semantics —
 * be covered by unit tests, while the untestable part (does this SQL do what the
 * comment says) stays small enough to review by eye.
 */

import { BosandaError } from "@bosanda/protocol";

// ───────────────────────── the balance clamp ─────────────────────────

/**
 * THE CLAMP, and why it exists.
 *
 * PLAN.md §10 explicitly permits bounded negative overage: a request may start
 * whenever remaining > 0, an already-started stream always finishes, so with up
 * to five concurrent streams the true balance can settle below zero.
 * `worstCaseOverage()` in `@bosanda/metering` computes that floor, and
 * `settle()` returns a `remainingAfter` that may be negative.
 *
 * The schema does not allow storing it. Both columns forbid it:
 *
 *   api_keys.quota_remaining     BIGINT NOT NULL CHECK (quota_remaining >= 0)
 *   quota_ledger.balance_after   BIGINT NOT NULL CHECK (balance_after >= 0)
 *
 * The schema is immutable after release (§14), so this layer cannot widen the
 * constraint, and writing a negative value would abort the transaction — losing
 * the debit entirely, which is strictly worse than under-recording it.
 *
 * THE RULE: the persisted balance is `max(0, trueBalance)`. Both the ledger row
 * and the key balance are clamped, and they are clamped identically, so
 * `balance_after` always equals the `quota_remaining` written in the same
 * transaction.
 *
 * WHAT IS LOST, stated plainly: the magnitude of the overage is not recoverable
 * from the balance columns. What IS preserved is the full debit —
 * `weighted_tokens_delta` is written unclamped (it has no non-negative CHECK),
 * and `usage_events.weighted_tokens` records the same figure. So the true
 * balance is always reconstructible by summing deltas, and the overage is
 * derivable as `clampedBalance - (previousBalance + delta)`. Nothing is
 * unaccounted for; only the denormalized cache is floored.
 *
 * WHAT IS NOT AFFECTED: enforcement. §10 rejects new requests once remaining is
 * "zero or negative", and `canStartRequest` rejects on `remaining <= 0`. Zero and
 * a negative number are the same answer, so clamping cannot let a request through
 * that the true balance would have refused.
 */
export function clampBalance(trueBalance: number): number {
  return Math.max(0, trueBalance);
}

/** True when the clamp actually discarded overage. Worth logging when so. */
export function wasClamped(trueBalance: number): boolean {
  return trueBalance < 0;
}

/** How much overage the clamp hid, as a non-negative magnitude. 0 when none. */
export function clampedOverage(trueBalance: number): number {
  return trueBalance < 0 ? -trueBalance : 0;
}

// ───────────────────────── debit idempotency ─────────────────────────

/**
 * The outcome of `recordDebit`.
 *
 * `recorded` means this call wrote the ledger row and moved the balance.
 * `duplicate` means the unique partial index `quota_ledger_request_debit_key`
 * already held a debit for (api_key_id, request_id) — a retried settle — so
 * nothing was written and the pre-existing row is returned instead.
 *
 * A duplicate is NOT an error. §13 requires activation and settlement to be
 * idempotent, and a worker that crashes between committing a debit and
 * acknowledging its job will legitimately retry. The caller wants the recorded
 * figure, not an exception.
 */
export type DebitOutcome<T> =
  | { status: "recorded"; entry: T; /** True when overage was floored to 0. */ clamped: boolean }
  | { status: "duplicate"; entry: T };

/**
 * Interpret the result of the `INSERT ... ON CONFLICT DO NOTHING RETURNING *`
 * that opens `recordDebit`.
 *
 * `inserted` is the RETURNING row (null when the conflict fired). `existing` is
 * the follow-up SELECT, consulted only on conflict. A conflict with no existing
 * row is impossible — the index is what caused the conflict — so it is reported
 * as an internal error rather than papered over.
 */
export function decideDebitOutcome<T>(
  inserted: T | null,
  existing: T | null,
  context: { apiKeyId: string; requestId: string; clamped: boolean },
): DebitOutcome<T> {
  if (inserted !== null) {
    return { status: "recorded", entry: inserted, clamped: context.clamped };
  }
  if (existing === null) {
    throw new BosandaError("internal_error", {
      internalDetail: `debit for key ${context.apiKeyId} request ${context.requestId} conflicted but no existing row was found`,
    });
  }
  return { status: "duplicate", entry: existing };
}

/**
 * Whether a settle is even eligible to be recorded idempotently.
 *
 * The unique index is PARTIAL: `WHERE kind = 'debit' AND request_id IS NOT NULL`.
 * A debit written without a request_id therefore has NO idempotency protection
 * and a retry would double-charge. Rather than let that happen quietly,
 * `recordDebit` requires a request id and this predicate names the reason.
 */
export function debitIsIdempotent(requestId: string | null): boolean {
  return requestId !== null && requestId.length > 0;
}

// ───────────────────────── usage-event idempotency ─────────────────────────

/**
 * `usage_events.request_id` is UNIQUE (not partial), so the same reasoning as
 * debits applies with one difference: there is exactly one row per request, and a
 * retry is always a duplicate.
 */
export type InsertOutcome<T> = { status: "inserted" | "duplicate"; row: T };

export function decideInsertOutcome<T>(
  inserted: T | null,
  existing: T | null,
  what: string,
): InsertOutcome<T> {
  if (inserted !== null) return { status: "inserted", row: inserted };
  if (existing === null) {
    throw new BosandaError("internal_error", {
      internalDetail: `${what} conflicted but no existing row was found`,
    });
  }
  return { status: "duplicate", row: existing };
}

// ───────────────────────── stock compare-and-swap ─────────────────────────

/**
 * The outcome of a stock CAS.
 *
 * A failed CAS is a RETURNED VALUE, not a thrown error, because it is an expected
 * outcome under contention: two buyers racing for the last unit means one of them
 * must lose, and the caller's response depends on which reason applied. Throwing
 * would force every call site into a try/catch that has to re-read the message to
 * decide between "retry" and "sold out".
 *
 *   * `ok`             — the update applied; `version` is the new counter value.
 *   * `version_conflict` — someone else moved the row between our read and our
 *                        write. The caller SHOULD re-read and retry; nothing is
 *                        wrong.
 *   * `insufficient`   — the arithmetic would break a CHECK (no free unit to
 *                        reserve, or more reserved units released than are held).
 *                        Retrying will not help; this is a 409 to the customer.
 *   * `missing`        — no `package_stock` row for that package. An operator has
 *                        not set stock for the size (§11 "manually managed").
 *
 * The distinction between `version_conflict` and `insufficient` matters and is why
 * the statements below re-read on failure instead of reporting a bare "0 rows
 * updated": those two are indistinguishable from the update count alone, and
 * retrying an `insufficient` forever would spin.
 */
export type StockCasOutcome =
  | { ok: true; version: number; available: number; reserved: number }
  | { ok: false; reason: "version_conflict" | "insufficient" | "missing" };

/**
 * Classify a failed CAS from the row as it stands after the attempt.
 *
 * `observed` is a fresh read (null when the row does not exist). `expectedVersion`
 * is what the caller compared against. If the version moved, it was a race; if it
 * did not, the row is unchanged and the guard clause in the WHERE is what rejected
 * us, so the counts are genuinely insufficient.
 */
export function classifyStockFailure(
  observed: { version: number } | null,
  expectedVersion: number,
): StockCasOutcome {
  if (observed === null) return { ok: false, reason: "missing" };
  if (observed.version !== expectedVersion) return { ok: false, reason: "version_conflict" };
  return { ok: false, reason: "insufficient" };
}

/**
 * Can `units` be reserved right now? Mirrors the SQL guard so the same rule is
 * checkable in a test.
 *
 * §11 reserves against FREE stock (available - reserved), not against
 * `available`, so a unit already held by another pending order cannot be promised
 * twice.
 */
export function canReserve(stock: { available: number; reserved: number }, units: number): boolean {
  if (!Number.isInteger(units) || units < 1) return false;
  return stock.available - stock.reserved >= units;
}

/** Can `units` be released? Only what is actually held may be given back. */
export function canRelease(stock: { reserved: number }, units: number): boolean {
  if (!Number.isInteger(units) || units < 1) return false;
  return stock.reserved >= units;
}

/**
 * Can a reservation be committed (turned into a real decrement)?
 *
 * A commit decrements BOTH counters: the unit leaves `available` because it has
 * been sold, and leaves `reserved` because it is no longer merely held. Both must
 * therefore be large enough, or a CHECK would abort.
 */
export function canCommit(stock: { available: number; reserved: number }, units: number): boolean {
  if (!Number.isInteger(units) || units < 1) return false;
  return stock.available >= units && stock.reserved >= units;
}

// ───────────────────────── credential rotation CAS ─────────────────────────

/**
 * The outcome of a credential rotation.
 *
 * §6 single-flight refresh: two workers may both notice an expiring token. The
 * loser must learn that it lost and re-read, not overwrite a newer credential
 * with an older one — hence the same returned-outcome shape as stock.
 */
export type RotateOutcome =
  | { ok: true; credentialVersion: number }
  | { ok: false; reason: "version_conflict" | "missing"; currentVersion: number | null };

export function classifyRotateFailure(
  observed: { credentialVersion: number } | null,
): RotateOutcome {
  if (observed === null) return { ok: false, reason: "missing", currentVersion: null };
  return {
    ok: false,
    reason: "version_conflict",
    currentVersion: observed.credentialVersion,
  };
}

// ───────────────────────── pagination ─────────────────────────

/** Hard ceiling on any list page, so a caller cannot ask for the whole table. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export type Pagination = { limit?: number; offset?: number };

/**
 * Normalize caller-supplied paging into safe integers.
 *
 * Clamped rather than rejected: a dashboard passing `limit=1000` should get the
 * maximum page, not an error. Non-integers and negatives fall back to defaults.
 * These values are interpolated through the SQL tag like any other parameter —
 * the normalization is about sane behaviour, not injection defence.
 */
export function normalizePagination(input: Pagination = {}): { limit: number; offset: number } {
  const requestedLimit = input.limit;
  const requestedOffset = input.offset;

  const limit =
    typeof requestedLimit === "number" && Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const offset =
    typeof requestedOffset === "number" && Number.isInteger(requestedOffset) && requestedOffset > 0
      ? requestedOffset
      : 0;

  return { limit, offset };
}

// ───────────────────────── admin order filters ─────────────────────────

/**
 * The admin order list filters (§15 "View and reconcile Pakasir orders").
 *
 * Every field is optional and absent means "no constraint". `normalizeOrderFilter`
 * below turns a caller's loose input into this canonical shape, and the repository
 * builds its WHERE from the canonical form — so a test can assert which
 * predicates a given filter implies without executing SQL.
 */
export type OrderFilter = {
  userId?: string;
  status?: readonly string[];
  type?: string;
  provider?: string;
  providerTransactionId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
};

export type NormalizedOrderFilter = {
  userId: string | null;
  /** Empty array means no status constraint. */
  statuses: string[];
  type: string | null;
  provider: string | null;
  providerTransactionId: string | null;
  createdAfter: Date | null;
  createdBefore: Date | null;
};

const trimmedOrNull = (value: string | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const dateOrNull = (value: Date | undefined): Date | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

/**
 * Canonicalize a filter: blank strings become null (an empty search box must not
 * become `WHERE user_id = ''`), unknown statuses are dropped, and an invalid Date
 * is ignored rather than turned into a NaN bound.
 */
export function normalizeOrderFilter(
  filter: OrderFilter = {},
  allowedStatuses: readonly string[] = [],
): NormalizedOrderFilter {
  const requested = filter.status ?? [];
  const statuses =
    allowedStatuses.length === 0
      ? [...new Set(requested)]
      : [...new Set(requested.filter((status) => allowedStatuses.includes(status)))];

  return {
    userId: trimmedOrNull(filter.userId),
    statuses,
    type: trimmedOrNull(filter.type),
    provider: trimmedOrNull(filter.provider),
    providerTransactionId: trimmedOrNull(filter.providerTransactionId),
    createdAfter: dateOrNull(filter.createdAfter),
    createdBefore: dateOrNull(filter.createdBefore),
  };
}

/**
 * Which predicates a normalized filter implies, in a stable order.
 *
 * Exists purely so the WHERE clause is assertable in a unit test: the repository
 * builds fragments from exactly these keys, so a test that checks this list
 * catches a filter silently dropped from the query. It contains no SQL and no
 * values.
 */
export function orderFilterPredicates(filter: NormalizedOrderFilter): string[] {
  const predicates: string[] = [];
  if (filter.userId !== null) predicates.push("user_id");
  if (filter.statuses.length > 0) predicates.push("status");
  if (filter.type !== null) predicates.push("type");
  if (filter.provider !== null) predicates.push("provider");
  if (filter.providerTransactionId !== null) predicates.push("provider_transaction_id");
  if (filter.createdAfter !== null) predicates.push("created_at >=");
  if (filter.createdBefore !== null) predicates.push("created_at <");
  return predicates;
}

// ───────────────────────── audit filters ─────────────────────────

export type AuditFilter = {
  actorType?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
};

export type NormalizedAuditFilter = {
  actorType: string | null;
  actorId: string | null;
  action: string | null;
  targetType: string | null;
  targetId: string | null;
  createdAfter: Date | null;
  createdBefore: Date | null;
};

export function normalizeAuditFilter(filter: AuditFilter = {}): NormalizedAuditFilter {
  return {
    actorType: trimmedOrNull(filter.actorType),
    actorId: trimmedOrNull(filter.actorId),
    action: trimmedOrNull(filter.action),
    targetType: trimmedOrNull(filter.targetType),
    targetId: trimmedOrNull(filter.targetId),
    createdAfter: dateOrNull(filter.createdAfter),
    createdBefore: dateOrNull(filter.createdBefore),
  };
}

export function auditFilterPredicates(filter: NormalizedAuditFilter): string[] {
  const predicates: string[] = [];
  if (filter.actorType !== null) predicates.push("actor_type");
  if (filter.actorId !== null) predicates.push("actor_id");
  if (filter.action !== null) predicates.push("action");
  if (filter.targetType !== null) predicates.push("target_type");
  if (filter.targetId !== null) predicates.push("target_id");
  if (filter.createdAfter !== null) predicates.push("created_at >=");
  if (filter.createdBefore !== null) predicates.push("created_at <");
  return predicates;
}

// ───────────────────────── authentication verdict ─────────────────────────

/**
 * Why an authenticated key lookup failed, or that it succeeded.
 *
 * `user_suspended` is a distinct reason because §12 requires a suspended
 * account's keys to stop working, and an operator debugging "my key stopped"
 * needs to know which of the two applied. All of these collapse to the same
 * client-visible error at the gateway — the distinction is operator-only (§16).
 *
 * Note what is NOT decided here: quota. `canStartRequest` in
 * `@bosanda/metering` owns remaining-quota and expiry enforcement, and this
 * layer does not duplicate it. This function answers only "is this key and its
 * owner in a state where authentication should succeed".
 */
export type KeyAuthVerdict =
  | { ok: true }
  | { ok: false; reason: "unknown_key" | "key_revoked" | "key_expired" | "user_suspended" };

export function decideKeyAuth(
  found: { key: { status: string }; userStatus: string } | null,
): KeyAuthVerdict {
  if (found === null) return { ok: false, reason: "unknown_key" };
  if (found.userStatus === "suspended") return { ok: false, reason: "user_suspended" };
  if (found.key.status === "revoked") return { ok: false, reason: "key_revoked" };
  if (found.key.status === "expired") return { ok: false, reason: "key_expired" };
  return { ok: true };
}
