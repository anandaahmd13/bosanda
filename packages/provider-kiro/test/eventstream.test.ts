/**
 * EventStream decoder tests (PLAN.md §6 "EventStream decoder requirements",
 * §3 G2, §19 "Direct adapter").
 *
 * This is the highest-risk parser in the project, so the suite is adversarial
 * rather than illustrative. Two design choices worth stating:
 *
 *  1. CRC32 is proven by KNOWN-ANSWER vectors, not by round-tripping through the
 *     frame builder. The builder imports the decoder's `crc32`, so a round-trip
 *     test would pass even with a wrong polynomial. The vectors below are the
 *     standard published CRC-32/ISO-HDLC values, so the shared function is
 *     pinned to the real algorithm and the builder can then be trusted for
 *     framing.
 *  2. Chunk-boundary coverage is EXHAUSTIVE, not sampled: every single split
 *     offset of a two-frame stream is tested, which is what §19's "every chunk
 *     boundary" asks for.
 */

import { describe, expect, it } from "vitest";
import {
  crc32,
  decodeEventStream,
  EventStreamDecoder,
  EventStreamError,
  headerString,
  payloadJson,
  MAX_FRAME_BYTES,
} from "@bosanda/provider-kiro";
import {
  asStream,
  buildEventFrame,
  buildFrame,
  bytewise,
  chunk,
  corruptMessageCrc,
  corruptPayloadByte,
  corruptPreludeCrc,
  splitAt,
  withDeclaredHeadersLength,
  withDeclaredLength,
} from "../../../spikes/kiro-direct/src/frames.js";

const encoder = new TextEncoder();

const drainAll = (decoder: EventStreamDecoder, chunks: readonly Uint8Array[]) => {
  const out = [];
  for (const piece of chunks) out.push(...decoder.push(piece));
  return out;
};

describe("crc32", () => {
  // Standard CRC-32/ISO-HDLC known-answer vectors. These pin the shared CRC
  // function to the real algorithm; see the file header for why that matters.
  it("matches published vectors", () => {
    expect(crc32(encoder.encode(""))).toBe(0x00000000);
    expect(crc32(encoder.encode("a"))).toBe(0xe8b7be43);
    expect(crc32(encoder.encode("abc"))).toBe(0x352441c2);
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(encoder.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("is chainable via the seed, so a value can be computed across chunks", () => {
    const whole = crc32(encoder.encode("123456789"));
    const chained = crc32(encoder.encode("56789"), crc32(encoder.encode("1234")));
    expect(chained).toBe(whole);
  });
});

describe("well-formed frames", () => {
  it("decodes a single frame delivered in one chunk", () => {
    const decoder = new EventStreamDecoder();
    const messages = decoder.push(buildEventFrame("assistantResponseEvent", { content: "hello" }));
    decoder.end();

    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.messageType).toBe("event");
    expect(message.eventType).toBe("assistantResponseEvent");
    expect(message.contentType).toBe("application/json");
    expect(payloadJson(message)).toEqual({ content: "hello" });
  });

  it("decodes several frames arriving in one chunk", () => {
    const stream = Buffer.concat([
      buildEventFrame("assistantResponseEvent", { content: "a" }),
      buildEventFrame("assistantResponseEvent", { content: "b" }),
      buildEventFrame("messageStopEvent", { stopReason: "end_turn" }),
    ]);

    const decoder = new EventStreamDecoder();
    const messages = decoder.push(stream);
    decoder.end();

    expect(messages.map((m) => m.eventType)).toEqual([
      "assistantResponseEvent",
      "assistantResponseEvent",
      "messageStopEvent",
    ]);
  });

  it("decodes a frame with an empty payload and no headers", () => {
    const decoder = new EventStreamDecoder();
    const messages = decoder.push(buildFrame({}));
    decoder.end();

    expect(messages).toHaveLength(1);
    expect(messages[0]!.payload.byteLength).toBe(0);
    expect(messages[0]!.eventType).toBeNull();
    expect(payloadJson(messages[0]!)).toBeNull();
  });

  it("parses every header value type it supports", () => {
    const uuid = "0f9c1b2a-3d4e-5f60-8712-9a0b1c2d3e4f";
    const frame = buildFrame({
      ":event-type": "kitchenSink",
      flagTrue: { type: "boolean", value: true },
      flagFalse: { type: "boolean", value: false },
      tinyInt: { type: "byte", value: -7 },
      smallInt: { type: "short", value: -1234 },
      normalInt: { type: "integer", value: -123456 },
      bigInt: { type: "long", value: -1234567890123n },
      blob: { type: "byteArray", value: new Uint8Array([1, 2, 3, 255]) },
      when: { type: "timestamp", value: new Date("2026-01-02T03:04:05.678Z") },
      id: { type: "uuid", value: uuid },
    });

    const decoder = new EventStreamDecoder();
    const message = decoder.push(frame)[0]!;
    decoder.end();

    expect(headerString(message, ":event-type")).toBe("kitchenSink");
    expect(message.headers["flagTrue"]).toEqual({ type: "boolean", value: true });
    expect(message.headers["flagFalse"]).toEqual({ type: "boolean", value: false });
    expect(message.headers["tinyInt"]).toEqual({ type: "byte", value: -7 });
    expect(message.headers["smallInt"]).toEqual({ type: "short", value: -1234 });
    expect(message.headers["normalInt"]).toEqual({ type: "integer", value: -123456 });
    expect(message.headers["bigInt"]).toEqual({ type: "long", value: -1234567890123n });
    expect(message.headers["blob"]).toEqual({
      type: "byteArray",
      value: new Uint8Array([1, 2, 3, 255]),
    });
    expect(message.headers["when"]).toEqual({
      type: "timestamp",
      value: new Date("2026-01-02T03:04:05.678Z"),
    });
    expect(message.headers["id"]).toEqual({ type: "uuid", value: uuid });
  });

  it("preserves multi-byte UTF-8 in payload and headers", () => {
    const text = "halo dunia — ini ujian 🇮🇩";
    const decoder = new EventStreamDecoder();
    const message = decoder.push(buildEventFrame("assistantResponseEvent", { content: text }))[0]!;
    decoder.end();

    expect(payloadJson(message)).toEqual({ content: text });
  });

  it("returns detached payloads that survive later frames reusing the buffer", () => {
    const decoder = new EventStreamDecoder();
    const first = decoder.push(buildEventFrame("assistantResponseEvent", { content: "first" }))[0]!;
    const before = new Uint8Array(first.payload);

    for (let i = 0; i < 50; i += 1) {
      decoder.push(buildEventFrame("assistantResponseEvent", { content: `filler-${i}` }));
    }
    decoder.end();

    expect(first.payload).toEqual(before);
  });
});

describe("chunk boundaries", () => {
  it("reassembles a frame delivered one byte at a time", () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "byte-at-a-time" });
    const decoder = new EventStreamDecoder();
    const messages = drainAll(decoder, bytewise(frame));
    decoder.end();

    expect(messages).toHaveLength(1);
    expect(payloadJson(messages[0]!)).toEqual({ content: "byte-at-a-time" });
  });

  it("yields nothing until the final byte of a frame arrives", () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "x" });
    const decoder = new EventStreamDecoder();

    const [head, tail] = splitAt(frame, frame.byteLength - 1);
    expect(decoder.push(head)).toHaveLength(0);
    expect(decoder.buffered).toBe(frame.byteLength - 1);
    expect(decoder.push(tail)).toHaveLength(1);
    expect(decoder.buffered).toBe(0);
  });

  it("handles EVERY split offset of a two-frame stream", () => {
    const stream = Buffer.concat([
      buildEventFrame("assistantResponseEvent", { content: "alpha" }),
      buildEventFrame("messageStopEvent", { stopReason: "end_turn" }),
    ]);

    for (let offset = 0; offset <= stream.byteLength; offset += 1) {
      const decoder = new EventStreamDecoder();
      const [head, tail] = splitAt(stream, offset);
      const messages = drainAll(decoder, [head, tail]);
      decoder.end();

      expect(messages, `split at ${offset}`).toHaveLength(2);
      expect(payloadJson(messages[0]!)).toEqual({ content: "alpha" });
      expect(payloadJson(messages[1]!)).toEqual({ stopReason: "end_turn" });
    }
  });

  it("handles a range of fixed chunk sizes", () => {
    const stream = Buffer.concat(
      Array.from({ length: 6 }, (_unused, i) =>
        buildEventFrame("assistantResponseEvent", { content: `chunk-${i}` }),
      ),
    );

    for (const size of [1, 2, 3, 5, 7, 11, 13, 16, 31, 64, 127, 1024]) {
      const decoder = new EventStreamDecoder();
      const messages = drainAll(decoder, chunk(stream, size));
      decoder.end();
      expect(messages, `chunk size ${size}`).toHaveLength(6);
    }
  });

  it("tolerates empty chunks between frames", () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "gap" });
    const [head, tail] = splitAt(frame, 7);

    const decoder = new EventStreamDecoder();
    expect(decoder.push(new Uint8Array())).toHaveLength(0);
    expect(decoder.push(head)).toHaveLength(0);
    expect(decoder.push(new Uint8Array())).toHaveLength(0);
    expect(decoder.push(tail)).toHaveLength(1);
    decoder.end();
  });

  it("splits cleanly inside the prelude, the headers, and the payload", () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "boundaries" });
    const headersLength = frame.readUInt32BE(4);

    // 4 = mid-prelude, 12 = header start, 12+n = mid-headers, payload start.
    for (const offset of [4, 8, 11, 12, 12 + Math.floor(headersLength / 2), 12 + headersLength]) {
      const decoder = new EventStreamDecoder();
      const [head, tail] = splitAt(frame, offset);
      const messages = drainAll(decoder, [head, tail]);
      decoder.end();
      expect(messages, `offset ${offset}`).toHaveLength(1);
    }
  });
});

describe("CRC validation fails closed and distinguishes the two CRCs", () => {
  it("rejects a bad prelude CRC as prelude_crc", () => {
    const decoder = new EventStreamDecoder();
    try {
      decoder.push(corruptPreludeCrc(buildEventFrame("assistantResponseEvent", { content: "x" })));
      expect.unreachable("expected a prelude CRC failure");
    } catch (error) {
      expect(error).toBeInstanceOf(EventStreamError);
      expect((error as EventStreamError).kind).toBe("prelude_crc");
    }
  });

  it("rejects a bad message CRC as message_crc", () => {
    const decoder = new EventStreamDecoder();
    try {
      decoder.push(corruptMessageCrc(buildEventFrame("assistantResponseEvent", { content: "x" })));
      expect.unreachable("expected a message CRC failure");
    } catch (error) {
      expect((error as EventStreamError).kind).toBe("message_crc");
    }
  });

  it("catches a corrupted payload byte via the message CRC, with the prelude intact", () => {
    const decoder = new EventStreamDecoder();
    try {
      decoder.push(corruptPayloadByte(buildEventFrame("assistantResponseEvent", { content: "x" })));
      expect.unreachable("expected a message CRC failure");
    } catch (error) {
      // Not prelude_crc: the prelude was untouched, which is the whole point of
      // having two independent CRCs.
      expect((error as EventStreamError).kind).toBe("message_crc");
    }
  });

  it("detects a bad prelude CRC even when the frame arrives byte-at-a-time", () => {
    const corrupt = corruptPreludeCrc(buildEventFrame("assistantResponseEvent", { content: "x" }));
    const decoder = new EventStreamDecoder();

    expect(() => drainAll(decoder, bytewise(corrupt))).toThrow(EventStreamError);
  });

  it("reports the prelude CRC before waiting for a corrupted length", () => {
    // A frame whose length field is corrupted WITHOUT repairing the prelude CRC
    // must be reported as corruption, not as a truncated stream.
    const frame = buildEventFrame("assistantResponseEvent", { content: "x" });
    const mangled = Buffer.from(frame);
    mangled.writeUInt32BE(0x7fff_ffff, 0);

    const decoder = new EventStreamDecoder();
    try {
      decoder.push(mangled);
      expect.unreachable("expected a prelude CRC failure");
    } catch (error) {
      expect((error as EventStreamError).kind).toBe("prelude_crc");
    }
  });

  it("does not confuse the two CRCs on a zero-length payload frame", () => {
    expect(() => new EventStreamDecoder().push(corruptMessageCrc(buildFrame({})))).toThrow(
      /message_crc/,
    );
    expect(() => new EventStreamDecoder().push(corruptPreludeCrc(buildFrame({})))).toThrow(
      /prelude_crc/,
    );
  });
});

describe("size guards", () => {
  it("rejects an authentic prelude declaring more than the hard maximum", () => {
    // The prelude CRC is REPAIRED, so this cannot be caught as corruption — only
    // the explicit size guard stops it.
    const oversized = withDeclaredLength(
      buildEventFrame("assistantResponseEvent", { content: "x" }),
      MAX_FRAME_BYTES + 1,
    );

    const decoder = new EventStreamDecoder();
    try {
      decoder.push(oversized);
      expect.unreachable("expected a frame_too_large failure");
    } catch (error) {
      expect((error as EventStreamError).kind).toBe("frame_too_large");
    }
  });

  it("rejects an oversized declaration from the prelude alone, before buffering the body", () => {
    const oversized = withDeclaredLength(
      buildEventFrame("assistantResponseEvent", { content: "x" }),
      MAX_FRAME_BYTES + 1,
    );

    // Only the 12-byte prelude is delivered. The guard must fire now rather than
    // waiting for gigabytes that would never arrive.
    const decoder = new EventStreamDecoder();
    expect(() => decoder.push(oversized.subarray(0, 12))).toThrow(/frame_too_large/);
  });

  it("honours a lowered maxFrameBytes", () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "a".repeat(500) });
    // maxBufferedBytes is left generous on purpose. push() checks the buffered
    // ceiling BEFORE decoding, so a ceiling below the frame size would report
    // buffer_overflow and this test would pass without ever reaching the
    // frame-size guard it exists to cover.
    const decoder = new EventStreamDecoder({ maxFrameBytes: 128, maxBufferedBytes: 4096 });
    expect(() => decoder.push(frame)).toThrow(/frame_too_large/);
  });

  it("enforces the buffered-bytes ceiling so buffering is never unbounded", () => {
    // Reaching this guard needs a SINGLE oversized chunk, which is the only way
    // in: the constructor forces maxBufferedBytes >= maxFrameBytes, so a frame
    // assembled from small pieces always either completes or trips
    // frame_too_large first. A chunk overshooting the frame boundary by a wide
    // margin is what remains, and it is realistic — an HTTP body delivers
    // whatever the socket had ready.
    const decoder = new EventStreamDecoder({ maxFrameBytes: 2048, maxBufferedBytes: 4096 });

    expect(() => decoder.push(new Uint8Array(4097))).toThrow(/buffer_overflow/);
  });

  it("accepts a maximum-size frame assembled from small chunks", () => {
    // maxBufferedBytes must exceed maxFrameBytes, or a legal maximum-size frame
    // could never be reassembled.
    const payload = encoder.encode("z".repeat(3000));
    const frame = buildFrame({ ":event-type": "big" }, payload);
    const decoder = new EventStreamDecoder({
      maxFrameBytes: frame.byteLength,
      maxBufferedBytes: frame.byteLength + 1024,
    });

    const messages = drainAll(decoder, chunk(frame, 17));
    decoder.end();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.payload.byteLength).toBe(payload.byteLength);
  });

  it("rejects a construction whose buffer ceiling is below the frame ceiling", () => {
    expect(() => new EventStreamDecoder({ maxFrameBytes: 4096, maxBufferedBytes: 1024 })).toThrow(
      EventStreamError,
    );
  });

  it("rejects a frame declaring less than the minimum message size", () => {
    const runt = withDeclaredLength(buildFrame({}), 11);
    expect(() => new EventStreamDecoder().push(runt)).toThrow(/malformed_prelude/);
  });
});

describe("truncation and malformed structure", () => {
  it("reports truncation when the stream ends mid-frame", () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "cut short" });
    const decoder = new EventStreamDecoder();
    decoder.push(frame.subarray(0, frame.byteLength - 3));

    try {
      decoder.end();
      expect.unreachable("expected a truncated failure");
    } catch (error) {
      expect((error as EventStreamError).kind).toBe("truncated");
    }
  });

  it("reports truncation when only part of a prelude arrived", () => {
    const decoder = new EventStreamDecoder();
    decoder.push(buildFrame({}).subarray(0, 5));
    expect(() => decoder.end()).toThrow(/truncated/);
  });

  it("treats a clean end after a whole frame as success", () => {
    const decoder = new EventStreamDecoder();
    decoder.push(buildEventFrame("messageStopEvent", { stopReason: "end_turn" }));
    expect(() => decoder.end()).not.toThrow();
  });

  it("treats an empty stream as a clean end", () => {
    expect(() => new EventStreamDecoder().end()).not.toThrow();
  });

  it("rejects a headers length that does not fit the frame", () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "x" });
    const bad = withDeclaredHeadersLength(frame, frame.byteLength);
    expect(() => new EventStreamDecoder().push(bad)).toThrow(/malformed_prelude/);
  });

  it("rejects a truncated header block", () => {
    // Shrink the declared headers length so the last header runs past its end.
    const frame = buildEventFrame("assistantResponseEvent", { content: "x" });
    const headersLength = frame.readUInt32BE(4);
    const bad = Buffer.from(withDeclaredHeadersLength(frame, headersLength - 4));
    // Repair the message CRC so the header parser is what fails, not the CRC.
    bad.writeUInt32BE(crc32(bad.subarray(0, bad.byteLength - 4)), bad.byteLength - 4);

    expect(() => new EventStreamDecoder().push(bad)).toThrow(/malformed_header/);
  });

  it("rejects an unknown header value type rather than guessing its length", () => {
    // Header: 1-byte name "x", value type 99 (undefined).
    const headerBlock = Buffer.from([1, 0x78, 99]);
    const totalLength = 12 + headerBlock.byteLength + 4;
    const frame = Buffer.allocUnsafe(totalLength);
    frame.writeUInt32BE(totalLength, 0);
    frame.writeUInt32BE(headerBlock.byteLength, 4);
    frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
    frame.set(headerBlock, 12);
    frame.writeUInt32BE(crc32(frame.subarray(0, totalLength - 4)), totalLength - 4);

    expect(() => new EventStreamDecoder().push(frame)).toThrow(/malformed_header/);
  });

  it("rejects a zero-length header name", () => {
    const headerBlock = Buffer.from([0, 0]);
    const totalLength = 12 + headerBlock.byteLength + 4;
    const frame = Buffer.allocUnsafe(totalLength);
    frame.writeUInt32BE(totalLength, 0);
    frame.writeUInt32BE(headerBlock.byteLength, 4);
    frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
    frame.set(headerBlock, 12);
    frame.writeUInt32BE(crc32(frame.subarray(0, totalLength - 4)), totalLength - 4);

    expect(() => new EventStreamDecoder().push(frame)).toThrow(/malformed_header/);
  });

  it("returns null from payloadJson for a non-JSON payload instead of throwing", () => {
    const decoder = new EventStreamDecoder();
    const message = decoder.push(
      buildFrame({ ":event-type": "weird" }, encoder.encode("not json at all")),
    )[0]!;
    decoder.end();

    expect(payloadJson(message)).toBeNull();
  });

  it("returns null from payloadJson for invalid UTF-8", () => {
    const decoder = new EventStreamDecoder();
    const message = decoder.push(
      buildFrame({ ":event-type": "weird" }, new Uint8Array([0xff, 0xfe, 0xfd])),
    )[0]!;
    decoder.end();

    expect(payloadJson(message)).toBeNull();
  });
});

describe("poisoning", () => {
  it("refuses further work after a fault, so it cannot resynchronize", () => {
    const decoder = new EventStreamDecoder();
    expect(() => decoder.push(corruptMessageCrc(buildFrame({})))).toThrow(/message_crc/);

    // A caller that swallowed the first error must not be able to keep feeding
    // bytes at an attacker-chosen offset.
    expect(() => decoder.push(buildFrame({}))).toThrow(/poisoned/);
    expect(() => decoder.end()).toThrow(/poisoned/);
  });

  it("keeps reporting poisoned rather than the original kind on later calls", () => {
    const decoder = new EventStreamDecoder();
    expect(() => decoder.push(corruptPreludeCrc(buildFrame({})))).toThrow(/prelude_crc/);
    try {
      decoder.push(new Uint8Array([1, 2, 3]));
      expect.unreachable("expected poisoned");
    } catch (error) {
      expect((error as EventStreamError).kind).toBe("poisoned");
    }
  });
});

describe("decodeEventStream", () => {
  it("yields messages from an async byte stream", async () => {
    const stream = Buffer.concat([
      buildEventFrame("assistantResponseEvent", { content: "one" }),
      buildEventFrame("assistantResponseEvent", { content: "two" }),
      buildEventFrame("messageStopEvent", { stopReason: "end_turn" }),
    ]);

    const seen: (string | null)[] = [];
    for await (const message of decodeEventStream(asStream(bytewise(stream)))) {
      seen.push(message.eventType);
    }

    expect(seen).toEqual(["assistantResponseEvent", "assistantResponseEvent", "messageStopEvent"]);
  });

  it("throws on truncation at the end of the byte stream", async () => {
    const frame = buildEventFrame("assistantResponseEvent", { content: "x" });
    const iterate = async () => {
      for await (const _message of decodeEventStream(
        asStream([frame.subarray(0, frame.byteLength - 2)]),
      )) {
        // drain
      }
    };
    await expect(iterate()).rejects.toThrow(/truncated/);
  });

  it("stops pulling chunks once the consumer breaks (backpressure)", async () => {
    let produced = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (;;) {
        produced += 1;
        yield buildEventFrame("assistantResponseEvent", { content: `n-${produced}` });
      }
    }

    let consumed = 0;
    for await (const _message of decodeEventStream(source())) {
      consumed += 1;
      if (consumed === 3) break;
    }

    expect(consumed).toBe(3);
    // The generator must not have run ahead of the consumer.
    expect(produced).toBeLessThanOrEqual(4);
  });
});
