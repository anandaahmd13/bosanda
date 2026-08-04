import { createServer, type Socket } from "node:net";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { CodexRpcClient, type RpcClientOptions } from "./rpc.js";

const MAX_REQUEST_BYTES = 1_000_000;

export type RuntimeServerOptions = RpcClientOptions & { socketPath: string };

export async function startRuntimeServer(
  options: RuntimeServerOptions,
): Promise<{ close(): Promise<void> }> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o750 });
  const server = createServer((socket) => handleConnection(socket, options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function handleConnection(socket: Socket, options: RuntimeServerOptions): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) return socket.destroy();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void handleLine(socket, line, options);
    }
  });
}

async function handleLine(
  socket: Socket,
  line: string,
  options: RuntimeServerOptions,
): Promise<void> {
  try {
    const request = JSON.parse(line) as { op?: string };
    if (request.op !== "health") {
      socket.write(JSON.stringify({ ok: false, error: "operation_not_available" }) + "\n");
      return;
    }
    const client = await CodexRpcClient.start(options);
    client.close();
    socket.write(JSON.stringify({ ok: true, ready: true }) + "\n");
  } catch {
    socket.write(JSON.stringify({ ok: false, error: "runtime_unavailable" }) + "\n");
  }
}
