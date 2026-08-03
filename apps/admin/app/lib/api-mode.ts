/**
 * THE single switch between fixtures and a real backend.
 *
 * The gateway may not be running while the dashboard is being reviewed, so the
 * dashboard ships with fixtures ON by default in development and OFF in
 * production. The production refusal is the important boundary: fabricated
 * operator data must never be shown on a live host.
 *
 * Fixtures are refused in production even if someone sets the flag, because a
 * production admin panel showing fabricated revenue and fake account health is
 * an incident, not a convenience.
 */

const flag = process.env["ADMIN_USE_FIXTURES"];
const isProduction = process.env.NODE_ENV === "production";

/**
 * True when pages render from `./fixtures.ts` instead of calling the admin API.
 *
 * Defaults to on outside production. Set `ADMIN_USE_FIXTURES=false` to point a
 * local dashboard at a real `ADMIN_API_BASE_URL`.
 */
export const USE_FIXTURES: boolean = isProduction ? false : flag !== "false";

/**
 * Base URL of the admin API. Server-side only — this is never sent to the
 * browser, and the browser never calls the API directly (§16: the session
 * cookie is HttpOnly, so authenticated reads happen in server components).
 */
export const API_BASE_URL: string = process.env["ADMIN_API_BASE_URL"] ?? "http://127.0.0.1:4000";

/** Rendered in the header so an operator can never mistake one for the other. */
export const DATA_SOURCE_LABEL: string = USE_FIXTURES ? "FIXTURE DATA" : "LIVE";
