/**
 * Session and CSRF plumbing. SERVER ONLY — never import from a "use client" file.
 *
 * The session cookie is HttpOnly (§12), so it is invisible to client JS by
 * design. Consequence for the whole app: every authenticated read happens in a
 * server component or route handler, which reads the cookie here and forwards it
 * to the gateway. Nothing token-shaped is ever handed to the browser, and
 * nothing is ever put in localStorage.
 */

import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CSRF_COOKIE, CSRF_FIELD, SESSION_COOKIE } from "./env";

/** Raw session cookie value, or null when signed out. Must never be logged. */
export async function readSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

export async function isAuthenticated(): Promise<boolean> {
  return (await readSessionCookie()) !== null;
}

/**
 * Cookie header to forward to the gateway on an authenticated read.
 *
 * Only the session cookie is forwarded — not the whole jar. The CSRF cookie is a
 * browser-side double-submit artifact and the gateway has no use for it, so
 * there is no reason to widen what crosses the process boundary.
 */
export function sessionCookieHeader(sessionValue: string): string {
  return `${SESSION_COOKIE}=${sessionValue}`;
}

/**
 * Gate a server component. Redirects to /login with a `next` hint rather than
 * rendering a half-empty dashboard.
 */
export async function requireSessionCookie(returnTo: string): Promise<string> {
  const session = await readSessionCookie();
  if (session === null) {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }
  return session;
}

/**
 * CSRF token for this browser, as minted by middleware.
 *
 * Double-submit: middleware sets a non-HttpOnly random cookie, every mutating
 * form embeds the same value in a hidden field, and `assertCsrf` compares them.
 * The cookie is readable by JS on purpose — that is what makes the pattern work
 * — and it is not a credential: possessing it proves nothing without the
 * HttpOnly session cookie, which an attacker's origin cannot read or set.
 *
 * Returns null only if middleware did not run, in which case forms render
 * disabled rather than posting something that will be rejected.
 */
export async function readCsrfToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(CSRF_COOKIE)?.value ?? null;
}

/**
 * Verify the double-submit pair. Call FIRST in every server action that mutates
 * state, before touching form values (§12: "CSRF protection is required for
 * mutations"). There are no GET mutations anywhere in this app.
 */
export async function assertCsrf(form: FormData): Promise<boolean> {
  const cookieToken = await readCsrfToken();
  const formValue = form.get(CSRF_FIELD);

  if (cookieToken === null || typeof formValue !== "string") return false;

  const a = Buffer.from(cookieToken, "utf8");
  const b = Buffer.from(formValue, "utf8");
  // timingSafeEqual throws on a length mismatch, so compare lengths first. A
  // length difference is not secret: it is visible in the request either way.
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
