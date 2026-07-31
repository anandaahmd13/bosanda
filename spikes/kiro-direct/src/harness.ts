/**
 * G0-G4 evidence harness (PLAN.md §3, §20 M0).
 *
 * THIS HARNESS HAS NOT BEEN RUN AGAINST A REAL ACCOUNT. It exists so the project
 * OWNER can point it at real credentials and produce the evidence
 * `docs/direct-adapter-gate.md` requires. Nothing it prints constitutes a passed
 * gate on its own — a human reads the output and fills in that document.
 *
 * Two modes:
 *
 *  - `--offline` (default when no credential file is given): runs the checks that
 *    need no network. It exercises the decoder against synthetic frames and the
 *    transform invariants. This proves the harness itself works; it proves
 *    NOTHING about upstream compatibility.
 *  - live: requires a credential JSON file and an explicit
 *    `KIRO_DIRECT_ENABLED=true`. Performs one real streaming request.
 *
 * Capture policy (§16 "Privacy", §17): captures are written to
 * `spikes/kiro-direct/captures/`, which is gitignored, and event PAYLOADS are
 * summarized by type and byte length rather than saved verbatim unless
 * `--keep-payloads` is passed. Prompt text is never written. The owner is
 * responsible for sanitizing anything they choose to paste into the gate doc.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalRequest } from "@bosanda/protocol";
import { BosandaError } from "@bosanda/protocol";
import type { ProviderCredentials } from "@bosanda/provider-core";
import { requestId, systemClock } from "@bosanda/shared";
import {
  CredentialManager,
  DEFAULT_KIRO_MODELS,
  EventStreamDecoder,
  KiroDirectAdapter,
  type CredentialStore,
  type RefreshResult,
  type UpstreamResponse,
  describeCredentials,
  isHostCapabilityToolName,
  assertNoInjectedTools,
  transformRequest,
} from "@bosanda/provider-kiro";
import { buildEventFrame, bytewise } from "./frames.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_DIR = resolve(HERE, "..", "captures");

export type GateId = "G0" | "G1" | "G2" | "G3" | "G4";

export type CheckResult = {
  gate: GateId;
  name: string;
  /** "not_executed" is the honest default for anything needing live upstream. */
  status: "pass" | "fail" | "not_executed";
  detail: string;
};

const results: CheckResult[] = [];

function record(result: CheckResult): void {
  results.push(result);
  const mark =
    result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "NOT EXECUTED";
  console.log(`[${result.gate}] ${mark}  ${result.name}\n        ${result.detail}`);
}

/** A credential file the owner supplies. NEVER commit one of these. */
type CredentialFile = {
  accountId: string;
  authMethod: "social" | "idc" | "api_key";
  refreshToken?: string | null;
  accessToken?: string | null;
  accessTokenExpiresAt?: string | null;
  region: string;
  profileArn?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  persona: "cli" | "ide";
  /** Token endpoint. Recorded as G0 evidence: which credential form works. */
  refreshUrl?: string;
};

async function loadCredentialFile(path: string): Promise<CredentialFile> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as CredentialFile;
}

function toProviderCredentials(file: CredentialFile): ProviderCredentials {
  return {
    authMethod: file.authMethod,
    refreshToken: file.refreshToken ?? null,
    accessToken: file.accessToken ?? null,
    accessTokenExpiresAt:
      file.accessTokenExpiresAt != null ? new Date(file.accessTokenExpiresAt) : null,
    region: file.region,
    profileArn: file.profileArn ?? null,
    clientId: file.clientId ?? null,
    clientSecret: file.clientSecret ?? null,
    persona: file.persona,
    credentialVersion: 1,
  };
}

/**
 * In-memory credential store for the harness.
 *
 * Production uses PostgreSQL with a row lock and a compare-and-swap (§6, §14).
 * This one emulates the version check so the harness can demonstrate the
 * single-flight and conflict paths (G0.3, G0.4) without a database — but note in
 * the gate doc that the ATOMICITY evidence must come from the real store.
 */
class MemoryStore implements CredentialStore {
  private credentials: ProviderCredentials;
  refreshCount = 0;

  constructor(
    private readonly accountId: string,
    initial: ProviderCredentials,
  ) {
    this.credentials = initial;
  }

  async load(accountId: string): Promise<ProviderCredentials | null> {
    return accountId === this.accountId ? { ...this.credentials } : null;
  }

  async persistRefresh(
    accountId: string,
    expectedVersion: number,
    next: RefreshResult,
  ): Promise<ProviderCredentials | null> {
    if (accountId !== this.accountId) return null;
    if (expectedVersion !== this.credentials.credentialVersion) return null;
    this.refreshCount += 1;
    this.credentials = {
      ...this.credentials,
      accessToken: next.accessToken,
      accessTokenExpiresAt: next.accessTokenExpiresAt,
      refreshToken: next.refreshToken ?? this.credentials.refreshToken,
      credentialVersion: this.credentials.credentialVersion + 1,
    };
    return { ...this.credentials };
  }
}

// --- Offline checks ---------------------------------------------------------

/**
 * Decoder behaviour against synthetic frames. This is the ONLY part of G2 that
 * can be demonstrated without upstream: it covers chunk-boundary handling and CRC
 * validation, but not "response arrives progressively" or backpressure against a
 * real socket.
 */
function checkDecoderOffline(): void {
  const frames = Buffer.concat([
    buildEventFrame("assistantResponseEvent", { content: "hello " }),
    buildEventFrame("assistantResponseEvent", { content: "world" }),
    buildEventFrame("messageStopEvent", { stopReason: "end_turn" }),
  ]);

  const decoder = new EventStreamDecoder();
  let count = 0;
  for (const piece of bytewise(frames)) {
    count += decoder.push(piece).length;
  }
  decoder.end();

  record({
    gate: "G2",
    name: "decoder reassembles byte-at-a-time delivery (synthetic frames)",
    status: count === 3 ? "pass" : "fail",
    detail: `decoded ${count} of 3 synthetic frames delivered one byte per chunk`,
  });
}

/** Transform invariants (§6). Fully checkable offline. */
function checkTransformOffline(): void {
  const request: CanonicalRequest = {
    requestId: requestId(),
    surface: "anthropic",
    model: "bosanda-sonnet-4-5",
    system: "You are concise.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    toolChoice: null,
    stream: true,
    maxTokens: 256,
    temperature: null,
    topP: null,
    stopSequences: [],
    includeUsage: true,
  };

  const options = {
    upstreamModelId: "CLAUDE_SONNET_4_5_20250929_V1_0",
    persona: "cli" as const,
    profileArn: null,
    toolsEnabled: true,
  };

  const first = transformRequest(request, options);
  const second = transformRequest(request, options);

  record({
    gate: "G1",
    name: "fresh conversation id per request (§6, §16)",
    status: first.conversationId !== second.conversationId ? "pass" : "fail",
    detail: "two transforms of an identical request produced different conversation ids",
  });

  const serialized = JSON.stringify(first.request);
  const injected = ["fs_read", "execute_bash", "mcp_", "bosanda_"].filter((name) =>
    serialized.includes(name),
  );
  record({
    gate: "G3",
    name: "no filesystem/shell/MCP tool is injected (§6, §3 G3)",
    status: injected.length === 0 ? "pass" : "fail",
    detail:
      injected.length === 0
        ? "serialized upstream request contains no host-capability tool name"
        : `found: ${injected.join(", ")}`,
  });

  // §3 G3 requires the REAL Claude Code tool loop to work, and Claude Code's
  // primary tool is named exactly `Bash`. An earlier revision rejected
  // client-declared host-capability names, which would have failed this gate —
  // and §3 makes a G3 failure a no-go for the project. So the check is that these
  // names SURVIVE: they execute on the client's machine, never on ours.
  const claudeCodeTools = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
  const withTools = transformRequest(
    {
      ...request,
      tools: claudeCodeTools.map((name) => ({
        name,
        description: null,
        inputSchema: { type: "object" as const },
      })),
    },
    options,
  );
  const forwarded = (
    withTools.request.conversationState.currentMessage.userInputMessage.userInputMessageContext
      .tools ?? []
  ).map((tool) => tool.toolSpecification.name);
  const missing = claudeCodeTools.filter((name) => !forwarded.includes(name));

  record({
    gate: "G3",
    name: "client-declared Claude Code tools reach upstream unchanged",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? `forwarded ${forwarded.length} client tools verbatim, including Bash`
        : `dropped or rejected: ${missing.join(", ")}`,
  });

  // The invariant that DOES bind Bosanda: a tool we added but the client never
  // declared must fail the request rather than reach upstream.
  let caughtInjection = false;
  try {
    assertNoInjectedTools(
      [
        {
          toolSpecification: { name: "fs_read", description: "", inputSchema: { json: {} } },
        },
      ],
      [{ name: "get_weather" }],
    );
  } catch {
    caughtInjection = true;
  }

  record({
    gate: "G3",
    name: "a tool the client never declared is refused (§6 no injection)",
    status: caughtInjection && isHostCapabilityToolName("fs_read") ? "pass" : "fail",
    detail: "assertNoInjectedTools compares the outbound tool set against the declared set",
  });
}

/** Single-flight refresh (§3 G0.4), demonstrable offline with a fake refresher. */
async function checkRefreshSingleFlight(): Promise<void> {
  const accountId = "acct_harness";
  const store = new MemoryStore(accountId, {
    authMethod: "social",
    refreshToken: "synthetic-refresh-token",
    accessToken: "synthetic-expired-token",
    accessTokenExpiresAt: new Date(Date.now() - 60_000),
    region: "us-east-1",
    profileArn: null,
    clientId: null,
    clientSecret: null,
    persona: "cli",
    credentialVersion: 1,
  });

  let upstreamCalls = 0;
  const manager = new CredentialManager({
    store,
    refresher: async () => {
      upstreamCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return {
        accessToken: "synthetic-fresh-token",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      };
    },
    clock: systemClock,
  });

  const controller = new AbortController();
  await Promise.all(Array.from({ length: 8 }, () => manager.access(accountId, controller.signal)));

  record({
    gate: "G0",
    name: "concurrent refreshes collapse to one upstream call (§3 G0.4)",
    status: upstreamCalls === 1 ? "pass" : "fail",
    detail: `8 concurrent access() calls produced ${upstreamCalls} upstream refresh(es)`,
  });

  const stored = await store.load(accountId);
  const described = stored === null ? "" : JSON.stringify(describeCredentials(stored));
  record({
    gate: "G0",
    name: "credential description carries no token material (§17)",
    status: stored !== null && !described.includes("synthetic") ? "pass" : "fail",
    detail: "describeCredentials emits presence flags and an expiry only",
  });
}

/** Everything that genuinely requires live upstream. Always NOT EXECUTED offline. */
function recordLiveGapsAsNotExecuted(): void {
  const gaps: [GateId, string][] = [
    ["G0", "real credential import, refresh, and rotation against the upstream token endpoint"],
    ["G0", "which credential form the direct adapter actually accepts (ksk_ vs OIDC)"],
    ["G0", "profileArn discovery and caching"],
    ["G0", "revoked/expired credential detection against upstream"],
    ["G1", "upstream URL, region behaviour, and required headers"],
    ["G1", "conversationState shape accepted by upstream"],
    ["G1", "upstream model identifiers and cost multipliers"],
    ["G2", "response arrives progressively over a real socket"],
    ["G2", "abort propagation cancels the upstream fetch"],
    ["G2", "idle and hard timeouts against a real stall"],
    ["G2", "backpressure reaches the upstream response reader"],
    ["G2", "real event families and their payload schemas"],
    ["G3", "full Claude Code tool loop on a real repository"],
    ["G3", "stable tool ids and incremental JSON from real toolUseEvent frames"],
    ["G4", "whether metricsEvent supplies input/output/cached/reasoning usage"],
    ["G4", "provider credit consumption measured against observed Kiro balance"],
  ];
  for (const [gate, name] of gaps) {
    record({
      gate,
      name,
      status: "not_executed",
      detail: "requires real Kiro credentials and live upstream traffic; not available offline",
    });
  }
}

// --- Live check -------------------------------------------------------------

/**
 * Performs ONE real streaming request.
 *
 * Uses `undici`'s global fetch. TLS validation is left at its default (mandatory,
 * §16) and there is no proxy fallback path.
 */
async function checkLive(file: CredentialFile, keepPayloads: boolean): Promise<void> {
  const accountId = file.accountId;
  const store = new MemoryStore(accountId, toProviderCredentials(file));

  const manager = new CredentialManager({
    store,
    refresher: async (credentials, signal) => {
      if (file.refreshUrl === undefined) {
        throw new BosandaError("authentication_error", {
          internalDetail: "credential file has no refreshUrl; cannot refresh",
        });
      }
      const response = await fetch(file.refreshUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          refreshToken: credentials.refreshToken,
          ...(credentials.clientId !== null ? { clientId: credentials.clientId } : {}),
          ...(credentials.clientSecret !== null ? { clientSecret: credentials.clientSecret } : {}),
        }),
        signal,
      });
      if (!response.ok) {
        throw new BosandaError("authentication_error", {
          internalDetail: `token endpoint returned HTTP ${response.status}`,
        });
      }
      const body = (await response.json()) as {
        accessToken?: string;
        expiresIn?: number;
        refreshToken?: string;
      };
      if (typeof body.accessToken !== "string") {
        throw new BosandaError("upstream_incompatible", {
          internalDetail: "token endpoint response has no string accessToken",
        });
      }
      return {
        accessToken: body.accessToken,
        accessTokenExpiresAt: new Date(Date.now() + (body.expiresIn ?? 3600) * 1000),
        refreshToken: body.refreshToken ?? null,
      };
    },
  });

  const adapter = new KiroDirectAdapter({
    credentials: manager,
    isEnabled: () => true,
    transport: async ({ url, headers, body, signal }) => {
      const response = await fetch(url, { method: "POST", headers, body, signal });
      const wrapped: UpstreamResponse = {
        status: response.status,
        header: (name) => response.headers.get(name),
        body: response.body === null ? null : (response.body as AsyncIterable<Uint8Array>),
      };
      return wrapped;
    },
    onTelemetry: (telemetry) => {
      console.log(`        telemetry: ${JSON.stringify(telemetry)}`);
    },
  });

  const model = DEFAULT_KIRO_MODELS[0];
  if (model === undefined) throw new Error("model catalog is empty");

  const request: CanonicalRequest = {
    requestId: requestId(),
    surface: "anthropic",
    model: model.publicId,
    system: null,
    messages: [
      { role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] },
    ],
    tools: [],
    toolChoice: null,
    stream: true,
    maxTokens: 64,
    temperature: null,
    topP: null,
    stopSequences: [],
    includeUsage: true,
  };

  const controller = new AbortController();
  const observed: string[] = [];
  const startedAt = Date.now();
  let firstEventMs: number | null = null;

  try {
    for await (const event of adapter.stream(request, accountId, controller.signal)) {
      firstEventMs ??= Date.now() - startedAt;
      // Event TYPES only. Text deltas are counted, never captured, unless the
      // owner explicitly opts in.
      observed.push(event.type);
    }

    record({
      gate: "G2",
      name: "live streaming request completed",
      status: "pass",
      detail: `first event after ${firstEventMs ?? -1}ms; ${observed.length} canonical events; types: ${[...new Set(observed)].join(", ")}`,
    });
  } catch (error) {
    const classified = BosandaError.from(error);
    record({
      gate: "G2",
      name: "live streaming request completed",
      status: "fail",
      detail: `${classified.code}: ${classified.internalDetail ?? "no detail"}`,
    });
  }

  await mkdir(CAPTURE_DIR, { recursive: true });
  await writeFile(
    resolve(CAPTURE_DIR, `run-${Date.now()}.json`),
    JSON.stringify(
      {
        note: "Event TYPES and timings only. Review before pasting into the gate doc.",
        keepPayloads,
        adapterVersion: adapter.adapterVersion,
        eventTypes: observed,
        firstEventMs,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nCapture written to ${CAPTURE_DIR}`);
}

// --- Entrypoint -------------------------------------------------------------

export async function runHarness(argv: readonly string[]): Promise<number> {
  const credentialArg = argv.find((a) => a.startsWith("--credentials="));
  const offline = argv.includes("--offline") || credentialArg === undefined;
  const keepPayloads = argv.includes("--keep-payloads");

  console.log("Bosanda Kiro Direct — G0-G4 evidence harness (PLAN.md §3, §20 M0)");
  console.log(
    offline
      ? "MODE: offline. Synthetic frames only. This proves NOTHING about upstream compatibility.\n"
      : "MODE: live. One real streaming request will be performed.\n",
  );

  checkDecoderOffline();
  checkTransformOffline();
  await checkRefreshSingleFlight();

  if (offline) {
    recordLiveGapsAsNotExecuted();
  } else {
    if (process.env["KIRO_DIRECT_ENABLED"] !== "true") {
      console.error(
        "Refusing to run live: set KIRO_DIRECT_ENABLED=true to acknowledge real upstream traffic.",
      );
      return 2;
    }
    const path = credentialArg.slice("--credentials=".length);
    await checkLive(await loadCredentialFile(path), keepPayloads);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  const notExecuted = results.filter((r) => r.status === "not_executed").length;
  const passed = results.filter((r) => r.status === "pass").length;

  console.log(
    `\nSummary: ${passed} pass, ${failed} fail, ${notExecuted} not executed.\n` +
      "The gate is NOT passed while any check is 'not executed'. Record results in\n" +
      "docs/direct-adapter-gate.md by hand — this harness does not write that file.",
  );

  return failed > 0 ? 1 : 0;
}
