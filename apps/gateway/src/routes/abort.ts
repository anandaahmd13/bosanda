/**
 * Client disconnect → provider abort (PLAN.md §7 cancellation, §16 invariant 9).
 *
 * A customer pressing Ctrl-C in Claude Code has to reach the upstream fetch. If it
 * does not, three things leak at once: the provider slot stays leased until the idle
 * timeout, the customer's concurrency budget stays consumed, and we keep receiving —
 * and eventually settling — tokens for a response nobody will read.
 *
 * ── WHY THE LISTENER IS REMOVED ───────────────────────────────────────────
 * `request.raw` is a long-lived socket-backed object, and with keep-alive the same
 * socket serves many requests. Attaching a `close` listener per request without
 * removing it grows the listener list for the life of the connection, which Node
 * eventually warns about and which keeps every prior request's AbortController
 * reachable. `dispose()` is not politeness; it is what stops a slow leak on a busy
 * connection.
 */

import type { FastifyRequest } from "fastify";

export type RequestAbort = {
  signal: AbortSignal;
  /** Detaches the socket listener. Safe to call more than once. */
  dispose: () => void;
};

/**
 * Builds an `AbortSignal` that fires when the client goes away.
 *
 * `aborted` on the raw request covers the case where the socket closed between
 * Fastify handing us the request and this function running — without that check a
 * request that died during authentication would stream to a closed socket until the
 * upstream idle timeout.
 */
export function requestAbortSignal(request: FastifyRequest): RequestAbort {
  const controller = new AbortController();

  const onClose = (): void => {
    // "aborted" rather than "client_disconnected": the reason is surfaced in logs and
    // compared against nothing, so a stable short string is enough.
    controller.abort(new Error("client disconnected"));
  };

  if (request.raw.destroyed || request.raw.aborted) {
    onClose();
  } else {
    request.raw.once("close", onClose);
  }

  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      request.raw.removeListener("close", onClose);
    },
  };
}
