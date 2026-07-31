/**
 * Cookie construction (PLAN.md §12: "Login uses secure, HTTP-only, same-site
 * cookies", "CSRF protection is required for mutations").
 *
 * Serialization lives here rather than in each app so the security attributes
 * are defined once. A route that forgets `HttpOnly` is a cross-site scripting
 * bug that hands over the session; making it impossible to express is cheaper
 * than reviewing for it.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "bosanda_session";
export const CSRF_COOKIE = "bosanda_csrf";
/** Form field / header carrying the CSRF token for the double-submit check. */
export const CSRF_FIELD = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

export type CookieAttributes = {
  name: string;
  value: string;
  maxAgeSeconds: number;
  /** False only for local http development. */
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax" | "Strict" | "None";
  path: string;
  domain?: string | undefined;
};

/**
 * `SameSite=Lax`, not `Strict`: the payment provider redirects the user back to
 * the return URL as a top-level GET, and `Strict` would withhold the cookie on
 * that navigation, landing a paying customer on a logged-out page. `Lax` still
 * withholds it on cross-site POST, which is the case CSRF cares about.
 */
export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  options: { secure?: boolean; domain?: string } = {},
): CookieAttributes {
  return {
    name: SESSION_COOKIE,
    value: token,
    maxAgeSeconds,
    secure: options.secure ?? true,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    domain: options.domain,
  };
}

/**
 * The CSRF cookie is intentionally NOT HttpOnly: the double-submit pattern
 * requires client-side code to read it and echo it back in a form field, and
 * the same-origin policy is what stops another site from reading it. It carries
 * no authority on its own — only a value that must match the submitted one.
 */
export function csrfCookie(
  token: string,
  maxAgeSeconds: number,
  options: { secure?: boolean; domain?: string } = {},
): CookieAttributes {
  return {
    name: CSRF_COOKIE,
    value: token,
    maxAgeSeconds,
    secure: options.secure ?? true,
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
    domain: options.domain,
  };
}

/** A cookie that clears its counterpart. Same attributes, empty value, age 0. */
export function clearedCookie(
  name: string,
  options: { secure?: boolean; domain?: string } = {},
): CookieAttributes {
  return {
    name,
    value: "",
    maxAgeSeconds: 0,
    secure: options.secure ?? true,
    // Cleared as HttpOnly regardless: the browser only needs name and path to
    // match, and this cannot be used to downgrade a live cookie.
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    domain: options.domain,
  };
}

export function serializeCookie(cookie: CookieAttributes): string {
  const parts = [`${cookie.name}=${encodeURIComponent(cookie.value)}`];
  parts.push(`Path=${cookie.path}`);
  parts.push(`Max-Age=${Math.max(0, Math.floor(cookie.maxAgeSeconds))}`);
  if (cookie.maxAgeSeconds <= 0) {
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (cookie.domain !== undefined) parts.push(`Domain=${cookie.domain}`);
  parts.push(`SameSite=${cookie.sameSite}`);
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Parse a `Cookie` request header into a map. */
export function parseCookies(header: string | null | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (header === null || header === undefined || header === "") return jar;

  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index <= 0) continue;
    const name = segment.slice(0, index).trim();
    const rawValue = segment.slice(index + 1).trim();
    if (name === "") continue;
    // A repeated name keeps the first: a later duplicate is how cookie-shadowing
    // attacks try to override the real value.
    if (jar.has(name)) continue;
    try {
      jar.set(name, decodeURIComponent(rawValue));
    } catch {
      jar.set(name, rawValue);
    }
  }

  return jar;
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Double-submit comparison. Constant-time, and rejects empty values so a
 * request with neither cookie nor field does not pass by both being "".
 */
export function csrfTokensMatch(
  cookieToken: string | null | undefined,
  submittedToken: string | null | undefined,
): boolean {
  if (
    cookieToken === null ||
    cookieToken === undefined ||
    submittedToken === null ||
    submittedToken === undefined ||
    cookieToken === "" ||
    submittedToken === ""
  ) {
    return false;
  }

  const left = Buffer.from(cookieToken, "utf8");
  const right = Buffer.from(submittedToken, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
