/**
 * The one place an HTTP request becomes an authenticated key (PLAN.md §12).
 *
 * `apps/gateway/src/auth.ts` owns the header parsing and the lookup; this thin
 * wrapper is what routes call, and it exists for three reasons that are easy to get
 * wrong if every route repeats them:
 *
 *   1. It THROWS the single frozen 401 rather than returning a union, so a route
 *      cannot forget to check and accidentally serve an unauthenticated request.
 *   2. It records the failure CLASS as a metric label and in the operator log while
 *      the response stays identical for every class (§12's no-oracle rule). The
 *      reason never reaches the client.
 *   3. It calls `touchLastUsed` exactly once, on success — the gateway is where a
 *      key is genuinely exercised, so this is the call site that makes
 *      `api_keys.last_used_at` mean anything.
 *
 * ── WHY NOT A `preHandler` HOOK ───────────────────────────────────────────
 * A global hook would authenticate `/health` and `/metrics` too, which must stay
 * reachable by the local probe without a customer key, and it would put the 401 in a
 * different place from the surface-specific error envelope each route needs. Calling
 * it explicitly at the top of each protected handler keeps the boundary visible in
 * the route body rather than in registration order.
 */

import type { AuthenticatedApiKey } from "@bosanda/database";
import type { FastifyRequest } from "fastify";
import { authenticate, authenticationError } from "../auth.js";
import { touchKey } from "../pipeline.js";
import type { GatewayDeps } from "../dependencies.js";

/**
 * Authenticates or throws the frozen 401.
 *
 * The metric label is the failure class, never the presented key or a digest of it:
 * `missing_header` and `key_revoked` are useful operational signals (a spike in the
 * former means a client is misconfigured, a spike in the latter means a leaked key
 * is still being used), and neither identifies anyone.
 */
export async function requireAuth(
  request: FastifyRequest,
  deps: GatewayDeps,
): Promise<AuthenticatedApiKey> {
  const result = await authenticate(request.headers, deps);

  if (!result.ok) {
    // The failure CLASS goes to the log only. §17 pre-registers its metric set and
    // an unregistered name throws, so there is deliberately no
    // `bosanda_auth_failures_total`: the 401 is already counted by
    // `bosanda_requests_total{status="401"}` in the observability plugin, and
    // adding a second series here would mean editing a frozen package to describe
    // something the existing one already reports.
    // `bosandaLog`, not `request.log`: `app.ts` boots Fastify with `logger: false`, so
    // `request.log` is Fastify's no-op stub and every call on it is silently dropped.
    // This line is the only operator-visible record of WHY a 401 was returned, since
    // the response is deliberately identical for all five failure classes.
    request.bosandaLog.warn({ reason: result.reason }, "api key authentication failed");
    throw authenticationError(result.reason);
  }

  // Fire-and-forget: a customer's request must not fail because a timestamp write
  // did. `touchKey` logs its own failure.
  //
  // The container's logger rather than `request.log`: this write outlives the
  // request (nothing awaits it), and Fastify's per-request child logger is not the
  // `@bosanda/observability` type anyway. The correlation id is carried in the log
  // line's fields instead of by the logger's binding.
  touchKey(result.authenticated.key.id, deps, deps.logger);

  return result.authenticated;
}
