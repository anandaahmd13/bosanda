import { createConnection } from "node:net";
import { BosandaError, type CanonicalRequest } from "@bosanda/protocol";

export type CodexRuntimeEvent = {
  method: string;
  params?: Record<string, unknown>;
};

export const CODEX_APP_SERVER_INITIALIZE = {
  clientInfo: { name: "bosanda", title: "Bosanda", version: "0.1.0" },
  capabilities: {},
} as const;

export type CodexAccountInfo = {
  authenticated: boolean;
  email?: string;
  planType?: string;
};

export type CodexLoginStatus = {
  state: "idle" | "pending" | "completed" | "failed" | "cancelled";
  authUrl?: string;
  startedAt?: number;
  completedAt?: number;
  message?: string;
};

export type CodexRuntime = {
  health(): Promise<{ ready: boolean }>;
  accountRead(accountId: string): Promise<CodexAccountInfo>;
  loginStart(accountId: string, params?: Record<string, unknown>): Promise<CodexLoginStatus>;
  loginStatus(accountId: string): Promise<CodexLoginStatus>;
  loginCancel(accountId: string): Promise<CodexLoginStatus>;
  logout(accountId: string): Promise<void>;
  modelList(accountId: string): Promise<readonly Record<string, unknown>[]>;
  turn(
    accountId: string,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CodexRuntimeEvent>;
  continueTurn(
    accountId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<CodexRuntimeEvent>;
  abortTurn(accountId: string, turnId?: string): Promise<void>;
};

export type CodexRuntimeClient = CodexRuntime;

export type CodexRuntimeClientOptions = {
  socketPath: string;
  /** When false, all ops throw adapter_disabled. */
  enabled?: () => boolean;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type SocketResponse = {
  id?: string;
  ok: boolean;
  error?: string;
  result?: unknown;
  event?: { method: string; params?: Record<string, unknown> };
  done?: boolean;
};

function mapSocketError(error: string | undefined, accountId?: string): BosandaError {
  const code = error ?? "runtime_error";
  if (code === "timeout" || code === "version_mismatch") {
    return new BosandaError(code === "timeout" ? "upstream_timeout" : "upstream_incompatible", {
      internalDetail: `codex runtime: ${code}`,
      providerAccountId: accountId,
    });
  }
  if (code === "process_lost") {
    return new BosandaError("upstream_incompatible", {
      internalDetail: "codex runtime process lost mid-turn",
      providerAccountId: accountId,
    });
  }
  if (code === "invalid_request" || code === "operation_not_available") {
    return new BosandaError("invalid_request", {
      internalDetail: `codex runtime: ${code}`,
      providerAccountId: accountId,
    });
  }
  if (code === "runtime_unavailable") {
    return new BosandaError("no_healthy_provider", {
      internalDetail: "codex runtime unavailable",
      providerAccountId: accountId,
    });
  }
  return new BosandaError("upstream_incompatible", {
    internalDetail: `codex runtime: ${code}`,
    providerAccountId: accountId,
  });
}

function toLoginStatus(result: unknown): CodexLoginStatus {
  if (typeof result !== "object" || result === null) return { state: "idle" };
  const row = result as Record<string, unknown>;
  const state = row["state"];
  if (
    state === "idle" ||
    state === "pending" ||
    state === "completed" ||
    state === "failed" ||
    state === "cancelled"
  ) {
    return {
      state,
      ...(typeof row["authUrl"] === "string" ? { authUrl: row["authUrl"] } : {}),
      ...(typeof row["startedAt"] === "number" ? { startedAt: row["startedAt"] } : {}),
      ...(typeof row["completedAt"] === "number" ? { completedAt: row["completedAt"] } : {}),
      ...(typeof row["message"] === "string" ? { message: row["message"] } : {}),
    };
  }
  return { state: "idle" };
}

function requestToTurnParams(request: CanonicalRequest): Record<string, unknown> {
  return {
    requestId: request.requestId,
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    stopSequences: request.stopSequences,
    stream: request.stream,
  };
}

class SocketCodexRuntime implements CodexRuntime {
  private readonly socketPath: string;
  private readonly enabled: () => boolean;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private nextId = 1;

  constructor(options: CodexRuntimeClientOptions) {
    this.socketPath = options.socketPath;
    this.enabled = options.enabled ?? (() => true);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  private assertEnabled(): void {
    if (!this.enabled()) {
      throw new BosandaError("adapter_disabled", {
        internalDetail: "OpenAI Codex runtime is disabled",
      });
    }
  }

  async health(): Promise<{ ready: boolean }> {
    this.assertEnabled();
    const result = await this.request("health");
    const row =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    return { ready: row["ready"] === true };
  }

  async accountRead(accountId: string): Promise<CodexAccountInfo> {
    this.assertEnabled();
    const result = await this.request("account.read", accountId);
    const row =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    return {
      authenticated: row["authenticated"] === true,
      ...(typeof row["email"] === "string" ? { email: row["email"] } : {}),
      ...(typeof row["planType"] === "string" ? { planType: row["planType"] } : {}),
    };
  }

  async loginStart(
    accountId: string,
    params: Record<string, unknown> = {},
  ): Promise<CodexLoginStatus> {
    this.assertEnabled();
    const result = await this.request("account.login.start", accountId, params);
    return toLoginStatus(result);
  }

  async loginStatus(accountId: string): Promise<CodexLoginStatus> {
    this.assertEnabled();
    const result = await this.request("account.login.status", accountId);
    return toLoginStatus(result);
  }

  async loginCancel(accountId: string): Promise<CodexLoginStatus> {
    this.assertEnabled();
    const result = await this.request("account.login.cancel", accountId);
    return toLoginStatus(result);
  }

  async logout(accountId: string): Promise<void> {
    this.assertEnabled();
    await this.request("account.logout", accountId);
  }

  async modelList(accountId: string): Promise<readonly Record<string, unknown>[]> {
    this.assertEnabled();
    const result = await this.request("model.list", accountId);
    if (!Array.isArray(result)) return [];
    return result.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }

  turn(
    accountId: string,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CodexRuntimeEvent> {
    this.assertEnabled();
    return this.streamOp("turn.start", accountId, requestToTurnParams(request), signal);
  }

  continueTurn(
    accountId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<CodexRuntimeEvent> {
    this.assertEnabled();
    return this.streamOp("turn.continue", accountId, params, signal);
  }

  async abortTurn(accountId: string, turnId?: string): Promise<void> {
    this.assertEnabled();
    await this.request("turn.abort", accountId, turnId === undefined ? {} : { turnId });
  }

  private async request(
    op: string,
    accountId?: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const id = String(this.nextId++);
    const payload = JSON.stringify({
      id,
      op,
      ...(accountId === undefined ? {} : { accountId }),
      ...(params === undefined || Object.keys(params).length === 0 ? {} : { params }),
    });

    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let buffer = "";
      let settled = false;

      const timer = setTimeout(() => {
        fail(mapSocketError("timeout", accountId));
      }, this.requestTimeoutMs);

      const connectTimer = setTimeout(() => {
        fail(mapSocketError("runtime_unavailable", accountId));
      }, this.connectTimeoutMs);

      const fail = (error: BosandaError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        socket.destroy();
        reject(error);
      };

      const succeed = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        socket.end();
        resolve(value);
      };

      socket.on("connect", () => {
        clearTimeout(connectTimer);
        socket.write(`${payload}\n`);
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let response: SocketResponse;
          try {
            response = JSON.parse(line) as SocketResponse;
          } catch {
            fail(
              new BosandaError("upstream_incompatible", {
                internalDetail: "malformed codex runtime response",
                providerAccountId: accountId,
              }),
            );
            return;
          }
          if (response.id !== undefined && response.id !== id) continue;
          if (!response.ok) {
            fail(mapSocketError(response.error, accountId));
            return;
          }
          if (response.event !== undefined || response.done === true) continue;
          succeed(response.result);
        }
      });

      socket.on("error", () => fail(mapSocketError("runtime_unavailable", accountId)));
      socket.on("close", () => {
        if (!settled) fail(mapSocketError("runtime_unavailable", accountId));
      });
    });
  }

  private async *streamOp(
    op: string,
    accountId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<CodexRuntimeEvent> {
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, op, accountId, params });
    const queue: CodexRuntimeEvent[] = [];
    let waiting: ((value: IteratorResult<CodexRuntimeEvent>) => void) | null = null;
    let done = false;
    let failure: BosandaError | null = null;

    const socket = createConnection({ path: this.socketPath });
    let buffer = "";

    const push = (event: CodexRuntimeEvent | null, error?: BosandaError) => {
      if (error) failure = error;
      if (event) queue.push(event);
      if (event === null) done = true;
      if (waiting) {
        const wake = waiting;
        waiting = null;
        if (failure) wake({ value: undefined as never, done: true });
        else if (queue.length > 0) {
          const next = queue.shift();
          if (next) wake({ value: next, done: false });
        } else if (done) wake({ value: undefined as never, done: true });
      }
    };

    const onAbort = () => {
      void this.abortTurn(accountId).catch(() => undefined);
      socket.destroy();
      push(
        null,
        new BosandaError("upstream_timeout", {
          internalDetail: "codex turn aborted",
          providerAccountId: accountId,
        }),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    socket.on("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let response: SocketResponse;
        try {
          response = JSON.parse(line) as SocketResponse;
        } catch {
          push(
            null,
            new BosandaError("upstream_incompatible", {
              internalDetail: "malformed codex runtime stream frame",
              providerAccountId: accountId,
            }),
          );
          return;
        }
        if (response.id !== undefined && response.id !== id) continue;
        if (!response.ok && response.event === undefined) {
          push(null, mapSocketError(response.error, accountId));
          return;
        }
        if (response.event) push(response.event);
        if (response.done) {
          if (!response.ok && response.error) push(null, mapSocketError(response.error, accountId));
          else push(null);
          socket.end();
        }
      }
    });
    socket.on("error", () => push(null, mapSocketError("runtime_unavailable", accountId)));
    socket.on("close", () => {
      if (!done && !failure) push(null, mapSocketError("process_lost", accountId));
    });

    try {
      while (true) {
        if (failure) throw failure;
        if (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
          continue;
        }
        if (done) break;
        const result = await new Promise<IteratorResult<CodexRuntimeEvent>>((resolve) => {
          waiting = resolve;
        });
        if (failure) throw failure;
        if (result.done) break;
        yield result.value;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
    }
  }
}

/**
 * Production socket client. Construction is allowed when the runtime flag is on;
 * commercial/tool gates still live on the adapter. When disabled, ops throw
 * adapter_disabled so the registry can exist without serving traffic.
 */
export function createCodexRuntimeClient(options: CodexRuntimeClientOptions): CodexRuntimeClient {
  return new SocketCodexRuntime(options);
}

/** Test double / local wiring helper. */
export function createMemoryCodexRuntime(impl: CodexRuntime): CodexRuntimeClient {
  return impl;
}
