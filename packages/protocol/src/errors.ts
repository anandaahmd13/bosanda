/**
 * Canonical error taxonomy (PLAN.md §8 "Error mapping").
 *
 * Adapters and gateway code must classify failures into one of these codes.
 * The HTTP status and client-visible message derive from the code alone, so no
 * upstream text, credential, or payload can reach a client by accident.
 */

export type ErrorCode =
  | "invalid_request" // 400
  | "unsupported_capability" // 400
  | "authentication_error" // 401
  | "model_not_allowed" // 403
  | "not_found" // 404
  | "conflict" // 409
  | "quota_exhausted" // 429 (no remaining weighted tokens)
  | "rate_limit" // 429 (RPM)
  | "concurrency_limit" // 429 (5 active)
  | "internal_error" // 500
  | "upstream_incompatible" // 502
  | "no_healthy_provider" // 503
  | "adapter_disabled" // 503
  | "upstream_timeout"; // 504

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unsupported_capability: 400,
  authentication_error: 401,
  model_not_allowed: 403,
  not_found: 404,
  conflict: 409,
  quota_exhausted: 429,
  rate_limit: 429,
  concurrency_limit: 429,
  internal_error: 500,
  upstream_incompatible: 502,
  no_healthy_provider: 503,
  adapter_disabled: 503,
  upstream_timeout: 504,
};

/** Client-safe message per code. Never interpolate upstream text into these. */
const PUBLIC_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "The request was invalid.",
  unsupported_capability: "The request uses a capability this endpoint does not support.",
  authentication_error: "Missing, invalid, or revoked API key.",
  model_not_allowed: "This model is not available for your package.",
  not_found: "The requested resource was not found.",
  conflict: "The request conflicts with the current state of the resource.",
  quota_exhausted: "Your key has no remaining quota.",
  rate_limit: "Request rate limit exceeded.",
  concurrency_limit: "Too many concurrent requests for this key.",
  internal_error: "An internal error occurred.",
  upstream_incompatible: "The upstream provider returned an incompatible response.",
  no_healthy_provider: "No provider capacity is currently available.",
  adapter_disabled: "This model is temporarily unavailable.",
  upstream_timeout: "The upstream provider timed out.",
};

/**
 * Whether a failed attempt should let the scheduler try the NEXT provider
 * account. Only meaningful before the first byte reaches the client
 * (PLAN.md §7 retry policy).
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "upstream_incompatible",
  "upstream_timeout",
  "no_healthy_provider",
  "internal_error",
]);

export type BosandaErrorOptions = {
  /** Operator-facing detail. Logged (redacted), never sent to the client. */
  internalDetail?: string;
  cause?: unknown;
  /** Seconds; surfaced as Retry-After when present. */
  retryAfterSeconds?: number;
  /** Provider account this failure is attributed to, for health scoring. */
  providerAccountId?: string;
};

export class BosandaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly internalDetail: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly providerAccountId: string | undefined;

  constructor(code: ErrorCode, options: BosandaErrorOptions = {}) {
    // Message carries internal detail for logs; publicMessage is what clients see.
    super(options.internalDetail ? `${code}: ${options.internalDetail}` : code, {
      cause: options.cause,
    });
    this.name = "BosandaError";
    this.code = code;
    this.status = STATUS[code];
    this.publicMessage = PUBLIC_MESSAGE[code];
    this.internalDetail = options.internalDetail;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.providerAccountId = options.providerAccountId;
  }

  /** True when the scheduler may try another provider account. */
  get isProviderRetryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  /** Whether the provider account should enter cooldown after this failure. */
  get shouldCooldownProvider(): boolean {
    return (
      this.code === "upstream_incompatible" ||
      this.code === "upstream_timeout" ||
      this.code === "rate_limit"
    );
  }

  static from(error: unknown, fallback: ErrorCode = "internal_error"): BosandaError {
    if (error instanceof BosandaError) return error;
    return new BosandaError(fallback, {
      cause: error,
      internalDetail: error instanceof Error ? error.message : "unknown error",
    });
  }
}

export function statusForCode(code: ErrorCode): number {
  return STATUS[code];
}

export function publicMessageForCode(code: ErrorCode): string {
  return PUBLIC_MESSAGE[code];
}
