/**
 * In-memory fakes for the worker's ports.
 *
 * WHY FAKES AND NOT A DATABASE. `docs/testing.md` requires the suite to run on a machine
 * with no PostgreSQL, and every worker port is already a narrow `Pick<...>` chosen for
 * exactly that. What these fakes prove is the DISPATCH — that a decided action reaches the
 * right transaction with the right arguments. What they cannot prove is SQL behaviour:
 * `SKIP LOCKED`, the stock CHECK constraints, and real transaction rollback are the
 * integration-test surface described in `docs/testing.md`, and nothing here claims otherwise.
 *
 * THE TRANSACTION FAKE IS NOT ATOMIC. `transact` just runs the callback. A test that wants
 * to prove rollback cannot use it, and no test here pretends to — the assertions are about
 * which calls happened, not about what survives a failure. Making the fake pretend to roll
 * back would produce a test that passes for reasons unrelated to the real database.
 */

import type { ApiKey, Order, PackageStock, StockCasOutcome } from "@bosanda/database";
import { createRegistry, type Registry } from "@bosanda/observability";
import type { PakasirTransaction } from "@bosanda/payments";
import { fixedClock, type Clock } from "@bosanda/shared";
import { registerWorkerMetrics } from "../src/metrics.js";
import type { WorkerTx } from "../src/deps.js";

/**
 * A logger that records instead of writing.
 *
 * Shaped as the subset of pino the worker actually calls. `as never` at the call site is
 * avoided by keeping the recorded entries on a separate property, so a test asserting "no
 * secret was logged" can serialize `entries` directly.
 */
export type RecordingLogger = {
  entries: { level: string; obj: unknown; msg: string }[];
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export function recordingLogger(): RecordingLogger {
  const entries: { level: string; obj: unknown; msg: string }[] = [];
  const at =
    (level: string) =>
    (obj: unknown, msg = ""): void => {
      entries.push({ level, obj, msg });
    };
  return {
    entries,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

export const FIXED_NOW = new Date("2026-03-01T12:00:00.000Z");

export function testClock(now: Date = FIXED_NOW): Clock {
  return fixedClock(now);
}

export function testRegistry(): Registry {
  const registry = createRegistry();
  registerWorkerMetrics(registry);
  return registry;
}

export type OrderOverrides = Partial<Order>;

/**
 * A `pending_payment` order with a live reservation, which is the state most branches
 * start from. Every field is explicit so a test's override reads as the one thing it is
 * varying.
 */
export function makeOrder(overrides: OrderOverrides = {}): Order {
  return {
    id: "01HQORDER0000000000000001",
    userId: "01HQUSER00000000000000001",
    packageId: "pkg-small",
    packageSnapshot: {
      packageId: "pkg-small",
      weightedTokenQuota: 1_000_000,
      priceIdr: 50_000,
      maxKeyQuota: 1_000_000,
      durationSeconds: 86_400,
    },
    type: "new_key",
    targetApiKeyId: null,
    amountIdr: 50_000,
    status: "pending_payment",
    stockReservationExpiresAt: new Date(FIXED_NOW.getTime() + 600_000),
    provider: "pakasir",
    providerTransactionId: "tx-1",
    paidAt: null,
    activatedAt: null,
    createdAt: new Date(FIXED_NOW.getTime() - 3_600_000),
    updatedAt: new Date(FIXED_NOW.getTime() - 3_600_000),
    ...overrides,
  };
}

export function makeApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "01HQKEY000000000000000001",
    userId: "01HQUSER00000000000000001",
    label: null,
    prefix: "bsk_live_aaaa",
    lookupDigest: "digest-1",
    encryptedKey: "ciphertext",
    encryptionKeyVersion: 1,
    status: "active",
    quotaLimit: 1_000_000,
    quotaRemaining: 250_000,
    expiresAt: new Date(FIXED_NOW.getTime() - 1_000),
    createdAt: new Date(FIXED_NOW.getTime() - 86_400_000),
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

export function makeTransaction(overrides: Partial<PakasirTransaction> = {}): PakasirTransaction {
  return {
    orderId: "01HQORDER0000000000000001",
    status: "paid",
    amountIdr: 50_000,
    paidAt: FIXED_NOW,
    providerTransactionId: "tx-1",
    ...overrides,
  };
}

/**
 * Records every transactional call the jobs make.
 *
 * `stock` starts with a reserved unit so a release has something to give back; setting
 * `stock: null` models a package with no stock row, which §11 permits.
 */
export type TxRecorder = {
  calls: string[];
  orders: Order[];
  stock: PackageStock | null;
  releaseOutcome: StockCasOutcome;
  sweepIds: string[];
  keysById: Map<string, ApiKey>;
  audits: { action: string; targetId: string | null; metadata: Record<string, unknown> }[];
  expiries: { apiKeyId: string; weightedTokensDelta: number }[];
  /** Set to make the matching `mark*` return null, modelling a lost CAS. */
  markReturnsNull: boolean;
  tx: WorkerTx;
};

export function txRecorder(options: Partial<Omit<TxRecorder, "tx" | "calls">> = {}): TxRecorder {
  const state: TxRecorder = {
    calls: [],
    orders: options.orders ?? [],
    stock:
      options.stock === undefined
        ? { packageId: "pkg-small", available: 9, reserved: 1, version: 3, updatedAt: FIXED_NOW }
        : options.stock,
    releaseOutcome: options.releaseOutcome ?? { ok: true, version: 4, available: 9, reserved: 0 },
    sweepIds: options.sweepIds ?? [],
    keysById: options.keysById ?? new Map(),
    audits: [],
    expiries: [],
    markReturnsNull: options.markReturnsNull ?? false,
    tx: {} as WorkerTx,
  };

  const found = (id: string): Order | null => state.orders.find((o) => o.id === id) ?? null;

  state.tx = {
    orders: {
      lockById: async (id) => {
        state.calls.push(`lockById:${id}`);
        return found(id);
      },
      markExpired: async (id) => {
        state.calls.push(`markExpired:${id}`);
        return state.markReturnsNull ? null : found(id);
      },
      markCancelled: async (id) => {
        state.calls.push(`markCancelled:${id}`);
        return state.markReturnsNull ? null : found(id);
      },
      markReviewRequired: async (id, reason) => {
        state.calls.push(`markReviewRequired:${id}:${reason}`);
        return state.markReturnsNull ? null : found(id);
      },
      markActivated: async (id) => {
        state.calls.push(`markActivated:${id}`);
        return state.markReturnsNull ? null : found(id);
      },
    },
    packages: {
      lockStock: async (packageId) => {
        state.calls.push(`lockStock:${packageId}`);
        return state.stock;
      },
      releaseStock: async (packageId, units, expectedVersion) => {
        state.calls.push(`releaseStock:${packageId}:${units}:v${expectedVersion}`);
        return state.releaseOutcome;
      },
    },
    apiKeys: {
      sweepExpired: async () => {
        state.calls.push("sweepExpired");
        return state.sweepIds;
      },
      findById: async (id) => {
        state.calls.push(`findById:${id}`);
        return state.keysById.get(id) ?? null;
      },
    },
    quota: {
      recordExpiry: async (input) => {
        state.calls.push(`recordExpiry:${input.apiKeyId}`);
        state.expiries.push({
          apiKeyId: input.apiKeyId,
          weightedTokensDelta: input.weightedTokensDelta,
        });
        return {} as never;
      },
    },
    audit: {
      append: async (input) => {
        state.calls.push(`audit:${input.action}`);
        state.audits.push({
          action: input.action,
          targetId: input.targetId,
          metadata: input.metadata,
        });
        return {} as never;
      },
    },
  };

  return state;
}

/** A `transact` that simply runs the callback. See the header on why it is not atomic. */
export function immediateTransact(recorder: TxRecorder) {
  return async <T>(fn: (tx: WorkerTx) => Promise<T>): Promise<T> => fn(recorder.tx);
}
