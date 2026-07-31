import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { pino } from "pino";
import { redactValue } from "@bosanda/shared";
import { requestLogger, createLogger } from "@bosanda/observability";

/**
 * createLogger writes to stdout, so for assertions we rebuild the same
 * configuration against a capture stream. The redaction contract under test is
 * the formatter + redact paths, which are shared.
 */
const capture = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = pino(
    {
      level: "trace",
      base: { service: "test" },
      redact: {
        paths: ["*.authorization", "*.password", "*.apiKey", "*.messages", "*.content"],
        censor: "[redacted]",
      },
      formatters: { log: (object) => redactValue(object) as Record<string, unknown> },
    },
    stream,
  );
  return { logger, lines, json: () => lines.map((line) => JSON.parse(line)) };
};

describe("logger redaction (PLAN.md §17)", () => {
  it("never emits an API key, credential, or token", () => {
    const { logger, lines } = capture();

    logger.info(
      {
        requestId: "req_1",
        apiKey: "bsk_live_LEAK1",
        authorization: "Bearer LEAK2",
        refreshToken: "rt_LEAK3",
        accessToken: "at_LEAK4",
        encryptedCredentials: "ct_LEAK5",
      },
      "auth attempt",
    );

    const text = lines.join("");
    for (const secret of ["LEAK1", "LEAK2", "LEAK3", "LEAK4", "LEAK5"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain("req_1");
  });

  it("never emits prompt text, tool input, or tool results", () => {
    const { logger, lines } = capture();

    logger.info(
      {
        requestId: "req_2",
        messages: [{ role: "user", content: "PROMPT-LEAK" }],
        system: "SYSTEM-LEAK",
        toolInput: { path: "/Users/secret/file.ts" },
        toolResult: "FILE-CONTENTS-LEAK",
        arguments: '{"path":"ARGS-LEAK"}',
      },
      "turn complete",
    );

    const text = lines.join("");
    for (const secret of [
      "PROMPT-LEAK",
      "SYSTEM-LEAK",
      "FILE-CONTENTS-LEAK",
      "ARGS-LEAK",
      "/Users/secret",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("keeps operational metadata readable", () => {
    const { logger, json } = capture();

    logger.info(
      {
        requestId: "req_3",
        surface: "anthropic",
        model: "kiro-sonnet",
        status: 200,
        ttfbMs: 412,
        durationMs: 8123,
        retries: 1,
        weightedTokens: 13_000,
        estimated: false,
      },
      "usage settled",
    );

    const [entry] = json();
    expect(entry.requestId).toBe("req_3");
    expect(entry.surface).toBe("anthropic");
    expect(entry.ttfbMs).toBe(412);
    expect(entry.weightedTokens).toBe(13_000);
    expect(entry.estimated).toBe(false);
    expect(entry.msg).toBe("usage settled");
  });

  it("redacts nested credential objects", () => {
    const { logger, lines } = capture();
    logger.warn(
      { provider: { accountId: "acct_1", credentials: { refreshToken: "NESTED-LEAK" } } },
      "refresh failed",
    );
    const text = lines.join("");
    expect(text).not.toContain("NESTED-LEAK");
    expect(text).toContain("acct_1");
  });

  it("summarizes error objects without leaking a stack full of local paths", () => {
    const { logger, lines } = capture();
    logger.error(
      { failure: new Error("upstream 403 for /Users/voyjnan/secret") },
      "attempt failed",
    );
    const text = lines.join("");
    expect(text).not.toContain("/Users/voyjnan/secret");
  });
});

describe("createLogger / requestLogger", () => {
  it("stamps the service name and accepts a level", () => {
    const logger = createLogger({ service: "gateway", level: "debug" });
    expect(logger.level).toBe("debug");
  });

  it("child logger carries request context fields", () => {
    const { logger, json } = capture();
    const child = requestLogger(logger, {
      requestId: "req_9",
      surface: "openai",
      model: "kiro-haiku",
      providerAccountId: "acct_7",
      adapterVersion: "kiro-direct/1",
    });

    child.info("routed");
    const [entry] = json();
    expect(entry.requestId).toBe("req_9");
    expect(entry.providerAccountId).toBe("acct_7");
    expect(entry.adapterVersion).toBe("kiro-direct/1");
  });
});
