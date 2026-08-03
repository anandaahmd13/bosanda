/**
 * OpenAI SSE response writing (PLAN.md §8 OpenAI surface, §18 streaming).
 *
 * WHY THE ROUTES DO NOT WRITE FRAMES THEMSELVES. Three rules have to hold on
 * every byte and each is easy to get subtly wrong in a route handler:
 *
 *   1. Headers must be flushed BEFORE the first upstream event, or nginx and the
 *      client both sit waiting on a response that is technically in progress.
 *      `X-Accel-Buffering: no` in particular must be on the wire early — the vhost
 *      sets `proxy_buffering off` too, but §18 makes the gateway responsible for
 *      declaring it, so a misconfigured edge cannot silently buffer an SSE turn.
 *   2. A mid-stream failure must NOT emit a terminator. Once `data: [DONE]` is
 *      sent, a well-behaved client treats the turn as complete and will render a
 *      truncated answer as a finished one. An error frame with no `[DONE]` is what
 *      tells the SDK the stream broke.
 *   3. Exactly one terminator on the success path, and only after the encoder has
 *      produced its (optional) usage chunk.
 *
 * Centralizing them means the invariant is tested once, in
 * `streaming-errors.test.ts`, rather than re-asserted per route.
 *
 * ── THE BYTE LATCH ────────────────────────────────────────────────────────
 * `hasWritten` records whether anything reached the client. §7 rule 3 forbids
 * failing over after the first byte; `streamWithFailover` owns that decision for
 * the provider side, but the ERROR RENDERING decision is here: before the first
 * byte an error is still a normal JSON response with a real status code, and after
 * it the only available channel is an SSE error frame on a 200 that is already
 * committed. Two different renderings of the same error, chosen by one flag.
 */

import { DONE_FRAME, OpenAIStreamEncoder, encodeErrorEvent } from "@bosanda/openai";
import type { CanonicalEvent } from "@bosanda/protocol";
import type { Clock } from "@bosanda/shared";

/**
 * The subset of a Fastify reply this writer needs.
 *
 * Structural rather than `FastifyReply` so a test can pass a recording object and
 * assert the exact frame sequence without an HTTP server.
 */
export type StreamSink = {
  raw: {
    writableEnded: boolean;
    /**
     * Writes the status line and headers straight to the socket.
     *
     * REQUIRED, not a convenience. The routes call `reply.hijack()` so Fastify
     * stops managing the reply; from that moment `reply.header()` mutates an
     * object nobody will ever serialize, and the response goes out with only
     * Node's implicit headers (`date`, `connection`, `transfer-encoding`). The
     * client then receives SSE with no `content-type: text/event-stream` and the
     * §18 anti-buffering contract is silently unmet. Writing the head here is
     * the only way a hijacked reply gets real headers.
     */
    writeHead(status: number, headers: Record<string, string>): unknown;
    write(chunk: string): boolean;
    end(): void;
  };
  header(name: string, value: string): unknown;
  hijack?: () => unknown;
};

/** Headers every SSE response carries. §18, plus the nginx contract. */
export const SSE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["content-type", "text/event-stream; charset=utf-8"],
  ["cache-control", "no-cache, no-transform"],
  ["connection", "keep-alive"],
  // §18: the gateway declares this itself; the edge also sets it.
  ["x-accel-buffering", "no"],
];

/**
 * `SSE_HEADERS` in the shape `writeHead` wants.
 *
 * Kept as a function rather than a frozen object so a caller cannot mutate the
 * headers of every future stream by editing one shared record.
 */
export function sseHead(): Record<string, string> {
  return Object.fromEntries(SSE_HEADERS.map(([name, value]) => [name, value]));
}

export type OpenAIStreamWriterOptions = {
  reply: StreamSink;
  model: string;
  includeUsage: boolean;
  clock?: Clock;
  /** Response id, so the non-streaming and streaming paths can share one. */
  id?: string;
};

/**
 * Writes one OpenAI streaming response.
 *
 * `bytesWritten` is tracked for the §17 `bosanda_stream_bytes_total` counter and
 * for the settlement path, which needs to know whether the turn produced output
 * before it failed.
 */
export class OpenAIStreamWriter {
  private readonly reply: StreamSink;
  private readonly encoder: OpenAIStreamEncoder;
  private started = false;
  private finished = false;
  private written = 0;
  private frames = 0;
  /** Text actually emitted, for the counted-usage fallback (§9). */
  private readonly segments: string[] = [];

  constructor(options: OpenAIStreamWriterOptions) {
    this.reply = options.reply;
    this.encoder = new OpenAIStreamEncoder({
      model: options.model,
      includeUsage: options.includeUsage,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.id === undefined ? {} : { id: options.id }),
    });
  }

  get hasWritten(): boolean {
    return this.written > 0;
  }

  get bytesWritten(): number {
    return this.written;
  }

  get framesWritten(): number {
    return this.frames;
  }

  get outputSegments(): readonly string[] {
    return this.segments;
  }

  /**
   * Flushes SSE headers. Idempotent, and safe to call before the first upstream
   * event has arrived — which is the point: a slow provider must not delay the
   * client learning that its request was accepted.
   *
   * Writes through `raw.writeHead` because the route has already hijacked the
   * reply; see `StreamSink.raw.writeHead` for why `reply.header()` is not enough.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.reply.raw.writeHead(200, sseHead());
  }

  /** Encodes and writes one canonical event. Returns bytes written (0 is normal). */
  write(event: CanonicalEvent): number {
    this.start();
    if (event.type === "text_delta") this.segments.push(event.text);

    let bytes = 0;
    for (const frame of this.encoder.encode(event)) bytes += this.push(frame);
    return bytes;
  }

  /**
   * Success terminator: the encoder's trailing usage chunk (when opted in) plus
   * `[DONE]`. Idempotent, and a no-op once `fail()` has run — an error must never
   * be followed by a completion marker.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.start();
    for (const frame of this.encoder.finish()) this.push(frame);
    this.end();
  }

  /**
   * Mid-stream failure: ONE error frame, NO `[DONE]`.
   *
   * Only valid after headers are committed. Before that the caller should send a
   * normal error response instead — `renderStreamFailure` in the route makes that
   * choice.
   */
  fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.start();
    this.push(encodeErrorEvent(error));
    this.end();
  }

  private push(frame: string): number {
    if (this.reply.raw.writableEnded) return 0;
    this.reply.raw.write(frame);
    const bytes = Buffer.byteLength(frame, "utf8");
    this.written += bytes;
    this.frames += 1;
    return bytes;
  }

  private end(): void {
    if (!this.reply.raw.writableEnded) this.reply.raw.end();
  }
}

/** Re-exported so a test can assert the terminator without importing two packages. */
export { DONE_FRAME };
