import { describe, expect, it } from "vitest";
import {
  BosandaError,
  statusForCode,
  publicMessageForCode,
  type ErrorCode,
} from "@bosanda/protocol";

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

describe("error mapping table (PLAN.md §8)", () => {
  it("maps each code to the documented HTTP status", () => {
    expect(statusForCode("invalid_request")).toBe(400);
    expect(statusForCode("unsupported_capability")).toBe(400);
    expect(statusForCode("authentication_error")).toBe(401);
    expect(statusForCode("model_not_allowed")).toBe(403);
    expect(statusForCode("not_found")).toBe(404);
    expect(statusForCode("conflict")).toBe(409);
    expect(statusForCode("rate_limit")).toBe(429);
    expect(statusForCode("concurrency_limit")).toBe(429);
    expect(statusForCode("quota_exhausted")).toBe(429);
    expect(statusForCode("internal_error")).toBe(500);
    expect(statusForCode("upstream_incompatible")).toBe(502);
    expect(statusForCode("no_healthy_provider")).toBe(503);
    expect(statusForCode("adapter_disabled")).toBe(503);
    expect(statusForCode("upstream_timeout")).toBe(504);
  });

  it("gives every code a non-empty public message", () => {
    for (const code of ALL_CODES) {
      expect(publicMessageForCode(code).length, code).toBeGreaterThan(0);
    }
  });
});

describe("BosandaError", () => {
  it("keeps internal detail out of the client-visible message", () => {
    const error = new BosandaError("upstream_incompatible", {
      internalDetail: "profileArn xyz rejected by runtime.us-east-1.kiro.dev",
    });

    expect(error.publicMessage).toBe("The upstream provider returned an incompatible response.");
    expect(error.publicMessage).not.toContain("profileArn");
    expect(error.publicMessage).not.toContain("kiro.dev");
    // Operator-facing channel still has the detail.
    expect(error.message).toContain("profileArn");
    expect(error.status).toBe(502);
  });

  it("carries retry-after and provider attribution when supplied", () => {
    const error = new BosandaError("rate_limit", {
      retryAfterSeconds: 12,
      providerAccountId: "acct_1",
    });
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.providerAccountId).toBe("acct_1");
  });

  it("marks only upstream/capacity failures as provider-retryable", () => {
    const retryable: ErrorCode[] = [
      "upstream_incompatible",
      "upstream_timeout",
      "no_healthy_provider",
      "internal_error",
    ];
    for (const code of ALL_CODES) {
      expect(new BosandaError(code).isProviderRetryable, code).toBe(retryable.includes(code));
    }
  });

  it("never retries client-caused failures onto another account", () => {
    for (const code of [
      "invalid_request",
      "authentication_error",
      "model_not_allowed",
      "quota_exhausted",
      "rate_limit",
      "concurrency_limit",
      "adapter_disabled",
    ] as ErrorCode[]) {
      expect(new BosandaError(code).isProviderRetryable, code).toBe(false);
    }
  });

  it("cools down a provider only for upstream-fault classes", () => {
    expect(new BosandaError("upstream_incompatible").shouldCooldownProvider).toBe(true);
    expect(new BosandaError("upstream_timeout").shouldCooldownProvider).toBe(true);
    expect(new BosandaError("rate_limit").shouldCooldownProvider).toBe(true);
    expect(new BosandaError("invalid_request").shouldCooldownProvider).toBe(false);
    expect(new BosandaError("quota_exhausted").shouldCooldownProvider).toBe(false);
  });

  it("passes through an existing BosandaError unchanged", () => {
    const original = new BosandaError("conflict");
    expect(BosandaError.from(original)).toBe(original);
  });

  it("wraps unknown throwables as internal_error while preserving the cause", () => {
    const cause = new Error("socket hang up");
    const wrapped = BosandaError.from(cause);
    expect(wrapped.code).toBe("internal_error");
    expect(wrapped.status).toBe(500);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.internalDetail).toBe("socket hang up");
  });

  it("honours an explicit fallback code and handles non-Error throwables", () => {
    const wrapped = BosandaError.from("weird string", "upstream_incompatible");
    expect(wrapped.code).toBe("upstream_incompatible");
    expect(wrapped.internalDetail).toBe("unknown error");
  });

  it("is a real Error subclass so instanceof and stack survive", () => {
    const error = new BosandaError("internal_error");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BosandaError");
    expect(error.stack).toBeTruthy();
  });
});
