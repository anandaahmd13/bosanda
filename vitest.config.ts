import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string, entry = "src/index.ts") =>
  fileURLToPath(new URL(`./packages/${name}/${entry}`, import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "spikes/*/test/**/*.test.ts",
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@bosanda/config": pkg("config"),
      "@bosanda/database": pkg("database"),
      "@bosanda/auth": pkg("auth"),
      "@bosanda/api-keys": pkg("api-keys"),
      "@bosanda/protocol": pkg("protocol"),
      "@bosanda/openai": pkg("openai"),
      "@bosanda/anthropic": pkg("anthropic"),
      "@bosanda/provider-core": pkg("provider-core"),
      "@bosanda/provider-kiro": pkg("provider-kiro"),
      "@bosanda/metering": pkg("metering"),
      "@bosanda/payments": pkg("payments"),
      "@bosanda/observability": pkg("observability"),
      "@bosanda/shared": pkg("shared"),
    },
  },
});
