/**
 * AWS binary EventStream (`vnd.amazon.eventstream`) decoder.
 *
 * PLAN.md §6 "EventStream decoder requirements" and §3 G2. This is the single
 * highest-risk parser in the project: it consumes attacker-adjacent bytes from
 * an upstream whose wire protocol is undocumented (§2 "Important support
 * status"), so every field is bounds-checked before it is trusted and every
 * fault fails CLOSED.
 *
 * Wire layout of one message (all integers big-endian):
 *
 *   +---------------------------------------------------------------+
 *   | total length (4) | headers length (4) | prelude CRC32 (4)     |  prelude
 *   +---------------------------------------------------------------+
 *   | headers (headers length bytes)                                |
 *   +---------------------------------------------------------------+
 *   | payload (total - 12 - headers length - 4 bytes)               |
 *   +---------------------------------------------------------------+
 *   | message CRC32 (4)  -- over bytes [0, total-4)                 |
 *   +---------------------------------------------------------------+
 *
 * Two ordering rules matter and are the reason the prelude CRC exists at all:
 *
 *  1. The prelude CRC is verified against the FIRST 8 BYTES ONLY, before
 *     `totalLength` is used for anything. A corrupted length field would
 *     otherwise make us wait for (or allocate against) a bogus frame size, and
 *     we would report that as a truncated stream instead of as corruption.
 *  2. `totalLength` is range-checked against a hard maximum immediately after
 *     the prelude CRC passes, so a well-formed-but-absurd prelude (which a
 *     hostile or broken upstream can produce, CRC and all) cannot drive
 *     unbounded buffering.
 *
 * The decoder is INCREMENTAL: `push()` accepts arbitrary chunk boundaries,
 * including one byte at a time, and returns only whole verified messages. It
 * holds at most `maxBufferedBytes` of an incomplete frame. Once any fault is
 * raised the instance is poisoned and every later call throws the same class of
 * error, so a caller that swallows one error cannot resynchronize onto attacker-
 * chosen byte offsets.
 *
 * No raw payload bytes are ever logged from here (§6, §17) — callers get the
 * decoded payload and are responsible for keeping it out of logs.
 */

/** Prelude is total length + headers length + prelude CRC. */
const PRELUDE_BYTES = 12;
/** Bytes of the prelude covered by the prelude CRC. */
const PRELUDE_CRC_COVERED = 8;
const MESSAGE_CRC_BYTES = 4;
/** Smallest legal message: prelude + trailing CRC, no headers, no payload. */
const MIN_MESSAGE_BYTES = PRELUDE_BYTES + MESSAGE_CRC_BYTES;

/**
 * Hard maximum frame size (§6, §16). Kiro assistant-response frames are small
 * (a text delta or a tool-input fragment); 16 MiB is orders of magnitude of
 * headroom while still bounding a single allocation.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Hard maximum buffered incomplete-frame size (§6). Strictly greater than
 * MAX_FRAME_BYTES: a legal maximum-size frame must still be assemblable from
 * small chunks, and a chunk may overshoot the frame boundary.
 */
export const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES + 1024 * 1024;

export type EventStreamDecoderOptions = {
  /** Override for tests; must be at least MIN_MESSAGE_BYTES. */
  maxFrameBytes?: number;
  /** Override for tests; must be at least maxFrameBytes. */
  maxBufferedBytes?: number;
};

/**
 * Fault classes. These are DISTINCT on purpose: §3 G2 requires proving that a
 * bad prelude CRC and a bad message CRC are both detected, and §17 counts
 * EventStream failures by kind so an operator can tell a flaky network
 * (`message_crc` on large frames) from a protocol change (`malformed_header`).
 */
export type EventStreamFaultKind =
  /** CRC over the first 8 prelude bytes did not match. */
  | "prelude_crc"
  /** CRC over the whole message did not match. */
  | "message_crc"
  /** Prelude passed CRC but declares a frame above the hard maximum. */
  | "frame_too_large"
  /** Buffered incomplete-frame bytes exceeded the hard maximum. */
  | "buffer_overflow"
  /** Stream ended with a partial frame still buffered. */
  | "truncated"
  /** Internally inconsistent lengths (headers longer than the frame, etc.). */
  | "malformed_prelude"
  /** Header block is truncated, or a header uses an unknown value type. */
  | "malformed_header"
  /** A push arrived after a previous fault poisoned the decoder. */
  | "poisoned";

export class EventStreamError extends Error {
  readonly kind: EventStreamFaultKind;

  constructor(kind: EventStreamFaultKind, detail: string) {
    // Detail describes SHAPE only (lengths, offsets, type tags) — never payload
    // bytes, so this message is safe to log as operator detail.
    super(`eventstream ${kind}: ${detail}`);
    this.name = "EventStreamError";
    this.kind = kind;
  }
}

// --- CRC32 (IEEE 802.3, reflected, poly 0xEDB88320) -------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/**
 * CRC32 of `bytes`, as an unsigned 32-bit number. `seed` lets a caller chain
 * chunks; the frame builder in the spike uses the same function so tests cannot
 * pass against a decoder-specific CRC bug.
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]!) & 0xff]!;
  }
  return ~crc >>> 0;
}

// --- Header values ----------------------------------------------------------

/** Header value type tags, per the EventStream header encoding. */
export const HEADER_TYPE = {
  booleanTrue: 0,
  booleanFalse: 1,
  byte: 2,
  short: 3,
  integer: 4,
  long: 5,
  byteArray: 6,
  string: 7,
  timestamp: 8,
  uuid: 9,
} as const;

export type EventStreamHeaderValue =
  | { type: "boolean"; value: boolean }
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "integer"; value: number }
  | { type: "long"; value: bigint }
  | { type: "byteArray"; value: Uint8Array }
  | { type: "string"; value: string }
  | { type: "timestamp"; value: Date }
  | { type: "uuid"; value: string };

export type EventStreamHeaders = Readonly<Record<string, EventStreamHeaderValue>>;

export type EventStreamMessage = {
  headers: EventStreamHeaders;
  /** Raw payload bytes. Never log these (§6 "No raw upstream payload"). */
  payload: Uint8Array;
  /** `:message-type` — "event", "exception", or "error" in practice. */
  messageType: string | null;
  /** `:event-type` — e.g. "assistantResponseEvent". */
  eventType: string | null;
  /** `:exception-type` — set on exception frames (§6). */
  exceptionType: string | null;
  contentType: string | null;
  /** Declared frame size, for metrics only. */
  totalLength: number;
};

/** Reads a string-typed header, or null when absent or not a string. */
export function headerString(message: EventStreamMessage, name: string): string | null {
  const header = message.headers[name];
  return header !== undefined && header.type === "string" ? header.value : null;
}

/** Decodes the payload as UTF-8 JSON. Returns null rather than throwing. */
export function payloadJson(message: EventStreamMessage): unknown {
  if (message.payload.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.payload)) as unknown;
  } catch {
    return null;
  }
}

// --- Byte queue -------------------------------------------------------------

/**
 * Growable FIFO over a single contiguous Buffer.
 *
 * Contiguity is a requirement, not a convenience: CRC32 and the header parser
 * both need a flat view, and a chunk-list representation would force a copy per
 * frame anyway. A read cursor plus compaction keeps amortized cost linear
 * instead of the O(n^2) that repeated `Buffer.concat` of the whole backlog
 * would produce on a byte-at-a-time stream.
 */
class ByteQueue {
  private buf: Buffer;
  private start = 0;
  private end = 0;

  constructor(initialCapacity = 16 * 1024) {
    this.buf = Buffer.allocUnsafe(initialCapacity);
  }

  get length(): number {
    return this.end - this.start;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const needed = this.length + chunk.byteLength;

    if (needed > this.buf.byteLength) {
      // Grow to the next power of two that fits, copying only live bytes.
      let capacity = this.buf.byteLength;
      while (capacity < needed) capacity *= 2;
      const grown = Buffer.allocUnsafe(capacity);
      this.buf.copy(grown, 0, this.start, this.end);
      this.buf = grown;
      this.end = this.length;
      this.start = 0;
    } else if (this.end + chunk.byteLength > this.buf.byteLength) {
      // Enough room overall, just not at the tail: slide live bytes to the front.
      this.buf.copy(this.buf, 0, this.start, this.end);
      this.end = this.length;
      this.start = 0;
    }

    this.buf.set(chunk, this.end);
    this.end += chunk.byteLength;
  }

  /** Big-endian uint32 at `offset` bytes past the read cursor. */
  readUint32(offset: number): number {
    return this.buf.readUInt32BE(this.start + offset);
  }

  /** Zero-copy view of `[offset, offset+length)` past the read cursor. */
  view(offset: number, length: number): Buffer {
    const from = this.start + offset;
    return this.buf.subarray(from, from + length);
  }

  /** Detached copy — safe to hand to a consumer that outlives the queue. */
  copyOut(offset: number, length: number): Uint8Array {
    return new Uint8Array(Uint8Array.prototype.slice.call(this.view(offset, length)));
  }

  discard(count: number): void {
    this.start += count;
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
  }
}

// --- Decoder ----------------------------------------------------------------

/**
 * Incremental decoder. Feed it network chunks; it returns whole verified
 * messages. Call `end()` when the upstream body completes to detect truncation.
 */
export class EventStreamDecoder {
  private readonly queue = new ByteQueue();
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private poison: EventStreamError | null = null;

  constructor(options: EventStreamDecoderOptions = {}) {
    const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    if (maxFrameBytes < MIN_MESSAGE_BYTES) {
      throw new EventStreamError(
        "malformed_prelude",
        `maxFrameBytes must be at least ${MIN_MESSAGE_BYTES}`,
      );
    }
    if (maxBufferedBytes < maxFrameBytes) {
      throw new EventStreamError(
        "buffer_overflow",
        "maxBufferedBytes must be at least maxFrameBytes",
      );
    }
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferedBytes = maxBufferedBytes;
  }

  /** Bytes currently held for an incomplete frame. Exposed for metrics/tests. */
  get buffered(): number {
    return this.queue.length;
  }

  /**
   * Appends a chunk and drains every complete message it completed.
   *
   * Chunk boundaries are irrelevant: a message may arrive one byte at a time,
   * several messages may arrive in one chunk, and a chunk may end mid-header.
   */
  push(chunk: Uint8Array): EventStreamMessage[] {
    this.assertUsable();
    try {
      this.queue.push(chunk);
      if (this.queue.length > this.maxBufferedBytes) {
        throw new EventStreamError(
          "buffer_overflow",
          `buffered ${this.queue.length} bytes exceeds maximum ${this.maxBufferedBytes}`,
        );
      }
      const messages: EventStreamMessage[] = [];
      for (;;) {
        const message = this.tryDecodeOne();
        if (message === null) break;
        messages.push(message);
      }
      return messages;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /**
   * Signals end of upstream body. Throws `truncated` when a partial frame is
   * still buffered — a stream that stops mid-frame is a failure, not a clean
   * finish, and silently dropping the remainder would look like a short turn.
   */
  end(): void {
    this.assertUsable();
    if (this.queue.length > 0) {
      throw this.fail(
        new EventStreamError(
          "truncated",
          `stream ended with ${this.queue.length} buffered bytes of an incomplete frame`,
        ),
      );
    }
  }

  private assertUsable(): void {
    if (this.poison !== null) {
      throw new EventStreamError("poisoned", `decoder already failed with ${this.poison.kind}`);
    }
  }

  /** Records the first fault so the decoder can never resynchronize. */
  private fail(error: unknown): unknown {
    if (error instanceof EventStreamError && this.poison === null) this.poison = error;
    return error;
  }

  /** Returns one message, or null when more bytes are needed. */
  private tryDecodeOne(): EventStreamMessage | null {
    if (this.queue.length < PRELUDE_BYTES) return null;

    const totalLength = this.queue.readUint32(0);
    const headersLength = this.queue.readUint32(4);
    const declaredPreludeCrc = this.queue.readUint32(8);

    // Verify the prelude BEFORE trusting either length (see file header, rule 1).
    const actualPreludeCrc = crc32(this.queue.view(0, PRELUDE_CRC_COVERED));
    if (actualPreludeCrc !== declaredPreludeCrc) {
      throw new EventStreamError(
        "prelude_crc",
        `declared 0x${declaredPreludeCrc.toString(16)} but computed 0x${actualPreludeCrc.toString(16)}`,
      );
    }

    // The prelude is authentic; now enforce the hard maximum (rule 2) before we
    // agree to wait for `totalLength` bytes.
    if (totalLength > this.maxFrameBytes) {
      throw new EventStreamError(
        "frame_too_large",
        `frame declares ${totalLength} bytes, maximum is ${this.maxFrameBytes}`,
      );
    }
    if (totalLength < MIN_MESSAGE_BYTES) {
      throw new EventStreamError(
        "malformed_prelude",
        `frame declares ${totalLength} bytes, minimum is ${MIN_MESSAGE_BYTES}`,
      );
    }
    if (headersLength > totalLength - MIN_MESSAGE_BYTES) {
      throw new EventStreamError(
        "malformed_prelude",
        `headers length ${headersLength} does not fit in a ${totalLength}-byte frame`,
      );
    }

    if (this.queue.length < totalLength) return null;

    const messageCrcOffset = totalLength - MESSAGE_CRC_BYTES;
    const declaredMessageCrc = this.queue.readUint32(messageCrcOffset);
    const actualMessageCrc = crc32(this.queue.view(0, messageCrcOffset));
    if (actualMessageCrc !== declaredMessageCrc) {
      throw new EventStreamError(
        "message_crc",
        `declared 0x${declaredMessageCrc.toString(16)} but computed 0x${actualMessageCrc.toString(16)} over ${messageCrcOffset} bytes`,
      );
    }

    const headers = parseHeaders(this.queue.view(PRELUDE_BYTES, headersLength));

    const payloadOffset = PRELUDE_BYTES + headersLength;
    const payloadLength = messageCrcOffset - payloadOffset;
    // Detached copy: the queue's backing buffer is reused for later frames.
    const payload = this.queue.copyOut(payloadOffset, payloadLength);

    this.queue.discard(totalLength);

    return {
      headers,
      payload,
      messageType: stringOf(headers[":message-type"]),
      eventType: stringOf(headers[":event-type"]),
      exceptionType: stringOf(headers[":exception-type"]),
      contentType: stringOf(headers[":content-type"]),
      totalLength,
    };
  }
}

function stringOf(header: EventStreamHeaderValue | undefined): string | null {
  return header !== undefined && header.type === "string" ? header.value : null;
}

/**
 * Parses the header block.
 *
 * Every read is preceded by a bounds check against the declared block length,
 * so a header claiming a 64 KiB string inside a 40-byte block fails rather than
 * reading into the payload. An unknown value type is fatal: its length is
 * unknown, so there is no safe way to skip it, and guessing would desynchronize
 * the rest of the block.
 */
function parseHeaders(block: Buffer): EventStreamHeaders {
  const headers: Record<string, EventStreamHeaderValue> = {};
  let offset = 0;

  const need = (bytes: number, what: string): void => {
    if (offset + bytes > block.byteLength) {
      throw new EventStreamError(
        "malformed_header",
        `${what} needs ${bytes} bytes at offset ${offset} of a ${block.byteLength}-byte header block`,
      );
    }
  };

  while (offset < block.byteLength) {
    need(1, "header name length");
    const nameLength = block.readUInt8(offset);
    offset += 1;

    if (nameLength === 0) {
      throw new EventStreamError("malformed_header", `zero-length header name at offset ${offset}`);
    }
    need(nameLength, "header name");
    const name = block.toString("utf8", offset, offset + nameLength);
    offset += nameLength;

    need(1, "header value type");
    const valueType = block.readUInt8(offset);
    offset += 1;

    switch (valueType) {
      case HEADER_TYPE.booleanTrue:
        headers[name] = { type: "boolean", value: true };
        break;
      case HEADER_TYPE.booleanFalse:
        headers[name] = { type: "boolean", value: false };
        break;
      case HEADER_TYPE.byte:
        need(1, "byte header");
        headers[name] = { type: "byte", value: block.readInt8(offset) };
        offset += 1;
        break;
      case HEADER_TYPE.short:
        need(2, "short header");
        headers[name] = { type: "short", value: block.readInt16BE(offset) };
        offset += 2;
        break;
      case HEADER_TYPE.integer:
        need(4, "integer header");
        headers[name] = { type: "integer", value: block.readInt32BE(offset) };
        offset += 4;
        break;
      case HEADER_TYPE.long:
        need(8, "long header");
        headers[name] = { type: "long", value: block.readBigInt64BE(offset) };
        offset += 8;
        break;
      case HEADER_TYPE.byteArray: {
        need(2, "byte-array header length");
        const length = block.readUInt16BE(offset);
        offset += 2;
        need(length, "byte-array header value");
        headers[name] = {
          type: "byteArray",
          value: new Uint8Array(
            Uint8Array.prototype.slice.call(block.subarray(offset, offset + length)),
          ),
        };
        offset += length;
        break;
      }
      case HEADER_TYPE.string: {
        need(2, "string header length");
        const length = block.readUInt16BE(offset);
        offset += 2;
        need(length, "string header value");
        headers[name] = { type: "string", value: block.toString("utf8", offset, offset + length) };
        offset += length;
        break;
      }
      case HEADER_TYPE.timestamp: {
        need(8, "timestamp header");
        const millis = block.readBigInt64BE(offset);
        offset += 8;
        headers[name] = { type: "timestamp", value: new Date(Number(millis)) };
        break;
      }
      case HEADER_TYPE.uuid: {
        need(16, "uuid header");
        const hex = block.toString("hex", offset, offset + 16);
        offset += 16;
        headers[name] = {
          type: "uuid",
          value: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        };
        break;
      }
      default:
        throw new EventStreamError(
          "malformed_header",
          `unknown header value type ${valueType} for header of ${nameLength} name bytes`,
        );
    }
  }

  return headers;
}

/**
 * Adapts a byte stream to an async iterable of messages.
 *
 * Backpressure reaches the upstream reader naturally (§3 G2): this generator
 * only pulls the next chunk after the consumer has taken every message the
 * previous chunk produced.
 */
export async function* decodeEventStream(
  source: AsyncIterable<Uint8Array>,
  options: EventStreamDecoderOptions = {},
): AsyncGenerator<EventStreamMessage> {
  const decoder = new EventStreamDecoder(options);
  for await (const chunk of source) {
    for (const message of decoder.push(chunk)) {
      yield message;
    }
  }
  decoder.end();
}
