/**
 * The dependency container's HTTP-lifecycle bindings.
 *
 * Deliberately thin, and thin in a specific way: the pool, the keyring, the scheduler and
 * everything else are built ONCE in `dependencies.ts`, and this plugin only attaches that
 * container to the Fastify lifecycle. There is no second pool here and there must never be
 * one — `postgres`' connection limit is sized for a single pool per process, and a second
 * would double the gateway's real connection count while making `deps.close()` a partial
 * drain that leaves sockets open past shutdown.
 *
 * Three bindings, each the kind of thing only a plugin can do:
 *
 *   1. `app.deps` — the container, reachable from any route or hook that has the instance.
 *   2. `onReady` — a startup check that fails the boot loudly rather than serving errors.
 *   3. `onClose` — the graceful release, so `deps.close()` runs on every shutdown path.
 *
 * §16 requires the gateway to boot with the Kiro adapter disabled and answer a sanitized
 * 503. It does NOT extend that tolerance to the database: with no database there is no key
 * to authenticate, no model catalogue, and no ledger to settle against, so every request
 * would 500 and `/health` would be the only honest endpoint. A process that cannot serve
 * anything should fail to start rather than sit in the rotation returning errors, which is
 * why the check below throws.
 */

import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import type { GatewayDeps } from "../dependencies.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * The one dependency container for the process.
     *
     * Present so a route registered elsewhere can reach the pool, clock, and metrics without
     * `deps` being threaded through its own parameters. The existing routes DO take `deps`
     * explicitly — which is better for testing, since a test can pass fakes without building
     * an instance — so this is the escape hatch for a hook or a plugin that only has `app`,
     * not the primary path.
     */
    deps: GatewayDeps;
  }
}

export function registerDatabase(app: FastifyInstance, deps: GatewayDeps): void {
  /**
   * A single object, decorated once at boot.
   *
   * `decorate` (instance) rather than `decorateRequest`: the container is shared and
   * immutable for the process lifetime, so there is nothing per-request about it. Fastify
   * REJECTS a reference-type value on `decorateRequest` for exactly this reason — that API
   * would share one object across every request while pretending otherwise. On the instance,
   * shared is the correct and intended semantic.
   */
  app.decorate("deps", deps);

  app.addHook("onReady", async () => {
    try {
      await deps.checkDatabase();
    } catch (error) {
      const bosanda = BosandaError.from(error);
      /**
       * Logged with internal detail, then rethrown with a fresh error whose detail is a fixed
       * string. The original may carry a connection string — `postgres` puts the host, port,
       * and user in its errors — and this rejection ends up in the systemd journal, which is
       * less protected than the application log. §16: `internalDetail` is for the operator
       * log, and the journal is not that log.
       */
      deps.logger.error(
        { code: bosanda.code, detail: bosanda.internalDetail },
        "database unreachable at startup",
      );
      throw new BosandaError("internal_error", {
        internalDetail: "database readiness check failed at startup",
      });
    }

    deps.logger.info(
      {
        adapterEnabled: deps.env.KIRO_DIRECT_ENABLED,
        toolUseEnabled: deps.env.KIRO_TOOL_USE_ENABLED,
      },
      "gateway ready",
    );
  });

  /**
   * The graceful release (§19 phase 4).
   *
   * `onClose` fires after Fastify has stopped the listener and awaited in-flight requests, so
   * by the time this runs every hijacked SSE stream has finished writing and every settlement
   * transaction has been issued. Closing the pool any earlier would abort a settlement
   * mid-commit and lose the ledger row for a turn the customer already received — tokens
   * spent upstream with nothing recorded, which is both a revenue loss and a hole in the
   * audit trail.
   *
   * ── WHY THIS IS SAFE ALONGSIDE `main.ts` ──────────────────────────────────
   * `main.ts` also calls `deps.close()` after `app.close()`, so on a SIGTERM drain the call
   * happens twice. That is intentional and correct, because the two paths cover different
   * failures and `close` is documented idempotent in `dependencies.ts` ("Released on drain.
   * Idempotent."):
   *
   *   - `main.ts` alone would leak the pool for any shutdown that does not go through its
   *     signal handler — a test calling `app.close()`, or a future embedder.
   *   - this hook alone would skip the release when `app.close()` itself throws, which is
   *     precisely the case `main.ts` catches and then continues past in order to settle.
   *
   * The `released` flag is not the idempotency guarantee — `deps.close()` owns that — it just
   * keeps the log honest, so the journal shows one "dependencies released" line per process
   * instead of implying two distinct releases happened.
   */
  let released = false;
  app.addHook("onClose", async () => {
    if (released) return;
    released = true;

    try {
      await deps.close();
      deps.logger.info("dependencies released");
    } catch (error) {
      /**
       * Swallowed after logging, deliberately. A throw from `onClose` makes `app.close()`
       * reject, and `main.ts` treats that as "the HTTP layer misbehaved, continue to settle".
       * Letting a pool-teardown failure propagate there would produce a misleading error at a
       * point where the only remaining work is exiting, and could mask the real reason for a
       * failed shutdown. `BosandaError.from` normalizes the shape; only the sanitized detail
       * is logged.
       */
      const bosanda = BosandaError.from(error);
      deps.logger.error(
        { code: bosanda.code, detail: bosanda.internalDetail },
        "failed to release dependencies during shutdown",
      );
    }
  });
}
