/**
 * Anthropic SSE response writing (PLAN.md §8 Anthropic surface, §18 streaming).
 *
 * This is the surface Claude Code speaks, so frame fidelity matters more here than
 * anywhere else in the codebase. Three differences from the OpenAI writer are
 * substantive rather than cosmetic:
 *
 *   1. NO TERMINATOR SENTINEL. Anthropic has no `[DONE]`; `message_stop` IS the
 *      end. So the success path and the failure path differ only in which frame
 *      comes last, and getting that wrong produces a stream that a client waits on
 *      forever. `finalize()` synthesizes the closing frames when upstream ended
 *      without a `finish` event, which is the case a truncated turn hits.
 *   2. THE ENCODER RETURNS OBJECTS. `AnthropicStreamEncoder.encode` yields
 *      `SseFrame` values that must go through `formatSse`; writing them directly
 *      would put `[object Object]` on the wire.
 *   3. THE ENCODER CAN THROW MID-STREAM. A `tool_input_delta` with no preceding
 *      `tool_start` is `upstream_incompatible` (502), and it surfaces from
 *      `encode()` rather than from the adapter. That throw has to be caught by the
 *      route and rendered as an error FRAME, because headers are long committed by
 *      then — see `write()` letting it propagate deliberately.
 *
 * §18 header handling and the byte latch match the OpenAI writer; the reasoning is
 * documented there and not repeated.
 */

import { AnthropicStreamEncoder, encodeErrorEvent, formatSse } from "@bosanda/anthropic";
import type { SseFrame } from "@bosanda/anthropic";
import type { CanonicalEvent } from "@bosanda/protocol";
import { sseHead, type StreamSink } from "./openai.js";

export type AnthropicStreamWriterOptions = {
  reply: StreamSink;
  /** Reused across the stream so `message_start` and `message_delta` agree. */
  messageId?: string;
  /**
   * Input tokens known at request time. Anthropic reports them on
   * `message_start`, before upstream has told us anything, so this is the
   * locally-counted figure (§9) and is corrected in `message_delta` if upstream
   * reports differently.
   */
  inputTokens?: number;
};

export class AnthropicStreamWriter {
  private readonly reply: StreamSink;
  private readonly encoder: AnthropicStreamEncoder;
  private started = false;
  private finished = false;
  private written = 0;
  private frames = 0;
  private readonly segments: string[] = [];

  constructor(options: AnthropicStreamWriterOptions) {
    this.reply = options.reply;
    this.encoder = new AnthropicStreamEncoder({
      ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
      ...(options.inputTokens === undefined ? {} : { inputTokens: options.inputTokens }),
    });
  }

  get messageId(): string {
    return this.encoder.messageId;
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
   * Flushes SSE headers. Idempotent.
   *
   * Writes through `raw.writeHead` for the same reason the OpenAI writer does:
   * the route hijacked the reply, so `reply.header()` would never reach the wire.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.reply.raw.writeHead(200, sseHead());
  }

  /**
   * Encodes and writes one canonical event.
   *
   * Deliberately does NOT catch the encoder's `upstream_incompatible`: the route
   * needs to see it so it can decide between a JSON error (nothing written yet) and
   * an SSE error frame (already streaming). Swallowing it here would turn a
   * protocol drift into a silently truncated response, which is the failure mode
   * §3's compatibility gate exists to catch.
   */
  write(event: CanonicalEvent): number {
    this.start();
    if (event.type === "text_delta") this.segments.push(event.text);

    let bytes = 0;
    for (const frame of this.encoder.encode(event)) bytes += this.push(frame);
    return bytes;
  }

  /**
   * Success close: `message_delta` + `message_stop`, synthesized if upstream never
   * sent a `finish`. Idempotent, and a no-op after `fail()`.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.start();
    for (const frame of this.encoder.finalize()) this.push(frame);
    this.end();
  }

  /** Mid-stream failure: one `error` frame, then close. No `message_stop`. */
  fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.start();
    this.push(encodeErrorEvent(error));
    this.end();
  }

  /** Keep-alive for a long silent turn; §18 allows a comment/ping frame. */
  ping(): void {
    if (this.finished) return;
    this.start();
    this.push(this.encoder.ping());
  }

  private push(frame: SseFrame): number {
    if (this.reply.raw.writableEnded) return 0;
    const text = formatSse(frame);
    this.reply.raw.write(text);
    const bytes = Buffer.byteLength(text, "utf8");
    this.written += bytes;
    this.frames += 1;
    return bytes;
  }

  private end(): void {
    if (!this.reply.raw.writableEnded) this.reply.raw.end();
  }
}
