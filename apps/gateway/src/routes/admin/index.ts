/**
 * The admin surface (PLAN.md §15 operator console, §16 privacy, §17 threat model).
 *
 * ── EVERY ROUTE AUTHENTICATES, INDIVIDUALLY ───────────────────────────────
 * There is no prefix-scoped `onRequest` hook here. Each handler calls `requireAdmin` as
 * its first statement — see `session.ts` for why: a hook that authenticates by URL prefix
 * silently covers whatever is registered under it later, and silently stops covering a
 * route that moves. An explicit call is visible in the handler and a missing one is
 * visible in review. `GET /admin/v1/health` is included; the unauthenticated probe is
 * `/health`, registered elsewhere.
 *
 * ── WHAT NEVER CROSSES THIS BOUNDARY ──────────────────────────────────────
 * No plaintext API key, no key ciphertext, no lookup digest, no provider credential in any
 * form, no prompt or response text. The client's zod schemas are `.strict()`, so an extra
 * field is a hard parse failure rather than a silent leak — but the routes do not rely on
 * that: nothing that could carry a secret is ever put into a response body, an error
 * message, an audit row, or a log line.
 */

import type { FastifyInstance } from "fastify";
import type { AdminDeps } from "./deps.js";
import { registerAccountRoutes } from "./routes-accounts.js";
import { registerCatalogRoutes } from "./routes-catalog.js";
import { registerOrderRoutes } from "./routes-orders.js";
import { registerCodexProviderRoutes } from "./routes-codex.js";
import { registerProviderRoutes } from "./routes-providers.js";
import { registerSessionRoutes } from "./routes-session.js";
import { registerStatusRoutes } from "./routes-status.js";

export type {
  AdminApiKeyFilter,
  AdminApiKeyQuery,
  AdminApiKeyRow,
  AdminDeps,
  AdminOrderQuery,
  AdminPaymentEventRow,
  AdminReconciliationQuery,
  AdminReconciliationSnapshot,
  AdminTrafficBucket,
  AdminTrafficQuery,
  AdminTrafficWindow,
  AdminTx,
  AdminUserAggregates,
  AdminUserQuery,
} from "./deps.js";

export { ADMIN_SESSION_COOKIE, ADMIN_SESSION_COOKIE_DEV } from "./session.js";

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  registerSessionRoutes(app, deps);
  registerStatusRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerCodexProviderRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerAccountRoutes(app, deps);
}
