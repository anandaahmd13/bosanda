/**
 * `POST /v1/messages/count_tokens` (PLAN.md §8: "Local count/estimate; never
 * invokes generation").
 *
 * The whole point of this endpoint is that it is LOCAL. It must never reach a
 * provider, never lease a provider account, never consume quota and never
 * generate a token. That guarantee is structural here, not a convention: this
 * module imports `countRequestInputTokens` from @bosanda/metering — which is a
 * pure, synchronous function (§10) — and imports nothing that can perform I/O.
 * There is no adapter, no scheduler and no fetch in this file's import graph.
 *
 * The count is a documented heuristic, not BPE. @bosanda/metering's counter
 * header explains the tradeoff and stamps COUNTER_VERSION so a later change to
 * the method stays explainable.
 */

import type { CanonicalRequest } from "@bosanda/protocol";
import { COUNTER_VERSION, countRequestInputTokens } from "@bosanda/metering";
import { decodeCountTokensRequest, type DecodeOptions, type HeaderLike } from "./decode.js";

/** Anthropic's documented response shape for this endpoint. */
export type CountTokensResponse = {
  input_tokens: number;
};

/**
 * The counter version behind a response, for logging and support. Deliberately
 * NOT part of the wire body: Anthropic's response is `{ input_tokens }` only,
 * and this surface's job is fidelity.
 */
export function counterVersion(): string {
  return COUNTER_VERSION;
}

/** Counts tokens for an already-decoded canonical request. Pure. */
export function countTokensForRequest(request: CanonicalRequest): CountTokensResponse {
  return { input_tokens: countRequestInputTokens(request) };
}

/**
 * Full endpoint path: validate `anthropic-version`, decode, enforce limits, count.
 *
 * Synchronous by design — a synchronous signature cannot await a provider, so
 * the "never invokes generation" guarantee is visible in the type.
 */
export function countTokens(
  body: unknown,
  headers: HeaderLike,
  options: DecodeOptions = {},
): CountTokensResponse {
  const request = decodeCountTokensRequest(body, headers, options);
  return countTokensForRequest(request);
}
