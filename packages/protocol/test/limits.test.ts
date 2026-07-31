import { describe, expect, it } from "vitest";
import { LIMITS, assertWithinLimits, BosandaError, type CanonicalRequest } from "@bosanda/protocol";

const base = (overrides: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  requestId: "req_test",
  surface: "anthropic",
  model: "kiro-claude-sonnet",
  system: null,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  toolChoice: null,
  stream: true,
  maxTokens: null,
  temperature: null,
  topP: null,
  stopSequences: [],
  includeUsage: false,
  ...overrides,
});

const expectInvalid = (request: CanonicalRequest) => {
  try {
    assertWithinLimits(request);
  } catch (error) {
    expect(error).toBeInstanceOf(BosandaError);
    expect((error as BosandaError).code).toBe("invalid_request");
    expect((error as BosandaError).status).toBe(400);
    return error as BosandaError;
  }
  throw new Error("expected assertWithinLimits to reject");
};

describe("assertWithinLimits", () => {
  it("accepts a minimal valid request", () => {
    expect(() => assertWithinLimits(base())).not.toThrow();
  });

  it("rejects an empty history", () => {
    expectInvalid(base({ messages: [] }));
  });

  it("enforces the message count ceiling", () => {
    const many = Array.from({ length: LIMITS.maxMessages + 1 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x" }],
    }));
    expectInvalid(base({ messages: many }));
  });

  it("enforces the total history character budget across content types", () => {
    const big = "x".repeat(LIMITS.maxHistoryChars + 1);
    expectInvalid(base({ messages: [{ role: "user", content: [{ type: "text", text: big }] }] }));

    // tool_result content counts toward the same budget.
    expectInvalid(
      base({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "t1", content: big, isError: false }],
          },
        ],
      }),
    );
  });

  it("counts reasoning and tool_use content toward the budget exactly once", () => {
    const half = "x".repeat(Math.floor(LIMITS.maxHistoryChars / 2) + 10);
    expectInvalid(
      base({
        messages: [
          { role: "assistant", content: [{ type: "reasoning", text: half }] },
          { role: "assistant", content: [{ type: "reasoning", text: half }] },
        ],
      }),
    );
  });

  it("enforces the system prompt ceiling", () => {
    expectInvalid(base({ system: "x".repeat(LIMITS.maxSystemChars + 1) }));
    expect(() => assertWithinLimits(base({ system: "x".repeat(64) }))).not.toThrow();
  });

  it("rejects tool_use input that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectInvalid(
      base({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: cyclic }],
          },
        ],
      }),
    );
  });

  it("enforces tool count, name, description, and schema limits", () => {
    const tool = { name: "Read", description: null, inputSchema: { type: "object" } };
    expectInvalid(base({ tools: Array.from({ length: LIMITS.maxTools + 1 }, () => tool) }));
    expectInvalid(base({ tools: [{ ...tool, name: "" }] }));
    expectInvalid(base({ tools: [{ ...tool, name: "n".repeat(LIMITS.maxToolNameChars + 1) }] }));
    expectInvalid(
      base({
        tools: [{ ...tool, description: "d".repeat(LIMITS.maxToolDescriptionChars + 1) }],
      }),
    );
    expectInvalid(
      base({
        tools: [
          {
            ...tool,
            inputSchema: { type: "object", blob: "s".repeat(LIMITS.maxToolSchemaChars) },
          },
        ],
      }),
    );
  });

  it("accepts a realistic Claude Code tool set", () => {
    const tools = ["Read", "Edit", "Bash", "Glob", "Grep"].map((name) => ({
      name,
      description: `${name} tool executed on the client device`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    }));
    expect(() => assertWithinLimits(base({ tools }))).not.toThrow();
  });

  it("enforces stop sequence count and length", () => {
    expectInvalid(base({ stopSequences: Array(LIMITS.maxStopSequences + 1).fill("x") }));
    expectInvalid(base({ stopSequences: ["x".repeat(LIMITS.maxStopSequenceChars + 1)] }));
  });

  it("validates max_tokens shape and ceiling", () => {
    expectInvalid(base({ maxTokens: 0 }));
    expectInvalid(base({ maxTokens: -5 }));
    expectInvalid(base({ maxTokens: 1.5 }));
    expectInvalid(base({ maxTokens: LIMITS.maxOutputTokens + 1 }));
    expect(() => assertWithinLimits(base({ maxTokens: 4096 }))).not.toThrow();
  });

  it("validates sampling ranges", () => {
    expectInvalid(base({ temperature: -0.1 }));
    expectInvalid(base({ temperature: 2.1 }));
    expectInvalid(base({ topP: 0 }));
    expectInvalid(base({ topP: 1.1 }));
    expect(() => assertWithinLimits(base({ temperature: 0, topP: 1 }))).not.toThrow();
  });

  it("rejects tool_choice that names an undeclared tool", () => {
    const tools = [{ name: "Read", description: null, inputSchema: { type: "object" } }];
    expectInvalid(base({ tools, toolChoice: { type: "tool", name: "Bash" } }));
    expect(() =>
      assertWithinLimits(base({ tools, toolChoice: { type: "tool", name: "Read" } })),
    ).not.toThrow();
  });

  it("allows auto/any/none tool choice without tools declared", () => {
    for (const type of ["auto", "any", "none"] as const) {
      expect(() => assertWithinLimits(base({ toolChoice: { type } }))).not.toThrow();
    }
  });

  it("keeps operator detail internal, never in the public message", () => {
    const error = expectInvalid(base({ maxTokens: LIMITS.maxOutputTokens + 1 }));
    expect(error.internalDetail).toContain("max_tokens");
    expect(error.publicMessage).toBe("The request was invalid.");
  });
});
