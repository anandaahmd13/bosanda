/**
 * Synthetic AWS EventStream frame BUILDER (PLAN.md §3 G2, §19 "Direct adapter").
 *
 * The decoder in `@bosanda/provider-kiro` must be tested without live upstream
 * traffic, which M0 cannot supply in this environment. This builder produces
 * byte-exact frames with CORRECT CRC32s so the decoder suite exercises real
 * parsing rather than a mock.
 *
 * One deliberate coupling: `crc32` is IMPORTED from the decoder rather than
 * reimplemented. A second implementation would let a bug cancel out — a wrong
 * polynomial in both places produces frames the decoder happily accepts and no
 * test fails. Importing means the CRC logic itself is proven by the KNOWN-ANSWER
 * vectors in the test suite, and the builder proves only framing.
 *
 * The corruption helpers exist so tests can assert that a bad prelude CRC and a
 * bad message CRC are reported DISTINCTLY, which §3 G2 requires.
 */

import { crc32, HEADER_TYPE } from "@bosanda/provider-kiro";

export type FrameHeaderValue =
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "integer"; value: number }
  | { type: "long"; value: bigint }
  | { type: "byteArray"; value: Uint8Array }
  | { type: "timestamp"; value: Date }
  | { type: "uuid"; value: string };

/** A bare string is shorthand for a string-typed header. */
export type FrameHeaders = Record<string, FrameHeaderValue | string>;

const encoder = new TextEncoder();

function encodeHeaderValue(value: FrameHeaderValue): Buffer {
  switch (value.type) {
    case "boolean":
      return Buffer.of(value.value ? HEADER_TYPE.booleanTrue : HEADER_TYPE.booleanFalse);
    case "byte": {
      const out = Buffer.allocUnsafe(2);
      out.writeUInt8(HEADER_TYPE.byte, 0);
      out.writeInt8(value.value, 1);
      return out;
    }
    case "short": {
      const out = Buffer.allocUnsafe(3);
      out.writeUInt8(HEADER_TYPE.short, 0);
      out.writeInt16BE(value.value, 1);
      return out;
    }
    case "integer": {
      const out = Buffer.allocUnsafe(5);
      out.writeUInt8(HEADER_TYPE.integer, 0);
      out.writeInt32BE(value.value, 1);
      return out;
    }
    case "long": {
      const out = Buffer.allocUnsafe(9);
      out.writeUInt8(HEADER_TYPE.long, 0);
      out.writeBigInt64BE(value.value, 1);
      return out;
    }
    case "byteArray": {
      const out = Buffer.allocUnsafe(3 + value.value.byteLength);
      out.writeUInt8(HEADER_TYPE.byteArray, 0);
      out.writeUInt16BE(value.value.byteLength, 1);
      out.set(value.value, 3);
      return out;
    }
    case "string": {
      const bytes = encoder.encode(value.value);
      const out = Buffer.allocUnsafe(3 + bytes.byteLength);
      out.writeUInt8(HEADER_TYPE.string, 0);
      out.writeUInt16BE(bytes.byteLength, 1);
      out.set(bytes, 3);
      return out;
    }
    case "timestamp": {
      const out = Buffer.allocUnsafe(9);
      out.writeUInt8(HEADER_TYPE.timestamp, 0);
      out.writeBigInt64BE(BigInt(value.value.getTime()), 1);
      return out;
    }
    case "uuid": {
      const hex = value.value.replace(/-/g, "");
      const out = Buffer.allocUnsafe(17);
      out.writeUInt8(HEADER_TYPE.uuid, 0);
      out.set(Buffer.from(hex, "hex"), 1);
      return out;
    }
  }
}

export function encodeHeaders(headers: FrameHeaders): Buffer {
  const parts: Buffer[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    const value: FrameHeaderValue = typeof raw === "string" ? { type: "string", value: raw } : raw;
    const nameBytes = encoder.encode(name);
    const head = Buffer.allocUnsafe(1 + nameBytes.byteLength);
    head.writeUInt8(nameBytes.byteLength, 0);
    head.set(nameBytes, 1);
    parts.push(head, encodeHeaderValue(value));
  }
  return Buffer.concat(parts);
}

/**
 * Builds one complete, VALID frame.
 *
 * Layout: total length, headers length, prelude CRC (over the first 8 bytes),
 * headers, payload, message CRC (over everything but the last 4 bytes).
 */
export function buildFrame(headers: FrameHeaders, payload: Uint8Array = new Uint8Array()): Buffer {
  const headerBytes = encodeHeaders(headers);
  const totalLength = 12 + headerBytes.byteLength + payload.byteLength + 4;

  const frame = Buffer.allocUnsafe(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headerBytes.byteLength, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  frame.set(headerBytes, 12);
  frame.set(payload, 12 + headerBytes.byteLength);
  frame.writeUInt32BE(crc32(frame.subarray(0, totalLength - 4)), totalLength - 4);

  return frame;
}

/** Builds a frame whose payload is JSON, the shape Kiro events use. */
export function buildJsonFrame(headers: FrameHeaders, payload: unknown): Buffer {
  return buildFrame(headers, encoder.encode(JSON.stringify(payload)));
}

/**
 * Builds a Kiro-shaped `event` frame: `:message-type` = "event" plus an
 * `:event-type` naming the event family (§3 G2 "Expected event families").
 */
export function buildEventFrame(eventType: string, payload: unknown): Buffer {
  return buildJsonFrame(
    {
      ":message-type": "event",
      ":event-type": eventType,
      ":content-type": "application/json",
    },
    payload,
  );
}

/** Builds an upstream exception frame (§6 "Exception events map to ... errors"). */
export function buildExceptionFrame(exceptionType: string, payload: unknown = {}): Buffer {
  return buildJsonFrame(
    {
      ":message-type": "exception",
      ":exception-type": exceptionType,
      ":content-type": "application/json",
    },
    payload,
  );
}

// --- Corruption helpers -----------------------------------------------------

/**
 * Flips one bit in the prelude CRC field, so ONLY the prelude check fails.
 *
 * The `>>> 0` is load-bearing: `^` in JavaScript yields a SIGNED int32, so for
 * any CRC with its high bit set (about half of them) the xor is negative and
 * `writeUInt32BE` throws RangeError instead of corrupting the frame. That turns
 * a decoder test into a helper crash, and which frames trip it depends on the
 * payload — so it fails intermittently as fixtures change.
 */
export function corruptPreludeCrc(frame: Buffer): Buffer {
  const out = Buffer.from(frame);
  out.writeUInt32BE((out.readUInt32BE(8) ^ 0x0000_0001) >>> 0, 8);
  return out;
}

/** Flips one bit in the trailing message CRC, leaving the prelude valid. */
export function corruptMessageCrc(frame: Buffer): Buffer {
  const out = Buffer.from(frame);
  const at = out.byteLength - 4;
  out.writeUInt32BE((out.readUInt32BE(at) ^ 0x0000_0001) >>> 0, at);
  return out;
}

/**
 * Corrupts a PAYLOAD byte and leaves both CRCs stale, which is how a real
 * mid-stream corruption presents: the prelude still validates, the message CRC
 * does not.
 */
export function corruptPayloadByte(frame: Buffer, offsetFromPayload = 0): Buffer {
  const out = Buffer.from(frame);
  const headersLength = out.readUInt32BE(4);
  const at = 12 + headersLength + offsetFromPayload;
  if (at >= out.byteLength - 4) throw new Error("offset is past the payload");
  out[at] = (out[at] ?? 0) ^ 0xff;
  return out;
}

/**
 * Rewrites `totalLength` and repairs the prelude CRC, producing a frame whose
 * prelude is AUTHENTIC but whose declared size is absurd. This is what the
 * oversized-length guard has to catch: a plain corruption would be caught by the
 * prelude CRC first and never reach the size check.
 */
export function withDeclaredLength(frame: Buffer, totalLength: number): Buffer {
  const out = Buffer.from(frame);
  out.writeUInt32BE(totalLength, 0);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  return out;
}

/** Same, for `headersLength`, with the prelude CRC repaired. */
export function withDeclaredHeadersLength(frame: Buffer, headersLength: number): Buffer {
  const out = Buffer.from(frame);
  out.writeUInt32BE(headersLength, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  return out;
}

// --- Chunking helpers -------------------------------------------------------

/** Splits bytes into fixed-size chunks — the "arbitrary boundaries" case. */
export function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += size) {
    out.push(bytes.subarray(i, Math.min(i + size, bytes.byteLength)));
  }
  return out;
}

/** One chunk per byte — the pathological delivery pattern. */
export function bytewise(bytes: Uint8Array): Uint8Array[] {
  return chunk(bytes, 1);
}

/** Splits at exactly one offset, for targeting a specific field boundary. */
export function splitAt(bytes: Uint8Array, offset: number): [Uint8Array, Uint8Array] {
  return [bytes.subarray(0, offset), bytes.subarray(offset)];
}

/** Wraps chunks as an async iterable, as an HTTP body would arrive. */
export async function* asStream(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const item of chunks) {
    // Yield to the event loop so consumers exercise real async boundaries.
    await Promise.resolve();
    yield item;
  }
}
