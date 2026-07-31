/**
 * Secret decoding and keyring tests (PLAN.md §16).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM env.test.ts. `env.test.ts` covers schema
 * parsing; this covers the one place where Node's own API is a trap:
 *
 *   Buffer.from(value, "base64") NEVER THROWS. It silently discards every
 *   character outside the base64 alphabet.
 *
 * So `"<32 bytes of base64>" + "!!!"`, the same string with an embedded newline,
 * and the same string with padding stripped all decode to 32 bytes — and to the
 * SAME 32 bytes as the clean value. Before the fix these tests pin, `loadEnv`
 * accepted API_KEY_LOOKUP_SECRET and SESSION_SECRET as "distinct" (the strings
 * differed) while `keyringFromEnv` handed out identical key material for both.
 * §16's entire point is that a leak of one subsystem's key does not compromise
 * another, and that guarantee was silently void.
 *
 * The tests are therefore written against the property an operator cares about —
 * "different-looking secrets are really different KEYS" — not against the
 * validator's implementation.
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { ConfigError, decodeSecret, keyringFromEnv, loadEnv, type Env } from "../src/index.js";

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

/** Variants of `clean` that Buffer.from decodes to the SAME bytes as `clean`. */
function aliasesOf(clean: string): { label: string; value: string }[] {
  return [
    { label: "embedded newline", value: `${clean.slice(0, 10)}\n${clean.slice(10)}` },
    { label: "embedded space", value: `${clean.slice(0, 10)} ${clean.slice(10)}` },
    { label: "embedded junk", value: `${clean.slice(0, 10)}!!!${clean.slice(10)}` },
    { label: "leading space", value: ` ${clean}` },
    { label: "trailing space", value: `${clean} ` },
    { label: "trailing newline", value: `${clean}\n` },
    { label: "padding stripped", value: clean.replace(/=+$/, "") },
    { label: "tab separated", value: `${clean.slice(0, 8)}\t${clean.slice(8)}` },
  ];
}

describe("Buffer.from base64 — the trap being guarded", () => {
  it("confirms Node decodes non-canonical input to identical bytes", () => {
    // Not testing our code: documenting the platform behaviour the guards exist
    // for, so a future reader does not "simplify" them away.
    const clean = key();
    const cleanBytes = Buffer.from(clean, "base64");
    for (const alias of aliasesOf(clean)) {
      const bytes = Buffer.from(alias.value, "base64");
      expect(alias.value, alias.label).not.toBe(clean);
      expect(bytes.length, alias.label).toBe(32);
      expect(bytes.equals(cleanBytes), `${alias.label} decoded differently`).toBe(true);
    }
  });
});

describe("decodeSecret", () => {
  it("returns 32 raw bytes for canonical input", () => {
    const clean = key();
    const bytes = decodeSecret("X", clean);
    expect(bytes).toHaveLength(32);
    expect(Buffer.from(bytes).toString("base64")).toBe(clean);
  });

  it("returns a Uint8Array, not a Buffer view that could alias", () => {
    expect(decodeSecret("X", key())).toBeInstanceOf(Uint8Array);
  });

  it("rejects every non-canonical alias of a valid secret", () => {
    // The regression. Each of these previously produced usable key bytes
    // identical to the clean value's.
    const clean = key();
    for (const alias of aliasesOf(clean)) {
      expect(() => decodeSecret("MY_KEY", alias.value), alias.label).toThrow(ConfigError);
    }
  });

  it("rejects the wrong length", () => {
    for (const bytes of [8, 16, 31, 33, 64]) {
      expect(
        () => decodeSecret("MY_KEY", randomBytes(bytes).toString("base64")),
        `${bytes}`,
      ).toThrow(ConfigError);
    }
  });

  it("rejects an empty value", () => {
    expect(() => decodeSecret("MY_KEY", "")).toThrow(ConfigError);
  });

  it("rejects a value that is not base64 at all", () => {
    expect(() => decodeSecret("MY_KEY", "!!!not-base64!!!")).toThrow(ConfigError);
  });

  it("names the variable and never the value (§17)", () => {
    const secret = "LEAKED-SECRET-VALUE-4d1f";
    for (const bad of [secret, `${key()}${secret}`, ""]) {
      try {
        decodeSecret("MY_KEY", bad);
        expect.unreachable("expected ConfigError");
      } catch (error) {
        const text = `${(error as ConfigError).message}\n${(error as ConfigError).problems.join()}`;
        expect(text).toContain("MY_KEY");
        expect(text).not.toContain(secret);
      }
    }
  });

  it("tells the operator how to generate a correct value", () => {
    // A rejection an operator cannot act on gets worked around, usually by
    // pasting something worse.
    try {
      decodeSecret("MY_KEY", ` ${key()}`);
      expect.unreachable("expected ConfigError");
    } catch (error) {
      expect((error as ConfigError).message).toContain("openssl rand -base64 32");
    }
  });
});

describe("loadEnv secret validation (§16)", () => {
  it("rejects a non-canonical secret at the parse boundary", () => {
    const clean = key();
    for (const alias of aliasesOf(clean)) {
      expect(() => loadEnv(validEnv({ SESSION_SECRET: alias.value })), alias.label).toThrow(
        ConfigError,
      );
    }
  });

  it("does not accept two secrets that decode to the same key material", () => {
    // THE BUG. The strings differ, so the old string-equality distinctness check
    // passed, and the keyring then handed identical bytes to the API-key HMAC and
    // the session signer.
    const shared = key();
    const disguised = `${shared.slice(0, 10)}\n${shared.slice(10)}`;
    expect(disguised).not.toBe(shared);

    expect(() =>
      loadEnv(validEnv({ API_KEY_LOOKUP_SECRET: shared, SESSION_SECRET: disguised })),
    ).toThrow(ConfigError);
  });

  it("still rejects the plain case of one value reused verbatim", () => {
    const shared = key();
    expect(() =>
      loadEnv(validEnv({ API_KEY_LOOKUP_SECRET: shared, SESSION_SECRET: shared })),
    ).toThrow(/must not reuse the same value/);
  });

  it("rejects reuse across every pair of the four encryption secrets", () => {
    const names = [
      "PROVIDER_ENCRYPTION_KEY",
      "API_KEY_ENCRYPTION_KEY",
      "API_KEY_LOOKUP_SECRET",
      "SESSION_SECRET",
    ] as const;
    const shared = key();
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        expect(
          () => loadEnv(validEnv({ [names[i]!]: shared, [names[j]!]: shared })),
          `${names[i]} vs ${names[j]}`,
        ).toThrow(ConfigError);
      }
    }
  });

  it("accepts a correctly generated environment", () => {
    expect(() => loadEnv(validEnv())).not.toThrow();
  });

  it("does not compare the webhook secret as base64", () => {
    // PAKASIR_WEBHOOK_SECRET is an arbitrary string, not a key. It must not be
    // coerced through a base64 decode that could collide it with a real key.
    expect(() =>
      loadEnv(validEnv({ PAKASIR_WEBHOOK_SECRET: "pakasir-webhook-secret-value-2" })),
    ).not.toThrow();
  });

  it("rejects a webhook secret reused verbatim", () => {
    const shared = "shared-secret-at-least-16-chars";
    // Not base64-decodable to 32 bytes, so it is fingerprinted raw.
    expect(() =>
      loadEnv(validEnv({ PAKASIR_WEBHOOK_SECRET: shared, DATABASE_URL: "postgres://u@h/d" })),
    ).not.toThrow();
  });
});

describe("keyringFromEnv", () => {
  const ring = () => keyringFromEnv(loadEnv(validEnv()) as Env);

  it("gives every purpose distinct key material", () => {
    const keyring = ring();
    const hexes = (
      ["provider-credentials", "customer-api-key", "api-key-lookup", "session"] as const
    ).map((purpose) => Buffer.from(keyring.keyFor(purpose)).toString("hex"));
    expect(new Set(hexes).size).toBe(4);
  });

  it("returns 32 bytes for every purpose", () => {
    const keyring = ring();
    for (const purpose of [
      "provider-credentials",
      "customer-api-key",
      "api-key-lookup",
      "session",
    ] as const) {
      expect(keyring.keyFor(purpose), purpose).toHaveLength(32);
    }
  });

  it("reports the configured current version", () => {
    const keyring = keyringFromEnv(loadEnv(validEnv({ ENCRYPTION_KEY_VERSION: "4" })));
    expect(keyring.currentVersion).toBe(4);
  });

  it("defaults to version 1", () => {
    expect(ring().currentVersion).toBe(1);
  });

  it("serves the current version through keyForVersion", () => {
    const keyring = ring();
    expect(keyring.keyForVersion("session", 1)).toEqual(keyring.keyFor("session"));
  });

  it("refuses an unheld version loudly rather than falling back (§16)", () => {
    // A silent fallback to the current key would decrypt old rows with the wrong
    // key and report an authentication failure that looks like data corruption.
    const keyring = keyringFromEnv(loadEnv(validEnv({ ENCRYPTION_KEY_VERSION: "3" })));
    for (const version of [1, 2, 4, 99]) {
      expect(() => keyring.keyForVersion("session", version), `${version}`).toThrow(ConfigError);
    }
  });

  it("tells the operator to retain the retired key", () => {
    const keyring = keyringFromEnv(loadEnv(validEnv({ ENCRYPTION_KEY_VERSION: "2" })));
    try {
      keyring.keyForVersion("provider-credentials", 1);
      expect.unreachable("expected ConfigError");
    } catch (error) {
      expect((error as ConfigError).message).toMatch(/Retain the retired key/);
    }
  });

  it("names the purpose and version but no key material in the error (§17)", () => {
    const env = loadEnv(validEnv({ ENCRYPTION_KEY_VERSION: "2" }));
    const keyring = keyringFromEnv(env);
    try {
      keyring.keyForVersion("api-key-lookup", 1);
      expect.unreachable("expected ConfigError");
    } catch (error) {
      const text = (error as ConfigError).message;
      expect(text).toContain("api-key-lookup");
      expect(text).toContain("version 1");
      for (const secret of [
        env.PROVIDER_ENCRYPTION_KEY,
        env.API_KEY_ENCRYPTION_KEY,
        env.API_KEY_LOOKUP_SECRET,
        env.SESSION_SECRET,
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("is stable across calls, so a key does not change mid-request", () => {
    const keyring = ring();
    expect(keyring.keyFor("session")).toEqual(keyring.keyFor("session"));
  });
});
