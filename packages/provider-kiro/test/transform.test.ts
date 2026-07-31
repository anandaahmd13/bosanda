/**
 * Request transformation tests (PLAN.md §6 "Request transformation invariants",
 * §3 G1/G3, §16, §19).
 *
 * The four invariants in transform.ts are security properties, not formatting
 * preferences, so each one gets adversarial coverage rather than one happy-path
 * assertion:
 *
 *  1. fresh conversationId per call    — cross-request/cross-customer isolation
 *  2. no injected tools — every outbound tool was declared by the CLIENT
 *     (a client-declared `Bash` is forwarded; §6 constrains what we ADD)
 *  3. no Bosanda secrets/paths/env vars in an outbound prompt
 *  4. deterministic history repair
 *
 * The wire shape asserted here is the version-1 GUESS (`FIXTURE_VERSION` carries
 * a `-draft` suffix). These tests pin what the code CURRENTLY produces so a
 * change is visible and deliberate; they are not evidence that upstream accepts
 * it. Only §3 G1 against live traffic can establish that, and M0 has not run.
 */

import { describe, expect, it } from "vitest";
import { BosandaError, type CanonicalContent, type CanonicalRequest } from "@bosanda/protocol";
import {
  FIXTURE_VERSION,
  assertNoInjectedTools,
  assertNoServerContext,
  isHostCapabilityToolName,
  transformRequest,
  type TransformOptions,
} from "@bosanda/provider-kiro";

const options = (overrides: Partial<TransformOptions> = {}): TransformOptions => ({
  upstreamModelId: "CLAUDE_SONNET_4_5_20250929_V1_0",
  persona: "cli",
  profileArn: null,
  toolsEnabled: true,
  ...overrides,
});

const request = (overrides: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  requestId: "req_test",
  surface: "anthropic",
  model: "bosanda-sonnet-4-5",
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

const text = (value: string): CanonicalContent => ({ type: "text", text: value });

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof BosandaError) return error.code;
    throw error;
  }
  throw new Error("expected a BosandaError but nothing was thrown");
};

describe("invariant 1: a fresh conversation id per request (§6, §16)", () => {
  it("mints a different id for two identical requests", () => {
    // Reusing an id would let hidden upstream context leak between requests and,
    // worse, between customers.
    const input = request();
    const first = transformRequest(input, options());
    const second = transformRequest(input, options());

    expect(first.conversationId).not.toBe(second.conversationId);
    expect(first.request.conversationState.conversationId).toBe(first.conversationId);
  });

  it("has no parameter through which a caller could supply one", () => {
    // The id is generated INSIDE the function, so a caller cannot pass a stale
    // one even by mistake. If a future refactor adds such an option this fails.
    const supplied = { ...options(), conversationId: "attacker-controlled" };
    const result = transformRequest(request(), supplied as TransformOptions);

    expect(result.conversationId).not.toBe("attacker-controlled");
  });

  it("produces a v4 UUID", () => {
    const { conversationId } = transformRequest(request(), options());
    expect(conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("mints ids that stay unique across many calls", () => {
    const ids = new Set(
      Array.from({ length: 200 }, () => transformRequest(request(), options()).conversationId),
    );
    expect(ids.size).toBe(200);
  });
});

describe("invariant 2: no injected tools (§6, §3 G3)", () => {
  it("forwards only the tools the client declared", () => {
    const result = transformRequest(
      request({
        tools: [
          { name: "get_weather", description: "Weather", inputSchema: { type: "object" } },
          { name: "search_docs", description: null, inputSchema: { type: "object" } },
        ],
      }),
      options(),
    );

    const tools =
      result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .tools ?? [];
    expect(tools.map((t) => t.toolSpecification.name)).toEqual(["get_weather", "search_docs"]);
    // A null description becomes "", never a Bosanda-authored default.
    expect(tools[1]!.toolSpecification.description).toBe("");
  });

  it("omits the tools field entirely when the client declared none", () => {
    const result = transformRequest(request(), options());
    expect(
      result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .tools,
    ).toBeUndefined();
  });

  it("forwards Claude Code's own tools, including Bash, unchanged", () => {
    // THE REGRESSION TEST FOR THIS PACKAGE. Claude Code's primary tool is named
    // exactly `Bash`. An earlier revision rejected client-declared
    // host-capability names, so this request failed with
    // unsupported_capability — meaning §3 G3 ("Complete Claude Code client-side
    // tool use passes") could not have passed, and §3 makes a G3 failure a
    // project no-go. These tools run on the CLIENT's machine.
    const claudeCodeTools = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "WebFetch"];
    const result = transformRequest(
      request({
        tools: claudeCodeTools.map((name) => ({
          name,
          description: null,
          inputSchema: { type: "object" },
        })),
      }),
      options(),
    );

    const forwarded = (
      result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .tools ?? []
    ).map((tool) => tool.toolSpecification.name);
    expect(forwarded).toEqual(claudeCodeTools);
  });

  it("forwards lowercase shell-style names a client may declare", () => {
    // `shell`, `exec`, `run_command`, and `env` were all refused by the old
    // blocklist. A client declaring them is describing its OWN capabilities.
    for (const name of ["shell", "exec", "run_command", "env", "read_file", "bash"]) {
      const result = transformRequest(
        request({ tools: [{ name, description: null, inputSchema: { type: "object" } }] }),
        options(),
      );
      expect(
        result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
          .tools?.[0]?.toolSpecification.name,
        `${name} must reach upstream`,
      ).toBe(name);
    }
  });

  it("refuses a tool the client never declared", () => {
    // The invariant that actually binds Bosanda (§6 "never inject"). Checked
    // structurally against the declared set, so it catches an injected tool
    // whatever it is called — including a name no blocklist would flag.
    expect(
      codeOf(() =>
        assertNoInjectedTools(
          [
            {
              toolSpecification: {
                name: "helpful_assistant",
                description: "",
                inputSchema: { json: {} },
              },
            },
          ],
          [{ name: "get_weather" }],
        ),
      ),
      // internal_error, not unsupported_capability: nothing about the CLIENT's
      // request is unsupported — Bosanda built a bad upstream request.
    ).toBe("internal_error");
  });

  it("accepts an outbound set that exactly matches the declared set", () => {
    expect(() =>
      assertNoInjectedTools(
        [{ toolSpecification: { name: "Bash", description: "", inputSchema: { json: {} } } }],
        [{ name: "Bash" }],
      ),
    ).not.toThrow();
  });

  it("classifies host-capability names without gating them", () => {
    // Still used to enrich the injection error, and asserted by the §3 harness.
    for (const name of ["fs_read", "fs.write", "filesystem", "read_file", "bash", "shell", "env"]) {
      expect(isHostCapabilityToolName(name), `${name} names a host capability`).toBe(true);
    }
    for (const name of ["get_weather", "search", "shellfish_facts", "execute_order"]) {
      expect(isHostCapabilityToolName(name), `${name} does not`).toBe(false);
    }
  });

  it("drops tools entirely when the kill switch is off", () => {
    // Documented behaviour of the §3 tool-use switch: the turn runs as plain
    // text, with no tool reaching upstream at all.
    const result = transformRequest(
      request({
        tools: [{ name: "get_weather", description: null, inputSchema: { type: "object" } }],
      }),
      options({ toolsEnabled: false }),
    );

    expect(
      result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .tools,
    ).toBeUndefined();
  });

  it("attaches tool specs to the current message only, never to history", () => {
    // Repeating a large Claude Code tool block per historical turn would inflate
    // the input tokens the customer is billed for (§10) without changing output.
    const result = transformRequest(
      request({
        messages: [
          { role: "user", content: [text("first")] },
          { role: "assistant", content: [text("reply")] },
          { role: "user", content: [text("second")] },
        ],
        tools: [{ name: "get_weather", description: null, inputSchema: { type: "object" } }],
      }),
      options(),
    );

    const history = result.request.conversationState.history;
    for (const entry of history) {
      if ("userInputMessage" in entry) {
        expect(entry.userInputMessage.userInputMessageContext.tools).toBeUndefined();
      }
    }
    expect(
      result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .tools,
    ).toHaveLength(1);
  });
});

describe("invariant 3: no Bosanda server context outbound (§16)", () => {
  it("rejects a system prompt naming a BOSANDA_* variable", () => {
    expect(
      codeOf(() => transformRequest(request({ system: "Use BOSANDA_DATABASE_URL" }), options())),
    ).toBe("internal_error");
  });

  it("rejects a Bosanda API key shape", () => {
    expect(
      codeOf(() =>
        transformRequest(
          request({ messages: [{ role: "user", content: [text("key bsk_ABCDEFGH234567")] }] }),
          options(),
        ),
      ),
    ).toBe("internal_error");
  });

  it("rejects an AWS account ARN", () => {
    expect(
      codeOf(() =>
        transformRequest(
          request({ system: "arn:aws:codewhisperer:us-east-1:123456789012:profile/X" }),
          options(),
        ),
      ),
    ).toBe("internal_error");
  });

  it("rejects a Bosanda deployment path", () => {
    expect(
      codeOf(() => transformRequest(request({ system: "read /etc/bosanda/env" }), options())),
    ).toBe("internal_error");
  });

  it("checks history messages, not just the current one", () => {
    expect(
      codeOf(() =>
        transformRequest(
          request({
            messages: [
              { role: "user", content: [text("BOSANDA_SESSION_SECRET")] },
              { role: "assistant", content: [text("ok")] },
              { role: "user", content: [text("continue")] },
            ],
          }),
          options(),
        ),
      ),
    ).toBe("internal_error");
  });

  it("names WHAT was found without echoing the matched text", () => {
    // internalDetail is logged (§17), so it must not become the leak it reports.
    try {
      assertNoServerContext("token bsk_ABCDEFGH234567", "the system prompt");
      throw new Error("expected a throw");
    } catch (error) {
      const detail = (error as BosandaError).internalDetail ?? "";
      expect(detail).toContain("a Bosanda API key");
      expect(detail).not.toContain("bsk_ABCDEFGH234567");
    }
  });

  it("passes ordinary prose through untouched", () => {
    // The guard is against OUR templates, not the customer's content: a false
    // positive fails a paid request.
    const prose =
      "Refactor the bosanda-web client, check env handling, and read src/config.ts for the API key flow.";
    expect(() => assertNoServerContext(prose, "the system prompt")).not.toThrow();
  });

  it("prepends nothing of its own to the prompt", () => {
    // There is no template into which an env var could be interpolated, and the
    // system prompt must arrive verbatim.
    const result = transformRequest(
      request({ system: "SYSTEM", messages: [{ role: "user", content: [text("USER")] }] }),
      options(),
    );

    expect(result.request.conversationState.currentMessage.userInputMessage.content).toBe(
      "SYSTEM\n\nUSER",
    );
  });
});

describe("invariant 4: deterministic history repair (§6)", () => {
  it("merges consecutive same-role messages", () => {
    // Anthropic clients legitimately split tool results across messages, so
    // merging (not rejecting) is required for real traffic.
    const result = transformRequest(
      request({
        messages: [
          { role: "user", content: [text("a")] },
          { role: "user", content: [text("b")] },
          { role: "assistant", content: [text("r1")] },
          { role: "assistant", content: [text("r2")] },
          { role: "user", content: [text("c")] },
        ],
      }),
      options(),
    );

    const history = result.request.conversationState.history;
    expect(history).toHaveLength(2);
    expect("userInputMessage" in history[0]! && history[0].userInputMessage.content).toBe("ab");
    expect(
      "assistantResponseMessage" in history[1]! && history[1].assistantResponseMessage.content,
    ).toBe("r1r2");
  });

  it("rejects an empty message list", () => {
    expect(codeOf(() => transformRequest(request({ messages: [] }), options()))).toBe(
      "invalid_request",
    );
  });

  it("rejects a trailing assistant message", () => {
    // This wire shape has no representation for a continuation.
    expect(
      codeOf(() =>
        transformRequest(
          request({
            messages: [
              { role: "user", content: [text("q")] },
              { role: "assistant", content: [text("half an answer")] },
            ],
          }),
          options(),
        ),
      ),
    ).toBe("invalid_request");
  });

  it("is deterministic apart from the conversation id", () => {
    const input = request({
      messages: [
        { role: "user", content: [text("a")] },
        { role: "user", content: [text("b")] },
        { role: "assistant", content: [text("r")] },
        { role: "user", content: [text("c")] },
      ],
    });

    const strip = (value: CanonicalRequest) => {
      const result = transformRequest(value, options());
      return JSON.stringify({
        ...result.request,
        conversationState: { ...result.request.conversationState, conversationId: "<id>" },
      });
    };

    expect(strip(input)).toBe(strip(input));
  });

  it("does not mutate the caller's request", () => {
    // History merging builds new arrays; mutating the input would corrupt the
    // caller's copy on a retry against a second account (§7 failover).
    const input = request({
      messages: [
        { role: "user", content: [text("a")] },
        { role: "user", content: [text("b")] },
        { role: "user", content: [text("c")] },
      ],
    });
    const before = JSON.stringify(input);

    transformRequest(input, options());

    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("content mapping (§6)", () => {
  it("preserves tool ids verbatim", () => {
    // The client correlates its tool_result against exactly this value, so
    // rewriting an id breaks the loop.
    const result = transformRequest(
      request({
        messages: [
          { role: "user", content: [text("use a tool")] },
          {
            role: "assistant",
            content: [
              text("calling"),
              { type: "tool_use", id: "toolu_01ABCdef", name: "get_weather", input: { city: "X" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "toolu_01ABCdef",
                content: "sunny",
                isError: false,
              },
            ],
          },
        ],
      }),
      options(),
    );

    const assistant = result.request.conversationState.history[1]!;
    expect("assistantResponseMessage" in assistant).toBe(true);
    if ("assistantResponseMessage" in assistant) {
      expect(assistant.assistantResponseMessage.toolUses).toEqual([
        { toolUseId: "toolu_01ABCdef", name: "get_weather", input: { city: "X" } },
      ]);
    }

    const current = result.request.conversationState.currentMessage.userInputMessage;
    expect(current.userInputMessageContext.toolResults).toEqual([
      { toolUseId: "toolu_01ABCdef", status: "success", content: [{ text: "sunny" }] },
    ]);
  });

  it("maps an errored tool result to status error", () => {
    const result = transformRequest(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "toolu_1", content: "boom", isError: true },
            ],
          },
        ],
      }),
      options(),
    );

    expect(
      result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .toolResults?.[0]?.status,
    ).toBe("error");
  });

  it("drops prior reasoning content rather than replaying it", () => {
    // Upstream regenerates its own scratchpad, and echoing it back inflates the
    // input tokens the customer pays for (§10).
    const result = transformRequest(
      request({
        messages: [
          { role: "user", content: [text("q")] },
          {
            role: "assistant",
            content: [{ type: "reasoning", text: "SECRET-SCRATCHPAD" }, text("answer")],
          },
          { role: "user", content: [text("follow up")] },
        ],
      }),
      options(),
    );

    const serialized = JSON.stringify(result.request);
    expect(serialized).not.toContain("SECRET-SCRATCHPAD");
    expect(serialized).toContain("answer");
  });

  it("omits toolResults when there are none", () => {
    const result = transformRequest(request(), options());
    expect(
      result.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .toolResults,
    ).toBeUndefined();
  });
});

describe("request envelope (§6, §9, §17)", () => {
  it("sends the UPSTREAM model id, never the public one", () => {
    // Sending the public id would leak Bosanda's catalog naming upstream and
    // would simply be rejected.
    const result = transformRequest(
      request({ model: "bosanda-sonnet-4-5" }),
      options({ upstreamModelId: "CLAUDE_SONNET_4_5_20250929_V1_0" }),
    );

    const serialized = JSON.stringify(result.request);
    expect(serialized).toContain("CLAUDE_SONNET_4_5_20250929_V1_0");
    expect(serialized).not.toContain("bosanda-sonnet-4-5");
  });

  it("maps persona onto origin", () => {
    expect(
      transformRequest(request(), options({ persona: "cli" })).request.conversationState
        .currentMessage.userInputMessage.origin,
    ).toBe("CLI");
    expect(
      transformRequest(request(), options({ persona: "ide" })).request.conversationState
        .currentMessage.userInputMessage.origin,
    ).toBe("AI_EDITOR");
  });

  it("includes profileArn only when the account has one", () => {
    expect(transformRequest(request(), options()).request.profileArn).toBeUndefined();
    expect(
      transformRequest(request(), options({ profileArn: "arn:aws:test:::profile/A" })).request
        .profileArn,
    ).toBe("arn:aws:test:::profile/A");
  });

  it("always sets chatTriggerType to MANUAL", () => {
    expect(transformRequest(request(), options()).request.conversationState.chatTriggerType).toBe(
      "MANUAL",
    );
  });

  it("reports the fixture version, still marked draft", () => {
    // The -draft suffix records that this shape has never been validated against
    // live upstream traffic. It must not be removed without running §3 G1.
    expect(transformRequest(request(), options()).fixtureVersion).toBe(FIXTURE_VERSION);
    expect(FIXTURE_VERSION).toMatch(/-draft$/);
  });

  it("carries the system prompt on the first history turn when history exists", () => {
    // This wire shape has no dedicated system field, so it has to ride a user
    // turn — and it must appear exactly once.
    const result = transformRequest(
      request({
        system: "SYSTEM-PROMPT",
        messages: [
          { role: "user", content: [text("first")] },
          { role: "assistant", content: [text("reply")] },
          { role: "user", content: [text("second")] },
        ],
      }),
      options(),
    );

    const first = result.request.conversationState.history[0]!;
    expect("userInputMessage" in first && first.userInputMessage.content).toBe(
      "SYSTEM-PROMPT\n\nfirst",
    );
    expect(result.request.conversationState.currentMessage.userInputMessage.content).toBe("second");

    const occurrences = JSON.stringify(result.request).split("SYSTEM-PROMPT").length - 1;
    expect(occurrences).toBe(1);
  });

  it("carries the system prompt on the current message when there is no history", () => {
    const result = transformRequest(
      request({ system: "SYSTEM-PROMPT", messages: [{ role: "user", content: [text("only")] }] }),
      options(),
    );

    expect(result.request.conversationState.history).toEqual([]);
    expect(result.request.conversationState.currentMessage.userInputMessage.content).toBe(
      "SYSTEM-PROMPT\n\nonly",
    );
  });
});
