import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { fixedClock } from "@bosanda/shared";
import {
  type RevealAuditEntry,
  type StoredApiKey,
  generateApiKey,
  maskKey,
  revealApiKey,
  seal,
} from "@bosanda/api-keys";
import { testKeyring } from "./keyring.js";

const keyring = testKeyring();
const NOW = new Date("2026-03-01T08:30:00.000Z");
const clock = fixedClock(NOW);

const actor = {
  userId: "user_01HZ",
  sessionId: "sess_01HZ",
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0",
} as const;

function recordingSink() {
  const entries: RevealAuditEntry[] = [];
  return {
    entries,
    sink: {
      record(entry: RevealAuditEntry) {
        entries.push(entry);
      },
    },
  };
}

function storedKey(overrides: Partial<StoredApiKey> = {}): {
  key: StoredApiKey;
  plaintext: string;
} {
  const { plaintext, prefix } = generateApiKey();
  return {
    plaintext,
    key: {
      id: "key_01HZ",
      prefix,
      ciphertext: seal(plaintext, keyring),
      revokedAt: null,
      ...overrides,
    },
  };
}

describe("maskKey", () => {
  it("shows only the tag and the first four prefix characters", () => {
    // §12 forbids logging a full prefix, and the prefix is a lookup handle.
    expect(maskKey("bsk_A3F2K9QW")).toBe(`bsk_A3F2${"•".repeat(4)}${"•".repeat(32)}`);
  });

  it("hides everything after the visible head", () => {
    const masked = maskKey("bsk_A3F2K9QW");
    expect(masked).not.toContain("K9QW");
    expect(masked.startsWith("bsk_A3F2")).toBe(true);
  });

  it("renders the same total length as a real key, so the UI does not shift on reveal", () => {
    expect(maskKey("bsk_A3F2K9QW")).toHaveLength(generateApiKey().plaintext.length);
  });

  it("needs no encryption key, so a dashboard list renders from the database alone", () => {
    // Purely a shape assertion: maskKey takes the stored prefix, never the ciphertext.
    expect(() => maskKey("bsk_A3F2K9QW")).not.toThrow();
  });

  it("tolerates a prefix passed without the tag", () => {
    expect(maskKey("A3F2K9QW")).toBe(maskKey("bsk_A3F2K9QW"));
  });
});

describe("revealApiKey", () => {
  it("returns the plaintext for an active key", async () => {
    const { key, plaintext } = storedKey();
    const { sink } = recordingSink();
    await expect(revealApiKey({ key, actor, keyring, clock, audit: sink })).resolves.toBe(
      plaintext,
    );
  });

  it("audits a successful reveal with the actor, session and clock time", async () => {
    const { key } = storedKey();
    const { entries, sink } = recordingSink();
    await revealApiKey({ key, actor, keyring, clock, audit: sink });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      action: "api_key.reveal",
      apiKeyId: "key_01HZ",
      userId: actor.userId,
      sessionId: actor.sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      at: NOW,
      outcome: "succeeded",
      reason: null,
    });
  });

  it("uses the injected clock rather than wall time", async () => {
    const { key } = storedKey();
    const { entries, sink } = recordingSink();
    await revealApiKey({ key, actor, keyring, clock, audit: sink });
    expect(entries[0]?.at).toEqual(NOW);
  });

  it("denies and audits a reveal of a revoked key", async () => {
    const { key } = storedKey({ revokedAt: new Date("2026-02-01T00:00:00.000Z") });
    const { entries, sink } = recordingSink();

    await expect(revealApiKey({ key, actor, keyring, clock, audit: sink })).rejects.toThrow(
      BosandaError,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("denied");
    expect(entries[0]?.reason).toBe("key is revoked");
  });

  it("audits a decryption failure instead of failing silently", async () => {
    const { key } = storedKey();
    const corrupted: StoredApiKey = { ...key, ciphertext: "v1.notavalidnonce.notavalidciphertext" };
    const { entries, sink } = recordingSink();

    await expect(
      revealApiKey({ key: corrupted, actor, keyring, clock, audit: sink }),
    ).rejects.toThrow(BosandaError);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.reason).toBeTruthy();
  });

  it("refuses when the ciphertext decrypts to a key that does not match the stored prefix", async () => {
    // An inconsistent row would show one key while metering another.
    const { key } = storedKey();
    const other = generateApiKey();
    const mismatched: StoredApiKey = { ...key, ciphertext: seal(other.plaintext, keyring) };
    const { entries, sink } = recordingSink();

    await expect(
      revealApiKey({ key: mismatched, actor, keyring, clock, audit: sink }),
    ).rejects.toThrow(/does not match its stored prefix/);
    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.reason).toBe("decrypted key does not match stored prefix");
  });

  it("fails the reveal when the audit write fails", async () => {
    // An unrecorded reveal is worse than a broken toggle.
    const { key } = storedKey();
    const failing = {
      record(): Promise<void> {
        return Promise.reject(new Error("audit store unavailable"));
      },
    };
    await expect(revealApiKey({ key, actor, keyring, clock, audit: failing })).rejects.toThrow(
      "audit store unavailable",
    );
  });

  it("writes the audit entry before returning the plaintext", async () => {
    const { key, plaintext } = storedKey();
    const order: string[] = [];
    const sink = {
      async record(): Promise<void> {
        await Promise.resolve();
        order.push("audited");
      },
    };
    const revealed = await revealApiKey({ key, actor, keyring, clock, audit: sink });
    order.push("returned");
    expect(revealed).toBe(plaintext);
    expect(order).toEqual(["audited", "returned"]);
  });

  it("never puts key material into the audit entry", async () => {
    const { key, plaintext } = storedKey();
    const { entries, sink } = recordingSink();
    await revealApiKey({ key, actor, keyring, clock, audit: sink });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(plaintext.slice(4));
    expect(serialized).not.toContain(key.ciphertext);
  });

  it("accepts a null ip and user agent", async () => {
    const { key } = storedKey();
    const { entries, sink } = recordingSink();
    await revealApiKey({
      key,
      actor: { ...actor, ip: null, userAgent: null },
      keyring,
      clock,
      audit: sink,
    });
    expect(entries[0]?.ip).toBeNull();
    expect(entries[0]?.userAgent).toBeNull();
  });

  it("reveals a key sealed under a retired generation after rotation", async () => {
    const { plaintext, prefix } = generateApiKey();
    const before = testKeyring({ currentVersion: 1, versions: { 1: 1 } });
    const key: StoredApiKey = {
      id: "key_old",
      prefix,
      ciphertext: seal(plaintext, before),
      revokedAt: null,
    };
    const after = testKeyring({ currentVersion: 2, versions: { 1: 1, 2: 2 } });
    const { sink } = recordingSink();

    await expect(revealApiKey({ key, actor, keyring: after, clock, audit: sink })).resolves.toBe(
      plaintext,
    );
  });
});
