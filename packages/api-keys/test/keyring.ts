/**
 * Test keyring. Built by hand rather than via keyringFromEnv so a test can hold
 * several generations at once and exercise rotation, which the production
 * single-generation env keyring deliberately cannot.
 */

import type { SecretKeyring, SecretPurpose } from "@bosanda/config";

/** Deterministic 32-byte key material. Test-only; never a real key. */
export function testKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

export type TestKeyringOptions = {
  currentVersion?: number;
  /** version -> seed. Every listed version can be decrypted. */
  versions?: Record<number, number>;
};

export function testKeyring(options: TestKeyringOptions = {}): SecretKeyring {
  const currentVersion = options.currentVersion ?? 1;
  const versions = options.versions ?? { [currentVersion]: 1 };

  const keyOf = (purpose: SecretPurpose, seed: number): Uint8Array => {
    // Per-purpose separation, so a bug that reaches for the wrong purpose's key
    // fails the test rather than silently working.
    const offset = {
      "provider-credentials": 0,
      "customer-api-key": 1,
      "api-key-lookup": 2,
      session: 3,
    }[purpose];
    return testKey(seed * 10 + offset);
  };

  return {
    currentVersion,
    keyFor(purpose) {
      const seed = versions[currentVersion];
      if (seed === undefined)
        throw new Error(`test keyring has no current version ${currentVersion}`);
      return keyOf(purpose, seed);
    },
    keyForVersion(purpose, version) {
      const seed = versions[version];
      if (seed === undefined) throw new Error(`test keyring holds no key for version ${version}`);
      return keyOf(purpose, seed);
    },
  };
}
