import { createLogger, type Logger } from "@bosanda/observability";
import { fixedClock, ulid, type Clock } from "@bosanda/shared";
import { startSession, hashPassword, type SessionRecord } from "@bosanda/auth";
import type { Env, SecretKeyring } from "@bosanda/config";
import type {
  ApiKey,
  AuditEvent,
  Order,
  PackageRecord,
  PackageStock,
  PublicUser,
  User,
} from "@bosanda/database";
import type { CustomerDeps, CustomerTx } from "../src/customer-dependencies.js";
import { NOW, testEnv, testKeyring } from "./harness.js";

export type CustomerFixtures = {
  users: User[];
  sessions: SessionRecord[];
  keys: ApiKey[];
  packages: PackageRecord[];
  stock: Map<string, PackageStock>;
  orders: Order[];
  audits: AuditEvent[];
};

export const CUSTOMER_PASSWORD = "correct-horse-battery-staple";

export function customerUser(overrides: Partial<User> = {}): User {
  return {
    id: ulid(),
    username: "customer",
    passwordHash: "harness",
    role: "customer",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function customerPackage(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "pkg-starter",
    name: "Starter",
    weightedTokenQuota: 1_000_000,
    priceIdr: 50_000,
    durationSeconds: 86_400,
    maxKeyQuota: 5_000_000,
    allowedModels: [],
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function customerStock(overrides: Partial<PackageStock> = {}): PackageStock {
  return {
    packageId: "pkg-starter",
    available: 10,
    reserved: 0,
    version: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

export function customerKey(userId: string, overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: ulid(),
    userId,
    label: null,
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
  };
}

export function customerOrder(userId: string, overrides: Partial<Order> = {}): Order {
  return {
    id: ulid(),
    userId,
    packageId: "pkg-starter",
    packageSnapshot: {
      packageId: "pkg-starter",
      weightedTokenQuota: 1_000_000,
      priceIdr: 50_000,
      maxKeyQuota: 5_000_000,
      durationSeconds: 86_400,
    },
    type: "new_key",
    targetApiKeyId: null,
    amountIdr: 50_000,
    status: "pending_payment",
    stockReservationExpiresAt: new Date(NOW.getTime() + 1_800_000),
    provider: "pakasir",
    providerTransactionId: null,
    paidAt: null,
    activatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function publicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...result } = user;
  return result;
}

export type CustomerHarness = {
  deps: CustomerDeps;
  fixtures: CustomerFixtures;
  keyring: SecretKeyring;
  user: User;
  cookie: string;
  logger: Logger;
};

export async function customerHarness(
  options: { env?: Partial<Env>; fixtures?: Partial<CustomerFixtures>; clock?: Clock } = {},
): Promise<CustomerHarness> {
  const clock = options.clock ?? fixedClock(NOW);
  const env = {
    ...testEnv(options.env),
    PAKASIR_BASE_URL: "https://pakasir.test",
    PAKASIR_PROJECT: "bosanda-test",
    PUBLIC_WEB_URL: "https://web.test",
  } as Env;
  const keyring = testKeyring();
  const user = customerUser({ passwordHash: await hashPassword(CUSTOMER_PASSWORD) });
  const fixtures: CustomerFixtures = {
    users: [user],
    sessions: [],
    keys: [],
    packages: [customerPackage()],
    stock: new Map([["pkg-starter", customerStock()]]),
    orders: [],
    audits: [],
    ...options.fixtures,
  };
  if (!fixtures.users.some((item) => item.id === user.id)) fixtures.users.unshift(user);

  const sessions = {
    findWithUser: async (digest: string) => {
      const session = fixtures.sessions.find((item) => item.tokenHash === digest);
      if (session === undefined) return null;
      const owner = fixtures.users.find((item) => item.id === session.userId);
      return owner === undefined ? null : { session, user: publicUser(owner) };
    },
    touchLastUsed: async (id: string) => {
      const session = fixtures.sessions.find((item) => item.id === id);
      if (session !== undefined) session.lastUsedAt = clock.now();
      return session ?? null;
    },
    revokeByTokenHash: async (digest: string, at: Date) => {
      const session = fixtures.sessions.find((item) => item.tokenHash === digest);
      if (session !== undefined) session.revokedAt = at;
      return session ?? null;
    },
  };
  const findUser = (id: string) => fixtures.users.find((item) => item.id === id) ?? null;
  const findKey = (id: string) => fixtures.keys.find((item) => item.id === id) ?? null;
  const findOrder = (id: string) => fixtures.orders.find((item) => item.id === id) ?? null;
  const audits = {
    append: async (input: any) => {
      fixtures.audits.push(input);
    },
  };
  const tx: CustomerTx = {
    audit: audits,
    sessions: {
      insert: async (input: any) => {
        const row = { ...input, revokedAt: null };
        fixtures.sessions.push(row);
        return row;
      },
      revokeByTokenHash: sessions.revokeByTokenHash,
    },
    users: {
      insert: async (input: any) => {
        const row = {
          id: input.id,
          username: input.username,
          passwordHash: input.passwordHash,
          role: input.role,
          status: input.status,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        };
        fixtures.users.push(row);
        return row;
      },
      findByUsername: async (username: string) =>
        fixtures.users.find((item) => item.username.toLowerCase() === username.toLowerCase()) ??
        null,
    },
    apiKeys: {
      findById: async (id: string) => findKey(id),
      revoke: async (id: string, at: Date) => {
        const key = findKey(id);
        if (key === null || key.status !== "active") return null;
        key.status = "revoked";
        key.revokedAt = at;
        return key;
      },
    },
    orders: {
      create: async (input: any) => {
        const row = { ...input, updatedAt: input.createdAt };
        fixtures.orders.push(row);
        return row;
      },
      lockById: async (id: string) => findOrder(id),
      findById: async (id: string) => findOrder(id),
      markCancelled: async (id: string, at: Date) => {
        const order = findOrder(id);
        if (order === null || (order.status !== "draft" && order.status !== "pending_payment"))
          return null;
        order.status = "cancelled";
        order.updatedAt = at;
        return order;
      },
      attachProviderTransaction: async (
        id: string,
        _provider: string,
        providerTransactionId: string,
        at: Date,
      ) => {
        const order = findOrder(id);
        if (order === null) return null;
        order.providerTransactionId = providerTransactionId;
        order.updatedAt = at;
        return order;
      },
    },
    packages: {
      findById: async (id: string) => fixtures.packages.find((item) => item.id === id) ?? null,
      readStock: async (id: string) => fixtures.stock.get(id) ?? null,
      lockStock: async (id: string) => fixtures.stock.get(id) ?? null,
      reserveStock: async (id: string, units: number, version: number) => {
        const stock = fixtures.stock.get(id);
        if (
          stock === undefined ||
          stock.version !== version ||
          stock.available - stock.reserved < units
        )
          return { ok: false, reason: "insufficient" as const };
        stock.reserved += units;
        stock.version += 1;
        return {
          ok: true,
          version: stock.version,
          available: stock.available,
          reserved: stock.reserved,
        };
      },
      releaseStock: async (id: string, units: number, version: number) => {
        const stock = fixtures.stock.get(id);
        if (stock === undefined || stock.version !== version || stock.reserved < units)
          return { ok: false, reason: "insufficient" as const };
        stock.reserved -= units;
        stock.version += 1;
        return {
          ok: true,
          version: stock.version,
          available: stock.available,
          reserved: stock.reserved,
        };
      },
    },
  };

  const deps: CustomerDeps = {
    env,
    clock,
    logger: createLogger({ service: "customer-test", level: "fatal" }),
    keyring,
    decoyHash: await hashPassword("decoy-password-that-is-never-correct"),
    killSwitches: async () => ({
      adapterEnabled: true,
      toolUseEnabled: true,
      disabledRegions: new Set(),
      disabledModels: new Set(),
      disabledAccounts: new Set(),
    }),
    sessions,
    users: {
      findByUsername: async (username: string) =>
        fixtures.users.find((item) => item.username.toLowerCase() === username.toLowerCase()) ??
        null,
      findPublicById: async (id: string) => {
        const found = findUser(id);
        return found === null ? null : publicUser(found);
      },
    },
    apiKeys: {
      findById: async (id: string) => findKey(id),
      listForUser: async (id: string) => fixtures.keys.filter((item) => item.userId === id),
      listActiveForUser: async (id: string, now: Date) =>
        fixtures.keys.filter(
          (item) => item.userId === id && item.status === "active" && item.expiresAt > now,
        ),
    },
    quota: { trueBalance: async (id: string) => findKey(id)?.quotaRemaining ?? 0 },
    orders: {
      findById: async (id: string) => findOrder(id),
      listForUser: async (id: string) => fixtures.orders.filter((item) => item.userId === id),
    },
    packages: {
      listActiveWithStock: async () =>
        fixtures.packages
          .filter((item) => item.active)
          .map((item) => ({ package: item, stock: fixtures.stock.get(item.id) ?? null })),
      findById: async (id: string) => fixtures.packages.find((item) => item.id === id) ?? null,
      readStock: async (id: string) => fixtures.stock.get(id) ?? null,
    },
    models: { listPublished: async () => [] },
    flags: { readAll: async () => [] },
    usage: {
      totalsForUser: async () => ({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        weightedTokens: 0,
        estimatedRequests: 0,
      }),
    },
    usageQuery: { seriesForUser: async () => [] },
    orderQuery: { activatedKeyIds: async () => new Map<string, string>() },
    transact: async (fn) => fn(tx),
    checkout: async (order) => ({
      paymentUrl: `https://pakasir.test/pay/${order.id}`,
      providerTransactionId: null,
    }),
  };
  const started = startSession(user.id, keyring, clock);
  fixtures.sessions.push({
    id: ulid(),
    ...started.record,
    lastUsedAt: started.record.lastUsedAt ?? started.record.createdAt,
  });
  return {
    deps,
    fixtures,
    keyring,
    user,
    cookie: `bosanda_session=${started.token.plaintext}`,
    logger: deps.logger,
  };
}
