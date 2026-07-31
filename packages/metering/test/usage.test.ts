import { describe, expect, it } from "vitest";
import type { CanonicalRequest } from "@bosanda/protocol";
import { METER_VERSION, resolveUsage, toCanonicalUsage } from "@bosanda/metering";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: "req_test",
    surface: "anthropic",
    model: "bosanda-sonnet",
    system: null,
    messages: [{ role: "user", content: [{ type: "text", text: "hello there" }] }],
    tools: [],
    toolChoice: null,
    stream: true,
    maxTokens: null,
    temperature: null,
    topP: null,
    stopSequences: [],
    includeUsage: false,
    ...overrides,
  };
}

describe("resolveUsage — priority 1: complete upstream is authoritative (§10)", () => {
  it("uses upstream numbers verbatim and marks them not estimated", () => {
    const resolved = resolveUsage({
      request: request(),
      upstream: { inputTokens: 1234, outputTokens: 567 },
      outputSegments: ["ignored because upstream is authoritative"],
    });

    expect(resolved.inputTokens).toBe(1234);
    expect(resolved.outputTokens).toBe(567);
    expect(resolved.estimated).toBe(false);
    expect(resolved.source).toBe("upstream");
    expect(resolved.meterVersion).toBe(METER_VERSION);
  });

  it("treats a zero-output upstream report as complete, not missing", () => {
    // 0 is a legitimate authoritative output count (e.g. an immediate refusal).
    // Truthiness checks would misclassify it as absent.
    const resolved = resolveUsage({
      request: request(),
      upstream: { inputTokens: 100, outputTokens: 0 },
      outputSegments: [],
    });
    expect(resolved.source).toBe("upstream");
    expect(resolved.estimated).toBe(false);
    expect(resolved.outputTokens).toBe(0);
  });

  it("ignores invalid upstream counts instead of carrying them into settlement", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const invalidInput = resolveUsage({
        request: request(),
        upstream: { inputTokens: bad, outputTokens: 10 },
        outputSegments: ["text"],
      });
      expect(invalidInput.estimated).toBe(true);
      expect(invalidInput.source).toBe("counted");
      expect(Number.isSafeInteger(invalidInput.inputTokens)).toBe(true);
      expect(invalidInput.partialUpstream).toEqual({ outputTokens: 10 });

      const invalidOutput = resolveUsage({
        request: request(),
        upstream: { inputTokens: 10, outputTokens: bad },
        outputSegments: ["text"],
      });
      expect(invalidOutput.estimated).toBe(true);
      expect(invalidOutput.source).toBe("counted");
      expect(Number.isSafeInteger(invalidOutput.outputTokens)).toBe(true);
      expect(invalidOutput.partialUpstream).toEqual({ inputTokens: 10 });
    }
  });
});

describe("resolveUsage — priority 2: partial upstream is NEVER authoritative (§10)", () => {
  it("marks a partial report estimated and preserves what upstream did say", () => {
    const resolved = resolveUsage({
      request: request(),
      upstream: { inputTokens: 900 },
      outputSegments: ["some generated text"],
    });

    expect(resolved.estimated).toBe(true);
    expect(resolved.source).toBe("counted");
    // The real upstream input number is still better than our estimate.
    expect(resolved.inputTokens).toBe(900);
    expect(resolved.outputTokens).toBeGreaterThan(0);
    expect(resolved.partialUpstream).toEqual({ inputTokens: 900 });
  });

  it("prefers a real upstream output count over the local estimate", () => {
    const resolved = resolveUsage({
      request: request(),
      upstream: { outputTokens: 42 },
      outputSegments: ["text that would estimate to something else entirely"],
    });

    expect(resolved.outputTokens).toBe(42);
    expect(resolved.estimated).toBe(true);
    expect(resolved.partialUpstream).toEqual({ outputTokens: 42 });
  });

  it("counts locally when upstream reported nothing at all", () => {
    const resolved = resolveUsage({
      request: request(),
      upstream: null,
      outputSegments: ["hello back"],
    });

    expect(resolved.source).toBe("counted");
    expect(resolved.estimated).toBe(true);
    expect(resolved.inputTokens).toBeGreaterThan(0);
    expect(resolved.outputTokens).toBeGreaterThan(0);
    expect(resolved.partialUpstream).toBeUndefined();
  });
});

describe("resolveUsage — priority 3: versioned fallback", () => {
  it("charges input only when a completed turn produced no observable output", () => {
    const resolved = resolveUsage({
      request: request(),
      upstream: null,
      outputSegments: [],
    });

    expect(resolved.source).toBe("fallback");
    expect(resolved.estimated).toBe(true);
    expect(resolved.inputTokens).toBeGreaterThan(0);
    expect(resolved.outputTokens).toBe(0);
  });

  it("adds a conservative output allowance for a turn cut short mid-generation", () => {
    const resolved = resolveUsage({
      request: request(),
      upstream: null,
      outputSegments: [],
      partialTurn: true,
    });

    expect(resolved.source).toBe("fallback");
    expect(resolved.outputTokens).toBeGreaterThan(0);
    expect(resolved.outputTokens).toBeLessThan(resolved.inputTokens);
  });

  it("still charges for the input a provider consumed on an errored turn (§10)", () => {
    // "Partial/error turns are charged for usage actually reported or estimated."
    const big = request({
      system: "x".repeat(4000),
      messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(8000) }] }],
    });
    const resolved = resolveUsage({ request: big, upstream: null, outputSegments: [] });
    expect(resolved.inputTokens).toBeGreaterThan(2000);
  });
});

describe("resolveUsage — provenance is always recorded (§10)", () => {
  it("stamps the meter version on every path", () => {
    const cases = [
      { upstream: { inputTokens: 1, outputTokens: 1 }, outputSegments: [] },
      { upstream: { inputTokens: 1 }, outputSegments: ["a"] },
      { upstream: null, outputSegments: ["a"] },
      { upstream: null, outputSegments: [] },
    ];
    for (const testCase of cases) {
      const resolved = resolveUsage({ request: request(), ...testCase });
      expect(resolved.meterVersion).toBe(METER_VERSION);
    }
  });

  it("exposes a source discriminator for every path", () => {
    expect(
      resolveUsage({
        request: request(),
        upstream: { inputTokens: 1, outputTokens: 1 },
        outputSegments: [],
      }).source,
    ).toBe("upstream");
    expect(resolveUsage({ request: request(), upstream: null, outputSegments: ["a"] }).source).toBe(
      "counted",
    );
    expect(resolveUsage({ request: request(), upstream: null, outputSegments: [] }).source).toBe(
      "fallback",
    );
  });
});

describe("toCanonicalUsage", () => {
  it("projects onto the canonical usage shape, preserving the estimated flag", () => {
    const resolved = resolveUsage({
      request: request(),
      upstream: { inputTokens: 10, outputTokens: 20 },
      outputSegments: [],
    });
    expect(toCanonicalUsage(resolved)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      estimated: false,
    });
  });

  it("carries estimated=true through for an estimated resolution", () => {
    const resolved = resolveUsage({ request: request(), upstream: null, outputSegments: ["a"] });
    expect(toCanonicalUsage(resolved).estimated).toBe(true);
  });
});
