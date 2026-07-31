/**
 * A test keyring.
 *
 * `keyringFromEnv` needs a full validated Env; this builds the four purpose
 * keys directly, with distinct bytes per purpose so a wrong-purpose lookup
 * produces a different digest and fails the test rather than passing silently.
 */

import type { SecretKeyring, SecretPurpose } from "@bosanda/config";

const OFFSET: Record<SecretPurpose, number> = {
  "provider-credentials": 0x10,
  "customer-api-key": 0x40,
  "api-key-lookup": 0x70,
  session: 0xa0,
};

function keyBytes(purpose: SecretPurpose, version: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (OFFSET[purpose] + i + version * 7) & 0xff;
  }
  return bytes;
}

export function testKeyring(currentVersion = 1, retainedVersions: number[] = [1]): SecretKeyring {
  const retained = new Set(retainedVersions);
  retained.add(currentVersion);

  return {
    currentVersion,
    keyFor(purpose) {
      return keyBytes(purpose, currentVersion);
    },
    keyForVersion(purpose, version) {
      if (!retained.has(version)) {
        throw new Error(`test keyring holds no key for version ${version}`);
      }
      return keyBytes(purpose, version);
    },
  };
}
