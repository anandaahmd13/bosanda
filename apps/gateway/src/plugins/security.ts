/**
 * Transport-level hardening for a machine-to-machine API (PLAN.md §16, §18).
 *
 * This gateway is not a browser app. Nothing here serves HTML, sets a session cookie, or is
 * fetched by a page on another origin: the callers are the OpenAI and Anthropic SDKs, curl,
 * and server-side code holding a `bsk_` key. Every decision below follows from that one
 * fact, and the restrictive settings are cheap precisely because no legitimate client needs
 * the permissive ones.
 *
 * ── WHAT THIS PLUGIN DOES NOT DO ──────────────────────────────────────────
 * No error handler and no 404 handler. Both live in `plugins/observability.ts`, beside the
 * request id and the request counter they log against. Fastify allows ONE error handler per
 * encapsulation scope and lets the later registration replace the earlier one, so a second
 * one here would not be defence in depth — it would decide, invisibly and by registration
 * order, which of two files is actually live.
 *
 * No `@fastify/rate-limit`. See the block comment below; a deliberate omission.
 */

import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { LIMITS } from "@bosanda/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayDeps } from "../dependencies.js";

/**
 * Headers this plugin adds to every response, streaming or not.
 *
 * Both are the §18 nginx contract. The vhost sets them with `always`, and they are repeated
 * here because the gateway is also reachable directly on loopback (a health probe, an
 * operator with curl, a future sidecar), and because a proxy that buffers or recompresses an
 * SSE body turns time-to-first-token into "whenever the buffer fills". `no-transform` is
 * specifically the half that forbids recompression — `no-cache` alone does not.
 *
 * Applied blanket rather than only on streams, so a new streaming route cannot forget them.
 * They are inert on a JSON response.
 *
 * The document-oriented headers that used to live here (`nosniff`, `x-frame-options`,
 * `referrer-policy`) are now helmet's job — see the registration below. Setting them by hand
 * as well would emit each one twice.
 */
const RESPONSE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["cache-control", "no-store, no-transform"],
  ["x-accel-buffering", "no"],
];

/**
 * Registers transport hardening.
 *
 * Synchronous and void-returning to match `app.ts`, which calls it without awaiting.
 * Fastify queues the two `register` calls and resolves them during `ready()`, so nothing is
 * lost by not awaiting — but a promise RETURNED from here would be floating at the call
 * site, and its rejection would arrive as an unhandled rejection instead of a failed boot.
 */
export function registerSecurity(app: FastifyInstance, deps: GatewayDeps): void {
  /**
   * ── WHY NOT `@fastify/rate-limit` ───────────────────────────────────────
   * The package is installed and is deliberately never registered. Two limiters already sit
   * in the path, and a third would make the system less correct rather than safer:
   *
   *   1. nginx owns the EDGE bucket, keyed by IP (`limit_req_zone` at 300r/m, plus
   *      `limit_conn api_conn 60`). Its job is to stop a flood before it costs the gateway a
   *      socket, and it necessarily works on the only identity available before auth.
   *   2. `KeyLimiter` (`limits.ts`) owns the CUSTOMER limit, keyed by `apiKeyId`, counting
   *      both RPM and CONCURRENCY. That is the limit the product actually sells, and that
   *      file's own header explains why this plugin is the wrong tool: it "keys on IP by
   *      default and counts requests, not concurrency".
   *
   * A third layer would key on IP again, so it would punish the customers whose traffic
   * shares an egress NAT while doing nothing about one key spread across many IPs — which is
   * the abuse pattern that actually costs money. It would also reject with its own 429 body
   * and its own `retry-after`, bypassing the observability plugin's envelope and the
   * `BosandaError` taxonomy: a rate-limited client would get a shape no SDK recognizes, and
   * the rejection would be invisible to `bosanda_rpm_rejections_total`. The right place to
   * tighten a limit is one of the two layers that already exist.
   */

  /**
   * `bodyLimit` is a SERVER option — Fastify reads it when the instance is constructed, so a
   * plugin cannot set it, and `app.ts` passes `LIMITS.maxBodyBytes` there. This assertion is
   * what keeps the coupling honest, because the value is a three-way contract that nothing
   * else verifies:
   *
   *   nginx `client_max_body_size 8m`  ==  LIMITS.maxBodyBytes  ==  Fastify bodyLimit
   *
   * If the gateway's limit were the LARGER of the two, nginx would reject an oversized body
   * first with its own HTML error page, and an SDK would surface a JSON parse failure
   * instead of a 400 the caller can act on. If it were SMALLER, the gateway would pay to
   * read a body it was always going to refuse. Equal values mean the rejection always comes
   * from here, in the right envelope, as early as possible.
   */
  const configuredBodyLimit: unknown = app.initialConfig.bodyLimit;
  if (configuredBodyLimit !== LIMITS.maxBodyBytes) {
    throw new Error(
      `fastify bodyLimit (${String(configuredBodyLimit)}) must equal LIMITS.maxBodyBytes ` +
        `(${String(LIMITS.maxBodyBytes)}) and nginx client_max_body_size (8m)`,
    );
  }

  /**
   * ── HELMET ──────────────────────────────────────────────────────────────
   * Most of what helmet does protects a DOCUMENT, and this service returns
   * `application/json` and `text/event-stream` only. So the defaults are trimmed to the
   * headers that still mean something for an API, and each disable is a decision:
   *
   * - `contentSecurityPolicy: false`. A CSP governs what a page may load; there is no page.
   *   The edge already sends `default-src 'none'` as belt-and-braces for anything that
   *   somehow renders a response, and setting it here too would put a second, conflicting
   *   CSP header on every response.
   * - `hsts: false`. HSTS is only meaningful on a TLS origin, and nginx terminates TLS. Set
   *   here it is advisory at best, and actively wrong on the loopback interface where the
   *   gateway legitimately speaks plain HTTP — a browser that saw it would pin
   *   `https://127.0.0.1`.
   * - `crossOriginEmbedderPolicy: false`. COEP governs `SharedArrayBuffer` and embedded
   *   subresources in a document context; it does nothing for a JSON fetch, and
   *   `require-corp` is a known way to break embeds for no benefit here.
   *
   * Kept: `noSniff` (a client that guesses `text/html` on our JSON is a stored-XSS vector if
   * a response is ever echoed into a page), `frameguard: deny` (nothing here should be
   * framed), `no-referrer` (a URL of ours must not leak into a third party's logs), and
   * helmet's remaining defaults, which are inert-but-harmless for an API — notably
   * `X-Permitted-Cross-Domain-Policies: none`, which stops a legacy Flash/PDF policy reader
   * treating this origin as permissive.
   */
  void app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    noSniff: true,
  });

  /**
   * ── CORS ────────────────────────────────────────────────────────────────
   * Registered with NO allowed origins. `origin: false` means the plugin never emits
   * `Access-Control-Allow-Origin`, so a browser refuses to hand any response back to page
   * script. Registering it anyway is still worth doing, because it also answers the OPTIONS
   * preflight: a browser that tries gets a clean rejection at the CORS layer instead of a
   * 404 from the router, which is a far more confusing thing to debug.
   *
   * WHY NOT allow origins: an API key sent from page script is a key published to every
   * visitor, and §16 assumes `bsk_` keys live on servers. Allowing a browser origin would
   * make key exfiltration a supported use case. A customer wanting browser-side access must
   * proxy through their own backend, which is where their key belongs.
   *
   * `credentials` is deliberately absent: with no allowed origin it would be meaningless,
   * and pairing it with a permissive origin later is the classic CORS misconfiguration.
   * Callers authenticate with a bearer or `x-api-key` header, never a cookie, so there is
   * nothing for a credentialed cross-origin request to carry.
   */
  void app.register(cors, {
    origin: false,
    methods: ["GET", "POST", "OPTIONS"],
    // The two auth headers the surfaces accept, plus the content and version headers the
    // SDKs send. An allowlist rather than a wildcard, so a preflight for anything unusual
    // fails visibly instead of being waved through.
    allowedHeaders: [
      "authorization",
      "x-api-key",
      "content-type",
      "anthropic-version",
      "x-request-id",
    ],
    // Lets a caller read the correlation id the observability plugin echoes back, and the
    // backoff hint on a 429. Without this they are on the wire but invisible to a
    // browser-side reader.
    exposedHeaders: ["x-request-id", "retry-after"],
    maxAge: 600,
  });

  /**
   * The buffered path.
   *
   * This hook does NOT run for a hijacked reply, which is why the streaming path is handled
   * separately below. Both are needed: `onSend` is the only place that can still add a
   * header to a response Fastify serialized itself, and `onRequest` is the only place early
   * enough for a reply the route is about to hijack.
   */
  app.addHook("onSend", async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    for (const [name, value] of RESPONSE_HEADERS) {
      // Never overwrite. An SSE response already carries `cache-control: no-cache,
      // no-transform` from the stream writer's `sseHead()`, and replacing it with `no-store`
      // would be needlessly hostile to a stream a client may want to resume — `no-store`
      // is the right answer for a JSON body, not for that one.
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });

  /**
   * The streaming path.
   *
   * Set on `reply.raw` during `onRequest`, because a hijacked reply writes its own status
   * line through `raw.writeHead` and never consults Fastify's header bag. `writeHead` MERGES
   * with whatever `setHeader` already placed, so these survive it; `sseHead()` sets
   * `x-accel-buffering` itself, and the guard below means the stream's own value wins for
   * `cache-control`.
   */
  app.addHook("onRequest", async (_request: FastifyRequest, reply: FastifyReply) => {
    if (reply.raw.headersSent) return;
    for (const [name, value] of RESPONSE_HEADERS) {
      if (!reply.raw.hasHeader(name)) reply.raw.setHeader(name, value);
    }
  });

  // Logged at boot so the effective posture is visible in the journal rather than only
  // inferable from this file. `bodyLimit` especially: it is the one value that has to match
  // two other systems.
  deps.logger.info(
    {
      bodyLimitBytes: LIMITS.maxBodyBytes,
      corsOrigins: "none",
      rateLimitPlugin: false,
    },
    "security plugin registered",
  );
}
