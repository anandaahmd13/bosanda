/**
 * The Kiro Direct ProviderAdapter (PLAN.md §2 ADR-1, §6, §3, §7).
 *
 * Wires the pieces together: credential access -> request transformation ->
 * HTTP POST -> EventStream decode -> canonical events. Everything upstream-
 * specific stops here; the adapter emits CanonicalEvent only and never
 * serializes a client protocol (§5).
 *
 * THE GATE HAS NOT BEEN EXECUTED. §3 M0 requires real credentials and live
 * traffic to freeze the upstream URL, headers, payload shape, and event schemas,
 * and this environment has neither. Consequently:
 *
 *  - `KIRO_DIRECT_ENABLED` defaults to false (see @bosanda/config), and this
 *    adapter raises `adapter_disabled` (503) on every entry point when it is off.
 *    That is checked FIRST, before credentials are read, so a disabled adapter
 *    cannot even decrypt a secret.
 *  - The URL/header construction below follows the shapes §2 records as
 *    OBSERVED, not as documented. `ADAPTER_VERSION` carries a `-draft` suffix so
 *    every usage row is stamped with the fact that it ran against an unverified
 *    protocol.
 *  - The HTTP transport is injectable. Tests use a fake; nothing in the test
 *    suite performs network I/O.
 */

import type { CanonicalEvent, CanonicalRequest } from "@bosanda/protocol";
import { BosandaError } from "@bosanda/protocol";
import type {
  AccountHealth,
  Persona,
  ProviderAdapter,
  ProviderModel,
  ProviderType,
} from "@bosanda/provider-core";
import { type Clock, systemClock, withIdleTimeout } from "@bosanda/shared";
import { CredentialManager, describeCredentials } from "./credentials.js";
import { decodeEventStream, type EventStreamDecoderOptions } from "./eventstream.js";
import { DEFAULT_KIRO_MODELS, resolveModel } from "./models.js";
import {
  classifyHttpStatus,
  classifyStreamError,
  newTelemetry,
  type StreamTelemetry,
  toCanonicalEvents,
  ToolBlockTracker,
} from "./stream.js";
import { FIXTURE_VERSION, transformRequest } from "./transform.js";

/**
 * Adapter version, recorded on every usage row (§3 "Compatibility versioning").
 * The `-draft` suffix states that the compatibility gate has not been executed.
 */
export const ADAPTER_VERSION = `kiro-direct-0.1.0-draft/${FIXTURE_VERSION}`;

/** X-Amz-Target for the IDE persona, per §2. */
const IDE_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

/** What the adapter needs from an HTTP response, so tests need no real fetch. */
export type UpstreamResponse = {
  status: number;
  /** Header lookup, case-insensitive by contract. */
  header(name: string): string | null;
  /** Response body as a byte stream. Absent on an error status. */
  body: AsyncIterable<Uint8Array> | null;
};

export type UpstreamRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

/**
 * HTTP transport port. Injected so the unit suite is hermetic and so §16's
 * "no implicit fallback from a configured proxy to direct egress" can be enforced
 * by the concrete implementation rather than assumed here.
 */
export type UpstreamTransport = (request: UpstreamRequest) => Promise<UpstreamResponse>;

export type KiroAdapterOptions = {
  credentials: CredentialManager;
  transport: UpstreamTransport;
  /** Global kill switch (§3). Read per call, so a flip takes effect immediately. */
  isEnabled: () => boolean;
  /** Emergency tool-use disable (§3). Tools are stripped, the turn still runs. */
  isToolUseEnabled?: () => boolean;
  catalog?: readonly ProviderModel[];
  clock?: Clock;
  /** §7/§16: an upstream that accepts then stalls must not hold a slot forever. */
  idleTimeoutMs?: number;
  decoder?: EventStreamDecoderOptions;
  /** Called once per turn with counts and event-type names only — never text. */
  onTelemetry?: (telemetry: {
    accountId: string;
    model: string;
    fixtureVersion: string;
    unknownEvents: Record<string, number>;
    usageReported: boolean;
    sawStop: boolean;
  }) => void;
};

export class KiroDirectAdapter implements ProviderAdapter {
  readonly providerType: ProviderType = "kiro";
  readonly adapterVersion = ADAPTER_VERSION;

  private readonly credentials: CredentialManager;
  private readonly transport: UpstreamTransport;
  private readonly isEnabled: () => boolean;
  private readonly isToolUseEnabled: () => boolean;
  private readonly catalog: readonly ProviderModel[];
  private readonly clock: Clock;
  private readonly idleTimeoutMs: number;
  private readonly decoderOptions: EventStreamDecoderOptions;
  private readonly onTelemetry: KiroAdapterOptions["onTelemetry"];

  constructor(options: KiroAdapterOptions) {
    this.credentials = options.credentials;
    this.transport = options.transport;
    this.isEnabled = options.isEnabled;
    this.isToolUseEnabled = options.isToolUseEnabled ?? (() => true);
    this.catalog = options.catalog ?? DEFAULT_KIRO_MODELS;
    this.clock = options.clock ?? systemClock;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.decoderOptions = options.decoder ?? {};
    this.onTelemetry = options.onTelemetry;
  }

  /**
   * §3: when the global switch is off, every path returns a sanitized 503. The
   * public message ("This model is temporarily unavailable.") tells a client
   * nothing about which switch fired.
   */
  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new BosandaError("adapter_disabled", {
        internalDetail: "KIRO_DIRECT_ENABLED=false; Kiro Direct adapter is globally disabled",
      });
    }
  }

  /**
   * Confirms the credential can produce a usable access token (§3 G0.6).
   *
   * Returns an AccountHealth whose `detail` is built from `describeCredentials`,
   * i.e. presence flags and an expiry — never token material. A revoked
   * credential yields `credential_invalid`, which §7 escalates to disabling the
   * account until admin action rather than a timed cooldown.
   */
  async validateAccount(accountId: string): Promise<AccountHealth> {
    this.assertEnabled();
    const now = this.clock.now();
    const controller = new AbortController();

    try {
      const credentials = await this.credentials.access(accountId, controller.signal);
      const described = describeCredentials(credentials);
      return {
        accountId,
        status: "active",
        cooldownUntil: null,
        lastValidatedAt: now,
        errorScore: 0,
        activeRequests: 0,
        region: credentials.region,
        persona: credentials.persona,
        detail: `authMethod=${described.authMethod} profileArn=${described.hasProfileArn ? "present" : "absent"}`,
      };
    } catch (error) {
      const classified = BosandaError.from(error, "authentication_error");
      // A credential problem is terminal for the account; anything else is
      // transient and should not brand the account as invalid.
      const terminal =
        classified.code === "authentication_error" || classified.code === "not_found";
      return {
        accountId,
        status: terminal ? "credential_invalid" : "cooling_down",
        cooldownUntil: null,
        lastValidatedAt: now,
        errorScore: 1,
        activeRequests: 0,
        region: "unknown",
        persona: "cli",
        // internalDetail is operator-only and already sanitized by construction.
        detail: classified.internalDetail ?? classified.code,
      };
    }
  }

  /**
   * §3: all Kiro models are hidden while the adapter is globally disabled. The
   * caller filters further with `isModelPubliclyVisible` for per-model switches.
   */
  async listModels(): Promise<ProviderModel[]> {
    if (!this.isEnabled()) return [];
    return [...this.catalog];
  }

  /**
   * Streams one turn.
   *
   * Ordering is deliberate: kill switch, then model resolution, then credentials.
   * A disabled adapter or an unknown model must fail without touching a secret.
   */
  stream(
    request: CanonicalRequest,
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    // Not an async generator itself, so `adapter_disabled` surfaces on the call
    // rather than only on the first `next()` — a caller that builds a lease
    // before iterating would otherwise not learn the adapter is off.
    this.assertEnabled();
    const model = resolveModel(request.model, this.catalog);
    if (request.tools.length > 0 && !model.supportsTools) {
      throw new BosandaError("unsupported_capability", {
        internalDetail: `model "${model.publicId}" does not support tool use`,
      });
    }
    return this.run(request, model, accountId, signal);
  }

  private async *run(
    request: CanonicalRequest,
    model: ProviderModel,
    accountId: string,
    signal: AbortSignal,
  ): AsyncGenerator<CanonicalEvent> {
    const telemetry = newTelemetry();
    const tracker = new ToolBlockTracker();
    let fixtureVersion = FIXTURE_VERSION;

    try {
      const credentials = await this.credentials.access(accountId, signal);

      const transformed = transformRequest(request, {
        upstreamModelId: model.upstreamId,
        persona: credentials.persona,
        profileArn: credentials.profileArn,
        toolsEnabled: this.isToolUseEnabled(),
      });
      fixtureVersion = transformed.fixtureVersion;

      const response = await this.transport({
        url: upstreamUrl(credentials.persona, credentials.region),
        method: "POST",
        headers: upstreamHeaders(credentials.persona, credentials.accessToken),
        body: JSON.stringify(transformed.request),
        signal,
      });

      if (response.status !== 200 || response.body === null) {
        // The response BODY is never read into the error (§12/§16) — only the
        // status and the numeric Retry-After hint.
        throw classifyHttpStatus(response.status, retryAfter(response));
      }

      // message_start carries the PUBLIC model ID: the upstream ID must never
      // reach a client (§9).
      yield { type: "message_start", id: request.requestId, model: model.publicId };

      const messages = withIdleTimeout(
        decodeEventStream(response.body, this.decoderOptions),
        this.idleTimeoutMs,
      );

      for await (const message of messages) {
        for (const event of toCanonicalEvents(message, tracker, telemetry)) {
          yield event;
        }
      }

      // A turn that ended with tool blocks still open would leave a client
      // waiting on a content block that never closes, so close them here.
      for (const index of tracker.openIndices()) {
        tracker.close(index);
        yield { type: "tool_stop", index };
      }

      if (telemetry.usage !== null) {
        yield {
          type: "usage",
          inputTokens: telemetry.usage.inputTokens ?? 0,
          outputTokens: telemetry.usage.outputTokens ?? 0,
          ...(telemetry.usage.cachedTokens !== undefined
            ? { cachedTokens: telemetry.usage.cachedTokens }
            : {}),
          // Only a COMPLETE upstream report is authoritative (§10); the final
          // decision belongs to resolveUsage in @bosanda/metering.
          estimated:
            telemetry.usage.inputTokens === undefined || telemetry.usage.outputTokens === undefined,
        };
      }

      if (!telemetry.sawStop) {
        // The body ended without a stop event. The turn still completed, so emit
        // a finish rather than failing output the customer was billed for.
        yield { type: "finish", reason: tracker.count > 0 ? "tool_use" : "end_turn" };
      }
    } catch (error) {
      throw classifyStreamError(error, accountId);
    } finally {
      this.report(accountId, model.publicId, fixtureVersion, telemetry);
    }
  }

  private report(
    accountId: string,
    model: string,
    fixtureVersion: string,
    telemetry: StreamTelemetry,
  ): void {
    if (this.onTelemetry === undefined) return;
    this.onTelemetry({
      accountId,
      model,
      fixtureVersion,
      unknownEvents: Object.fromEntries(telemetry.unknownEvents),
      usageReported: telemetry.usage !== null,
      sawStop: telemetry.sawStop,
    });
  }
}

function retryAfter(response: UpstreamResponse): number | undefined {
  const raw = response.header("retry-after");
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Upstream endpoint per persona (§2 "Observed upstream targets").
 *
 * The CLI persona is preferred for version 1; IDE remains behind a separate flag
 * and is not required for launch. Region is interpolated from the credential, so
 * an account cannot be routed outside its own region.
 */
export function upstreamUrl(persona: Persona, region: string): string {
  return persona === "cli"
    ? `https://runtime.${region}.kiro.dev/generateAssistantResponse`
    : `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`;
}

/**
 * Request headers.
 *
 * The Authorization value is the only place an access token appears, and it is
 * built here and handed straight to the transport. It is never logged: the
 * observability logger redacts `authorization`, and no code path in this package
 * passes a header map to a log call.
 */
export function upstreamHeaders(
  persona: Persona,
  accessToken: string | null,
): Record<string, string> {
  if (accessToken === null) {
    throw new BosandaError("authentication_error", {
      internalDetail: "no access token available for the upstream request",
    });
  }
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/vnd.amazon.eventstream",
    ...(persona === "ide" ? { "x-amz-target": IDE_TARGET } : {}),
    "user-agent": "bosanda-gateway/0.1",
  };
}
