/**
 * Test doubles for provider-core.
 *
 * `provider-kiro` is owned by another agent and must not be imported here, so
 * these fakes satisfy the frozen `ProviderAdapter` contract directly. No network,
 * no timers, no real credentials.
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
import type { SchedulableAccount } from "@bosanda/provider-core";

export const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

/**
 * A mutable clock. `fixedClock` from @bosanda/shared is frozen at one instant;
 * cooldown and breaker tests need to advance time, so this adds `advance()`
 * while keeping the same `Clock` shape.
 */
export function controllableClock(start: Date = FIXED_NOW): {
  now(): Date;
  advance(ms: number): void;
  set(at: Date): void;
} {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (at: Date) => {
      current = at.getTime();
    },
  };
}

export function accountHealth(
  accountId: string,
  overrides: Partial<AccountHealth> = {},
): AccountHealth {
  return {
    accountId,
    status: "active",
    cooldownUntil: null,
    lastValidatedAt: FIXED_NOW,
    errorScore: 0,
    activeRequests: 0,
    region: "us-east-1",
    persona: "cli",
    ...overrides,
  };
}

/** Builds a schedulable account with sensible defaults. */
export function account(
  accountId: string,
  options: {
    models?: string[];
    region?: string;
    persona?: Persona;
    maxConcurrent?: number;
    health?: Partial<AccountHealth>;
  } = {},
): SchedulableAccount {
  const health = accountHealth(accountId, {
    region: options.region ?? "us-east-1",
    persona: options.persona ?? "cli",
    ...options.health,
  });
  const base: SchedulableAccount = {
    accountId,
    health,
    supportedModels: new Set(options.models ?? ["model-a"]),
  };
  return options.maxConcurrent === undefined
    ? base
    : { ...base, maxConcurrent: options.maxConcurrent };
}

export function pool(count: number, models: string[] = ["model-a"]): SchedulableAccount[] {
  return Array.from({ length: count }, (_unused, index) =>
    account(`acct-${String(index + 1).padStart(2, "0")}`, { models }),
  );
}

export const model = (publicId: string, overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  publicId,
  upstreamId: `upstream-${publicId}`,
  label: publicId,
  contextWindow: 200_000,
  multiplier: 1.3,
  multiplierVersion: 1,
  supportsTools: true,
  supportsReasoning: true,
  regions: ["us-east-1"],
  published: true,
  compatibilityStatus: "passing",
  ...overrides,
});

export type FakeAdapterOptions = {
  providerType?: ProviderType;
  adapterVersion?: string;
  models?: ProviderModel[];
  /** Events emitted per successful stream. */
  events?: CanonicalEvent[];
  /**
   * Per-account behaviour. "ok" streams `events`; a BosandaError is thrown
   * before any event; `{ afterEvents: n, error }` throws mid-stream after n
   * events — the case that must NEVER trigger failover.
   */
  behaviour?: Record<string, "ok" | BosandaError | { afterEvents: number; error: BosandaError }>;
};

/** Records what the fake was asked to do, for assertions. */
export type FakeAdapterCalls = {
  streamedAccounts: string[];
  validated: string[];
  listModelsCalls: number;
};

export class FakeAdapter implements ProviderAdapter {
  readonly providerType: ProviderType;
  readonly adapterVersion: string;
  readonly calls: FakeAdapterCalls = {
    streamedAccounts: [],
    validated: [],
    listModelsCalls: 0,
  };

  private readonly models: ProviderModel[];
  private readonly events: CanonicalEvent[];
  private readonly behaviour: NonNullable<FakeAdapterOptions["behaviour"]>;

  constructor(options: FakeAdapterOptions = {}) {
    this.providerType = options.providerType ?? "kiro";
    this.adapterVersion = options.adapterVersion ?? "fake-1.0.0";
    this.models = options.models ?? [model("model-a")];
    this.events = options.events ?? [
      { type: "message_start", id: "msg-1", model: "model-a" },
      { type: "text_delta", text: "hello" },
      { type: "finish", reason: "end_turn" },
    ];
    this.behaviour = options.behaviour ?? {};
  }

  async validateAccount(accountId: string): Promise<AccountHealth> {
    this.calls.validated.push(accountId);
    const behaviour = this.behaviour[accountId];
    if (behaviour instanceof BosandaError) {
      return accountHealth(accountId, {
        status: "credential_invalid",
        detail: behaviour.code,
      });
    }
    return accountHealth(accountId);
  }

  async listModels(): Promise<ProviderModel[]> {
    this.calls.listModelsCalls += 1;
    return this.models;
  }

  async *stream(
    _request: CanonicalRequest,
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    this.calls.streamedAccounts.push(accountId);
    const behaviour = this.behaviour[accountId] ?? "ok";

    if (behaviour instanceof BosandaError) throw behaviour;

    const failAfter =
      typeof behaviour === "object" && behaviour !== null && "afterEvents" in behaviour
        ? behaviour
        : undefined;

    let emitted = 0;
    for (const event of this.events) {
      if (signal.aborted) {
        throw BosandaError.from(signal.reason ?? new Error("aborted"));
      }
      if (failAfter && emitted === failAfter.afterEvents) throw failAfter.error;
      yield event;
      emitted += 1;
    }
    if (failAfter && emitted === failAfter.afterEvents) throw failAfter.error;
  }
}

/** Minimal CanonicalRequest for tests that need one. */
export function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: "req-test-0001",
    surface: "openai",
    model: "model-a",
    system: null,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
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

/** Deterministic "random" so jittered backoff is assertable. */
export const noJitter = (): number => 1;
export const midJitter = (): number => 0.5;
