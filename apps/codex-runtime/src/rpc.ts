import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_LINE_BYTES = 1_000_000;

type RpcResponse = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type RpcClientOptions = {
  binary: string;
  expectedVersion?: string;
  stateDir: string;
  cwd?: string;
  env?: Record<string, string>;
};

export class CodexRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.on("exit", () => this.close(new Error("Codex App Server exited")));
    child.stderr.on("data", () => undefined);
  }

  static async start(options: RpcClientOptions): Promise<CodexRpcClient> {
    const child = spawn(options.binary, ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd ?? options.stateDir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", CODEX_HOME: options.stateDir, ...options.env },
    });
    const client = new CodexRpcClient(child);
    if (options.expectedVersion !== undefined && options.expectedVersion.length > 0) {
      const version = await CodexRpcClient.version(options.binary);
      if (version !== options.expectedVersion) {
        client.close(new Error("Codex version does not match configured version"));
        throw new Error("Codex version does not match configured version");
      }
    }
    await client.request("initialize", {
      clientInfo: { name: "bosanda", title: "Bosanda", version: "0.1.0" },
      capabilities: {},
    });
    client.notify("initialized", {});
    return client;
  }

  static async version(binary: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, ["--version"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(output.trim()) : reject(new Error("Codex version check failed")),
      );
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex RPC client is closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload, "utf8") > MAX_LINE_BYTES)
      return Promise.reject(new Error("Codex RPC request too large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex RPC request timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    const payload = JSON.stringify({
      method,
      ...(Object.keys(params).length === 0 ? {} : { params }),
    });
    if (Buffer.byteLength(payload, "utf8") <= MAX_LINE_BYTES)
      this.child.stdin.write(`${payload}\n`);
  }

  close(error = new Error("Codex RPC client closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child.kill();
  }

  private onLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
      return this.close(new Error("Codex RPC response too large"));
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return this.close(new Error("Malformed Codex RPC response"));
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(new Error(`Codex RPC error ${message.error.code ?? "unknown"}`));
    else pending.resolve(message.result);
  }
}
