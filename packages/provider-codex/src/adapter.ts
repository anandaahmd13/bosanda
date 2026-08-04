import { BosandaError, type CanonicalEvent, type CanonicalRequest } from "@bosanda/protocol";
import type { AccountHealth, ProviderAdapter, ProviderModel } from "@bosanda/provider-core";
import { mapCodexModel } from "./models.js";
import type { CodexRuntime } from "./runtime.js";
import { createToolEventTracker, toCanonicalEvents } from "./events.js";
import { ContinuationMap } from "./continuation.js";

export type CodexAdapterOptions = {
  runtime: CodexRuntime;
  enabled?: () => boolean;
  commercialEnabled?: () => boolean;
  toolUseEnabled?: () => boolean;
  continuations?: ContinuationMap;
};

export const ADAPTER_VERSION = "codex-app-server-0.1.0-draft";

export class CodexAdapter implements ProviderAdapter {
  readonly providerType = "openai_codex" as const;
  readonly adapterVersion = ADAPTER_VERSION;
  private readonly runtime: CodexRuntime;
  private readonly enabled: () => boolean;
  private readonly commercialEnabled: () => boolean;
  private readonly toolUseEnabled: () => boolean;
  private readonly continuations: ContinuationMap;

  constructor(options: CodexAdapterOptions) {
    this.runtime = options.runtime;
    this.enabled = options.enabled ?? (() => false);
    this.commercialEnabled = options.commercialEnabled ?? (() => false);
    this.toolUseEnabled = options.toolUseEnabled ?? (() => false);
    this.continuations = options.continuations ?? new ContinuationMap();
  }

  private assertEnabled(): void {
    if (!this.enabled() || !this.commercialEnabled()) {
      throw new BosandaError("adapter_disabled", {
        internalDetail: "OpenAI Codex runtime or commercial gate is disabled",
      });
    }
  }

  async validateAccount(accountId: string): Promise<AccountHealth> {
    this.assertEnabled();
    const account = await this.runtime.accountRead(accountId);
    if (!account.authenticated) {
      return {
        accountId,
        status: "credential_invalid",
        cooldownUntil: null,
        lastValidatedAt: new Date(),
        errorScore: 1,
        activeRequests: 0,
        region: "global",
        persona: "app_server",
        detail: "Codex App Server account is not authenticated",
      };
    }
    return {
      accountId,
      status: "active",
      cooldownUntil: null,
      lastValidatedAt: new Date(),
      errorScore: 0,
      activeRequests: 0,
      region: "global",
      persona: "app_server",
      detail: account.planType ? `plan=${account.planType}` : undefined,
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    if (!this.enabled() || !this.commercialEnabled()) return [];
    // Catalog listing uses a synthetic account id only when the runtime supports
    // account-scoped model discovery; callers should prefer per-account sync.
    const rawModels = await this.runtime.modelList("catalog");
    return rawModels.map(mapCodexModel);
  }

  stream(
    request: CanonicalRequest,
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    this.assertEnabled();
    if (request.tools.length > 0 && !this.toolUseEnabled()) {
      throw new BosandaError("unsupported_capability", {
        internalDetail: "Codex tool use is disabled",
      });
    }
    return this.run(request, accountId, signal);
  }

  private async *run(
    request: CanonicalRequest,
    accountId: string,
    signal: AbortSignal,
  ): AsyncGenerator<CanonicalEvent> {
    const tracker = createToolEventTracker();
    const pendingResults = request.messages
      .flatMap((message) => message.content)
      .filter(
        (
          part,
        ): part is { type: "tool_result"; toolUseId: string; content: string; isError: boolean } =>
          part.type === "tool_result",
      );

    try {
      const source =
        pendingResults.length > 0
          ? this.continueFromResults(accountId, request, pendingResults, signal)
          : this.runtime.turn(accountId, request, signal);

      for await (const event of source) {
        const mapped = toCanonicalEvents(event, request.model, tracker);
        for (const canonical of mapped) {
          if (canonical.type === "tool_start") {
            this.continuations.remember(canonical.id, accountId, canonical.id);
          }
          yield canonical;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        try {
          await this.runtime.abortTurn(accountId);
        } catch {
          // best-effort abort
        }
      }
      // Process loss must not silently continue on another account — clear pins.
      if (error instanceof BosandaError && error.internalDetail?.includes("process lost")) {
        this.continuations.clear(accountId);
      }
      throw BosandaError.from(error, "upstream_incompatible");
    }
  }

  private async *continueFromResults(
    accountId: string,
    request: CanonicalRequest,
    results: { toolUseId: string; content: string; isError: boolean }[],
    signal: AbortSignal,
  ): AsyncIterable<import("./runtime.js").CodexRuntimeEvent> {
    const continuations = [];
    for (const result of results) {
      const pending = this.continuations.take(result.toolUseId, accountId);
      if (pending === null) {
        throw new BosandaError("invalid_request", {
          internalDetail: "codex tool continuation is missing or pinned to another account",
          providerAccountId: accountId,
        });
      }
      continuations.push({
        callId: pending.callId,
        toolUseId: result.toolUseId,
        content: result.content,
        isError: result.isError,
      });
    }
    yield* this.runtime.continueTurn(
      accountId,
      {
        requestId: request.requestId,
        model: request.model,
        toolResults: continuations,
        messages: request.messages,
      },
      signal,
    );
  }
}

export { mapCodexModel };
