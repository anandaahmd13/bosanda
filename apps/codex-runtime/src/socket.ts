import { createServer, type Socket } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { RpcClientOptions } from "./rpc.js";
import { SessionManager } from "./sessions.js";
import { handleOp } from "./ops.js";
import type { RuntimeRequest, RuntimeResponse } from "./protocol.js";

const MAX_REQUEST_BYTES = 1_000_000;

export type RuntimeServerOptions = RpcClientOptions & { socketPath: string };

export async function startRuntimeServer(
  options: RuntimeServerOptions,
): Promise<{ close(): Promise<void> }> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o750 });
  try {
    await unlink(options.socketPath);
  } catch {
    // absent is fine
  }

  const sessions = new SessionManager(options);
  const baseOptions = {
    binary: options.binary,
    expectedVersion: options.expectedVersion,
    stateDir: options.stateDir,
  };

  const server = createServer((socket) => handleConnection(socket, sessions, baseOptions));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    close: async () => {
      await sessions.closeAll();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function handleConnection(
  socket: Socket,
  sessions: SessionManager,
  baseOptions: { binary: string; expectedVersion?: string; stateDir: string },
): void {
  let buffer = "";
  const write = (response: RuntimeResponse): void => {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      socket.destroy();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void dispatch(line, sessions, baseOptions, write);
    }
  });
}

async function dispatch(
  line: string,
  sessions: SessionManager,
  baseOptions: { binary: string; expectedVersion?: string; stateDir: string },
  write: (response: RuntimeResponse) => void,
): Promise<void> {
  let request: RuntimeRequest;
  try {
    request = JSON.parse(line) as RuntimeRequest;
  } catch {
    write({ ok: false, error: "malformed_request" });
    return;
  }
  if (typeof request.op !== "string" || request.op.length === 0) {
    write({
      ...(request.id === undefined ? {} : { id: request.id }),
      ok: false,
      error: "operation_not_available",
    });
    return;
  }
  await handleOp(request, { sessions, baseOptions, write });
}
