/**
 * Local token counter (PLAN.md §10 usage source priority #2, and the
 * /v1/messages/count_tokens endpoint in §8).
 *
 * HONEST LIMITATION: this is NOT a BPE tokenizer. It is a deterministic heuristic
 * approximation, and it is labelled as such everywhere its output is used. Real BPE
 * for the upstream model would require that model's vocabulary, which Bosanda does
 * not have — and shipping a *different* tokenizer's vocabulary would give confidently
 * wrong numbers rather than acknowledged estimates.
 *
 * Method: characters / CHARS_PER_TOKEN, with per-segment overheads for message and
 * content-block framing. Calibrated against the widely-observed ~4 chars/token ratio
 * for English prose in Claude-family tokenizers.
 *
 * Expected error: roughly ±15% on English prose; worse (under-counting) on CJK text,
 * where one character is often one token or more, and worse (over-counting) on long
 * runs of repeated punctuation or whitespace that BPE merges aggressively. Do not use
 * this for billing when authoritative upstream usage is available — the priority order
 * in usage.ts exists precisely to prefer upstream numbers.
 *
 * Version-stamped: any change to the heuristic MUST bump COUNTER_VERSION, so ledger
 * rows remain explainable after the method changes.
 */

import type { CanonicalContent, CanonicalRequest } from "@bosanda/protocol";

export const COUNTER_VERSION = "heuristic-2";

/** Average characters per token for mixed English prose and code. */
const CHARS_PER_TOKEN = 4;

/** Per-message framing overhead (role markers, delimiters). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Per content-block framing overhead. */
const BLOCK_OVERHEAD_TOKENS = 2;

/** Per tool definition framing overhead, on top of its serialized schema. */
const TOOL_OVERHEAD_TOKENS = 8;

/** CJK and other scripts where a character is typically >= 1 token. */
const DENSE_SCRIPT_PATTERN = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;

/**
 * Token estimate for a plain string.
 *
 * Dense-script characters are counted at 1 token each rather than 0.25, because
 * treating a Japanese sentence as 4 chars/token under-counts by ~4x — and
 * under-counting is the failure direction that gives away free capacity.
 */
export function countText(text: string): number {
  if (text.length === 0) return 0;

  const denseMatches = text.match(DENSE_SCRIPT_PATTERN);
  const denseCount = denseMatches?.length ?? 0;
  const remaining = text.length - denseCount;

  return denseCount + Math.ceil(remaining / CHARS_PER_TOKEN);
}

function countContent(content: CanonicalContent): number {
  switch (content.type) {
    case "text":
      return BLOCK_OVERHEAD_TOKENS + countText(content.text);
    case "reasoning":
      return BLOCK_OVERHEAD_TOKENS + countText(content.text);
    case "tool_use":
      // The serialized input is what crosses the wire, so count that rather than
      // guessing from the object shape.
      return BLOCK_OVERHEAD_TOKENS + countText(content.name) + countText(safeJson(content.input));
    case "tool_result":
      return BLOCK_OVERHEAD_TOKENS + countText(content.toolUseId) + countText(content.content);
  }
}

/** JSON.stringify that cannot throw on cycles or BigInt, since input is caller-supplied. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Input-token estimate for a whole request: system prompt, full message history,
 * and tool definitions. Tool definitions matter — a large tool schema set is often
 * a substantial fraction of a Claude Code request's input.
 *
 * Pure and synchronous. It performs no provider call, which is what makes
 * /v1/messages/count_tokens safe to serve without generating anything.
 */
export function countRequestInputTokens(request: CanonicalRequest): number {
  let total = 0;

  if (request.system !== null) {
    total += MESSAGE_OVERHEAD_TOKENS + countText(request.system);
  }

  for (const message of request.messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    for (const content of message.content) {
      total += countContent(content);
    }
  }

  for (const tool of request.tools) {
    total += TOOL_OVERHEAD_TOKENS;
    total += countText(tool.name);
    if (tool.description !== null) {
      total += countText(tool.description);
    }
    total += countText(safeJson(tool.inputSchema));
  }

  for (const stop of request.stopSequences) {
    total += countText(stop);
  }

  return total;
}

/**
 * Output-token estimate from generated text, for the fallback path.
 *
 * Streaming chunk boundaries are transport details, not billing inputs. Join the
 * observed text before rounding so the same response always receives the same
 * estimate whether it arrived as one chunk or one character at a time.
 */
export function countOutputTokens(segments: readonly string[]): number {
  return countText(segments.join(""));
}
