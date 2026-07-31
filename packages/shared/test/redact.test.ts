import { describe, expect, it } from "vitest";
import {
  maskApiKey,
  redactHeaders,
  redactValue,
  isSensitiveKey,
  scrubPaths,
  REDACTED,
} from "@bosanda/shared";

describe("redactHeaders", () => {
  it("keeps allowlisted headers and drops everything else by name", () => {
    const safe = redactHeaders({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: "Bearer sk-super-secret",
      "x-api-key": "bsk_live_abcdef",
      cookie: "session=abc",
    });

    expect(safe["content-type"]).toBe("application/json");
    expect(safe["anthropic-version"]).toBe("2023-06-01");
    expect(safe.authorization).toBeUndefined();
    expect(safe["x-api-key"]).toBeUndefined();
    expect(safe["x-dropped-headers"]).toBe("authorization,cookie,x-api-key");
  });

  it("never leaks a secret value anywhere in the output", () => {
    const serialized = JSON.stringify(
      redactHeaders({ authorization: "Bearer sk-leak-me", cookie: "s=leak-me-too" }),
    );
    expect(serialized).not.toContain("leak-me");
  });

  it("joins array header values for allowlisted names", () => {
    expect(redactHeaders({ accept: ["a/b", "c/d"] }).accept).toBe("a/b,c/d");
  });
});

describe("maskApiKey", () => {
  it("keeps the prefix and hides the entropy tail", () => {
    expect(maskApiKey("bsk_9f8e7d6c5b4a3210")).toBe("bsk_********");
  });

  it("masks fully when there is no prefix separator", () => {
    expect(maskApiKey("rawsecretvalue")).toBe("********");
  });
});

describe("redactValue", () => {
  it("replaces sensitive keys wholesale rather than truncating", () => {
    const out = redactValue({
      requestId: "req_123",
      password: "hunter2",
      refresh_token: "rt_abc",
      messages: [{ role: "user", content: "my private prompt" }],
      nested: { apiKey: "bsk_x", safe: 5 },
    }) as Record<string, unknown>;

    expect(out.requestId).toBe("req_123");
    expect(out.password).toBe(REDACTED);
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.messages).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).safe).toBe(5);
  });

  it("does not leak prompt text through any path", () => {
    const serialized = JSON.stringify(
      redactValue({ messages: [{ content: "SECRET-PROMPT" }], tool_result: "SECRET-RESULT" }),
    );
    expect(serialized).not.toContain("SECRET-PROMPT");
    expect(serialized).not.toContain("SECRET-RESULT");
  });

  it("summarizes binary, long strings, big arrays, and deep objects", () => {
    expect(redactValue(Buffer.alloc(12))).toBe("[binary 12 bytes]");
    expect(redactValue("x".repeat(300))).toContain("[300 chars]");
    expect(redactValue(new Array(25).fill(1))).toBe("[array 25 items]");

    let deep: unknown = "bottom";
    for (let i = 0; i < 10; i += 1) deep = { level: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[depth-limit]");
  });

  it("redacts error objects to name and message only", () => {
    const err = new Error("boom");
    const out = redactValue(err) as Record<string, unknown>;
    expect(out).toEqual({ name: "Error", message: "boom" });
    expect(out.stack).toBeUndefined();
  });

  it("passes through primitives and null/undefined unchanged", () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
  });
});

describe("isSensitiveKey", () => {
  it("flags the credential and content families from PLAN.md §17", () => {
    for (const key of [
      "authorization",
      "Cookie",
      "x-api-key",
      "password",
      "clientSecret",
      "refreshToken",
      "encrypted_credentials",
      "lookup_digest",
      "prompt",
      "tool_result",
      "arguments",
      "profileArn",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("matches regardless of casing or separator style", () => {
    for (const key of [
      "refresh_token",
      "refreshToken",
      "Refresh-Token",
      "REFRESH_TOKEN",
      "tool_result",
      "toolResult",
      "ToolResult",
      "api_key",
      "apiKey",
      "X-API-KEY",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("allows benign metadata keys", () => {
    for (const key of ["requestId", "model", "status", "durationMs", "ttfbMs", "retries"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("keeps token COUNTS loggable — they are metrics, not secrets (§17)", () => {
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cachedTokens",
      "weightedTokens",
      "raw_input_tokens",
      "maxTokens",
      "tokenCount",
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("still redacts bare credential-shaped token keys", () => {
    for (const key of ["token", "accessToken", "refreshToken", "idToken", "sessionToken"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });
});

describe("scrubPaths", () => {
  it("removes absolute local paths that §17 forbids in logs", () => {
    expect(scrubPaths("failed reading /Users/voyjnan/bosanda/.env")).toBe("failed reading [path]");
    expect(scrubPaths("at /home/deploy/app/main.js:12")).toContain("[path]");
    expect(scrubPaths("open /var/lib/postgresql/data")).toBe("open [path]");
    expect(scrubPaths("cd ~/secrets/keys")).toBe("cd [path]");
    expect(scrubPaths("C:\\Users\\op\\creds.txt")).toBe("[path]");
  });

  it("leaves upstream URL paths debuggable", () => {
    const url = "POST https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
    expect(scrubPaths(url)).toBe(url);
  });

  it("scrubs paths reached through redactValue, including inside errors", () => {
    const out = redactValue({
      detail: "ENOENT /Users/voyjnan/bosanda/secret.pem",
      failure: new Error("cannot open /home/deploy/id_rsa"),
    }) as Record<string, unknown>;

    expect(out.detail).toBe("ENOENT [path]");
    expect((out.failure as Record<string, unknown>).message).toBe("cannot open [path]");
    expect(JSON.stringify(out)).not.toContain("/Users/");
    expect(JSON.stringify(out)).not.toContain("/home/");
  });
});
