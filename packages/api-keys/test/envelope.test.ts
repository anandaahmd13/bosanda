import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { envelopeVersion, generateApiKey, open, seal } from "@bosanda/api-keys";
import { testKeyring } from "./keyring.js";

const keyring = testKeyring();

function parts(envelope: string): [string, string, string] {
  const split = envelope.split(".");
  return [split[0] ?? "", split[1] ?? "", split[2] ?? ""];
}

function flipFirstByte(base64url: string): string {
  const bytes = Buffer.from(base64url, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString("base64url");
}

describe("seal / open", () => {
  it("roundtrips a key", () => {
    const { plaintext } = generateApiKey();
    expect(open(seal(plaintext, keyring), keyring)).toBe(plaintext);
  });

  it("roundtrips many keys", () => {
    for (let i = 0; i < 200; i += 1) {
      const { plaintext } = generateApiKey();
      expect(open(seal(plaintext, keyring), keyring)).toBe(plaintext);
    }
  });

  it("stamps the current key version", () => {
    const envelope = seal(
      generateApiKey().plaintext,
      testKeyring({ currentVersion: 3, versions: { 3: 1 } }),
    );
    expect(parts(envelope)[0]).toBe("v3");
    expect(envelopeVersion(envelope)).toBe(3);
  });

  it("uses a fresh 24-byte nonce per seal, so identical keys seal differently", () => {
    // Determinism here would let anyone with read access to the table tell whether two
    // rows hold the same key.
    const { plaintext } = generateApiKey();
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const [, nonce, ciphertext] = parts(seal(plaintext, keyring));
      expect(Buffer.from(nonce, "base64url")).toHaveLength(24);
      nonces.add(nonce);
      ciphertexts.add(ciphertext);
    }
    expect(nonces.size).toBe(500);
    expect(ciphertexts.size).toBe(500);
  });

  it("never leaks the plaintext into the serialized form", () => {
    const { plaintext } = generateApiKey();
    const envelope = seal(plaintext, keyring);
    const body = plaintext.slice(4);
    expect(envelope).not.toContain(plaintext);
    expect(envelope).not.toContain(body);
    // Nor in any common re-encoding of it.
    expect(envelope).not.toContain(Buffer.from(plaintext).toString("base64url"));
    expect(envelope.toUpperCase()).not.toContain(body);
  });

  it("carries the Poly1305 tag, so ciphertext is 16 bytes longer than the plaintext", () => {
    const { plaintext } = generateApiKey();
    const [, , ciphertext] = parts(seal(plaintext, keyring));
    expect(Buffer.from(ciphertext, "base64url")).toHaveLength(Buffer.byteLength(plaintext) + 16);
  });

  it("handles a non-ASCII payload byte-exactly", () => {
    // Not a real key shape, but the envelope must not corrupt UTF-8 if it is ever
    // reused for another secret.
    const value = "kunci-rahasia-é-日本語";
    expect(open(seal(value, keyring), keyring)).toBe(value);
  });

  it("handles an empty payload", () => {
    expect(open(seal("", keyring), keyring)).toBe("");
  });
});

describe("open failure modes", () => {
  it("fails closed on a tampered ciphertext", () => {
    const [version, nonce, ciphertext] = parts(seal(generateApiKey().plaintext, keyring));
    const tampered = `${version}.${nonce}.${flipFirstByte(ciphertext)}`;
    expect(() => open(tampered, keyring)).toThrow(BosandaError);
  });

  it("fails closed on a tampered nonce", () => {
    const [version, nonce, ciphertext] = parts(seal(generateApiKey().plaintext, keyring));
    const tampered = `${version}.${flipFirstByte(nonce)}.${ciphertext}`;
    expect(() => open(tampered, keyring)).toThrow(BosandaError);
  });

  it("fails closed on a truncated tag", () => {
    const [version, nonce, ciphertext] = parts(seal(generateApiKey().plaintext, keyring));
    const bytes = Buffer.from(ciphertext, "base64url").subarray(0, -1);
    expect(() => open(`${version}.${nonce}.${bytes.toString("base64url")}`, keyring)).toThrow(
      BosandaError,
    );
  });

  it("fails closed under a different key", () => {
    const envelope = seal(generateApiKey().plaintext, keyring);
    const wrong = testKeyring({ versions: { 1: 77 } });
    expect(() => open(envelope, wrong)).toThrow(BosandaError);
  });

  it("rejects a nonce of the wrong length rather than letting the cipher decide", () => {
    const [version, , ciphertext] = parts(seal(generateApiKey().plaintext, keyring));
    const short = Buffer.alloc(12).toString("base64url");
    expect(() => open(`${version}.${short}.${ciphertext}`, keyring)).toThrow(
      /nonce must be 24 bytes/,
    );
  });

  it("rejects malformed framing", () => {
    expect(() => open("", keyring)).toThrow(/malformed/);
    expect(() => open("not-an-envelope", keyring)).toThrow(/malformed/);
    expect(() => open("v1.onlytwo", keyring)).toThrow(/malformed/);
    expect(() => open("v1.a.b.c", keyring)).toThrow(/malformed/);
    expect(() => open("1.a.b", keyring)).toThrow(/bad version tag/);
  });

  it("rejects a non-numeric or non-positive version", () => {
    expect(() => open("vx.a.b", keyring)).toThrow(/invalid key version/);
    expect(() => open("v0.a.b", keyring)).toThrow(/invalid key version/);
    expect(() => open("v-1.a.b", keyring)).toThrow(/invalid key version/);
  });

  it("reports a missing key generation loudly instead of trying the current key", () => {
    // The silent-wrong-key path is the dangerous one: it would surface as a confusing
    // authentication failure much later. §16 requires this to be loud.
    const v1 = testKeyring({ currentVersion: 1, versions: { 1: 1 } });
    const envelope = seal(generateApiKey().plaintext, v1);
    const v2Only = testKeyring({ currentVersion: 2, versions: { 2: 2 } });
    expect(() => open(envelope, v2Only)).toThrow(/holds no key for version 1/);
  });

  it("never includes key material in the thrown error", () => {
    const { plaintext } = generateApiKey();
    const [version, nonce, ciphertext] = parts(seal(plaintext, keyring));
    const tampered = `${version}.${nonce}.${flipFirstByte(ciphertext)}`;
    try {
      open(tampered, keyring);
      expect.unreachable("open should have thrown");
    } catch (error) {
      const message =
        error instanceof Error ? `${error.message}${error.stack ?? ""}` : String(error);
      expect(message).not.toContain(plaintext);
      expect(message).not.toContain(plaintext.slice(4));
      expect(message).not.toContain(ciphertext);
      expect(message).not.toContain(nonce);
    }
  });
});

describe("key rotation", () => {
  it("decrypts an old generation while sealing new data with the current one", () => {
    const { plaintext } = generateApiKey();
    const before = testKeyring({ currentVersion: 1, versions: { 1: 1 } });
    const old = seal(plaintext, before);

    // Operator rotates: version 2 becomes current, version 1 is retained for reads.
    const after = testKeyring({ currentVersion: 2, versions: { 1: 1, 2: 2 } });
    expect(open(old, after)).toBe(plaintext);

    const fresh = seal(plaintext, after);
    expect(envelopeVersion(fresh)).toBe(2);
    expect(open(fresh, after)).toBe(plaintext);
    // The two envelopes are not interchangeable ciphertext.
    expect(parts(fresh)[2]).not.toBe(parts(old)[2]);
  });

  it("a re-sealed key still decrypts to the same plaintext", () => {
    const { plaintext } = generateApiKey();
    const after = testKeyring({ currentVersion: 2, versions: { 1: 1, 2: 2 } });
    const resealed = seal(open(seal(plaintext, testKeyring()), testKeyring()), after);
    expect(open(resealed, after)).toBe(plaintext);
  });
});

describe("envelopeVersion", () => {
  it("reads the version without needing a key", () => {
    expect(envelopeVersion(seal("x", keyring))).toBe(1);
  });

  it("returns null for anything unparseable", () => {
    expect(envelopeVersion("")).toBeNull();
    expect(envelopeVersion("1.a.b")).toBeNull();
    expect(envelopeVersion("vx.a.b")).toBeNull();
    expect(envelopeVersion("v0.a.b")).toBeNull();
  });
});
