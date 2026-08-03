/**
 * Request identity, §17 request counting, and the last-resort error boundary.
 *
 * ── WHY `setGenReqId` AND NOT AN `onRequest` HOOK ──────────────────────────
 * `request.id` is not decoration here. `routes/openai.ts` and `routes/anthropic.ts` pass
 * it into the decoder as the canonical `requestId`, and settlement keys BOTH the ledger
 * debit and the usage row on that value (§10 idempotency). The id therefore has to be
 * final before any handler runs, and it has to be the same string every log line for the
 * request carries. A hook that reassigned `request.id` would satisfy the first and break
 * the second, leaving the logs and the ledger disagreeing about which request they
 * describe. `setGenReqId` is the one point upstream of both.
 *
 * ── WHY THE INBOUND HEADER IS VALIDATED RATHER THAN IGNORED ────────────────
 * Refusing the inbound header outright is safe but throws away the reason it exists:
 * when a customer's own gateway already has a trace id, discarding it means a support
 * request can never be joined to our logs. This plugin takes the middle position —
 * honour the header only when it is syntactically incapable of harm, generate otherwise.
 *
 * "Harm" is concrete, because the value is echoed into a response header and into every
 * log line: header injection (CR/LF), log forging (newlines), and unbounded allocation
 * per request. `SAFE_REQUEST_ID` admits only characters that can do none of those and
 * bounds the length. A malformed value is silently replaced rather than rejected — the
 * header is optional, so failing a request over it would break callers for a field they
 * were never required to send.
 *
 * Deliberate id COLLISION is not treated as our problem to prevent: a caller who forges
 * another caller's id only confuses their own trace, because every log line is already
 * scoped by `apiKeyId` and settlement idempotency is keyed per key.
 *
 * Fastify's own `requestIdHeader` option would adopt the raw header with NO validation
 * (`req.headers[h] || genReqId(req)`), which is exactly the hole this closes;
 * `assertRequestIdHeaderDisabled` fails the boot if a future `app.ts` switches it on,
 * rather than leaving the bypass to be discovered later.
 *
 * ── WHY COMPLETION IS TRACKED WITH A SET AND A SOCKET LISTENER ─────────────
 * `onResponse` does not fire for a hijacked reply, and `routes/openai.ts` hijacks on
 * every streaming turn — the dominant traffic. Counting only in `onResponse` would omit
 * precisely the requests the product exists to serve. Socket `close` is the one event
 * that fires for every streaming outcome (clean finish, client abort, upstream failure),
 * so both paths report and the Set makes the second arrival a no-op.
 *
 * ── WHY THE ERROR HANDLER LIVES HERE AND STILL SPEAKS TWO DIALECTS ─────────
 * The routes encode their own failures once they are inside their `try` (via
 * `encodeError` / `toAnthropicError`), but `requireAuth`, the Anthropic version check,
 * the decoders, and `admit` are all called BEFORE that `try`. So every 401, every
 * malformed-body 400, and every 429 arrives here instead. Those are the most common
 * errors the service produces, and an SDK handed an unrecognized envelope for them
 * reports "unparseable response" rather than "invalid API key" — turning a self-service
 * fix into a support ticket. Hence this handler selects the surface's own envelope rather
 * than inventing a third shape.
 *
 * That is safe under §16 by construction rather than by review: both encoders read only
 * `code` and `publicMessage`, and their module headers commit to it. What must never
 * happen is reaching Fastify's DEFAULT handler, which sends `err.message` —
 * `BosandaError.message` is `${code}: ${internalDetail}`, so it is never client-safe.
 */

import { BosandaError } from "@bosanda/protocol";
import { encodeError as encodeOpenAIError } from "@bosanda/openai";
import { toAnthropicError } from "@bosanda/anthropic";
import { requestLogger, type Logger } from "@bosanda/observability";
import { requestId as generateRequestId } from "@bosanda/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import type { GatewayDeps } from "../dependencies.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The §17 request-scoped logger: a child of `deps.logger`, so it carries that
     * logger's redaction chain. Assigned by this plugin's `onRequest` hook, which runs
     * for every request including one that will 404.
     *
     * This exists ALONGSIDE the assignment to `request.log` below because the two have
     * different static types. `request.log` is a `FastifyBaseLogger` — the level methods
     * and nothing else; `bosandaLog` is the full `Logger`, so code needing `.child()` has
     * a typed path without a cast. Both names point at one instance, so there is no
     * second logger and no divergent state.
     */
    bosandaLog: Logger;
  }
}

/** Honoured inbound when safe, and always echoed outbound. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Unreserved URL characters plus `:` for a caller forwarding a W3C-style trace id. No
 * CR, LF, space, quote, or comma, so the value is safe both as a header value and inside
 * a JSON log line. The 8-character floor rejects a placeholder like `-`; the 128 ceiling
 * bounds what one request can make us write per log line.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** A request whose socket closed before any status reached the client. */
const CLIENT_CLOSED = "client_closed";

/** The inbound id when it is safe to reuse, else a fresh one. */
export function resolveRequestId(headerValue: string | string[] | undefined): string {
  // An array means a proxy duplicated the header. Two candidate ids is not a situation to
  // resolve by picking one, so both are discarded.
  if (typeof headerValue === "string" && SAFE_REQUEST_ID.test(headerValue)) return headerValue;
  return generateRequestId();
}

/**
 * Low-cardinality surface label (§17).
 *
 * Derived from the ROUTE PATTERN (`/v1/models/:id`), never from `request.url`, which
 * carries path parameters and the query string. A label taken from the URL would grow the
 * series set with traffic, which is the unbounded growth the registry's own header comment
 * warns about.
 */
export function surfaceLabel(routeUrl: string | undefined): string {
  if (routeUrl === undefined) return "unmatched";
  if (routeUrl.startsWith("/v1/chat/completions")) return "openai";
  if (routeUrl.startsWith("/v1/messages")) return "anthropic";
  if (routeUrl.startsWith("/v1/models")) return "catalogue";
  if (routeUrl === "/health" || routeUrl === "/metrics") return "internal";
  return "other";
}

/**
 * The `status` label.
 *
 * Bucketed by class, EXCEPT for 401 and 429, which are named exactly. Two reasons for the
 * exception rather than a uniform class: those are the statuses an operator alerts on
 * individually (a 401 spike is a revoked or misconfigured key, a 429 spike is a customer
 * at their ceiling), and `routes/authenticate.ts` already documents this counter as the
 * source of `status="401"` — a pure `4xx` bucket would make that comment false and would
 * merge "rate limited" with "malformed body", which call for different responses. The
 * label set stays fixed at six values, so cardinality never moves with traffic.
 */
export function statusLabel(status: number): string {
  if (status === 401) return "401";
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  return "2xx";
}

/** Which error envelope the caller expects, inferred from the path. */
function surfaceFor(request: FastifyRequest): "openai" | "anthropic" {
  // `request.url` rather than the route pattern: an unmatched path has no pattern, and a
  // 404 under `/v1/messages` should still answer in the dialect the caller speaks. Safe
  // here because the value only selects between two encoders, and is never a metric label.
  return request.url.startsWith("/v1/messages") ? "anthropic" : "openai";
}

/**
 * Whether a reply can still carry a body.
 *
 * Three distinct ways the answer is no, and all three are live on the streaming path.
 * `reply.sent` is true for a hijacked reply and for a raw stream that already ended;
 * `headersSent` catches a stream that started but has not finished; `writableEnded`
 * catches a socket closed under us. Calling `send()` in any of those states either throws
 * "reply already sent" or splices JSON into the middle of an SSE body the client is
 * mid-parse on. §8 puts the error channel in-band once events start, and that channel
 * belongs to the route's stream writer, so here the only correct action is to log.
 */
function canStillRespond(reply: FastifyReply): boolean {
  return !reply.sent && !reply.raw.headersSent && !reply.raw.writableEnded;
}

function fastifyStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Maps a non-Bosanda throwable onto the frozen taxonomy.
 *
 * `BosandaError.from` alone would call everything `internal_error` (500), and one case is
 * load-bearing: the vhost pins `client_max_body_size 8m` to `LIMITS.maxBodyBytes` precisely
 * so an oversized body produces the gateway's own JSON 400 rather than nginx's HTML.
 * Fastify raises `FST_ERR_CTP_BODY_TOO_LARGE` with `statusCode: 413` for that, and
 * reporting it as a 500 would make the gateway look broken for a request that is merely
 * too big — and would page an operator for a client's mistake.
 *
 * Only the STATUS is read off the Fastify error. Its message is never inspected and never
 * forwarded; it reaches the operator log as `internalDetail` through `BosandaError.from`
 * and stops there.
 */
function classify(error: unknown): BosandaError {
  if (error instanceof BosandaError) return error;

  const status = fastifyStatusCode(error);
  if (status !== undefined && status >= 400 && status < 500) {
    // 404 is the only 4xx worth its own code here. Every other client error collapses to
    // `invalid_request`, whose public message says nothing about which check failed — the
    // same no-oracle habit the auth path uses.
    return BosandaError.from(error, status === 404 ? "not_found" : "invalid_request");
  }
  return BosandaError.from(error, "internal_error");
}

/** The surface's own error envelope. Reads `code` and `publicMessage` only (§16). */
function errorBody(request: FastifyRequest, error: BosandaError): unknown {
  return surfaceFor(request) === "anthropic" ? toAnthropicError(error) : encodeOpenAIError(error);
}

/**
 * Fails the boot if Fastify was configured to take `requestIdHeader` itself.
 *
 * A throw at registration rather than a warning: the entire value of `resolveRequestId` is
 * that no unvalidated header becomes a request id, and a silent bypass of that is the class
 * of misconfiguration that survives review. `initialConfig` is Fastify's frozen copy of the
 * options it booted with, and the option's own default is `false`, so this only fires when
 * someone sets it deliberately.
 */
function assertRequestIdHeaderDisabled(app: FastifyInstance): void {
  const configured: unknown = app.initialConfig.requestIdHeader;
  if (configured !== false && configured !== undefined && configured !== "") {
    throw new Error(
      "fastify option requestIdHeader must stay disabled: it would adopt an unvalidated " +
        "inbound header as request.id, bypassing resolveRequestId (plugins/observability.ts)",
    );
  }
}

/**
 * Registers request identity, request counting, and the error boundary.
 *
 * Synchronous and returns void because `app.ts` calls it without awaiting: an async
 * signature there would leave a floating promise whose rejection — the boot assertion
 * above, for one — would surface as an unhandled rejection on a later tick instead of
 * failing `buildApp`. Nothing here needs to await.
 *
 * MUST run before the routes: `setGenReqId` and `decorateRequest` both refuse once the
 * server has started, and the root error handler is what every route without its own
 * inherits.
 */
export function registerObservability(app: FastifyInstance, deps: GatewayDeps): void {
  assertRequestIdHeaderDisabled(app);

  // `req` is the raw Node request; Fastify has not built its own object yet.
  app.setGenReqId((req: IncomingMessage) => resolveRequestId(req.headers[REQUEST_ID_HEADER]));

  // Fastify rejects a reference-type decoration VALUE (it would be shared across every
  // request), so the slot is declared empty and filled per request below.
  app.decorateRequest("bosandaLog");

  /**
   * Request ids whose completion has not been counted yet.
   *
   * A Set rather than a counter because both completion paths can fire for one request
   * (`onResponse` for a normal reply, socket `close` for a hijacked one) and `delete`
   * returning false is what makes the second a no-op. A bare counter would double-count
   * every stream.
   */
  const pending = new Set<string>();

  const complete = (request: FastifyRequest, status: string): void => {
    if (!pending.delete(request.id)) return;
    deps.metrics.increment("bosanda_requests_total", {
      surface: surfaceLabel(request.routeOptions.url),
      route: request.routeOptions.url ?? "unmatched",
      status,
    });
  };

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const log = requestLogger(deps.logger, { requestId: request.id });
    request.bosandaLog = log;

    /**
     * `request.log` is REPLACED, not merely supplemented.
     *
     * `app.ts` boots Fastify with `logger: false` — correctly, since a second pino with no
     * redaction configured is how a prompt reaches disk. But with the logger off, Fastify's
     * `request.log` is a no-op, and `routes/openai.ts`, `routes/anthropic.ts`, and
     * `routes/authenticate.ts` all call `request.log.warn` on their failure paths. Without
     * this line those lines are silently discarded, which is the worst of both options: the
     * code reads as instrumented and the journal shows nothing for a failed stream.
     * Assigning the redacting child makes them real and keeps the guarantee.
     */
    request.log = log;

    pending.add(request.id);

    // Set on the RAW response, not through `reply.header()`. A hijacked reply
    // (`routes/openai.ts` on the streaming path) writes straight to `reply.raw` and Fastify
    // never flushes its own header bag, so a `reply.header()` call would be dropped on
    // exactly the requests whose correlation id matters most. Headers set with `setHeader`
    // are merged by the later `writeHead`, so the buffered path and the stream writer's
    // `sseHead()` both keep it.
    if (!reply.raw.headersSent) reply.raw.setHeader(REQUEST_ID_HEADER, request.id);

    /**
     * The streaming completion path.
     *
     * The status comes from `reply.raw.statusCode` rather than `reply.statusCode` so this
     * and `onResponse` cannot disagree: raw is what actually went on the wire. A stream
     * that dies mid-body has already sent its 200, so `2xx` is what the client saw —
     * inventing a 5xx here would make the counter contradict the wire, and the failure is
     * already reported by the route's log line and `bosanda_eventstream_failures_total`.
     *
     * A socket that closes with no headers sent is counted `client_closed` instead:
     * `raw.statusCode` still reads 200 in that state, so trusting it would quietly inflate
     * the success rate with abandoned requests.
     *
     * `once`, and no removal needed: `close` fires exactly once per request and `complete`
     * is idempotent.
     */
    request.raw.once("close", () => {
      complete(request, reply.raw.headersSent ? statusLabel(reply.raw.statusCode) : CLIENT_CLOSED);
    });
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    complete(request, statusLabel(reply.statusCode));
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const failure = classify(error);

    /**
     * Operator-side logging at a level chosen by whose fault the failure is. A 4xx is the
     * caller's problem and is noise at `error`; a 5xx is ours and must be visible. Getting
     * this wrong in the loud direction is how a rate-limited customer buries a real outage.
     *
     * `internalDetail` appears here and nowhere else. `err` is passed as a field so pino's
     * serializer — which redacts — handles the stack, rather than us formatting it into a
     * string that would bypass the redaction paths. The fallback logger covers a failure
     * raised before the `onRequest` hook ran, which has no request binding, so the id is on
     * the line explicitly either way.
     */
    const log = request.bosandaLog ?? deps.logger;
    const line = {
      err: error,
      requestId: request.id,
      code: failure.code,
      status: failure.status,
      detail: failure.internalDetail,
      route: request.routeOptions.url ?? "unmatched",
    };
    if (failure.status >= 500) log.error(line, "request failed");
    else log.warn(line, "request failed");

    if (!canStillRespond(reply)) {
      // Nothing to do beyond the log above: once bytes are committed the error channel is
      // in-band and belongs to the route's stream writer (§8).
      return;
    }

    if (failure.retryAfterSeconds !== undefined) {
      /**
       * Sent only when the error carries a value, never guessed. The number is derived from
       * the caller's own traffic window or a provider cooldown — never another tenant's
       * state — so it discloses nothing. Fabricating one for every 429 would tell a client
       * to wait on a condition nothing is tracking, and publishing the exact sliding-window
       * remainder would hand a caller the recipe for riding the limit.
       */
      reply.header("retry-after", String(failure.retryAfterSeconds));
    }

    reply
      .status(failure.status)
      .type("application/json; charset=utf-8")
      .send(errorBody(request, failure));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    /**
     * Fastify's stock 404 is its own `{statusCode, error, message}` shape and echoes the
     * method and URL back to the caller. Answering in the surface's envelope keeps every
     * response on this service inside one vocabulary, stays parseable for an SDK that will
     * try, and gives a scanner no signal about what exists.
     *
     * The URL is NOT logged: it is caller-controlled and would land in the operator log
     * verbatim, which is log forging by way of an error message. The method alone is a
     * bounded value and enough to tell a misrouted POST from a scanner's GET.
     */
    const failure = new BosandaError("not_found");
    (request.bosandaLog ?? deps.logger).info(
      { requestId: request.id, method: request.method },
      "route not found",
    );
    reply
      .status(failure.status)
      .type("application/json; charset=utf-8")
      .send(errorBody(request, failure));
  });
}
