import { randomBytes, randomUUID } from "node:crypto";

/** Crockford base32 alphabet: no I, L, O, U — safe to read aloud and to type. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Lexicographically sortable 26-char ID (ULID layout: 48-bit ms timestamp +
 * 80 bits of randomness). Used for database primary keys so index inserts stay
 * append-mostly, unlike random UUIDv4.
 */
export function ulid(now: number = Date.now()): string {
  let timestamp = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    timestamp = B32[remaining % 32]! + timestamp;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = randomBytes(10);
  let random = "";
  for (let i = 0; i < 16; i += 1) {
    // 16 chars x 5 bits = 80 bits, read from a 10-byte buffer.
    const bitOffset = i * 5;
    const byteIndex = bitOffset >>> 3;
    const shift = bitOffset & 7;
    const window = ((bytes[byteIndex]! << 8) | (bytes[byteIndex + 1] ?? 0)) >>> (11 - shift);
    random += B32[window & 31]!;
  }

  return timestamp + random;
}

/** Public request correlation ID. Appears in logs and usage rows. */
export function requestId(): string {
  return `req_${ulid().toLowerCase()}`;
}

/**
 * Tool call ID handed to clients. Anthropic clients expect `toolu_`-style
 * opaque IDs; keeping our own prefix makes provenance obvious in logs while
 * remaining opaque to the client.
 */
export function toolCallId(): string {
  return `toolu_${randomBytes(12).toString("base64url")}`;
}

/** Chat completion / message ID surfaced in responses. */
export function messageId(surface: "openai" | "anthropic"): string {
  const suffix = randomBytes(12).toString("base64url");
  return surface === "openai" ? `chatcmpl_${suffix}` : `msg_${suffix}`;
}

/** Upstream conversation ID. A fresh one per request — never reused (PLAN.md §6). */
export function conversationId(): string {
  return randomUUID();
}
