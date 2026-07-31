/**
 * Wire schemas for every gateway response this app consumes.
 *
 * Every function in `api.ts` validates with one of these before the value
 * reaches a component, so a gateway that changes shape fails loudly here rather
 * than rendering `undefined` into the page.
 *
 * Note what is deliberately ABSENT: there is no field anywhere in this file for
 * a plaintext API key in a list, a provider credential, prompt text, response
 * text, a tool input, or a tool result (§16 privacy, §17 redaction). The single
 * place a plaintext key may appear is `RevealedKeySchema`, which is only ever
 * the body of an explicit, audited, one-off reveal request.
 */

import { z } from "zod";

/** UTC ISO-8601 instant (§14: all timestamps UTC). */
const Instant = z.iso.datetime();

/** Integer rupiah — never a float (§14). */
const Rupiah = z.number().int().nonnegative();

/** Weighted tokens: `(input + output) x model multiplier` (§10). Can go
 * slightly negative because §10 permits bounded overage on concurrent streams. */
const WeightedTokens = z.number().int();

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

/**
 * Per-size stock availability (§11 "Stock" — manually managed per package size).
 * `available` is the count an admin has published minus pending reservations;
 * the storefront only needs to know whether it can sell one right now.
 */
export const StockEntrySchema = z.object({
  packageId: z.string().min(1),
  tokens: WeightedTokens,
  priceIdr: Rupiah,
  available: z.number().int().nonnegative(),
  /** False when an admin disabled the size outright, independent of stock. */
  enabled: z.boolean(),
});
export type StockEntry = z.infer<typeof StockEntrySchema>;

export const StorefrontSchema = z.object({
  /** §3/§9: when no model has passed the compatibility gate, sales stay off. */
  salesEnabled: z.boolean(),
  stock: z.array(StockEntrySchema),
});
export type Storefront = z.infer<typeof StorefrontSchema>;

// ---------------------------------------------------------------------------
// Models (public docs page)
// ---------------------------------------------------------------------------

/**
 * Mirrors the public projection of the model registry (§9). `upstreamId` is
 * intentionally not present: §9 says the upstream provider model ID is never
 * surfaced to clients.
 */
export const PublicModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  multiplier: z.number().positive(),
  multiplierVersion: z.number().int().nonnegative(),
  supportsTools: z.boolean(),
  supportsReasoning: z.boolean(),
});
export type PublicModel = z.infer<typeof PublicModelSchema>;

export const ModelListSchema = z.object({
  object: z.literal("list").optional(),
  data: z.array(PublicModelSchema),
});

// ---------------------------------------------------------------------------
// Account / session
// ---------------------------------------------------------------------------

export const AccountSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1),
  role: z.enum(["user", "admin"]),
  status: z.enum(["active", "disabled"]),
  createdAt: Instant,
});
export type Account = z.infer<typeof AccountSchema>;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const KeyStatusSchema = z.enum(["active", "expired", "revoked", "exhausted"]);
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

/**
 * What the keys table renders. `masked` is produced by the server (§12 "display
 * masked by default") and is the ONLY key-ish string in this payload.
 *
 * §17 forbids logging even a full prefix of a key, so `masked` is expected to be
 * a short prefix plus bullets plus a short suffix — enough for a human to tell
 * two keys apart, not enough to authenticate.
 */
export const KeySummarySchema = z.object({
  keyId: z.string().min(1),
  masked: z.string().min(1),
  status: KeyStatusSchema,
  createdAt: Instant,
  /** Null before activation. */
  expiresAt: Instant.nullable(),
  quotaTotal: WeightedTokens,
  quotaRemaining: WeightedTokens,
});
export type KeySummary = z.infer<typeof KeySummarySchema>;

export const KeyListSchema = z.object({ keys: z.array(KeySummarySchema) });

/**
 * Response to an explicit reveal (§12: "eye toggle decrypts only after a valid
 * website session; key reveal is audited").
 *
 * This value must never be logged, cached, persisted, or embedded in a
 * server-rendered payload. It is fetched by an explicit user action, held in
 * component state, and dropped.
 */
export const RevealedKeySchema = z.object({
  keyId: z.string().min(1),
  plaintext: z.string().min(1),
  /** Echoed back so the UI can state plainly that the reveal was recorded. */
  auditedAt: Instant,
});
export type RevealedKey = z.infer<typeof RevealedKeySchema>;

// ---------------------------------------------------------------------------
// Quota & usage
// ---------------------------------------------------------------------------

export const QuotaSchema = z.object({
  /** Sum across the user's active keys. */
  remaining: WeightedTokens,
  total: WeightedTokens,
  /** Earliest expiry among active keys; null when nothing is active. */
  expiresAt: Instant.nullable(),
  activeKeyCount: z.number().int().nonnegative(),
  /**
   * §10: usage is authoritative only when upstream reported complete usage;
   * otherwise it is an estimate and the UI must say so.
   */
  hasEstimatedUsage: z.boolean(),
});
export type Quota = z.infer<typeof QuotaSchema>;

/** One bucket of the recent-usage chart. */
export const UsageBucketSchema = z.object({
  /** Bucket start, UTC. */
  at: Instant,
  weightedTokens: WeightedTokens,
});
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

export const UsageSeriesSchema = z.object({
  bucketMinutes: z.number().int().positive(),
  buckets: z.array(UsageBucketSchema),
});
export type UsageSeries = z.infer<typeof UsageSeriesSchema>;

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** Order state machine, exactly §13. */
export const OrderStatusSchema = z.enum([
  "draft",
  "pending_payment",
  "paid",
  "activated",
  "expired",
  "cancelled",
  "review_required",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.object({
  orderId: z.string().min(1),
  status: OrderStatusSchema,
  /** Immutable purchase snapshot (§11) — what the buyer actually agreed to pay. */
  priceIdr: Rupiah,
  tokens: WeightedTokens,
  packageId: z.string().min(1),
  /** "new_key" or a top-up of an existing key (§11 "New key versus top-up"). */
  intent: z.enum(["new_key", "top_up"]),
  targetKeyId: z.string().min(1).nullable(),
  createdAt: Instant,
  /** Present once the provider hand-off exists and the order is still payable. */
  paymentUrl: z.url().nullable(),
  /** Set when activation completed; the key the quota landed on. */
  activatedKeyId: z.string().min(1).nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderListSchema = z.object({ orders: z.array(OrderSchema) });

/** Narrow projection used by the return page's status poll. */
export const OrderStatusResponseSchema = z.object({
  orderId: z.string().min(1),
  status: OrderStatusSchema,
  activatedKeyId: z.string().min(1).nullable(),
  paymentUrl: z.url().nullable(),
});
export type OrderStatusResponse = z.infer<typeof OrderStatusResponseSchema>;

/** Keys eligible to receive a top-up: active and non-exhausted only (§11). */
export const TopUpCandidateSchema = z.object({
  keyId: z.string().min(1),
  masked: z.string().min(1),
  quotaRemaining: WeightedTokens,
  expiresAt: Instant,
  /** Largest package that still fits under the 100M per-key cap (§11). */
  maxTopUpTokens: WeightedTokens,
});
export type TopUpCandidate = z.infer<typeof TopUpCandidateSchema>;

export const TopUpCandidateListSchema = z.object({ keys: z.array(TopUpCandidateSchema) });
