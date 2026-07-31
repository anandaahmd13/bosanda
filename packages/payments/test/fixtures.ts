/**
 * Synthetic fixtures for the payments suite. No live PostgreSQL, no network, no real
 * credentials — every dependency is injected.
 */

import { fixedClock } from "@bosanda/shared";
import type { OrderSnapshot, OrderStatus, OrderType, PackageSnapshot } from "../src/types.js";
import type {
  PakasirConfig,
  PakasirDeps,
  PakasirHttpRequest,
  PakasirHttpResponse,
} from "../src/pakasir.js";
import type { PaymentEventStore } from "../src/webhook.js";

/** Fixed reference instant for the whole suite. UTC. */
export const NOW = new Date("2026-03-01T12:00:00.000Z");
export const clock = fixedClock(NOW);

/** Not a real secret — a synthetic value that satisfies the >=16 char env rule. */
export const TEST_SECRET = "test-webhook-secret-0123456789";

export const TEN_M = 10_000_000;

export function packageSnapshot(overrides: Partial<PackageSnapshot> = {}): PackageSnapshot {
  return {
    packageId: "01JQPKG0000000000000000010",
    weightedTokenQuota: TEN_M,
    priceIdr: 9_500,
    maxKeyQuota: 100_000_000,
    durationSeconds: 24 * 60 * 60,
    ...overrides,
  };
}

export function order(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  const snapshot = overrides.packageSnapshot ?? packageSnapshot();
  return {
    orderId: "01JQORDER00000000000000001",
    userId: "01JQUSER000000000000000001",
    type: "new_key" as OrderType,
    targetApiKeyId: null,
    packageSnapshot: snapshot,
    amountIdr: snapshot.priceIdr,
    currency: "IDR",
    status: "pending_payment" as OrderStatus,
    stockReservationExpiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
    provider: "pakasir",
    providerTransactionId: null,
    paidAt: null,
    activatedAt: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

/** A paid new-key order, ready for activation. */
export function paidOrder(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return order({
    status: "paid",
    paidAt: NOW,
    providerTransactionId: "trx_synthetic_1",
    ...overrides,
  });
}

export const config: PakasirConfig = {
  baseUrl: "https://pakasir.test",
  project: "bosanda-test",
  apiKey: "pakasir-api-key-synthetic",
  timeoutMs: 1_000,
  maxAttempts: 3,
};

export type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

/**
 * Scripted transport. Each queued step is one attempt: either a response or a thrown
 * failure. Records every call so tests can assert request shape and attempt count.
 */
export type Step =
  | { status: number; body: string }
  | { throws: unknown }
  /** Never settles, so the hard timeout fires. */
  | { hang: true };

export function fakeTransport(steps: Step[]): {
  deps: PakasirDeps;
  calls: RecordedCall[];
  sleeps: number[];
} {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let index = 0;

  const transport = async (request: PakasirHttpRequest): Promise<PakasirHttpResponse> => {
    calls.push({
      url: request.url,
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
    });

    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error("fakeTransport: no step queued for this attempt");

    if ("throws" in step) throw step.throws;
    if ("hang" in step) {
      return await new Promise<PakasirHttpResponse>(() => {
        /* never settles */
      });
    }
    return { status: step.status, text: async () => step.body };
  };

  return {
    deps: {
      transport,
      clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      // Deterministic jitter so backoff values are assertable.
      random: () => 0.5,
    },
    calls,
    sleeps,
  };
}

/** In-memory idempotency store mirroring the payment_events UNIQUE constraint. */
export function fakeEventStore(): PaymentEventStore & { keys: string[] } {
  const seen = new Set<string>();
  return {
    keys: [],
    async claim(input) {
      const composite = `${input.provider}:${input.eventKey}`;
      if (seen.has(composite)) return "duplicate";
      seen.add(composite);
      this.keys.push(input.eventKey);
      return "claimed";
    },
  };
}
