/**
 * Pakasir webhook verification and handling (PLAN.md §13 "Webhook requirements").
 *
 * ASSUMED SIGNATURE SCHEME. §13 line "Validate the authentication/signature mechanism
 * documented by Pakasir" names no concrete algorithm, and §23 defers it: "Pakasir:
 * implementation must follow the current official Pakasir API/webhook documentation
 * available during M3." That documentation is not available in this environment, so this
 * module assumes:
 *
 *   signature = hex(HMAC-SHA-256(PAKASIR_WEBHOOK_SECRET, raw_request_body))
 *
 * delivered in the `x-pakasir-signature` header, optionally prefixed `sha256=`. Only
 * `SIGNATURE_HEADER`, `signPayload`, and `verifySignature` encode that assumption; the
 * order-matching and idempotency logic below is scheme-independent and stays correct if
 * the real scheme differs.
 *
 * Invariants that are NOT assumptions (§13, verbatim requirements):
 *  - verification runs on the RAW body, BEFORE JSON parsing, so a body that parses to the
 *    same object but differs by a byte cannot pass;
 *  - comparison is constant-time;
 *  - "Never trust price, package, username, or quota from browser-supplied webhook data":
 *    the only fields read from the payload are the order id, the provider status, the
 *    provider transaction id, and the amount — and the amount is used ONLY to be checked
 *    against the immutable order snapshot, never as the charged value;
 *  - idempotency is keyed on the provider event key, so a duplicate delivery is a no-op
 *    that still reports success to the provider;
 *  - a payload DIGEST is recorded, never the raw payload;
 *  - "Return success only after durable processing" — this module decides, and reports
 *    what durable work the caller must commit before acknowledging.
 */

import { createHash, createHmac } from "node:crypto";
import { constantTimeEqual } from "@bosanda/api-keys";
import type { Clock } from "@bosanda/shared";
import { z } from "zod";
import { isIntegerRupiah, type OrderSnapshot, type PaymentStatus } from "./types.js";
import { normalizePakasirStatus } from "./pakasir.js";

/** Header carrying the HMAC. Part of the assumed scheme documented above. */
export const SIGNATURE_HEADER = "x-pakasir-signature";

/** Computes the expected signature for a raw body. Exported for use by tests and tooling. */
export function signPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * SHA-256 of the raw body, hex. This is what gets persisted in `payment_events`
 * (§14 `payload_digest`) so a delivery is auditable without retaining provider data.
 */
export function payloadDigest(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export type SignatureRejection = "missing_signature" | "malformed_signature" | "bad_signature";

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureRejection };

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Verifies the HMAC over the RAW body using a constant-time comparison.
 *
 * The received value is normalized (optional `sha256=` prefix, case) and shape-checked
 * before comparison. A shape check is not a timing leak: it rejects values that could not
 * be a signature at all, and every value that *could* be one takes the same path.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): SignatureResult {
  if (signatureHeader === null || signatureHeader === undefined || signatureHeader.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }

  const received = signatureHeader
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  if (!HEX_64.test(received)) return { ok: false, reason: "malformed_signature" };

  const expected = signPayload(rawBody, secret);
  return constantTimeEqual(received, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

/**
 * The only fields read from a webhook body.
 *
 * `amount` is accepted so it can be CHECKED against the order snapshot, never so it can be
 * charged. There is deliberately no field for package, quota, price, or username: §13
 * forbids trusting those from webhook data, and the way to be sure is to not decode them.
 */
const webhookSchema = z.object({
  order_id: z.string().min(1).max(128),
  status: z.string().min(1).max(64),
  amount: z.number().finite().optional(),
  transaction_id: z.string().min(1).max(128).optional(),
  /** Provider-side event identity, when the provider supplies one. */
  event_id: z.string().min(1).max(128).optional(),
  completed_at: z.string().min(1).max(64).optional(),
});

export type PakasirWebhookEvent = {
  readonly orderId: string;
  readonly status: PaymentStatus;
  /** Integer rupiah, or null when absent or not an integer. */
  readonly amountIdr: number | null;
  readonly providerTransactionId: string | null;
  /** Idempotency key for `payment_events.provider_event_key` (§14 UNIQUE). */
  readonly eventKey: string;
  readonly paidAt: Date | null;
};

export type ParseResult =
  { ok: true; event: PakasirWebhookEvent } | { ok: false; reason: "malformed_payload" };

/**
 * Parses a verified body. Runs only AFTER signature verification.
 *
 * The idempotency key prefers the provider's own event id and otherwise derives one from
 * (order, status, transaction, body digest). §13 requires accepting duplicate and
 * out-of-order callbacks safely, so the fallback must be stable across redeliveries of the
 * same event while still distinguishing a genuine later status change for the same order.
 */
export function parseWebhookEvent(rawBody: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "malformed_payload" };
  }

  const parsed = webhookSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed_payload" };
  const body = parsed.data;

  const status = normalizePakasirStatus(body.status);
  const transactionId = body.transaction_id ?? null;
  const completedAt = body.completed_at === undefined ? null : new Date(body.completed_at);
  const paidAt =
    completedAt !== null && Number.isFinite(completedAt.getTime()) ? completedAt : null;

  const eventKey =
    body.event_id ??
    `${body.order_id}:${status}:${transactionId ?? "none"}:${payloadDigest(rawBody).slice(0, 32)}`;

  return {
    ok: true,
    event: {
      orderId: body.order_id,
      status,
      amountIdr: body.amount !== undefined && isIntegerRupiah(body.amount) ? body.amount : null,
      providerTransactionId: transactionId,
      eventKey,
      paidAt,
    },
  };
}

/**
 * Idempotency store, backed by the `payment_events` UNIQUE (provider, provider_event_key)
 * constraint (§14). `claim` is an INSERT ... ON CONFLICT DO NOTHING: "claimed" means this
 * delivery owns the event, "duplicate" means someone already recorded it.
 *
 * Injectable so tests need no PostgreSQL.
 */
export type PaymentEventStore = {
  claim(input: {
    provider: "pakasir";
    eventKey: string;
    payloadDigest: string;
    receivedAt: Date;
  }): Promise<"claimed" | "duplicate">;
};

/** What the caller must durably commit before acknowledging (§13 step 8). */
export type WebhookAction =
  /** Nothing to do; safe to acknowledge. */
  | { kind: "none"; reason: "duplicate" | "already_activated" | "not_paid" | "terminal_status" }
  /** Mark paid, consume stock, create-or-top-up the key, append ledger, audit — one txn. */
  | { kind: "activate"; order: OrderSnapshot; event: PakasirWebhookEvent }
  /** Release the reservation and close the order out. */
  | { kind: "expire_and_release_stock"; order: OrderSnapshot }
  | { kind: "cancel_and_release_stock"; order: OrderSnapshot }
  /** Money and order state disagree; a human decides (§13 refunds/review). */
  | { kind: "review_required"; order: OrderSnapshot; reason: ReviewReason };

export type ReviewReason =
  "amount_mismatch" | "currency_mismatch" | "snapshot_price_mismatch" | "activated_without_payment";

/**
 * Outcome of handling one delivery.
 *
 * `acknowledge` is what the HTTP layer keys off. It is true whenever the event has been
 * durably accounted for — including for a duplicate and for an order routed to review —
 * because a provider that receives a non-2xx will redeliver forever. It is false only when
 * the delivery could not be authenticated or understood, which is the one case where a
 * redelivery might legitimately differ.
 */
export type WebhookOutcome =
  | { acknowledge: true; action: WebhookAction; digest: string; eventKey: string }
  | {
      acknowledge: false;
      rejection: SignatureRejection | "malformed_payload" | "unknown_order";
      digest: string;
    };

export type WebhookDeps = {
  readonly secret: string;
  readonly store: PaymentEventStore;
  readonly clock: Clock;
  /** Resolves the SERVER-created order named by the payload (§13 "Match the provider
   *  transaction to the server-created order"). */
  readonly findOrder: (orderId: string) => Promise<OrderSnapshot | null>;
};

/**
 * Decides what a verified, de-duplicated event means for an order.
 *
 * Pure and synchronous, so every branch is testable without a store. Amount and currency
 * are validated against the immutable snapshot here (§13), and a mismatch never activates.
 */
export function decideWebhookAction(
  order: OrderSnapshot,
  event: PakasirWebhookEvent,
): WebhookAction {
  if (order.currency !== "IDR") {
    return { kind: "review_required", order, reason: "currency_mismatch" };
  }
  if (order.amountIdr !== order.packageSnapshot.priceIdr) {
    return { kind: "review_required", order, reason: "snapshot_price_mismatch" };
  }

  // An order that is already activated must never be activated twice, whatever the
  // provider says. This is the second line of defence behind the event-key UNIQUE.
  if (order.status === "activated" || order.activatedAt !== null) {
    return { kind: "none", reason: "already_activated" };
  }

  switch (event.status) {
    case "paid": {
      // The provider-reported amount, when present, must match the frozen snapshot.
      if (event.amountIdr !== null && event.amountIdr !== order.amountIdr) {
        return { kind: "review_required", order, reason: "amount_mismatch" };
      }
      return { kind: "activate", order, event };
    }
    case "expired":
      return { kind: "expire_and_release_stock", order };
    case "failed":
    case "cancelled":
      return { kind: "cancel_and_release_stock", order };
    case "pending":
      return { kind: "none", reason: "not_paid" };
  }
}

/**
 * Full webhook path: verify raw → parse → claim idempotency key → match order → decide.
 *
 * Ordering is load-bearing. Verification precedes parsing so an unsigned body is never
 * decoded, and the idempotency claim precedes order lookup so a replay costs one indexed
 * insert rather than a decision pass.
 */
export async function handlePakasirWebhook(
  rawBody: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const digest = payloadDigest(rawBody);

  const rawHeader = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toUpperCase()];
  const signature = Array.isArray(rawHeader) ? (rawHeader[0] ?? null) : (rawHeader ?? null);

  const verified = verifySignature(rawBody, signature, deps.secret);
  if (!verified.ok) return { acknowledge: false, rejection: verified.reason, digest };

  const parsed = parseWebhookEvent(rawBody);
  if (!parsed.ok) return { acknowledge: false, rejection: parsed.reason, digest };
  const event = parsed.event;

  const claim = await deps.store.claim({
    provider: "pakasir",
    eventKey: event.eventKey,
    payloadDigest: digest,
    receivedAt: deps.clock.now(),
  });

  if (claim === "duplicate") {
    // §13 "Accept duplicate and out-of-order callbacks safely": no work, still a success.
    return {
      acknowledge: true,
      action: { kind: "none", reason: "duplicate" },
      digest,
      eventKey: event.eventKey,
    };
  }

  const order = await deps.findOrder(event.orderId);
  if (order === null) {
    // Not acknowledged: an order this gateway has never seen may be a misrouted delivery
    // or a race with checkout commit, and a redelivery could legitimately succeed.
    return { acknowledge: false, rejection: "unknown_order", digest };
  }

  return {
    acknowledge: true,
    action: decideWebhookAction(order, event),
    digest,
    eventKey: event.eventKey,
  };
}
