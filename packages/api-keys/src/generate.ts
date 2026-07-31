/**
 * Customer API key generation (PLAN.md §12 "Customer API keys").
 *
 * Format:  bsk_<8-char public prefix><32-char secret>
 *
 * The `prefix` (the `bsk_` tag plus the first 8 characters) is stored in the clear so
 * the dashboard and the admin key search can identify a key without decrypting it, and
 * so an operator can correlate a customer report ("my key starting bsk_a3f2…") with a
 * row. The remaining 32 characters are the secret.
 *
 * ENTROPY: the body is 40 characters drawn from a 32-symbol alphabet = 200 bits total,
 * of which the 32 secret characters carry 160 bits. That is far beyond what an online
 * guessing attack against a rate-limited endpoint could reach, and it stays comfortable
 * even though the 40-bit prefix is public.
 *
 * The alphabet is Crockford base32 (no I, L, O, U) so a key is safe to read aloud,
 * transcribe, and paste without homoglyph confusion — the same reasoning as the ULID
 * implementation in @bosanda/shared.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Crockford base32: digits plus uppercase letters excluding I, L, O, U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const KEY_TAG = "bsk_";

/** Characters of the random body that are stored in the clear for identification. */
export const PREFIX_BODY_CHARS = 8;

/** Characters of the random body that constitute the secret. */
export const SECRET_BODY_CHARS = 32;

const BODY_CHARS = PREFIX_BODY_CHARS + SECRET_BODY_CHARS;

/** Full plaintext key length, including the tag. */
export const KEY_LENGTH = KEY_TAG.length + BODY_CHARS;

export type GeneratedKey = {
  /** The full plaintext key. Never persist or log this. */
  plaintext: string;
  /** Public identifier stored in the clear, e.g. "bsk_A3F2K9QW". */
  prefix: string;
};

/**
 * Draws `count` uniform symbols from ALPHABET.
 *
 * Rejection sampling rather than `byte % 32`: the alphabet is exactly 32 symbols, so
 * masking the low 5 bits is already uniform and no rejection is needed. Using a mask
 * (not a modulo) is what makes that true — a modulo over a non-power-of-two alphabet
 * would bias toward the early symbols.
 */
function randomSymbols(count: number): string {
  const bytes = randomBytes(count);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    // Non-null assertion avoided: index is provably in range, but the compiler
    // cannot know that under noUncheckedIndexedAccess.
    const byte = bytes[i] ?? 0;
    out += ALPHABET[byte & 0x1f] ?? "0";
  }
  return out;
}

/** Generates a fresh key. The plaintext exists only in memory and in the response. */
export function generateApiKey(): GeneratedKey {
  const body = randomSymbols(BODY_CHARS);
  const plaintext = `${KEY_TAG}${body}`;
  return {
    plaintext,
    prefix: `${KEY_TAG}${body.slice(0, PREFIX_BODY_CHARS)}`,
  };
}

/** Extracts the public prefix from a plaintext key, for lookup and display. */
export function prefixOf(plaintext: string): string {
  return plaintext.slice(0, KEY_TAG.length + PREFIX_BODY_CHARS);
}

/**
 * Shape validation only — says nothing about whether the key exists.
 *
 * Callers should still perform the full digest lookup even for a malformed key so the
 * rejection path costs roughly the same either way; this is a cheap pre-filter for
 * obviously-wrong input, not an authentication decision.
 */
export function looksLikeApiKey(candidate: string): boolean {
  if (candidate.length !== KEY_LENGTH) return false;
  if (!candidate.startsWith(KEY_TAG)) return false;
  for (let i = KEY_TAG.length; i < candidate.length; i += 1) {
    if (!ALPHABET.includes(candidate[i] ?? "")) return false;
  }
  return true;
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length via the
 * exception path, so unequal lengths are compared against a same-length buffer to keep
 * the work uniform before returning false.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still do a comparison of equal-length buffers so the timing profile does not
    // depend on which mismatch occurred.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
