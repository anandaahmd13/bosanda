/**
 * Event translation and error classification tests (PLAN.md §6 items 9/11,
 * §3 G2/G3/G4, §7, §8, §17).
 *
 * The reason this module is worth heavy coverage: §7's scheduler behaviour is
 * driven ENTIRELY by the ErrorCode chosen here. A misclassification does not
 * produce a wrong error message, it produces the wrong OPERATIONAL response —
 * retrying into a throttle, cooling down an account that did nothing wrong, or
 * failing to open the compatibility circuit breaker that §3 relies on to notice
 * the undocumented protocol changed.
 *
 * So the classification tests assert the CONSEQUENCE (`isProviderRetryable`,
 * `shouldCooldownProvider`) alongside the code. Asserting only the code would
 * let a future edit to the RETRYABLE set in @bosanda/protocol silently change
 * scheduler behaviour with every test still green.
 *
 * Two properties get adversarial rather than happy-path coverage:
 *
 *  - §17 forbids upstream payload text in any error or log field. Every error
 *    path here is checked against a payload seeded with a marker string, and the
 *    assertion is on the whole serialized error including `cause`.
 *  - §3 G3 requires MULTIPLE concurrent tool calls with stable IDs and
 *    incremental JSON. Interleaved streams are tested, not just sequential ones.
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { TimeoutError } from "@bosanda/shared";
import {
  EventStreamError,
  type EventStreamFaultKind,
  type EventStreamMessage,
} from "../src/eventstream.js";
import {
  ToolBlockTracker,
  classifyExceptionFrame,
  classifyHttpStatus,
  classifyStreamError,
  extractUsage,
  isAbortError,
  newTelemetry,
  toCanonicalEvents,
  toFinishReason,
} from "../src/stream.js";

// --- helpers ----------------------------------------------------------------

/**
 * Builds a decoded message directly rather than encoding and decoding a frame.
 * The wire format is covered exhaustively in eventstream.test.ts; going through
 * it here would couple every classification test to the codec.
 */
function msg(
  parts: Partial<Omit<EventStreamMessage, "payload">> & { body?: unknown; raw?: string },
): EventStreamMessage {
  const text = parts.raw ?? (parts.body === undefined ? "" : JSON.stringify(parts.body));
  const payload = new TextEncoder().encode(text);
  // `in` rather than `??` so an EXPLICIT null is preserved: a frame whose
  // headers are genuinely absent is a real case, and `??` would quietly
  // substitute the default and test something else.
  return {
    headers: {},
    payload,
    messageType: "messageType" in parts ? parts.messageType! : "event",
    eventType: "eventType" in parts ? parts.eventType! : null,
    exceptionType: "exceptionType" in parts ? parts.exceptionType! : null,
    contentType: "contentType" in parts ? parts.contentType! : "application/json",
    totalLength: 16 + payload.byteLength,
  };
}

const event = (eventType: string, body?: unknown): EventStreamMessage =>
  msg({ eventType, ...(body === undefined ? {} : { body }) });

/**
 * Serializes an error and everything reachable from it, so a leak hiding in
 * `cause`, `internalDetail`, or a nested property is still caught. `Error` has
 * non-enumerable message/stack, so those are pulled out explicitly.
 */
function fullText(error: unknown): string {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string => {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "";
    seen.add(value);
    const parts: string[] = [];
    if (value instanceof Error) {
      parts.push(value.name, value.message, value.stack ?? "", walk(value.cause));
    }
    for (const key of Object.keys(value)) {
      parts.push(key, walk((value as Record<string, unknown>)[key]));
    }
    return parts.join(" ");
  };
  return walk(error);
}

/** A payload whose every field value is a marker, so any leak is visible. */
const LEAK = "LEAKED-UPSTREAM-PROSE-9f2a";

describe("toFinishReason", () => {
  it("maps the known stop reasons in both casings", () => {
    expect(toFinishReason("tool_use")).toBe("tool_use");
    expect(toFinishReason("toolUse")).toBe("tool_use");
    expect(toFinishReason("TOOL_USE")).toBe("tool_use");
    expect(toFinishReason("max_tokens")).toBe("max_tokens");
    expect(toFinishReason("maxTokens")).toBe("max_tokens");
    expect(toFinishReason("length")).toBe("max_tokens");
    expect(toFinishReason("refusal")).toBe("refusal");
    expect(toFinishReason("content_filtered")).toBe("refusal");
    expect(toFinishReason("contentFiltered")).toBe("refusal");
    expect(toFinishReason("end_turn")).toBe("end_turn");
  });

  it("falls back to end_turn for an unrecognised or absent label", () => {
    // Deliberate: the turn DID complete. Failing it over an unfamiliar label
    // would discard output the customer has already been billed for.
    for (const raw of ["some_new_reason", "", null, undefined, 42, {}, []]) {
      expect(toFinishReason(raw)).toBe("end_turn");
    }
  });
});

describe("ToolBlockTracker", () => {
  it("assigns stable ascending indices and reports new calls once", () => {
    const tracker = new ToolBlockTracker();
    expect(tracker.resolve("call_a")).toEqual({ index: 0, started: true });
    expect(tracker.resolve("call_a")).toEqual({ index: 0, started: false });
    expect(tracker.resolve("call_b")).toEqual({ index: 1, started: true });
    expect(tracker.resolve("call_a")).toEqual({ index: 0, started: false });
    expect(tracker.count).toBe(2);
  });

  it("keeps indices stable when calls interleave (§3 G3 concurrent tool use)", () => {
    const tracker = new ToolBlockTracker();
    const order = ["x", "y", "z", "y", "x", "z", "x"];
    const indices = order.map((id) => tracker.resolve(id).index);
    expect(indices).toEqual([0, 1, 2, 1, 0, 2, 0]);
  });

  it("does not reuse the index of a closed call", () => {
    // A reused index would make a later tool call's deltas land in the block a
    // client already finished, corrupting both.
    const tracker = new ToolBlockTracker();
    tracker.resolve("first");
    tracker.close(0);
    expect(tracker.resolve("second").index).toBe(1);
  });

  it("reports open indices in ascending order and forgets closed ones", () => {
    const tracker = new ToolBlockTracker();
    for (const id of ["a", "b", "c", "d"]) tracker.resolve(id);
    expect(tracker.close(2)).toBe(true);
    expect(tracker.close(0)).toBe(true);
    expect(tracker.openIndices()).toEqual([1, 3]);
  });

  it("reports a redundant close as false so a double stop is detectable", () => {
    const tracker = new ToolBlockTracker();
    tracker.resolve("a");
    expect(tracker.close(0)).toBe(true);
    expect(tracker.close(0)).toBe(false);
    expect(tracker.close(99)).toBe(false);
  });
});

describe("toCanonicalEvents — content", () => {
  it("emits a text delta for assistantResponseEvent and codeEvent", () => {
    const tracker = new ToolBlockTracker();
    const telemetry = newTelemetry();
    expect(
      toCanonicalEvents(event("assistantResponseEvent", { content: "hi" }), tracker, telemetry),
    ).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(
      toCanonicalEvents(event("codeEvent", { content: "const x = 1;" }), tracker, telemetry),
    ).toEqual([{ type: "text_delta", text: "const x = 1;" }]);
  });

  it("drops an empty text delta rather than emitting a no-op event", () => {
    const events = toCanonicalEvents(
      event("assistantResponseEvent", { content: "" }),
      new ToolBlockTracker(),
      newTelemetry(),
    );
    expect(events).toEqual([]);
  });

  it("accepts either field name on reasoningContentEvent", () => {
    const tracker = new ToolBlockTracker();
    const telemetry = newTelemetry();
    expect(
      toCanonicalEvents(event("reasoningContentEvent", { content: "a" }), tracker, telemetry),
    ).toEqual([{ type: "reasoning_delta", text: "a" }]);
    expect(
      toCanonicalEvents(event("reasoningContentEvent", { text: "b" }), tracker, telemetry),
    ).toEqual([{ type: "reasoning_delta", text: "b" }]);
  });

  it("rejects a content event whose content field is not a string", () => {
    for (const body of [{ content: 42 }, { content: null }, {}, { Content: "wrong case" }]) {
      expect(() =>
        toCanonicalEvents(
          event("assistantResponseEvent", body),
          new ToolBlockTracker(),
          newTelemetry(),
        ),
      ).toThrow(BosandaError);
    }
  });

  it("names the missing field without quoting the payload (§17)", () => {
    try {
      toCanonicalEvents(
        event("assistantResponseEvent", { content: { nested: LEAK } }),
        new ToolBlockTracker(),
        newTelemetry(),
      );
      expect.unreachable("expected a BosandaError");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).internalDetail).toContain("content");
      expect(fullText(error)).not.toContain(LEAK);
    }
  });

  it("sets sawStop and emits finish on messageStopEvent, empty payload included", () => {
    const telemetry = newTelemetry();
    expect(telemetry.sawStop).toBe(false);
    // A pure signal frame carries no payload at all.
    const events = toCanonicalEvents(
      msg({ eventType: "messageStopEvent" }),
      new ToolBlockTracker(),
      telemetry,
    );
    expect(events).toEqual([{ type: "finish", reason: "end_turn" }]);
    expect(telemetry.sawStop).toBe(true);
  });

  it("carries the upstream stopReason through to the finish event", () => {
    const events = toCanonicalEvents(
      event("messageStopEvent", { stopReason: "tool_use" }),
      new ToolBlockTracker(),
      newTelemetry(),
    );
    expect(events).toEqual([{ type: "finish", reason: "tool_use" }]);
  });
});

describe("toCanonicalEvents — tool calls (§3 G3)", () => {
  it("emits tool_start once, then input deltas, then tool_stop", () => {
    const tracker = new ToolBlockTracker();
    const telemetry = newTelemetry();
    const push = (body: unknown) =>
      toCanonicalEvents(event("toolUseEvent", body), tracker, telemetry);

    expect(push({ toolUseId: "tu_1", name: "Bash", input: '{"comm' })).toEqual([
      { type: "tool_start", index: 0, id: "tu_1", name: "Bash" },
      { type: "tool_input_delta", index: 0, partialJson: '{"comm' },
    ]);
    expect(push({ toolUseId: "tu_1", input: 'and":"ls"}' })).toEqual([
      { type: "tool_input_delta", index: 0, partialJson: 'and":"ls"}' },
    ]);
    expect(push({ toolUseId: "tu_1", stop: true })).toEqual([{ type: "tool_stop", index: 0 }]);
    expect(tracker.openIndices()).toEqual([]);
  });

  it("preserves the upstream tool ID verbatim (§6)", () => {
    // The client correlates its tool_result against exactly this value, so any
    // normalisation here breaks the loop.
    const odd = "tooluse_AbC-123_/+=.~";
    const events = toCanonicalEvents(
      event("toolUseEvent", { toolUseId: odd, name: "Read" }),
      new ToolBlockTracker(),
      newTelemetry(),
    );
    expect(events[0]).toMatchObject({ type: "tool_start", id: odd });
  });

  it("forwards input fragments verbatim without parsing them", () => {
    // Fragments are not valid JSON on their own — that IS the feature. Parsing
    // or re-serializing here would corrupt the client's assembly.
    const tracker = new ToolBlockTracker();
    const fragments = ['{"a', 'rg": "va', 'l"}'];
    const seen: string[] = [];
    for (const fragment of fragments) {
      const events = toCanonicalEvents(
        event("toolUseEvent", { toolUseId: "t", name: "X", input: fragment }),
        tracker,
        newTelemetry(),
      );
      for (const e of events) if (e.type === "tool_input_delta") seen.push(e.partialJson);
    }
    expect(seen).toEqual(fragments);
    expect(seen.join("")).toBe('{"arg": "val"}');
  });

  it("serializes a non-streamed complete input object as one fragment", () => {
    const events = toCanonicalEvents(
      event("toolUseEvent", { toolUseId: "t", name: "X", input: { command: "ls" } }),
      new ToolBlockTracker(),
      newTelemetry(),
    );
    expect(events).toEqual([
      { type: "tool_start", index: 0, id: "t", name: "X" },
      { type: "tool_input_delta", index: 0, partialJson: '{"command":"ls"}' },
    ]);
  });

  it("omits an input delta when the fragment is absent or empty", () => {
    const tracker = new ToolBlockTracker();
    expect(
      toCanonicalEvents(
        event("toolUseEvent", { toolUseId: "t", name: "X" }),
        tracker,
        newTelemetry(),
      ),
    ).toEqual([{ type: "tool_start", index: 0, id: "t", name: "X" }]);
    expect(
      toCanonicalEvents(
        event("toolUseEvent", { toolUseId: "t", input: "" }),
        tracker,
        newTelemetry(),
      ),
    ).toEqual([]);
  });

  it("interleaves two concurrent tool calls onto stable separate indices", () => {
    const tracker = new ToolBlockTracker();
    const telemetry = newTelemetry();
    const all = [
      { toolUseId: "a", name: "Read", input: '{"p' },
      { toolUseId: "b", name: "Grep", input: '{"q' },
      { toolUseId: "a", input: 'ath":"x"}' },
      { toolUseId: "b", input: '":"y"}' },
      { toolUseId: "a", stop: true },
      { toolUseId: "b", stop: true },
    ].flatMap((body) => toCanonicalEvents(event("toolUseEvent", body), tracker, telemetry));

    expect(all).toEqual([
      { type: "tool_start", index: 0, id: "a", name: "Read" },
      { type: "tool_input_delta", index: 0, partialJson: '{"p' },
      { type: "tool_start", index: 1, id: "b", name: "Grep" },
      { type: "tool_input_delta", index: 1, partialJson: '{"q' },
      { type: "tool_input_delta", index: 0, partialJson: 'ath":"x"}' },
      { type: "tool_input_delta", index: 1, partialJson: '":"y"}' },
      { type: "tool_stop", index: 0 },
      { type: "tool_stop", index: 1 },
    ]);
  });

  it("leaves an unstopped call open so the adapter can close it", () => {
    // §3 G3 requires a well-formed block sequence. If upstream ends without a
    // stop, the adapter must synthesize one from openIndices().
    const tracker = new ToolBlockTracker();
    for (const body of [
      { toolUseId: "a", name: "A" },
      { toolUseId: "b", name: "B" },
      { toolUseId: "a", stop: true },
    ]) {
      toCanonicalEvents(event("toolUseEvent", body), tracker, newTelemetry());
    }
    expect(tracker.openIndices()).toEqual([1]);
  });

  it("rejects a toolUseEvent with no string toolUseId", () => {
    for (const body of [{ name: "X" }, { toolUseId: 7, name: "X" }, { toolUseId: null }]) {
      expect(() =>
        toCanonicalEvents(event("toolUseEvent", body), new ToolBlockTracker(), newTelemetry()),
      ).toThrow(/toolUseId/);
    }
  });

  it("rejects a FIRST toolUseEvent with no name but allows later ones without it", () => {
    const tracker = new ToolBlockTracker();
    expect(() =>
      toCanonicalEvents(event("toolUseEvent", { toolUseId: "t" }), tracker, newTelemetry()),
    ).toThrow(/name/);
    // The tracker still allocated the index, so a continuation is accepted.
    expect(() =>
      toCanonicalEvents(
        event("toolUseEvent", { toolUseId: "t", input: "x" }),
        tracker,
        newTelemetry(),
      ),
    ).not.toThrow();
  });

  it("classifies a tool-call shape failure as upstream_incompatible", () => {
    // Not invalid_request: the CLIENT did nothing wrong, and §3 wants these
    // counted toward the compatibility circuit breaker.
    try {
      toCanonicalEvents(
        event("toolUseEvent", { name: "X" }),
        new ToolBlockTracker(),
        newTelemetry(),
      );
      expect.unreachable("expected a BosandaError");
    } catch (error) {
      expect((error as BosandaError).code).toBe("upstream_incompatible");
      expect((error as BosandaError).isProviderRetryable).toBe(true);
      expect((error as BosandaError).shouldCooldownProvider).toBe(true);
    }
  });
});

describe("toCanonicalEvents — unknown and malformed frames", () => {
  it("counts an unknown event type and ignores it (§6)", () => {
    // An upstream adding a new informational event must not break live traffic.
    const telemetry = newTelemetry();
    const tracker = new ToolBlockTracker();
    for (let i = 0; i < 3; i += 1) {
      expect(
        toCanonicalEvents(event("someFutureEvent", { anything: LEAK }), tracker, telemetry),
      ).toEqual([]);
    }
    toCanonicalEvents(event("anotherNewEvent"), tracker, telemetry);
    expect([...telemetry.unknownEvents]).toEqual([
      ["someFutureEvent", 3],
      ["anotherNewEvent", 1],
    ]);
  });

  it("records only the type name of an unknown event, never its payload (§17)", () => {
    const telemetry = newTelemetry();
    toCanonicalEvents(event("mysteryEvent", { secret: LEAK }), new ToolBlockTracker(), telemetry);
    expect(JSON.stringify([...telemetry.unknownEvents])).not.toContain(LEAK);
  });

  it("rejects a frame with no :event-type header", () => {
    try {
      toCanonicalEvents(msg({ eventType: null }), new ToolBlockTracker(), newTelemetry());
      expect.unreachable("expected a BosandaError");
    } catch (error) {
      expect((error as BosandaError).code).toBe("upstream_incompatible");
      expect((error as BosandaError).internalDetail).toContain("no :event-type");
    }
  });

  it("rejects a payload that is valid JSON but not an object", () => {
    for (const raw of ['"a string"', "42", "true", "[1,2]", "null"]) {
      const message = msg({ eventType: "assistantResponseEvent", raw });
      // `null` decodes to JSON null, which payloadJson cannot distinguish from
      // an empty payload, so it becomes a missing-content error instead.
      expect(() => toCanonicalEvents(message, new ToolBlockTracker(), newTelemetry())).toThrow(
        BosandaError,
      );
    }
  });

  it("treats unparseable payload bytes as an empty payload, not a crash", () => {
    // payloadJson returns null rather than throwing, so the event's own field
    // check produces the error and the message stays clean.
    const message = msg({ eventType: "assistantResponseEvent", raw: "{not json" });
    expect(() => toCanonicalEvents(message, new ToolBlockTracker(), newTelemetry())).toThrow(
      /missing a string "content" field/,
    );
  });

  it("classifies an exception frame before reading any event type", () => {
    // An exception frame can also carry an :event-type. Treating it as an event
    // would surface an upstream error string as model output.
    const message = msg({
      messageType: "exception",
      eventType: "assistantResponseEvent",
      exceptionType: "ThrottlingException",
      body: { content: LEAK },
    });
    try {
      toCanonicalEvents(message, new ToolBlockTracker(), newTelemetry());
      expect.unreachable("expected a BosandaError");
    } catch (error) {
      expect((error as BosandaError).code).toBe("rate_limit");
      expect(fullText(error)).not.toContain(LEAK);
    }
  });

  it("classifies an error-type frame as an exception too", () => {
    expect(() =>
      toCanonicalEvents(
        msg({ messageType: "error", exceptionType: "InternalServerException" }),
        new ToolBlockTracker(),
        newTelemetry(),
      ),
    ).toThrow(BosandaError);
  });
});

describe("extractUsage (§3 G4, §10)", () => {
  it("reads counts from the top level and from a nested usage object", () => {
    expect(extractUsage({ inputTokens: 10, outputTokens: 20 })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(extractUsage({ usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3 } })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 3,
    });
  });

  it("accepts each observed spelling of every field", () => {
    expect(extractUsage({ input_tokens: 5 })).toEqual({ inputTokens: 5 });
    expect(extractUsage({ promptTokens: 6 })).toEqual({ inputTokens: 6 });
    expect(extractUsage({ output_tokens: 7 })).toEqual({ outputTokens: 7 });
    expect(extractUsage({ completionTokens: 8 })).toEqual({ outputTokens: 8 });
    expect(extractUsage({ cacheReadInputTokens: 9 })).toEqual({ cachedTokens: 9 });
    expect(extractUsage({ cached_tokens: 11 })).toEqual({ cachedTokens: 11 });
  });

  it("returns null when nothing recognisable is present", () => {
    // Null, not zeros: §10 forbids treating a missing report as authoritative,
    // and zeros would silently bill the customer nothing.
    expect(extractUsage({})).toBeNull();
    expect(extractUsage({ somethingElse: 1 })).toBeNull();
    expect(extractUsage({ usage: {} })).toBeNull();
  });

  it("ignores non-numeric, negative, and non-finite counts", () => {
    expect(extractUsage({ inputTokens: "10" })).toBeNull();
    expect(extractUsage({ inputTokens: -1 })).toBeNull();
    expect(extractUsage({ inputTokens: Number.NaN })).toBeNull();
    expect(extractUsage({ inputTokens: Number.POSITIVE_INFINITY })).toBeNull();
    expect(extractUsage({ inputTokens: null })).toBeNull();
  });

  it("truncates a fractional count rather than rejecting the whole event", () => {
    expect(extractUsage({ inputTokens: 10.9 })).toEqual({ inputTokens: 10 });
  });

  it("omits absent fields instead of setting them undefined", () => {
    // The metering layer distinguishes "absent" from "present and zero", so an
    // explicit undefined key would blur that.
    const usage = extractUsage({ inputTokens: 3 });
    expect(usage).not.toBeNull();
    expect(Object.keys(usage as object)).toEqual(["inputTokens"]);
  });

  it("accepts a genuine zero count", () => {
    expect(extractUsage({ outputTokens: 0 })).toEqual({ outputTokens: 0 });
  });

  it("records usage from metricsEvent and keeps the last usable report", () => {
    const telemetry = newTelemetry();
    const tracker = new ToolBlockTracker();
    expect(
      toCanonicalEvents(event("metricsEvent", { inputTokens: 5 }), tracker, telemetry),
    ).toEqual([]);
    expect(telemetry.usage).toEqual({ inputTokens: 5 });
    // An unrecognisable later metricsEvent must not wipe a good report.
    toCanonicalEvents(event("metricsEvent", { nothing: true }), tracker, telemetry);
    expect(telemetry.usage).toEqual({ inputTokens: 5 });
    toCanonicalEvents(
      event("metricsEvent", { inputTokens: 9, outputTokens: 4 }),
      tracker,
      telemetry,
    );
    expect(telemetry.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });
});

describe("classifyExceptionFrame (§7, §8)", () => {
  const cases: readonly {
    type: string;
    code: string;
    retryable: boolean;
    cooldown: boolean;
  }[] = [
    { type: "ThrottlingException", code: "rate_limit", retryable: false, cooldown: true },
    { type: "TooManyRequestsException", code: "rate_limit", retryable: false, cooldown: true },
    { type: "QuotaExceededException", code: "rate_limit", retryable: false, cooldown: true },
    { type: "LimitExceededException", code: "rate_limit", retryable: false, cooldown: true },
    {
      type: "ExpiredTokenException",
      code: "authentication_error",
      retryable: false,
      cooldown: false,
    },
    {
      type: "AccessDeniedException",
      code: "authentication_error",
      retryable: false,
      cooldown: false,
    },
    {
      type: "UnauthorizedException",
      code: "authentication_error",
      retryable: false,
      cooldown: false,
    },
    {
      type: "InvalidGrantException",
      code: "authentication_error",
      retryable: false,
      cooldown: false,
    },
    { type: "RequestTimeoutException", code: "upstream_timeout", retryable: true, cooldown: true },
    { type: "TimedOutException", code: "upstream_timeout", retryable: true, cooldown: true },
    {
      type: "ModelNotSupportedException",
      code: "model_not_allowed",
      retryable: false,
      cooldown: false,
    },
    { type: "InvalidModelException", code: "model_not_allowed", retryable: false, cooldown: false },
    { type: "ValidationException", code: "upstream_incompatible", retryable: true, cooldown: true },
    {
      type: "SerializationException",
      code: "upstream_incompatible",
      retryable: true,
      cooldown: true,
    },
    {
      type: "InternalServerException",
      code: "upstream_incompatible",
      retryable: true,
      cooldown: true,
    },
    {
      type: "ServiceUnavailableException",
      code: "upstream_incompatible",
      retryable: true,
      cooldown: true,
    },
  ];

  it.each(cases)(
    "$type -> $code (retryable=$retryable, cooldown=$cooldown)",
    ({ type, code, retryable, cooldown }) => {
      // The consequence is asserted alongside the code: a change to §7's
      // RETRYABLE set must not pass silently.
      const error = classifyExceptionFrame(msg({ messageType: "exception", exceptionType: type }));
      expect(error.code).toBe(code);
      expect(error.isProviderRetryable).toBe(retryable);
      expect(error.shouldCooldownProvider).toBe(cooldown);
    },
  );

  it("defaults an unrecognised exception type to upstream_incompatible", () => {
    // Not internal_error: an unanticipated fault against an undocumented
    // protocol is more likely an upstream change, and §3 wants it counted.
    const error = classifyExceptionFrame(
      msg({ messageType: "exception", exceptionType: "SomeBrandNewException" }),
    );
    expect(error.code).toBe("upstream_incompatible");
    expect(error.shouldCooldownProvider).toBe(true);
  });

  it("matches the exception TYPE and ignores message prose", () => {
    // Matching on a human-readable message would classify on text that is part
    // of no contract, and would copy upstream prose into our logs.
    const error = classifyExceptionFrame(
      msg({
        messageType: "exception",
        exceptionType: "InternalServerException",
        body: { message: `throttled: ${LEAK}` },
      }),
    );
    expect(error.code).toBe("upstream_incompatible");
    expect(fullText(error)).not.toContain(LEAK);
  });

  it("falls back through eventType then messageType for a name", () => {
    expect(
      classifyExceptionFrame(msg({ messageType: "exception", eventType: "ThrottlingException" }))
        .code,
    ).toBe("rate_limit");
    expect(classifyExceptionFrame(msg({ messageType: "exception" })).internalDetail).toContain(
      "exception",
    );
  });

  it("labels a frame with no identifying header at all", () => {
    const error = classifyExceptionFrame(
      msg({ messageType: null, eventType: null, exceptionType: null }),
    );
    expect(error.internalDetail).toContain("unknown_exception");
  });

  it("reads a numeric retry hint under either field name", () => {
    for (const field of ["retryAfterSeconds", "retryAfter"]) {
      const error = classifyExceptionFrame(
        msg({
          messageType: "exception",
          exceptionType: "ThrottlingException",
          body: { [field]: 30 },
        }),
      );
      expect(error.retryAfterSeconds).toBe(30);
    }
  });

  it("ignores a non-numeric or negative retry hint", () => {
    for (const value of ["30", -5, null, {}]) {
      const error = classifyExceptionFrame(
        msg({
          messageType: "exception",
          exceptionType: "ThrottlingException",
          body: { retryAfterSeconds: value },
        }),
      );
      expect(error.retryAfterSeconds).toBeUndefined();
    }
  });

  it("survives an exception frame with an unparseable body", () => {
    const error = classifyExceptionFrame(
      msg({
        messageType: "exception",
        exceptionType: "ThrottlingException",
        raw: "<html>502</html>",
      }),
    );
    expect(error.code).toBe("rate_limit");
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(fullText(error)).not.toContain("html");
  });

  it("never places the upstream body in the error, for any classification", () => {
    for (const type of cases.map((entry) => entry.type)) {
      const error = classifyExceptionFrame(
        msg({
          messageType: "exception",
          exceptionType: type,
          body: { message: LEAK, detail: LEAK, trace: [LEAK] },
        }),
      );
      expect(fullText(error)).not.toContain(LEAK);
    }
  });

  it("keeps the client-visible message free of upstream detail", () => {
    const error = classifyExceptionFrame(
      msg({
        messageType: "exception",
        exceptionType: "ValidationException",
        body: { message: LEAK },
      }),
    );
    expect(error.publicMessage).toBe("The upstream provider returned an incompatible response.");
    expect(error.publicMessage).not.toContain("Validation");
  });
});

describe("classifyStreamError", () => {
  it("passes an existing BosandaError through untouched", () => {
    const original = new BosandaError("quota_exhausted", { internalDetail: "already classified" });
    expect(classifyStreamError(original, "acct_1")).toBe(original);
  });

  const faults: readonly EventStreamFaultKind[] = [
    "prelude_crc",
    "message_crc",
    "frame_too_large",
    "buffer_overflow",
    "truncated",
    "malformed_prelude",
    "malformed_header",
    "poisoned",
  ];

  it.each(faults)("maps the %s fault to upstream_incompatible with cooldown", (kind) => {
    // Every parse fault is a compatibility signal per §3, so all eight must
    // cool the account down and feed the circuit breaker.
    const error = classifyStreamError(new EventStreamError(kind, "shape detail"), "acct_7");
    expect(error.code).toBe("upstream_incompatible");
    expect(error.isProviderRetryable).toBe(true);
    expect(error.shouldCooldownProvider).toBe(true);
    expect(error.internalDetail).toBe(`eventstream ${kind}`);
    expect(error.providerAccountId).toBe("acct_7");
    expect(error.cause).toBeInstanceOf(EventStreamError);
  });

  it("maps both timeout kinds to upstream_timeout", () => {
    for (const kind of ["idle", "hard"] as const) {
      const error = classifyStreamError(new TimeoutError(kind, 30_000), "acct_2");
      expect(error.code).toBe("upstream_timeout");
      expect(error.isProviderRetryable).toBe(true);
      expect(error.shouldCooldownProvider).toBe(true);
      expect(error.internalDetail).toContain(kind);
    }
  });

  it("maps a client abort to invalid_request with no cooldown", () => {
    // The account did nothing wrong. Cooling it down would let a client with a
    // flaky connection disable the pool.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const error = classifyStreamError(abort, "acct_3");
    expect(error.code).toBe("invalid_request");
    expect(error.shouldCooldownProvider).toBe(false);
    expect(error.isProviderRetryable).toBe(false);
  });

  it("defaults an unknown throwable to upstream_incompatible", () => {
    for (const thrown of [new Error("boom"), "a string", 42, null, undefined, { odd: true }]) {
      const error = classifyStreamError(thrown);
      expect(error.code).toBe("upstream_incompatible");
      expect(error.internalDetail).toBe("unclassified upstream streaming failure");
    }
  });

  it("omits the account attribution when none is supplied", () => {
    expect(classifyStreamError(new Error("boom")).providerAccountId).toBeUndefined();
  });

  it("keeps an unknown error's own message out of internalDetail (§17)", () => {
    // The cause is retained for a stack trace, but the detail we log as our own
    // must not adopt text from an arbitrary throwable.
    const error = classifyStreamError(new Error(LEAK));
    expect(error.internalDetail).not.toContain(LEAK);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe("classifyHttpStatus", () => {
  const cases: readonly [number, string, boolean][] = [
    [401, "authentication_error", false],
    [403, "authentication_error", false],
    [404, "model_not_allowed", false],
    [429, "rate_limit", true],
    [408, "upstream_timeout", true],
    [504, "upstream_timeout", true],
    [400, "upstream_incompatible", true],
    [418, "upstream_incompatible", true],
    [500, "upstream_incompatible", true],
    [502, "upstream_incompatible", true],
    [503, "upstream_incompatible", true],
  ];

  it.each(cases)("HTTP %i -> %s (cooldown=%s)", (status, code, cooldown) => {
    const error = classifyHttpStatus(status);
    expect(error.code).toBe(code);
    expect(error.shouldCooldownProvider).toBe(cooldown);
    expect(error.internalDetail).toBe(`upstream returned HTTP ${status}`);
  });

  it("carries a Retry-After hint through when given", () => {
    expect(classifyHttpStatus(429, 60).retryAfterSeconds).toBe(60);
    expect(classifyHttpStatus(429).retryAfterSeconds).toBeUndefined();
  });

  it("never puts the status in the client-visible message", () => {
    expect(classifyHttpStatus(500).publicMessage).not.toContain("500");
  });
});

describe("isAbortError", () => {
  it("recognises the shape without requiring a DOMException", () => {
    expect(isAbortError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("rejects everything else, including near misses", () => {
    for (const value of [
      new Error("AbortError"),
      { name: "aborterror" },
      { name: "TimeoutError" },
      "AbortError",
      null,
      undefined,
      42,
    ]) {
      expect(isAbortError(value)).toBe(false);
    }
  });
});

describe("newTelemetry", () => {
  it("returns independent state per turn", () => {
    // Shared telemetry would leak one customer's token counts into another's
    // usage row.
    const a = newTelemetry();
    const b = newTelemetry();
    a.unknownEvents.set("x", 1);
    a.usage = { inputTokens: 1 };
    a.sawStop = true;
    expect(b.unknownEvents.size).toBe(0);
    expect(b.usage).toBeNull();
    expect(b.sawStop).toBe(false);
  });
});
