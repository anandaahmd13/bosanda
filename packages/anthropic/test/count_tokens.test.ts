import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countRequestInputTokens } from "@bosanda/metering";
import { BosandaError } from "@bosanda/protocol";
import {
  countTokens,
  countTokensForRequest,
  counterVersion,
  decodeCountTokensRequest,
} from "@bosanda/anthropic";

const V = { "anthropic-version": "2023-06-01" };

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "bosanda-sonnet",
    messages: [{ role: "user", content: "hello there" }],
    ...overrides,
  };
}

const srcPath = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url));

describe("count_tokens: correctness (PLAN.md §8, §10)", () => {
  it("returns the metering package's own count for the decoded request", () => {
    const request = decodeCountTokensRequest(body(), V);
    expect(countTokens(body(), V)).toEqual({ input_tokens: countRequestInputTokens(request) });
  });

  it("responds with exactly Anthropic's shape: input_tokens only", () => {
    expect(Object.keys(countTokens(body(), V))).toEqual(["input_tokens"]);
  });

  it("returns a positive integer", () => {
    const { input_tokens } = countTokens(body(), V);
    expect(Number.isInteger(input_tokens)).toBe(true);
    expect(input_tokens).toBeGreaterThan(0);
  });

  it("counts the system prompt", () => {
    const withSystem = countTokens(body({ system: "You are a careful assistant." }), V);
    expect(withSystem.input_tokens).toBeGreaterThan(countTokens(body(), V).input_tokens);
  });

  it("counts tool definitions, which dominate a Claude Code request", () => {
    const tools = [
      {
        name: "read_file",
        description: "Read a file from disk",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, limit: { type: "number" } },
          required: ["path"],
        },
      },
    ];
    expect(countTokens(body({ tools }), V).input_tokens).toBeGreaterThan(
      countTokens(body(), V).input_tokens,
    );
  });

  it("grows monotonically with history length", () => {
    const short = countTokens(body(), V).input_tokens;
    const long = countTokens(
      body({
        messages: [
          { role: "user", content: "hello there" },
          { role: "assistant", content: "Hi. How can I help?" },
          { role: "user", content: "Explain streaming SSE framing in detail." },
        ],
      }),
      V,
    ).input_tokens;
    expect(long).toBeGreaterThan(short);
  });

  it("is deterministic: the same body always yields the same count", () => {
    expect(countTokens(body(), V)).toEqual(countTokens(body(), V));
  });

  it("counts a block-array tool_result the same way the decoder flattened it", () => {
    const request = decodeCountTokensRequest(
      body({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "abc" }] },
            ],
          },
        ],
      }),
      V,
    );
    expect(countTokensForRequest(request)).toEqual({
      input_tokens: countRequestInputTokens(request),
    });
  });

  it("does NOT require max_tokens, which /v1/messages does", () => {
    expect(() => countTokens(body(), V)).not.toThrow();
  });

  it("still enforces the version header", () => {
    try {
      countTokens(body(), {});
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).code).toBe("invalid_request");
    }
  });

  it("still enforces request limits before counting", () => {
    try {
      countTokens(body({ messages: [] }), V);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as BosandaError).code).toBe("invalid_request");
    }
  });

  it("exposes the counter version for logging, but keeps it off the wire", () => {
    expect(counterVersion()).toBe("heuristic-2");
    expect("counter_version" in countTokens(body(), V)).toBe(false);
  });
});

describe("count_tokens NEVER reaches a provider (§8: local count, never invokes generation)", () => {
  it("is synchronous, so it cannot await a provider call", () => {
    const result = countTokens(body(), V) as unknown;
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("imports no provider, adapter, scheduler, or HTTP client", () => {
    // A structural assertion: the guarantee is enforced by the import graph, not
    // by a convention a later edit could quietly break.
    const source = readFileSync(srcPath("count_tokens.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

    expect(imports).toContain("@bosanda/metering");
    for (const forbidden of [
      "@bosanda/provider-core",
      "@bosanda/provider-kiro",
      "undici",
      "node:http",
      "node:https",
      "node:net",
    ]) {
      expect(imports).not.toContain(forbidden);
    }
  });

  it("uses countRequestInputTokens and contains no fetch or await in real code", () => {
    const source = readFileSync(srcPath("count_tokens.ts"), "utf8");
    expect(source).toContain("countRequestInputTokens");

    // Comments legitimately discuss fetch and await; strip them so this asserts
    // against executable code rather than prose.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toMatch(/\basync\b/);
  });

  it("survives with globalThis.fetch removed, proving no network dependency", () => {
    const original = globalThis.fetch;
    // If any code path tried to reach a provider, this would throw.
    (globalThis as { fetch?: unknown }).fetch = () => {
      throw new Error("count_tokens must never perform network I/O");
    };
    try {
      expect(countTokens(body(), V).input_tokens).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("counts a large tool-heavy request without any provider present", () => {
    const tools = Array.from({ length: 20 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool number ${index}`,
      input_schema: { type: "object", properties: { arg: { type: "string" } } },
    }));
    expect(countTokens(body({ tools }), V).input_tokens).toBeGreaterThan(100);
  });
});
