import { describe, expect, it } from "vitest";
import { ulid, requestId, toolCallId, messageId, conversationId } from "@bosanda/shared";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
  it("is 26 Crockford base32 chars", () => {
    for (let i = 0; i < 200; i += 1) expect(ulid()).toMatch(CROCKFORD);
  });

  it("sorts lexicographically by time so index inserts stay append-mostly", () => {
    const early = ulid(1_700_000_000_000);
    const later = ulid(1_800_000_000_000);
    expect(early < later).toBe(true);
  });

  it("encodes the same timestamp prefix for the same millisecond", () => {
    const at = 1_750_000_000_000;
    expect(ulid(at).slice(0, 10)).toBe(ulid(at).slice(0, 10));
  });

  it("is unique across many draws in one millisecond", () => {
    const at = 1_750_000_000_000;
    const seen = new Set(Array.from({ length: 5000 }, () => ulid(at)));
    expect(seen.size).toBe(5000);
  });

  it("uses the full random alphabet rather than a truncated window", () => {
    const chars = new Set<string>();
    for (let i = 0; i < 3000; i += 1) {
      for (const ch of ulid(1_750_000_000_000).slice(10)) chars.add(ch);
    }
    // A correct 5-bit reader reaches every symbol; a broken shift collapses the range.
    expect(chars.size).toBe(32);
  });
});

describe("prefixed ids", () => {
  it("namespaces request ids", () => {
    expect(requestId()).toMatch(/^req_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("emits opaque tool call ids", () => {
    const id = toolCallId();
    expect(id).toMatch(/^toolu_[A-Za-z0-9_-]{16}$/);
    expect(toolCallId()).not.toBe(id);
  });

  it("uses the surface-appropriate message id prefix", () => {
    expect(messageId("openai")).toMatch(/^chatcmpl_[A-Za-z0-9_-]{16}$/);
    expect(messageId("anthropic")).toMatch(/^msg_[A-Za-z0-9_-]{16}$/);
  });

  it("never reuses a conversation id (PLAN.md §6 isolation invariant)", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => conversationId()));
    expect(seen.size).toBe(1000);
    expect([...seen][0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
