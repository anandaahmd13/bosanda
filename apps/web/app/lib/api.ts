/**
 * THE server-call boundary. SERVER ONLY.
 *
 * Every call this app makes to the gateway is one exported function here: one
 * function per endpoint, each validating its response with a zod schema from
 * `./schemas` before the value can reach a component. No component fetches, and
 * nothing is faked inline in a page.
 *
 * ── Which implementation am I looking at? ────────────────────────────────────
 * Exactly one flag decides: `USE_FIXTURES` from `./env`
 * (BOSANDA_WEB_FIXTURES=1 and NODE_ENV !== "production"). Each function starts
 * with `if (USE_FIXTURES) return …` and everything after that line is the real
 * HTTP path. `apiMode()` reports which is live, and `<FixtureBanner />` puts it
 * on screen so a fixture render can never be mistaken for production.
 *
 * WHY fixtures exist at all: per docs/IMPLEMENTATION-STATUS.md the `database`,
 * `auth`, `api-keys`, `payments` packages and `apps/gateway` are all still
 * unimplemented. There is no server to call in this repo tree today. The real
 * path below is written against the documented contract, and it has NOT been
 * executed against a live gateway.
 *
 * ── Endpoint paths ──────────────────────────────────────────────────────────
 * PLAN.md §8 freezes only the model-inference surface (`/v1/models`,
 * `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`). It does
 * NOT specify the account/commerce endpoints this dashboard needs. The
 * `/v1/auth/*` prefix is taken from the rate-limit location in
 * deploy/nginx/sites-available/api.bosanda.dev.conf (`^/v1/(auth|login|register)`),
 * which is existing committed infrastructure. The rest (`/v1/account`,
 * `/v1/keys`, `/v1/orders`, `/v1/packages`) are marked PROPOSED below and must
 * be confirmed against the gateway once it exists. They are all in one file
 * precisely so that reconciliation is a single diff.
 *
 * ── Security invariants enforced here ───────────────────────────────────────
 *  - Reads forward the HttpOnly session cookie; no token is ever returned to the
 *    browser (§12).
 *  - `cache: "no-store"` on everything authenticated: a shared cache entry
 *    across users would be a data leak.
 *  - Mutations are POST only. There are no GET mutations (§12).
 *  - Errors surface a generic, client-safe message. Upstream error bodies are
 *    never forwarded to the page, matching the BosandaError contract where
 *    `internalDetail` is operator-only (docs/IMPLEMENTATION-STATUS.md).
 *  - No function here returns prompt text, response text, tool input, tool
 *    result, a provider credential, or a plaintext key — with the single
 *    exception of `revealApiKey`, which is an explicit, audited user action.
 */

import { z } from "zod";
import { GATEWAY_INTERNAL_URL, USE_FIXTURES } from "./env";
import { sessionCookieHeader } from "./session";
import {
  AccountSchema,
  KeyListSchema,
  ModelListSchema,
  OrderListSchema,
  OrderSchema,
  OrderStatusResponseSchema,
  QuotaSchema,
  RevealedKeySchema,
  StorefrontSchema,
  TopUpCandidateListSchema,
  UsageSeriesSchema,
  type Account,
  type KeySummary,
  type Order,
  type OrderStatusResponse,
  type PublicModel,
  type Quota,
  type RevealedKey,
  type Storefront,
  type TopUpCandidate,
  type UsageSeries,
} from "./schemas";
import {
  fixtureAccount,
  fixtureCreatedOrder,
  fixtureKeys,
  fixtureOrders,
  fixtureQuota,
  fixtureRevealedKey,
  fixtureStorefront,
  fixtureTopUpCandidates,
  fixtureUsage,
} from "./fixtures";

/** Which implementation is live. Rendered by `<FixtureBanner />`. */
export function apiMode(): "fixtures" | "gateway" {
  return USE_FIXTURES ? "fixtures" : "gateway";
}

/**
 * Failure of a gateway call, already safe to show a user.
 *
 * `status` lets a caller distinguish "signed out" (401) from "broken" so the
 * dashboard can redirect instead of rendering an error card.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Client-safe wording per HTTP status, mapped from §8's error table. */
function publicMessage(status: number): string {
  switch (status) {
    case 400:
      return "That request was not valid.";
    case 401:
      return "Your session has expired. Please sign in again.";
    case 403:
      return "You do not have access to that.";
    case 404:
      return "That was not found.";
    case 409:
      return "That conflicts with the current state. Reload and try again.";
    case 429:
      return "Too many requests. Please wait a moment and try again.";
    case 503:
      return "The service is temporarily unavailable.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}

/** Per-request timeout so a hung gateway cannot pin an SSR worker open. */
const REQUEST_TIMEOUT_MS = 10_000;

type RequestOptions = {
  /** Session cookie value to forward, when the call is authenticated. */
  session?: string | null;
  /** JSON body. Presence implies POST. */
  body?: unknown;
  /** Overrides the method inferred from `body`. */
  method?: "GET" | "POST";
};

/**
 * One place where an HTTP request is actually made.
 *
 * Validates with `schema` and throws `ApiError` on any non-2xx, network fault,
 * timeout, or schema mismatch. A schema mismatch is treated as a server fault
 * (502-ish) rather than silently coerced, because rendering a partially-decoded
 * quota is worse than showing an error.
 */
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { session, body, method } = options;
  const resolvedMethod = method ?? (body === undefined ? "GET" : "POST");

  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // Forwarding the HttpOnly session cookie server-to-server is the whole reason
  // authenticated reads live in server components (§12).
  if (session != null) headers["cookie"] = sessionCookieHeader(session);

  let response: Response;
  try {
    response = await fetch(`${GATEWAY_INTERNAL_URL}${path}`, {
      method: resolvedMethod,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Authenticated and operational data must never be shared between users.
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Deliberately swallowing the cause: it can carry internal hostnames and
    // paths, which §17 keeps out of anything user-visible.
    throw new ApiError(503, "Could not reach the service. Please try again.");
  }

  if (!response.ok) {
    throw new ApiError(response.status, publicMessage(response.status));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, publicMessage(502));
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // The validation issues can quote server field values, so they are logged
    // for an operator (console.error is the one console channel ESLint allows)
    // and never returned to the page.
    console.error(`[api] response schema mismatch for ${path}`);
    throw new ApiError(502, publicMessage(502));
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public storefront
// ---------------------------------------------------------------------------

/**
 * Package availability and the global sales switch.
 * PROPOSED path: `GET /v1/packages`.
 */
export async function getStorefront(): Promise<Storefront> {
  if (USE_FIXTURES) return fixtureStorefront();
  return request("/v1/packages", StorefrontSchema);
}

/**
 * Published model list for the docs page. §8 freezes this path.
 *
 * Returns [] rather than throwing when the gateway is unreachable: the docs page
 * is public and useful without the table, and an outage should not 500 it.
 */
export async function listPublicModels(): Promise<PublicModel[]> {
  if (USE_FIXTURES) return [];
  try {
    const parsed = await request("/v1/models", ModelListSchema);
    return parsed.data;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Auth (mutations — POST only)
// ---------------------------------------------------------------------------

/**
 * Sign-up result. The gateway is expected to reply with `Set-Cookie` carrying
 * the new HttpOnly session; this function returns only whether it succeeded, so
 * no token ever passes through the React tree.
 */
export type AuthOutcome = { ok: true; setCookie: string | null } | { ok: false; message: string };

/**
 * POST /v1/auth/register — username + password only (§12: email is not
 * required in v1, no guest checkout).
 */
export async function register(username: string, password: string): Promise<AuthOutcome> {
  if (USE_FIXTURES) return { ok: true, setCookie: null };
  return authCall("/v1/auth/register", { username, password });
}

/** POST /v1/auth/login — §12 requires session rotation on success. */
export async function login(username: string, password: string): Promise<AuthOutcome> {
  if (USE_FIXTURES) return { ok: true, setCookie: null };
  return authCall("/v1/auth/login", { username, password });
}

/** POST /v1/auth/logout — revokes the session server-side. */
export async function logout(session: string): Promise<void> {
  if (USE_FIXTURES) return;
  try {
    await request("/v1/auth/logout", z.unknown(), { session, body: {}, method: "POST" });
  } catch {
    // A failed logout must still clear the local cookie, so this is not fatal.
  }
}

/**
 * Shared auth POST. Returns the raw `Set-Cookie` for the caller to relay, and
 * never echoes the submitted credentials back in any form.
 *
 * The failure message is intentionally identical for "no such user" and "wrong
 * password" so this endpoint cannot be used to enumerate usernames.
 */
async function authCall(
  path: string,
  body: { username: string; password: string },
): Promise<AuthOutcome> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_INTERNAL_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: "Could not reach the service. Please try again." };
  }

  if (response.ok) {
    return { ok: true, setCookie: response.headers.get("set-cookie") };
  }
  if (response.status === 409) {
    return { ok: false, message: "That username is already taken." };
  }
  if (response.status === 401 || response.status === 400) {
    return { ok: false, message: "Incorrect username or password." };
  }
  if (response.status === 429) {
    return { ok: false, message: "Too many attempts. Please wait a moment and try again." };
  }
  return { ok: false, message: publicMessage(response.status) };
}

// ---------------------------------------------------------------------------
// Account & dashboard reads (authenticated)
// ---------------------------------------------------------------------------

/** PROPOSED: `GET /v1/account`. */
export async function getAccount(session: string): Promise<Account> {
  if (USE_FIXTURES) return fixtureAccount();
  return request("/v1/account", AccountSchema, { session });
}

/** PROPOSED: `GET /v1/account/quota` — weighted tokens remaining (§10). */
export async function getQuota(session: string): Promise<Quota> {
  if (USE_FIXTURES) return fixtureQuota();
  return request("/v1/account/quota", QuotaSchema, { session });
}

/**
 * PROPOSED: `GET /v1/account/usage` — bucketed weighted-token burn.
 * Aggregates only; §16 forbids retaining or exposing prompt/response bodies.
 */
export async function getUsage(session: string): Promise<UsageSeries> {
  if (USE_FIXTURES) return fixtureUsage();
  return request("/v1/account/usage", UsageSeriesSchema, { session });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * PROPOSED: `GET /v1/keys`.
 *
 * Returns masked keys only. The plaintext is NOT in this payload and must not
 * be added to it: §12 requires masked-by-default display, and a list response
 * is exactly the thing that ends up in a cache or a screenshot.
 */
export async function listApiKeys(session: string): Promise<KeySummary[]> {
  if (USE_FIXTURES) return fixtureKeys();
  const parsed = await request("/v1/keys", KeyListSchema, { session });
  return parsed.keys;
}

/**
 * PROPOSED: `POST /v1/keys/{id}/reveal`.
 *
 * Separate, explicit, audited request (§12: "eye toggle decrypts only after a
 * valid website session; key reveal is audited"). POST despite being a read
 * because it writes an audit row and must never be cached, prefetched, or
 * triggered by link traversal.
 *
 * The returned plaintext is handed straight to the client component that asked
 * for it and is never logged or persisted.
 */
export async function revealApiKey(session: string, keyId: string): Promise<RevealedKey> {
  if (USE_FIXTURES) return fixtureRevealedKey(keyId);
  return request(`/v1/keys/${encodeURIComponent(keyId)}/reveal`, RevealedKeySchema, {
    session,
    body: {},
    method: "POST",
  });
}

/** PROPOSED: `POST /v1/keys/{id}/revoke` (§12: keys can be revoked and rotated). */
export async function revokeApiKey(session: string, keyId: string): Promise<void> {
  if (USE_FIXTURES) return;
  await request(`/v1/keys/${encodeURIComponent(keyId)}/revoke`, z.unknown(), {
    session,
    body: {},
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Orders & checkout
// ---------------------------------------------------------------------------

/** PROPOSED: `GET /v1/orders` — history with status and the immutable snapshot. */
export async function listOrders(session: string): Promise<Order[]> {
  if (USE_FIXTURES) return fixtureOrders();
  const parsed = await request("/v1/orders", OrderListSchema, { session });
  return parsed.orders;
}

/** PROPOSED: `GET /v1/orders/{id}`. */
export async function getOrder(session: string, orderId: string): Promise<Order> {
  if (USE_FIXTURES) {
    const found = fixtureOrders().find((order) => order.orderId === orderId);
    return found ?? fixtureCreatedOrder("p10m", 10_000_000, 9_500);
  }
  return request(`/v1/orders/${encodeURIComponent(orderId)}`, OrderSchema, { session });
}

/**
 * PROPOSED: `GET /v1/orders/{id}/status` — polled by the return page (§13).
 *
 * A narrow projection on purpose: the poll runs every few seconds and there is
 * no reason to re-ship the whole order snapshot to do it.
 */
export async function getOrderStatus(
  session: string,
  orderId: string,
): Promise<OrderStatusResponse> {
  if (USE_FIXTURES) {
    const order = await getOrder(session, orderId);
    return {
      orderId: order.orderId,
      status: order.status,
      activatedKeyId: order.activatedKeyId,
      paymentUrl: order.paymentUrl,
    };
  }
  return request(`/v1/orders/${encodeURIComponent(orderId)}/status`, OrderStatusResponseSchema, {
    session,
  });
}

/** PROPOSED: `GET /v1/keys/top-up-candidates` — active, non-exhausted only (§11). */
export async function listTopUpCandidates(session: string): Promise<TopUpCandidate[]> {
  if (USE_FIXTURES) return fixtureTopUpCandidates();
  const parsed = await request("/v1/keys/top-up-candidates", TopUpCandidateListSchema, { session });
  return parsed.keys;
}

/**
 * PROPOSED: `POST /v1/orders` — create an order and reserve stock (§13 step 3-4).
 *
 * Only the package id, the intent, and the target key are sent. Price and quota
 * are deliberately NOT sent: §13 says never trust price, package, username, or
 * quota from browser-supplied data — the server resolves the price from its own
 * package record and snapshots it onto the order.
 */
export async function createOrder(
  session: string,
  input: { packageId: string; intent: "new_key" | "top_up"; targetKeyId: string | null },
): Promise<Order> {
  if (USE_FIXTURES) {
    const fallback = fixtureCreatedOrder(input.packageId, 10_000_000, 9_500);
    return fallback;
  }
  return request("/v1/orders", OrderSchema, {
    session,
    method: "POST",
    body: {
      packageId: input.packageId,
      intent: input.intent,
      targetKeyId: input.targetKeyId,
    },
  });
}

/** PROPOSED: `POST /v1/orders/{id}/cancel` — releases the stock reservation (§11). */
export async function cancelOrder(session: string, orderId: string): Promise<void> {
  if (USE_FIXTURES) return;
  await request(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, z.unknown(), {
    session,
    body: {},
    method: "POST",
  });
}
