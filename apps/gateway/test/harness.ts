/**
 * The gateway test harness.
 *
 * `IMPLEMENTATION-STATUS.md` requires `pnpm test` to run on a machine with no
 * PostgreSQL and no network. That is not a convenience: a suite that needs a database
 * gets skipped on the machine where it matters, and a suite that reaches the network
 * fails for reasons unrelated to the code. So every port in `GatewayDeps` is
 * satisfiable by an object literal here, and the narrow `Pick<...>` types in
 * `dependencies.ts` are what make that possible.
 *
 * ── WHAT THE FAKES DO AND DO NOT SIMULATE ─────────────────────────────────
 * The fake repositories store rows in a Map and enforce the ONE constraint the
 * gateway's correctness depends on: the settlement idempotency keys. They do not
 * simulate SQL semantics, row locks, or the real unique indexes — that is what the
 * PostgreSQL integration suite (still outstanding) is for, and pretending otherwise
 * here would produce a suite that passes while the real constraints are wrong.
 *
 * The fake adapter is a scripted `AsyncIterable<CanonicalEvent>`, so a test can say
 * "emit two text deltas then throw" and assert what reached the socket. That is the
 * only way to test the zero-byte retry rule and the error-placement boundary, both of
 * which are defined entirely by WHEN a failure happens relative to the first byte.
 */

import { createRegistry, createLogger, type Logger, type Registry } from "@bosanda/observability";
import { fixedClock, ulid, type Clock } from "@bosanda/shared";
import { generateApiKey, lookupDigest } from "@bosanda/api-keys";
import type { Env, SecretKeyring } from "@bosanda/config";
import type { CanonicalEvent, CanonicalRequest } from "@bosanda/protocol";
import { BosandaError } from "@bosanda/protocol";
import {
  CircuitBreakerRegistry,
  CooldownRegistry,
  HealthTracker,
  Scheduler,
  createAdapterRegistry,
  type AccountHealth,
  type KillSwitches,
  type ProviderAdapter,
  type ProviderModel,
} from "@bosanda/provider-core";
import type {
  ApiKey,
  AuthenticatedApiKey,
  ModelRecord,
  PersistedAccountHealth,
} from "@bosanda/database";
import { KeyLimiter } from "../src/limits.js";
import type { GatewayDeps, SettlementTx } from "../src/dependencies.js";

/** A deterministic instant, so every id, expiry, and duration in a test is stable. */
export const NOW = new Date("2026-07-31T12:00:00.000Z");

/**
 * A 32-byte key for every purpose.
 *
 * The same bytes for all four purposes is fine in a test and would be a serious
 * defect in production: §12 separates the lookup HMAC from the envelope key so that
 * compromising the searchable index does not yield the ability to decrypt. Tests only
 * need the keyring to be self-consistent.
 */
export function testKeyring(): SecretKeyring {
  const key = Buffer.alloc(32, 7);
  return {
    currentVersion: 1,
    keyFor: () => key,
    keyForVersion: () => key,
  };
}

/** Only the env fields the gateway reads. Cast once, here, rather than at each use. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    KEY_MAX_ACTIVE_REQUESTS: 5,
    KEY_MAX_REQUESTS_PER_MINUTE: 100,
    PROVIDER_COOLDOWN_MS: 30_000,
    PROVIDER_COOLDOWN_MAX_MS: 900_000,
    UPSTREAM_IDLE_TIMEOUT_MS: 120_000,
    UPSTREAM_HARD_TIMEOUT_MS: 600_000,
    KIRO_DIRECT_ENABLED: true,
    KIRO_TOOL_USE_ENABLED: true,
    KIRO_DISABLED_REGIONS: [],
    KIRO_DISABLED_MODELS: [],
    ...overrides,
  } as Env;
}

export const TEST_MODEL = "bosanda-sonnet";

export function modelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    publicId: TEST_MODEL,
    providerType: "kiro",
    upstreamId: "upstream-model-id",
    label: "Bosanda Sonnet",
    contextWindow: 200_000,
    multiplier: "1.0000",
    multiplierNumeric: 1,
    multiplierVersion: "1",
    supportsTools: true,
    supportsReasoning: false,
    regions: ["us-east-1"],
    published: true,
    compatibilityStatus: "passing",
    updatedAt: NOW,
    ...overrides,
  };
}

export type TestKey = { plaintext: string; authenticated: AuthenticatedApiKey };

/**
 * Mints a real key through `generateApiKey` and a real `lookupDigest`.
 *
 * Deliberately not a hand-written fake string: `looksLikeApiKey` runs before the
 * digest in the auth path, so a fabricated key would be rejected on shape and the
 * test would prove nothing about the lookup.
 */
export function testKey(
  keyring: SecretKeyring,
  overrides: Partial<ApiKey> = {},
  authOverrides: Partial<Omit<AuthenticatedApiKey, "key">> = {},
): TestKey {
  const generated = generateApiKey();
  const key: ApiKey = {
    id: ulid(),
    userId: ulid(),
    label: "test",
    prefix: generated.prefix,
    lookupDigest: lookupDigest(generated.plaintext, keyring),
    encryptedKey: "envelope-not-used-in-these-tests",
    encryptionKeyVersion: 1,
    status: "active",
    quotaLimit: 1_000_000,
    quotaRemaining: 1_000_000,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
  return {
    plaintext: generated.plaintext,
    authenticated: {
      key,
      userStatus: authOverrides.userStatus ?? "active",
      userRole: authOverrides.userRole ?? "customer",
    },
  };
}

export function accountHealthRow(
  overrides: Partial<PersistedAccountHealth> = {},
): PersistedAccountHealth {
  return {
    accountId: ulid(),
    status: "active",
    cooldownUntil: null,
    lastValidatedAt: NOW,
    errorScore: 0,
    activeRequests: 0,
    region: "us-east-1",
    persona: "cli",
    ...overrides,
  };
}

/** A scripted step: an event to emit, or an error to throw at that point. */
export type ScriptStep = { emit: CanonicalEvent } | { throw: unknown };

export function textStream(text: string, usage = true): ScriptStep[] {
  const steps: ScriptStep[] = [
    { emit: { type: "message_start", id: "msg_test", model: TEST_MODEL } },
    { emit: { type: "text_delta", text } },
  ];
  if (usage) {
    steps.push({
      emit: { type: "usage", inputTokens: 10, outputTokens: 5, estimated: false },
    });
  }
  // `end_turn` is the canonical token; the surfaces map it ("stop" for OpenAI,
  // "end_turn" for Anthropic). Emitting a surface token here would leave
  // `finish_reason` undefined and `JSON.stringify` would drop the field entirely.
  steps.push({ emit: { type: "finish", reason: "end_turn" } });
  return steps;
}

export type FakeAdapterOptions = {
  /** One script per attempt. The last is reused if attempts exceed the list. */
  scripts: ScriptStep[][];
  models?: ProviderModel[];
  adapterVersion?: string;
};

export type FakeAdapter = ProviderAdapter & {
  /** Account ids in the order they were tried — the failover assertion. */
  readonly attempts: readonly string[];
};

export function fakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const attempts: string[] = [];
  let index = 0;

  return {
    providerType: "kiro",
    adapterVersion: options.adapterVersion ?? "test-1",
    attempts,
    validateAccount: async (accountId: string): Promise<AccountHealth> => ({
      accountId,
      status: "active",
      cooldownUntil: null,
      lastValidatedAt: NOW,
      errorScore: 0,
      activeRequests: 0,
      region: "us-east-1",
      persona: "cli",
    }),
    listModels: async () => options.models ?? [],
    stream: (_request: CanonicalRequest, accountId: string): AsyncIterable<CanonicalEvent> => {
      attempts.push(accountId);
      const script = options.scripts[Math.min(index, options.scripts.length - 1)] ?? [];
      index += 1;

      return {
        async *[Symbol.asyncIterator]() {
          for (const step of script) {
            if ("throw" in step) throw step.throw;
            yield step.emit;
          }
        },
      };
    },
  };
}

/** Everything a test wants to inspect after a request. */
export type Recorded = {
  debits: { requestId: string; weightedTokens: number; remainingAfter: number }[];
  usage: { requestId: string; status: string; surface: string }[];
  touched: string[];
};

export type HarnessOptions = {
  env?: Partial<Env>;
  models?: ModelRecord[];
  accounts?: PersistedAccountHealth[];
  keys?: TestKey[];
  scripts?: ScriptStep[][];
  adapter?: ProviderAdapter;
  killSwitches?: Partial<KillSwitches>;
  clock?: Clock;
  /** Forces `transact` to reject, exercising the never-throws contract. */
  failSettlement?: boolean;
};

export type Harness = {
  deps: GatewayDeps;
  recorded: Recorded;
  keyring: SecretKeyring;
  adapter: ProviderAdapter;
  metrics: Registry;
  logger: Logger;
};

/**
 * Builds a complete `GatewayDeps` from fakes.
 *
 * The two idempotency keys ARE enforced: `quota_ledger (api_key_id, request_id)` and
 * `usage_events.request_id`. Everything else about the fakes is a Map. A settlement
 * test that double-settles must observe the same duplicate behaviour it would get
 * from PostgreSQL, because that behaviour is what stops a customer being billed twice
 * for one retry.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? fixedClock(NOW);
  const env = testEnv(options.env);
  const keyring = testKeyring();
  const metrics = createRegistry();
  const logger = createLogger({ service: "gateway-test", level: "silent" });

  const recorded: Recorded = { debits: [], usage: [], touched: [] };
  const models = options.models ?? [modelRecord()];
  const accounts = options.accounts ?? [accountHealthRow()];
  const keys = options.keys ?? [];

  const cooldowns = new CooldownRegistry({
    clock,
    baseMs: env.PROVIDER_COOLDOWN_MS,
    maxMs: env.PROVIDER_COOLDOWN_MAX_MS,
  });
  const breakers = new CircuitBreakerRegistry({ clock });
  const scheduler = new Scheduler({ clock, cooldowns, breakers });
  const health = new HealthTracker({ clock, registry: metrics, cooldowns, breakers, scheduler });

  const adapter =
    options.adapter ?? fakeAdapter({ scripts: options.scripts ?? [textStream("hello")] });

  // The real unique constraints, as sets.
  const ledgerKeys = new Set<string>();
  const usageKeys = new Set<string>();

  const tx: SettlementTx = {
    quota: {
      recordDebit: async (input) => {
        const composite = `${input.apiKeyId}:${input.requestId}`;
        const entry = {
          id: input.id,
          apiKeyId: input.apiKeyId,
          requestId: input.requestId,
          weightedTokens: input.weightedTokens,
          remainingAfter: input.remainingAfter,
        };
        if (ledgerKeys.has(composite)) {
          // Matches `ON CONFLICT ... DO NOTHING`: the ORIGINAL row wins and the
          // balance is untouched.
          return { status: "duplicate", entry } as never;
        }
        ledgerKeys.add(composite);
        recorded.debits.push({
          requestId: input.requestId,
          weightedTokens: input.weightedTokens,
          remainingAfter: input.remainingAfter,
        });
        return { status: "recorded", entry, clamped: false } as never;
      },
    },
    usage: {
      insert: async (input) => {
        if (usageKeys.has(input.requestId)) {
          return { status: "duplicate", row: input } as never;
        }
        usageKeys.add(input.requestId);
        recorded.usage.push({
          requestId: input.requestId,
          status: input.status,
          surface: input.surface,
        });
        return { status: "inserted", row: input } as never;
      },
    },
  };

  const deps: GatewayDeps = {
    env,
    clock,
    logger,
    metrics,
    keyring,

    limiter: new KeyLimiter({
      clock,
      maxActive: env.KEY_MAX_ACTIVE_REQUESTS,
      maxPerMinute: env.KEY_MAX_REQUESTS_PER_MINUTE,
    }),
    cooldowns,
    breakers,
    scheduler,
    health,
    adapters: createAdapterRegistry([adapter]),

    apiKeys: {
      findByLookupDigest: async (digest: string) =>
        keys.find((candidate) => candidate.authenticated.key.lookupDigest === digest)
          ?.authenticated ?? null,
      touchLastUsed: async (keyId: string) => {
        recorded.touched.push(keyId);
      },
    },
    models: {
      listPublished: async () => models.filter((model) => model.published),
      findByPublicId: async (publicId: string) =>
        models.find((model) => model.publicId === publicId) ?? null,
    },
    providerAccounts: {
      listEligibleHealth: async () => accounts,
    },

    transact: async (fn) => {
      if (options.failSettlement === true) {
        throw new BosandaError("internal_error", { internalDetail: "forced settlement failure" });
      }
      return fn(tx);
    },

    killSwitches: async () => ({
      adapterEnabled: true,
      toolUseEnabled: true,
      disabledRegions: new Set<string>(),
      disabledModels: new Set<string>(),
      disabledAccounts: new Set<string>(),
      ...options.killSwitches,
    }),

    checkDatabase: async () => {},
    close: async () => {},
  };

  return { deps, recorded, keyring, adapter, metrics, logger };
}
