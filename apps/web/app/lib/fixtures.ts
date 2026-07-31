/**
 * Dev-mode fixtures. SERVER ONLY.
 *
 * NO BACKEND EXISTS in this repo tree yet (see docs/IMPLEMENTATION-STATUS.md:
 * `database`, `auth`, `api-keys`, `payments`, and `apps/gateway` are all still
 * listed as remaining). These values exist so the pages render and can be
 * reviewed locally. They are reachable only when `USE_FIXTURES` is true, which
 * requires BOSANDA_WEB_FIXTURES=1 and a non-production NODE_ENV.
 *
 * Every fixture is obviously fake on screen: usernames are `demo`, keys are
 * `bsk_demo…`, and `<FixtureBanner />` renders a persistent warning strip. The
 * goal is that nobody can mistake a fixture screenshot for production state.
 *
 * Nothing here is a claim about real behaviour. In particular the model list is
 * empty because no model has passed the §3 compatibility gate.
 */

import type {
  Account,
  KeySummary,
  Order,
  Quota,
  RevealedKey,
  Storefront,
  TopUpCandidate,
  UsageSeries,
} from "./schemas";
import { PACKAGE_SIZES } from "./packages";
import { PUBLIC_WEB_URL } from "./env";

const HOUR_MS = 3_600_000;

/** Fixed instant so repeated renders are stable and diffable. */
function baseNow(): number {
  return Date.now();
}

function iso(offsetMs: number): string {
  return new Date(baseNow() + offsetMs).toISOString();
}

/**
 * Stock that exercises every storefront state an operator will actually see:
 * plenty available, low, sold out, and admin-disabled.
 */
export function fixtureStorefront(): Storefront {
  return {
    // Deliberately true so the package grid is reviewable. In reality §3/§9
    // keep this false until a model passes the gate.
    salesEnabled: true,
    stock: PACKAGE_SIZES.map((size, index) => ({
      packageId: size.id,
      tokens: size.tokens,
      priceIdr: size.priceIdr,
      // 30M and 70M sold out; 100M disabled by an admin; the rest in stock.
      available: index === 2 || index === 6 ? 0 : index === 9 ? 0 : 4 + index,
      enabled: index !== 9,
    })),
  };
}

export function fixtureAccount(): Account {
  return {
    userId: "usr_demo000000000000000000",
    username: "demo",
    role: "user",
    status: "active",
    createdAt: iso(-72 * HOUR_MS),
  };
}

export function fixtureQuota(): Quota {
  return {
    remaining: 6_420_000,
    total: 10_000_000,
    expiresAt: iso(3 * HOUR_MS + 12 * 60_000),
    activeKeyCount: 2,
    // True so the "estimated usage" disclosure (§10) is visible in dev.
    hasEstimatedUsage: true,
  };
}

/** 24 hourly buckets — the key validity window (§11). */
export function fixtureUsage(): UsageSeries {
  const shape = [
    0, 0, 0, 0, 120_000, 340_000, 180_000, 0, 0, 60_000, 420_000, 510_000, 300_000, 0, 0, 90_000,
    260_000, 180_000, 0, 40_000, 220_000, 150_000, 80_000, 0,
  ];
  return {
    bucketMinutes: 60,
    buckets: shape.map((weightedTokens, index) => ({
      at: iso((index - shape.length + 1) * HOUR_MS),
      weightedTokens,
    })),
  };
}

/** One of each key state so the table's status chips are all reviewable. */
export function fixtureKeys(): KeySummary[] {
  return [
    {
      keyId: "key_demo0000000000000000a",
      masked: "bsk_demo••••••••••••4f2a",
      status: "active",
      createdAt: iso(-4 * HOUR_MS),
      expiresAt: iso(3 * HOUR_MS + 12 * 60_000),
      quotaTotal: 10_000_000,
      quotaRemaining: 6_420_000,
    },
    {
      keyId: "key_demo0000000000000000b",
      masked: "bsk_demo••••••••••••91c7",
      status: "active",
      createdAt: iso(-9 * HOUR_MS),
      expiresAt: iso(14 * HOUR_MS),
      quotaTotal: 20_000_000,
      quotaRemaining: 19_100_000,
    },
    {
      keyId: "key_demo0000000000000000c",
      masked: "bsk_demo••••••••••••0de5",
      status: "exhausted",
      createdAt: iso(-30 * HOUR_MS),
      expiresAt: iso(-6 * HOUR_MS),
      quotaTotal: 10_000_000,
      quotaRemaining: 0,
    },
    {
      keyId: "key_demo0000000000000000d",
      masked: "bsk_demo••••••••••••77b1",
      status: "revoked",
      createdAt: iso(-50 * HOUR_MS),
      expiresAt: null,
      quotaTotal: 10_000_000,
      quotaRemaining: 3_000_000,
    },
  ];
}

/**
 * A fake "revealed" key. Even in fixtures this is not a real credential shape;
 * it is a visibly-demo string so a screenshot cannot leak anything.
 */
export function fixtureRevealedKey(keyId: string): RevealedKey {
  return {
    keyId,
    plaintext: `bsk_demo_NOT_A_REAL_KEY_${keyId.slice(-4)}`,
    auditedAt: iso(0),
  };
}

/** Order history covering every §13 state the user can encounter. */
export function fixtureOrders(): Order[] {
  return [
    {
      orderId: "ord_demo0000000000000001",
      status: "activated",
      priceIdr: 9_500,
      tokens: 10_000_000,
      packageId: "p10m",
      intent: "new_key",
      targetKeyId: null,
      createdAt: iso(-4 * HOUR_MS),
      paymentUrl: null,
      activatedKeyId: "key_demo0000000000000000a",
    },
    {
      orderId: "ord_demo0000000000000002",
      status: "pending_payment",
      priceIdr: 28_500,
      tokens: 30_000_000,
      packageId: "p30m",
      intent: "new_key",
      targetKeyId: null,
      createdAt: iso(-30 * 60_000),
      paymentUrl: "https://pakasir.example/pay/demo-pending",
      activatedKeyId: null,
    },
    {
      orderId: "ord_demo0000000000000003",
      status: "expired",
      priceIdr: 19_000,
      tokens: 20_000_000,
      packageId: "p20m",
      intent: "new_key",
      targetKeyId: null,
      createdAt: iso(-28 * HOUR_MS),
      paymentUrl: null,
      activatedKeyId: null,
    },
    {
      orderId: "ord_demo0000000000000004",
      status: "review_required",
      priceIdr: 95_000,
      tokens: 100_000_000,
      packageId: "p100m",
      intent: "top_up",
      targetKeyId: "key_demo0000000000000000b",
      createdAt: iso(-50 * HOUR_MS),
      paymentUrl: null,
      activatedKeyId: null,
    },
  ];
}

/** Only active, non-exhausted keys are eligible to receive a top-up (§11). */
export function fixtureTopUpCandidates(): TopUpCandidate[] {
  return [
    {
      keyId: "key_demo0000000000000000a",
      masked: "bsk_demo••••••••••••4f2a",
      quotaRemaining: 6_420_000,
      expiresAt: iso(3 * HOUR_MS + 12 * 60_000),
      // 100M cap minus what is already on the key (§11).
      maxTopUpTokens: 90_000_000,
    },
    {
      keyId: "key_demo0000000000000000b",
      masked: "bsk_demo••••••••••••91c7",
      quotaRemaining: 19_100_000,
      expiresAt: iso(14 * HOUR_MS),
      maxTopUpTokens: 80_000_000,
    },
  ];
}

/** Fixture order created by checkout, so the return/polling page has a target. */
export function fixtureCreatedOrder(packageId: string, tokens: number, priceIdr: number): Order {
  const orderId = `ord_demo${Date.now().toString(36)}`;
  return {
    orderId,
    status: "pending_payment",
    priceIdr,
    tokens,
    packageId,
    intent: "new_key",
    targetKeyId: null,
    createdAt: iso(0),
    // Points back at our own mock so no third-party request is made in dev.
    // Absolute, because the real provider sends an absolute URL and the schema
    // (`paymentUrl: z.url()`) requires one — a relative path here would typecheck
    // but would not be what the gateway path produces.
    paymentUrl: `${PUBLIC_WEB_URL}/checkout/mock-provider?order_id=${encodeURIComponent(orderId)}`,
    activatedKeyId: null,
  };
}
