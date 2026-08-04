/**
 * The gateway's dependency graph (PLAN.md §4 "composition", §7 boot order).
 *
 * WHY A PLAIN OBJECT OF PORTS AND NOT A DI CONTAINER. Every collaborator the
 * routes need is listed here as the NARROWEST type that satisfies the route —
 * `Pick<ApiKeysRepository, "findByLookupDigest">` rather than the whole
 * repository. Two things fall out of that. First, an HTTP test can supply an
 * object literal instead of PostgreSQL, so `pnpm test` stays runnable on a
 * machine with no database (which is the standing constraint in
 * IMPLEMENTATION-STATUS.md). Second, the `Pick` list IS the audit trail: if a
 * route ever needs a new database method the diff shows it here, next to the
 * comment saying why.
 *
 * THE BOOT ORDER IS FORCED, not stylistic. `Scheduler` needs the cooldown and
 * breaker registries; `HealthTracker` needs all three plus the metrics registry;
 * `CredentialManager` needs a store bound to the pool; the adapter needs the
 * credential manager; the `AdapterRegistry` needs the adapter. Constructing them
 * out of order is a type error rather than a runtime surprise, which is the point
 * of taking them as constructor arguments instead of reading module state.
 *
 * WHAT IS DELIBERATELY ABSENT. No secret, token, or credential is stored on this
 * object. `keyring` holds key MATERIAL by necessity (§12 needs it to compute the
 * lookup digest) and must never be logged or serialized; everything else here is
 * a function or a repository handle.
 */

import { keyringFromEnv, type Env, type SecretKeyring } from "@bosanda/config";
import {
  apiKeysRepository,
  checkConnection,
  closeClient,
  createClientFromEnv,
  flagsRepository,
  killSwitchesFrom,
  modelsRepository,
  providerAccountsRepository,
  quotaRepository,
  usageRepository,
  withTransaction,
  type ApiKeysRepository,
  type ModelsRepository,
  type PersistedAccountHealth,
  type ProviderAccountsRepository,
  type QuotaRepository,
  type Sql,
  type UsageRepository,
} from "@bosanda/database";
import { createRegistry, createLogger, type Logger, type Registry } from "@bosanda/observability";
import {
  AdapterRegistry,
  CircuitBreakerRegistry,
  CooldownRegistry,
  HealthTracker,
  Scheduler,
  createAdapterRegistry,
  killSwitchesFromEnv,
  type KillSwitches,
  type Persona,
  type ProviderType,
  type SchedulableAccount,
} from "@bosanda/provider-core";
import { CredentialManager, KiroDirectAdapter } from "@bosanda/provider-kiro";
import { CodexAdapter, createCodexRuntimeClient } from "@bosanda/provider-codex";
import { systemClock, type Clock } from "@bosanda/shared";
import { KeyLimiter } from "./limits.js";
import {
  postgresCredentialStore,
  createTokenRefresher,
  createUpstreamTransport,
} from "./credentials.js";

/**
 * The provider type this MVP serves. §22 lists exactly one provider for v1;
 * naming it once here keeps the pool query and the adapter lookup from drifting.
 */
export const PROVIDER_TYPE = "kiro" as const;
export const CODEX_PROVIDER_TYPE = "openai_codex" as const;
export type GatewayProviderType = ProviderType;

/**
 * Repository surfaces, narrowed to what the HTTP layer actually calls.
 *
 * `touchLastUsed` is included even though no route calls it yet on the
 * management side: the gateway is where a key is genuinely "used", so this is the
 * call site that makes `api_keys.last_used_at` mean something.
 */
export type GatewayRepositories = {
  apiKeys: Pick<ApiKeysRepository, "findByLookupDigest" | "touchLastUsed">;
  models: Pick<ModelsRepository, "listPublished" | "findByPublicId">;
  providerAccounts: Pick<
    ProviderAccountsRepository,
    "listEligibleHealth" | "listDisabledIds" | "findById"
  >;
};

export function narrowProviderType(providerType: string): ProviderType {
  if (providerType === PROVIDER_TYPE || providerType === CODEX_PROVIDER_TYPE) return providerType;
  throw new Error(`unsupported provider type: ${providerType}`);
}

/**
 * The two repositories settlement writes, bound to one transaction.
 *
 * §16 invariant 4 requires the ledger debit and the usage row to commit together,
 * so they are handed out as a pair by `transact` rather than being reachable
 * independently on `GatewayDeps` — a route cannot write half of a settlement
 * because there is no way to get one without the other.
 */
export type SettlementTx = {
  quota: Pick<QuotaRepository, "recordDebit">;
  usage: Pick<UsageRepository, "insert">;
};

export type GatewayDeps = GatewayRepositories & {
  env: Env;
  clock: Clock;
  logger: Logger;
  metrics: Registry;
  keyring: SecretKeyring;

  /** Per-key concurrency + RPM (§7). */
  limiter: KeyLimiter;

  cooldowns: CooldownRegistry;
  breakers: CircuitBreakerRegistry;
  scheduler: Scheduler;
  health: HealthTracker;
  adapters: AdapterRegistry;

  /**
   * Read per request, never cached: an operator flipping a flag must take effect
   * without a deploy (§3). Returning the whole struct rather than a boolean keeps
   * the precedence logic in `evaluateKillSwitches` where it is tested.
   */
  killSwitches: (provider?: ProviderType) => Promise<KillSwitches>;

  /**
   * Runs `fn` inside one database transaction (§16 invariant 4).
   *
   * Exposed as a function rather than as a raw `Sql` handle so tests can supply an
   * in-memory pair without a pool, and so no route can start an ad-hoc transaction
   * over arbitrary tables.
   */
  transact: <T>(fn: (tx: SettlementTx) => Promise<T>) => Promise<T>;

  /** Liveness probe for `/health`. Resolves when the database is reachable. */
  checkDatabase: () => Promise<void>;

  /** Released on drain. Idempotent. */
  close: () => Promise<void>;
};

/**
 * Converts a persisted pool row into what the scheduler classifies.
 *
 * `supportedModels` is computed from the published catalogue rather than stored
 * per account: every Kiro account can serve every Kiro model it is not
 * explicitly disabled for, and duplicating that into a join table would be a
 * second source of truth to keep in sync. When per-account model restrictions
 * become real, this is the one function that changes.
 */
export function toSchedulable(
  row: PersistedAccountHealth,
  supportedModels: ReadonlySet<string>,
): SchedulableAccount {
  return {
    accountId: row.accountId,
    health: {
      accountId: row.accountId,
      status: row.status,
      cooldownUntil: row.cooldownUntil,
      lastValidatedAt: row.lastValidatedAt,
      errorScore: row.errorScore,
      activeRequests: row.activeRequests,
      region: row.region,
      persona: narrowPersona(row.persona),
    },
    supportedModels,
  };
}

/**
 * A stored persona string that is neither `cli` nor `ide` is a data defect, but
 * failing the whole request over it would take the pool down for a cosmetic
 * field. `cli` is the §6 default and the safe assumption.
 */
function narrowPersona(persona: string): Persona {
  return persona === "ide" ? "ide" : "cli";
}

export type CreateDependenciesOptions = {
  env: Env;
  /** Injected in tests; production uses the system clock. */
  clock?: Clock;
  logger?: Logger;
  metrics?: Registry;
  /** Supplied by tests that want to skip the real pool. */
  sql?: Sql;
};

/**
 * Wires the production graph.
 *
 * NOTE ON `killSwitches`. Environment gives the baseline and the `feature_flags`
 * table can only ever narrow it: `killSwitchesFrom` unions the disabled sets and
 * ANDs the booleans, so a flag row cannot re-enable something the environment
 * turned off. That direction is deliberate — `KIRO_DIRECT_ENABLED=false` must not
 * be overridable by a database write.
 */
export function createDependencies(options: CreateDependenciesOptions): GatewayDeps {
  const { env } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger({ service: "gateway", level: env.LOG_LEVEL });
  const metrics = options.metrics ?? createRegistry();
  const keyring = keyringFromEnv(env);
  const sql = options.sql ?? createClientFromEnv(env);

  const cooldowns = new CooldownRegistry({
    clock,
    baseMs: env.PROVIDER_COOLDOWN_MS,
    maxMs: env.PROVIDER_COOLDOWN_MAX_MS,
  });
  const breakers = new CircuitBreakerRegistry({ clock });
  const scheduler = new Scheduler({
    clock,
    cooldowns,
    breakers,
    disabledRegions: new Set(env.KIRO_DISABLED_REGIONS),
  });
  const health = new HealthTracker({ clock, registry: metrics, cooldowns, breakers, scheduler });

  const credentials = new CredentialManager({
    store: postgresCredentialStore({ sql, keyring, clock, logger }),
    refresher: createTokenRefresher(),
    clock,
    onRefresh: (event) => {
      metrics.increment("bosanda_token_refresh_total", { outcome: event.outcome });
      logger.info(
        { providerAccountId: event.accountId, outcome: event.outcome },
        "provider token refresh",
      );
    },
  });

  const adapter = new KiroDirectAdapter({
    credentials,
    transport: createUpstreamTransport(),
    // Read per call so a flag flip takes effect on the next request (§3).
    isEnabled: () => env.KIRO_DIRECT_ENABLED,
    isToolUseEnabled: () => env.KIRO_TOOL_USE_ENABLED,
    clock,
    idleTimeoutMs: env.UPSTREAM_IDLE_TIMEOUT_MS,
    onTelemetry: (telemetry) => {
      for (const [name, count] of Object.entries(telemetry.unknownEvents)) {
        metrics.increment("bosanda_adapter_compat_errors_total", { kind: "unknown_event" }, count);
        logger.warn(
          { providerAccountId: telemetry.accountId, event: name, count },
          "unknown upstream event",
        );
      }
      if (!telemetry.usageReported) {
        metrics.increment("bosanda_usage_estimated_total", { reason: "no_metrics_event" });
      }
    },
  });

  // Codex speaks App Server over the dedicated runtime socket. Registration is
  // unconditional so admin validate/login can resolve the adapter type; the
  // adapter itself still rejects until runtime+commercial gates are both true,
  // and models stay unpublished until the compatibility gate is signed off.
  const codexRuntime = createCodexRuntimeClient({
    socketPath: env.OPENAI_CODEX_SOCKET,
    enabled: () => env.OPENAI_CODEX_RUNTIME_ENABLED,
  });
  const codexAdapter = new CodexAdapter({
    runtime: codexRuntime,
    enabled: () => env.OPENAI_CODEX_RUNTIME_ENABLED,
    commercialEnabled: () => env.OPENAI_CODEX_COMMERCIAL_ENABLED,
    toolUseEnabled: () => env.OPENAI_CODEX_TOOL_USE_ENABLED,
  });
  const adapters: AdapterRegistry = createAdapterRegistry([adapter, codexAdapter]);

  return {
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
    adapters,

    apiKeys: apiKeysRepository(sql),
    models: modelsRepository(sql),
    providerAccounts: providerAccountsRepository(sql),

    transact: (fn) =>
      withTransaction(sql, (tx) => fn({ quota: quotaRepository(tx), usage: usageRepository(tx) })),

    killSwitches: async (provider = PROVIDER_TYPE) => {
      const flags = await flagsRepository(sql).readAll();
      const selectedProvider = provider;
      const disabledAccounts =
        await providerAccountsRepository(sql).listDisabledIds(selectedProvider);
      const baseline = killSwitchesFromEnv(env, disabledAccounts, selectedProvider);
      return killSwitchesFrom(
        {
          adapterEnabled: baseline.adapterEnabled,
          toolUseEnabled: baseline.toolUseEnabled,
          disabledRegions: baseline.disabledRegions,
          disabledModels: baseline.disabledModels,
        },
        flags,
        disabledAccounts,
        selectedProvider === CODEX_PROVIDER_TYPE ? "openai_codex" : "kiro",
      );
    },

    checkDatabase: () => checkConnection(sql),
    close: () => closeClient(sql),
  };
}
