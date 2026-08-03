/**
 * `GET|POST /admin/v1/session` and `POST /admin/v1/session/revoke` (PLAN.md §12, §15).
 *
 * ── THE LOGIN RESPONSE CARRIES THE TOKEN, AND WHY THAT IS NOT A LEAK ──────
 * The brief says no token in any response body. The admin client's `login()` parses
 * `{token, expiresAt}` FROM the body:
 *
 *     const schema = z.object({ token: z.string().min(1), expiresAt: z.string().datetime() });
 *     const result = await request("/admin/v1/session", schema, { method: "POST", ... });
 *
 * These cannot both hold, so the conflict is resolved deliberately rather than by
 * picking the more convenient one. The token is returned AND a `Set-Cookie` is issued.
 *
 * The reason this is safe here and would not be on the customer surface: `apps/admin`'s
 * `api.ts` runs exclusively in the Next.js SERVER runtime (it imports
 * `next/headers`, which throws in a browser), and its `login()` immediately writes the
 * token into an HttpOnly `__Host-` cookie via `cookies().set`. The body therefore travels
 * server→server over the internal network and is never delivered to a browser, never
 * reaches JavaScript, and never enters `localStorage`. The property the constraint exists
 * to protect — no token readable by client-side script — is intact.
 *
 * Returning ONLY the cookie would break the dashboard's login entirely (its zod parse
 * fails, so a correct password would surface as an error), and the brief forbids changing
 * `apps/admin`. Returning only the body would leave the gateway unable to authenticate a
 * direct browser session. Both is the option that satisfies the client contract and keeps
 * the cookie discipline; the mismatch is reported rather than hidden.
 *
 * ── WHY LOGIN IS NOT BEHIND `requireAdmin` ────────────────────────────────
 * These two are the only admin routes without a session, for the obvious reason. Every
 * other route in this group calls `requireAdmin` first. `GET /session` DOES require one:
 * it is the "who am I" probe, and its answer for an unauthenticated caller is 401.
 *
 * ── WHY A NON-ADMIN LOGIN FAILS AS A CREDENTIAL FAILURE ───────────────────
 * A customer's correct username and password produce the same 401 as a wrong password.
 * Distinguishing them would confirm to an attacker that an account exists and is merely
 * unprivileged, which is the first thing they would want to know. `attemptLogin` already
 * holds the "no such user" and "wrong password" paths identical; the role check joins them.
 */

import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import {
  assertLoginSucceeded,
  attemptLogin,
  clearedCookie,
  serializeCookie,
  sessionDigest,
  startSession,
  type UserRecord,
} from "@bosanda/auth";
import { ulid } from "@bosanda/shared";
import type { AdminDeps } from "./deps.js";
import { ADMIN_ACTIONS, auditActor, writeAudit } from "./audit.js";
import { iso, ok, readBody, readString } from "./contract.js";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE_DEV,
  readSessionToken,
  requireAdmin,
} from "./session.js";

/**
 * The cookie the gateway sets.
 *
 * `__Host-` requires `Secure`, which requires HTTPS — so it is used only when the
 * gateway is running in production. In development the dashboard is plain HTTP on
 * localhost and the browser would silently DISCARD a `__Host-` cookie, making login
 * appear to succeed and every subsequent request 401. The name pair mirrors
 * `apps/admin/app/lib/session.ts` exactly.
 *
 * `sameSite: strict` because the admin surface has no legitimate cross-site entry point,
 * and it is a second control over CSRF alongside the dashboard's double-submit token.
 */
function adminCookieName(deps: AdminDeps): string {
  return deps.env.NODE_ENV === "production" ? ADMIN_SESSION_COOKIE : ADMIN_SESSION_COOKIE_DEV;
}

function sessionSetCookie(deps: AdminDeps, token: string, expiresAt: Date): string {
  const production = deps.env.NODE_ENV === "production";
  // Derived from the row's own expiry rather than from `SESSION_LIFETIME_MS`, so the
  // browser stops sending the cookie at the same instant the gateway stops accepting it.
  const maxAgeSeconds = Math.floor((expiresAt.getTime() - deps.clock.now().getTime()) / 1000);
  return serializeCookie({
    name: adminCookieName(deps),
    value: token,
    maxAgeSeconds,
    secure: production,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });
}

/** Clears the cookie on revoke, with the same attributes so the browser matches it. */
function clearedSetCookie(deps: AdminDeps): string {
  return serializeCookie(
    clearedCookie(adminCookieName(deps), { secure: deps.env.NODE_ENV === "production" }),
  );
}

export function registerSessionRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /**
   * The session probe. `adminSession` is `.strict()`, so exactly these four fields.
   *
   * `role` is `z.literal("admin")` in the client schema — it can only ever be `"admin"`
   * here, because `requireAdmin` has already rejected anything else.
   */
  app.get("/admin/v1/session", async (request, reply) => {
    const actor = await requireAdmin(request, deps);

    // The cookie's own expiry is the session's absolute deadline. Re-read rather than
    // recomputed so the dashboard's countdown agrees with when the gateway will stop
    // accepting the cookie.
    const found = await deps.sessions.findWithUser(
      sessionDigest(readSessionToken(request) ?? "", deps.keyring),
    );
    if (found === null) {
      // Cannot happen — `requireAdmin` just read the same row — but the type is nullable
      // and inventing an expiry would be worse than failing.
      throw new BosandaError("authentication_error", {
        internalDetail: "admin session vanished between guard and read",
      });
    }

    return reply.status(200).send({
      userId: actor.user.id,
      username: actor.user.username,
      role: "admin",
      expiresAt: iso(found.session.expiresAt),
    });
  });

  /**
   * Login.
   *
   * The audit row is written for a SUCCESS only. A failed attempt is logged (below) but
   * not audited, because `audit_events.actor_id` would have to name a user we have
   * deliberately not identified — on a wrong password we do not know, and must not
   * confirm, whether the username exists.
   */
  app.post("/admin/v1/session", async (request, reply) => {
    const body = readBody(request.body, ["username", "password"]);
    // Bounded before any Argon2 work: `MAX_PASSWORD_LENGTH` is 1024 and hashing an
    // unbounded string is a cheap way to burn CPU on this unauthenticated route.
    const username = readString(body, "username", { min: 1, max: 64 });
    const password = readString(body, "password", { min: 1, max: 1024 });

    const existing = await deps.users.findByUsername(username);

    /**
     * A non-admin is passed to `attemptLogin` as `null`.
     *
     * This is what keeps the timing identical AND the outcome indistinguishable: the
     * function still performs exactly one Argon2 verify (against the decoy), and returns
     * `invalid_credentials` — the same result a wrong password gives. Checking the role
     * after a successful verify would answer faster for a customer with the wrong
     * password than for one with the right password, which is the oracle this avoids.
     */
    const candidate: UserRecord | null =
      existing !== null && existing.role === "admin"
        ? {
            id: existing.id,
            username: existing.username,
            passwordHash: existing.passwordHash,
            role: existing.role,
            status: existing.status,
          }
        : null;

    const outcome = await attemptLogin({ username, password, user: candidate });

    if (!outcome.ok) {
      // Logged before throwing so a credential-stuffing run is visible in the journal.
      // `usernameKnown` distinguishes a probe from a real account under attack; neither
      // that flag nor the reason reaches the response.
      request.bosandaLog.warn(
        { reason: outcome.reason, usernameKnown: existing !== null },
        "admin login failed",
      );
    }
    // Throws the single 401 for every failure mode; returns the user otherwise.
    const user = assertLoginSucceeded(outcome);

    const started = startSession(user.id, deps.keyring, deps.clock);
    const at = deps.clock.now();

    await deps.transact(async (tx) => {
      /**
       * `lastUsedAt` is spread explicitly rather than relied on from `started.record`.
       *
       * `SessionRecord.lastUsedAt` is declared optional (`Date | null | undefined`) because
       * a row read back from the database may not have been touched yet, while
       * `InsertSessionInput.lastUsedAt` is a required `Date` — the sliding idle window in
       * `evaluateSession` reads it, so a session inserted without one would be measured
       * from `createdAt` instead. `startSession` always sets it to its own `now`, and
       * falling back to `at` keeps the type honest without changing the value.
       */
      await tx.sessions.insert({
        id: ulid(),
        ...started.record,
        lastUsedAt: started.record.lastUsedAt ?? at,
      });
      await writeAudit(
        tx,
        { id: user.id, username: user.username },
        {
          action: ADMIN_ACTIONS.sessionCreated,
          targetType: "user",
          targetId: user.id,
          reason: "operator signed in",
        },
        at,
      );
    });

    request.bosandaLog.info({ userId: user.id }, "admin login succeeded");

    return (
      reply
        .status(200)
        .header(
          "set-cookie",
          sessionSetCookie(deps, started.token.plaintext, started.record.expiresAt),
        )
        /**
         * `token` is the plaintext session token. See the module header: this reaches a
         * Next.js server action only, which moves it into an HttpOnly cookie. It is NOT
         * logged anywhere — `started.token.plaintext` appears in this expression and
         * nowhere else in the process.
         */
        .send({ token: started.token.plaintext, expiresAt: iso(started.record.expiresAt) })
    );
  });

  /**
   * Revoke — the logout button.
   *
   * Requires a valid admin session: revoking is a state change, and an unauthenticated
   * caller who could revoke by presenting an arbitrary token could log an operator out
   * by guessing. The cookie is cleared regardless of whether the row was still active,
   * so a double-click does not produce an error the operator has to interpret.
   */
  app.post("/admin/v1/session/revoke", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const token = readSessionToken(request);
    const at = deps.clock.now();

    if (token !== null) {
      await deps.sessions.revokeByTokenHash(sessionDigest(token, deps.keyring), at);
    }

    await deps.transact((tx) =>
      writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.sessionRevoked,
          targetType: "session",
          targetId: actor.sessionId,
          reason: "operator signed out",
        },
        at,
      ),
    );

    return reply.status(200).header("set-cookie", clearedSetCookie(deps)).send(ok("Signed out."));
  });
}
