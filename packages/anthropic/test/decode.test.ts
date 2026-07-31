import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import {
  decodeMessagesRequest,
  requireAnthropicVersion,
  SUPPORTED_ANTHROPIC_VERSIONS,
} from "@bosanda/anthropic";

const V = { "anthropic-version": "2023-06-01" };

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "bosanda-sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

/** Asserts a BosandaError with the given code, and returns it for detail checks. */
function expectError(fn: () => unknown, code: string): BosandaError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BosandaError);
    const bosanda = error as BosandaError;
    expect(bosanda.code).toBe(code);
    return bosanda;
  }
  throw new Error(`expected a ${code} error, but nothing was thrown`);
}

describe("anthropic-version header (PLAN.md §8: required and recorded)", () => {
  it("accepts a supported version and returns it for recording", () => {
    expect(requireAnthropicVersion(V)).toBe("2023-06-01");
    for (const version of SUPPORTED_ANTHROPIC_VERSIONS) {
      expect(requireAnthropicVersion({ "anthropic-version": version })).toBe(version);
    }
  });

  it("rejects a missing header", () => {
    const error = expectError(() => decodeMessagesRequest(body(), {}), "invalid_request");
    expect(error.internalDetail).toContain("anthropic-version");
  });

  it("rejects an empty header", () => {
    expectError(
      () => decodeMessagesRequest(body(), { "anthropic-version": "  " }),
      "invalid_request",
    );
  });

  it("rejects an unknown version rather than guessing its semantics", () => {
    const error = expectError(
      () => decodeMessagesRequest(body(), { "anthropic-version": "2029-01-01" }),
      "invalid_request",
    );
    expect(error.internalDetail).toContain("2029-01-01");
  });

  it("is case-insensitive and reads Headers, plain objects, and Maps", () => {
    expect(requireAnthropicVersion({ "Anthropic-Version": "2023-06-01" })).toBe("2023-06-01");
    expect(requireAnthropicVersion(new Headers({ "anthropic-version": "2023-06-01" }))).toBe(
      "2023-06-01",
    );
    expect(requireAnthropicVersion(new Map([["anthropic-version", "2023-06-01"]]))).toBe(
      "2023-06-01",
    );
    // Node array-ifies repeated headers.
    expect(requireAnthropicVersion({ "anthropic-version": ["2023-06-01"] })).toBe("2023-06-01");
  });
});

describe("system: both wire shapes (§8)", () => {
  it("accepts system as a plain string", () => {
    const request = decodeMessagesRequest(body({ system: "You are terse." }), V);
    expect(request.system).toBe("You are terse.");
  });

  it("accepts system as a content-block array and joins the text", () => {
    const request = decodeMessagesRequest(
      body({
        system: [
          { type: "text", text: "First." },
          { type: "text", text: "Second." },
        ],
      }),
      V,
    );
    expect(request.system).toBe("First.\n\nSecond.");
  });

  it("keeps unmodelled block decoration such as cache_control", () => {
    const request = decodeMessagesRequest(
      body({
        system: [{ type: "text", text: "Cached.", cache_control: { type: "ephemeral" } }],
      }),
      V,
    );
    expect(request.system).toBe("Cached.");
  });

  it("is null when omitted", () => {
    expect(decodeMessagesRequest(body(), V).system).toBeNull();
  });

  it("rejects a non-text system block", () => {
    const error = expectError(
      () =>
        decodeMessagesRequest(body({ system: [{ type: "image", source: { type: "base64" } }] }), V),
      "unsupported_capability",
    );
    expect(error.internalDetail).toContain("system[0]");
  });
});

describe("content blocks: every kind (§5)", () => {
  it("decodes string content into a single text block", () => {
    const request = decodeMessagesRequest(body(), V);
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("decodes a text block array", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("decodes tool_use, preserving the client's id and input verbatim", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_abc", name: "read_file", input: { path: "a.ts" } },
            ],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_abc",
      name: "read_file",
      input: { path: "a.ts" },
    });
  });

  it("defaults a missing tool_use input to an empty object", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "now" }] },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toMatchObject({ input: {} });
  });

  it("decodes a string tool_result and defaults is_error to false", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: "file body" }],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toEqual({
      type: "tool_result",
      toolUseId: "toolu_abc",
      content: "file body",
      isError: false,
    });
  });

  it("decodes a tool_result with BLOCK-ARRAY content, the shape Claude Code sends", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_abc",
                content: [
                  { type: "text", text: "line one" },
                  { type: "text", text: "line two" },
                ],
              },
            ],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toEqual({
      type: "tool_result",
      toolUseId: "toolu_abc",
      content: "line one\nline two",
      isError: false,
    });
  });

  it("carries is_error through on a failed tool_result", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ENOENT", is_error: true },
            ],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toMatchObject({ isError: true });
  });

  it("placeholders an image inside a tool_result instead of dropping the result", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "text", text: "screenshot:" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
                ],
              },
            ],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toMatchObject({
      content: "screenshot:\n[image]",
      toolUseId: "t1",
    });
  });

  it("treats an empty tool_result content as an empty string", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] }],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toMatchObject({ content: "" });
  });

  it("maps a thinking block onto canonical reasoning", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "step one", signature: "sig" }],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content[0]).toEqual({ type: "reasoning", text: "step one" });
  });

  it("drops redacted_thinking, which cannot be replayed and carries no readable text", () => {
    const request = decodeMessagesRequest(
      body({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
      V,
    );
    expect(request.messages[0]?.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("rejects a top-level image block, since the upstream surface is text-only", () => {
    const error = expectError(
      () =>
        decodeMessagesRequest(
          body({
            messages: [
              {
                role: "user",
                content: [{ type: "image", source: { type: "base64", data: "x" } }],
              },
            ],
          }),
          V,
        ),
      "unsupported_capability",
    );
    expect(error.internalDetail).toContain("messages[0].content[0]");
  });

  it("rejects an unmodelled block type with a precise path", () => {
    const error = expectError(
      () =>
        decodeMessagesRequest(
          body({
            messages: [
              { role: "user", content: [{ type: "text", text: "ok" }] },
              { role: "assistant", content: [{ type: "document", source: {} }] },
            ],
          }),
          V,
        ),
      "unsupported_capability",
    );
    expect(error.internalDetail).toContain("messages[1].content[0]");
    expect(error.internalDetail).toContain("document");
  });
});

describe("tools and tool_choice", () => {
  const tools = [
    {
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ];

  it("decodes a tool with its input_schema", () => {
    const request = decodeMessagesRequest(body({ tools }), V);
    expect(request.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("nulls a missing description", () => {
    const request = decodeMessagesRequest(
      body({ tools: [{ name: "now", input_schema: { type: "object" } }] }),
      V,
    );
    expect(request.tools[0]?.description).toBeNull();
  });

  it("rejects a tool with no input_schema", () => {
    const error = expectError(
      () => decodeMessagesRequest(body({ tools: [{ name: "broken" }] }), V),
      "invalid_request",
    );
    expect(error.internalDetail).toContain("input_schema");
  });

  it.each([
    ["auto", { type: "auto" }],
    ["any", { type: "any" }],
    ["none", { type: "none" }],
  ] as const)("decodes tool_choice %s", (_label, choice) => {
    const request = decodeMessagesRequest(body({ tools, tool_choice: choice }), V);
    expect(request.toolChoice).toEqual(choice);
  });

  it("decodes tool_choice tool with its name", () => {
    const request = decodeMessagesRequest(
      body({ tools, tool_choice: { type: "tool", name: "read_file" } }),
      V,
    );
    expect(request.toolChoice).toEqual({ type: "tool", name: "read_file" });
  });

  it("is null when tool_choice is absent", () => {
    expect(decodeMessagesRequest(body(), V).toolChoice).toBeNull();
  });

  it("rejects a server-executed tool: tools run client-side only (§16)", () => {
    const error = expectError(
      () =>
        decodeMessagesRequest(
          body({
            tools: [{ type: "bash_20250124", name: "bash", input_schema: { type: "object" } }],
          }),
          V,
        ),
      "unsupported_capability",
    );
    expect(error.internalDetail).toContain("client-side");
  });

  it("accepts an explicitly custom tool type", () => {
    const request = decodeMessagesRequest(
      body({ tools: [{ type: "custom", name: "read_file", input_schema: { type: "object" } }] }),
      V,
    );
    expect(request.tools[0]?.name).toBe("read_file");
  });
});

describe("sampling parameters and stream flag", () => {
  it("carries stop_sequences, temperature, top_p and stream", () => {
    const request = decodeMessagesRequest(
      body({
        stop_sequences: ["\n\nHuman:", "END"],
        temperature: 0.5,
        top_p: 0.9,
        stream: true,
      }),
      V,
    );
    expect(request.stopSequences).toEqual(["\n\nHuman:", "END"]);
    expect(request.temperature).toBe(0.5);
    expect(request.topP).toBe(0.9);
    expect(request.stream).toBe(true);
  });

  it("defaults stream to false and the optional knobs to null", () => {
    const request = decodeMessagesRequest(body(), V);
    expect(request.stream).toBe(false);
    expect(request.temperature).toBeNull();
    expect(request.topP).toBeNull();
    expect(request.stopSequences).toEqual([]);
  });

  it("always sets includeUsage: Anthropic reports usage unconditionally", () => {
    expect(decodeMessagesRequest(body(), V).includeUsage).toBe(true);
  });

  it("sets the surface to anthropic and mints a request id", () => {
    const request = decodeMessagesRequest(body(), V);
    expect(request.surface).toBe("anthropic");
    expect(request.requestId).toMatch(/^req_/);
  });

  it("uses a caller-supplied request id when the gateway already assigned one", () => {
    const request = decodeMessagesRequest(body(), V, { requestId: "req_fixed" });
    expect(request.requestId).toBe("req_fixed");
  });
});

describe("assertWithinLimits runs after decoding (frozen contract)", () => {
  it("rejects an empty message list", () => {
    expectError(() => decodeMessagesRequest(body({ messages: [] }), V), "invalid_request");
  });

  it("rejects max_tokens above the limit", () => {
    expectError(() => decodeMessagesRequest(body({ max_tokens: 999_999 }), V), "invalid_request");
  });

  it("rejects an out-of-range temperature", () => {
    expectError(() => decodeMessagesRequest(body({ temperature: 5 }), V), "invalid_request");
  });

  it("rejects tool_choice naming an undeclared tool", () => {
    expectError(
      () => decodeMessagesRequest(body({ tool_choice: { type: "tool", name: "ghost" } }), V),
      "invalid_request",
    );
  });

  it("rejects too many stop sequences", () => {
    expectError(
      () => decodeMessagesRequest(body({ stop_sequences: Array(20).fill("x") }), V),
      "invalid_request",
    );
  });
});

describe("malformed bodies", () => {
  it("requires max_tokens on /v1/messages", () => {
    const error = expectError(
      () => decodeMessagesRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }, V),
      "invalid_request",
    );
    expect(error.internalDetail).toContain("max_tokens");
  });

  it("rejects a missing model", () => {
    expectError(() => decodeMessagesRequest(body({ model: undefined }), V), "invalid_request");
  });

  it("rejects an unknown role", () => {
    expectError(
      () => decodeMessagesRequest(body({ messages: [{ role: "system", content: "x" }] }), V),
      "invalid_request",
    );
  });

  it("rejects a non-object body", () => {
    expectError(() => decodeMessagesRequest("not json", V), "invalid_request");
    expectError(() => decodeMessagesRequest(null, V), "invalid_request");
  });

  it("classifies a malformed KNOWN block as invalid_request, not unsupported_capability", () => {
    // A text block with a numeric `text` is something we support, sent wrongly.
    // Calling it "unsupported" would send the client chasing the wrong problem.
    const error = expectError(
      () =>
        decodeMessagesRequest(
          body({ messages: [{ role: "user", content: [{ type: "text", text: 42 }] }] }),
          V,
        ),
      "invalid_request",
    );
    expect(error.internalDetail).toContain("messages[0].content[0]");
  });

  it("names the failing JSON path without echoing prompt text", () => {
    const secret = "SUPER-SECRET-PROMPT-TEXT";
    const error = expectError(
      () =>
        decodeMessagesRequest(
          body({
            messages: [{ role: "user", content: [{ type: "text", text: 42, note: secret }] }],
          }),
          V,
        ),
      "invalid_request",
    );
    expect(error.internalDetail).toContain("messages[0].content[0]");
    expect(error.internalDetail).not.toContain(secret);
  });
});
