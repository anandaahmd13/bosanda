/**
 * DEV-MODE FIXTURES — not a backend, and never used in production.
 *
 * No backend exists in this repo tree yet (see docs/IMPLEMENTATION-STATUS.md
 * "Remaining"), so `api.ts` falls back to these so pages render locally. The
 * single switch is `USE_FIXTURES` in `./api-mode.ts`; nothing here is imported
 * by any component directly.
 *
 * Every value below is fabricated. Mutations are accepted and discarded — they
 * do not persist across requests, by design: a fixture that appeared to save
 * would be worse than one that obviously does not.
 *
 * SECURITY: even the fake data contains no plaintext key, credential, prompt,
 * or tool payload. The fixtures must satisfy the same `.strict()` schemas as a
 * real backend, which is the point.
 */

import type {
  AdminSession,
  ApiKeySummary,
  AuditEvent,
  FeatureFlag,
  HealthReport,
  LedgerEntry,
  Model,
  OrderDetail,
  OrderSummary,
  Overview,
  PackageDefinition,
  ProviderAccount,
  AdminUser,
} from "./schemas";

/** Fixed clock so fixture pages are deterministic across reloads. */
const NOW = Date.parse("2026-07-31T10:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const fixtureSession: AdminSession = {
  userId: "usr_01J8Z9QK3M0000000000ADMIN",
  username: "operator",
  role: "admin",
  expiresAt: iso(8 * HOUR),
};

export const fixtureOverview: Overview = {
  metrics: {
    windowSeconds: 86_400,
    requestCount: 48_213,
    errorCount: 604,
    errorRate: 604 / 48_213,
    latencyMs: { p50: 812, p95: 4_190, p99: 9_640 },
    weightedTokensServed: 812_400_000,
    activeStreams: 7,
    revenueIdr: 2_641_500,
    healthyAccounts: 4,
    totalAccounts: 6,
  },
  series: Array.from({ length: 24 }, (_, i) => {
    // Deterministic pseudo-shape; a diurnal curve reads better than noise.
    const wave = Math.sin((i / 24) * Math.PI * 2 - Math.PI / 2) + 1;
    const requests = Math.round(1_200 + wave * 900);
    return {
      at: iso(-(23 - i) * HOUR),
      requests,
      errors: Math.round(requests * (i === 14 ? 0.09 : 0.012)),
      weightedTokens: requests * 16_800,
    };
  }),
  killSwitchSummary: {
    adapterEnabled: true,
    kiroDirectEnabled: false,
    toolUseEnabled: true,
    disabledRegionCount: 0,
    disabledModelCount: 1,
    disabledAccountCount: 1,
  },
};

export const fixtureAccounts: ProviderAccount[] = [
  {
    id: "acc_01J8Z9QK3M0000000000000A",
    label: "kiro-pool-01",
    providerType: "kiro",
    status: "active",
    region: "us-east-1",
    persona: "cli",
    activeRequests: 3,
    errorScore: 0,
    cooldownUntil: null,
    lastValidatedAt: iso(-12 * MINUTE),
    credentialVersion: 4,
    hasStoredCredential: true,
    lastErrorClass: null,
    lastErrorCount24h: 0,
    weightedTokens24h: 214_800_000,
  },
  {
    id: "acc_01J8Z9QK3M0000000000000B",
    label: "kiro-pool-02",
    providerType: "kiro",
    status: "active",
    region: "us-east-1",
    persona: "cli",
    activeRequests: 1,
    errorScore: 0.4,
    cooldownUntil: null,
    lastValidatedAt: iso(-9 * MINUTE),
    credentialVersion: 2,
    hasStoredCredential: true,
    lastErrorClass: "upstream_timeout",
    lastErrorCount24h: 3,
    weightedTokens24h: 198_100_000,
  },
  {
    id: "acc_01J8Z9QK3M0000000000000C",
    label: "kiro-pool-03",
    providerType: "kiro",
    status: "cooling_down",
    region: "eu-west-1",
    persona: "ide",
    activeRequests: 0,
    errorScore: 3.1,
    cooldownUntil: iso(18_000),
    lastValidatedAt: iso(-41 * MINUTE),
    credentialVersion: 7,
    hasStoredCredential: true,
    lastErrorClass: "upstream_incompatible",
    lastErrorCount24h: 27,
    weightedTokens24h: 96_400_000,
  },
  {
    id: "acc_01J8Z9QK3M0000000000000D",
    label: "kiro-pool-04",
    providerType: "kiro",
    status: "credential_invalid",
    region: "us-west-2",
    persona: "cli",
    activeRequests: 0,
    errorScore: 9.6,
    cooldownUntil: null,
    lastValidatedAt: iso(-6 * HOUR),
    credentialVersion: 1,
    hasStoredCredential: true,
    lastErrorClass: "credential_invalid",
    lastErrorCount24h: 12,
    weightedTokens24h: 0,
  },
  {
    id: "acc_01J8Z9QK3M0000000000000E",
    label: "kiro-pool-05",
    providerType: "kiro",
    status: "disabled",
    region: "us-east-1",
    persona: "cli",
    activeRequests: 0,
    errorScore: 0,
    cooldownUntil: null,
    lastValidatedAt: iso(-3 * HOUR),
    credentialVersion: 3,
    hasStoredCredential: true,
    lastErrorClass: null,
    lastErrorCount24h: 0,
    weightedTokens24h: 0,
  },
  {
    id: "acc_01J8Z9QK3M0000000000000F",
    label: "kiro-pool-06",
    providerType: "kiro",
    status: "active",
    region: "ap-southeast-1",
    persona: "cli",
    activeRequests: 2,
    errorScore: 0.1,
    cooldownUntil: null,
    lastValidatedAt: iso(-4 * MINUTE),
    credentialVersion: 2,
    hasStoredCredential: true,
    lastErrorClass: null,
    lastErrorCount24h: 1,
    weightedTokens24h: 303_100_000,
  },
];

export const fixtureModels: Model[] = [
  {
    publicId: "bosanda-sonnet-4",
    upstreamId: "CLAUDE_SONNET_4_20250514_V1_0",
    label: "Bosanda Sonnet 4",
    contextWindow: 200_000,
    multiplier: 1.3,
    multiplierVersion: 3,
    multiplierEffectiveAt: iso(-72 * HOUR),
    supportsTools: true,
    supportsReasoning: true,
    regions: ["us-east-1", "eu-west-1"],
    published: true,
    compatibilityStatus: "passing",
  },
  {
    publicId: "bosanda-haiku-3-5",
    upstreamId: "CLAUDE_HAIKU_3_5_20241022_V1_0",
    label: "Bosanda Haiku 3.5",
    contextWindow: 200_000,
    multiplier: 1,
    multiplierVersion: 1,
    multiplierEffectiveAt: iso(-240 * HOUR),
    supportsTools: true,
    supportsReasoning: false,
    regions: ["us-east-1"],
    published: true,
    compatibilityStatus: "passing",
  },
  {
    publicId: "bosanda-opus-4",
    upstreamId: "CLAUDE_OPUS_4_20250514_V1_0",
    label: "Bosanda Opus 4",
    contextWindow: 200_000,
    multiplier: 2.2,
    multiplierVersion: 2,
    multiplierEffectiveAt: iso(-36 * HOUR),
    supportsTools: true,
    supportsReasoning: true,
    regions: ["us-east-1"],
    published: false,
    compatibilityStatus: "unknown",
  },
  {
    publicId: "bosanda-sonnet-3-7",
    upstreamId: "CLAUDE_SONNET_3_7_20250219_V1_0",
    label: "Bosanda Sonnet 3.7",
    contextWindow: 200_000,
    multiplier: 1.3,
    multiplierVersion: 1,
    multiplierEffectiveAt: iso(-500 * HOUR),
    supportsTools: false,
    supportsReasoning: false,
    regions: ["us-east-1"],
    published: false,
    compatibilityStatus: "failing",
  },
];

/** 10M–100M at Rp9.500 per 10M (§11). Stock is manual per size. */
export const fixturePackages: PackageDefinition[] = Array.from({ length: 10 }, (_, i) => {
  const tens = i + 1;
  const available = [12, 8, 6, 4, 0, 3, 2, 1, 0, 1][i] ?? 0;
  const reserved = [2, 1, 0, 1, 0, 0, 1, 0, 0, 0][i] ?? 0;
  return {
    id: `pkg_${tens * 10}m`,
    name: `${tens * 10}M weighted tokens`,
    weightedTokenQuota: tens * 10_000_000,
    priceIdr: tens * 9_500,
    durationSeconds: 86_400,
    maxKeyQuota: 100_000_000,
    active: true,
    stock: { available, reserved, version: 3 + i, updatedAt: iso(-2 * HOUR) },
    soldOut: available === 0,
  };
});

export const fixtureOrders: OrderSummary[] = [
  {
    id: "ord_01J8Z9QK3M00000000000001",
    username: "andi",
    userId: "usr_01J8Z9QK3M00000000000101",
    packageName: "30M weighted tokens",
    type: "new_key",
    amountIdr: 28_500,
    status: "activated",
    provider: "pakasir",
    providerTransactionId: "PKS-2026073100412",
    createdAt: iso(-5 * HOUR),
    paidAt: iso(-5 * HOUR + 4 * MINUTE),
    activatedAt: iso(-5 * HOUR + 4 * MINUTE + 2_000),
  },
  {
    id: "ord_01J8Z9QK3M00000000000002",
    username: "budi",
    userId: "usr_01J8Z9QK3M00000000000102",
    packageName: "10M weighted tokens",
    type: "top_up",
    amountIdr: 9_500,
    status: "paid",
    provider: "pakasir",
    providerTransactionId: "PKS-2026073100518",
    createdAt: iso(-38 * MINUTE),
    paidAt: iso(-31 * MINUTE),
    activatedAt: null,
  },
  {
    id: "ord_01J8Z9QK3M00000000000003",
    username: "citra",
    userId: "usr_01J8Z9QK3M00000000000103",
    packageName: "100M weighted tokens",
    type: "new_key",
    amountIdr: 95_000,
    status: "pending_payment",
    provider: "pakasir",
    providerTransactionId: "PKS-2026073100601",
    createdAt: iso(-11 * MINUTE),
    paidAt: null,
    activatedAt: null,
  },
  {
    id: "ord_01J8Z9QK3M00000000000004",
    username: "dewi",
    userId: "usr_01J8Z9QK3M00000000000104",
    packageName: "20M weighted tokens",
    type: "new_key",
    amountIdr: 19_000,
    status: "review_required",
    provider: "pakasir",
    providerTransactionId: "PKS-2026073100233",
    createdAt: iso(-9 * HOUR),
    paidAt: iso(-9 * HOUR + 3 * MINUTE),
    activatedAt: null,
  },
  {
    id: "ord_01J8Z9QK3M00000000000005",
    username: "eko",
    userId: "usr_01J8Z9QK3M00000000000105",
    packageName: "50M weighted tokens",
    type: "new_key",
    amountIdr: 47_500,
    status: "expired",
    provider: "pakasir",
    providerTransactionId: null,
    createdAt: iso(-30 * HOUR),
    paidAt: null,
    activatedAt: null,
  },
  {
    id: "ord_01J8Z9QK3M00000000000006",
    username: "fitri",
    userId: "usr_01J8Z9QK3M00000000000106",
    packageName: "40M weighted tokens",
    type: "new_key",
    amountIdr: 38_000,
    status: "cancelled",
    provider: "pakasir",
    providerTransactionId: null,
    createdAt: iso(-26 * HOUR),
    paidAt: null,
    activatedAt: null,
  },
];

const fixtureLedger: LedgerEntry[] = [
  {
    id: "led_01J8Z9QK3M00000000000001",
    kind: "purchase",
    weightedTokensDelta: 30_000_000,
    balanceAfter: 30_000_000,
    estimated: false,
    meterVersion: "meter-1",
    requestId: null,
    createdAt: iso(-5 * HOUR + 4 * MINUTE),
    reason: "Order activation",
  },
  {
    id: "led_01J8Z9QK3M00000000000002",
    kind: "usage",
    weightedTokensDelta: -1_284_000,
    balanceAfter: 28_716_000,
    estimated: false,
    meterVersion: "meter-1",
    requestId: "req_01J8Z9QK3M0000000000AA01",
    createdAt: iso(-4 * HOUR),
    reason: null,
  },
  {
    id: "led_01J8Z9QK3M00000000000003",
    kind: "usage",
    weightedTokensDelta: -640_500,
    balanceAfter: 28_075_500,
    estimated: true,
    meterVersion: "meter-1-fallback",
    requestId: "req_01J8Z9QK3M0000000000AA02",
    createdAt: iso(-2 * HOUR),
    reason: null,
  },
];

export function fixtureOrderDetail(orderId: string): OrderDetail | null {
  const order = fixtureOrders.find((candidate) => candidate.id === orderId);
  if (order === undefined) return null;

  const tens = Math.max(1, Math.round(order.amountIdr / 9_500));
  return {
    order,
    packageSnapshot: {
      name: order.packageName,
      weightedTokenQuota: tens * 10_000_000,
      priceIdr: order.amountIdr,
      durationSeconds: 86_400,
    },
    targetApiKeyPrefix: order.type === "top_up" ? "bsk_live_7Qm4" : null,
    stockReservationExpiresAt: order.status === "pending_payment" ? iso(19 * MINUTE) : null,
    ledger: order.status === "activated" ? fixtureLedger : [],
    paymentEvents:
      order.providerTransactionId === null
        ? []
        : [
            {
              id: "pev_01J8Z9QK3M00000000000001",
              status: order.paidAt === null ? "received" : "processed",
              receivedAt: order.paidAt ?? order.createdAt,
              processedAt: order.activatedAt,
              errorCode: order.status === "review_required" ? "amount_mismatch" : null,
            },
          ],
  };
}

export const fixtureUsers: AdminUser[] = [
  {
    id: "usr_01J8Z9QK3M00000000000101",
    username: "andi",
    role: "user",
    status: "active",
    activeKeyCount: 2,
    totalWeightedRemaining: 28_075_500,
    createdAt: iso(-40 * 24 * HOUR),
    lastLoginAt: iso(-3 * HOUR),
  },
  {
    id: "usr_01J8Z9QK3M00000000000102",
    username: "budi",
    role: "user",
    status: "active",
    activeKeyCount: 1,
    totalWeightedRemaining: 4_120_000,
    createdAt: iso(-12 * 24 * HOUR),
    lastLoginAt: iso(-45 * MINUTE),
  },
  {
    id: "usr_01J8Z9QK3M00000000000103",
    username: "citra",
    role: "user",
    status: "active",
    activeKeyCount: 0,
    totalWeightedRemaining: 0,
    createdAt: iso(-2 * 24 * HOUR),
    lastLoginAt: iso(-11 * MINUTE),
  },
  {
    id: "usr_01J8Z9QK3M00000000000104",
    username: "dewi",
    role: "user",
    status: "disabled",
    activeKeyCount: 0,
    totalWeightedRemaining: 0,
    createdAt: iso(-90 * 24 * HOUR),
    lastLoginAt: iso(-9 * HOUR),
  },
  {
    id: "usr_01J8Z9QK3M0000000000ADMIN",
    username: "operator",
    role: "admin",
    status: "active",
    activeKeyCount: 0,
    totalWeightedRemaining: 0,
    createdAt: iso(-120 * 24 * HOUR),
    lastLoginAt: iso(-2 * MINUTE),
  },
];

export const fixtureKeys: ApiKeySummary[] = [
  {
    id: "key_01J8Z9QK3M00000000000201",
    userId: "usr_01J8Z9QK3M00000000000101",
    username: "andi",
    label: "claude-code-laptop",
    prefix: "bsk_live_7Qm4",
    status: "active",
    quotaLimit: 30_000_000,
    quotaRemaining: 28_075_500,
    expiresAt: iso(19 * HOUR),
    createdAt: iso(-5 * HOUR),
    lastUsedAt: iso(-2 * HOUR),
  },
  {
    id: "key_01J8Z9QK3M00000000000202",
    userId: "usr_01J8Z9QK3M00000000000101",
    username: "andi",
    label: "ci-runner",
    prefix: "bsk_live_K2pR",
    status: "expired",
    quotaLimit: 10_000_000,
    quotaRemaining: 2_300_000,
    expiresAt: iso(-6 * HOUR),
    createdAt: iso(-30 * HOUR),
    lastUsedAt: iso(-7 * HOUR),
  },
  {
    id: "key_01J8Z9QK3M00000000000203",
    userId: "usr_01J8Z9QK3M00000000000102",
    username: "budi",
    label: null,
    prefix: "bsk_live_Xy91",
    status: "active",
    quotaLimit: 10_000_000,
    quotaRemaining: 4_120_000,
    expiresAt: iso(23 * HOUR),
    createdAt: iso(-31 * MINUTE),
    lastUsedAt: iso(-4 * MINUTE),
  },
  {
    id: "key_01J8Z9QK3M00000000000204",
    userId: "usr_01J8Z9QK3M00000000000104",
    username: "dewi",
    label: "old-key",
    prefix: "bsk_live_Zz00",
    status: "revoked",
    quotaLimit: 20_000_000,
    quotaRemaining: 0,
    expiresAt: null,
    createdAt: iso(-9 * HOUR),
    lastUsedAt: null,
  },
];

export const fixtureFlags: FeatureFlag[] = [
  {
    key: "adapter.global",
    scope: "global",
    target: null,
    label: "Global Kiro adapter",
    enabled: true,
    blastRadius:
      "Turning this off stops ALL API traffic for every customer immediately. Kiro models disappear from /v1/models, in-flight streams are allowed to finish, and new requests get a sanitized 503. No payment can activate a package while this is off.",
    updatedAt: iso(-14 * 24 * HOUR),
    updatedBy: "operator",
  },
  {
    key: "adapter.tool_use",
    scope: "tool_use",
    target: null,
    label: "Tool use",
    enabled: true,
    blastRadius:
      "Turning this off breaks Claude Code for every customer: tool definitions are rejected and agentic sessions cannot run. Plain chat completions keep working.",
    updatedAt: iso(-14 * 24 * HOUR),
    updatedBy: "operator",
  },
  {
    key: "adapter.region.eu-west-1",
    scope: "region",
    target: "eu-west-1",
    label: "Region eu-west-1",
    enabled: true,
    blastRadius:
      "Turning this off removes 1 account from the pool. Requests shift to the remaining regions; if none are healthy, customers get a 503.",
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: "adapter.region.ap-southeast-1",
    scope: "region",
    target: "ap-southeast-1",
    label: "Region ap-southeast-1",
    enabled: true,
    blastRadius:
      "Turning this off removes 1 account from the pool, including the busiest one in the last 24h. Expect a latency increase for customers routed there.",
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: "adapter.model.bosanda-sonnet-3-7",
    scope: "model",
    target: "bosanda-sonnet-3-7",
    label: "Model bosanda-sonnet-3-7",
    enabled: false,
    blastRadius:
      "While off, this model is hidden from /v1/models and any request naming it is rejected with a 403. Customers using it must switch models.",
    updatedAt: iso(-2 * 24 * HOUR),
    updatedBy: "operator",
  },
  {
    key: "adapter.model.bosanda-sonnet-4",
    scope: "model",
    target: "bosanda-sonnet-4",
    label: "Model bosanda-sonnet-4",
    enabled: true,
    blastRadius:
      "This is the default published model and carries most traffic. Turning it off will break the majority of active customer integrations.",
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: "adapter.account.acc_01J8Z9QK3M0000000000000E",
    scope: "account",
    target: "acc_01J8Z9QK3M0000000000000E",
    label: "Account kiro-pool-05",
    enabled: false,
    blastRadius:
      "While off, this account is skipped by the scheduler. Its in-flight requests finish. Pool capacity drops by one account.",
    updatedAt: iso(-3 * HOUR),
    updatedBy: "operator",
  },
];

export const fixtureAudit: AuditEvent[] = [
  {
    id: "aud_01J8Z9QK3M00000000000001",
    actorType: "admin",
    actorId: "usr_01J8Z9QK3M0000000000ADMIN",
    actorLabel: "operator",
    action: "flag.disable",
    targetType: "model",
    targetId: "bosanda-sonnet-3-7",
    reason: "Tool-use compatibility suite failing since adapter v0.4.1",
    createdAt: iso(-2 * 24 * HOUR),
  },
  {
    id: "aud_01J8Z9QK3M00000000000002",
    actorType: "admin",
    actorId: "usr_01J8Z9QK3M0000000000ADMIN",
    actorLabel: "operator",
    action: "account.disable",
    targetType: "provider_account",
    targetId: "acc_01J8Z9QK3M0000000000000E",
    reason: "Rotating credentials with the provider",
    createdAt: iso(-3 * HOUR),
  },
  {
    id: "aud_01J8Z9QK3M00000000000003",
    actorType: "system",
    actorId: "worker",
    actorLabel: "reconciliation worker",
    action: "order.review_required",
    targetType: "order",
    targetId: "ord_01J8Z9QK3M00000000000004",
    reason: "Provider amount did not match the order snapshot",
    createdAt: iso(-9 * HOUR),
  },
  {
    id: "aud_01J8Z9QK3M00000000000004",
    actorType: "admin",
    actorId: "usr_01J8Z9QK3M0000000000ADMIN",
    actorLabel: "operator",
    action: "user.password_reset",
    targetType: "user",
    targetId: "usr_01J8Z9QK3M00000000000104",
    reason: "Support ticket #412, identity verified over the published channel",
    createdAt: iso(-9 * HOUR - 20 * MINUTE),
  },
  {
    id: "aud_01J8Z9QK3M00000000000005",
    actorType: "admin",
    actorId: "usr_01J8Z9QK3M0000000000ADMIN",
    actorLabel: "operator",
    action: "key.revoke",
    targetType: "api_key",
    targetId: "key_01J8Z9QK3M00000000000204",
    reason: "Account disabled for abuse",
    createdAt: iso(-9 * HOUR - 18 * MINUTE),
  },
  {
    id: "aud_01J8Z9QK3M00000000000006",
    actorType: "admin",
    actorId: "usr_01J8Z9QK3M0000000000ADMIN",
    actorLabel: "operator",
    action: "stock.add",
    targetType: "package",
    targetId: "pkg_10m",
    reason: "Weekly capacity top-up",
    createdAt: iso(-2 * HOUR),
  },
];

export const fixtureHealth: HealthReport = {
  components: [
    {
      name: "PostgreSQL",
      state: "healthy",
      detail: "Connected, 4 of 10 pool connections in use",
      checkedAt: iso(-20_000),
    },
    {
      name: "Provider pool",
      state: "degraded",
      detail: "4 of 6 accounts eligible; 1 cooling down, 1 credential_invalid",
      checkedAt: iso(-20_000),
    },
    {
      name: "Worker",
      state: "healthy",
      detail: "Last heartbeat 12s ago",
      checkedAt: iso(-12_000),
    },
    {
      name: "Payment reconciliation",
      state: "degraded",
      detail: "Last completed run 41m ago; 1 order awaiting review",
      checkedAt: iso(-41 * MINUTE),
    },
    {
      name: "Kiro direct adapter",
      state: "down",
      detail: "KIRO_DIRECT_ENABLED=false — compatibility gate M0 not signed off",
      checkedAt: iso(-20_000),
    },
  ],
  providerPool: { healthy: 4, coolingDown: 1, credentialInvalid: 1, disabled: 1 },
  reconciliation: {
    lastRunAt: iso(-41 * MINUTE),
    lagSeconds: 41 * 60,
    pendingOrders: 1,
    reviewRequiredOrders: 1,
  },
};
