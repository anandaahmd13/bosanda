/**
 * The admin session guard (PLAN.md §12 sessions, §16 "Admin / user isolation").
 *
 * ── WHY THIS IS NOT `requireAuth` ─────────────────────────────────────────
 * `routes/authenticate.ts` authenticates an API KEY: a bearer credential a customer
 * pastes into an SDK, scoped to metered inference. The admin surface is authenticated
 * by a browser SESSION cookie instead, and the two must not be interchangeable. If an
 * API key could reach an admin route, a customer's own key — which they can read in
 * full — would be an operator credential; if a session cookie could drive inference,
 * a CSRF against the dashboard would spend someone's quota. Two separate functions,
 * neither calling the other, is what makes that impossible to get wrong by accident.
 *
 * ── WHY THE COOKIE IS READ BY HAND ────────────────────────────────────────
 * `@fastify/cookie` is present in the workspace but is NOT registered by `app.ts`, and
 * registering a plugin that every other surface would then also carry is a wider change
 * than this route group is allowed to make. `parseCookies` from `@bosanda/auth` is the
 * same parser the website uses, so there is one cookie-parsing implementation and it is
 * already tested.
 *
 * ── WHY BOTH COOKIE NAMES ARE ACCEPTED ────────────────────────────────────
 * `apps/admin/app/lib/session.ts` sends `__Host-bosanda_admin_session` in production and
 * `bosanda_admin_session_dev` otherwise, and the gateway cannot see which build the
 * dashboard is running. Accepting both names is not a weakening: the cookie VALUE is an
 * opaque 256-bit token verified against a keyed digest, so the name carries no authority
 * at all — it is only a lookup label. What the name buys is on the browser side
 * (`__Host-` pins the cookie to one origin), and that protection is enforced by the
 * browser at set time, not by us at read time.
 *
 * ── EVERY REJECTION IS THE SAME 401 ───────────────────────────────────────
 * No cookie, an unknown token, a revoked session, an expired session, an idle session,
 * a suspended user, and a NON-ADMIN user all produce one `authentication_error` with one
 * public message. `evaluateSession` already collapses its four reasons for this reason;
 * the role check joins them because "you are logged in but not an operator" is exactly
 * the fact an attacker would use to decide whose password to attack. The distinction is
 * kept in `internalDetail`, which never leaves the process.
 */

import type { FastifyRequest } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import { evaluateSession, parseCookies, sessionDigest } from "@bosanda/auth";
import type { PublicUser } from "@bosanda/database";
import type { AdminDeps } from "./deps.js";

/**
 * Cookie names the guard will read, in priority order.
 *
 * Exported so the tests use the same strings the dashboard does rather than a literal
 * that could drift from `apps/admin/app/lib/session.ts` unnoticed.
 */
export const ADMIN_SESSION_COOKIE = "__Host-bosanda_admin_session";
export const ADMIN_SESSION_COOKIE_DEV = "bosanda_admin_session_dev";

/** The authenticated operator, as every admin route needs it. */
export type AdminActor = {
  readonly sessionId: string;
  readonly user: PublicUser;
};

/**
 * The one error every failed admin authentication produces.
 *
 * `internalDetail` names the reason for the operator log; `publicMessage` is the
 * protocol default for `authentication_error` and says nothing about which check failed.
 */
function rejected(detail: string): BosandaError {
  return new BosandaError("authentication_error", { internalDetail: `admin ${detail}` });
}

/** Reads the session token out of the request's cookie header, or null. */
export function readSessionToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return null;

  const jar = parseCookies(header);
  const token = jar.get(ADMIN_SESSION_COOKIE) ?? jar.get(ADMIN_SESSION_COOKIE_DEV);
  return token !== undefined && token.length > 0 ? token : null;
}

/**
 * Authenticates the request as an admin, or throws 401.
 *
 * Called as the FIRST statement of every admin handler. Deliberately not an `onRequest`
 * hook on a prefixed scope: a hook that authenticates by URL prefix silently protects
 * whatever is later registered under that prefix and silently stops protecting a route
 * that moves, whereas an explicit call is visible in the handler that needs it and a
 * missing one is visible in review.
 *
 * `touchLastUsed` is awaited rather than fired and forgotten — unlike the API-key path,
 * which handles thousands of requests a second and cannot afford the write. The admin
 * surface handles a handful, and the sliding idle window in `evaluateSession` reads
 * `last_used_at`: not awaiting it would let a busy operator's session expire on the idle
 * timeout while they were actively using it.
 */
export async function requireAdmin(request: FastifyRequest, deps: AdminDeps): Promise<AdminActor> {
  const token = readSessionToken(request);
  if (token === null) throw rejected("request carried no session cookie");

  const found = await deps.sessions.findWithUser(sessionDigest(token, deps.keyring));

  // `evaluateSession` takes null and reports `unknown`, so an absent row and a present
  // but unusable one travel the same path and cost the same lookup.
  const validity = evaluateSession(found === null ? null : found.session, deps.clock.now());
  if (!validity.valid) throw rejected(`session rejected: ${validity.reason}`);
  if (found === null) throw rejected("session rejected: unknown");

  const { user } = found;
  if (user.role !== "admin") {
    // The session is genuine — this is a CUSTOMER holding a valid cookie. Logged at the
    // same level as any other rejection but with the user named, because a customer
    // session arriving at an operator route is worth an operator's attention.
    throw rejected(`session belongs to a non-admin user ${user.id}`);
  }
  if (user.status !== "active") throw rejected(`user ${user.id} is not active`);

  await deps.sessions.touchLastUsed(found.session.id, deps.clock.now());

  return { sessionId: found.session.id, user };
}
