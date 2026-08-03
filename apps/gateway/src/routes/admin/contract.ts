/**
 * Request validation and the database↔admin vocabulary projection (PLAN.md §15, §16).
 *
 * ── WHY VALIDATION LIVES HERE AND NOT IN `decisions.ts` ───────────────────
 * `normalizePagination` CLAMPS an out-of-range limit and `normalizeOrderFilter` silently
 * DROPS an unknown status. That is right for a worker sweeping rows, where a bad value
 * should not stall a queue — but wrong for an operator console. An admin who filters by
 * `status=activated` (not a real status) and sees the unfiltered list has been told
 * something false about the system they are about to change. So the route layer rejects
 * first, and only then hands a known-good filter to the repository.
 *
 * Every rejection is `invalid_request` (400) and names the PARAMETER, never the value:
 * a query string is caller-controlled and echoing it back is reflected content.
 *
 * ── WHY THE PROJECTIONS ARE EXPLICIT AND NOT CASTS ────────────────────────
 * The database and the admin client disagree on the spelling of five enums. A cast would
 * compile and ship a response that `apps/admin`'s `.strict()` zod schemas reject at
 * runtime — the dashboard would show an error for a working backend. Each mapping below
 * is total and named, so an unmapped value is a compile error rather than a 500 in
 * production. Where the two vocabularies genuinely have different cardinality the choice
 * is documented at the mapping, because there is no correct answer to record, only a
 * defensible one.
 */

import { BosandaError } from "@bosanda/protocol";
import { ORDER_STATUS_VALUES } from "@bosanda/database";
import type {
  ApiKeyStatus,
  CompatibilityStatus,
  LedgerKind,
  OrderStatus,
  ProviderAccountStatus,
  UserRole,
  UserStatus,
} from "@bosanda/database";

/**
 * Rejects a bad parameter without quoting its value.
 *
 * ── WHY THE OPERATOR DOES NOT SEE WHICH PARAMETER WAS WRONG ───────────────
 * `BosandaError` derives `publicMessage` from the code alone and offers no override —
 * `errors.ts` is explicit that this is what stops "upstream text, credential, or payload"
 * reaching a client. So the response says "The request was invalid." and the parameter
 * name plus the expectation go to `internalDetail`, which is logged and never sent.
 *
 * That is a worse operator experience than a targeted message would be, and it is the
 * frozen taxonomy's deliberate trade. Working around it (a bare `reply.send` with a
 * hand-built body, say) would put a second error envelope shape on the wire and bypass the
 * one `setErrorHandler` that guarantees no internal detail escapes. Not worth it for a
 * field label.
 */
export function invalid(parameter: string, expectation: string): BosandaError {
  return new BosandaError("invalid_request", {
    internalDetail: `admin request rejected: ${parameter} ${expectation}`,
  });
}

/* ────────────────────────────── query strings ────────────────────────────── */

/**
 * `MAX_PAGE_SIZE` from `decisions.ts`, repeated as the REJECTION threshold.
 *
 * Not imported: there it is the clamp ceiling, here it is the boundary of what a caller
 * may ask for. The values coinciding is intentional; the meanings differ, and importing
 * would imply the route clamps.
 */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

export type Paging = { limit: number; offset: number };

/**
 * Parses a query string against an exact allowlist.
 *
 * An unknown key is a 400. That is the whole point of the function: the admin client
 * sends a fixed set of parameters per endpoint, so anything else is either a typo in a
 * hand-edited URL (the operator wants to know) or someone probing (they learn nothing).
 * Fastify parses a repeated key into an array, which is also rejected — a filter applied
 * twice with two values has no defined meaning.
 */
export function readQuery(raw: unknown, allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object") throw invalid("query", "must be a set of key/value pairs");

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      throw invalid(key, `is not a recognized parameter (expected one of: ${allowed.join(", ")})`);
    }
    if (Array.isArray(value)) throw invalid(key, "must not be repeated");
    if (typeof value !== "string") throw invalid(key, "must be a string");
    // An explicitly empty value is dropped rather than rejected: the client omits a
    // filter by not sending it, but a form that posts an empty box means the same thing.
    if (value.length > 0) out.set(key, value);
  }
  return out;
}

/** `limit`/`offset`, rejected rather than clamped. */
export function readPaging(query: Map<string, string>): Paging {
  return {
    limit: readInt(query, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: readInt(query, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function readInt(
  query: Map<string, string>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = query.get(key);
  if (raw === undefined) return fallback;

  // `Number()` accepts "1e3", " 12 ", and "0x10"; a page size is a plain decimal integer
  // and anything else is a caller error worth surfacing.
  if (!/^\d+$/.test(raw)) throw invalid(key, "must be a non-negative integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(key, `must be between ${min} and ${max}`);
  }
  return value;
}

/** A free-text search term, length-bounded so one request cannot force a huge scan. */
export function readSearch(query: Map<string, string>, key = "q"): string | undefined {
  const raw = query.get(key);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 128) throw invalid(key, "must be at most 128 characters");
  return trimmed;
}

/* ────────────────────────────── request bodies ───────────────────────────── */

/**
 * `reason`, which the client sends on nearly every mutation.
 *
 * Required and non-blank wherever the client sends it: §15 exists so an operator action
 * is explicable months later, and an audit row whose reason is `""` is indistinguishable
 * from one that was never recorded. Bounded at 500 characters because it is persisted in
 * audit metadata and an unbounded field is an append-only-table growth vector.
 */
export const MAX_REASON_LENGTH = 500;

export function readBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("body", "must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw invalid(key, `is not a recognized field (expected one of: ${allowed.join(", ")})`);
    }
  }
  return body;
}

export function readReason(body: Record<string, unknown>): string {
  const raw = body["reason"];
  if (typeof raw !== "string") throw invalid("reason", "is required and must be a string");
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw invalid("reason", "must not be blank");
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw invalid("reason", `must be at most ${MAX_REASON_LENGTH} characters`);
  }
  return trimmed;
}

export function readBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw invalid(key, "must be a boolean");
  return value;
}

export function readString(
  body: Record<string, unknown>,
  key: string,
  options: { max?: number; min?: number } = {},
): string {
  const value = body[key];
  if (typeof value !== "string") throw invalid(key, "must be a string");
  const min = options.min ?? 1;
  const max = options.max ?? 200;
  if (value.length < min) throw invalid(key, `must be at least ${min} characters`);
  if (value.length > max) throw invalid(key, `must be at most ${max} characters`);
  return value;
}

export function readInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalid(key, "must be an integer");
  }
  if (value < min || value > max) throw invalid(key, `must be between ${min} and ${max}`);
  return value;
}

/**
 * A rate multiplier: positive, finite, and at most 4 decimal places.
 *
 * The column is `NUMERIC(10,4)`. A value with more precision would be silently rounded
 * by PostgreSQL, so the operator would see a different number than they typed on the
 * next page load — and that number meters real money.
 */
export function readMultiplier(body: Record<string, unknown>): number {
  const value = body["multiplier"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid("multiplier", "must be a finite number");
  }
  if (value <= 0) throw invalid("multiplier", "must be greater than zero");
  if (value > 999_999) throw invalid("multiplier", "must be at most 999999");
  if (Math.round(value * 10_000) !== value * 10_000) {
    throw invalid("multiplier", "must have at most 4 decimal places");
  }
  return value;
}

/** A path parameter. Rejected when absent or absurdly long, never echoed. */
export function readParam(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(key, "is required");
  }
  if (value.length > 128) throw invalid(key, "is too long");
  return value;
}

/* ──────────────────────── enum projections (both ways) ───────────────────── */

/**
 * `users.role`: database `customer` ↔ admin `user`.
 *
 * The admin schema spells the non-operator role `user`; the database spells it
 * `customer`. Same concept, two names, and `adminUser.role` is `z.enum(["user","admin"])`
 * so sending `customer` fails validation in the dashboard.
 */
export function toAdminRole(role: UserRole): "user" | "admin" {
  return role === "admin" ? "admin" : "user";
}

/**
 * `users.status`: database `suspended` ↔ admin `disabled`.
 *
 * `setUserEnabled({enabled})` is the only writer, so the mapping is used in both
 * directions and must agree with itself: `enabled: false` writes `suspended`, which
 * reads back as `disabled`.
 */
export function toAdminUserStatus(status: UserStatus): "active" | "disabled" {
  return status === "active" ? "active" : "disabled";
}

export function fromAdminEnabled(enabled: boolean): UserStatus {
  return enabled ? "active" : "suspended";
}

/**
 * `api_keys.status` plus the DERIVED `exhausted`.
 *
 * `exhausted` is not a stored status — the CHECK constraint permits only
 * `active|revoked|expired`. The admin schema has it because an operator looking at a key
 * with a zero balance needs to see why it is failing, and "active" would be misleading:
 * the key authenticates fine and every request is refused. So it is computed from the
 * balance, and only for a key that is otherwise active. Revoked and expired keep their
 * stored status regardless of balance, because those are the reasons that actually
 * stopped the key.
 */
export function toAdminKeyStatus(
  status: ApiKeyStatus,
  quotaRemaining: number,
): "active" | "revoked" | "expired" | "exhausted" {
  if (status === "revoked") return "revoked";
  if (status === "expired") return "expired";
  return quotaRemaining <= 0 ? "exhausted" : "active";
}

/**
 * `models.compatibility_status`: four database values onto three admin values.
 *
 * `untested` → `unknown` is a rename. `degraded` has NO admin spelling, and the choice
 * is load-bearing: `modelsRepository.setPublished` treats `degraded` as PUBLISHABLE
 * (`compatibility_status IN ('passing','degraded')`), so a degraded model is one the
 * system is willing to serve. Reporting it as `failing` would tell an operator the model
 * is broken while it serves traffic, and they might disable a working model; reporting
 * `passing` overstates confidence but agrees with what the system does with it. Chosen
 * `passing`, because a status field that contradicts the publish gate is worse than one
 * that is coarse. The precise value stays visible in `provider_health_events`.
 */
export function toAdminCompatibility(
  status: CompatibilityStatus,
): "unknown" | "passing" | "failing" {
  switch (status) {
    case "untested":
      return "unknown";
    case "passing":
    case "degraded":
      return "passing";
    case "failing":
      return "failing";
  }
}

/**
 * `provider_accounts.status` → admin `accountStatus`.
 *
 * `@bosanda/database` already exports `toAccountStatus` for exactly this and it produces
 * the admin spellings (`cooldown` → `cooling_down`, `invalid` → `credential_invalid`).
 * Re-declared here only as a typed re-expression so this module holds the full mapping
 * table in one readable place; the implementation defers to the frozen function.
 */
export type AdminAccountStatus = "active" | "disabled" | "cooling_down" | "credential_invalid";

export function toAdminAccountStatus(status: ProviderAccountStatus): AdminAccountStatus {
  switch (status) {
    case "active":
      return "active";
    case "cooldown":
      return "cooling_down";
    case "disabled":
      return "disabled";
    case "invalid":
      return "credential_invalid";
  }
}

/**
 * `quota_ledger.kind`: six database kinds onto five admin kinds.
 *
 * `grant` → `purchase` and `debit` → `usage` are renames of the same event. `refund` has
 * no admin spelling and becomes `adjustment`: both are operator-initiated corrections
 * with a signed delta, and the ledger row's sign plus its `order_id` still distinguish
 * them for anyone reading the table. Mapping it to `usage` would be worse — a refund
 * would appear in a "where did my quota go" view as consumption.
 */
export function toAdminLedgerKind(
  kind: LedgerKind,
): "purchase" | "top_up" | "usage" | "adjustment" | "expiry" {
  switch (kind) {
    case "grant":
      return "purchase";
    case "top_up":
      return "top_up";
    case "debit":
      return "usage";
    case "refund":
    case "adjustment":
      return "adjustment";
    case "expiry":
      return "expiry";
  }
}

/**
 * The order statuses the client may filter on. Anything else is a 400.
 *
 * `ORDER_STATUS_VALUES` from `@bosanda/database` is imported rather than restated: the
 * database CHECK constraint and `apps/admin`'s `orderStatus` enum already agree on all
 * seven spellings, so a hand-written copy here could only ever diverge from both.
 */
export const ORDER_STATUSES: readonly OrderStatus[] = ORDER_STATUS_VALUES;

export function readOrderStatus(query: Map<string, string>): OrderStatus | undefined {
  const raw = query.get("status");
  if (raw === undefined) return undefined;
  // The client omits the parameter for "all", so an explicit "all" is a caller that
  // built the URL by hand. Accepted as equivalent rather than rejected on a technicality.
  if (raw === "all") return undefined;
  const match = ORDER_STATUSES.find((status) => status === raw);
  if (match === undefined) {
    throw invalid("status", `must be one of: ${ORDER_STATUSES.join(", ")}, all`);
  }
  return match;
}

/** ISO-8601 for every timestamp, per the client's `z.string().datetime()`. */
export function iso(at: Date): string {
  return at.toISOString();
}

export function isoOrNull(at: Date | null | undefined): string | null {
  return at === null || at === undefined ? null : at.toISOString();
}

/**
 * The `mutationResult` envelope: `{ok, message}`.
 *
 * The message is operator-facing UI text, so it must be safe to render and must never
 * carry a value the caller supplied or a secret. Every call site passes a literal.
 */
export function ok(message: string): { ok: true; message: string } {
  return { ok: true, message };
}
