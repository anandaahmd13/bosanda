export {
  createClient,
  createClientFromEnv,
  checkConnection,
  closeClient,
  type CreateClientOptions,
  type Sql,
} from "./client.js";

export {
  checksumOf,
  migrate,
  planMigrations,
  type AppliedMigration,
  type MigrateResult,
  type Migration,
  type MigrationPlan,
  type MigrationStore,
} from "./migrations.js";

export { loadMigrations, migrationsDirectory } from "./migration-files.js";

export { migrationStore } from "./migration-store.js";

// ───────────────────────────── repositories ─────────────────────────────
//
// Every repository is a factory taking an `Executor` — the shared surface of the
// pool (`Sql`) and a transaction (`Tx`) — so the same code composes into a single
// transaction when several tables must move together (§16 invariant 5):
//
//   const key = await apiKeysRepository(sql).findByLookupDigest(digest);
//
//   await withTransaction(sql, async (tx) => {
//     await ordersRepository(tx).markPaid(orderId, at);
//     await quotaRepository(tx).recordGrant({ ... });
//   });
//
// Row mapping is explicit, one mapper per table, in `repositories/rows.ts`. Pure
// decision logic (the balance clamp, CAS classification, idempotency verdicts,
// filter normalization) lives in `repositories/decisions.ts` and is unit-tested
// without a database.

export {
  atomically,
  firstRow,
  isTransaction,
  jsonParam,
  requireRow,
  withTransaction,
  type Executor,
  type Tx,
} from "./repositories/executor.js";

export {
  MAX_SAFE_DB_INTEGER,
  bigintToNumber,
  freeUnits,
  nullableBigint,
  nullableDate,
  numericToNumber,
  toApiKey,
  toAccountStatus,
  toAuditEvent,
  toAuthenticatedApiKey,
  toDate,
  toFeatureFlag,
  toJsonObject,
  toKeyQuotaState,
  toModelRecord,
  toMultiplierRecord,
  toOrder,
  toOrderSnapshot,
  toPackageRecord,
  toPackageSnapshot,
  toPackageStock,
  toPaymentEvent,
  toProviderAccount,
  toProviderHealthEvent,
  toProviderModel,
  toPublicUser,
  toQuotaLedgerEntry,
  toSession,
  toStringArray,
  toUsageEvent,
  toUser,
  fromAccountStatus,
  type ActorType,
  type ApiKey,
  type ApiKeyRow,
  type ApiKeyRowWithUser,
  type ApiKeyStatus,
  type AuditEvent,
  type AuditEventRow,
  type AuthenticatedApiKey,
  type CompatibilityStatus,
  type FeatureFlag,
  type FeatureFlagRow,
  type LedgerKind,
  type ModelRecord,
  type ModelRow,
  type Order,
  type OrderRow,
  type OrderStatus,
  type OrderType,
  type PackageRecord,
  type PackageRow,
  type PackageStock,
  type PackageStockRow,
  type PaymentEvent,
  type PaymentEventRow,
  type PaymentEventStatus,
  type ProviderAccount,
  type ProviderAccountCredentials,
  type ProviderAccountRow,
  type ProviderAccountStatus,
  type ProviderHealthEvent,
  type ProviderHealthEventRow,
  type PublicUser,
  type QuotaLedgerEntry,
  type QuotaLedgerRow,
  type SchedulerAccountStatus,
  type Session,
  type SessionRow,
  type StoredPackageSnapshot,
  type UsageEvent,
  type UsageEventRow,
  type UsageStatus,
  type UsageSurface,
  type User,
  type UserRole,
  type UserRow,
  type UserStatus,
} from "./repositories/rows.js";

export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  auditFilterPredicates,
  canCommit,
  canRelease,
  canReserve,
  clampBalance,
  clampedOverage,
  classifyRotateFailure,
  classifyStockFailure,
  debitIsIdempotent,
  decideDebitOutcome,
  decideInsertOutcome,
  decideKeyAuth,
  normalizeAuditFilter,
  normalizeOrderFilter,
  normalizePagination,
  orderFilterPredicates,
  wasClamped,
  type AuditFilter,
  type DebitOutcome,
  type InsertOutcome,
  type KeyAuthVerdict,
  type NormalizedAuditFilter,
  type NormalizedOrderFilter,
  type OrderFilter,
  type Pagination,
  type RotateOutcome,
  type StockCasOutcome,
} from "./repositories/decisions.js";

export {
  apiKeysRepository,
  type ApiKeysRepository,
  type InsertApiKeyInput,
} from "./repositories/api-keys.js";

export {
  quotaRepository,
  type QuotaRepository,
  type RecordAdjustmentInput,
  type RecordDebitInput,
  type RecordExpiryInput,
  type RecordGrantInput,
} from "./repositories/quota.js";

export {
  usageRepository,
  type InsertUsageEventInput,
  type UsageByDay,
  type UsageByModel,
  type UsageRepository,
  type UsageTotals,
} from "./repositories/usage.js";

export {
  ORDER_STATUS_VALUES,
  ordersRepository,
  type CreateOrderInput,
  type InsertPaymentEventInput,
  type OrdersRepository,
} from "./repositories/orders.js";

export {
  packagesRepository,
  type PackagesRepository,
  type UpsertPackageInput,
} from "./repositories/packages.js";

export {
  providerAccountsRepository,
  toPersistedHealth,
  type InsertHealthEventInput,
  type InsertProviderAccountInput,
  type PersistedAccountHealth,
  type ProviderAccountsRepository,
  type RotateCredentialsInput,
} from "./repositories/provider-accounts.js";

export {
  modelsRepository,
  type ModelsRepository,
  type UpsertModelInput,
} from "./repositories/models.js";

export {
  usersRepository,
  type AdminUserSummary,
  type BootstrapAdminInput,
  type InsertUserInput,
  type UsersRepository,
} from "./repositories/users.js";

export {
  sessionsRepository,
  type InsertSessionInput,
  type SessionWithUser,
  type SessionsRepository,
} from "./repositories/sessions.js";

export {
  assertMetadataIsSafe,
  auditRepository,
  type AppendAuditInput,
  type AuditRepository,
} from "./repositories/audit.js";

export {
  FLAG_ADAPTER_ENABLED,
  FLAG_DISABLED_MODELS,
  FLAG_DISABLED_REGIONS,
  FLAG_TOOL_USE_ENABLED,
  flagsRepository,
  killSwitchesFrom,
  readBoolean,
  readStringSet,
  type FlagsRepository,
  type KillSwitchConfig,
  type ResolvedKillSwitches,
} from "./repositories/flags.js";

export {
  executeActivation,
  type ActivationFailureReason,
  type ActivationGrantInput,
  type ActivationOutcome,
  type ExecuteActivationInput,
  type NewKeyGrantInput,
  type NewKeyMaterial,
  type StockCommit,
  type TopUpGrantInput,
} from "./repositories/activation.js";
