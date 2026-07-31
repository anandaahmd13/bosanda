/**
 * SSE framing for the Anthropic surface (PLAN.md §8 "Anthropic stream order").
 *
 * Anthropic clients — Claude Code included — dispatch on the `event:` line, not
 * on the JSON body, so every frame MUST carry both an `event:` and a `data:`
 * line. A frame with only `data:` is silently ignored by a conformant client.
 *
 * There is deliberately no `[DONE]` sentinel on this surface (§8); the stream
 * ends with `message_stop`.
 */

export type SseFrame = {
  event: string;
  /** Pre-serialized JSON. */
  data: string;
};

/**
 * One frame as wire text, terminated by the blank line that closes an SSE event.
 *
 * `data` is JSON, which never contains a raw newline, so single-line output is
 * safe. A multi-line payload is still split across `data:` lines rather than
 * truncating the frame, because a bare newline would end the event early.
 */
export function formatSse(frame: SseFrame): string {
  const lines = frame.data.split("\n");
  let out = `event: ${frame.event}\n`;
  for (const line of lines) {
    out += `data: ${line}\n`;
  }
  return `${out}\n`;
}

/** Concatenated wire text for a whole frame sequence. */
export function formatSseStream(frames: readonly SseFrame[]): string {
  let out = "";
  for (const frame of frames) {
    out += formatSse(frame);
  }
  return out;
}

/**
 * Keep-alive comment. Anthropic sends `ping` as a real typed event rather than
 * an SSE comment, so it is a normal frame; this exists for the gateway's idle
 * keep-alive, which must not disturb block indices.
 */
export function pingFrame(): SseFrame {
  return { event: "ping", data: JSON.stringify({ type: "ping" }) };
}
