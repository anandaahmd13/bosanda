/**
 * `POST /v1/chat/completions` — the OpenAI-compatible surface (PLAN.md §8).
 *
 * The route is deliberately thin. Decode, run the shared pipeline, encode. Every
 * rule that matters (limits, quota, kill switches, pool selection, failover,
 * settlement) lives in `pipeline.ts` so it cannot hold on one surface and quietly
 * not on the other.
 *
 * ── THE ONE DECISION THIS FILE OWNS: WHERE THE ERROR GOES ─────────────────
 * §8: "before headers are sent, return a normal error response; after headers/events
 * start, emit the closest protocol-specific stream error and close." That boundary is
 * not a style choice — once a 200 and the SSE content-type are on the wire, there is
 * no status code left to change, and an SDK that has begun parsing `data:` frames
 * will not re-read the status. So the writer's `hasWritten` is the authority:
 *
 *   nothing written yet → JSON envelope + real HTTP status
 *   already streaming    → one `data:` error frame, NO `[DONE]`, then close
 *
 * The absent `[DONE]` is what tells the client the turn was truncated. Sending it
 * after an error would claim the response was complete.
 *
 * ── WHY SETTLEMENT IS IN A `finally` ──────────────────────────────────────
 * §10 bills what was delivered, including a turn that broke mid-stream after
 * emitting tokens. A `finally` is the only structure where the abort path, the
 * upstream-failure path, and the success path all settle exactly once — and because
 * `settleRequest` never throws, it cannot turn a served response into a crash.
 *
 * ── ABORT ─────────────────────────────────────────────────────────────────
 * A client disconnect must reach the provider, or a cancelled turn keeps burning an
 * upstream slot and the customer's concurrency budget until the idle timeout. Fastify
 * gives us the socket `close` event; that is wired to an `AbortController` whose
 * signal goes all the way down to the adapter's fetch.
 */

import {
  decodeChatCompletion,
  encodeCompletion,
  encodeError,
  encodeErrorStatus,
} from "@bosanda/openai";
import { BosandaError } from "@bosanda/protocol";
import type { CanonicalEvent } from "@bosanda/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { admit, runStream, settleOutcome } from "../pipeline.js";
import { OpenAIStreamWriter } from "../streaming/openai.js";
import type { GatewayDeps } from "../dependencies.js";
import { requireAuth } from "./authenticate.js";
import { requestAbortSignal } from "./abort.js";

export async function registerOpenAIRoutes(app: FastifyInstance, deps: GatewayDeps): Promise<void> {
  app.post("/v1/chat/completions", async (request, reply) => {
    const authenticated = await requireAuth(request, deps);

    // Decode BEFORE admission. A malformed body is a 400 that should cost nothing:
    // acquiring a rate-limit slot for a request that can never run would let a buggy
    // client exhaust its own quota window on requests we reject outright.
    const decoded = decodeChatCompletion(request.body, { requestId: request.id });

    const { admitted, request: canonical } = await admit({ authenticated, request: decoded }, deps);

    try {
      if (canonical.stream) {
        return await streamResponse(request, reply, canonical, admitted, deps);
      }
      return await bufferedResponse(reply, canonical, admitted, deps);
    } finally {
      // The slot is released here rather than inside the pipeline: it must outlive
      // admission and end with the response, and this is the only scope that spans
      // both branches.
      admitted.slot.release();
    }
  });
}

/**
 * `stream: true` — SSE.
 *
 * Headers are flushed as soon as admission succeeds, before the provider has
 * produced anything. That is deliberate: the client learns its request was accepted
 * immediately instead of waiting on upstream time-to-first-byte, and any proxy in
 * the path commits to a streaming response rather than buffering while it waits for
 * a content-length that will never come.
 */
async function streamResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  canonical: Parameters<typeof runStream>[0]["request"],
  admitted: Awaited<ReturnType<typeof admit>>["admitted"],
  deps: GatewayDeps,
): Promise<void> {
  const writer = new OpenAIStreamWriter({
    reply,
    model: canonical.model,
    includeUsage: canonical.includeUsage,
    clock: deps.clock,
  });

  // Tell Fastify the socket is ours. Without this it would try to send its own
  // response after the handler resolves and log a "reply already sent" error over a
  // stream we deliberately ended by hand.
  reply.hijack();
  writer.start();

  const { signal, dispose } = requestAbortSignal(request);
  let outcome: Awaited<ReturnType<typeof runStream>> | null = null;

  try {
    outcome = await runStream(
      {
        request: canonical,
        admitted,
        signal,
        emit: (event: CanonicalEvent) => {
          const bytes = writer.write(event);
          if (bytes > 0) {
            deps.metrics.increment("bosanda_stream_bytes_total", { surface: "openai" }, bytes);
          }
        },
      },
      deps,
    );

    // `runStream` returns rather than throws, so both endings are handled here.
    if (outcome.error === undefined) {
      writer.finish();
    } else {
      // Already streaming by definition — headers went out in `writer.start()`.
      // One error frame, no `[DONE]`.
      // `bosandaLog`, not `request.log`: Fastify boots with `logger: false`, so
      // `request.log` is a no-op stub. This is the ONLY record that the turn broke —
      // the client saw a 200 and the response counted as `2xx` — so dropping it would
      // make a mid-stream provider failure invisible to operators.
      request.bosandaLog.warn(
        { code: outcome.error.code, detail: outcome.error.internalDetail },
        "stream failed after headers were sent",
      );
      writer.fail(outcome.error);
    }
  } catch (error) {
    // Reached only if `emit` itself threw — a codec drift, not an upstream failure.
    // The writer is the sole way to answer now; a status is no longer available.
    request.bosandaLog.error({ err: error }, "stream encoder failed");
    writer.fail(error);
  } finally {
    dispose();
    if (outcome !== null) {
      await settleOutcome(
        {
          request: canonical,
          admitted,
          outcome,
          outputSegments: writer.outputSegments,
          surface: "openai",
        },
        deps,
      );
    }
  }
}

/**
 * `stream: false` — one JSON body.
 *
 * The turn is still STREAMED from the provider and buffered here. Bosanda does not
 * ask upstream for a non-streaming response: the adapter speaks EventStream, and
 * collecting canonical events is what lets both surfaces share one provider path.
 * The client simply never sees the frames.
 *
 * Because nothing has been written when a failure arrives, a mid-turn error is a real
 * HTTP status here — the opposite of the streaming branch, and the reason both live
 * in this file where the difference is visible.
 */
async function bufferedResponse(
  reply: FastifyReply,
  canonical: Parameters<typeof runStream>[0]["request"],
  admitted: Awaited<ReturnType<typeof admit>>["admitted"],
  deps: GatewayDeps,
): Promise<FastifyReply> {
  const events: CanonicalEvent[] = [];
  const segments: string[] = [];

  const outcome = await runStream(
    {
      request: canonical,
      admitted,
      // No socket-close abort on this path: there is no partial body to salvage, and
      // Fastify has not committed a response, so the request either completes or
      // fails as a unit.
      // §7's hard ceiling. The adapter applies the idle timeout independently; this
      // bounds the whole turn so a provider that trickles a byte a minute cannot hold
      // the request open past what nginx and systemd are configured to tolerate.
      signal: AbortSignal.timeout(deps.env.UPSTREAM_HARD_TIMEOUT_MS),
      emit: (event) => {
        events.push(event);
        if (event.type === "text_delta") segments.push(event.text);
      },
    },
    deps,
  );

  await settleOutcome(
    { request: canonical, admitted, outcome, outputSegments: segments, surface: "openai" },
    deps,
  );

  if (outcome.error !== undefined) {
    // A turn that produced text and then broke is still an error on this surface:
    // the client asked for one complete completion, and handing back a truncated
    // body with a 200 would be indistinguishable from a short answer.
    const error = BosandaError.from(outcome.error);
    return reply.status(encodeErrorStatus(error)).send(encodeError(error));
  }

  return reply.status(200).send(
    encodeCompletion(events, {
      model: canonical.model,
      includeUsage: canonical.includeUsage,
      clock: deps.clock,
    }),
  );
}
