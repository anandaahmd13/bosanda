import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CodexRpcClient, type RpcClientOptions } from "./rpc.js";

export type AccountSession = {
  accountId: string;
  client: CodexRpcClient;
  stateDir: string;
  login:
    | { state: "idle" }
    | { state: "pending"; startedAt: number; loginId?: string; authUrl?: string }
    | { state: "completed"; completedAt: number }
    | { state: "failed"; message: string }
    | { state: "cancelled" };
  activeTurnId: string | null;
};

export type SessionManagerOptions = RpcClientOptions & {
  stateDir: string;
};

/**
 * One App Server process per account id, isolated under its own CODEX_HOME.
 * Credentials live only in that state dir — never returned over the socket.
 */
export class SessionManager {
  private readonly sessions = new Map<string, AccountSession>();
  private readonly options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  async ensure(accountId: string): Promise<AccountSession> {
    const existing = this.sessions.get(accountId);
    if (existing && !existing.client.isClosed) return existing;

    const accountStateDir = join(this.options.stateDir, accountId);
    await mkdir(accountStateDir, { recursive: true, mode: 0o700 });
    const client = await CodexRpcClient.start({
      ...this.options,
      stateDir: accountStateDir,
    });
    const session: AccountSession = {
      accountId,
      client,
      stateDir: accountStateDir,
      login: { state: "idle" },
      activeTurnId: null,
    };
    this.sessions.set(accountId, session);
    return session;
  }

  get(accountId: string): AccountSession | undefined {
    return this.sessions.get(accountId);
  }

  async drop(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;
    session.client.close();
    this.sessions.delete(accountId);
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) session.client.close();
    this.sessions.clear();
  }
}
