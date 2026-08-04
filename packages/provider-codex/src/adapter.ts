import { BosandaError, type CanonicalEvent, type CanonicalRequest } from "@bosanda/protocol";
import type { AccountHealth, ProviderAdapter, ProviderModel } from "@bosanda/provider-core";
import { mapCodexModel } from "./models.js";
import type { CodexRuntime } from "./runtime.js";
import { toCanonicalEvents } from "./events.js";

export type CodexAdapterOptions = {
  runtime: CodexRuntime;
  enabled?: () => boolean;
  commercialEnabled?: () => boolean;
  toolUseEnabled?: () => boolean;
};

export const ADAPTER_VERSION = "codex-app-server-0.1.0-draft";

export class CodexAdapter implements ProviderAdapter {
  readonly providerType = "openai_codex" as const;
  readonly adapterVersion = ADAPTER_VERSION;
  private readonly runtime: CodexRuntime;
  private readonly enabled: () => boolean;
  private readonly commercialEnabled: () => boolean;
  private readonly toolUseEnabled: () => boolean;

  constructor(options: CodexAdapterOptions) {
    this.runtime = options.runtime;
    this.enabled = options.enabled ?? (() => false);
    this.commercialEnabled = options.commercialEnabled ?? (() => false);
    this.toolUseEnabled = options.toolUseEnabled ?? (() => false);
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
    try {
      for await (const event of this.runtime.turn(accountId, request, signal)) {
        yield* toCanonicalEvents(event, request.model);
      }
    } catch (error) {
      throw BosandaError.from(error, "upstream_incompatible");
    }
  }
}

export { mapCodexModel };
