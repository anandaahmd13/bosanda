/**
 * Login and registration decisions (PLAN.md §12).
 *
 * Pure policy: this module decides, the caller persists. Keeping the branch
 * structure here means the "wrong username" and "wrong password" paths can be
 * held identical by construction, which is what stops login from enumerating
 * which accounts exist.
 */

import { BosandaError } from "@bosanda/protocol";
import type { Clock } from "@bosanda/shared";
import { hashPassword, needsRehash, verifyPassword } from "./passwords.js";
import { assertUsernameAcceptable, normalizeUsername } from "./usernames.js";
import { assertPasswordAcceptable } from "./passwords.js";

export type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  role: "customer" | "admin";
  status: "active" | "suspended";
};

/**
 * A hash to verify against when no user was found.
 *
 * Without this, a request for a nonexistent username returns before doing any
 * Argon2 work and answers measurably faster than one for a real account —
 * turning login into an account-existence oracle. Verifying the submitted
 * password against a real Argon2id hash of an unguessable value spends the same
 * time and always fails.
 */
const DUMMY_HASH_PLACEHOLDER = "$argon2id$v=19$m=19456,t=2,p=1$";

export type LoginOutcome =
  | { ok: true; user: UserRecord; shouldRehashPassword: boolean }
  | { ok: false; reason: "invalid_credentials" | "suspended" };

export type LoginInput = {
  username: string;
  password: string;
  /** Looked up by normalized username; null when no such account exists. */
  user: UserRecord | null;
  /**
   * An Argon2id hash to burn time against when `user` is null. Supply a hash of
   * a random value generated at startup. Falls back to a constant if omitted,
   * which still costs an Argon2 verify.
   */
  decoyHash?: string;
};

/**
 * Decide whether a login succeeds.
 *
 * Always performs exactly one password verification, whatever the outcome.
 */
export async function attemptLogin(input: LoginInput): Promise<LoginOutcome> {
  const { user, password } = input;

  const hashToCheck = user?.passwordHash ?? input.decoyHash ?? DUMMY_HASH_PLACEHOLDER;
  const passwordMatches = await verifyPassword(password, hashToCheck);

  if (user === null || !passwordMatches) {
    // One reason for both cases: the response must not distinguish "no such
    // user" from "wrong password".
    return { ok: false, reason: "invalid_credentials" };
  }

  // Checked after the password so a suspended account is not revealed to
  // someone who does not know its password.
  if (user.status === "suspended") {
    return { ok: false, reason: "suspended" };
  }

  return { ok: true, user, shouldRehashPassword: needsRehash(user.passwordHash) };
}

/**
 * `invalid_credentials` and `suspended` both surface as 401 with the same
 * client-visible message; only the operator log distinguishes them.
 */
export function assertLoginSucceeded(outcome: LoginOutcome): UserRecord {
  if (!outcome.ok) {
    throw new BosandaError("authentication_error", {
      internalDetail: `login failed: ${outcome.reason}`,
    });
  }
  return outcome.user;
}

export type NewUser = {
  username: string;
  passwordHash: string;
  role: "customer";
  status: "active";
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Validate and prepare a registration (§12: public registration, no guest
 * checkout, no email).
 *
 * Uniqueness is NOT checked here — that is the database's `lower(username)`
 * unique index, which is the only check free of a race between two concurrent
 * signups.
 */
export async function prepareRegistration(
  username: string,
  password: string,
  clock: Clock,
): Promise<NewUser> {
  assertUsernameAcceptable(username);
  assertPasswordAcceptable(password);

  const now = clock.now();
  return {
    // Stored normalized so the display form matches the uniqueness form.
    username: normalizeUsername(username),
    passwordHash: await hashPassword(password),
    role: "customer",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/** Build a decoy hash at startup, for `attemptLogin`'s timing equalization. */
export async function createDecoyHash(): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  return hashPassword(randomBytes(24).toString("base64url"));
}
