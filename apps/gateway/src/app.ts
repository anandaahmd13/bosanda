/**
 * Builds the Fastify instance.
 *
 * Split from `main.ts` so the whole HTTP surface is constructible in a test with fake
 * dependencies and no listening socket: `app.inject()` exercises routing, hooks, the
 * error handler, and the body limit without a port. That is the only way the auth and
 * limit tests can assert on real HTTP semantics while remaining runnable on a machine
 * with no PostgreSQL.
 *
 * Registration order is load-bearing and documented at each step.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { LIMITS } from "@bosanda/protocol";
import { requestId } from "@bosanda/shared";
import type { GatewayDeps } from "./dependencies.js";
import { registerDatabase } from "./plugins/database.js";
import { registerObservability } from "./plugins/observability.js";
import { registerSecurity } from "./plugins/security.js";
import { registerAnthropicRoutes } from "./routes/anthropic.js";
import { registerHealthRoutes, type ReadinessState } from "./routes/health.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerOpenAIRoutes } from "./routes/openai.js";
import { registerAdminRoutes, type AdminDeps } from "./routes/admin/index.js";
import { registerCustomerRoutes } from "./routes/customer.js";
import { registerCustomerSessionRoutes } from "./routes/customer-session.js";
import type { CustomerDeps } from "./customer-dependencies.js";

export type AppOptions = {
  deps: GatewayDeps;
  readiness: ReadinessState;
  /** Operator console dependencies. */
  admin?: AdminDeps;
  /** Customer session, dashboard, key, and checkout dependencies. */
  customer?: CustomerDeps;
};

export function buildApp({ deps, readiness, admin, customer }: AppOptions): FastifyInstance {
  const app = Fastify({
    /**
     * Must equal nginx's `client_max_body_size` (§18). If the gateway's limit were the
     * larger of the two, nginx would reject an oversized body with its own HTML error
     * page and the client would get a non-JSON response an SDK cannot parse. Equal
     * values mean the rejection always comes from here, in the right envelope.
     */
    bodyLimit: LIMITS.maxBodyBytes,

    /**
     * Fastify's own logger is off: `deps.logger` is the configured pino instance with
     * the redaction paths, and the observability hook replaces `request.log` with a
     * child of it. Leaving this true would create a SECOND logger with no redaction
     * configured, and the first `request.log.info({ body })` anywhere in the codebase
     * would write a prompt to disk.
     */
    logger: false,

    /**
     * Trust the edge's forwarded headers. nginx is the only ingress, so
     * `X-Forwarded-For` is set by us and `request.ip` is the real client. Without this,
     * every request appears to come from 127.0.0.1 and per-IP diagnosis is impossible.
     */
    trustProxy: true,

    /**
     * Generate our own request ids rather than trusting the inbound `request-id`
     * header, which a client controls: accepting it would let a caller collide ids
     * deliberately and make one customer's logs unreadable, or forge the id another
     * customer would quote in a support request.
     *
     * `requestId()` is the same generator the usage rows use, so the id in a log line,
     * the id in the ledger, and the id a customer reads off an error envelope are all
     * one value — which is what makes a billing dispute answerable.
     */
    genReqId: () => requestId(),

    /** Keep-alive above nginx's 60s so the gateway is never the side that hangs up. */
    keepAliveTimeout: 65_000,
  });

  // Observability first: its `onRequest` hook stamps `startedAt`, which every later
  // hook and the duration metric read. Registered before security so that a request
  // rejected by the error handler still gets counted.
  registerObservability(app, deps);

  // Security second: it installs the error handler and 404 handler, which must be in
  // place before any route can throw.
  registerSecurity(app, deps);

  registerDatabase(app, deps);

  // Health before the metered surfaces, so a readiness probe cannot be blocked behind
  // route registration for endpoints it does not use.
  registerHealthRoutes(app, deps, readiness);
  registerModelRoutes(app, deps);
  registerOpenAIRoutes(app, deps);
  registerAnthropicRoutes(app, deps);

  // Customer routes use browser sessions and are optional for deployments that expose only
  // the inference process. Registration is explicit so an app without customer ports 404s.
  if (customer !== undefined) {
    registerCustomerSessionRoutes(app, customer);
    registerCustomerRoutes(app, customer);
  }

  // Admin last: it shares nothing with the metered surfaces and every one of its handlers
  // authenticates individually, so its position cannot affect them either way.
  if (admin !== undefined) registerAdminRoutes(app, admin);

  return app;
}
