/**
 * BosandaError -> the OpenAI error envelope (PLAN.md §8 "Error mapping").
 *
 * SECURITY (PLAN.md §12/§16): `message` is `BosandaError.publicMessage` and nothing
 * else. `internalDetail`, `cause`, the stack, any upstream response body, and any
 * provider account ID are operator-only and must never cross the client boundary, so
 * this module never reads them. `param` is only ever what the CALLER passes in
 * explicitly — it is never derived from the error, which is what makes the leak
 * impossible by construction rather than by review.
 */

import { BosandaError, type ErrorCode } from "@bosanda/protocol";

/**
 * OpenAI's `error.type` families. Clients switch on HTTP status far more than on
 * this string, but SDKs surface it, so the value should read as OpenAI's own
 * vocabulary rather than ours.
 */
export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "insufficient_quota"
  | "rate_limit_error"
  | "api_error"
  | "server_error";

export type OpenAIErrorEnvelope = {
  error: {
    message: string;
    type: OpenAIErrorType;
    /** Offending request field, when the caller knows it. Otherwise null. */
    param: string | null;
    /** The Bosanda ErrorCode: stable, machine-readable, and leaks nothing. */
    code: ErrorCode;
  };
};

/**
 * ErrorCode -> OpenAI type. `not_found` maps to `invalid_request_error` because that
 * is what real OpenAI returns for an unknown model, and `quota_exhausted` maps to
 * `insufficient_quota`, which OpenAI uses as both type and code.
 */
const TYPE_BY_CODE: Record<ErrorCode, OpenAIErrorType> = {
  invalid_request: "invalid_request_error",
  unsupported_capability: "invalid_request_error",
  authentication_error: "authentication_error",
  model_not_allowed: "permission_error",
  not_found: "invalid_request_error",
  conflict: "invalid_request_error",
  quota_exhausted: "insufficient_quota",
  rate_limit: "rate_limit_error",
  concurrency_limit: "rate_limit_error",
  internal_error: "server_error",
  upstream_incompatible: "api_error",
  no_healthy_provider: "server_error",
  adapter_disabled: "server_error",
  upstream_timeout: "api_error",
};

export function openAIErrorType(code: ErrorCode): OpenAIErrorType {
  return TYPE_BY_CODE[code];
}

/**
 * Build the OpenAI error envelope. Accepts `unknown` so a route can funnel any
 * throwable through one path: a non-BosandaError becomes `internal_error`, whose
 * public message is generic, so an unexpected exception's text cannot escape.
 */
export function encodeError(error: unknown, param: string | null = null): OpenAIErrorEnvelope {
  const bosanda = BosandaError.from(error);
  return {
    error: {
      message: bosanda.publicMessage,
      type: openAIErrorType(bosanda.code),
      param,
      code: bosanda.code,
    },
  };
}

/** HTTP status for the envelope, taken from the canonical code (never from upstream). */
export function encodeErrorStatus(error: unknown): number {
  return BosandaError.from(error).status;
}

/**
 * Mid-stream failure frame (PLAN.md §8: "After headers/events start, emit the closest
 * protocol-specific stream error when possible and close the connection").
 *
 * OpenAI has no first-class stream error event; the de-facto convention is one
 * `data:` frame carrying the same envelope. No `[DONE]` follows — the turn did not
 * complete, and claiming otherwise would tell the client the response was whole.
 */
export function encodeErrorEvent(error: unknown, param: string | null = null): string {
  return `data: ${JSON.stringify(encodeError(error, param))}\n\n`;
}
