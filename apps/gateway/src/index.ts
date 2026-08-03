/**
 * The gateway's public surface.
 *
 * `main.ts` is deliberately NOT re-exported: importing this barrel must never start a
 * server, and `main.ts` calls `main()` at module scope. What is exported is what a test
 * or a future admin process composes with — `buildApp` plus the primitives beneath it.
 */

export {
  authenticate,
  authenticationError,
  extractKey,
  type AuthenticateDeps,
  type AuthFailureReason,
  type AuthResult,
  type HeaderBag,
} from "./auth.js";

export { KeyLimiter, type LimiterOptions, type Slot } from "./limits.js";

export { buildApp, type AppOptions } from "./app.js";

export {
  createCustomerDependencies,
  type CreateCustomerDependenciesOptions,
  type CustomerDeps,
  type CustomerTx,
  type CustomerUsageBucket,
  type CustomerUsageQuery,
} from "./customer-dependencies.js";

export {
  CUSTOMER_SESSION_COOKIE,
  registerCustomerSessionRoutes,
  requireCustomer,
  type CustomerActor,
} from "./routes/customer-session.js";

export { registerCustomerRoutes } from "./routes/customer.js";

export {
  admit,
  loadPool,
  resolveRequestModel,
  runStream,
  settleOutcome,
  touchKey,
  type AdmissionInput,
  type Admitted,
  type ResolvedModel,
  type RunStreamInput,
  type SettleOutcomeInput,
  type StreamOutcome,
} from "./pipeline.js";

export { settleRequest, type SettleRequestInput, type TurnStatus } from "./settlement.js";

export {
  createTokenRefresher,
  createUpstreamTransport,
  parseRefreshResponse,
  postgresCredentialStore,
  type CredentialStoreOptions,
  type TokenRefresherOptions,
} from "./credentials.js";

export { requestAbortSignal, type RequestAbort } from "./routes/abort.js";

export {
  createReadinessState,
  registerHealthRoutes,
  type HealthBody,
  type ReadinessState,
} from "./routes/health.js";

export {
  OpenAIStreamWriter,
  SSE_HEADERS,
  sseHead,
  type OpenAIStreamWriterOptions,
  type StreamSink,
} from "./streaming/openai.js";

export { AnthropicStreamWriter, type AnthropicStreamWriterOptions } from "./streaming/anthropic.js";

export {
  REQUEST_ID_HEADER,
  registerObservability,
  resolveRequestId,
  statusLabel,
  surfaceLabel,
} from "./plugins/observability.js";

export { registerSecurity } from "./plugins/security.js";
export { registerDatabase } from "./plugins/database.js";

export {
  createAdminDependencies,
  type CreateAdminDependenciesOptions,
} from "./admin-dependencies.js";

export {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE_DEV,
  registerAdminRoutes,
  type AdminDeps,
} from "./routes/admin/index.js";
