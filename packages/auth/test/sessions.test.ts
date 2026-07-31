import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { DAY_MS, fixedClock } from "@bosanda/shared";
import {
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_LIFETIME_MS,
  assertSessionValid,
  digestsMatch,
  evaluateSession,
  generateSessionToken,
  sessionDigest,
  startSession,
  type SessionRecord,
} from "../src/sessions.js";
import { testKeyring } from "./keyring.js";

const keyring = testKeyring();
const NOW = "2026-03-01T12:00:00.000Z";
const clock = fixedClock(NOW);

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const createdAt = new Date(NOW);
  return {
    id: "01JQ0000000000000000000000",
    userId: "01JQ1111111111111111111111",
    tokenHash: "a".repeat(64),
    expiresAt: new Date(createdAt.getTime() + SESSION_LIFETIME_MS),
    revokedAt: null,
    createdAt,
    lastUsedAt: createdAt,
    ...overrides,
  };
}

describe("generateSessionToken", () => {
  it("returns a plaintext token and its digest", () => {
    const token = generateSessionToken(keyring);
    expect(token.plaintext.length).toBeGreaterThanOrEqual(43);
    expect(token.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is url-safe, so it needs no encoding in a cookie", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateSessionToken(keyring).plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats across many tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(generateSessionToken(keyring).plaintext);
    expect(seen.size).toBe(2000);
  });

  it("produces a digest matching sessionDigest of its plaintext", () => {
    const token = generateSessionToken(keyring);
    expect(token.digest).toBe(sessionDigest(token.plaintext, keyring));
  });
});

describe("sessionDigest", () => {
  it("is deterministic", () => {
    expect(sessionDigest("abc", keyring)).toBe(sessionDigest("abc", keyring));
  });

  it("changes completely for a one-character difference", () => {
    const a = sessionDigest("token-a", keyring);
    const b = sessionDigest("token-b", keyring);
    expect(a).not.toBe(b);

    let differing = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differing += 1;
    // An avalanche should differ in far more than a handful of nibbles.
    expect(differing).toBeGreaterThan(a.length / 3);
  });

  it("is keyed: a different session key yields a different digest", () => {
    const other = testKeyring(2, [1, 2]);
    expect(sessionDigest("token", keyring)).not.toBe(sessionDigest("token", other));
  });

  it("never contains the token", () => {
    expect(sessionDigest("supersecrettoken", keyring)).not.toContain("supersecret");
  });

  it("is domain-separated from a bare HMAC of the token", async () => {
    const { createHmac } = await import("node:crypto");
    const bare = createHmac("sha256", keyring.keyFor("session")).update("token").digest("hex");
    expect(sessionDigest("token", keyring)).not.toBe(bare);
  });
});

describe("digestsMatch", () => {
  it("matches identical digests", () => {
    const digest = sessionDigest("x", keyring);
    expect(digestsMatch(digest, digest)).toBe(true);
  });

  it("rejects different digests", () => {
    expect(digestsMatch(sessionDigest("x", keyring), sessionDigest("y", keyring))).toBe(false);
  });

  it("rejects empty input rather than treating it as equal", () => {
    expect(digestsMatch("", "")).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(digestsMatch("aabb", "aa")).toBe(false);
  });
});

describe("evaluateSession", () => {
  it("accepts a fresh session", () => {
    const result = evaluateSession(session(), clock.now());
    expect(result.valid).toBe(true);
  });

  it("rejects an unknown session", () => {
    expect(evaluateSession(null, clock.now())).toEqual({ valid: false, reason: "unknown" });
  });

  it("rejects a revoked session even when unexpired", () => {
    const revoked = session({ revokedAt: new Date(NOW) });
    expect(evaluateSession(revoked, clock.now())).toEqual({ valid: false, reason: "revoked" });
  });

  it("rejects a session at exactly its expiry instant", () => {
    const now = new Date(NOW);
    const expired = session({ expiresAt: now });
    expect(evaluateSession(expired, now)).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a session past the idle timeout", () => {
    const createdAt = new Date(new Date(NOW).getTime() - 10 * DAY_MS);
    const idle = session({
      createdAt,
      lastUsedAt: createdAt,
      expiresAt: new Date(new Date(NOW).getTime() + DAY_MS),
    });
    expect(evaluateSession(idle, clock.now())).toEqual({ valid: false, reason: "idle" });
  });

  it("accepts a session used within the idle window", () => {
    const createdAt = new Date(new Date(NOW).getTime() - 10 * DAY_MS);
    const active = session({
      createdAt,
      lastUsedAt: new Date(new Date(NOW).getTime() - 1000),
      expiresAt: new Date(new Date(NOW).getTime() + DAY_MS),
    });
    expect(evaluateSession(active, clock.now()).valid).toBe(true);
  });

  it("falls back to createdAt when lastUsedAt is absent", () => {
    const createdAt = new Date(new Date(NOW).getTime() - SESSION_IDLE_TIMEOUT_MS - 1000);
    const record = session({
      createdAt,
      lastUsedAt: null,
      expiresAt: new Date(new Date(NOW).getTime() + DAY_MS),
    });
    expect(evaluateSession(record, clock.now())).toEqual({ valid: false, reason: "idle" });
  });

  it("checks revocation before expiry, since revocation is the stronger signal", () => {
    const both = session({
      revokedAt: new Date(NOW),
      expiresAt: new Date(new Date(NOW).getTime() - DAY_MS),
    });
    expect(evaluateSession(both, clock.now())).toEqual({ valid: false, reason: "revoked" });
  });
});

describe("assertSessionValid", () => {
  it("returns the session when valid", () => {
    const record = session();
    expect(assertSessionValid(evaluateSession(record, clock.now()))).toBe(record);
  });

  it.each(["unknown", "revoked", "expired", "idle"] as const)(
    "raises authentication_error for %s",
    (reason) => {
      try {
        assertSessionValid({ valid: false, reason });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(BosandaError);
        expect((error as BosandaError).code).toBe("authentication_error");
        // The reason stays operator-only. (The public message is a fixed string
        // from the frozen taxonomy and does not vary by reason — the following
        // test pins that.)
        expect((error as BosandaError).internalDetail).toContain(reason);
      }
    },
  );

  it("gives every rejection the same client-visible message", () => {
    const messages = new Set(
      (["unknown", "revoked", "expired", "idle"] as const).map((reason) => {
        try {
          assertSessionValid({ valid: false, reason });
          return "";
        } catch (error) {
          return (error as BosandaError).publicMessage;
        }
      }),
    );
    expect(messages.size).toBe(1);
  });
});

describe("startSession", () => {
  it("stamps createdAt from the clock and expiry a lifetime later", () => {
    const { record } = startSession("user-1", keyring, clock);
    expect(record.createdAt.toISOString()).toBe(NOW);
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBe(SESSION_LIFETIME_MS);
  });

  it("stores only the digest on the record, never the plaintext", () => {
    const { token, record } = startSession("user-1", keyring, clock);
    expect(record.tokenHash).toBe(token.digest);
    expect(JSON.stringify(record)).not.toContain(token.plaintext);
  });

  it("starts unrevoked and immediately valid", () => {
    const { record } = startSession("user-1", keyring, clock);
    expect(record.revokedAt).toBeNull();
    expect(evaluateSession({ id: "s", ...record }, clock.now()).valid).toBe(true);
  });

  it("issues a different token on each call, which is what rotation relies on", () => {
    const first = startSession("user-1", keyring, clock);
    const second = startSession("user-1", keyring, clock);
    expect(first.token.plaintext).not.toBe(second.token.plaintext);
    expect(first.record.tokenHash).not.toBe(second.record.tokenHash);
  });

  it("honours a custom lifetime", () => {
    const { record } = startSession("user-1", keyring, clock, DAY_MS);
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBe(DAY_MS);
  });
});
