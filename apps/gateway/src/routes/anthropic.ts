/**
 * `POST /v1/messages` and `POST /v1/messages/count_tokens` — the Anthropic-compatible
 * surface (PLAN.md §8).
 *
 * This is the surface Claude Code itself speaks, so fidelity matters more here than
 * anywhere else: event order, block indices, and the `message_delta` usage trailer are
 * all things a real client parses strictly rather than tolerantly. The codec owns that
 * fidelity; this file owns the HTTP boundary and the same error-placement decision the
 * OpenAI route makes.
 *
 * ── THE DIFFERENCES FROM THE OPENAI ROUTE ─────────────────────────────────
 *  1. `anthropic-version` is REQUIRED and validated before anything else. An
 *     unsupported version is a 400, not a silent best-effort: the header exists so a
 *     client can pin wire behaviour, and honouring an unknown value would defeat it.
 *  2. Anthropic reports input tokens on `message_start`, before upstream has told us
 *     anything. The locally counted figure is passed to the writer and corrected in
 *     `message_delta` if upstream disagrees (§9).
 *  3. `count_tokens` runs the decoder and the counter and nothing else — no
 *     admission, no provider, no ledger entry.
 *
 * Everything else is identical by construction, because it is the same pipeline.
 */

import {
  countTokensForRequest,
  decodeCountTokensRequest,
  decodeMessagesRequest,
  encodeMessage,
  requireAnthropicVersion,
  statusForError,
  toAnthropicError,
} from "@bosanda/anthropic";
import { BosandaError } from "@bosanda/protocol";
import type { CanonicalEvent } from "@bosanda/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { admit, runStream, settleOutcome } from "../pipeline.js";
import { AnthropicStreamWriter } from "../streaming/anthropic.js";
import type { GatewayDeps } from "../dependencies.js";
import { requireAuth } from "./authenticate.js";
import { requestAbortSignal } from "./abort.js";

export async function registerAnthropicRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
): Promise<void> {
  app.post("/v1/messages", async (request, reply) => {
    const authenticated = await requireAuth(request, deps);

    // Version first: a client on an unsupported wire contract should learn that
    // before it is charged for anything or occupies a rate-limit slot.
    requireAnthropicVersion(request.headers);

    const decoded = decodeMessagesRequest(request.body, request.headers, {
      requestId: request.id,
    });

    const { admitted, request: canonical } = await admit({ authenticated, request: decoded }, deps);

    try {
      if (canonical.stream) {
        return await streamResponse(request, reply, canonical, admitted, deps);
      }
      return await bufferedResponse(reply, canonical, admitted, deps);
    } finally {
      admitted.slot.release();
    }
  });

  /**
   * Token counting.
   *
   * Authenticated but NOT metered: §10 bills tokens that were generated or consumed
   * upstream, and this endpoint touches no provider. It is also the one place a client
   * can size a prompt before committing to spend, so making it cost quota would
   * defeat its purpose. It still passes through the rate limiter's sibling — the RPM
   * window — via `requireAuth` plus the edge bucket, so it cannot be used as a free
   * unlimited endpoint.
   */
  app.post("/v1/messages/count_tokens", async (request, reply) => {
    await requireAuth(request, deps);
    requireAnthropicVersion(request.headers);

    const decoded = decodeCountTokensRequest(request.body, request.headers, {
      requestId: request.id,
    });

    // The model still has to exist and be permitted: counting against a model the
    // customer may not use would tell them it exists.
    const [record, switches] = await Promise.all([
      deps.models.findByPublicId(decoded.model),
      deps.killSwitches(),
    ]);
    if (record === null || !record.published || switches.disabledModels.has(decoded.model)) {
      throw new BosandaError("model_not_allowed", {
        internalDetail: `count_tokens for unknown or unavailable model ${decoded.model}`,
      });
    }

    return reply.status(200).send(countTokensForRequest(decoded));
  });
}

async function streamResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  canonical: Parameters<typeof runStream>[0]["request"],
  admitted: Awaited<ReturnType<typeof admit>>["admitted"],
  deps: GatewayDeps,
): Promise<void> {
  // Counted locally, because `message_start` must carry a number and upstream has not
  // spoken yet. `message_delta` carries the authoritative figure once it has.
  const inputTokens = countTokensForRequest(canonical).input_tokens;

  const writer = new AnthropicStreamWriter({ reply, inputTokens });

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
            deps.metrics.increment("bosanda_stream_bytes_total", { surface: "anthropic" }, bytes);
          }
        },
      },
      deps,
    );

    if (outcome.error === undefined) {
      writer.finish();
    } else {
      // `bosandaLog`, not `request.log`: Fastify boots with `logger: false`, so
      // `request.log` is a no-op stub and this line would vanish. It is the only
      // operator-visible record that the turn broke after a 200 was committed.
      request.bosandaLog.warn(
        { code: outcome.error.code, detail: outcome.error.internalDetail },
        "stream failed after headers were sent",
      );
      // One `error` event, then close. No `message_stop`: that would tell the client
      // the message ended normally, and Claude Code would treat a truncated turn as
      // a complete one.
      writer.fail(outcome.error);
    }
  } catch (error) {
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
          surface: "anthropic",
        },
        deps,
      );
    }
  }
}

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
      signal: AbortSignal.timeout(deps.env.UPSTREAM_HARD_TIMEOUT_MS),
      emit: (event) => {
        events.push(event);
        if (event.type === "text_delta") segments.push(event.text);
      },
    },
    deps,
  );

  await settleOutcome(
    { request: canonical, admitted, outcome, outputSegments: segments, surface: "anthropic" },
    deps,
  );

  if (outcome.error !== undefined) {
    const error = BosandaError.from(outcome.error);
    return reply.status(statusForError(error)).send(toAnthropicError(error));
  }

  return reply.status(200).send(encodeMessage(events));
}
