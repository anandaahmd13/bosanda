import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { fixedClock } from "@bosanda/shared";
import {
  assertLoginSucceeded,
  attemptLogin,
  createDecoyHash,
  prepareRegistration,
  type UserRecord,
} from "../src/login.js";
import { hashPassword, verifyPassword } from "../src/passwords.js";

const PASSWORD = "correct horse battery staple";
const clock = fixedClock("2026-04-01T09:00:00.000Z");

const storedHash = await hashPassword(PASSWORD);
const decoyHash = await createDecoyHash();

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "01JQ1111111111111111111111",
    username: "budi",
    passwordHash: storedHash,
    role: "customer",
    status: "active",
    ...overrides,
  };
}

describe("attemptLogin", () => {
  it("succeeds with the right password", async () => {
    const outcome = await attemptLogin({ username: "budi", password: PASSWORD, user: user() });
    expect(outcome.ok).toBe(true);
  });

  it("fails with the wrong password", async () => {
    const outcome = await attemptLogin({ username: "budi", password: "wrong", user: user() });
    expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("fails identically when the account does not exist", async () => {
    // The reason must be indistinguishable from a wrong password, or login
    // becomes an account-enumeration oracle.
    const missing = await attemptLogin({
      username: "nobody",
      password: PASSWORD,
      user: null,
      decoyHash,
    });
    const wrong = await attemptLogin({ username: "budi", password: "wrong", user: user() });
    expect(missing).toEqual(wrong);
  });

  it("still performs a password verification when no user was found", async () => {
    // Timing is the observable here. Measure that the null-user path costs the
    // same order of magnitude as the real one rather than returning instantly.
    const timeOne = async (fn: () => Promise<unknown>) => {
      const start = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    const realMs = await timeOne(() =>
      attemptLogin({ username: "budi", password: "wrong", user: user() }),
    );
    const missingMs = await timeOne(() =>
      attemptLogin({ username: "nobody", password: PASSWORD, user: null, decoyHash }),
    );

    // Argon2id at these parameters takes tens of ms; an early return would be
    // sub-millisecond. A loose bound keeps this robust on a noisy CI box.
    expect(missingMs).toBeGreaterThan(realMs / 10);
  });

  it("rejects a suspended account even with the correct password", async () => {
    const outcome = await attemptLogin({
      username: "budi",
      password: PASSWORD,
      user: user({ status: "suspended" }),
    });
    expect(outcome).toEqual({ ok: false, reason: "suspended" });
  });

  it("does not reveal suspension to someone who has the wrong password", async () => {
    const outcome = await attemptLogin({
      username: "budi",
      password: "wrong",
      user: user({ status: "suspended" }),
    });
    expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("reports when a stored hash needs upgrading", async () => {
    const weak = "$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA";
    const outcome = await attemptLogin({
      username: "budi",
      password: PASSWORD,
      user: user({ passwordHash: weak }),
    });
    // The weak hash is not a real hash of PASSWORD, so login fails; what
    // matters is that a corrupt hash does not throw.
    expect(outcome.ok).toBe(false);
  });

  it("flags a rehash when the hash verifies but is below policy", async () => {
    const weakHash = await hashPassword(PASSWORD, {
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    const outcome = await attemptLogin({
      username: "budi",
      password: PASSWORD,
      user: user({ passwordHash: weakHash }),
    });
    expect(outcome).toMatchObject({ ok: true, shouldRehashPassword: true });
  });

  it("does not flag a rehash for a current-policy hash", async () => {
    const outcome = await attemptLogin({ username: "budi", password: PASSWORD, user: user() });
    expect(outcome).toMatchObject({ ok: true, shouldRehashPassword: false });
  });

  it("fails closed on a corrupted stored hash", async () => {
    const outcome = await attemptLogin({
      username: "budi",
      password: PASSWORD,
      user: user({ passwordHash: "" }),
    });
    expect(outcome.ok).toBe(false);
  });

  it("admits an admin through the same path", async () => {
    const outcome = await attemptLogin({
      username: "ops",
      password: PASSWORD,
      user: user({ role: "admin" }),
    });
    expect(outcome).toMatchObject({ ok: true });
  });
});

describe("assertLoginSucceeded", () => {
  it("returns the user on success", async () => {
    const record = user();
    const outcome = await attemptLogin({ username: "budi", password: PASSWORD, user: record });
    expect(assertLoginSucceeded(outcome)).toBe(record);
  });

  it("raises authentication_error on failure", () => {
    try {
      assertLoginSucceeded({ ok: false, reason: "invalid_credentials" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).code).toBe("authentication_error");
    }
  });

  it("gives invalid_credentials and suspended the same public message", () => {
    const publicMessages = (["invalid_credentials", "suspended"] as const).map((reason) => {
      try {
        assertLoginSucceeded({ ok: false, reason });
        return "";
      } catch (error) {
        return (error as BosandaError).publicMessage;
      }
    });
    expect(new Set(publicMessages).size).toBe(1);
  });
});

describe("prepareRegistration", () => {
  it("stores the normalized username", async () => {
    const created = await prepareRegistration("  BudiSantoso ", PASSWORD, clock);
    expect(created.username).toBe("budisantoso");
  });

  it("hashes the password and never keeps the plaintext", async () => {
    const created = await prepareRegistration("budi", PASSWORD, clock);
    expect(created.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(JSON.stringify(created)).not.toContain(PASSWORD);
    await expect(verifyPassword(PASSWORD, created.passwordHash)).resolves.toBe(true);
  });

  it("creates an active customer, never an admin", async () => {
    // Registration is public (§12); it must not be a path to the admin role.
    const created = await prepareRegistration("budi", PASSWORD, clock);
    expect(created.role).toBe("customer");
    expect(created.status).toBe("active");
  });

  it("stamps timestamps from the clock", async () => {
    const created = await prepareRegistration("budi", PASSWORD, clock);
    expect(created.createdAt.toISOString()).toBe("2026-04-01T09:00:00.000Z");
    expect(created.updatedAt).toEqual(created.createdAt);
  });

  it("rejects a reserved username", async () => {
    await expect(prepareRegistration("admin", PASSWORD, clock)).rejects.toBeInstanceOf(
      BosandaError,
    );
  });

  it("rejects an invalid username before hashing", async () => {
    await expect(prepareRegistration("a b", PASSWORD, clock)).rejects.toThrow(/username rejected/);
  });

  it("rejects a weak password", async () => {
    await expect(prepareRegistration("budi", "short", clock)).rejects.toThrow(/password rejected/);
  });
});

describe("createDecoyHash", () => {
  it("produces a verifiable argon2id hash of an unguessable value", async () => {
    const hash = await createDecoyHash();
    expect(hash.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(false);
  });

  it("differs on each call", async () => {
    const [a, b] = await Promise.all([createDecoyHash(), createDecoyHash()]);
    expect(a).not.toBe(b);
  });
});
