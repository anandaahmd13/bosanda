/**
 * @bosanda/provider-kiro barrel — the Kiro Direct HTTP adapter (PLAN.md §2
 * ADR-1, §6).
 *
 * NOTE FOR CALLERS: the compatibility gate in §3 (M0) has NOT been executed.
 * `KIRO_DIRECT_ENABLED` defaults to false and the adapter raises
 * `adapter_disabled` until an operator turns it on with verified credentials.
 * `ADAPTER_VERSION` and `FIXTURE_VERSION` both carry a `-draft` suffix to record
 * that the upstream protocol shapes here are unverified.
 */

export {
  KiroDirectAdapter,
  ADAPTER_VERSION,
  upstreamUrl,
  upstreamHeaders,
  type KiroAdapterOptions,
  type UpstreamTransport,
  type UpstreamRequest,
  type UpstreamResponse,
} from "./adapter.js";

export {
  EventStreamDecoder,
  EventStreamError,
  decodeEventStream,
  crc32,
  headerString,
  payloadJson,
  HEADER_TYPE,
  MAX_FRAME_BYTES,
  MAX_BUFFERED_BYTES,
  type EventStreamMessage,
  type EventStreamHeaders,
  type EventStreamHeaderValue,
  type EventStreamFaultKind,
  type EventStreamDecoderOptions,
} from "./eventstream.js";

export {
  CredentialManager,
  sealCredentials,
  openCredentials,
  credentialEnvelopeVersion,
  assertUsableCredentials,
  describeCredentials,
  needsRefresh,
  TOKEN_REFRESH_SKEW_MS,
  type CredentialStore,
  type CredentialManagerOptions,
  type RefreshResult,
  type TokenRefresher,
} from "./credentials.js";

export {
  transformRequest,
  assertNoServerContext,
  isHostCapabilityToolName,
  assertNoInjectedTools,
  FIXTURE_VERSION,
  type KiroRequest,
  type KiroHistoryEntry,
  type KiroToolSpecification,
  type KiroUserInputMessage,
  type KiroAssistantResponseMessage,
  type TransformOptions,
  type TransformResult,
} from "./transform.js";

export {
  toCanonicalEvents,
  classifyExceptionFrame,
  classifyStreamError,
  classifyHttpStatus,
  extractUsage,
  toFinishReason,
  isAbortError,
  newTelemetry,
  ToolBlockTracker,
  type StreamTelemetry,
  type KiroUpstreamUsage,
} from "./stream.js";

export { DEFAULT_KIRO_MODELS, MODEL_CATALOG_VERSION, resolveModel } from "./models.js";
