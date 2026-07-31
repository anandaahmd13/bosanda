import { beforeEach, describe, expect, it, vi } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { fixedClock } from "@bosanda/shared";
import {
  MIN_RESET_REASON_LENGTH,
  RESET_OPERATOR_WARNING,
  resetPasswordAsAdmin,
  type AdminActor,
  type ResetAuditEntry,
} from "../src/recovery.js";
import { verifyPassword } from "../src/passwords.js";

const NEW_PASSWORD = "a replacement passphrase";
const REASON = "user called support line, identity verified against order 01JQ";
const clock = fixedClock("2026-04-02T11:30:00.000Z");

function admin(overrides: Partial<AdminActor> = {}): AdminActor {
  return {
    userId: "01JQADMIN000000000000000000",
    role: "admin",
    sessionId: "01JQSESSION0000000000000000",
    ip: "203.0.113.9",
    userAgent: "Mozilla/5.0",
    ...overrides,
  };
}

/**
 * Records the order of store and audit calls, because §12's guarantee is about
 * sequencing: the sessions must be gone before the reset is reported done.
 */
function harness() {
  const calls: string[] = [];
  const entries: ResetAuditEntry[] = [];
  let storedHash: string | null = null;

  return {
    calls,
    entries,
    get storedHash() {
      return storedHash;
    },
    store: {
      setPasswordHash: vi.fn(async (_userId: string, passwordHash: string, _at: Date) => {
        calls.push("setPasswordHash");
        storedHash = passwordHash;
      }),
      revokeAllSessions: vi.fn(async (_userId: string, _at: Date) => {
        calls.push("revokeAllSessions");
        return 3;
      }),
    },
    audit: {
      record: vi.fn(async (entry: ResetAuditEntry) => {
        calls.push(`audit:${entry.outcome}`);
        entries.push(entry);
      }),
    },
  };
}

describe("resetPasswordAsAdmin", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it("stores a hash of the new password", async () => {
    await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.storedHash).not.toBeNull();
    expect(h.storedHash?.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(NEW_PASSWORD, h.storedHash as string)).resolves.toBe(true);
  });

  it("never stores the plaintext password", async () => {
    await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.storedHash).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(h.entries)).not.toContain(NEW_PASSWORD);
  });

  it("revokes every session and reports the count", async () => {
    const result = await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.store.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(result.revokedSessionCount).toBe(3);
  });

  it("changes the password before revoking sessions", async () => {
    // Reversed, there is a window where the old password no longer works but a
    // stolen cookie still does.
    await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.calls).toEqual(["setPasswordHash", "revokeAllSessions", "audit:succeeded"]);
  });

  it("writes the audit row before returning", async () => {
    await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.calls.at(-1)).toBe("audit:succeeded");
  });

  it("records actor, target, reason, and timestamp", async () => {
    await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.entries).toEqual([
      {
        action: "user.password_reset",
        actorType: "admin",
        actorId: "01JQADMIN000000000000000000",
        actorSessionId: "01JQSESSION0000000000000000",
        targetUserId: "01JQUSER0000000000000000000",
        reason: REASON,
        ip: "203.0.113.9",
        userAgent: "Mozilla/5.0",
        at: new Date("2026-04-02T11:30:00.000Z"),
        revokedSessionCount: 3,
        outcome: "succeeded",
      },
    ]);
  });

  it("trims the reason it records", async () => {
    await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: `   ${REASON}   `,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.entries[0]?.reason).toBe(REASON);
  });

  it("stamps the same instant on the write, the revocation, and the audit", async () => {
    const result = await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    const at = new Date("2026-04-02T11:30:00.000Z");
    expect(result.at).toEqual(at);
    expect(h.store.setPasswordHash.mock.calls[0]?.[2]).toEqual(at);
    expect(h.store.revokeAllSessions.mock.calls[0]?.[1]).toEqual(at);
    expect(h.entries[0]?.at).toEqual(at);
  });

  it("refuses a non-admin actor", async () => {
    await expect(
      resetPasswordAsAdmin({
        actor: admin({ role: "customer" }),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: REASON,
        store: h.store,
        audit: h.audit,
        clock,
      }),
    ).rejects.toMatchObject({ code: "authentication_error" });
  });

  it("touches nothing when the actor is not an admin", async () => {
    await resetPasswordAsAdmin({
      actor: admin({ role: "customer" }),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    }).catch(() => undefined);

    expect(h.store.setPasswordHash).not.toHaveBeenCalled();
    expect(h.store.revokeAllSessions).not.toHaveBeenCalled();
  });

  it("audits a denied attempt by a non-admin", async () => {
    // A customer reaching this call is a finding in itself; it must leave a
    // trace rather than failing silently.
    await resetPasswordAsAdmin({
      actor: admin({ role: "customer" }),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    }).catch(() => undefined);

    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({
      outcome: "denied",
      revokedSessionCount: 0,
      targetUserId: "01JQUSER0000000000000000000",
    });
  });

  it("keeps the denial detail internal", async () => {
    try {
      await resetPasswordAsAdmin({
        actor: admin({ role: "customer" }),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: REASON,
        store: h.store,
        audit: h.audit,
        clock,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as BosandaError;
      expect(err.internalDetail).toContain("non-admin");
      expect(err.publicMessage).not.toContain("non-admin");
    }
  });

  it("requires a reason", async () => {
    await expect(
      resetPasswordAsAdmin({
        actor: admin(),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: "",
        store: h.store,
        audit: h.audit,
        clock,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects a reason that is only whitespace", async () => {
    await expect(
      resetPasswordAsAdmin({
        actor: admin(),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: " ".repeat(40),
        store: h.store,
        audit: h.audit,
        clock,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects a reason below the minimum length", async () => {
    await expect(
      resetPasswordAsAdmin({
        actor: admin(),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: "x".repeat(MIN_RESET_REASON_LENGTH - 1),
        store: h.store,
        audit: h.audit,
        clock,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("accepts a reason at exactly the minimum length", async () => {
    await expect(
      resetPasswordAsAdmin({
        actor: admin(),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: "x".repeat(MIN_RESET_REASON_LENGTH),
        store: h.store,
        audit: h.audit,
        clock,
      }),
    ).resolves.toMatchObject({ revokedSessionCount: 3 });
  });

  it("writes nothing when the new password is too weak", async () => {
    await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: "short",
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    }).catch(() => undefined);

    expect(h.store.setPasswordHash).not.toHaveBeenCalled();
    expect(h.store.revokeAllSessions).not.toHaveBeenCalled();
  });

  it("fails the reset when the audit write fails", async () => {
    // An unaudited reset is indistinguishable from an account takeover, so it
    // must not be reported as success.
    h.audit.record.mockRejectedValueOnce(new Error("audit table unreachable"));

    await expect(
      resetPasswordAsAdmin({
        actor: admin(),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: REASON,
        store: h.store,
        audit: h.audit,
        clock,
      }),
    ).rejects.toThrow(/audit table unreachable/);
  });

  it("propagates a store failure without auditing success", async () => {
    h.store.revokeAllSessions.mockRejectedValueOnce(new Error("db down"));

    await expect(
      resetPasswordAsAdmin({
        actor: admin(),
        targetUserId: "01JQUSER0000000000000000000",
        newPassword: NEW_PASSWORD,
        reason: REASON,
        store: h.store,
        audit: h.audit,
        clock,
      }),
    ).rejects.toThrow(/db down/);
    expect(h.entries).toHaveLength(0);
  });

  it("records a null ip and user agent rather than inventing values", async () => {
    await resetPasswordAsAdmin({
      actor: admin({ ip: null, userAgent: null }),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(h.entries[0]).toMatchObject({ ip: null, userAgent: null });
  });

  it("produces a different hash for the same password on each reset", async () => {
    const first = harness();
    const second = harness();
    const args = {
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      clock,
    };

    await resetPasswordAsAdmin({ ...args, store: first.store, audit: first.audit });
    await resetPasswordAsAdmin({ ...args, store: second.store, audit: second.audit });

    expect(first.storedHash).not.toBe(second.storedHash);
  });

  it("reports zero revoked sessions when the user had none", async () => {
    h.store.revokeAllSessions.mockResolvedValueOnce(0);

    const result = await resetPasswordAsAdmin({
      actor: admin(),
      targetUserId: "01JQUSER0000000000000000000",
      newPassword: NEW_PASSWORD,
      reason: REASON,
      store: h.store,
      audit: h.audit,
      clock,
    });

    expect(result.revokedSessionCount).toBe(0);
    expect(h.entries[0]?.revokedSessionCount).toBe(0);
  });
});

describe("RESET_OPERATOR_WARNING", () => {
  it("tells the admin that identity verification is their responsibility", () => {
    expect(RESET_OPERATOR_WARNING).toMatch(/verify/i);
    expect(RESET_OPERATOR_WARNING).toMatch(/cannot confirm who asked/i);
  });

  it("states the consequences: takeover, sign-out, and an audit trail", () => {
    expect(RESET_OPERATOR_WARNING).toMatch(/takes over the account/i);
    expect(RESET_OPERATOR_WARNING).toMatch(/signs out every existing session/i);
    expect(RESET_OPERATOR_WARNING).toMatch(/recorded against your admin account/i);
  });
});
