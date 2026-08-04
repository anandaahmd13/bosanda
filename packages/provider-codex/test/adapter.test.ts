import { describe, expect, it } from "vitest";
import {
  CodexAdapter,
  ContinuationMap,
  createToolEventTracker,
  mapCodexModel,
  toCanonicalEvents,
} from "@bosanda/provider-codex";
import type { CodexRuntime } from "@bosanda/provider-codex";
import type { CanonicalRequest } from "@bosanda/protocol";

function runtimeStub(overrides: Partial<CodexRuntime> = {}): CodexRuntime {
  return {
    health: async () => ({ ready: true }),
    accountRead: async () => ({ authenticated: true }),
    loginStart: async () => ({ state: "pending" }),
    loginStatus: async () => ({ state: "idle" }),
    loginCancel: async () => ({ state: "cancelled" }),
    logout: async () => undefined,
    modelList: async () => [],
    turn: async function* () {
      yield { method: "turn/completed" };
    },
    continueTurn: async function* () {
      yield { method: "turn/completed" };
    },
    abortTurn: async () => undefined,
    ...overrides,
  };
}

const baseRequest: CanonicalRequest = {
  requestId: "req_1",
  surface: "anthropic",
  model: "bosanda-codex-gpt-5",
  system: null,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  toolChoice: null,
  stream: true,
  maxTokens: null,
  temperature: null,
  topP: null,
  stopSequences: [],
  includeUsage: true,
};

describe("provider-codex", () => {
  it("maps private upstream ids to unpublished public models", () => {
    const model = mapCodexModel({ id: "gpt-5-codex", displayName: "Codex" });
    expect(model.publicId).toBe("bosanda-codex-gpt-5-codex");
    expect(model.published).toBe(false);
    expect(model.compatibilityStatus).toBe("unknown");
  });

  it("maps text, tool, usage, and terminal events", () => {
    const tracker = createToolEventTracker();
    expect(
      toCanonicalEvents({ method: "item/agentMessage/delta", params: { delta: "hi" } }, "m"),
    ).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(
      toCanonicalEvents(
        { method: "item/toolCall/start", params: { callId: "c1", name: "Read" } },
        "m",
        tracker,
      ),
    ).toEqual([{ type: "tool_start", index: 0, id: "c1", name: "Read" }]);
    expect(
      toCanonicalEvents(
        { method: "item/toolCall/inputDelta", params: { callId: "c1", delta: '{"p"' } },
        "m",
        tracker,
      ),
    ).toEqual([{ type: "tool_input_delta", index: 0, partialJson: '{"p"' }]);
    expect(
      toCanonicalEvents({ method: "item/toolCall/end", params: { callId: "c1" } }, "m", tracker),
    ).toEqual([{ type: "tool_stop", index: 0 }]);
    expect(
      toCanonicalEvents(
        {
          method: "thread/tokenUsage/updated",
          params: { last: { inputTokens: 3, outputTokens: 5 } },
        },
        "m",
      ),
    ).toEqual([{ type: "usage", inputTokens: 3, outputTokens: 5, estimated: false }]);
    expect(toCanonicalEvents({ method: "turn/completed" }, "m")).toEqual([
      { type: "finish", reason: "end_turn" },
    ]);
    expect(toCanonicalEvents({ method: "turn/interrupted" }, "m")).toEqual([
      { type: "finish", reason: "refusal" },
    ]);
  });

  it("throws on process-loss turn failures", () => {
    expect(() =>
      toCanonicalEvents({ method: "turn/failed", params: { reason: "process_lost" } }, "m"),
    ).toThrow(/process lost/);
  });

  it("keeps the adapter disabled by default", async () => {
    const adapter = new CodexAdapter({ runtime: runtimeStub() });
    await expect(adapter.validateAccount("a")).rejects.toMatchObject({ code: "adapter_disabled" });
  });

  it("validates authenticated accounts when gates are on", async () => {
    const adapter = new CodexAdapter({
      runtime: runtimeStub(),
      enabled: () => true,
      commercialEnabled: () => true,
    });
    const health = await adapter.validateAccount("acct");
    expect(health.status).toBe("active");
    expect(health.persona).toBe("app_server");
  });

  it("rejects tool use while the tool gate is off", async () => {
    const adapter = new CodexAdapter({
      runtime: runtimeStub(),
      enabled: () => true,
      commercialEnabled: () => true,
      toolUseEnabled: () => false,
    });
    const request = {
      ...baseRequest,
      tools: [{ name: "Read", description: null, inputSchema: {} }],
    };
    expect(() => adapter.stream(request, "a", new AbortController().signal)).toThrow(
      /tool use is disabled/,
    );
  });

  it("pins continuations to the account", () => {
    const map = new ContinuationMap(1000);
    map.remember("tool", "a", "call");
    expect(map.take("tool", "b")).toBeNull();
    expect(map.take("tool", "a")?.callId).toBe("call");
  });

  it("refuses tool continuation pinned to another account", async () => {
    const map = new ContinuationMap(60_000);
    map.remember("tu_1", "acct-a", "call-1");
    const adapter = new CodexAdapter({
      runtime: runtimeStub(),
      enabled: () => true,
      commercialEnabled: () => true,
      toolUseEnabled: () => true,
      continuations: map,
    });
    const request: CanonicalRequest = {
      ...baseRequest,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "tu_1", content: "ok", isError: false }],
        },
      ],
    };
    const iter = adapter.stream(request, "acct-b", new AbortController().signal);
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
