/**
 * Row types and explicit snake_case -> camelCase mappers.
 *
 * WHY EXPLICIT MAPPERS. The driver can rename columns for you
 * (`transform: postgres.camel`), and we deliberately do not use it. A magic
 * transform means a renamed column silently produces `undefined` at runtime with
 * no compile error, and it gives nowhere to put the numeric decisions below. Each
 * mapper here names every column it reads, so a migration that renames one breaks
 * the build.
 *
 * These functions are PURE — no `Executor`, no I/O. That is what makes the
 * numeric conversions and the derived predicates unit-testable without a
 * PostgreSQL instance.
 *
 * ── BIGINT: the decision, and why ──────────────────────────────────────────
 * `postgres` returns int8 (BIGINT) as a STRING, because an int8 can exceed
 * `Number.MAX_SAFE_INTEGER` (2^53-1 = 9_007_199_254_740_991). Two rules here:
 *
 *   * Quantities become `number` via `bigintToNumber`, which THROWS above
 *     MAX_SAFE_INTEGER rather than returning a silently-wrong float. Every
 *     quantity we store is bounded far below that ceiling — a key holds at most
 *     100M weighted tokens (§11), token counts per request are capped by
 *     protocol LIMITS, and prices are rupiah in the tens of thousands. So the
 *     throw is unreachable in practice and exists to convert a
 *     someday-impossible situation into a loud failure instead of a corrupt
 *     ledger. `@bosanda/metering` and `@bosanda/payments` type all of these as
 *     `number`, so converting at the boundary is also what keeps the layer
 *     usable without casts everywhere.
 *   * Version counters (`package_stock.version`, `provider_accounts.credential_version`)
 *     also become `number`: they are compare-and-swap operands that must be
 *     compared and incremented, `ProviderCredentials.credentialVersion` is typed
 *     `number` in the frozen provider contract, and one increment per credential
 *     refresh will not reach 2^53 before the sun burns out.
 *
 * IDs stay strings — they are CHAR(26) ULIDs, not numbers.
 *
 * ── NUMERIC(10,4) multipliers: the decision, and why ───────────────────────
 * `multiplier` on `models` and `quota_ledger` is NUMERIC(10,4), which the driver
 * also returns as a string ("1.3000"). Reproducibility (§9: "a multiplier change
 * never rewrites historical usage") means the exact stored decimal must survive a
 * round trip, so BOTH forms are exposed:
 *
 *   * `multiplier`        — the raw string, exactly as stored. Persist this back.
 *   * `multiplierNumeric` — `Number(...)` of it, for arithmetic.
 *
 * The parse is lossless in the direction that matters: NUMERIC(10,4) has at most
 * 4 decimal places, and `@bosanda/metering`'s `weightedTokens` immediately
 * re-scales by 10^4 into integer space (`Math.round(multiplier * 10_000)`), so
 * the float is only ever an intermediate that the same rounding collapses back to
 * the stored decimal. `weightedTokens` validates the same NUMERIC(10,4) boundary
 * before doing integer arithmetic. Keeping the string alongside it means nothing
 * has to trust that argument when writing history back.
 */

import { BosandaError } from "@bosanda/protocol";

/** Largest integer a JS `number` represents exactly: 2^53 - 1. */
export const MAX_SAFE_DB_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * BIGINT (driver string) -> number, refusing anything not exactly representable.
 *
 * Also accepts `number` and `bigint`, because the driver's behaviour is
 * configurable and a caller-built fixture may hold either.
 */
export function bigintToNumber(value: string | number | bigint, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed)) {
    throw new BosandaError("internal_error", {
      internalDetail: `${column} is not an integer: ${String(value)}`,
    });
  }
  if (Math.abs(parsed) > MAX_SAFE_DB_INTEGER) {
    throw new BosandaError("internal_error", {
      internalDetail: `${column} exceeds the safe integer range: ${String(value)}`,
    });
  }
  return parsed;
}

/** Nullable BIGINT. */
export function nullableBigint(
  value: string | number | bigint | null,
  column: string,
): number | null {
  return value === null ? null : bigintToNumber(value, column);
}

/**
 * NUMERIC -> number for arithmetic. Rejects non-finite and non-positive values:
 * both `models.multiplier` and `quota_ledger.multiplier` carry CHECK (> 0), so a
 * violation means the row is corrupt rather than that the caller erred.
 */
export function numericToNumber(value: string | number, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BosandaError("internal_error", {
      internalDetail: `${column} is not a positive finite number: ${String(value)}`,
    });
  }
  return parsed;
}

/**
 * TIMESTAMPTZ -> Date. The driver returns `Date` already (client.ts pins the
 * session to UTC); this normalizes the string case a fixture might produce and
 * rejects an unparseable value rather than propagating an Invalid Date.
 */
export function toDate(value: Date | string, column: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BosandaError("internal_error", {
      internalDetail: `${column} is not a valid timestamp`,
    });
  }
  return date;
}

export function nullableDate(value: Date | string | null, column: string): Date | null {
  return value === null ? null : toDate(value, column);
}

// ───────────────────────── users / sessions ─────────────────────────

export type UserRole = "customer" | "admin";
export type UserStatus = "active" | "suspended";

export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

/**
 * A `users` row.
 *
 * `passwordHash` is present because `@bosanda/auth`'s `attemptLogin` needs it to
 * verify. It must never leave the process — not in a response, not in a log
 * (§16). `toPublicUser` below is the shape that may cross an API boundary.
 */
export type User = {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** A user without the password hash. Safe for admin listings and session context. */
export type PublicUser = Omit<User, "passwordHash">;

/**
 * Narrow a CHECK-constrained TEXT column to its union.
 *
 * The database already guarantees membership, so a miss means the schema and
 * these types have diverged — a build/deploy error, surfaced loudly rather than
 * cast away.
 */
function narrow<T extends string>(value: string, allowed: readonly T[], column: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new BosandaError("internal_error", {
      internalDetail: `${column} holds unexpected value ${value}`,
    });
  }
  return found;
}

const USER_ROLES: readonly UserRole[] = ["customer", "admin"];
const USER_STATUSES: readonly UserStatus[] = ["active", "suspended"];

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: narrow(row.role, USER_ROLES, "users.role"),
    status: narrow(row.status, USER_STATUSES, "users.status"),
    createdAt: toDate(row.created_at, "users.created_at"),
    updatedAt: toDate(row.updated_at, "users.updated_at"),
  };
}

/** Drop the password hash. Used wherever a user is returned outward. */
export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  last_used_at: Date;
};

/** A persisted session shaped for direct use by `evaluateSession`. */
export type Session = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date;
};

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: toDate(row.expires_at, "sessions.expires_at"),
    revokedAt: nullableDate(row.revoked_at, "sessions.revoked_at"),
    createdAt: toDate(row.created_at, "sessions.created_at"),
    lastUsedAt: toDate(row.last_used_at, "sessions.last_used_at"),
  };
}

// ───────────────────────── api_keys ─────────────────────────

export type ApiKeyStatus = "active" | "revoked" | "expired";

const API_KEY_STATUSES: readonly ApiKeyStatus[] = ["active", "revoked", "expired"];

export type ApiKeyRow = {
  id: string;
  user_id: string;
  label: string | null;
  prefix: string;
  lookup_digest: string;
  encrypted_key: string;
  encryption_key_version: number;
  status: string;
  quota_limit: string;
  quota_remaining: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
};

/**
 * An `api_keys` row.
 *
 * `encryptedKey` is the sealed envelope for the §12 eye toggle. It is returned
 * because `revealApiKey` in `@bosanda/api-keys` needs it, and like the password
 * hash it must never be logged or serialized to a client.
 */
export type ApiKey = {
  id: string;
  userId: string;
  label: string | null;
  prefix: string;
  lookupDigest: string;
  encryptedKey: string;
  encryptionKeyVersion: number;
  status: ApiKeyStatus;
  quotaLimit: number;
  quotaRemaining: number;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    prefix: row.prefix,
    lookupDigest: row.lookup_digest,
    encryptedKey: row.encrypted_key,
    encryptionKeyVersion: row.encryption_key_version,
    status: narrow(row.status, API_KEY_STATUSES, "api_keys.status"),
    quotaLimit: bigintToNumber(row.quota_limit, "api_keys.quota_limit"),
    quotaRemaining: bigintToNumber(row.quota_remaining, "api_keys.quota_remaining"),
    expiresAt: toDate(row.expires_at, "api_keys.expires_at"),
    createdAt: toDate(row.created_at, "api_keys.created_at"),
    revokedAt: nullableDate(row.revoked_at, "api_keys.revoked_at"),
    lastUsedAt: nullableDate(row.last_used_at, "api_keys.last_used_at"),
  };
}

/**
 * The gateway's hot-path row: the key JOINed to its owner's status.
 *
 * Joined rather than fetched separately because §12 requires a suspended
 * account's keys to stop working, and two round trips on the authentication path
 * would both cost latency and admit a window where the key is validated against
 * a stale user state.
 */
export type ApiKeyRowWithUser = ApiKeyRow & { user_status: string; user_role: string };

export type AuthenticatedApiKey = {
  key: ApiKey;
  userStatus: UserStatus;
  userRole: UserRole;
};

export function toAuthenticatedApiKey(row: ApiKeyRowWithUser): AuthenticatedApiKey {
  return {
    key: toApiKey(row),
    userStatus: narrow(row.user_status, USER_STATUSES, "users.status"),
    userRole: narrow(row.user_role, USER_ROLES, "users.role"),
  };
}

/**
 * The `KeyQuotaState` shape `@bosanda/metering` decides against
 * (`canStartRequest`, `settle`, `validateTopUp`).
 *
 * Deliberately a projection rather than a second source of truth: the gateway
 * reads a key once and passes this straight into the metering decision, so the
 * numbers the decision saw are the numbers that were read.
 */
export function toKeyQuotaState(key: ApiKey): {
  keyId: string;
  status: ApiKeyStatus;
  remaining: number;
  quotaLimit: number;
  expiresAt: Date | null;
} {
  return {
    keyId: key.id,
    status: key.status,
    remaining: key.quotaRemaining,
    quotaLimit: key.quotaLimit,
    expiresAt: key.expiresAt,
  };
}

// ───────────────────────── quota_ledger ─────────────────────────

export type LedgerKind = "grant" | "top_up" | "debit" | "refund" | "adjustment" | "expiry";

const LEDGER_KINDS: readonly LedgerKind[] = [
  "grant",
  "top_up",
  "debit",
  "refund",
  "adjustment",
  "expiry",
];

export type QuotaLedgerRow = {
  id: string;
  api_key_id: string;
  order_id: string | null;
  request_id: string | null;
  kind: string;
  raw_input_tokens: string;
  raw_output_tokens: string;
  multiplier: string | null;
  weighted_tokens_delta: string;
  balance_after: string;
  estimated: boolean;
  meter_version: string;
  created_at: Date;
};

export type QuotaLedgerEntry = {
  id: string;
  apiKeyId: string;
  orderId: string | null;
  requestId: string | null;
  kind: LedgerKind;
  rawInputTokens: number;
  rawOutputTokens: number;
  /** Exact stored decimal, e.g. "1.3000". Null for non-usage kinds. See the header. */
  multiplier: string | null;
  /** Parsed for arithmetic. Null when `multiplier` is null. */
  multiplierNumeric: number | null;
  /** Signed: negative debits quota, positive credits it. */
  weightedTokensDelta: number;
  /** The persisted balance. Clamped at 0 by CHECK — see `quota.ts`. */
  balanceAfter: number;
  estimated: boolean;
  meterVersion: string;
  createdAt: Date;
};

export function toQuotaLedgerEntry(row: QuotaLedgerRow): QuotaLedgerEntry {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    orderId: row.order_id,
    requestId: row.request_id,
    kind: narrow(row.kind, LEDGER_KINDS, "quota_ledger.kind"),
    rawInputTokens: bigintToNumber(row.raw_input_tokens, "quota_ledger.raw_input_tokens"),
    rawOutputTokens: bigintToNumber(row.raw_output_tokens, "quota_ledger.raw_output_tokens"),
    multiplier: row.multiplier,
    multiplierNumeric:
      row.multiplier === null ? null : numericToNumber(row.multiplier, "quota_ledger.multiplier"),
    weightedTokensDelta: bigintToNumber(
      row.weighted_tokens_delta,
      "quota_ledger.weighted_tokens_delta",
    ),
    balanceAfter: bigintToNumber(row.balance_after, "quota_ledger.balance_after"),
    estimated: row.estimated,
    meterVersion: row.meter_version,
    createdAt: toDate(row.created_at, "quota_ledger.created_at"),
  };
}

// ───────────────────────── packages / stock ─────────────────────────

export type PackageRow = {
  id: string;
  name: string;
  weighted_token_quota: string;
  price_idr: string;
  duration_seconds: number;
  max_key_quota: string;
  allowed_models: unknown;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type PackageRecord = {
  id: string;
  name: string;
  weightedTokenQuota: number;
  /** Integer rupiah (§14: never floating point). */
  priceIdr: number;
  durationSeconds: number;
  maxKeyQuota: number;
  /**
   * Public model IDs this package may use (§9 package scopes). An empty array
   * means "no restriction" — v1 presets default to all published models (§9) and
   * the schema's default is `[]`.
   */
  allowedModels: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * JSONB string array -> string[].
 *
 * A non-array or non-string element cannot occur for `allowed_models` (CHECK
 * `jsonb_typeof = 'array'`), but element types are unconstrained, so
 * non-strings are dropped rather than allowed to become `undefined` entries in a
 * `string[]`.
 */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function toPackageRecord(row: PackageRow): PackageRecord {
  return {
    id: row.id,
    name: row.name,
    weightedTokenQuota: bigintToNumber(row.weighted_token_quota, "packages.weighted_token_quota"),
    priceIdr: bigintToNumber(row.price_idr, "packages.price_idr"),
    durationSeconds: row.duration_seconds,
    maxKeyQuota: bigintToNumber(row.max_key_quota, "packages.max_key_quota"),
    allowedModels: toStringArray(row.allowed_models),
    active: row.active,
    createdAt: toDate(row.created_at, "packages.created_at"),
    updatedAt: toDate(row.updated_at, "packages.updated_at"),
  };
}

export type PackageStockRow = {
  package_id: string;
  available: number;
  reserved: number;
  version: string;
  updated_at: Date;
};

export type PackageStock = {
  packageId: string;
  available: number;
  reserved: number;
  /** Optimistic-concurrency counter (§14). The CAS operand. */
  version: number;
  updatedAt: Date;
};

export function toPackageStock(row: PackageStockRow): PackageStock {
  return {
    packageId: row.package_id,
    available: row.available,
    reserved: row.reserved,
    version: bigintToNumber(row.version, "package_stock.version"),
    updatedAt: toDate(row.updated_at, "package_stock.updated_at"),
  };
}

/** Free units: physical stock not already held by a pending order (§11). */
export function freeUnits(stock: Pick<PackageStock, "available" | "reserved">): number {
  return Math.max(0, stock.available - stock.reserved);
}

// ───────────────────────── orders / payment_events ─────────────────────────

export type OrderStatus =
  "draft" | "pending_payment" | "paid" | "activated" | "expired" | "cancelled" | "review_required";

export type OrderType = "new_key" | "top_up";

const ORDER_STATUSES: readonly OrderStatus[] = [
  "draft",
  "pending_payment",
  "paid",
  "activated",
  "expired",
  "cancelled",
  "review_required",
];

const ORDER_TYPES: readonly OrderType[] = ["new_key", "top_up"];

export type OrderRow = {
  id: string;
  user_id: string;
  package_id: string;
  package_snapshot: unknown;
  type: string;
  target_api_key_id: string | null;
  amount_idr: string;
  status: string;
  stock_reservation_expires_at: Date | null;
  provider: string | null;
  provider_transaction_id: string | null;
  paid_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * The frozen purchase snapshot, matching `PackageSnapshot` from
 * `@bosanda/payments` (§11: "existing paid orders retain their purchase
 * snapshot").
 */
export type StoredPackageSnapshot = {
  packageId: string;
  weightedTokenQuota: number;
  priceIdr: number;
  maxKeyQuota: number;
  durationSeconds: number;
};

/**
 * Parse `orders.package_snapshot`.
 *
 * Strict: every field must be an integer (or a string for `packageId`). This is
 * the value §13 forbids recomputing from webhook data and the only thing
 * amount validation may compare against, so a malformed snapshot must fail
 * rather than default. It is written by us, so a failure here is a bug on the
 * write path, not bad user input.
 */
export function toPackageSnapshot(value: unknown, orderId: string): StoredPackageSnapshot {
  const bad = (detail: string): never => {
    throw new BosandaError("internal_error", {
      internalDetail: `order ${orderId} package_snapshot ${detail}`,
    });
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("is not an object");
  }
  const record = value as Record<string, unknown>;

  const integer = (field: string): number => {
    const raw = record[field];
    const parsed = typeof raw === "string" ? Number(raw) : raw;
    if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
      return bad(`field ${field} is not an integer`);
    }
    return parsed;
  };

  const packageId = record["packageId"];
  if (typeof packageId !== "string" || packageId.length === 0) {
    return bad("field packageId is not a string");
  }

  return {
    packageId,
    weightedTokenQuota: integer("weightedTokenQuota"),
    priceIdr: integer("priceIdr"),
    maxKeyQuota: integer("maxKeyQuota"),
    durationSeconds: integer("durationSeconds"),
  };
}

/**
 * An `orders` row.
 *
 * `provider` is nullable in the schema (a `draft` order predates checkout) but
 * `OrderSnapshot` in `@bosanda/payments` types it as the non-null literal
 * `"pakasir"`. `toOrderSnapshot` below performs that narrowing explicitly and
 * refuses an order with no provider, so the difference is handled at one place
 * instead of being papered over with a cast.
 */
export type Order = {
  id: string;
  userId: string;
  packageId: string;
  packageSnapshot: StoredPackageSnapshot;
  type: OrderType;
  targetApiKeyId: string | null;
  amountIdr: number;
  status: OrderStatus;
  stockReservationExpiresAt: Date | null;
  provider: string | null;
  providerTransactionId: string | null;
  paidAt: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    userId: row.user_id,
    packageId: row.package_id,
    packageSnapshot: toPackageSnapshot(row.package_snapshot, row.id),
    type: narrow(row.type, ORDER_TYPES, "orders.type"),
    targetApiKeyId: row.target_api_key_id,
    amountIdr: bigintToNumber(row.amount_idr, "orders.amount_idr"),
    status: narrow(row.status, ORDER_STATUSES, "orders.status"),
    stockReservationExpiresAt: nullableDate(
      row.stock_reservation_expires_at,
      "orders.stock_reservation_expires_at",
    ),
    provider: row.provider,
    providerTransactionId: row.provider_transaction_id,
    paidAt: nullableDate(row.paid_at, "orders.paid_at"),
    activatedAt: nullableDate(row.activated_at, "orders.activated_at"),
    createdAt: toDate(row.created_at, "orders.created_at"),
    updatedAt: toDate(row.updated_at, "orders.updated_at"),
  };
}

/**
 * `Order` -> the `OrderSnapshot` that `@bosanda/payments` decides against
 * (`decideActivation`, `decideWebhookAction`, `planReconcilePass`).
 *
 * Two narrowings happen here, both deliberate:
 *   * `provider` must be present and must be "pakasir" — v1 has one provider,
 *     and an order without one has not reached checkout, so it cannot be the
 *     subject of a payment decision.
 *   * `currency` is the literal "IDR". There is no currency column: §11 prices
 *     everything in rupiah and §14 stores integer rupiah, so the column would
 *     hold one value forever. Stamped here rather than invented per call site.
 */
export function toOrderSnapshot(order: Order): {
  orderId: string;
  userId: string;
  type: OrderType;
  targetApiKeyId: string | null;
  packageSnapshot: StoredPackageSnapshot;
  amountIdr: number;
  currency: "IDR";
  status: OrderStatus;
  stockReservationExpiresAt: Date | null;
  provider: "pakasir";
  providerTransactionId: string | null;
  paidAt: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
} {
  if (order.provider !== "pakasir") {
    throw new BosandaError("internal_error", {
      internalDetail: `order ${order.id} has provider ${String(order.provider)}, expected pakasir`,
    });
  }
  return {
    orderId: order.id,
    userId: order.userId,
    type: order.type,
    targetApiKeyId: order.targetApiKeyId,
    packageSnapshot: order.packageSnapshot,
    amountIdr: order.amountIdr,
    currency: "IDR",
    status: order.status,
    stockReservationExpiresAt: order.stockReservationExpiresAt,
    provider: "pakasir",
    providerTransactionId: order.providerTransactionId,
    paidAt: order.paidAt,
    activatedAt: order.activatedAt,
    createdAt: order.createdAt,
  };
}

export type PaymentEventStatus = "received" | "processed" | "ignored" | "failed";

const PAYMENT_EVENT_STATUSES: readonly PaymentEventStatus[] = [
  "received",
  "processed",
  "ignored",
  "failed",
];

export type PaymentEventRow = {
  id: string;
  provider: string;
  provider_event_key: string;
  payload_digest: string;
  status: string;
  received_at: Date;
  processed_at: Date | null;
  error_code: string | null;
};

export type PaymentEvent = {
  id: string;
  provider: string;
  providerEventKey: string;
  payloadDigest: string;
  status: PaymentEventStatus;
  receivedAt: Date;
  processedAt: Date | null;
  errorCode: string | null;
};

export function toPaymentEvent(row: PaymentEventRow): PaymentEvent {
  return {
    id: row.id,
    provider: row.provider,
    providerEventKey: row.provider_event_key,
    payloadDigest: row.payload_digest,
    status: narrow(row.status, PAYMENT_EVENT_STATUSES, "payment_events.status"),
    receivedAt: toDate(row.received_at, "payment_events.received_at"),
    processedAt: nullableDate(row.processed_at, "payment_events.processed_at"),
    errorCode: row.error_code,
  };
}

// ───────────────────────── provider accounts / health ─────────────────────────

/**
 * `provider_accounts.status` as the DATABASE spells it.
 *
 * Note the mismatch with `AccountStatus` in the frozen `@bosanda/provider-core`
 * contract: the schema says `cooldown`/`invalid`, the contract says
 * `cooling_down`/`credential_invalid`. Neither may be changed — the schema is
 * immutable after release (§14) and the adapter contract is frozen (§6) — so
 * `toAccountStatus` / `fromAccountStatus` translate at this boundary and are
 * unit-tested for round-trip fidelity.
 */
export type ProviderAccountStatus = "active" | "cooldown" | "disabled" | "invalid";

const PROVIDER_ACCOUNT_STATUSES: readonly ProviderAccountStatus[] = [
  "active",
  "cooldown",
  "disabled",
  "invalid",
];

/** The `@bosanda/provider-core` spelling. Mirrored, not imported, to avoid a cycle. */
export type SchedulerAccountStatus = "active" | "disabled" | "cooling_down" | "credential_invalid";

export function toAccountStatus(status: ProviderAccountStatus): SchedulerAccountStatus {
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

export function fromAccountStatus(status: SchedulerAccountStatus): ProviderAccountStatus {
  switch (status) {
    case "active":
      return "active";
    case "cooling_down":
      return "cooldown";
    case "disabled":
      return "disabled";
    case "credential_invalid":
      return "invalid";
  }
}

export type ProviderAccountRow = {
  id: string;
  provider_type: string;
  label: string;
  status: string;
  region: string | null;
  persona: string | null;
  encrypted_credentials: string | null;
  encryption_key_version: number | null;
  profile_arn: string | null;
  credential_version: string;
  cooldown_until: Date | null;
  last_validated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * A `provider_accounts` row WITHOUT credential material.
 *
 * `encrypted_credentials` is deliberately absent: §16 forbids logging or
 * returning credential data, and the vast majority of reads (selection, admin
 * listing, health) do not need it. The ciphertext is only ever handed out by
 * `readCredentials`, which is named so a reviewer can grep every call site.
 */
export type ProviderAccount = {
  id: string;
  providerType: string;
  label: string;
  status: ProviderAccountStatus;
  region: string | null;
  persona: string | null;
  encryptionKeyVersion: number | null;
  profileArn: string | null;
  credentialVersion: number;
  cooldownUntil: Date | null;
  lastValidatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toProviderAccount(row: ProviderAccountRow): ProviderAccount {
  return {
    id: row.id,
    providerType: row.provider_type,
    label: row.label,
    status: narrow(row.status, PROVIDER_ACCOUNT_STATUSES, "provider_accounts.status"),
    region: row.region,
    persona: row.persona,
    encryptionKeyVersion: row.encryption_key_version,
    profileArn: row.profile_arn,
    credentialVersion: bigintToNumber(
      row.credential_version,
      "provider_accounts.credential_version",
    ),
    cooldownUntil: nullableDate(row.cooldown_until, "provider_accounts.cooldown_until"),
    lastValidatedAt: nullableDate(row.last_validated_at, "provider_accounts.last_validated_at"),
    createdAt: toDate(row.created_at, "provider_accounts.created_at"),
    updatedAt: toDate(row.updated_at, "provider_accounts.updated_at"),
  };
}

/**
 * Ciphertext plus the version that guards its rotation.
 *
 * Returned only by `readCredentials`. The caller decrypts with
 * `@bosanda/api-keys`' envelope and must not retain, log, or serialize either
 * field (§6, §16).
 */
export type ProviderAccountCredentials = {
  accountId: string;
  encryptedCredentials: string;
  encryptionKeyVersion: number;
  credentialVersion: number;
  region: string | null;
  persona: string | null;
  profileArn: string | null;
};

export type ProviderHealthEventRow = {
  id: string;
  provider_account_id: string;
  model_id: string | null;
  event_type: string;
  error_class: string | null;
  cooldown_until: Date | null;
  adapter_version: string | null;
  created_at: Date;
};

export type ProviderHealthEvent = {
  id: string;
  providerAccountId: string;
  modelId: string | null;
  eventType: string;
  errorClass: string | null;
  cooldownUntil: Date | null;
  adapterVersion: string | null;
  createdAt: Date;
};

export function toProviderHealthEvent(row: ProviderHealthEventRow): ProviderHealthEvent {
  return {
    id: row.id,
    providerAccountId: row.provider_account_id,
    modelId: row.model_id,
    eventType: row.event_type,
    errorClass: row.error_class,
    cooldownUntil: nullableDate(row.cooldown_until, "provider_health_events.cooldown_until"),
    adapterVersion: row.adapter_version,
    createdAt: toDate(row.created_at, "provider_health_events.created_at"),
  };
}

// ───────────────────────── models ─────────────────────────

export type CompatibilityStatus = "untested" | "passing" | "degraded" | "failing";

const COMPATIBILITY_STATUSES: readonly CompatibilityStatus[] = [
  "untested",
  "passing",
  "degraded",
  "failing",
];

export type ModelRow = {
  public_id: string;
  provider_type: string;
  upstream_id: string;
  label: string;
  context_window: number;
  multiplier: string;
  multiplier_version: string;
  capabilities: unknown;
  regions: unknown;
  published: boolean;
  compatibility_status: string;
  updated_at: Date;
};

/**
 * A `models` row.
 *
 * `multiplierVersion` is TEXT in the schema but `number` on the frozen
 * `ProviderModel` and on `MultiplierRecord` in `@bosanda/metering`. Both stay as
 * they are; `toMultiplierRecord` parses and validates, and reports the row as
 * corrupt if the text is not a positive integer.
 */
export type ModelRecord = {
  publicId: string;
  providerType: string;
  /** Never surfaced to a client (frozen `ProviderModel` contract, §16). */
  upstreamId: string;
  label: string;
  contextWindow: number;
  /** Exact stored decimal, e.g. "1.3000". See the header on NUMERIC handling. */
  multiplier: string;
  /** Parsed for arithmetic. */
  multiplierNumeric: number;
  /** As stored (TEXT). Parsed to a number by `toMultiplierRecord`. */
  multiplierVersion: string;
  supportsTools: boolean;
  supportsReasoning: boolean;
  regions: string[];
  published: boolean;
  compatibilityStatus: CompatibilityStatus;
  updatedAt: Date;
};

/** Read a boolean out of the `capabilities` JSONB, defaulting to false. */
function capabilityFlag(capabilities: unknown, key: string): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  return (capabilities as Record<string, unknown>)[key] === true;
}

export function toModelRecord(row: ModelRow): ModelRecord {
  return {
    publicId: row.public_id,
    providerType: row.provider_type,
    upstreamId: row.upstream_id,
    label: row.label,
    contextWindow: row.context_window,
    multiplier: row.multiplier,
    multiplierNumeric: numericToNumber(row.multiplier, "models.multiplier"),
    multiplierVersion: row.multiplier_version,
    supportsTools: capabilityFlag(row.capabilities, "supportsTools"),
    supportsReasoning: capabilityFlag(row.capabilities, "supportsReasoning"),
    regions: toStringArray(row.regions),
    published: row.published,
    compatibilityStatus: narrow(
      row.compatibility_status,
      COMPATIBILITY_STATUSES,
      "models.compatibility_status",
    ),
    updatedAt: toDate(row.updated_at, "models.updated_at"),
  };
}

/**
 * `ModelRecord` -> the `MultiplierRecord` shape `MultiplierRegistry` consumes.
 *
 * `effectiveAt` maps to `updated_at`: the schema records no separate activation
 * instant, and §9 stages a multiplier change as a NEW version row, so the moment
 * a version row was last written is the moment it became authoritative. A future
 * staged-publication feature would need its own column and migration; noted
 * rather than faked.
 */
export function toMultiplierRecord(model: ModelRecord): {
  model: string;
  version: number;
  multiplier: number;
  effectiveAt: Date;
} {
  const version = Number(model.multiplierVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new BosandaError("internal_error", {
      internalDetail: `models.multiplier_version for ${model.publicId} is not a positive integer`,
    });
  }
  return {
    model: model.publicId,
    version,
    multiplier: model.multiplierNumeric,
    effectiveAt: model.updatedAt,
  };
}

/**
 * `ModelRecord` -> the frozen `ProviderModel` shape.
 *
 * `compatibilityStatus` narrows the schema's four values onto the contract's
 * three: `untested` and `degraded` both become `unknown`. Chosen because the
 * contract has no `degraded`, and the alternative (calling a degraded model
 * `passing`) would overstate it. The schema value stays available on
 * `ModelRecord` for the admin dashboard, which needs the distinction.
 */
export function toProviderModel(model: ModelRecord): {
  publicId: string;
  upstreamId: string;
  label: string;
  contextWindow: number;
  multiplier: number;
  multiplierVersion: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  regions: string[];
  published: boolean;
  compatibilityStatus: "unknown" | "passing" | "failing";
} {
  const version = Number(model.multiplierVersion);
  return {
    publicId: model.publicId,
    upstreamId: model.upstreamId,
    label: model.label,
    contextWindow: model.contextWindow,
    multiplier: model.multiplierNumeric,
    multiplierVersion: Number.isInteger(version) && version >= 1 ? version : 0,
    supportsTools: model.supportsTools,
    supportsReasoning: model.supportsReasoning,
    regions: model.regions,
    published: model.published,
    compatibilityStatus:
      model.compatibilityStatus === "passing"
        ? "passing"
        : model.compatibilityStatus === "failing"
          ? "failing"
          : "unknown",
  };
}

// ───────────────────────── usage_events ─────────────────────────

export type UsageSurface = "openai" | "anthropic";
export type UsageStatus = "succeeded" | "failed" | "cancelled" | "partial";

const USAGE_SURFACES: readonly UsageSurface[] = ["openai", "anthropic"];
const USAGE_STATUSES: readonly UsageStatus[] = ["succeeded", "failed", "cancelled", "partial"];

export type UsageEventRow = {
  id: string;
  request_id: string;
  api_key_id: string;
  provider_account_id: string | null;
  model_public_id: string;
  surface: string;
  status: string;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  weighted_tokens: string;
  estimated: boolean;
  meter_version: string;
  adapter_version: string | null;
  retries: number;
  ttfb_ms: number | null;
  duration_ms: number | null;
  created_at: Date;
};

export type UsageEvent = {
  id: string;
  requestId: string;
  apiKeyId: string;
  providerAccountId: string | null;
  modelPublicId: string;
  surface: UsageSurface;
  status: UsageStatus;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  weightedTokens: number;
  estimated: boolean;
  meterVersion: string;
  adapterVersion: string | null;
  retries: number;
  ttfbMs: number | null;
  durationMs: number | null;
  createdAt: Date;
};

export function toUsageEvent(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    requestId: row.request_id,
    apiKeyId: row.api_key_id,
    providerAccountId: row.provider_account_id,
    modelPublicId: row.model_public_id,
    surface: narrow(row.surface, USAGE_SURFACES, "usage_events.surface"),
    status: narrow(row.status, USAGE_STATUSES, "usage_events.status"),
    inputTokens: bigintToNumber(row.input_tokens, "usage_events.input_tokens"),
    outputTokens: bigintToNumber(row.output_tokens, "usage_events.output_tokens"),
    cachedTokens: bigintToNumber(row.cached_tokens, "usage_events.cached_tokens"),
    weightedTokens: bigintToNumber(row.weighted_tokens, "usage_events.weighted_tokens"),
    estimated: row.estimated,
    meterVersion: row.meter_version,
    adapterVersion: row.adapter_version,
    retries: row.retries,
    ttfbMs: row.ttfb_ms,
    durationMs: row.duration_ms,
    createdAt: toDate(row.created_at, "usage_events.created_at"),
  };
}

// ───────────────────────── audit / flags ─────────────────────────

export type ActorType = "user" | "admin" | "system";

const ACTOR_TYPES: readonly ActorType[] = ["user", "admin", "system"];

export type AuditEventRow = {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: unknown;
  created_at: Date;
};

export type AuditEvent = {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** Operator-facing context. Never prompt/response content (§16). */
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export function toJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actorType: narrow(row.actor_type, ACTOR_TYPES, "audit_events.actor_type"),
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: toJsonObject(row.metadata),
    createdAt: toDate(row.created_at, "audit_events.created_at"),
  };
}

export type FeatureFlagRow = {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Date;
};

export type FeatureFlag = {
  key: string;
  value: unknown;
  updatedBy: string | null;
  updatedAt: Date;
};

export function toFeatureFlag(row: FeatureFlagRow): FeatureFlag {
  return {
    key: row.key,
    value: row.value,
    updatedBy: row.updated_by,
    updatedAt: toDate(row.updated_at, "feature_flags.updated_at"),
  };
}
