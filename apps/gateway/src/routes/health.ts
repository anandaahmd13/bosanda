/**
 * `GET /health` and `GET /metrics` (PLAN.md §17, §19 deployment).
 *
 * ── /health IS A DRAIN SIGNAL, NOT A PING ─────────────────────────────────
 * §19's drain sequence is: SIGTERM → stop accepting new connections AND fail the
 * health check → let in-flight SSE finish → settle → exit. So this endpoint has to
 * report 503 the moment shutdown begins, while the process is still very much alive
 * and still serving existing streams. That is the whole point: the load balancer
 * stops sending new work at the same moment the process stops wanting it, and the
 * long-running responses already in flight are not cut off.
 *
 * A health check that only answered "is the process up" would return 200 through the
 * entire 600-second drain and keep receiving new requests it has decided to refuse.
 *
 * ── WHY THE DATABASE CHECK IS NOT FATAL BY DEFAULT ────────────────────────
 * `deploy/systemd/bosanda-gateway.service` deliberately does not `Requires=`
 * postgresql: a gateway that can still serve a cached catalogue and drain cleanly is
 * better than one systemd refuses to start. The probe reports the database state in
 * the body so an operator can see it, and returns 503 only when the database is the
 * reason nothing can be served. `nginx` gives this location a 5-second read timeout,
 * so the check is bounded rather than allowed to hang the probe.
 *
 * ── /metrics IS NOT PUBLIC ────────────────────────────────────────────────
 * The edge denies it (`location = /metrics { deny all; }`) and
 * `scripts/healthcheck.sh` treats a 200 from outside as a FAILURE. It is exposed
 * here for the local Prometheus scrape only. The gateway does not add its own
 * authentication in front of it: §17 puts that boundary at the edge, and a second
 * secret to provision would be a third place for the policy to drift. Anything that
 * reaches this handler has already come through a network path that permitted it.
 */

import type { FastifyInstance } from "fastify";
import type { GatewayDeps } from "../dependencies.js";

/**
 * Mutable liveness state, owned by `main.ts` and read by the route.
 *
 * A tiny object rather than a boolean so the route closes over a reference the
 * shutdown handler can flip. Passing a boolean by value would capture whatever it
 * was at registration time — permanently healthy, which is exactly the bug.
 */
export type ReadinessState = {
  /** Set false as the FIRST step of the drain, before connections are refused. */
  accepting: boolean;
};

export function createReadinessState(): ReadinessState {
  return { accepting: true };
}

export type HealthBody = {
  status: "ok" | "draining" | "degraded";
  /** Included so an operator can tell a stale process from a fresh one. */
  uptimeSeconds: number;
  database: "ok" | "unreachable";
};

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  readiness: ReadinessState,
): Promise<void> {
  const startedAt = deps.clock.now().getTime();

  app.get("/health", async (_request, reply) => {
    const uptimeSeconds = Math.floor((deps.clock.now().getTime() - startedAt) / 1000);

    // Checked first and reported even while draining, so the drain log shows whether
    // settlement had a database to write to.
    let database: HealthBody["database"] = "ok";
    try {
      await deps.checkDatabase();
    } catch (error) {
      database = "unreachable";
      // `internalDetail` may name the failure but never the connection string —
      // `checkConnection` is written to throw without it.
      app.log.error({ err: error }, "health check: database unreachable");
    }

    if (!readiness.accepting) {
      // 503 while draining. The body still says what is happening, because an
      // operator watching a deploy needs to distinguish "shutting down on purpose"
      // from "broken".
      return reply.status(503).send({ status: "draining", uptimeSeconds, database });
    }

    if (database === "unreachable") {
      return reply.status(503).send({ status: "degraded", uptimeSeconds, database });
    }

    return reply.status(200).send({ status: "ok", uptimeSeconds, database });
  });

  app.get("/metrics", async (_request, reply) => {
    // Provider gauges are computed on demand rather than on a timer: a scrape is the
    // only consumer, and a timer would keep a reference to the registry alive during
    // drain for no reader.
    deps.health.publishGauges();

    return reply
      .status(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(deps.metrics.render());
  });
}
