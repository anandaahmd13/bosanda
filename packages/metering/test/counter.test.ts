import { describe, expect, it } from "vitest";
import type { CanonicalRequest } from "@bosanda/protocol";
import {
  COUNTER_VERSION,
  countOutputTokens,
  countRequestInputTokens,
  countText,
} from "@bosanda/metering";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: "req_test",
    surface: "anthropic",
    model: "bosanda-sonnet",
    system: null,
    messages: [],
    tools: [],
    toolChoice: null,
    stream: false,
    maxTokens: null,
    temperature: null,
    topP: null,
    stopSequences: [],
    includeUsage: false,
    ...overrides,
  };
}

describe("countText", () => {
  it("returns zero for an empty string", () => {
    expect(countText("")).toBe(0);
  });

  it("approximates English prose at roughly 4 characters per token", () => {
    const text = "The quick brown fox jumps over the lazy dog."; // 44 chars
    expect(countText(text)).toBe(11);
  });

  it("never returns zero for non-empty input", () => {
    expect(countText("a")).toBeGreaterThan(0);
    expect(countText(" ")).toBeGreaterThan(0);
  });

  it("counts dense-script characters at 1 token each, not 0.25", () => {
    // Under-counting CJK by 4x would give away free capacity, so the heuristic
    // deliberately treats these as >= 1 token per character.
    const japanese = "こんにちは世界";
    expect(countText(japanese)).toBe(japanese.length);

    const korean = "안녕하세요";
    expect(countText(korean)).toBe(korean.length);

    const chinese = "你好世界";
    expect(countText(chinese)).toBe(chinese.length);
  });

  it("handles mixed dense and latin script additively", () => {
    const mixed = "hello 世界"; // 6 latin-ish chars + 2 dense
    expect(countText(mixed)).toBe(2 + Math.ceil(6 / 4));
  });

  it("is monotonic: more text never counts fewer tokens", () => {
    let previous = 0;
    let text = "";
    for (let i = 0; i < 200; i += 1) {
      text += "word ";
      const current = countText(text);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("is deterministic", () => {
    const text = "settle this the same way every time";
    expect(countText(text)).toBe(countText(text));
  });
});

describe("countRequestInputTokens", () => {
  it("returns zero for a request with no system, messages, or tools", () => {
    expect(countRequestInputTokens(request())).toBe(0);
  });

  it("counts the system prompt", () => {
    const withSystem = countRequestInputTokens(request({ system: "You are a helpful assistant." }));
    expect(withSystem).toBeGreaterThan(0);
  });

  it("counts the full message history, not just the last turn", () => {
    const oneTurn = countRequestInputTokens(
      request({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
    );
    const threeTurns = countRequestInputTokens(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "hi there" }] },
          { role: "user", content: [{ type: "text", text: "how are you" }] },
        ],
      }),
    );
    expect(threeTurns).toBeGreaterThan(oneTurn);
  });

  it("counts tool definitions, which dominate many Claude Code requests", () => {
    const withoutTools = countRequestInputTokens(
      request({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    const withTools = countRequestInputTokens(
      request({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          {
            name: "read_file",
            description: "Read a file from the local filesystem and return its contents.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string", description: "Absolute path" } },
              required: ["path"],
            },
          },
        ],
      }),
    );
    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("counts a tool_use block's serialized input", () => {
    const counted = countRequestInputTokens(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "read_file",
                input: { path: "/some/long/path/to/a/file.ts" },
              },
            ],
          },
        ],
      }),
    );
    expect(counted).toBeGreaterThan(0);
  });

  it("counts a tool_result block's content", () => {
    const small = countRequestInputTokens(
      request({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "toolu_1", content: "ok", isError: false }],
          },
        ],
      }),
    );
    const large = countRequestInputTokens(
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "toolu_1",
                content: "x".repeat(4000),
                isError: false,
              },
            ],
          },
        ],
      }),
    );
    expect(large).toBeGreaterThan(small + 900);
  });

  it("counts reasoning blocks", () => {
    const counted = countRequestInputTokens(
      request({
        messages: [
          { role: "assistant", content: [{ type: "reasoning", text: "thinking it through" }] },
        ],
      }),
    );
    expect(counted).toBeGreaterThan(0);
  });

  it("does not throw on a tool_use input containing a circular reference", () => {
    // Input is caller-supplied, so serialization must fail soft rather than 500.
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;

    expect(() =>
      countRequestInputTokens(
        request({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "t", name: "n", input: circular }],
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("counts stop sequences", () => {
    const withStops = countRequestInputTokens(request({ stopSequences: ["\n\nHuman:", "END"] }));
    expect(withStops).toBeGreaterThan(0);
  });

  it("is pure: repeated calls on the same request agree", () => {
    const req = request({
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(countRequestInputTokens(req)).toBe(countRequestInputTokens(req));
  });
});

describe("countOutputTokens", () => {
  it("returns zero for no segments", () => {
    expect(countOutputTokens([])).toBe(0);
  });

  it("is independent of arbitrary streaming chunk boundaries", () => {
    const whole = countText("hello world from bosanda");
    const split = countOutputTokens(["hello ", "world ", "from ", "bosanda"]);
    expect(split).toBe(whole);
  });
});

describe("COUNTER_VERSION", () => {
  it("is a non-empty stable identifier, so ledger rows stay explainable", () => {
    expect(COUNTER_VERSION).toBe("heuristic-2");
  });
});
