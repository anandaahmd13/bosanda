import { describe, expect, it } from "vitest";
import { loadEnv, ConfigError, keyringFromEnv, decodeSecret } from "@bosanda/config";
import { randomBytes } from "node:crypto";

const key = () => randomBytes(32).toString("base64");

const validEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://bosanda:pw@127.0.0.1:5432/bosanda",
  PROVIDER_ENCRYPTION_KEY: key(),
  API_KEY_ENCRYPTION_KEY: key(),
  API_KEY_LOOKUP_SECRET: key(),
  SESSION_SECRET: key(),
  PAKASIR_WEBHOOK_SECRET: "pakasir-webhook-secret-value",
  ...overrides,
});

describe("loadEnv", () => {
  it("parses a valid environment and applies documented defaults", () => {
    const env = loadEnv(validEnv());

    expect(env.NODE_ENV).toBe("development");
    expect(env.GATEWAY_PORT).toBe(4000);
    // PLAN.md §7 concurrency decisions.
    expect(env.KEY_MAX_ACTIVE_REQUESTS).toBe(5);
    expect(env.KEY_MAX_REQUESTS_PER_MINUTE).toBe(100);
    expect(env.PROVIDER_COOLDOWN_MS).toBe(30_000);
    // §3: the adapter is off until the gate passes.
    expect(env.KIRO_DIRECT_ENABLED).toBe(false);
    expect(env.PUBLIC_API_URL).toBe("https://api.bosanda.dev");
  });

  it("defaults the Kiro adapter to disabled so no payment can activate it accidentally", () => {
    expect(loadEnv(validEnv()).KIRO_DIRECT_ENABLED).toBe(false);
    expect(loadEnv(validEnv({ KIRO_DIRECT_ENABLED: "true" })).KIRO_DIRECT_ENABLED).toBe(true);
    expect(loadEnv(validEnv({ KIRO_DIRECT_ENABLED: "1" })).KIRO_DIRECT_ENABLED).toBe(true);
    expect(loadEnv(validEnv({ KIRO_DIRECT_ENABLED: "0" })).KIRO_DIRECT_ENABLED).toBe(false);
  });

  it("reports every problem at once instead of failing on the first", () => {
    const error = (() => {
      try {
        loadEnv({ DATABASE_URL: "mysql://nope" });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("expected ConfigError");
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.problems.length).toBeGreaterThan(4);
    expect(error.problems.join("\n")).toContain("DATABASE_URL");
    expect(error.problems.join("\n")).toContain("PROVIDER_ENCRYPTION_KEY");
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: "mysql://h/db" }))).toThrow(ConfigError);
    expect(() =>
      loadEnv(validEnv({ DATABASE_URL: "postgresql://bosanda@localhost/db" })),
    ).not.toThrow();
  });

  it("requires 32-byte base64 secrets", () => {
    for (const bad of ["short", randomBytes(16).toString("base64"), "!!!not-base64!!!"]) {
      expect(() => loadEnv(validEnv({ SESSION_SECRET: bad })), bad).toThrow(ConfigError);
    }
  });

  it("never echoes a secret value in an error message", () => {
    const secret = "SUPER-SECRET-DO-NOT-LEAK";
    try {
      loadEnv(validEnv({ SESSION_SECRET: secret }));
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const text = `${(error as ConfigError).message}\n${(error as ConfigError).problems.join()}`;
      expect(text).not.toContain(secret);
      expect(text).toContain("SESSION_SECRET");
    }
  });

  it("rejects reusing one value across separate secrets (§16)", () => {
    const shared = key();
    const error = (() => {
      try {
        loadEnv(validEnv({ SESSION_SECRET: shared, API_KEY_LOOKUP_SECRET: shared }));
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("expected ConfigError");
    })();

    expect(error.problems.join("\n")).toMatch(/must not reuse the same value/);
  });

  it("parses comma-separated kill-switch lists into trimmed arrays", () => {
    const env = loadEnv(
      validEnv({
        KIRO_DISABLED_REGIONS: "eu-west-1, ap-southeast-1 ,",
        KIRO_DISABLED_MODELS: "kiro-old-model",
      }),
    );
    expect(env.KIRO_DISABLED_REGIONS).toEqual(["eu-west-1", "ap-southeast-1"]);
    expect(env.KIRO_DISABLED_MODELS).toEqual(["kiro-old-model"]);
    expect(loadEnv(validEnv()).KIRO_DISABLED_REGIONS).toEqual([]);
  });

  it("validates numeric ranges", () => {
    expect(() => loadEnv(validEnv({ GATEWAY_PORT: "70000" }))).toThrow(ConfigError);
    expect(() => loadEnv(validEnv({ KEY_MAX_ACTIVE_REQUESTS: "0" }))).toThrow(ConfigError);
    expect(loadEnv(validEnv({ GATEWAY_PORT: "8080" })).GATEWAY_PORT).toBe(8080);
  });
});

describe("keyring", () => {
  it("exposes distinct key material per purpose", () => {
    const keyring = keyringFromEnv(loadEnv(validEnv()));
    const provider = Buffer.from(keyring.keyFor("provider-credentials")).toString("hex");
    const customer = Buffer.from(keyring.keyFor("customer-api-key")).toString("hex");
    const lookup = Buffer.from(keyring.keyFor("api-key-lookup")).toString("hex");

    expect(new Set([provider, customer, lookup]).size).toBe(3);
    expect(keyring.keyFor("provider-credentials")).toHaveLength(32);
  });

  it("decrypts the current version and refuses unknown versions loudly", () => {
    const keyring = keyringFromEnv(loadEnv(validEnv({ ENCRYPTION_KEY_VERSION: "3" })));
    expect(keyring.currentVersion).toBe(3);
    expect(keyring.keyForVersion("session", 3)).toHaveLength(32);
    expect(() => keyring.keyForVersion("session", 2)).toThrow(ConfigError);
  });
});

describe("decodeSecret", () => {
  it("returns 32 raw bytes for valid input", () => {
    expect(decodeSecret("X", randomBytes(32).toString("base64"))).toHaveLength(32);
  });

  it("names the variable when the length is wrong", () => {
    expect(() => decodeSecret("MY_KEY", randomBytes(8).toString("base64"))).toThrow(/MY_KEY/);
  });
});
