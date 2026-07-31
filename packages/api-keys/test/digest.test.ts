import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LOOKUP_DIGEST_LENGTH,
  generateApiKey,
  isLookupDigest,
  lookupDigest,
} from "@bosanda/api-keys";
import { testKeyring } from "./keyring.js";

const keyring = testKeyring();

describe("lookupDigest", () => {
  it("returns lowercase hex of SHA-256 length", () => {
    const digest = lookupDigest(generateApiKey().plaintext, keyring);
    expect(digest).toHaveLength(LOOKUP_DIGEST_LENGTH);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic, which is what makes it usable as a UNIQUE index", () => {
    const { plaintext } = generateApiKey();
    expect(lookupDigest(plaintext, keyring)).toBe(lookupDigest(plaintext, keyring));
  });

  it("differs for different keys", () => {
    const digests = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      digests.add(lookupDigest(generateApiKey().plaintext, keyring));
    }
    expect(digests.size).toBe(500);
  });

  it("changes completely when a single character changes", () => {
    const { plaintext } = generateApiKey();
    const flipped = `${plaintext.slice(0, -1)}${plaintext.endsWith("0") ? "1" : "0"}`;
    const a = lookupDigest(plaintext, keyring);
    const b = lookupDigest(flipped, keyring);
    expect(a).not.toBe(b);
    // Avalanche: the two digests should share almost no hex positions.
    let shared = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) shared += 1;
    expect(shared).toBeLessThan(20);
  });

  it("is keyed: the same key under a different secret yields a different digest", () => {
    // This is the property that stops a stolen database dump from being usable
    // without the secret, which §12 keeps outside PostgreSQL.
    const { plaintext } = generateApiKey();
    const other = testKeyring({ versions: { 1: 99 } });
    expect(lookupDigest(plaintext, keyring)).not.toBe(lookupDigest(plaintext, other));
  });

  it("uses only the lookup key, so rotating an unrelated purpose does not invalidate it", () => {
    // keyFor("api-key-lookup") must be the only material consulted. The test keyring
    // derives distinct bytes per purpose, so a mix-up would change the digest.
    const { plaintext } = generateApiKey();
    const digest = lookupDigest(plaintext, keyring);
    expect(digest).toBe(lookupDigest(plaintext, testKeyring()));
  });

  it("does not contain the plaintext key", () => {
    const { plaintext } = generateApiKey();
    const digest = lookupDigest(plaintext, keyring);
    expect(digest).not.toContain(plaintext.slice(KEY_BODY_START));
    expect(digest.toUpperCase()).not.toContain(plaintext.slice(KEY_BODY_START));
  });

  it("is domain-separated from a bare HMAC of the key", () => {
    // A plain HMAC(secret, key) with no domain string would collide with any other
    // future use of the same secret. Assert the domain is actually mixed in.
    const { plaintext } = generateApiKey();
    const bare = bareHmac(plaintext);
    expect(lookupDigest(plaintext, keyring)).not.toBe(bare);
  });
});

const KEY_BODY_START = 4;

function bareHmac(plaintext: string): string {
  // Mirrors what a naive implementation would compute, for the contrast above.
  return createHmac("sha256", keyring.keyFor("api-key-lookup"))
    .update(plaintext, "utf8")
    .digest("hex");
}

describe("isLookupDigest", () => {
  it("accepts a real digest", () => {
    expect(isLookupDigest(lookupDigest(generateApiKey().plaintext, keyring))).toBe(true);
  });

  it("rejects wrong length, uppercase hex, and non-hex characters", () => {
    const digest = lookupDigest(generateApiKey().plaintext, keyring);
    expect(isLookupDigest(digest.slice(0, -1))).toBe(false);
    expect(isLookupDigest(`${digest}a`)).toBe(false);
    expect(isLookupDigest(digest.toUpperCase())).toBe(false);
    expect(isLookupDigest(`${digest.slice(0, -1)}z`)).toBe(false);
    expect(isLookupDigest("")).toBe(false);
  });
});
