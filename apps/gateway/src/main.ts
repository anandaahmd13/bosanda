/**
 * Gateway entrypoint.
 *
 * Nothing here is testable by `app.inject()`, and that is the point: this file holds
 * exactly the concerns that need a real process — signal handling, the listening
 * socket, and process-level failure. Everything else lives in `app.ts` so the suite can
 * reach it without a port.
 *
 * ── THE DRAIN (bosanda-gateway.service, §18) ──────────────────────────────
 * The unit sets `TimeoutStopSec=660` and expects four phases, in this order:
 *
 *   1. SIGTERM arrives.
 *   2. Fail the health check and stop accepting new connections, so `deploy.sh`
 *      sees the instance leave rotation.
 *   3. Let in-flight SSE streams RUN TO COMPLETION. A turn can legitimately take
 *      minutes. Cutting one would bill a customer's quota for a truncated answer
 *      and leave the client with no way to recover it (§10).
 *   4. Settle the ledger, close the pool, exit 0.
 *
 * Phase 2 before phase 3 is the whole design. Reversing them — closing the server
 * first and then flipping health — leaves a window where the load balancer still
 * routes to a socket that is already refusing connections.
 */

import { loadEnv } from "@bosanda/config";
import { createDecoyHash } from "@bosanda/auth";
import { createLogger } from "@bosanda/observability";
import { createClientFromEnv } from "@bosanda/database";
import { buildApp } from "./app.js";
import { createAdminDependencies } from "./admin-dependencies.js";
import { createCustomerDependencies } from "./customer-dependencies.js";
import {
  CODEX_PROVIDER_TYPE,
  createDependencies,
  PROVIDER_TYPE,
  type GatewayProviderType,
} from "./dependencies.js";
import { createReadinessState } from "./routes/health.js";

/**
 * Milliseconds between flipping the health check and closing the listener.
 *
 * Not cosmetic. `scripts/deploy.sh` and any future load balancer poll `/health` on an
 * interval; closing the listener in the same tick as the flip means a probe in flight
 * gets a connection error instead of the 503 that tells it to stop routing here. One
 * second is longer than the probe interval, which is what makes the transition
 * observable rather than abrupt.
 */
const DRAIN_GRACE_MS = 1_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: "gateway", level: env.LOG_LEVEL });

  /**
   * ONE pool, shared by both surfaces.
   *
   * Created here rather than letting `createDependencies` create its own so the admin
   * surface can be handed the same `Sql`. Two pools in one process would double this
   * instance's share of `max_connections` for no benefit.
   */
  const sql = createClientFromEnv(env);

  const deps = createDependencies({ env, logger, sql });
  const readiness = createReadinessState();
  const customer = createCustomerDependencies({
    env,
    sql,
    logger,
    decoyHash: await createDecoyHash(),
  });

  /**
   * The admin surface, mounted in the same process as the metered one.
   *
   * §17 treats the operator console as the highest-value target, so `buildApp` makes the
   * admin routes optional and a future deployment can run a gateway with them absent
   * entirely. They are mounted here because there is one gateway unit today; nginx is what
   * restricts who can reach `/admin/v1/*`, and every handler authenticates individually
   * regardless (see `routes/admin/session.ts`).
   *
   * `validateAccount` goes through the adapter, which owns the credential: the probe
   * returns health, and nothing decrypted ever reaches an admin route.
   */
  const admin = createAdminDependencies({
    env,
    sql,
    logger,
    validateAccount: async (accountId) => {
      const account = await deps.providerAccounts.findById(accountId);
      const providerType: GatewayProviderType =
        account?.providerType === CODEX_PROVIDER_TYPE ? CODEX_PROVIDER_TYPE : PROVIDER_TYPE;
      await deps.adapters.get(providerType).validateAccount(accountId);
    },
  });

  const app = buildApp({ deps, readiness, admin, customer });

  /**
   * Bound to `GATEWAY_HOST`, which defaults to 127.0.0.1.
   *
   * The gateway must NOT be reachable from the internet directly (§16): nginx
   * terminates TLS, enforces `client_max_body_size`, and denies `/metrics`. A gateway
   * listening on 0.0.0.0 bypasses all three, which is why the default is loopback and
   * changing it is a deliberate act recorded in the env file.
   */
  await app.listen({ host: env.GATEWAY_HOST, port: env.GATEWAY_PORT });
  logger.info(
    {
      host: env.GATEWAY_HOST,
      port: env.GATEWAY_PORT,
      adapterEnabled: env.KIRO_DIRECT_ENABLED,
    },
    "gateway listening",
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    /**
     * A second signal is ignored rather than escalating.
     *
     * An operator running `systemctl restart` twice, or an impatient Ctrl-C, must not
     * abort a drain that is legitimately waiting on a long turn — that is precisely the
     * truncated-answer-you-were-still-billed-for outcome the drain exists to prevent.
     * systemd's own `TimeoutStopSec` is the escalation path, and it ends in SIGKILL.
     */
    if (shuttingDown) {
      logger.warn({ signal }, "shutdown already in progress; ignoring signal");
      return;
    }
    shuttingDown = true;

    // Phase 2a: leave rotation. `/health` now answers 503 draining.
    readiness.accepting = false;
    logger.info({ signal }, "draining: health check now failing");

    await new Promise((resolve) => setTimeout(resolve, DRAIN_GRACE_MS));

    try {
      /**
       * Phase 2b + 3, together: `app.close()` closes the listener and then waits for
       * in-flight requests. Fastify's close does NOT abort open sockets, which is
       * exactly the behaviour phase 3 requires — a hijacked SSE reply keeps writing
       * until the route ends it.
       */
      logger.info("draining: waiting for in-flight requests");
      await app.close();
      logger.info("draining: all requests complete");
    } catch (error) {
      /**
       * A close failure is logged and then deliberately does not stop the shutdown:
       * phase 4 still has to run. Skipping settlement because the HTTP layer misbehaved
       * would leave tokens consumed upstream with no ledger row — a silent revenue loss
       * and a broken audit trail.
       */
      logger.error({ err: error }, "error while closing HTTP server; continuing to settle");
    }

    try {
      // Phase 4: settle and release. `deps.close()` drains the pool, which is what
      // flushes any settlement transaction still committing.
      await deps.close();
      logger.info("shutdown complete");
    } catch (error) {
      logger.error({ err: error }, "error while closing dependencies");
      process.exitCode = 1;
      return;
    }

    /**
     * Exit 0 so systemd treats a drain as success. The unit lists
     * `SuccessExitStatus=0 SIGTERM`, but `Restart=always` would still bring the process
     * back if we exited non-zero on a clean stop, turning every deploy into a flap.
     */
    process.exitCode = 0;
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  /**
   * A rejection or exception that reached the top is a bug, not a condition to recover
   * from: process state is unknown and continuing risks serving wrong answers or
   * writing wrong ledger rows. Log it with a real stack, then let systemd restart a
   * clean process — `RestartSec=5s` plus `StartLimitBurst=5` means a permanent fault
   * stops rather than hot-loops.
   *
   * Streaming failures never arrive here; they are handled in-band by the writers.
   */
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection; exiting");
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "uncaught exception; exiting");
    process.exit(1);
  });
}

/**
 * A startup failure must exit non-zero and print something an operator can act on.
 *
 * `console.error` rather than the logger: the most likely startup failures are a
 * missing env file and an invalid `ConfigError`, and both happen before a logger
 * exists. This is the one place in `src/**` where the lint rule permits console, and
 * the reason is that a silent exit here looks identical to a successful start in the
 * journal.
 */
main().catch((error: unknown) => {
  console.error("gateway failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
