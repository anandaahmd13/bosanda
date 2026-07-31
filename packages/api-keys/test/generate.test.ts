import { describe, expect, it } from "vitest";
import {
  KEY_LENGTH,
  KEY_TAG,
  PREFIX_BODY_CHARS,
  SECRET_BODY_CHARS,
  constantTimeEqual,
  generateApiKey,
  looksLikeApiKey,
  prefixOf,
} from "@bosanda/api-keys";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("generateApiKey", () => {
  it("produces the PLAN.md §12 format: bsk_ + 8-char prefix + 32-char secret", () => {
    const { plaintext, prefix } = generateApiKey();
    expect(plaintext).toMatch(/^bsk_[0-9A-HJKMNP-TV-Z]{40}$/);
    expect(plaintext).toHaveLength(KEY_LENGTH);
    expect(KEY_LENGTH).toBe(KEY_TAG.length + PREFIX_BODY_CHARS + SECRET_BODY_CHARS);
    expect(prefix).toHaveLength(KEY_TAG.length + PREFIX_BODY_CHARS);
    expect(plaintext.startsWith(prefix)).toBe(true);
  });

  it("excludes the ambiguous Crockford characters I, L, O and U", () => {
    // Read-aloud safety: a customer transcribing a key must not have to guess.
    for (let i = 0; i < 200; i += 1) {
      const { plaintext } = generateApiKey();
      const body = plaintext.slice(KEY_TAG.length);
      expect(body).not.toMatch(/[ILOU]/);
      for (const char of body) expect(ALPHABET.includes(char)).toBe(true);
    }
  });

  it("never repeats a key across many generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) seen.add(generateApiKey().plaintext);
    expect(seen.size).toBe(5_000);
  });

  it("draws symbols roughly uniformly across the alphabet", () => {
    // A modulo over a 32-symbol alphabet would still be uniform, but a bug that
    // truncated the byte or reused a nibble would show up as missing symbols.
    const counts = new Map<string, number>();
    for (let i = 0; i < 3_000; i += 1) {
      for (const char of generateApiKey().plaintext.slice(KEY_TAG.length)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(ALPHABET.length);
    const total = 3_000 * 40;
    const expected = total / ALPHABET.length;
    for (const [, count] of counts) {
      // Generous band: this asserts "no symbol is starved", not a chi-square fit.
      expect(count).toBeGreaterThan(expected * 0.7);
      expect(count).toBeLessThan(expected * 1.3);
    }
  });
});

describe("prefixOf", () => {
  it("agrees with the prefix returned by generateApiKey", () => {
    for (let i = 0; i < 100; i += 1) {
      const { plaintext, prefix } = generateApiKey();
      expect(prefixOf(plaintext)).toBe(prefix);
    }
  });

  it("is stable for a known key", () => {
    expect(prefixOf("bsk_A3F2K9QWZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe("bsk_A3F2K9QW");
  });
});

describe("looksLikeApiKey", () => {
  it("accepts a freshly generated key", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(looksLikeApiKey(generateApiKey().plaintext)).toBe(true);
    }
  });

  it("rejects the wrong tag, wrong length, and out-of-alphabet characters", () => {
    const good = generateApiKey().plaintext;
    expect(looksLikeApiKey(`sk_${good.slice(4)}`)).toBe(false);
    expect(looksLikeApiKey(good.slice(0, -1))).toBe(false);
    expect(looksLikeApiKey(`${good}A`)).toBe(false);
    // I, L, O, U are outside the Crockford alphabet.
    expect(looksLikeApiKey(`${good.slice(0, -1)}I`)).toBe(false);
    expect(looksLikeApiKey(`${good.slice(0, -1)}-`)).toBe(false);
    // Lowercase is not accepted; keys are emitted uppercase.
    expect(looksLikeApiKey(good.toLowerCase())).toBe(false);
  });

  it("rejects empty and obviously non-key input", () => {
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("bsk_")).toBe(false);
    expect(looksLikeApiKey("Bearer bsk_AAAAAAAA")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    const key = generateApiKey().plaintext;
    expect(constantTimeEqual(key, key)).toBe(true);
    expect(constantTimeEqual(key, `${key.slice(0, -1)}0`)).toBe(false);
  });

  it("returns false rather than throwing on a length mismatch", () => {
    // timingSafeEqual throws on unequal lengths; the wrapper must absorb that so the
    // exception path cannot be used as a length oracle.
    expect(() => constantTimeEqual("short", "much longer value")).not.toThrow();
    expect(constantTimeEqual("short", "much longer value")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("treats two empty strings as equal", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("compares by bytes, so multi-byte characters are handled", () => {
    expect(constantTimeEqual("kunci-é", "kunci-é")).toBe(true);
    expect(constantTimeEqual("kunci-é", "kunci-e")).toBe(false);
  });
});
