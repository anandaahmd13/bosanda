/**
 * Pakasir checkout call (PLAN.md §13 "Checkout" steps 3-4).
 *
 * ASSUMED PROVIDER CONTRACT — READ BEFORE TRUSTING THIS FILE.
 * PLAN.md §13 says only "Bosanda creates the Pakasir transaction", and §23 defers the
 * wire format: "Pakasir: implementation must follow the current official Pakasir
 * API/webhook documentation available during M3." That documentation is not available in
 * this environment, so the request/response shape below is an assumption modelled on
 * Pakasir's published pattern (a per-project hosted payment page keyed by amount plus a
 * merchant `order_id`). Everything provider-specific is confined to `checkoutUrl`,
 * `normalizePakasirStatus`, and `parseTransactionPayload`, so correcting it against the
 * real documentation is a local edit.
 *
 * What is NOT an assumption, and must survive any such correction:
 *  - integer rupiah only, and the charged amount must equal the frozen order snapshot;
 *  - a hard per-attempt timeout;
 *  - bounded retries on transport failure only, never on a 4xx;
 *  - no secret in any log line, error, or returned value.
 */

import { BosandaError } from "@bosanda/protocol";
import {
  type Clock,
  TimeoutError,
  backoffMs,
  sleep as defaultSleep,
  withTimeout,
} from "@bosanda/shared";
import { isIntegerRupiah, type OrderSnapshot, type PaymentStatus } from "./types.js";

/** Hard timeout for one checkout attempt. */
export const PAKASIR_TIMEOUT_MS = 15_000;

/**
 * Total attempts including the first. Bounded because creating a payment is not free to
 * repeat and a user is waiting on it.
 */
export const PAKASIR_MAX_ATTEMPTS = 3;

export type PakasirConfig = {
  /** `PAKASIR_BASE_URL`. */
  readonly baseUrl: string;
  /** `PAKASIR_PROJECT` — the merchant project slug. */
  readonly project: string;
  /**
   * `PAKASIR_API_KEY`. Secret: never logged, never placed in a BosandaError, never
   * returned from any function here.
   */
  readonly apiKey: string | null;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
};

/**
 * Minimal structural transport so tests need no network. A real caller adapts
 * `globalThis.fetch` to this in one small function at the edge.
 */
export type PakasirHttpRequest = {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly signal: AbortSignal;
};

export type PakasirHttpResponse = {
  readonly status: number;
  readonly text: () => Promise<string>;
};

export type PakasirTransport = (request: PakasirHttpRequest) => Promise<PakasirHttpResponse>;

export type PakasirDeps = {
  readonly transport: PakasirTransport;
  readonly clock: Clock;
  /** Injectable so retry tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source, for deterministic backoff in tests. */
  readonly random?: () => number;
};

/**
 * The order-derived half of the checkout request. Contains only values taken from
 * server-created order truth — never anything client-supplied. The project slug comes
 * from config, not from here, so a package record can never redirect a charge to another
 * merchant project.
 */
export type PakasirCheckoutRequest = {
  readonly orderId: string;
  /** Integer rupiah. */
  readonly amount: number;
  readonly currency: "IDR";
  readonly redirectUrl: string | null;
};

export type PakasirCheckout = {
  readonly orderId: string;
  readonly amount: number;
  /** Hosted page the browser is sent to. Contains no API key. */
  readonly paymentUrl: string;
  readonly providerTransactionId: string | null;
  readonly status: PaymentStatus;
};

export type PakasirTransaction = {
  readonly orderId: string;
  readonly status: PaymentStatus;
  /** Integer rupiah as reported by the provider, or null when absent/unusable. */
  readonly amountIdr: number | null;
  readonly providerTransactionId: string | null;
  readonly paidAt: Date | null;
};

/**
 * Provider status vocabulary → normalized `PaymentStatus`.
 *
 * Anything unrecognized maps to "pending", never to "paid": an unknown word must not be
 * the thing that activates a key. Reconciliation (§13) re-checks later.
 */
export function normalizePakasirStatus(raw: string): PaymentStatus {
  switch (raw.trim().toLowerCase()) {
    case "completed":
    case "complete":
    case "paid":
    case "settled":
    case "success":
    case "successful":
      return "paid";
    case "failed":
    case "failure":
    case "denied":
    case "rejected":
      return "failed";
    case "expired":
    case "timeout":
      return "expired";
    case "cancelled":
    case "canceled":
    case "voided":
      return "cancelled";
    default:
      return "pending";
  }
}

/**
 * Strips secret-shaped query parameters before a URL can reach a log line or an error.
 * Pakasir's documented pattern passes credentials as query parameters, so a URL is a real
 * leak vector here rather than a hypothetical one.
 */
export function redactPakasirUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (/key|secret|token|signature|password/i.test(name)) {
        parsed.searchParams.set(name, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    // An unparseable value may itself be malformed credential material; return nothing.
    return "[unparseable url]";
  }
}

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

/** Marks a failure that never produced an HTTP response (DNS, TCP, TLS, socket reset). */
class TransportError extends Error {
  constructor(cause: unknown) {
    super("transport failure");
    this.name = "TransportError";
    this.cause = cause;
  }
}

/** True only for a failure a retry could plausibly fix. A 4xx is never in this set. */
const isRetryableFailure = (error: unknown): boolean =>
  error instanceof TimeoutError || error instanceof TransportError;

/**
 * Builds the checkout request from the order, enforcing §14's integer rupiah and applying
 * §13's "Validate amount and currency against the immutable order snapshot" at creation
 * time too, not only on the webhook. An order whose `amountIdr` has drifted from its own
 * frozen snapshot never reaches the provider.
 */
export function buildCheckoutRequest(
  order: OrderSnapshot,
  redirectUrl: string | null = null,
): PakasirCheckoutRequest {
  if (!isIntegerRupiah(order.amountIdr)) {
    throw new BosandaError("invalid_request", {
      internalDetail: `order ${order.orderId} amount is not integer rupiah`,
    });
  }
  if (!isIntegerRupiah(order.packageSnapshot.priceIdr)) {
    throw new BosandaError("invalid_request", {
      internalDetail: `order ${order.orderId} snapshot price is not integer rupiah`,
    });
  }
  if (order.amountIdr !== order.packageSnapshot.priceIdr) {
    throw new BosandaError("invalid_request", {
      internalDetail: `order ${order.orderId} amount ${order.amountIdr} != snapshot price ${order.packageSnapshot.priceIdr}`,
    });
  }
  if (order.currency !== "IDR") {
    throw new BosandaError("invalid_request", {
      internalDetail: `order ${order.orderId} currency must be IDR`,
    });
  }
  if (order.provider !== "pakasir") {
    throw new BosandaError("invalid_request", {
      internalDetail: `order ${order.orderId} provider is not pakasir`,
    });
  }

  return {
    orderId: order.orderId,
    amount: order.amountIdr,
    currency: "IDR",
    redirectUrl,
  };
}

/**
 * The hosted payment page URL. Deliberately excludes the API key, because this value is
 * handed to a browser.
 */
export function checkoutUrl(config: PakasirConfig, request: PakasirCheckoutRequest): string {
  const url = new URL(
    `${trimSlash(config.baseUrl)}/pay/${encodeURIComponent(config.project)}/${request.amount}`,
  );
  url.searchParams.set("order_id", request.orderId);
  if (request.redirectUrl !== null) url.searchParams.set("redirect", request.redirectUrl);
  return url.toString();
}

async function attempt(
  config: PakasirConfig,
  deps: PakasirDeps,
  request: Omit<PakasirHttpRequest, "signal">,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? PAKASIR_TIMEOUT_MS;

  try {
    const response = await withTimeout(
      (async () => {
        try {
          return await deps.transport({ ...request, signal: controller.signal });
        } catch (error) {
          // A transport that reports its own timeout (undici does) must stay a timeout:
          // §8 maps that to 504, and BosandaError.shouldCooldownProvider keys off the code.
          // Wrapping it as a generic transport failure would misreport it as a 500.
          if (error instanceof TimeoutError) throw error;
          throw new TransportError(error);
        }
      })(),
      timeoutMs,
      "hard",
    );

    let body: string;
    try {
      body = await withTimeout(response.text(), timeoutMs, "hard");
    } catch (error) {
      if (error instanceof TimeoutError) throw error;
      throw new TransportError(error);
    }

    return { status: response.status, body };
  } finally {
    // Free the socket whether or not we timed out.
    controller.abort();
  }
}

/**
 * Runs an attempt loop with a hard timeout and bounded retries.
 *
 * Retry policy, deliberately narrow: only a failure that produced NO HTTP response is
 * retried (transport error or timeout). Any status code is final — a 4xx is a request
 * Bosanda got wrong and repeating it cannot help, and a 5xx may already have created a
 * transaction upstream, so a blind re-POST risks a second charge. Reconciliation (§13) is
 * the correct recovery for an ambiguous 5xx.
 */
async function send(
  config: PakasirConfig,
  deps: PakasirDeps,
  request: Omit<PakasirHttpRequest, "signal">,
  label: string,
  onStatus: (status: number) => never,
): Promise<string> {
  const maxAttempts = config.maxAttempts ?? PAKASIR_MAX_ATTEMPTS;
  const sleep = deps.sleep ?? defaultSleep;
  let lastFailure: unknown;

  for (let n = 1; n <= maxAttempts; n += 1) {
    try {
      const { status, body } = await attempt(config, deps, request);
      if (status >= 200 && status < 300) return body;
      // Status classes only. The upstream body may echo our request back, so it never
      // enters an error or a log line.
      onStatus(status);
    } catch (error) {
      if (error instanceof BosandaError) throw error;
      if (!isRetryableFailure(error)) throw BosandaError.from(error);

      lastFailure = error;
      if (n < maxAttempts) {
        await sleep(backoffMs(n, 200, 2_000, deps.random ?? Math.random));
      }
    }
  }

  const timedOut = lastFailure instanceof TimeoutError;
  throw new BosandaError(timedOut ? "upstream_timeout" : "internal_error", {
    internalDetail: `pakasir ${label} failed after ${maxAttempts} attempts (${
      timedOut ? "timeout" : "transport"
    })`,
  });
}

/** Shape-tolerant reader for the provider's JSON. Unknown fields are ignored. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Parses a transaction payload into normalized form.
 *
 * An amount is accepted only as an integer-rupiah number. A float or a numeric string
 * yields null so the caller treats the amount as UNVERIFIED rather than trusting a
 * coerced value — §13 forbids trusting provider-supplied price data anyway, so null is
 * the safe outcome.
 */
export function parseTransactionPayload(body: string, fallbackOrderId: string): PakasirTransaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BosandaError("internal_error", {
      internalDetail: "pakasir returned a non-JSON body",
    });
  }

  const root = asRecord(parsed);
  if (root === null) {
    throw new BosandaError("internal_error", {
      internalDetail: "pakasir returned a non-object body",
    });
  }
  const source = asRecord(root.transaction) ?? asRecord(root.data) ?? root;

  const rawStatus = readString(source, "status", "transaction_status", "state");
  const amount = source.amount;
  const completedAt = readString(source, "completed_at", "paid_at", "settled_at");
  const paidAt = completedAt === null ? null : new Date(completedAt);

  return {
    orderId: readString(source, "order_id", "orderId") ?? fallbackOrderId,
    status: rawStatus === null ? "pending" : normalizePakasirStatus(rawStatus),
    amountIdr: typeof amount === "number" && isIntegerRupiah(amount) ? amount : null,
    providerTransactionId: readString(source, "transaction_id", "id", "reference"),
    paidAt: paidAt !== null && Number.isFinite(paidAt.getTime()) ? paidAt : null,
  };
}

/**
 * Creates the Pakasir transaction for an order (§13 "Checkout" step 4).
 *
 * The returned `paymentUrl` is safe to hand to a browser, and neither the return value
 * nor any thrown error contains the API key.
 */
export async function createPakasirCheckout(
  order: OrderSnapshot,
  config: PakasirConfig,
  deps: PakasirDeps,
  redirectUrl: string | null = null,
): Promise<PakasirCheckout> {
  const request = buildCheckoutRequest(order, redirectUrl);
  const url = `${trimSlash(config.baseUrl)}/api/transactions`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`;

  const body = await send(
    config,
    deps,
    {
      url,
      method: "POST",
      headers,
      body: JSON.stringify({
        project: config.project,
        order_id: request.orderId,
        amount: request.amount,
        currency: request.currency,
        ...(request.redirectUrl === null ? {} : { redirect_url: request.redirectUrl }),
      }),
    },
    "checkout",
    (status) => {
      throw new BosandaError("internal_error", {
        internalDetail: `pakasir checkout returned ${status} at ${redactPakasirUrl(url)}`,
      });
    },
  );

  let transaction: PakasirTransaction | null;
  try {
    transaction = parseTransactionPayload(body, request.orderId);
  } catch {
    // A successful creation with an unparseable body still leaves a usable hosted page,
    // and reconciliation will establish the real status. Do not fail the checkout.
    transaction = null;
  }

  return {
    orderId: request.orderId,
    amount: request.amount,
    paymentUrl: checkoutUrl(config, request),
    providerTransactionId: transaction?.providerTransactionId ?? null,
    status: transaction?.status ?? "pending",
  };
}

/**
 * Status lookup for the reconciliation worker (§13: "A worker polls/checks Pakasir status
 * for pending or ambiguous orders").
 *
 * Same timeout and retry discipline as checkout. Read-only, so a retry cannot double-charge.
 */
export async function fetchPakasirTransaction(
  order: OrderSnapshot,
  config: PakasirConfig,
  deps: PakasirDeps,
): Promise<PakasirTransaction> {
  if (!isIntegerRupiah(order.amountIdr)) {
    throw new BosandaError("invalid_request", {
      internalDetail: `order ${order.orderId} amount is not integer rupiah`,
    });
  }

  const url = new URL(`${trimSlash(config.baseUrl)}/api/transactiondetail`);
  url.searchParams.set("project", config.project);
  url.searchParams.set("amount", String(order.amountIdr));
  url.searchParams.set("order_id", order.orderId);

  const headers: Record<string, string> = { accept: "application/json" };
  if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`;

  const body = await send(
    config,
    deps,
    { url: url.toString(), method: "GET", headers, body: null },
    "status lookup",
    (status) => {
      if (status === 404) {
        throw new BosandaError("not_found", {
          internalDetail: `pakasir has no transaction for order ${order.orderId}`,
        });
      }
      throw new BosandaError("internal_error", {
        internalDetail: `pakasir status lookup returned ${status}`,
      });
    },
  );

  return parseTransactionPayload(body, order.orderId);
}
