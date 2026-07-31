import { describe, expect, it } from "vitest";
import {
  BosandaError,
  publicMessageForCode,
  statusForCode,
  type ErrorCode,
} from "@bosanda/protocol";
import {
  anthropicErrorType,
  encodeErrorEvent,
  encodeErrorSse,
  statusForError,
  toAnthropicError,
} from "@bosanda/anthropic";

const ALL_CODES: ErrorCode[] = [
  "invalid_request",
  "unsupported_capability",
  "authentication_error",
  "model_not_allowed",
  "not_found",
  "conflict",
  "quota_exhausted",
  "rate_limit",
  "concurrency_limit",
  "internal_error",
  "upstream_incompatible",
  "no_healthy_provider",
  "adapter_disabled",
  "upstream_timeout",
];

describe("error envelope shape (§8)", () => {
  it("renders { type: 'error', error: { type, message } }", () => {
    const body = toAnthropicError(new BosandaError("invalid_request"));
    expect(body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "The request was invalid." },
    });
  });

  it("has exactly the documented keys and no extras", () => {
    const body = toAnthropicError(new BosandaError("internal_error"));
    expect(Object.keys(body).sort()).toEqual(["error", "type"]);
    expect(Object.keys(body.error).sort()).toEqual(["message", "type"]);
  });

  it.each(ALL_CODES)("maps %s to an Anthropic error type name", (code) => {
    const body = toAnthropicError(new BosandaError(code));
    expect(body.error.type).toBe(anthropicErrorType(code));
    expect(body.error.type).toMatch(/_error$/);
  });

  it("maps each status class to the name Anthropic clients expect", () => {
    expect(anthropicErrorType("invalid_request")).toBe("invalid_request_error");
    expect(anthropicErrorType("unsupported_capability")).toBe("invalid_request_error");
    expect(anthropicErrorType("authentication_error")).toBe("authentication_error");
    expect(anthropicErrorType("model_not_allowed")).toBe("permission_error");
    expect(anthropicErrorType("not_found")).toBe("not_found_error");
    expect(anthropicErrorType("rate_limit")).toBe("rate_limit_error");
    expect(anthropicErrorType("quota_exhausted")).toBe("rate_limit_error");
    expect(anthropicErrorType("concurrency_limit")).toBe("rate_limit_error");
    expect(anthropicErrorType("internal_error")).toBe("api_error");
    expect(anthropicErrorType("upstream_incompatible")).toBe("api_error");
    expect(anthropicErrorType("upstream_timeout")).toBe("api_error");
    expect(anthropicErrorType("no_healthy_provider")).toBe("overloaded_error");
    expect(anthropicErrorType("adapter_disabled")).toBe("overloaded_error");
  });

  it("keeps the HTTP status from the frozen protocol mapping", () => {
    for (const code of ALL_CODES) {
      expect(statusForError(new BosandaError(code))).toBe(statusForCode(code));
    }
    expect(statusForError(new BosandaError("model_not_allowed"))).toBe(403);
    expect(statusForError(new BosandaError("no_healthy_provider"))).toBe(503);
    expect(statusForError(new BosandaError("upstream_timeout"))).toBe(504);
  });
});

describe("ONLY publicMessage crosses the client boundary (§12/§16)", () => {
  it.each(ALL_CODES)("uses the code's public message verbatim for %s", (code) => {
    expect(toAnthropicError(new BosandaError(code)).error.message).toBe(publicMessageForCode(code));
  });

  it("never leaks internalDetail", () => {
    const detail = "kiro account acct_9f3 refresh failed: token expired at /var/lib/bosanda/creds";
    const body = toAnthropicError(new BosandaError("internal_error", { internalDetail: detail }));

    expect(JSON.stringify(body)).not.toContain(detail);
    expect(JSON.stringify(body)).not.toContain("acct_9f3");
    expect(JSON.stringify(body)).not.toContain("/var/lib/bosanda");
    expect(body.error.message).toBe("An internal error occurred.");
  });

  it("never leaks a provider account id", () => {
    const body = toAnthropicError(
      new BosandaError("no_healthy_provider", {
        providerAccountId: "acct_secret_123",
        internalDetail: "all accounts cooling down",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("acct_secret_123");
  });

  it("never leaks a stack trace or the cause chain", () => {
    const cause = new Error("ECONNREFUSED 10.0.0.5:443");
    const body = toAnthropicError(
      new BosandaError("upstream_incompatible", { cause, internalDetail: "upstream gave HTML" }),
    );
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("10.0.0.5");
    expect(serialized).not.toContain("at ");
    expect(serialized).not.toContain("stack");
  });

  it("never leaks an upstream response body", () => {
    const upstream = '{"__type":"ThrottlingException","message":"Rate exceeded for account 42"}';
    const body = toAnthropicError(
      new BosandaError("upstream_incompatible", { internalDetail: `upstream body: ${upstream}` }),
    );
    expect(JSON.stringify(body)).not.toContain("ThrottlingException");
    expect(JSON.stringify(body)).not.toContain("account 42");
  });

  it("sanitizes an arbitrary non-Bosanda throw into a generic 500", () => {
    const raw = new Error("plaintext key bsk_ABCDEFGH01234567890123456789012345678901");
    const body = toAnthropicError(raw);

    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("An internal error occurred.");
    expect(JSON.stringify(body)).not.toContain("bsk_");
    expect(statusForError(raw)).toBe(500);
  });

  it("sanitizes a thrown string and a thrown object", () => {
    for (const thrown of ["secret-string", { secret: "value" }, null, undefined]) {
      const body = toAnthropicError(thrown);
      expect(body.error.message).toBe("An internal error occurred.");
      expect(JSON.stringify(body)).not.toContain("secret");
    }
  });

  it("carries no field beyond type and message, so nothing can ride along", () => {
    const body = toAnthropicError(
      new BosandaError("rate_limit", { internalDetail: "rpm 61/60", retryAfterSeconds: 30 }),
    );
    // retryAfterSeconds belongs in the Retry-After header, not the body.
    expect(JSON.stringify(body)).not.toContain("30");
    expect(Object.keys(body.error)).toHaveLength(2);
  });
});

describe("mid-stream error frame (§8)", () => {
  it("is an SSE frame with an event: line and the error envelope", () => {
    const frame = encodeErrorEvent(new BosandaError("upstream_timeout"));
    expect(frame.event).toBe("error");
    expect(JSON.parse(frame.data)).toEqual({
      type: "error",
      error: { type: "api_error", message: "The upstream provider timed out." },
    });
  });

  it("renders wire text with both lines", () => {
    const text = encodeErrorSse(new BosandaError("rate_limit"));
    expect(text.startsWith("event: error\n")).toBe(true);
    expect(text).toContain("\ndata: ");
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("leaks nothing mid-stream either", () => {
    const text = encodeErrorSse(
      new BosandaError("upstream_timeout", {
        internalDetail: "idle 61s on acct_abc",
        providerAccountId: "acct_abc",
      }),
    );
    expect(text).not.toContain("acct_abc");
    expect(text).not.toContain("idle 61s");
  });
});
