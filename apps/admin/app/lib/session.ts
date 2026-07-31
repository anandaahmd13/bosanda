/**
 * Admin session + CSRF (PLAN.md §12, §16 "Admin / user isolation").
 *
 * SERVER-ONLY. Nothing here may be imported into a client component.
 *
 * Cookie isolation: the admin session cookie name and scope are deliberately
 * DIFFERENT from the storefront's. docs/security.md notes that separate origins
 * already give separate cookie scopes; a distinct name is defence in depth so a
 * customer cookie can never be mistaken for an operator cookie even if the two
 * hosts are ever collapsed behind one origin by mistake.
 *
 * The cookie is HttpOnly, so client JS cannot read it. Authenticated reads
 * happen in server components and route handlers, which forward it explicitly.
 * No token is ever placed in localStorage.
 */

import { cookies } from "next/headers";
import { adminSession, type AdminSession } from "./schemas";
import { USE_FIXTURES } from "./api-mode";
import { fixtureSession } from "./fixtures";
import { CSRF_FIELD } from "./csrf-field";

// Re-exported so server code has one import for the whole CSRF story, while the
// name itself lives in a client-safe module (see csrf-field.ts).
export { CSRF_FIELD };

/**
 * `__Host-` prefix: the browser refuses to accept this cookie unless it is
 * Secure, has Path=/, and has NO Domain attribute — which pins it to exactly
 * admin.bosanda.dev and makes a subdomain-wide overwrite impossible.
 */
export const ADMIN_SESSION_COOKIE = "__Host-bosanda_admin_session";
export const ADMIN_CSRF_COOKIE = "__Host-bosanda_admin_csrf";

/**
 * `__Host-` requires Secure, which requires HTTPS. Local development is plain
 * HTTP on 127.0.0.1, so the prefix is dropped there — the ONLY difference
 * between the two environments.
 */
const isProduction = process.env.NODE_ENV === "production";

export const sessionCookieName = isProduction ? ADMIN_SESSION_COOKIE : "bosanda_admin_session_dev";
export const csrfCookieName = isProduction ? ADMIN_CSRF_COOKIE : "bosanda_admin_csrf_dev";

export const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "strict",
  path: "/",
} as const;

/** The CSRF cookie must be readable by the form renderer, not by scripts. */
export const csrfCookieOptions = { ...cookieOptions, httpOnly: true } as const;

/**
 * Reads the current admin session, or null.
 *
 * In fixture mode a session is synthesized so the dashboard is browsable
 * locally without an auth backend, but ONLY when the dev login cookie is
 * present — otherwise /login could never be exercised.
 */
export async function getAdminSession(): Promise<AdminSession | null> {
  const jar = await cookies();
  const raw = jar.get(sessionCookieName)?.value;
  if (raw === undefined || raw.length === 0) return null;

  if (USE_FIXTURES) {
    return adminSession.parse(fixtureSession);
  }

  // Live mode: the opaque cookie is validated by the auth backend, which
  // returns the session or 401. Implemented in ./api.ts to keep the single
  // network boundary; this indirection avoids a circular import.
  const { fetchSession } = await import("./api");
  return fetchSession(raw);
}

/**
 * Generates a CSRF token with a CSPRNG.
 *
 * Double-submit: the same value goes into an HttpOnly cookie and into a hidden
 * form field. A cross-site attacker can cause a POST but cannot read the cookie
 * to populate the field, so a mismatch means forgery.
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads the CSRF cookie, minting nothing — callers decide when to set it. */
export async function readCsrfCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(csrfCookieName)?.value ?? null;
}

/**
 * Returns the CSRF token for embedding in a form, creating one if absent.
 *
 * Safe to call from a server component: `cookies().set` is permitted during
 * render in Next 16 only inside a Server Action or route handler, so when the
 * cookie is missing during a plain render we fall back to a token that the
 * verifying action will reject — forcing a visible retry rather than a silent
 * bypass. Layout mints the cookie on first paint, so this is rare.
 */
export async function getOrCreateCsrfToken(): Promise<string> {
  const existing = await readCsrfCookie();
  if (existing !== null && existing.length > 0) return existing;
  return generateCsrfToken();
}

/** Timing-safe comparison; avoids leaking the token prefix via early exit. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return diff === 0;
}

export class CsrfError extends Error {
  constructor() {
    super("This form expired or could not be verified. Reload the page and try again.");
    this.name = "CsrfError";
  }
}

/**
 * Verifies the double-submit CSRF token. Call this FIRST in every action that
 * mutates state. Throws `CsrfError` on mismatch.
 */
export async function assertCsrf(formData: FormData): Promise<void> {
  const submitted = formData.get(CSRF_FIELD);
  const cookieToken = await readCsrfCookie();
  if (
    typeof submitted !== "string" ||
    cookieToken === null ||
    submitted.length === 0 ||
    !timingSafeEqual(submitted, cookieToken)
  ) {
    throw new CsrfError();
  }
}

/**
 * Asserts an authenticated admin on every route (§15/§16).
 *
 * Returns the session or null. Callers render the neutral unauthorized state on
 * null — deliberately WITHOUT redirecting to a URL that discloses what exists,
 * and without distinguishing "not logged in" from "logged in but not admin".
 */
export async function requireAdmin(): Promise<AdminSession | null> {
  const session = await getAdminSession();
  if (session === null) return null;
  if (session.role !== "admin") return null;
  if (Date.parse(session.expiresAt) <= Date.now()) return null;
  return session;
}
