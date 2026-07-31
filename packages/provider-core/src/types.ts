/**
 * Provider abstraction (PLAN.md §6 "Provider interface", §9 "Model registry").
 *
 * This file is the contract between the scheduler in `provider-core` and each
 * concrete adapter (`provider-kiro`, and any official provider added later).
 * It must stay free of Kiro-specific and client-protocol-specific detail:
 * adapters speak CanonicalRequest/CanonicalEvent only.
 */

import type { CanonicalEvent, CanonicalRequest } from "@bosanda/protocol";

export type ProviderType = "kiro";

/** Which upstream persona an account authenticates as (PLAN.md §2). */
export type Persona = "cli" | "ide";

export type AccountStatus =
  | "active"
  /** Operator switched it off. */
  | "disabled"
  /** Transient failure cooldown; eligible again after cooldownUntil. */
  | "cooling_down"
  /** Credential revoked or unrecoverable — requires admin action (§7). */
  | "credential_invalid";

export type AccountHealth = {
  accountId: string;
  status: AccountStatus;
  /** Null when the account is currently eligible. */
  cooldownUntil: Date | null;
  lastValidatedAt: Date | null;
  /** Recent error score used as the second sort key in selection (§7). */
  errorScore: number;
  /** In-flight requests, for least-loaded ordering (§7). */
  activeRequests: number;
  region: string;
  persona: Persona;
  /** Operator-facing reason; must already be sanitized of credential data. */
  detail?: string;
};

export type ProviderModel = {
  /** Public Bosanda model ID exposed via /v1/models. */
  publicId: string;
  /** Upstream provider model ID — never surfaced to clients. */
  upstreamId: string;
  label: string;
  contextWindow: number;
  /** Kiro cost multiplier applied to raw tokens (§10). */
  multiplier: number;
  multiplierVersion: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  regions: string[];
  published: boolean;
  compatibilityStatus: "unknown" | "passing" | "failing";
};

/**
 * The adapter contract. `stream` must:
 *  - never emit client-protocol JSON (that is the encoder's job);
 *  - abort the upstream fetch when `signal` aborts;
 *  - throw BosandaError with a classified code on failure;
 *  - never include credential material in thrown errors or logs.
 */
export interface ProviderAdapter {
  readonly providerType: ProviderType;
  /** Recorded on every usage row for compatibility versioning (§3). */
  readonly adapterVersion: string;

  validateAccount(accountId: string): Promise<AccountHealth>;
  listModels(): Promise<ProviderModel[]>;

  stream(
    request: CanonicalRequest,
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent>;
}

/**
 * Decrypted provider credential material (§6 "Authentication data").
 *
 * Instances exist only in memory for the duration of a refresh or request. They
 * must never be logged, serialized into an error, or written to disk.
 */
export type ProviderCredentials = {
  authMethod: "social" | "idc" | "api_key";
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  region: string;
  profileArn: string | null;
  clientId: string | null;
  clientSecret: string | null;
  persona: Persona;
  /** Optimistic-concurrency guard for refresh-token rotation (§6). */
  credentialVersion: number;
};

/** Kill-switch surface (PLAN.md §3). Every check is consulted before routing. */
export type KillSwitches = {
  /** Global KIRO_DIRECT_ENABLED=false hides all Kiro models and rejects with 503. */
  adapterEnabled: boolean;
  toolUseEnabled: boolean;
  disabledRegions: ReadonlySet<string>;
  disabledModels: ReadonlySet<string>;
  disabledAccounts: ReadonlySet<string>;
};
