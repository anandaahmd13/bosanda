/**
 * @bosanda/payments — Pakasir order lifecycle (PLAN.md §11, §13).
 *
 * Every module here is side-effect free by design. §10 and §16 require the ledger row,
 * balance update, stock decrement, and key creation to land in ONE transaction, and only
 * @bosanda/database can guarantee that — so this package decides and the caller executes.
 */

export {
  isIntegerRupiah,
  type OrderStatus,
  type OrderType,
  type PackageSnapshot,
  type OrderSnapshot,
  type PaymentProvider,
  type PaymentStatus,
} from "./types.js";

export {
  PAKASIR_TIMEOUT_MS,
  PAKASIR_MAX_ATTEMPTS,
  buildCheckoutRequest,
  checkoutUrl,
  createPakasirCheckout,
  fetchPakasirTransaction,
  normalizePakasirStatus,
  parseTransactionPayload,
  redactPakasirUrl,
  type PakasirCheckout,
  type PakasirCheckoutRequest,
  type PakasirConfig,
  type PakasirDeps,
  type PakasirHttpRequest,
  type PakasirHttpResponse,
  type PakasirTransaction,
  type PakasirTransport,
} from "./pakasir.js";

export {
  SIGNATURE_HEADER,
  decideWebhookAction,
  handlePakasirWebhook,
  parseWebhookEvent,
  payloadDigest,
  signPayload,
  verifySignature,
  type PakasirWebhookEvent,
  type ParseResult,
  type PaymentEventStore,
  type ReviewReason as WebhookReviewReason,
  type SignatureRejection,
  type SignatureResult,
  type WebhookAction,
  type WebhookDeps,
  type WebhookOutcome,
} from "./webhook.js";

export {
  decideActivation,
  isTopUpEligible,
  paymentInstant,
  validityMsFor,
  type ActivationDecision,
  type ActivationGrant,
  type NewKeyGrant,
  type TopUpGrant,
} from "./activate.js";

export {
  DEFAULT_RESERVATION_MS,
  DEFAULT_TOP_UP_STOCK_POLICY,
  consumeStock,
  consumesStock,
  freeStock,
  isReservationExpired,
  releaseReservation,
  reserveStock,
  type ConsumptionDecision,
  type ReservationDecision,
  type StockRelease,
  type StockState,
  type TopUpStockPolicy,
} from "./stock.js";

export {
  ACTIVATION_GRACE_MS,
  decideReconcileAction,
  detectActivatedWithoutPayment,
  detectStaleReservation,
  exceededGrace,
  isReconcilable,
  needsProviderCheck,
  planReconcilePass,
  type NoneReason,
  type ReconcileAction,
  type ReviewReason as ReconcileReviewReason,
} from "./reconcile.js";
