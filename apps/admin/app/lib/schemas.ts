/**
 * Zod response contracts for every admin endpoint (PLAN.md §15).
 *
 * These are the ONLY shapes the dashboard trusts. Every response — live or
 * fixture — is parsed through them, so a backend that starts returning a
 * plaintext credential or a prompt body fails validation instead of rendering.
 *
 * SECURITY (§16/§17): no schema in this file has a field for a plaintext API
 * key, provider credential, prompt text, response text, tool input, or tool
 * result. That is deliberate and load-bearing — `.strict()` on the sensitive
 * objects means an upstream that adds such a field is REJECTED rather than
 * silently passed to a component that might render it.
 */

import { z } from "zod";

/** Integer rupiah, never a float (§14). */
export const rupiah = z.number().int();

/** UTC ISO-8601 instant. */
export const utcInstant = z.string().datetime();

export const accountStatus = z.enum(["active", "disabled", "cooling_down", "credential_invalid"]);
export type AccountStatus = z.infer<typeof accountStatus>;

export const orderStatus = z.enum([
  "draft",
  "pending_payment",
  "paid",
  "activated",
  "expired",
  "cancelled",
  "review_required",
]);
export type OrderStatus = z.infer<typeof orderStatus>;

export const compatibilityStatus = z.enum(["unknown", "passing", "failing"]);

export const keyStatus = z.enum(["active", "revoked", "expired", "exhausted"]);

export const userStatus = z.enum(["active", "disabled"]);

/* ------------------------------------------------------------------ overview */

export const overviewMetrics = z.object({
  windowSeconds: z.number().int().positive(),
  requestCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  /** 0..1. Rendered as a percentage. */
  errorRate: z.number().min(0).max(1),
  latencyMs: z.object({
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    p99: z.number().nonnegative(),
  }),
  weightedTokensServed: z.number().int().nonnegative(),
  activeStreams: z.number().int().nonnegative(),
  revenueIdr: rupiah.nonnegative(),
  healthyAccounts: z.number().int().nonnegative(),
  totalAccounts: z.number().int().nonnegative(),
});
export type OverviewMetrics = z.infer<typeof overviewMetrics>;

export const timeseriesPoint = z.object({
  at: utcInstant,
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  weightedTokens: z.number().int().nonnegative(),
});
export type TimeseriesPoint = z.infer<typeof timeseriesPoint>;

export const overview = z.object({
  metrics: overviewMetrics,
  series: z.array(timeseriesPoint),
  killSwitchSummary: z.object({
    adapterEnabled: z.boolean(),
    kiroDirectEnabled: z.boolean(),
    toolUseEnabled: z.boolean(),
    disabledRegionCount: z.number().int().nonnegative(),
    disabledModelCount: z.number().int().nonnegative(),
    disabledAccountCount: z.number().int().nonnegative(),
  }),
});
export type Overview = z.infer<typeof overview>;

/* ------------------------------------------------------------------ accounts */

/**
 * A provider account as the OPERATOR sees it.
 *
 * `.strict()` is the enforcement point for §16: `encrypted_credentials`,
 * `refreshToken`, `accessToken`, and `profileArn` are absent, and any upstream
 * that adds them makes this parse throw.
 *
 * `lastErrorClass` is a CLASSIFICATION ONLY (e.g. "upstream_incompatible").
 * Never a raw upstream body.
 */
export const providerAccount = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    providerType: z.enum(["kiro", "openai_codex"]),
    status: accountStatus,
    region: z.string().min(1),
    persona: z.enum(["cli", "ide", "app_server"]),
    activeRequests: z.number().int().nonnegative(),
    errorScore: z.number().nonnegative(),
    cooldownUntil: utcInstant.nullable(),
    lastValidatedAt: utcInstant.nullable(),
    credentialVersion: z.number().int().nonnegative(),
    /** True when a credential is stored. The value itself is never returned. */
    hasStoredCredential: z.boolean(),
    lastErrorClass: z.string().min(1).nullable(),
    lastErrorCount24h: z.number().int().nonnegative(),
    weightedTokens24h: z.number().int().nonnegative(),
  })
  .strict();
export type ProviderAccount = z.infer<typeof providerAccount>;

export const providerAccountList = z.object({ accounts: z.array(providerAccount) });

/* -------------------------------------------------------------------- models */

export const model = z
  .object({
    publicId: z.string().min(1),
    upstreamId: z.string().min(1),
    label: z.string().min(1),
    contextWindow: z.number().int().positive(),
    multiplier: z.number().positive(),
    multiplierVersion: z.number().int().positive(),
    multiplierEffectiveAt: utcInstant,
    supportsTools: z.boolean(),
    supportsReasoning: z.boolean(),
    regions: z.array(z.string().min(1)),
    published: z.boolean(),
    compatibilityStatus,
  })
  .strict();
export type Model = z.infer<typeof model>;

export const modelList = z.object({ models: z.array(model) });

/* ------------------------------------------------------------------ packages */

export const packageDefinition = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    weightedTokenQuota: z.number().int().positive(),
    priceIdr: rupiah.nonnegative(),
    durationSeconds: z.number().int().positive(),
    maxKeyQuota: z.number().int().positive(),
    active: z.boolean(),
    stock: z.object({
      available: z.number().int().nonnegative(),
      reserved: z.number().int().nonnegative(),
      version: z.number().int().nonnegative(),
      updatedAt: utcInstant,
    }),
    soldOut: z.boolean(),
  })
  .strict();
export type PackageDefinition = z.infer<typeof packageDefinition>;

export const packageList = z.object({ packages: z.array(packageDefinition) });

/* -------------------------------------------------------------------- orders */

export const orderSummary = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    userId: z.string().min(1),
    packageName: z.string().min(1),
    type: z.enum(["new_key", "top_up"]),
    amountIdr: rupiah.nonnegative(),
    status: orderStatus,
    provider: z.string().min(1),
    /** Provider transaction reference. Not a secret; safe for reconciliation. */
    providerTransactionId: z.string().nullable(),
    createdAt: utcInstant,
    paidAt: utcInstant.nullable(),
    activatedAt: utcInstant.nullable(),
  })
  .strict();
export type OrderSummary = z.infer<typeof orderSummary>;

export const orderList = z.object({
  orders: z.array(orderSummary),
  total: z.number().int().nonnegative(),
});

export const ledgerEntry = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["purchase", "top_up", "usage", "adjustment", "expiry"]),
    weightedTokensDelta: z.number().int(),
    balanceAfter: z.number().int(),
    estimated: z.boolean(),
    meterVersion: z.string().min(1),
    /** Correlation ID only — never prompt or response content (§16 privacy). */
    requestId: z.string().nullable(),
    createdAt: utcInstant,
    reason: z.string().nullable(),
  })
  .strict();
export type LedgerEntry = z.infer<typeof ledgerEntry>;

export const orderDetail = z.object({
  order: orderSummary,
  packageSnapshot: z.object({
    name: z.string().min(1),
    weightedTokenQuota: z.number().int().positive(),
    priceIdr: rupiah.nonnegative(),
    durationSeconds: z.number().int().positive(),
  }),
  targetApiKeyPrefix: z.string().nullable(),
  stockReservationExpiresAt: utcInstant.nullable(),
  ledger: z.array(ledgerEntry),
  paymentEvents: z.array(
    z
      .object({
        id: z.string().min(1),
        status: z.string().min(1),
        receivedAt: utcInstant,
        processedAt: utcInstant.nullable(),
        errorCode: z.string().nullable(),
      })
      .strict(),
  ),
});
export type OrderDetail = z.infer<typeof orderDetail>;

/* --------------------------------------------------------------------- users */

export const adminUser = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    role: z.enum(["user", "admin"]),
    status: userStatus,
    activeKeyCount: z.number().int().nonnegative(),
    totalWeightedRemaining: z.number().int(),
    createdAt: utcInstant,
    lastLoginAt: utcInstant.nullable(),
  })
  .strict();
export type AdminUser = z.infer<typeof adminUser>;

export const userList = z.object({
  users: z.array(adminUser),
  total: z.number().int().nonnegative(),
});

/**
 * An API key as the OPERATOR sees it.
 *
 * `prefix` is a short non-secret display fragment. There is NO field for the
 * plaintext key, the ciphertext, or the lookup digest — §12 allows the customer
 * an eye toggle on their own key in apps/web; the admin surface never reveals
 * one (§16/§17). `.strict()` enforces it.
 */
export const apiKeySummary = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    username: z.string().min(1),
    label: z.string().nullable(),
    prefix: z.string().min(1),
    status: keyStatus,
    quotaLimit: z.number().int().nonnegative(),
    quotaRemaining: z.number().int(),
    expiresAt: utcInstant.nullable(),
    createdAt: utcInstant,
    lastUsedAt: utcInstant.nullable(),
  })
  .strict();
export type ApiKeySummary = z.infer<typeof apiKeySummary>;

export const apiKeyList = z.object({
  keys: z.array(apiKeySummary),
  total: z.number().int().nonnegative(),
});

export const userDetail = z.object({
  user: adminUser,
  keys: z.array(apiKeySummary),
});
export type UserDetail = z.infer<typeof userDetail>;

/* --------------------------------------------------------------------- flags */

export const flagScope = z.enum(["global", "region", "model", "account", "tool_use"]);
export type FlagScope = z.infer<typeof flagScope>;

export const featureFlag = z
  .object({
    key: z.string().min(1),
    scope: flagScope,
    /** Null for the global/tool-use switches, which have no target. */
    target: z.string().nullable(),
    label: z.string().min(1),
    /** True = traffic ALLOWED. A kill switch is engaged when this is false. */
    enabled: z.boolean(),
    /** Plain-language blast radius, shown in the confirmation dialog (§3). */
    blastRadius: z.string().min(1),
    updatedAt: utcInstant.nullable(),
    updatedBy: z.string().nullable(),
  })
  .strict();
export type FeatureFlag = z.infer<typeof featureFlag>;

export const flagList = z.object({
  flags: z.array(featureFlag),
  /** Env-level KIRO_DIRECT_ENABLED. Read-only here: it is set in admin.env. */
  kiroDirectEnabled: z.boolean(),
});
export type FlagList = z.infer<typeof flagList>;

/* --------------------------------------------------------------------- audit */

export const auditEvent = z
  .object({
    id: z.string().min(1),
    actorType: z.enum(["admin", "system", "user"]),
    actorId: z.string().min(1),
    actorLabel: z.string().min(1),
    action: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    reason: z.string().nullable(),
    createdAt: utcInstant,
  })
  .strict();
export type AuditEvent = z.infer<typeof auditEvent>;

export const auditList = z.object({
  events: z.array(auditEvent),
  total: z.number().int().nonnegative(),
});

/* -------------------------------------------------------------------- health */

export const healthComponent = z
  .object({
    name: z.string().min(1),
    state: z.enum(["healthy", "degraded", "down"]),
    detail: z.string().min(1),
    checkedAt: utcInstant,
  })
  .strict();
export type HealthComponent = z.infer<typeof healthComponent>;

export const healthReport = z.object({
  components: z.array(healthComponent),
  providerPool: z.object({
    healthy: z.number().int().nonnegative(),
    coolingDown: z.number().int().nonnegative(),
    credentialInvalid: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
  }),
  reconciliation: z.object({
    lastRunAt: utcInstant.nullable(),
    lagSeconds: z.number().int().nonnegative().nullable(),
    pendingOrders: z.number().int().nonnegative(),
    reviewRequiredOrders: z.number().int().nonnegative(),
  }),
});
export type HealthReport = z.infer<typeof healthReport>;

/* ------------------------------------------------------------------- session */

export const adminSession = z
  .object({
    userId: z.string().min(1),
    username: z.string().min(1),
    role: z.literal("admin"),
    expiresAt: utcInstant,
  })
  .strict();
export type AdminSession = z.infer<typeof adminSession>;

/** Every mutation returns this. `ok:false` carries a safe, classified message. */
export const mutationResult = z.object({
  ok: z.boolean(),
  message: z.string().min(1),
});
export type MutationResult = z.infer<typeof mutationResult>;
