import type { CodexRpcClient } from "./rpc.js";
import type { AccountSession, SessionManager } from "./sessions.js";
import type { RuntimeRequest, RuntimeResponse } from "./protocol.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function accountSummary(result: unknown): {
  authenticated: boolean;
  email?: string;
  planType?: string;
} {
  const record = asRecord(result) ?? {};
  const account = asRecord(record["account"]) ?? record;
  const authenticated =
    account["authenticated"] === true ||
    account["status"] === "authenticated" ||
    typeof account["email"] === "string";
  const email = typeof account["email"] === "string" ? account["email"] : undefined;
  const planType =
    typeof account["planType"] === "string"
      ? account["planType"]
      : typeof account["plan"] === "string"
        ? account["plan"]
        : undefined;
  return {
    authenticated,
    ...(email === undefined ? {} : { email }),
    ...(planType === undefined ? {} : { planType }),
  };
}

function modelRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }
  const record = asRecord(result);
  if (!record) return [];
  const list = record["models"] ?? record["data"] ?? record["items"];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

function publicLoginStatus(session: AccountSession): Record<string, unknown> {
  const login = session.login;
  if (login.state === "pending") {
    return {
      state: "pending",
      startedAt: login.startedAt,
      ...(login.authUrl === undefined ? {} : { authUrl: login.authUrl }),
    };
  }
  if (login.state === "failed") return { state: "failed", message: login.message };
  if (login.state === "completed") return { state: "completed", completedAt: login.completedAt };
  if (login.state === "cancelled") return { state: "cancelled" };
  return { state: "idle" };
}

export type OpContext = {
  sessions: SessionManager;
  baseOptions: { binary: string; expectedVersion?: string; stateDir: string };
  write: (response: RuntimeResponse) => void;
};

export async function handleOp(request: RuntimeRequest, ctx: OpContext): Promise<void> {
  const id = request.id;
  const reply = (response: Omit<RuntimeResponse, "id">): void => {
    ctx.write({ ...(id === undefined ? {} : { id }), ...response });
  };

  try {
    switch (request.op) {
      case "health": {
        const { CodexRpcClient } = await import("./rpc.js");
        const client = await CodexRpcClient.start(ctx.baseOptions);
        client.close();
        reply({ ok: true, result: { ready: true } });
        return;
      }

      case "account.read": {
        const accountId = requireAccountId(request);
        const session = await ctx.sessions.ensure(accountId);
        const result = await tryAccountRead(session.client);
        reply({ ok: true, result: accountSummary(result) });
        return;
      }

      case "account.login.start": {
        const accountId = requireAccountId(request);
        const session = await ctx.sessions.ensure(accountId);
        session.login = { state: "pending", startedAt: Date.now() };
        attachLoginListeners(session);
        const result = await tryLoginStart(session.client, request.params ?? {});
        const record = asRecord(result) ?? {};
        const authUrl =
          typeof record["authUrl"] === "string"
            ? record["authUrl"]
            : typeof record["url"] === "string"
              ? record["url"]
              : undefined;
        const loginId =
          typeof record["loginId"] === "string"
            ? record["loginId"]
            : typeof record["id"] === "string"
              ? record["id"]
              : undefined;
        session.login = {
          state: "pending",
          startedAt: Date.now(),
          ...(authUrl === undefined ? {} : { authUrl }),
          ...(loginId === undefined ? {} : { loginId }),
        };
        reply({ ok: true, result: publicLoginStatus(session) });
        return;
      }

      case "account.login.status": {
        const accountId = requireAccountId(request);
        const session = await ctx.sessions.ensure(accountId);
        reply({ ok: true, result: publicLoginStatus(session) });
        return;
      }

      case "account.login.cancel": {
        const accountId = requireAccountId(request);
        const session = await ctx.sessions.ensure(accountId);
        await tryLoginCancel(session.client, session);
        session.login = { state: "cancelled" };
        reply({ ok: true, result: publicLoginStatus(session) });
        return;
      }

      case "account.logout": {
        const accountId = requireAccountId(request);
        const session = await ctx.sessions.ensure(accountId);
        await tryLogout(session.client);
        session.login = { state: "idle" };
        session.activeTurnId = null;
        reply({ ok: true, result: { loggedOut: true } });
        return;
      }

      case "model.list": {
        const accountId = requireAccountId(request);
        const session = await ctx.sessions.ensure(accountId);
        const result = await tryModelList(session.client);
        reply({ ok: true, result: modelRows(result) });
        return;
      }

      case "turn.start":
      case "turn.continue": {
        const accountId = requireAccountId(request);
        const session = await ctx.sessions.ensure(accountId);
        await streamTurn(session, request, reply);
        return;
      }

      case "turn.abort": {
        const accountId = requireAccountId(request);
        const session = ctx.sessions.get(accountId);
        if (!session) {
          reply({ ok: true, result: { aborted: false } });
          return;
        }
        await tryTurnAbort(session.client, session.activeTurnId, request.params ?? {});
        session.activeTurnId = null;
        reply({ ok: true, result: { aborted: true } });
        return;
      }

      default:
        reply({ ok: false, error: "operation_not_available" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime_error";
    const safe = message.includes("version")
      ? "version_mismatch"
      : message.includes("timed out")
        ? "timeout"
        : message.includes("exited") ||
            message.includes("closed") ||
            message.includes("process_lost")
          ? "process_lost"
          : message.includes("accountId")
            ? "invalid_request"
            : "runtime_error";
    reply({ ok: false, error: safe });
  }
}

function requireAccountId(request: RuntimeRequest): string {
  if (typeof request.accountId !== "string" || request.accountId.length === 0) {
    throw new Error("accountId required");
  }
  return request.accountId;
}

function attachLoginListeners(session: AccountSession): void {
  const onNotification = (notification: { method: string; params?: Record<string, unknown> }) => {
    if (
      notification.method === "account/login/completed" ||
      notification.method === "login/completed"
    ) {
      session.login = { state: "completed", completedAt: Date.now() };
    }
    if (notification.method === "account/login/failed" || notification.method === "login/failed") {
      session.login = { state: "failed", message: "login_failed" };
    }
  };
  session.client.on("notification", onNotification);
}

async function tryAccountRead(client: CodexRpcClient): Promise<unknown> {
  for (const method of ["account/read", "account/info", "getAccount"]) {
    try {
      return await client.request(method, {});
    } catch {
      // try next documented alias
    }
  }
  return { authenticated: false };
}

async function tryLoginStart(
  client: CodexRpcClient,
  params: Record<string, unknown>,
): Promise<unknown> {
  for (const method of ["account/login/start", "login/start", "account/login"]) {
    try {
      return await client.request(method, params);
    } catch {
      // try next
    }
  }
  throw new Error("login_start_unavailable");
}

async function tryLoginCancel(client: CodexRpcClient, session: AccountSession): Promise<void> {
  const loginId =
    session.login.state === "pending" && session.login.loginId !== undefined
      ? session.login.loginId
      : undefined;
  const params = loginId === undefined ? {} : { loginId };
  for (const method of ["account/login/cancel", "login/cancel"]) {
    try {
      await client.request(method, params);
      return;
    } catch {
      // try next
    }
  }
}

async function tryLogout(client: CodexRpcClient): Promise<void> {
  for (const method of ["account/logout", "logout"]) {
    try {
      await client.request(method, {});
      return;
    } catch {
      // try next
    }
  }
}

async function tryModelList(client: CodexRpcClient): Promise<unknown> {
  for (const method of ["model/list", "models/list", "listModels"]) {
    try {
      return await client.request(method, {});
    } catch {
      // try next
    }
  }
  return [];
}

async function tryTurnAbort(
  client: CodexRpcClient,
  turnId: string | null,
  params: Record<string, unknown>,
): Promise<void> {
  const body = {
    ...params,
    ...(turnId === null ? {} : { turnId }),
  };
  for (const method of ["turn/abort", "turn/interrupt", "interrupt"]) {
    try {
      await client.request(method, body);
      return;
    } catch {
      // try next
    }
  }
}

async function streamTurn(
  session: AccountSession,
  request: RuntimeRequest,
  reply: (response: Omit<RuntimeResponse, "id">) => void,
): Promise<void> {
  const params = request.params ?? {};
  const terminal = new Set(["turn/completed", "turn/interrupted", "turn/failed", "error"]);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      session.client.off("notification", onNotification);
      session.client.off("close", onClose);
      session.activeTurnId = null;
      if (error) reject(error);
      else resolve();
    };

    const onNotification = (notification: { method: string; params?: Record<string, unknown> }) => {
      const turnId = notification.params?.["turnId"];
      if (typeof turnId === "string") session.activeTurnId = turnId;
      reply({
        ok: true,
        event: { method: notification.method, params: notification.params },
      });
      if (terminal.has(notification.method)) {
        reply({ ok: true, done: true });
        finish();
      }
    };

    const onClose = () => {
      reply({
        ok: false,
        error: "process_lost",
        event: { method: "turn/failed", params: { reason: "process_lost" } },
        done: true,
      });
      finish(new Error("process_lost"));
    };

    session.client.on("notification", onNotification);
    session.client.on("close", onClose);

    const methods =
      request.op === "turn.continue"
        ? ["turn/continue", "turn/start", "thread/continue"]
        : ["turn/start", "thread/start", "turn/create"];

    void (async () => {
      let lastError: Error | undefined;
      for (const method of methods) {
        try {
          const result = await session.client.request(method, params, 120_000);
          const record = asRecord(result);
          const turnId = record && typeof record["turnId"] === "string" ? record["turnId"] : null;
          if (turnId) session.activeTurnId = turnId;
          if (record && record["completed"] === true) {
            reply({ ok: true, event: { method: "turn/completed", params: record } });
            reply({ ok: true, done: true });
            finish();
          }
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("turn_failed");
        }
      }
      finish(lastError ?? new Error("turn_unavailable"));
    })();
  });
}
