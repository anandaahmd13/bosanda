/**
 * BosandaError -> the OpenAI error envelope (PLAN.md §8 "Error mapping").
 *
 * The load-bearing assertions here are negative: nothing operator-only may cross
 * the client boundary (§12/§16). Those run over EVERY ErrorCode, not a sample,
 * so a code added later cannot quietly acquire a leak.
 */

import { describe, expect, it } from "vitest";
import { BosandaError, statusForCode, type ErrorCode } from "@bosanda/protocol";
import {
  DONE_FRAME,
  encodeError,
  encodeErrorEvent,
  encodeErrorStatus,
  openAIErrorType,
} from "@bosanda/openai";

/** Every ErrorCode in the frozen union (@bosanda/protocol). */
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

/** Operator-only strings planted in the error; none may appear in the envelope. */
const SECRETS = {
  internalDetail:
    "upstream 403 for provider account acct_01JQ; refresh token bsk_LEAKED; body: {denied}",
  accountId: "acct_01JQZZ",
};

function plantedError(code: ErrorCode): BosandaError {
  return new BosandaError(code, {
    internalDetail: SECRETS.internalDetail,
    providerAccountId: SECRETS.accountId,
    cause: new Error("inner cause with a stack"),
  });
}

describe("encodeError — envelope shape", () => {
  it("produces the OpenAI error envelope", () => {
    const envelope = encodeError(new BosandaError("invalid_request"));
    expect(envelope).toEqual({
      error: {
        message: "The request was invalid.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request",
      },
    });
  });

  it("has exactly the four documented keys and nothing else", () => {
    const envelope = encodeError(plantedError("internal_error"));
    expect(Object.keys(envelope)).toEqual(["error"]);
    expect(Object.keys(envelope.error).sort()).toEqual(["code", "message", "param", "type"]);
  });

  it("uses publicMessage as the message for every code", () => {
    for (const code of ALL_CODES) {
      const error = plantedError(code);
      expect(encodeError(error).error.message).toBe(error.publicMessage);
    }
  });

  it("carries the caller-supplied param and defaults it to null", () => {
    expect(encodeError(new BosandaError("invalid_request"), "max_tokens").error.param).toBe(
      "max_tokens",
    );
    expect(encodeError(new BosandaError("invalid_request")).error.param).toBeNull();
  });

  it("reports the Bosanda code as the machine-readable code", () => {
    for (const code of ALL_CODES) {
      expect(encodeError(new BosandaError(code)).error.code).toBe(code);
    }
  });
});

describe("encodeError — type mapping", () => {
  it("maps each code to an OpenAI error type family", () => {
    const expected: Record<ErrorCode, string> = {
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
    for (const code of ALL_CODES) {
      expect(openAIErrorType(code)).toBe(expected[code]);
      expect(encodeError(new BosandaError(code)).error.type).toBe(expected[code]);
    }
  });
});

describe("encodeErrorStatus", () => {
  it("takes the status from the canonical code, never from upstream", () => {
    for (const code of ALL_CODES) {
      expect(encodeErrorStatus(plantedError(code))).toBe(statusForCode(code));
    }
  });

  it("maps the §8 status table", () => {
    expect(encodeErrorStatus(new BosandaError("invalid_request"))).toBe(400);
    expect(encodeErrorStatus(new BosandaError("unsupported_capability"))).toBe(400);
    expect(encodeErrorStatus(new BosandaError("authentication_error"))).toBe(401);
    expect(encodeErrorStatus(new BosandaError("model_not_allowed"))).toBe(403);
    expect(encodeErrorStatus(new BosandaError("not_found"))).toBe(404);
    expect(encodeErrorStatus(new BosandaError("conflict"))).toBe(409);
    expect(encodeErrorStatus(new BosandaError("quota_exhausted"))).toBe(429);
    expect(encodeErrorStatus(new BosandaError("rate_limit"))).toBe(429);
    expect(encodeErrorStatus(new BosandaError("concurrency_limit"))).toBe(429);
    expect(encodeErrorStatus(new BosandaError("internal_error"))).toBe(500);
    expect(encodeErrorStatus(new BosandaError("upstream_incompatible"))).toBe(502);
    expect(encodeErrorStatus(new BosandaError("no_healthy_provider"))).toBe(503);
    expect(encodeErrorStatus(new BosandaError("adapter_disabled"))).toBe(503);
    expect(encodeErrorStatus(new BosandaError("upstream_timeout"))).toBe(504);
  });
});

describe("encodeError — no operator-only data ever reaches the client", () => {
  it("never includes internalDetail, for any code", () => {
    for (const code of ALL_CODES) {
      const json = JSON.stringify(encodeError(plantedError(code)));
      expect(json).not.toContain(SECRETS.internalDetail);
      expect(json).not.toContain("bsk_LEAKED");
      expect(json).not.toContain("upstream 403");
      expect(json).not.toContain("{denied}");
    }
  });

  it("never includes the provider account ID", () => {
    for (const code of ALL_CODES) {
      expect(JSON.stringify(encodeError(plantedError(code)))).not.toContain(SECRETS.accountId);
    }
  });

  it("never includes a stack trace or the cause", () => {
    for (const code of ALL_CODES) {
      const json = JSON.stringify(encodeError(plantedError(code)));
      expect(json).not.toContain("stack");
      expect(json).not.toContain("at ");
      expect(json).not.toContain("inner cause");
    }
  });

  it("never includes Error.message, which carries internal detail", () => {
    const error = plantedError("upstream_incompatible");
    // BosandaError puts internalDetail into .message for logs.
    expect(error.message).toContain(SECRETS.internalDetail);
    expect(JSON.stringify(encodeError(error))).not.toContain(error.message);
  });

  it("does not derive param from the error, so no field name can leak that way", () => {
    const error = plantedError("invalid_request");
    expect(encodeError(error).error.param).toBeNull();
  });
});

describe("encodeError — non-BosandaError inputs", () => {
  it("funnels an arbitrary Error into internal_error without leaking its text", () => {
    const raw = new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    const envelope = encodeError(raw);
    expect(envelope.error.code).toBe("internal_error");
    expect(envelope.error.type).toBe("server_error");
    expect(envelope.error.message).toBe("An internal error occurred.");
    expect(JSON.stringify(envelope)).not.toContain("hunter2");
    expect(JSON.stringify(envelope)).not.toContain("ECONNREFUSED");
    expect(encodeErrorStatus(raw)).toBe(500);
  });

  it("handles non-Error throwables", () => {
    for (const thrown of ["a string", 42, null, undefined, { secret: "value" }]) {
      const envelope = encodeError(thrown);
      expect(envelope.error.code).toBe("internal_error");
      expect(envelope.error.message).toBe("An internal error occurred.");
      expect(JSON.stringify(envelope)).not.toContain("secret");
    }
  });
});

describe("encodeErrorEvent — mid-stream failure", () => {
  it("emits a single data: frame carrying the envelope", () => {
    const frame = encodeErrorEvent(new BosandaError("upstream_timeout"));
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.slice(6, -2))).toEqual({
      error: {
        message: "The upstream provider timed out.",
        type: "api_error",
        param: null,
        code: "upstream_timeout",
      },
    });
  });

  it("does not append [DONE], because the turn did not complete", () => {
    // Claiming completion would tell the client a truncated response was whole.
    const frame = encodeErrorEvent(new BosandaError("upstream_incompatible"));
    expect(frame).not.toContain("[DONE]");
    expect(frame).not.toBe(DONE_FRAME);
  });

  it("leaks nothing mid-stream either", () => {
    for (const code of ALL_CODES) {
      const frame = encodeErrorEvent(plantedError(code));
      expect(frame).not.toContain(SECRETS.internalDetail);
      expect(frame).not.toContain(SECRETS.accountId);
      expect(frame).not.toContain("inner cause");
    }
  });

  it("passes param through when supplied", () => {
    const frame = encodeErrorEvent(new BosandaError("invalid_request"), "messages");
    expect(JSON.parse(frame.slice(6, -2)).error.param).toBe("messages");
  });
});
