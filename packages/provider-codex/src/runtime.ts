import type { CanonicalRequest } from "@bosanda/protocol";

export type CodexRuntimeEvent = {
  method: string;
  params?: Record<string, unknown>;
};

export const CODEX_APP_SERVER_INITIALIZE = {
  clientInfo: { name: "bosanda", title: "Bosanda", version: "0.1.0" },
  capabilities: {},
} as const;

export type CodexRuntime = {
  accountRead(
    accountId: string,
  ): Promise<{ authenticated: boolean; email?: string; planType?: string }>;
  modelList(accountId: string): Promise<readonly Record<string, unknown>[]>;
  turn(
    accountId: string,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CodexRuntimeEvent>;
};

export type CodexRuntimeClient = CodexRuntime;

/** ponytail: gate ceiling — production socket wiring waits for owner-run App Server evidence. */
export function createCodexRuntimeClient(): CodexRuntimeClient {
  throw new Error("Codex runtime socket client is not enabled until the compatibility gate passes");
}
