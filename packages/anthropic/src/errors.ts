/**
 * BosandaError -> Anthropic error envelope (PLAN.md §8 "Error mapping").
 *
 * SECURITY (PLAN.md §12/§16): only `publicMessage` crosses the client boundary.
 * `internalDetail`, `cause`, stacks, upstream bodies and provider account IDs
 * are operator-only and are never read here. That is enforced by construction:
 * this module touches `error.code` and `error.publicMessage` and nothing else.
 */

import { BosandaError, type ErrorCode } from "@bosanda/protocol";
import { formatSse, type SseFrame } from "./sse.js";

/**
 * Anthropic's documented error `type` names. Bosanda's ErrorCode union is finer
 * grained than Anthropic's, so several codes collapse onto one name; the HTTP
 * status still comes from the frozen `statusForCode` mapping, never from here.
 */
export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export type AnthropicErrorBody = {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
};

const ERROR_TYPE: Record<ErrorCode, AnthropicErrorType> = {
  // 400
  invalid_request: "invalid_request_error",
  unsupported_capability: "invalid_request_error",
  // 401
  authentication_error: "authentication_error",
  // 403 — Anthropic calls an out-of-scope resource a permission error.
  model_not_allowed: "permission_error",
  // 404
  not_found: "not_found_error",
  // 409 — Anthropic publishes no 409 type; the status stays 409 while the
  // envelope uses the closest client-recognized name.
  conflict: "invalid_request_error",
  // 429
  quota_exhausted: "rate_limit_error",
  rate_limit: "rate_limit_error",
  concurrency_limit: "rate_limit_error",
  // 500 / 502 / 504 — all "the server failed", from the client's point of view.
  internal_error: "api_error",
  upstream_incompatible: "api_error",
  upstream_timeout: "api_error",
  // 503 — Anthropic's capacity signal.
  no_healthy_provider: "overloaded_error",
  adapter_disabled: "overloaded_error",
};

export function anthropicErrorType(code: ErrorCode): AnthropicErrorType {
  return ERROR_TYPE[code];
}

/**
 * The JSON body for a non-streaming error response. Pair it with
 * `error.status` for the HTTP status line.
 */
export function toAnthropicError(error: unknown): AnthropicErrorBody {
  const bosanda = BosandaError.from(error);
  return {
    type: "error",
    error: {
      type: anthropicErrorType(bosanda.code),
      // publicMessage only — see the module header.
      message: bosanda.publicMessage,
    },
  };
}

/** HTTP status for an error response, from the frozen protocol mapping. */
export function statusForError(error: unknown): number {
  return BosandaError.from(error).status;
}

/**
 * Mid-stream error frame (PLAN.md §8: once events have started, emit the
 * protocol's own stream error and close the connection — the status line is
 * already sent, so this is the only way to tell the client).
 */
export function encodeErrorEvent(error: unknown): SseFrame {
  return { event: "error", data: JSON.stringify(toAnthropicError(error)) };
}

/** Wire-ready `event:`/`data:` text for a mid-stream error. */
export function encodeErrorSse(error: unknown): string {
  return formatSse(encodeErrorEvent(error));
}
