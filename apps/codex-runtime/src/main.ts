import { loadEnv } from "@bosanda/config";
import { startRuntimeServer } from "./socket.js";

const env = loadEnv();
const server = await startRuntimeServer({
  binary: env.OPENAI_CODEX_BINARY,
  expectedVersion: env.OPENAI_CODEX_EXPECTED_VERSION,
  stateDir: env.OPENAI_CODEX_STATE_DIR,
  socketPath: env.OPENAI_CODEX_SOCKET,
});

const shutdown = async () => {
  await server.close();
  process.exitCode = 0;
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
