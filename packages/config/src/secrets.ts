/**
 * Secret material handling (PLAN.md §16).
 *
 * Encryption keys are versioned so they can be rotated without rewriting
 * historical ciphertext: each row records the version it was sealed with, and
 * the keyring can decrypt any version it still holds while encrypting only with
 * the current one.
 */

import { ConfigError, type Env } from "./env.js";

/**
 * Decodes a base64 32-byte secret into raw key bytes. Errors name the variable
 * but never include the value.
 *
 * The canonical-encoding check is not cosmetic. `Buffer.from(value, "base64")`
 * does not throw on invalid input — it silently DROPS characters outside the
 * base64 alphabet. So a value with a stray newline, a shell-mangled character, or
 * missing padding still decodes to 32 bytes, and decodes to the SAME 32 bytes as
 * the clean value. That turns two secrets an operator believes are different into
 * one key, which is precisely what §16 forbids. Re-encoding and comparing is the
 * cheapest way to insist the input was really base64.
 */
export function decodeSecret(name: string, value: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    throw new ConfigError([`${name} is not valid base64`]);
  }
  if (bytes.length !== 32) {
    throw new ConfigError([`${name} must decode to 32 bytes, got ${bytes.length}`]);
  }
  if (bytes.toString("base64") !== value) {
    throw new ConfigError([
      `${name} is not canonical base64 (stray characters, whitespace, or missing padding); ` +
        `generate with: openssl rand -base64 32`,
    ]);
  }
  return new Uint8Array(bytes);
}

export type SecretPurpose =
  "provider-credentials" | "customer-api-key" | "api-key-lookup" | "session";

export type SecretKeyring = {
  /** Version stamped onto newly written ciphertext. */
  readonly currentVersion: number;
  /** Key bytes for encrypting new data. */
  keyFor(purpose: SecretPurpose): Uint8Array;
  /**
   * Key bytes for decrypting existing data sealed at `version`. Throws when the
   * version is unknown, which is what makes a premature key removal loud rather
   * than silently corrupting reads.
   */
  keyForVersion(purpose: SecretPurpose, version: number): Uint8Array;
};

/**
 * Builds the keyring from validated env.
 *
 * Version 1 holds one generation per purpose. Adding a rotation means keeping
 * the previous generation available here (e.g. PROVIDER_ENCRYPTION_KEY_V1)
 * while ENCRYPTION_KEY_VERSION advances.
 */
export function keyringFromEnv(env: Env): SecretKeyring {
  const keys: Record<SecretPurpose, Uint8Array> = {
    "provider-credentials": decodeSecret("PROVIDER_ENCRYPTION_KEY", env.PROVIDER_ENCRYPTION_KEY),
    "customer-api-key": decodeSecret("API_KEY_ENCRYPTION_KEY", env.API_KEY_ENCRYPTION_KEY),
    "api-key-lookup": decodeSecret("API_KEY_LOOKUP_SECRET", env.API_KEY_LOOKUP_SECRET),
    session: decodeSecret("SESSION_SECRET", env.SESSION_SECRET),
  };

  const currentVersion = env.ENCRYPTION_KEY_VERSION;

  return {
    currentVersion,
    keyFor(purpose) {
      return keys[purpose];
    },
    keyForVersion(purpose, version) {
      if (version !== currentVersion) {
        throw new ConfigError([
          `no key available for ${purpose} version ${version}; ` +
            `current version is ${currentVersion}. Retain the retired key to decrypt old rows.`,
        ]);
      }
      return keys[purpose];
    },
  };
}
