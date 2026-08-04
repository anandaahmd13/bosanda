import { describe, expect, it } from "vitest";
import {
  CodexAdapter,
  ContinuationMap,
  mapCodexModel,
  toCanonicalEvents,
} from "@bosanda/provider-codex";
import type { CodexRuntime } from "@bosanda/provider-codex";

describe("provider-codex", () => {
  it("maps private upstream ids to unpublished public models", () => {
    const model = mapCodexModel({ id: "gpt-5-codex", displayName: "Codex" });
    expect(model.publicId).toBe("bosanda-codex-gpt-5-codex");
    expect(model.published).toBe(false);
    expect(model.compatibilityStatus).toBe("unknown");
  });

  it("maps text and terminal events", () => {
    expect(
      toCanonicalEvents({ method: "item/agentMessage/delta", params: { delta: "hi" } }, "m"),
    ).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(toCanonicalEvents({ method: "turn/completed" }, "m")).toEqual([
      { type: "finish", reason: "end_turn" },
    ]);
  });

  it("keeps the adapter disabled by default", async () => {
    const runtime: CodexRuntime = {
      accountRead: async () => ({ authenticated: true }),
      modelList: async () => [],
      turn: async function* () {
        yield { method: "turn/completed" };
      },
    };
    const adapter = new CodexAdapter({ runtime });
    await expect(adapter.validateAccount("a")).rejects.toMatchObject({ code: "adapter_disabled" });
  });

  it("pins continuations to the account", () => {
    const map = new ContinuationMap(1000);
    map.remember("tool", "a", "call");
    expect(map.take("tool", "b")).toBeNull();
    expect(map.take("tool", "a")?.callId).toBe("call");
  });
});
