/**
 * The admin-surface test harness.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `harness.ts` ─────────────────────────
 * `harness.ts` builds a `GatewayDeps` for the metered surfaces. `AdminDeps` is a
 * disjoint set of ports (sessions, users, orders, flags, audit, and five bespoke
 * query ports), and the customer surface is being written concurrently against the
 * same `harness.ts`. Adding thirty admin fakes there would collide on every line;
 * a new file collides on none, and the two harnesses share the small primitives
 * (`NOW`, `testEnv`, `testKeyring`) by importing them rather than duplicating them.
 *
 * ── WHAT THESE FAKES ENFORCE ──────────────────────────────────────────────
 * The properties the admin routes' correctness depends on, and nothing else:
 *   - a session lookup is by KEYED DIGEST, so a test that presents a cookie proves
 *     the real `sessionDigest` path rather than a string compare;
 *   - `audit.append` records every row, so "every mutation is audited" is asserted
 *     rather than assumed, and `assertMetadataIsSafe` runs for real;
 *   - `transact` runs the callback against ONE tx object and can be forced to
 *     reject, so a rollback leaves no audit row;
 *   - `revoke` and `markActivated` return null on a second call, matching the
 *     guarded UPDATEs (`status='active'`, `status='paid' AND activated_at IS NULL`)
 *     that make revoke and activation idempotent.
 * They do not simulate SQL, row locks, or real indexes. That is the outstanding
 * PostgreSQL integration suite's job.
 */

import { createLogger, type Logger } from "@bosanda/observability";
import { fixedClock, ulid, type Clock } from "@bosanda/shared";
import { hashPassword, sessionDigest, type SessionRecord } from "@bosanda/auth";
import type { Env, SecretKeyring } from "@bosanda/config";
import { BosandaError } from "@bosanda/protocol";
import type {
  ActivationOutcome,
  ApiKey,
  AuditEvent,
  ModelRecord,
  Order,
  PackageRecord,
  PackageStock,
  ProviderAccount,
  PublicUser,
  QuotaLedgerEntry,
  User,
} from "@bosanda/database";
import type { AdminDeps, AdminTrafficWindow, AdminTx } from "../src/routes/admin/index.js";
import { NOW, testEnv, testKeyring, modelRecord, TEST_MODEL } from "./harness.js";

export { NOW, TEST_MODEL, modelRecord };

/** The operator every test authenticates as. */
export const ADMIN_PASSWORD = "correct-horse-battery-staple";

export type AdminFixtures = {
  users: User[];
  sessions: SessionRecord[];
  apiKeys: ApiKey[];
  orders: Order[];
  packages: PackageRecord[];
  stock: Map<string, PackageStock>;
  models: ModelRecord[];
  accounts: ProviderAccount[];
  flags: Map<string, unknown>;
  audit: AuditEvent[];
  ledger: QuotaLedgerEntry[];
};

/** Everything a test inspects after a request. */
export type AdminRecorded = {
  /** Every audit row written, in order. The §16 invariant-7 assertion. */
  audit: {
    action: string;
    actorId: string | null;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
  }[];
  /**
   * One entry per `sealCredential` call, holding DESCRIPTORS ONLY.
   *
   * Deliberately not the credential: the suite asserts that a sealed credential never
   * reaches a response, an audit row, or a log, and a harness that stashed the plaintext
   * would be the counterexample.
   */
  sealed: {
    region: string;
    persona: string;
    authMethod: string;
    hasRefreshToken: boolean;
    hasAccessToken: boolean;
  }[];
  adjustments: { apiKeyId: string; weightedTokensDelta: number; remainingAfter: number }[];
  passwordResets: string[];
  revokedSessionsFor: string[];
  validated: string[];
  touchedSessions: string[];
  /** Set when `transact` rolled back, so a test can assert nothing persisted. */
  rollbacks: number;
};

export function adminUser(overrides: Partial<User> = {}): User {
  return {
    id: ulid(),
    username: "operator",
    passwordHash: "replaced-by-harness",
    role: "admin",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as User;
}

export function customerUser(overrides: Partial<User> = {}): User {
  return adminUser({ username: "customer", role: "customer", ...overrides });
}

function toPublic(user: User): PublicUser {
  const { passwordHash: _omitted, ...rest } = user;
  return rest as PublicUser;
}

export function adminApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: ulid(),
    userId: ulid(),
    label: "primary",
    prefix: "bsk_test",
    lookupDigest: "digest",
    encryptedKey: "envelope",
    encryptionKeyVersion: 1,
    status: "active",
    quotaLimit: 1_000_000,
    quotaRemaining: 500_000,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  } as ApiKey;
}

export function adminPackage(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "pkg-starter",
    name: "Starter",
    weightedTokenQuota: 1_000_000,
    priceIdr: 50_000,
    durationSeconds: 2_592_000,
    maxKeyQuota: 5_000_000,
    allowedModels: [TEST_MODEL],
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PackageRecord;
}

export function packageStock(overrides: Partial<PackageStock> = {}): PackageStock {
  return {
    packageId: "pkg-starter",
    available: 10,
    reserved: 2,
    version: 3,
    updatedAt: NOW,
    ...overrides,
  } as PackageStock;
}

export function adminOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ulid(),
    userId: ulid(),
    type: "new_key",
    status: "paid",
    packageId: "pkg-starter",
    packageSnapshot: {
      packageId: "pkg-starter",
      weightedTokenQuota: 1_000_000,
      priceIdr: 50_000,
      maxKeyQuota: 5_000_000,
      durationSeconds: 2_592_000,
    },
    amountIdr: 50_000,
    provider: "pakasir",
    providerTransactionId: "trx-1",
    targetApiKeyId: null,
    stockReservationExpiresAt: null,
    paidAt: NOW,
    activatedAt: null,
    reviewReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Order;
}

export function providerAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: ulid(),
    providerType: "kiro",
    label: "pool-1",
    status: "active",
    region: "us-east-1",
    persona: "cli",
    encryptedCredentials: "envelope",
    encryptionKeyVersion: 1,
    credentialVersion: 0,
    profileArn: null,
    cooldownUntil: null,
    lastValidatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ProviderAccount;
}

export type AdminHarnessOptions = {
  env?: Partial<Env>;
  clock?: Clock;
  fixtures?: Partial<AdminFixtures>;
  /** Forces `transact` to reject after the callback runs, exercising rollback. */
  failTransaction?: boolean;
  /** Makes `validateAccount` reject, as a provider refusing the credential would. */
  failValidation?: boolean;
  /** Makes `checkDatabase` reject, for the degraded health report. */
  failDatabase?: boolean;
  /**
   * Overrides the traffic window aggregate.
   *
   * The default is a busy window (120 requests, 3 errors). An IDLE one is a distinct case
   * worth setting deliberately: `errorCount / requestCount` is 0/0 there, and the client's
   * schema rejects NaN, so an unguarded division takes the whole dashboard down rather
   * than showing zero.
   */
  traffic?: Partial<AdminTrafficWindow>;
  /**
   * Makes `rotateCredentials` report a lost compare-and-swap.
   *
   * A switch rather than a fixture value because the CAS cannot be lost from the outside:
   * the route reads `credentialVersion` and passes that same value as `expectedVersion`
   * within one transaction, so any starting version matches itself. Losing the CAS requires
   * another writer to commit in between, which is precisely what this simulates.
   */
  conflictOnRotate?: boolean;
};

export type AdminHarness = {
  deps: AdminDeps;
  fixtures: AdminFixtures;
  recorded: AdminRecorded;
  keyring: SecretKeyring;
  logger: Logger;
  /** The operator row, with a REAL Argon2 hash of `ADMIN_PASSWORD`. */
  operator: User;
  /** A valid session cookie header for `operator`. */
  cookie: string;
  /** A cookie header for an arbitrary user, for the non-admin rejection test. */
  cookieFor: (user: User) => string;
};

/**
 * Builds a complete `AdminDeps` from fakes, plus a real operator session.
 *
 * `hashPassword` is real Argon2 (~50ms once per harness) rather than a stub: the
 * login route's whole security property is that it verifies through `attemptLogin`,
 * and a fake hash would let a broken verify pass the suite.
 */
export async function adminHarness(options: AdminHarnessOptions = {}): Promise<AdminHarness> {
  const clock = options.clock ?? fixedClock(NOW);
  const env = testEnv(options.env);
  const keyring = testKeyring();
  const logger = createLogger({ service: "test", level: "fatal" });

  const operator = adminUser({ passwordHash: await hashPassword(ADMIN_PASSWORD) });

  const fixtures: AdminFixtures = {
    users: [operator],
    sessions: [],
    apiKeys: [],
    orders: [],
    packages: [adminPackage()],
    stock: new Map([["pkg-starter", packageStock()]]),
    models: [modelRecord()],
    accounts: [providerAccount()],
    flags: new Map<string, unknown>(),
    audit: [],
    ledger: [],
    ...options.fixtures,
  };

  /**
   * The operator is always present, whatever `options.fixtures.users` said.
   *
   * The spread above replaces the array wholesale, so a test supplying its own users would
   * drop the operator and every request would 401 — an authentication failure dressed up as
   * whatever the test was actually about. Re-inserting is strictly friendlier than making
   * each caller remember, and it cannot mask a real failure: the non-admin rejection tests
   * assert on a CUSTOMER's cookie, which this does not touch.
   */
  if (!fixtures.users.some((user) => user.id === operator.id)) {
    fixtures.users = [operator, ...fixtures.users];
  }

  const recorded: AdminRecorded = {
    audit: [],
    sealed: [],
    adjustments: [],
    passwordResets: [],
    revokedSessionsFor: [],
    validated: [],
    touchedSessions: [],
    rollbacks: 0,
  };

  /** Mints a session row for `user` and returns the cookie header for it. */
  const cookieFor = (user: User): string => {
    const token = `token-${user.id}`;
    fixtures.sessions.push({
      id: `session-${user.id}`,
      userId: user.id,
      tokenHash: sessionDigest(token, keyring),
      expiresAt: new Date(clock.now().getTime() + 3_600_000),
      revokedAt: null,
      createdAt: clock.now(),
      lastUsedAt: clock.now(),
    });
    return `bosanda_admin_session_dev=${token}`;
  };

  /** `normalizePagination`'s defaults, so a fake page matches a real one. */
  const page = (paging: {
    limit?: number;
    offset?: number;
  }): { limit: number; offset: number } => ({
    limit: paging.limit ?? 50,
    offset: paging.offset ?? 0,
  });

  const findUser = (id: string): User | undefined => fixtures.users.find((u) => u.id === id);

  /** Shared by `apiKeyQuery.list` and `.count` so the page and the total agree. */
  const matchKeys = (filter: { prefix?: string; lookupDigest?: string }): ApiKey[] =>
    fixtures.apiKeys.filter((key) => {
      if (
        filter.prefix !== undefined &&
        !key.prefix.toLowerCase().startsWith(filter.prefix.toLowerCase())
      ) {
        return false;
      }
      if (filter.lookupDigest !== undefined && key.lookupDigest !== filter.lookupDigest) {
        return false;
      }
      return true;
    });

  /**
   * The transaction object. One instance shared by every `transact` call: the fakes
   * hold no per-transaction state, and a test that needs rollback semantics uses
   * `failTransaction`, which discards the audit rows written inside the callback.
   */
  const tx: AdminTx = {
    /**
     * Stands in for the frozen `executeActivation`, reproducing the properties the route
     * depends on and nothing more.
     *
     * The load-bearing one is the idempotency barrier: `markActivated` is guarded on
     * `status='paid' AND activated_at IS NULL`, so a second activation matches no row and
     * comes back `order_not_activatable`. That check is FIRST here for the same reason it is
     * first there — it is the whole barrier, and a fake that granted quota before consulting
     * it would let the route's double-activation test pass against a broken implementation.
     */
    activate: async (input) => {
      const order = fixtures.orders.find((candidate) => candidate.id === input.grant.orderId);
      if (order === undefined) {
        return { ok: false, reason: "order_not_activatable", detail: "order missing" };
      }
      if (order.status !== "paid" || order.activatedAt !== null) {
        return {
          ok: false,
          reason: "order_not_activatable",
          detail: `order ${order.id} is ${order.status}`,
        };
      }

      // Stock is a CAS on the version read in the same transaction; a mismatch is a
      // conflict rather than an overwrite.
      let committed: PackageStock | undefined;
      if (input.stock !== undefined) {
        const current = fixtures.stock.get(input.stock.packageId);
        if (current === undefined || current.version !== input.stock.expectedVersion) {
          return { ok: false, reason: "stock_conflict", detail: "stock version moved" };
        }
        committed = {
          ...current,
          available: Math.max(0, current.available - input.stock.units),
          reserved: Math.max(0, current.reserved - input.stock.units),
          version: current.version + 1,
          updatedAt: input.at,
        } as PackageStock;
        fixtures.stock.set(input.stock.packageId, committed);
      }

      // The two grant shapes name the amount differently: `quota` for a new key,
      // `purchased` for a top-up.
      const granted = input.grant.kind === "new_key" ? input.grant.quota : input.grant.purchased;

      let key: ApiKey;
      if (input.keyMaterial === undefined) {
        // Top-up: the existing key must be present and topupable.
        const targetKeyId = input.grant.kind === "top_up" ? input.grant.apiKeyId : null;
        const existing = fixtures.apiKeys.find((candidate) => candidate.id === targetKeyId);
        if (existing === undefined) {
          return { ok: false, reason: "key_not_topupable", detail: "target key missing" };
        }
        key = {
          ...existing,
          quotaLimit: existing.quotaLimit + granted,
          quotaRemaining: existing.quotaRemaining + granted,
        } as ApiKey;
        fixtures.apiKeys = fixtures.apiKeys.map((candidate) =>
          candidate.id === key.id ? key : candidate,
        );
      } else {
        key = adminApiKey({
          id: input.keyMaterial.id,
          userId: input.grant.userId,
          label: input.keyMaterial.label,
          prefix: input.keyMaterial.prefix,
          lookupDigest: input.keyMaterial.lookupDigest,
          encryptedKey: input.keyMaterial.encryptedKey,
          encryptionKeyVersion: input.keyMaterial.encryptionKeyVersion,
          quotaLimit: granted,
          quotaRemaining: granted,
          createdAt: input.at,
        });
        fixtures.apiKeys = [...fixtures.apiKeys, key];
      }

      const ledgerEntry = {
        id: input.ledgerEntryId,
        apiKeyId: key.id,
        orderId: order.id,
        kind: input.grant.kind === "new_key" ? "grant" : "top_up",
        weightedTokensDelta: granted,
        balanceAfter: key.quotaRemaining,
        estimated: false,
        meterVersion: input.meterVersion,
        requestId: null,
        createdAt: input.at,
      } as QuotaLedgerEntry;
      fixtures.ledger = [...fixtures.ledger, ledgerEntry];

      const activated = { ...order, status: "activated", activatedAt: input.at } as Order;
      fixtures.orders = fixtures.orders.map((candidate) =>
        candidate.id === order.id ? activated : candidate,
      );

      // `executeActivation` writes its OWN audit row with actorType `system`. Reproduced so
      // a test can tell the system row apart from the admin row the route adds.
      recorded.audit.push({
        action:
          input.grant.kind === "new_key" ? "order.activated_new_key" : "order.activated_top_up",
        actorId: null,
        targetType: "order",
        targetId: order.id,
        metadata: { orderId: order.id, apiKeyId: key.id },
      });

      return {
        ok: true,
        order: activated,
        apiKey: key,
        ledgerEntry,
        ...(committed === undefined ? {} : { stock: { ok: true, stock: committed } }),
      } as ActivationOutcome;
    },

    audit: {
      append: async (input) => {
        recorded.audit.push({
          action: input.action,
          actorId: input.actorId,
          targetType: input.targetType,
          targetId: input.targetId,
          metadata: input.metadata,
        });
        const event = {
          id: input.id,
          actorType: input.actorType,
          actorId: input.actorId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          metadata: input.metadata,
          createdAt: input.createdAt,
        } as AuditEvent;
        fixtures.audit.push(event);
        return event;
      },
    },

    users: {
      findById: async (id) => findUser(id) ?? null,
      setPasswordHash: async (id, passwordHash, at) => {
        const user = findUser(id);
        if (user === undefined) return null;
        // The hash, never the plaintext. Recorded as the user id only so a test can
        // assert the reset happened without the harness itself holding a secret.
        recorded.passwordResets.push(id);
        const updated = { ...user, passwordHash, updatedAt: at };
        fixtures.users = fixtures.users.map((u) => (u.id === id ? updated : u));
        return updated;
      },
      setStatus: async (id, status, at) => {
        const user = findUser(id);
        if (user === undefined) return null;
        const updated = { ...user, status, updatedAt: at } as User;
        fixtures.users = fixtures.users.map((u) => (u.id === id ? updated : u));
        return updated;
      },
    },

    sessions: {
      insert: async (input) => {
        fixtures.sessions.push({
          id: input.id,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          revokedAt: null,
          createdAt: input.createdAt,
          lastUsedAt: input.lastUsedAt,
        });
        return { ...input, revokedAt: null } as never;
      },
      revokeAllForUser: async (userId, at) => {
        recorded.revokedSessionsFor.push(userId);
        const revoked: string[] = [];
        fixtures.sessions = fixtures.sessions.map((session) => {
          if (session.userId !== userId || session.revokedAt !== null) return session;
          revoked.push(session.id);
          return { ...session, revokedAt: at };
        });
        return revoked;
      },
    },

    apiKeys: {
      findById: async (id) => fixtures.apiKeys.find((key) => key.id === id) ?? null,
      revoke: async (id, at) => {
        const key = fixtures.apiKeys.find((candidate) => candidate.id === id);
        // Guarded on `status='active'` in SQL: a second revoke returns null, which is
        // what makes the route idempotent instead of double-auditing.
        if (key === undefined || key.status !== "active") return null;
        const updated = { ...key, status: "revoked", revokedAt: at } as ApiKey;
        fixtures.apiKeys = fixtures.apiKeys.map((c) => (c.id === id ? updated : c));
        return updated;
      },
    },

    quota: {
      lockKeyForUpdate: async (apiKeyId) => {
        const key = fixtures.apiKeys.find((candidate) => candidate.id === apiKeyId);
        if (key === undefined) return null;
        return {
          keyId: key.id,
          status: key.status,
          remaining: key.quotaRemaining,
          quotaLimit: key.quotaLimit,
          expiresAt: key.expiresAt,
        };
      },
      recordAdjustment: async (input) => {
        recorded.adjustments.push({
          apiKeyId: input.apiKeyId,
          weightedTokensDelta: input.weightedTokensDelta,
          remainingAfter: input.remainingAfter,
        });
        const entry: QuotaLedgerEntry = {
          id: input.id,
          apiKeyId: input.apiKeyId,
          orderId: input.orderId,
          requestId: null,
          kind: "adjustment",
          rawInputTokens: 0,
          rawOutputTokens: 0,
          // Null for non-usage kinds, per the ledger's own rule.
          multiplier: null,
          multiplierNumeric: null,
          weightedTokensDelta: input.weightedTokensDelta,
          // The PERSISTED balance, clamped at 0 by CHECK. The unclamped figure stays in
          // `weightedTokensDelta`, which is what makes an over-refund recoverable.
          balanceAfter: Math.max(0, input.remainingAfter),
          estimated: false,
          meterVersion: input.meterVersion,
          createdAt: input.createdAt,
        };
        fixtures.ledger.push(entry);
        const key = fixtures.apiKeys.find((candidate) => candidate.id === input.apiKeyId);
        if (key !== undefined) {
          fixtures.apiKeys = fixtures.apiKeys.map((candidate) =>
            candidate.id === input.apiKeyId
              ? ({ ...candidate, quotaRemaining: Math.max(0, input.remainingAfter) } as ApiKey)
              : candidate,
          );
        }
        return entry;
      },
    },

    orders: {
      findById: async (id) => fixtures.orders.find((order) => order.id === id) ?? null,
      lockById: async (id) => fixtures.orders.find((order) => order.id === id) ?? null,
      markReviewRequired: async (id, reason, at) => {
        if (reason.trim().length === 0) {
          throw new BosandaError("internal_error", {
            internalDetail: "markReviewRequired needs a reason",
          });
        }
        const order = fixtures.orders.find((candidate) => candidate.id === id);
        if (order === undefined) return null;
        const updated = { ...order, status: "review_required", updatedAt: at } as Order;
        fixtures.orders = fixtures.orders.map((c) => (c.id === id ? updated : c));
        return updated;
      },
      markCancelled: async (id, at) => {
        const order = fixtures.orders.find((candidate) => candidate.id === id);
        if (order === undefined || order.status === "cancelled") return null;
        const updated = { ...order, status: "cancelled", updatedAt: at } as Order;
        fixtures.orders = fixtures.orders.map((c) => (c.id === id ? updated : c));
        return updated;
      },
    },

    packages: {
      findById: async (id) => fixtures.packages.find((pkg) => pkg.id === id) ?? null,
      upsert: async (input) => {
        const { at, ...fields } = input;
        const updated = { ...adminPackage(), ...fields, updatedAt: at } as PackageRecord;
        fixtures.packages = fixtures.packages.map((pkg) => (pkg.id === input.id ? updated : pkg));
        return updated;
      },
      setActive: async (id, active, at) => {
        const pkg = fixtures.packages.find((candidate) => candidate.id === id);
        if (pkg === undefined) return null;
        const updated = { ...pkg, active, updatedAt: at } as PackageRecord;
        fixtures.packages = fixtures.packages.map((c) => (c.id === id ? updated : c));
        return updated;
      },
      readStock: async (packageId) => fixtures.stock.get(packageId) ?? null,
      lockStock: async (packageId) => fixtures.stock.get(packageId) ?? null,
      setStock: async (packageId, available, at) => {
        const current = fixtures.stock.get(packageId);
        const next = {
          packageId,
          available,
          // Deliberately NOT reset, matching the repository: outstanding reservations
          // survive an operator restock.
          reserved: current?.reserved ?? 0,
          version: (current?.version ?? 0) + 1,
          updatedAt: at,
        } as PackageStock;
        fixtures.stock.set(packageId, next);
        return next;
      },
    },

    models: {
      findByPublicId: async (publicId) =>
        fixtures.models.find((model) => model.publicId === publicId) ?? null,
      setMultiplier: async (publicId, multiplier, multiplierVersion, at) => {
        const model = fixtures.models.find((candidate) => candidate.publicId === publicId);
        if (model === undefined) return null;
        const value = typeof multiplier === "number" ? String(multiplier) : multiplier;
        const updated = {
          ...model,
          multiplier: value,
          multiplierNumeric: Number(value),
          multiplierVersion,
          updatedAt: at,
        } as ModelRecord;
        fixtures.models = fixtures.models.map((c) => (c.publicId === publicId ? updated : c));
        return updated;
      },
      setPublished: async (publicId, published, at) => {
        const model = fixtures.models.find((candidate) => candidate.publicId === publicId);
        if (model === undefined) return null;
        // Publishing is guarded on compatibility in SQL; an ineligible model returns
        // null so the route surfaces a conflict rather than silently not publishing.
        if (
          published &&
          model.compatibilityStatus !== "passing" &&
          model.compatibilityStatus !== "degraded"
        ) {
          return null;
        }
        const updated = { ...model, published, updatedAt: at } as ModelRecord;
        fixtures.models = fixtures.models.map((c) => (c.publicId === publicId ? updated : c));
        return updated;
      },
    },

    providerAccounts: {
      findById: async (id) => fixtures.accounts.find((account) => account.id === id) ?? null,
      insert: async (input) => {
        const account = { ...providerAccount(), ...input, credentialVersion: 0 } as ProviderAccount;
        fixtures.accounts.push(account);
        return account;
      },
      // Returns a boolean, per `AdminProviderAccountWrite`: the route only needs to know
      // whether a row matched, and re-reading the account is a separate concern.
      update: async (input) => {
        const account = fixtures.accounts.find((candidate) => candidate.id === input.accountId);
        if (account === undefined) return false;
        const updated = {
          ...account,
          label: input.label,
          region: input.region,
          persona: input.persona,
          updatedAt: input.at,
        } as ProviderAccount;
        fixtures.accounts = fixtures.accounts.map((c) => (c.id === input.accountId ? updated : c));
        return true;
      },
      rotateCredentials: async (input) => {
        const account = fixtures.accounts.find((candidate) => candidate.id === input.accountId);
        if (account === undefined) return { ok: false, reason: "missing" } as never;
        // Stands in for another writer having committed between this route's read of
        // `credentialVersion` and its write.
        if (options.conflictOnRotate === true) {
          return { ok: false, reason: "version_conflict", account } as never;
        }
        // Optimistic concurrency: a stale version is a returned outcome, not a throw.
        if (account.credentialVersion !== input.expectedVersion) {
          return { ok: false, reason: "version_conflict", account } as never;
        }
        const updated = {
          ...account,
          encryptedCredentials: input.encryptedCredentials,
          encryptionKeyVersion: input.encryptionKeyVersion,
          credentialVersion: account.credentialVersion + 1,
          updatedAt: input.at,
        } as ProviderAccount;
        fixtures.accounts = fixtures.accounts.map((c) => (c.id === input.accountId ? updated : c));
        return { ok: true, account: updated } as never;
      },
      setStatus: async (accountId, status, at) => {
        const account = fixtures.accounts.find((candidate) => candidate.id === accountId);
        if (account === undefined) return null;
        const updated = {
          ...account,
          status,
          cooldownUntil: status === "active" ? null : account.cooldownUntil,
          updatedAt: at,
        } as ProviderAccount;
        fixtures.accounts = fixtures.accounts.map((c) => (c.id === accountId ? updated : c));
        return updated;
      },
      markValidated: async (accountId, at) => {
        const account = fixtures.accounts.find((candidate) => candidate.id === accountId);
        if (account === undefined) return;
        const updated = { ...account, lastValidatedAt: at } as ProviderAccount;
        fixtures.accounts = fixtures.accounts.map((c) => (c.id === accountId ? updated : c));
      },
    },

    flags: {
      findByKey: async (key) =>
        fixtures.flags.has(key)
          ? ({ key, value: fixtures.flags.get(key), updatedBy: null, updatedAt: NOW } as never)
          : null,
      upsert: async (key, value, updatedBy, at) => {
        fixtures.flags.set(key, value);
        return { key, value, updatedBy, updatedAt: at } as never;
      },
    },
  };

  const deps: AdminDeps = {
    env,
    clock,
    logger,
    keyring,

    killSwitches: async () => ({
      adapterEnabled: true,
      toolUseEnabled: true,
      disabledRegions: new Set<string>(),
      disabledModels: new Set<string>(),
      disabledAccounts: new Set<string>(),
    }),

    sessions: {
      // By keyed digest, so the test exercises the real `sessionDigest`.
      findWithUser: async (tokenHash) => {
        const session = fixtures.sessions.find((candidate) => candidate.tokenHash === tokenHash);
        if (session === undefined) return null;
        const user = findUser(session.userId);
        if (user === undefined) return null;
        return { session, user: toPublic(user) } as never;
      },
      touchLastUsed: async (id, at) => {
        recorded.touchedSessions.push(id);
        fixtures.sessions = fixtures.sessions.map((session) =>
          session.id === id ? { ...session, lastUsedAt: at } : session,
        );
        return null as never;
      },
      revokeByTokenHash: async (tokenHash, at) => {
        const session = fixtures.sessions.find((candidate) => candidate.tokenHash === tokenHash);
        if (session === undefined || session.revokedAt !== null) return null;
        const updated = { ...session, revokedAt: at };
        fixtures.sessions = fixtures.sessions.map((c) => (c.id === session.id ? updated : c));
        return updated as never;
      },
      insert: tx.sessions.insert,
    },

    users: {
      findByUsername: async (username) =>
        fixtures.users.find((user) => user.username === username) ?? null,
      findById: async (id) => findUser(id) ?? null,
      findPublicById: async (id) => {
        const user = findUser(id);
        return user === undefined ? null : toPublic(user);
      },
      list: async (filter = {}, paging = {}) => {
        const search = filter.search?.toLowerCase();
        const { limit, offset } = page(paging);
        return fixtures.users
          .filter((user) => search === undefined || user.username.toLowerCase().includes(search))
          .slice(offset, offset + limit)
          .map(toPublic);
      },
      count: async (filter = {}) => {
        const search = filter.search?.toLowerCase();
        return fixtures.users.filter(
          (user) => search === undefined || user.username.toLowerCase().includes(search),
        ).length;
      },
    },

    apiKeys: {
      findById: async (id) => fixtures.apiKeys.find((key) => key.id === id) ?? null,
      listForUser: async (userId) => fixtures.apiKeys.filter((key) => key.userId === userId),
    },

    quota: {
      ledgerForKey: async (apiKeyId) =>
        fixtures.ledger.filter((entry) => entry.apiKeyId === apiKeyId),
      trueBalance: async (apiKeyId) =>
        fixtures.ledger
          .filter((entry) => entry.apiKeyId === apiKeyId)
          .reduce((sum, entry) => sum + entry.weightedTokensDelta, 0),
    },

    orders: {
      list: async (filter = {}, paging = {}) => {
        const statuses = filter.status;
        const { limit, offset } = page(paging);
        const matched = fixtures.orders.filter(
          (order) => statuses === undefined || statuses.includes(order.status),
        );
        return {
          orders: matched.slice(offset, offset + limit),
          filter: filter as never,
        };
      },
      count: async (filter = {}) => {
        const statuses = filter.status;
        return fixtures.orders.filter(
          (order) => statuses === undefined || statuses.includes(order.status),
        ).length;
      },
      findById: async (id) => fixtures.orders.find((order) => order.id === id) ?? null,
    },

    packages: {
      listAll: async () => fixtures.packages,
      findById: async (id) => fixtures.packages.find((pkg) => pkg.id === id) ?? null,
      readStock: async (packageId) => fixtures.stock.get(packageId) ?? null,
    },

    models: {
      listAll: async () => fixtures.models,
      findByPublicId: async (publicId) =>
        fixtures.models.find((model) => model.publicId === publicId) ?? null,
    },

    providerAccounts: {
      listByType: async () => fixtures.accounts,
      findById: async (id) => fixtures.accounts.find((account) => account.id === id) ?? null,
      errorCountsSince: async () => [],
      recentHealthEvents: async () => [],
    },

    flags: {
      readAll: async () =>
        [...fixtures.flags.entries()].map(([key, value]) => ({
          key,
          value,
          updatedBy: operator.id,
          updatedAt: NOW,
        })) as never,
    },

    usage: {
      totalsByProviderAccount: async () => [],
    },

    audit: {
      list: async (filter = {}, paging = {}) => {
        const { limit, offset } = page(paging);
        return {
          events: fixtures.audit.slice(offset, offset + limit),
          filter: filter as never,
        };
      },
      count: async () => fixtures.audit.length,
    },

    /** The five ports the frozen repositories cannot serve. */
    apiKeyQuery: {
      list: async (filter, paging) => {
        const matched = matchKeys(filter);
        return matched.slice(paging.offset, paging.offset + paging.limit).map((key) => ({
          id: key.id,
          userId: key.userId,
          username: findUser(key.userId)?.username ?? "unknown",
          label: key.label,
          prefix: key.prefix,
          status: key.status,
          quotaLimit: key.quotaLimit,
          quotaRemaining: key.quotaRemaining,
          expiresAt: key.expiresAt,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
        }));
      },
      count: async (filter) => matchKeys(filter).length,
    },

    userQuery: {
      aggregatesFor: async (userIds) =>
        userIds.map((userId) => {
          const keys = fixtures.apiKeys.filter((key) => key.userId === userId);
          return {
            userId,
            activeKeyCount: keys.filter((key) => key.status === "active").length,
            totalWeightedRemaining: keys.reduce((sum, key) => sum + key.quotaRemaining, 0),
            lastLoginAt:
              fixtures.sessions
                .filter((session) => session.userId === userId)
                .map((session) => session.createdAt)
                .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
          };
        }),
    },

    orderQuery: {
      paymentEventsFor: async () => [],
      searchIds: async (term, limit) => {
        const user = fixtures.users.find((candidate) => candidate.username === term);
        return fixtures.orders
          .filter(
            (order) =>
              order.id === term ||
              order.providerTransactionId === term ||
              (user !== undefined && order.userId === user.id),
          )
          .slice(0, limit)
          .map((order) => order.id);
      },
      labelsFor: async (orderIds) =>
        orderIds.map((orderId) => {
          const order = fixtures.orders.find((candidate) => candidate.id === orderId);
          return {
            orderId,
            username:
              order === undefined ? "unknown" : (findUser(order.userId)?.username ?? "unknown"),
            packageName: fixtures.packages.find((pkg) => pkg.id === order?.packageId)?.name ?? null,
          };
        }),
    },

    traffic: {
      window: async () => ({
        requestCount: 120,
        errorCount: 3,
        weightedTokens: 45_000,
        latencyMs: { p50: 90, p95: 400, p99: 900 },
        ...(options.traffic ?? {}),
      }),
      series: async () => [{ at: NOW, requests: 120, errors: 3, weightedTokens: 45_000 }],
      revenueIdr: async () => 150_000,
      weightedByAccount: async () =>
        fixtures.accounts.map((account) => ({ accountId: account.id, weightedTokens: 1_000 })),
    },

    reconciliation: {
      snapshot: async () => ({
        lastRunAt: NOW,
        lagSeconds: 12,
        pendingOrders: 1,
        reviewRequiredOrders: 0,
      }),
    },

    liveAccounts: () =>
      fixtures.accounts.map((account) => ({
        accountId: account.id,
        activeRequests: 0,
        errorScore: 0,
      })),

    activeStreams: () => 2,

    checkDatabase: async () => {
      if (options.failDatabase === true) {
        throw new BosandaError("internal_error", { internalDetail: "database unreachable" });
      }
    },

    validateAccount: async (accountId) => {
      recorded.validated.push(accountId);
      if (options.failValidation === true) {
        throw new BosandaError("upstream_incompatible", {
          internalDetail: "provider refused the credential",
        });
      }
    },

    transact: async (fn) => {
      /**
       * A forced rollback must discard the EFFECT as well as the audit row.
       *
       * Rewinding only `recorded.audit` would let a route that mutated a row outside its
       * transaction still look correct here, which is the opposite of what the §16
       * invariant-7 test is for. Snapshotting the fixtures and restoring them is the
       * honest fake: the collections are reassigned rather than mutated in place by the
       * repository fakes, so a shallow copy is a sufficient restore point. `stock` is a
       * Map, which IS mutated in place, so it is copied entry-wise.
       */
      const before = {
        audit: recorded.audit.length,
        users: fixtures.users,
        sessions: fixtures.sessions,
        apiKeys: fixtures.apiKeys,
        orders: fixtures.orders,
        packages: fixtures.packages,
        stock: new Map(fixtures.stock),
        models: fixtures.models,
        accounts: fixtures.accounts,
        flags: new Map(fixtures.flags),
        auditRows: fixtures.audit,
        ledger: fixtures.ledger,
      };

      const result = await fn(tx);

      if (options.failTransaction === true) {
        recorded.audit.length = before.audit;
        fixtures.users = before.users;
        fixtures.sessions = before.sessions;
        fixtures.apiKeys = before.apiKeys;
        fixtures.orders = before.orders;
        fixtures.packages = before.packages;
        fixtures.stock = before.stock;
        fixtures.models = before.models;
        fixtures.accounts = before.accounts;
        fixtures.flags = before.flags;
        fixtures.audit = before.auditRows;
        fixtures.ledger = before.ledger;
        recorded.rollbacks += 1;
        throw new BosandaError("internal_error", { internalDetail: "forced rollback" });
      }
      return result;
    },

    /**
     * Records that sealing happened WITHOUT keeping the secret.
     *
     * Only non-secret descriptors are retained: a test asserts that a credential was sealed
     * and that no response, audit row, or log line contains it — so the harness itself must
     * not become the place a token sits in memory. `refreshToken`/`accessToken` are noted as
     * booleans only.
     */
    sealCredential: (credentials) => {
      recorded.sealed.push({
        region: credentials.region,
        persona: credentials.persona,
        authMethod: credentials.authMethod,
        hasRefreshToken: credentials.refreshToken !== null,
        hasAccessToken: credentials.accessToken !== null,
      });
      return {
        envelope: `sealed:${recorded.sealed.length}`,
        keyVersion: 1,
        profileArn: credentials.profileArn,
      };
    },
  };

  return {
    deps,
    fixtures,
    recorded,
    keyring,
    logger,
    operator,
    cookie: cookieFor(operator),
    cookieFor,
  };
}
