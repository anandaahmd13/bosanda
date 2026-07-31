/**
 * decodeChatCompletion — OpenAI body -> CanonicalRequest (PLAN.md §8, §5).
 *
 * No HTTP, no provider, no credentials: the decoder is a pure function of a
 * plain object, so every case here is a synthetic fixture.
 */

import { describe, expect, it } from "vitest";
import { BosandaError, LIMITS, type CanonicalContent } from "@bosanda/protocol";
import { decodeChatCompletion } from "@bosanda/openai";

/** A realistic weather tool, in OpenAI's current `tools` spelling. */
const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
} as const;

/** Assert a call throws BosandaError with an exact code, and return it. */
function expectCode(code: string, run: () => unknown): BosandaError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BosandaError);
    const bosanda = error as BosandaError;
    expect(bosanda.code).toBe(code);
    return bosanda;
  }
  throw new Error(`expected a BosandaError with code ${code}, but nothing was thrown`);
}

describe("decodeChatCompletion — realistic tool round trip", () => {
  // The full Claude-Code-shaped exchange: system prompt, user question,
  // assistant tool call, tool result, then a follow-up question.
  const body = {
    model: "bosanda-sonnet",
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: "Weather in Jakarta?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Jakarta"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc123", content: '{"temp_c":31}' },
      { role: "user", content: "And tomorrow?" },
    ],
    tools: [weatherTool],
    tool_choice: "auto",
    max_tokens: 512,
    temperature: 0.4,
    top_p: 0.95,
    stop: ["\n\nHuman:"],
    stream: true,
    stream_options: { include_usage: true },
  };

  it("maps the whole request onto the canonical shape", () => {
    const request = decodeChatCompletion(body, { requestId: "req_fixed" });

    expect(request.requestId).toBe("req_fixed");
    expect(request.surface).toBe("openai");
    expect(request.system).toBe("You are a concise assistant.");
    expect(request.stream).toBe(true);
    expect(request.includeUsage).toBe(true);
    expect(request.maxTokens).toBe(512);
    expect(request.temperature).toBe(0.4);
    expect(request.topP).toBe(0.95);
    expect(request.stopSequences).toEqual(["\n\nHuman:"]);
    expect(request.toolChoice).toEqual({ type: "auto" });
  });

  it("hoists the system message out of the message list", () => {
    const request = decodeChatCompletion(body);
    // No canonical role is "system", so no message may retain it.
    expect(request.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    expect(request.messages).toHaveLength(3);
  });

  it("maps assistant tool_calls to tool_use with parsed input", () => {
    const request = decodeChatCompletion(body);
    const assistant = request.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toEqual([
      { type: "tool_use", id: "call_abc123", name: "get_weather", input: { city: "Jakarta" } },
    ]);
  });

  it("maps a tool role message to a tool_result on a user message", () => {
    const request = decodeChatCompletion(body);
    // Canonical has no "tool" role; the result rides on a user turn.
    const toolTurn = request.messages[2];
    expect(toolTurn?.role).toBe("user");
    expect(toolTurn?.content[0]).toEqual({
      type: "tool_result",
      toolUseId: "call_abc123",
      content: '{"temp_c":31}',
      isError: false,
    });
    // The follow-up question collapsed onto the same user turn.
    expect(toolTurn?.content[1]).toEqual({ type: "text", text: "And tomorrow?" });
  });

  it("maps tools onto CanonicalTool", () => {
    const request = decodeChatCompletion(body);
    expect(request.tools).toEqual([
      {
        name: "get_weather",
        description: "Get the current weather for a city.",
        inputSchema: weatherTool.function.parameters,
      },
    ]);
  });
});

describe("decodeChatCompletion — model passthrough", () => {
  it("never interprets or normalizes the client model string", () => {
    // Registry resolution and authorization happen elsewhere (§9); the decoder
    // must not rewrite, lowercase, or validate this against a known list.
    for (const model of ["bosanda-sonnet", "gpt-4o", "Weird/Model:v2", "  spaced  "]) {
      const request = decodeChatCompletion({
        model,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(request.model).toBe(model);
    }
  });
});

describe("decodeChatCompletion — system and developer messages", () => {
  it("accepts a developer message as system", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [
        { role: "developer", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
    });
    expect(request.system).toBe("Be terse.");
  });

  it("concatenates several system messages in order rather than last-wins", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [
        { role: "system", content: "First." },
        { role: "user", content: "hi" },
        { role: "system", content: "Second." },
      ],
    });
    expect(request.system).toBe("First.\n\nSecond.");
  });

  it("reports null system when no system message is present", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(request.system).toBeNull();
  });

  it("flattens array-form text content", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "A" },
            { type: "text", text: "B" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "question" }] },
      ],
    });
    expect(request.system).toBe("AB");
    expect(request.messages[0]?.content).toEqual([{ type: "text", text: "question" }]);
  });
});

describe("decodeChatCompletion — both max_tokens spellings", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };

  it("accepts the legacy max_tokens", () => {
    expect(decodeChatCompletion({ ...base, max_tokens: 128 }).maxTokens).toBe(128);
  });

  it("accepts the current max_completion_tokens", () => {
    expect(decodeChatCompletion({ ...base, max_completion_tokens: 256 }).maxTokens).toBe(256);
  });

  it("accepts both when they agree", () => {
    const request = decodeChatCompletion({
      ...base,
      max_tokens: 64,
      max_completion_tokens: 64,
    });
    expect(request.maxTokens).toBe(64);
  });

  it("rejects both when they disagree rather than picking one", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({ ...base, max_tokens: 64, max_completion_tokens: 128 }),
    );
  });

  it("reports null when neither is present", () => {
    expect(decodeChatCompletion(base).maxTokens).toBeNull();
  });
});

describe("decodeChatCompletion — stream_options.include_usage", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }], stream: true };

  it("carries include_usage when true", () => {
    expect(
      decodeChatCompletion({ ...base, stream_options: { include_usage: true } }).includeUsage,
    ).toBe(true);
  });

  it("is false when include_usage is false", () => {
    expect(
      decodeChatCompletion({ ...base, stream_options: { include_usage: false } }).includeUsage,
    ).toBe(false);
  });

  it("is false when stream_options is absent", () => {
    expect(decodeChatCompletion(base).includeUsage).toBe(false);
  });

  it("defaults stream to false when absent", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(request.stream).toBe(false);
  });
});

describe("decodeChatCompletion — tool_choice", () => {
  const withTool = (choice: unknown) => ({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [weatherTool],
    tool_choice: choice,
  });

  it("maps auto, none, and required", () => {
    expect(decodeChatCompletion(withTool("auto")).toolChoice).toEqual({ type: "auto" });
    expect(decodeChatCompletion(withTool("none")).toolChoice).toEqual({ type: "none" });
    // OpenAI's "required" is canonical "any": call some tool.
    expect(decodeChatCompletion(withTool("required")).toolChoice).toEqual({ type: "any" });
  });

  it("maps a named function choice to a tool choice", () => {
    const request = decodeChatCompletion(
      withTool({ type: "function", function: { name: "get_weather" } }),
    );
    expect(request.toolChoice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("reports null when absent", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(request.toolChoice).toBeNull();
  });

  it("rejects a choice naming an undeclared tool (via assertWithinLimits)", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion(withTool({ type: "function", function: { name: "not_declared" } })),
    );
  });
});

describe("decodeChatCompletion — deprecated functions spelling", () => {
  it("accepts `functions` and maps it onto CanonicalTool", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      functions: [{ name: "legacy", description: "old", parameters: { type: "object" } }],
    });
    expect(request.tools).toEqual([
      { name: "legacy", description: "old", inputSchema: { type: "object" } },
    ]);
  });

  it("gives an absent schema an empty-object JSON Schema", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      functions: [{ name: "no_args" }],
    });
    expect(request.tools[0]).toEqual({
      name: "no_args",
      description: null,
      inputSchema: { type: "object", properties: {} },
    });
  });

  it("prefers `tools` over `functions` when both are present", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [weatherTool],
      functions: [{ name: "legacy" }],
    });
    expect(request.tools.map((t) => t.name)).toEqual(["get_weather"]);
  });

  it("maps the legacy function_call onto tool choice", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      functions: [{ name: "legacy" }],
      function_call: { name: "legacy" },
    });
    expect(request.toolChoice).toEqual({ type: "tool", name: "legacy" });
  });
});

describe("decodeChatCompletion — stop sequences", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };

  it("wraps a single string", () => {
    expect(decodeChatCompletion({ ...base, stop: "END" }).stopSequences).toEqual(["END"]);
  });

  it("copies an array", () => {
    expect(decodeChatCompletion({ ...base, stop: ["A", "B"] }).stopSequences).toEqual(["A", "B"]);
  });

  it("defaults to an empty array", () => {
    expect(decodeChatCompletion(base).stopSequences).toEqual([]);
  });
});

describe("decodeChatCompletion — rejections", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };

  it("rejects a non-object body", () => {
    for (const body of ["a string", 42, null, [], true]) {
      expectCode("invalid_request", () => decodeChatCompletion(body));
    }
  });

  it("rejects a missing model", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    );
  });

  it("rejects an empty model string", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({ model: "", messages: [{ role: "user", content: "hi" }] }),
    );
  });

  it("rejects missing or empty messages", () => {
    expectCode("invalid_request", () => decodeChatCompletion({ model: "m" }));
    expectCode("invalid_request", () => decodeChatCompletion({ model: "m", messages: [] }));
  });

  it("rejects an unknown role", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({ model: "m", messages: [{ role: "robot", content: "hi" }] }),
    );
  });

  it("rejects a tool message without tool_call_id", () => {
    // Without a correlation ID the result cannot be attached to a call.
    expectCode("invalid_request", () =>
      decodeChatCompletion({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "result" },
        ],
      }),
    );
  });

  it("rejects tool_call arguments that are not valid JSON", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "f", arguments: "{not json" } },
            ],
          },
        ],
      }),
    );
  });

  it("treats empty tool_call arguments as no arguments", () => {
    // A zero-parameter tool is what OpenAI clients emit as "" — not an error.
    const request = decodeChatCompletion({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "" } }],
        },
      ],
    });
    const content = request.messages[1]?.content[0] as Extract<
      CanonicalContent,
      { type: "tool_use" }
    >;
    expect(content.input).toEqual({});
  });

  it("raises unsupported_capability for recognised parameters it cannot honour", () => {
    const cases: Record<string, unknown> = {
      logprobs: true,
      top_logprobs: 3,
      logit_bias: { "123": 1 },
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      response_format: { type: "json_object" },
      seed: 42,
      audio: { voice: "alloy" },
      modalities: ["text", "audio"],
      prediction: { type: "content", content: "x" },
      web_search_options: {},
      parallel_tool_calls: false,
      service_tier: "flex",
      reasoning_effort: "high",
    };
    for (const [key, value] of Object.entries(cases)) {
      const error = expectCode("unsupported_capability", () =>
        decodeChatCompletion({ ...base, [key]: value }),
      );
      // 400, and the public text says nothing about which parameter.
      expect(error.status).toBe(400);
    }
  });

  it("ignores unsupported parameters that are explicitly null", () => {
    // A client sending `seed: null` is not asking for a seed.
    const request = decodeChatCompletion({ ...base, seed: null, response_format: null });
    expect(request.model).toBe("m");
  });

  it("accepts n = 1 but rejects any other n", () => {
    expect(decodeChatCompletion({ ...base, n: 1 }).model).toBe("m");
    expectCode("unsupported_capability", () => decodeChatCompletion({ ...base, n: 4 }));
    expectCode("unsupported_capability", () => decodeChatCompletion({ ...base, n: 0 }));
  });

  it("rejects multimodal content parts as unsupported", () => {
    for (const type of ["image_url", "input_audio", "file", "video_url"]) {
      expectCode("unsupported_capability", () =>
        decodeChatCompletion({
          model: "m",
          messages: [{ role: "user", content: [{ type, [type]: { url: "x" } }] }],
        }),
      );
    }
  });

  it("ignores unknown extra top-level keys", () => {
    // Forward compatibility: an unrecognised key we have no opinion about is not
    // a capability claim, so it must not fail an otherwise valid request.
    const request = decodeChatCompletion({ ...base, some_future_field: "whatever" });
    expect(request.model).toBe("m");
  });
});

describe("decodeChatCompletion — assertWithinLimits runs before returning", () => {
  it("rejects too many messages", () => {
    const messages = Array.from({ length: LIMITS.maxMessages + 1 }, (_, i) => ({
      role: "user",
      content: `m${i}`,
    }));
    // Distinct roles would collapse; force separate turns via alternating roles
    // is unnecessary here because the limit counts canonical messages, and
    // consecutive same-role turns collapse — so alternate to keep them separate.
    const alternating = messages.map((m, i) => ({
      ...m,
      role: i % 2 === 0 ? "user" : "assistant",
    }));
    expectCode("invalid_request", () =>
      decodeChatCompletion({ model: "m", messages: alternating }),
    );
  });

  it("rejects max_tokens above the limit", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: LIMITS.maxOutputTokens + 1,
      }),
    );
  });

  it("rejects a non-integer max_tokens", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10.5,
      }),
    );
  });

  it("rejects out-of-range temperature and top_p", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        temperature: 3,
      }),
    );
    expectCode("invalid_request", () =>
      decodeChatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], top_p: 0 }),
    );
  });

  it("rejects too many stop sequences", () => {
    expectCode("invalid_request", () =>
      decodeChatCompletion({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stop: Array.from({ length: LIMITS.maxStopSequences + 1 }, (_, i) => `s${i}`),
      }),
    );
  });
});

describe("decodeChatCompletion — request IDs", () => {
  it("generates a request ID when the gateway does not supply one", () => {
    const request = decodeChatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(request.requestId).toMatch(/^req_[0-9a-z]{26}$/);
  });

  it("generates a distinct ID per decode", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(decodeChatCompletion(body).requestId).not.toBe(decodeChatCompletion(body).requestId);
  });
});

describe("decodeChatCompletion — error hygiene", () => {
  it("never puts request content into the client-visible message", () => {
    const secret = "SENSITIVE-PROMPT-TEXT";
    const error = expectCode("unsupported_capability", () =>
      decodeChatCompletion({
        model: "m",
        messages: [{ role: "user", content: secret }],
        seed: 7,
      }),
    );
    expect(error.publicMessage).not.toContain(secret);
    expect(error.publicMessage).toBe(
      "The request uses a capability this endpoint does not support.",
    );
  });

  it("folds zod's message into internalDetail, not publicMessage", () => {
    const error = expectCode("invalid_request", () => decodeChatCompletion({ model: "m" }));
    expect(error.publicMessage).toBe("The request was invalid.");
    expect(error.internalDetail).toBeTypeOf("string");
  });
});
