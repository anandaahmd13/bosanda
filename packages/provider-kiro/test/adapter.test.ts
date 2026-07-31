/**
 * KiroDirectAdapter tests (PLAN.md §2 ADR-1, §3, §5, §6, §7, §9, §10, §16).
 *
 * Everything here is hermetic: the transport, credential store, token refresher,
 * and clock are all fakes, so no test performs network I/O. The upstream bodies
 * are built with the same frame builder the spike uses, so a test cannot pass
 * against a decoder-specific CRC bug.
 *
 * The properties given adversarial coverage are the ones where a regression is
 * silent rather than loud:
 *
 *  - ORDERING. §3 requires that a disabled adapter never touches a secret, and
 *    the kill switch is checked before credentials are read. A refactor that
 *    moves the check later still passes a "returns 503" test, so the credential
 *    store here RECORDS its calls and the tests assert it was never touched.
 *  - §9: the upstream model ID must never reach a client. Asserted on the whole
 *    emitted event stream, not just on message_start.
 *  - §3's kill switches are read PER CALL, so a flip mid-session takes effect.
 *  - §10: a partial upstream usage report must be marked estimated, because
 *    billing a customer off an incomplete report is not recoverable after the
 *    fact.
 *
 * The wire shapes asserted (URL, headers, target) are what §2 records as
 * OBSERVED, not documented. These tests pin current behaviour so a change is
 * deliberate; only §3 M0 against live traffic can establish correctness, and M0
 * has not run.
 */

import { describe, expect, it } from "vitest";
import { BosandaError, type CanonicalEvent, type CanonicalRequest } from "@bosanda/protocol";
import type { ProviderCredentials, ProviderModel } from "@bosanda/provider-core";
import {
  ADAPTER_VERSION,
  KiroDirectAdapter,
  type KiroAdapterOptions,
  type UpstreamRequest,
  type UpstreamResponse,
  upstreamHeaders,
  upstreamUrl,
} from "../src/adapter.js";
import { CredentialManager, type CredentialStore } from "../src/credentials.js";
import { DEFAULT_KIRO_MODELS } from "../src/models.js";
import {
  asStream,
  buildEventFrame,
  buildExceptionFrame,
  bytewise,
  corruptMessageCrc,
} from "../../../spikes/kiro-direct/src/frames.js";

// --- fakes ------------------------------------------------------------------

const CREDENTIALS: ProviderCredentials = {
  authMethod: "social",
  refreshToken: "refresh-token-value",
  accessToken: "access-token-value",
  // Far future so no test accidentally triggers a refresh.
  accessTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  region: "us-east-1",
  profileArn: "arn:aws:codewhisperer:us-east-1:111122223333:profile/ABCDEF",
  clientId: null,
  clientSecret: null,
  persona: "cli",
  credentialVersion: 1,
};

/**
 * A credential store that counts loads. The count is the point: §3 requires a
 * disabled adapter to fail before decrypting anything, and only a call counter
 * can tell "returned 503 after reading the secret" from "returned 503 without
 * reading it".
 */
function recordingStore(credentials: ProviderCredentials | null = CREDENTIALS): CredentialStore & {
  loads: string[];
} {
  const loads: string[] = [];
  return {
    loads,
    async load(accountId) {
      loads.push(accountId);
      return credentials;
    },
    async persistRefresh() {
      throw new Error("no test should trigger a refresh");
    },
  };
}

function manager(store: CredentialStore): CredentialManager {
  return new CredentialManager({
    store,
    refresher: () => {
      throw new Error("no test should trigger a refresh");
    },
  });
}

/** Builds a response from frames, delivered as one chunk unless split. */
function okResponse(
  frames: readonly Uint8Array[],
  options: { split?: boolean; headers?: Record<string, string> } = {},
): UpstreamResponse {
  const joined = Buffer.concat(frames.map((frame) => Buffer.from(frame)));
  const chunks = options.split === true ? bytewise(joined) : [joined];
  return {
    status: 200,
    header: (name) => options.headers?.[name.toLowerCase()] ?? null,
    body: asStream(chunks),
  };
}

function errorResponse(status: number, headers: Record<string, string> = {}): UpstreamResponse {
  return {
    status,
    header: (name) => headers[name.toLowerCase()] ?? null,
    body: null,
  };
}

type Harness = {
  adapter: KiroDirectAdapter;
  sent: UpstreamRequest[];
  loads: string[];
  telemetry: Parameters<NonNullable<KiroAdapterOptions["onTelemetry"]>>[0][];
};

function harness(
  respond: (request: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse>,
  overrides: Partial<KiroAdapterOptions> = {},
  credentials: ProviderCredentials | null = CREDENTIALS,
): Harness {
  const store = recordingStore(credentials);
  const sent: UpstreamRequest[] = [];
  const telemetry: Harness["telemetry"] = [];
  const adapter = new KiroDirectAdapter({
    credentials: manager(store),
    transport: async (request) => {
      sent.push(request);
      return respond(request);
    },
    isEnabled: () => true,
    onTelemetry: (event) => telemetry.push(event),
    ...overrides,
  });
  return { adapter, sent, loads: store.loads, telemetry };
}

const MODEL = DEFAULT_KIRO_MODELS[0]!;

/**
 * A complete CanonicalRequest. Deliberately NOT written with an `as
 * CanonicalRequest` cast: the cast would let this helper drift from the real
 * type, and every test in the file would keep passing while exercising a request
 * shape the gateway never produces.
 */
function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: "req_test_1",
    surface: "anthropic",
    model: MODEL.publicId,
    system: null,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    toolChoice: null,
    stream: true,
    maxTokens: 1024,
    temperature: null,
    topP: null,
    stopSequences: [],
    includeUsage: true,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const textFrame = (text: string) => buildEventFrame("assistantResponseEvent", { content: text });
const stopFrame = (stopReason = "end_turn") => buildEventFrame("messageStopEvent", { stopReason });

// --- tests ------------------------------------------------------------------

describe("ADAPTER_VERSION", () => {
  it("carries a -draft marker until M0 is executed (§3)", () => {
    // Every usage row is stamped with this, so an operator can tell which rows
    // ran against an unverified protocol. Dropping the marker before the gate
    // passes would erase that.
    expect(ADAPTER_VERSION).toContain("-draft");
    expect(ADAPTER_VERSION).toMatch(/^kiro-direct-\d+\.\d+\.\d+-draft\//);
  });
});

describe("kill switches (§3)", () => {
  it("rejects stream with adapter_disabled and never reads a credential", () => {
    const { adapter, loads, sent } = harness(() => okResponse([stopFrame()]), {
      isEnabled: () => false,
    });
    try {
      adapter.stream(request(), "acct_1", new AbortController().signal);
      expect.unreachable("expected adapter_disabled");
    } catch (error) {
      expect((error as BosandaError).code).toBe("adapter_disabled");
      expect((error as BosandaError).status).toBe(503);
    }
    expect(loads).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("throws from stream() itself rather than only on the first next()", async () => {
    // A caller that acquires a concurrency lease before iterating would
    // otherwise hold a slot for an adapter that is switched off.
    const { adapter } = harness(() => okResponse([stopFrame()]), { isEnabled: () => false });
    expect(() => adapter.stream(request(), "acct_1", new AbortController().signal)).toThrow(
      BosandaError,
    );
  });

  it("tells the client nothing about which switch fired", () => {
    const { adapter } = harness(() => okResponse([stopFrame()]), { isEnabled: () => false });
    try {
      adapter.stream(request(), "acct_1", new AbortController().signal);
      expect.unreachable("expected adapter_disabled");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.publicMessage).toBe("This model is temporarily unavailable.");
      expect(bosanda.publicMessage).not.toContain("KIRO_DIRECT_ENABLED");
      // The switch name belongs in operator detail only.
      expect(bosanda.internalDetail).toContain("KIRO_DIRECT_ENABLED");
    }
  });

  it("hides every model from listModels while disabled", async () => {
    const { adapter } = harness(() => okResponse([stopFrame()]), { isEnabled: () => false });
    expect(await adapter.listModels()).toEqual([]);
  });

  it("lists the catalog when enabled", async () => {
    const { adapter } = harness(() => okResponse([stopFrame()]));
    expect(await adapter.listModels()).toEqual([...DEFAULT_KIRO_MODELS]);
  });

  it("returns a copy of the catalog, so a caller cannot mutate it", async () => {
    const { adapter } = harness(() => okResponse([stopFrame()]));
    const models = await adapter.listModels();
    models.pop();
    expect(await adapter.listModels()).toHaveLength(DEFAULT_KIRO_MODELS.length);
  });

  it("rejects validateAccount while disabled, without reading a credential", async () => {
    const { adapter, loads } = harness(() => okResponse([stopFrame()]), { isEnabled: () => false });
    await expect(adapter.validateAccount("acct_1")).rejects.toThrow(/adapter_disabled/);
    expect(loads).toEqual([]);
  });

  it("re-reads the switch on every call so a flip takes effect immediately", async () => {
    let enabled = true;
    const { adapter } = harness(() => okResponse([stopFrame()]), { isEnabled: () => enabled });
    expect(await adapter.listModels()).toHaveLength(DEFAULT_KIRO_MODELS.length);
    enabled = false;
    expect(await adapter.listModels()).toEqual([]);
    enabled = true;
    expect(await adapter.listModels()).toHaveLength(DEFAULT_KIRO_MODELS.length);
  });

  it("strips tools when tool use is disabled but still runs the turn (§3)", async () => {
    // The emergency switch degrades the turn, it does not fail it.
    const { adapter, sent } = harness(() => okResponse([textFrame("hi"), stopFrame()]), {
      isToolUseEnabled: () => false,
    });
    await collect(
      adapter.stream(
        request({ tools: [{ name: "Bash", description: "run", inputSchema: { type: "object" } }] }),
        "acct_1",
        new AbortController().signal,
      ),
    );
    expect(sent[0]!.body).not.toContain("Bash");
  });

  it("forwards tools when tool use is enabled", async () => {
    const { adapter, sent } = harness(() => okResponse([stopFrame()]));
    await collect(
      adapter.stream(
        request({ tools: [{ name: "Bash", description: "run", inputSchema: { type: "object" } }] }),
        "acct_1",
        new AbortController().signal,
      ),
    );
    expect(sent[0]!.body).toContain("Bash");
  });
});

describe("model resolution", () => {
  it("rejects an unknown model before reading a credential", () => {
    const { adapter, loads } = harness(() => okResponse([stopFrame()]));
    expect(() =>
      adapter.stream(request({ model: "not-a-model" }), "acct_1", new AbortController().signal),
    ).toThrow(BosandaError);
    expect(loads).toEqual([]);
  });

  it("rejects tool use on a model that does not support it", () => {
    const noTools: ProviderModel = { ...MODEL, supportsTools: false };
    const { adapter } = harness(() => okResponse([stopFrame()]), { catalog: [noTools] });
    try {
      adapter.stream(
        request({ tools: [{ name: "X", description: "d", inputSchema: { type: "object" } }] }),
        "acct_1",
        new AbortController().signal,
      );
      expect.unreachable("expected unsupported_capability");
    } catch (error) {
      expect((error as BosandaError).code).toBe("unsupported_capability");
    }
  });

  it("allows a toolless request on a model that does not support tools", async () => {
    const noTools: ProviderModel = { ...MODEL, supportsTools: false };
    const { adapter } = harness(() => okResponse([textFrame("ok"), stopFrame()]), {
      catalog: [noTools],
    });
    const events = await collect(
      adapter.stream(request({ model: noTools.publicId }), "acct_1", new AbortController().signal),
    );
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
  });
});

describe("upstream request construction (§2, §16)", () => {
  it("sends the upstream model ID and never the public one", async () => {
    const { adapter, sent } = harness(() => okResponse([stopFrame()]));
    await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(sent[0]!.body).toContain(MODEL.upstreamId);
    expect(sent[0]!.body).not.toContain(MODEL.publicId);
  });

  it("routes to the credential's own region, so an account cannot cross regions", async () => {
    const { adapter, sent } = harness(
      () => okResponse([stopFrame()]),
      {},
      { ...CREDENTIALS, region: "eu-west-1" },
    );
    await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(sent[0]!.url).toContain("eu-west-1");
    expect(sent[0]!.url).not.toContain("us-east-1");
  });

  it("uses POST and passes the caller's abort signal through", async () => {
    const controller = new AbortController();
    const { adapter, sent } = harness(() => okResponse([stopFrame()]));
    await collect(adapter.stream(request(), "acct_1", controller.signal));
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.signal).toBe(controller.signal);
  });

  it("sends a bearer token and the eventstream accept header", async () => {
    const { adapter, sent } = harness(() => okResponse([stopFrame()]));
    await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    const headers = sent[0]!.headers;
    expect(headers["authorization"]).toBe("Bearer access-token-value");
    expect(headers["accept"]).toBe("application/vnd.amazon.eventstream");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("keeps the access token out of the URL and body (§16)", async () => {
    // A token in a URL lands in access logs and proxy logs.
    const { adapter, sent } = harness(() => okResponse([stopFrame()]));
    await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(sent[0]!.url).not.toContain("access-token-value");
    expect(sent[0]!.body).not.toContain("access-token-value");
    expect(sent[0]!.body).not.toContain("refresh-token-value");
  });
});

describe("upstreamUrl / upstreamHeaders", () => {
  it("selects the endpoint by persona", () => {
    expect(upstreamUrl("cli", "us-east-1")).toBe(
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    );
    expect(upstreamUrl("ide", "us-east-1")).toBe(
      "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    );
  });

  it("always uses https", () => {
    for (const persona of ["cli", "ide"] as const) {
      expect(upstreamUrl(persona, "ap-southeast-2").startsWith("https://")).toBe(true);
    }
  });

  it("adds x-amz-target only for the ide persona", () => {
    expect(upstreamHeaders("ide", "t")["x-amz-target"]).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    );
    expect(upstreamHeaders("cli", "t")["x-amz-target"]).toBeUndefined();
  });

  it("refuses to build headers with no access token", () => {
    // Sending `Bearer null` upstream would look like a malformed credential to
    // the provider rather than a local bug.
    try {
      upstreamHeaders("cli", null);
      expect.unreachable("expected authentication_error");
    } catch (error) {
      expect((error as BosandaError).code).toBe("authentication_error");
      expect((error as BosandaError).internalDetail).not.toContain("Bearer");
    }
  });

  it("puts the token only in the authorization header", () => {
    const headers = upstreamHeaders("cli", "secret-token");
    const elsewhere = Object.entries(headers).filter(
      ([name, value]) => name !== "authorization" && value.includes("secret-token"),
    );
    expect(elsewhere).toEqual([]);
  });
});

describe("streaming a turn (§5, §9)", () => {
  it("emits message_start with the PUBLIC model id (§9)", async () => {
    const { adapter } = harness(() => okResponse([textFrame("hi"), stopFrame()]));
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events[0]).toEqual({
      type: "message_start",
      id: "req_test_1",
      model: MODEL.publicId,
    });
  });

  it("never leaks the upstream model id into ANY emitted event (§9)", async () => {
    // Asserted across the whole stream, not just message_start: a usage or
    // finish event carrying the upstream ID would leak the provider identity.
    const { adapter } = harness(() =>
      okResponse([
        textFrame("a"),
        buildEventFrame("metricsEvent", { inputTokens: 1, outputTokens: 2 }),
        stopFrame(),
      ]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(JSON.stringify(events)).not.toContain(MODEL.upstreamId);
  });

  it("translates a full turn in order", async () => {
    const { adapter } = harness(() =>
      okResponse([
        textFrame("Hello"),
        textFrame(" world"),
        buildEventFrame("metricsEvent", { inputTokens: 10, outputTokens: 5 }),
        stopFrame(),
      ]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events).toEqual([
      { type: "message_start", id: "req_test_1", model: MODEL.publicId },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "finish", reason: "end_turn" },
      { type: "usage", inputTokens: 10, outputTokens: 5, estimated: false },
    ]);
  });

  it("produces identical events when the body arrives one byte at a time", async () => {
    // The gateway has no control over upstream chunk boundaries, so a decoder
    // that only works on frame-aligned chunks is a latent production failure.
    const frames = [textFrame("chunked"), stopFrame()];
    const whole = await collect(
      harness(() => okResponse(frames)).adapter.stream(
        request(),
        "acct_1",
        new AbortController().signal,
      ),
    );
    const split = await collect(
      harness(() => okResponse(frames, { split: true })).adapter.stream(
        request(),
        "acct_1",
        new AbortController().signal,
      ),
    );
    expect(split).toEqual(whole);
  });

  it("streams a tool call through with a stable id (§3 G3)", async () => {
    const { adapter } = harness(() =>
      okResponse([
        buildEventFrame("toolUseEvent", { toolUseId: "tu_9", name: "Read", input: '{"p' }),
        buildEventFrame("toolUseEvent", { toolUseId: "tu_9", input: 'ath":"a"}' }),
        buildEventFrame("toolUseEvent", { toolUseId: "tu_9", stop: true }),
        stopFrame("tool_use"),
      ]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events.slice(1)).toEqual([
      { type: "tool_start", index: 0, id: "tu_9", name: "Read" },
      { type: "tool_input_delta", index: 0, partialJson: '{"p' },
      { type: "tool_input_delta", index: 0, partialJson: 'ath":"a"}' },
      { type: "tool_stop", index: 0 },
      { type: "finish", reason: "tool_use" },
    ]);
  });

  it("closes a tool block upstream left open", async () => {
    // Otherwise the client waits forever on a content block that never closes.
    const { adapter } = harness(() =>
      okResponse([
        buildEventFrame("toolUseEvent", { toolUseId: "tu_1", name: "A" }),
        buildEventFrame("toolUseEvent", { toolUseId: "tu_2", name: "B" }),
        stopFrame("tool_use"),
      ]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    const stops = events.filter((event) => event.type === "tool_stop");
    expect(stops).toEqual([
      { type: "tool_stop", index: 0 },
      { type: "tool_stop", index: 1 },
    ]);
  });

  it("synthesizes a finish when the body ends with no stop event", async () => {
    // The turn completed; failing it would discard output already billed for.
    const { adapter } = harness(() => okResponse([textFrame("truncated-but-valid")]));
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "end_turn" });
  });

  it("reports tool_use in a synthesized finish when a tool call was seen", async () => {
    const { adapter } = harness(() =>
      okResponse([buildEventFrame("toolUseEvent", { toolUseId: "t", name: "A", stop: true })]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_use" });
  });

  it("emits exactly one finish when upstream sent a stop", async () => {
    const { adapter } = harness(() => okResponse([textFrame("x"), stopFrame()]));
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events.filter((event) => event.type === "finish")).toHaveLength(1);
  });

  it("passes an unknown event type through without breaking the turn (§6)", async () => {
    const { adapter, telemetry } = harness(() =>
      okResponse([
        buildEventFrame("someFutureEvent", { whatever: true }),
        textFrame("still works"),
        stopFrame(),
      ]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events).toContainEqual({ type: "text_delta", text: "still works" });
    expect(telemetry[0]!.unknownEvents).toEqual({ someFutureEvent: 1 });
  });
});

describe("usage reporting (§10)", () => {
  it("marks a complete report as not estimated", async () => {
    const { adapter } = harness(() =>
      okResponse([
        buildEventFrame("metricsEvent", { inputTokens: 7, outputTokens: 3, cachedTokens: 2 }),
        stopFrame(),
      ]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 7,
      outputTokens: 3,
      cachedTokens: 2,
      estimated: false,
    });
  });

  it("marks a PARTIAL report as estimated (§10)", async () => {
    // Billing off an incomplete report is not recoverable after the fact, so a
    // missing half must be flagged for resolveUsage rather than zero-filled
    // silently.
    const { adapter } = harness(() =>
      okResponse([buildEventFrame("metricsEvent", { inputTokens: 7 }), stopFrame()]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 7,
      outputTokens: 0,
      estimated: true,
    });
  });

  it("emits no usage event when upstream reported nothing", async () => {
    // Absent, not zeros: zeros would bill the customer nothing.
    const { adapter } = harness(() => okResponse([textFrame("x"), stopFrame()]));
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });

  it("omits cachedTokens rather than reporting a zero it did not observe", async () => {
    const { adapter } = harness(() =>
      okResponse([
        buildEventFrame("metricsEvent", { inputTokens: 1, outputTokens: 1 }),
        stopFrame(),
      ]),
    );
    const events = await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toBeDefined();
    expect(Object.keys(usage as object)).not.toContain("cachedTokens");
  });
});

describe("error paths (§7, §8, §12)", () => {
  it("classifies a non-200 by status and reads no response body", async () => {
    const { adapter } = harness(() => errorResponse(429, { "retry-after": "42" }));
    try {
      await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
      expect.unreachable("expected rate_limit");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.code).toBe("rate_limit");
      expect(bosanda.retryAfterSeconds).toBe(42);
      expect(bosanda.shouldCooldownProvider).toBe(true);
      expect(bosanda.isProviderRetryable).toBe(false);
    }
  });

  it("ignores a non-numeric Retry-After", async () => {
    const { adapter } = harness(() =>
      errorResponse(429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).rejects.toMatchObject({ retryAfterSeconds: undefined });
  });

  it("treats a 200 with no body as a failure, not an empty turn", async () => {
    // An empty turn would be billed as a successful request that produced
    // nothing.
    const { adapter } = harness(() => ({ status: 200, header: () => null, body: null }));
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).rejects.toThrow(BosandaError);
  });

  it("maps a corrupt frame to upstream_incompatible and attributes the account", async () => {
    // §3 counts these toward the compatibility circuit breaker, and §7 needs the
    // account attribution to cool the right one down.
    const { adapter } = harness(() =>
      okResponse([Buffer.from(corruptMessageCrc(Buffer.from(textFrame("x")))), stopFrame()]),
    );
    try {
      await collect(adapter.stream(request(), "acct_9", new AbortController().signal));
      expect.unreachable("expected upstream_incompatible");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.code).toBe("upstream_incompatible");
      expect(bosanda.providerAccountId).toBe("acct_9");
      expect(bosanda.shouldCooldownProvider).toBe(true);
    }
  });

  it("classifies an upstream exception frame mid-stream", async () => {
    const { adapter } = harness(() =>
      okResponse([textFrame("partial"), buildExceptionFrame("ThrottlingException", {})]),
    );
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).rejects.toMatchObject({ code: "rate_limit" });
  });

  it("keeps upstream prose out of an error raised mid-stream (§12)", async () => {
    const leak = "LEAKED-UPSTREAM-PROSE-4c1d";
    const { adapter } = harness(() =>
      okResponse([buildExceptionFrame("ValidationException", { message: leak, detail: leak })]),
    );
    try {
      await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
      expect.unreachable("expected upstream_incompatible");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.message).not.toContain(leak);
      expect(bosanda.internalDetail ?? "").not.toContain(leak);
      expect(bosanda.publicMessage).not.toContain(leak);
    }
  });

  it("surfaces a transport rejection as upstream_incompatible", async () => {
    const { adapter } = harness(() => {
      throw new Error("socket hang up");
    });
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).rejects.toMatchObject({ code: "upstream_incompatible" });
  });

  it("maps a client abort to invalid_request, not a provider fault", async () => {
    // Cooling the account down here would let one flaky client disable the pool.
    const { adapter } = harness(() => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    try {
      await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
      expect.unreachable("expected invalid_request");
    } catch (error) {
      expect((error as BosandaError).code).toBe("invalid_request");
      expect((error as BosandaError).shouldCooldownProvider).toBe(false);
    }
  });

  it("times out an upstream that accepts then stalls (§7/§16)", async () => {
    // A stalled stream holding a concurrency slot forever is how one bad
    // upstream connection consumes the pool.
    async function* stalls(): AsyncGenerator<Uint8Array> {
      yield Buffer.from(textFrame("first"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield Buffer.from(stopFrame());
    }
    const { adapter } = harness(() => ({ status: 200, header: () => null, body: stalls() }), {
      idleTimeoutMs: 20,
    });
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).rejects.toMatchObject({ code: "upstream_timeout" });
  });

  it("propagates a missing credential as an error, not a tokenless request", async () => {
    const { adapter, sent } = harness(() => okResponse([stopFrame()]), {}, null);
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).rejects.toThrow(BosandaError);
    expect(sent).toEqual([]);
  });
});

describe("telemetry (§17)", () => {
  it("reports counts and names only, never text", async () => {
    const { adapter, telemetry } = harness(() =>
      okResponse([
        textFrame("SENSITIVE-COMPLETION-TEXT"),
        buildEventFrame("mysteryEvent", { secret: "SENSITIVE-COMPLETION-TEXT" }),
        buildEventFrame("metricsEvent", { inputTokens: 1, outputTokens: 1 }),
        stopFrame(),
      ]),
    );
    await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(telemetry).toHaveLength(1);
    expect(JSON.stringify(telemetry[0])).not.toContain("SENSITIVE-COMPLETION-TEXT");
    expect(telemetry[0]).toEqual({
      accountId: "acct_1",
      model: MODEL.publicId,
      fixtureVersion: expect.stringMatching(/-draft$/),
      unknownEvents: { mysteryEvent: 1 },
      usageReported: true,
      sawStop: true,
    });
  });

  it("reports even when the turn fails, so a failure is not invisible", async () => {
    const { adapter, telemetry } = harness(() => errorResponse(500));
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).rejects.toThrow(BosandaError);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!.sawStop).toBe(false);
    expect(telemetry[0]!.usageReported).toBe(false);
  });

  it("stamps the public model id, never the upstream one", async () => {
    const { adapter, telemetry } = harness(() => okResponse([stopFrame()]));
    await collect(adapter.stream(request(), "acct_1", new AbortController().signal));
    expect(telemetry[0]!.model).toBe(MODEL.publicId);
    expect(JSON.stringify(telemetry[0])).not.toContain(MODEL.upstreamId);
  });

  it("runs without a telemetry callback configured", async () => {
    const store = recordingStore();
    const adapter = new KiroDirectAdapter({
      credentials: manager(store),
      transport: async () => okResponse([textFrame("x"), stopFrame()]),
      isEnabled: () => true,
    });
    await expect(
      collect(adapter.stream(request(), "acct_1", new AbortController().signal)),
    ).resolves.toHaveLength(3);
  });
});

describe("validateAccount (§3 G0.6, §7)", () => {
  it("reports an active account with no token material in detail", async () => {
    const { adapter } = harness(() => okResponse([stopFrame()]));
    const health = await adapter.validateAccount("acct_1");
    expect(health.status).toBe("active");
    expect(health.region).toBe("us-east-1");
    expect(health.persona).toBe("cli");
    expect(health.errorScore).toBe(0);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("access-token-value");
    expect(serialized).not.toContain("refresh-token-value");
    // §17: the ARN is account-identifying, so the detail records presence only.
    expect(serialized).not.toContain("111122223333");
    expect(health.detail).toContain("present");
  });

  it("marks a missing credential credential_invalid, not merely cooling down", async () => {
    // §7 escalates credential_invalid to disabling the account until admin
    // action; a timed cooldown would keep re-trying a dead credential forever.
    const { adapter } = harness(() => okResponse([stopFrame()]), {}, null);
    const health = await adapter.validateAccount("acct_1");
    expect(health.status).toBe("credential_invalid");
    expect(health.errorScore).toBe(1);
  });

  it("does not throw for an unusable credential", async () => {
    // The scheduler needs a health record to act on, not an exception.
    const { adapter } = harness(
      () => okResponse([stopFrame()]),
      {},
      { ...CREDENTIALS, accessToken: null, refreshToken: null },
    );
    const health = await adapter.validateAccount("acct_1");
    expect(health.accountId).toBe("acct_1");
    expect(["credential_invalid", "cooling_down"]).toContain(health.status);
  });

  it("stamps lastValidatedAt from the injected clock", async () => {
    const now = new Date("2026-03-04T05:06:07.000Z");
    const { adapter } = harness(() => okResponse([stopFrame()]), {
      clock: { now: () => now },
    });
    const health = await adapter.validateAccount("acct_1");
    expect(health.lastValidatedAt).toEqual(now);
  });

  it("performs no upstream request", async () => {
    // G0.6 is a credential check, not a billable turn.
    const { adapter, sent } = harness(() => okResponse([stopFrame()]));
    await adapter.validateAccount("acct_1");
    expect(sent).toEqual([]);
  });
});

describe("adapter identity", () => {
  it("declares the kiro provider type and its own version", () => {
    const { adapter } = harness(() => okResponse([stopFrame()]));
    expect(adapter.providerType).toBe("kiro");
    expect(adapter.adapterVersion).toBe(ADAPTER_VERSION);
  });
});
