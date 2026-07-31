/**
 * Web-app runtime configuration.
 *
 * This is deliberately NOT `@bosanda/config`. That package validates the full
 * server env (database URL, keyring secrets, provider settings) and importing it
 * here would pull secret material into a Next process that has no business
 * holding it (§16 least privilege — see also the comment in
 * deploy/systemd/bosanda-web.service explaining why web.env is a separate file).
 *
 * The storefront needs exactly three things: where the gateway is, whether to
 * serve fixtures, and whether it is running over TLS.
 */

/**
 * Dev-mode fixture switch. THE single flag that decides whether every function
 * in `api.ts` talks to a real gateway or returns canned data.
 *
 * Fixtures are allowed only when explicitly opted in AND not in production, so
 * a missing/typo'd env var in production can never silently serve fake quota.
 * `next build` runs with NODE_ENV=production, which is why prerendered pages
 * must not depend on fixtures being on.
 */
export const USE_FIXTURES: boolean =
  process.env["BOSANDA_WEB_FIXTURES"] === "1" && process.env.NODE_ENV !== "production";

/**
 * Gateway base URL used for server-side reads. Server-to-server, so it should
 * point at the loopback gateway (127.0.0.1:4000) in production rather than out
 * through nginx and back in.
 */
export const GATEWAY_INTERNAL_URL: string =
  process.env["GATEWAY_INTERNAL_URL"] ?? "http://127.0.0.1:4000";

/** Public API origin, shown in the docs page. Never used to make requests. */
export const PUBLIC_API_URL: string = process.env["PUBLIC_API_URL"] ?? "https://api.bosanda.dev";

/** Public web origin, used for absolute return URLs handed to the payment provider. */
export const PUBLIC_WEB_URL: string = process.env["PUBLIC_WEB_URL"] ?? "https://bosanda.dev";

/** The documented support channel for manual account recovery (§12). */
export const SUPPORT_CHANNEL: string =
  process.env["BOSANDA_SUPPORT_CHANNEL"] ?? "the support contact published on bosanda.dev";

/** Session cookie name. HttpOnly — never readable from client JS (§12). */
export const SESSION_COOKIE = "bosanda_session";

/** Double-submit CSRF cookie name (§12: "CSRF protection is required for mutations"). */
export const CSRF_COOKIE = "bosanda_csrf";

// Hidden form field carrying the CSRF token. Defined in its own module so a
// client component can import the name without pulling this server-only file in;
// re-exported here so server code has a single import site.
export { CSRF_FIELD } from "./csrf-field";

/** True when cookies should carry the Secure attribute. */
export const COOKIE_SECURE: boolean = PUBLIC_WEB_URL.startsWith("https://");
