/**
 * Password hashing (PLAN.md §12: "Passwords use Argon2id with reviewed
 * parameters").
 *
 * Parameters follow OWASP's Argon2id guidance: 19 MiB of memory, 2 passes,
 * 1 lane. Memory cost is the parameter that actually resists GPU cracking, so
 * it is preferred over raising time cost. The chosen values cost roughly tens of
 * milliseconds per hash on server hardware, which is affordable on a login path
 * that is also rate-limited (§12) but expensive to attack in bulk.
 *
 * The parameters are embedded in the PHC-format output string, so a future
 * increase verifies existing hashes correctly and `needsRehash` reports which
 * stored hashes should be upgraded on next successful login.
 */

import { hash, verify, type Algorithm } from "@node-rs/argon2";
import { BosandaError } from "@bosanda/protocol";

/**
 * `Algorithm` is declared as an *ambient* const enum, which
 * `verbatimModuleSyntax` forbids reading at runtime — there is no emitted object
 * to read the member from. The value is therefore written literally and typed
 * against the enum, so a future change to the upstream numbering fails the
 * typecheck instead of silently selecting a different algorithm.
 *
 * Per @node-rs/argon2: 0 = Argon2d, 1 = Argon2i, 2 = Argon2id.
 */
const ARGON2ID: Algorithm = 2;

export type PasswordParams = {
  /** KiB of memory per hash. */
  memoryCost: number;
  /** Passes over memory. */
  timeCost: number;
  /** Lanes. */
  parallelism: number;
};

/** OWASP Argon2id baseline: m=19456 (19 MiB), t=2, p=1. */
export const PASSWORD_PARAMS: PasswordParams = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Password length bounds.
 *
 * The minimum is a floor on user choice. The maximum exists because Argon2
 * hashes the whole input: without a cap, a multi-megabyte "password" is a cheap
 * way to burn server CPU. 1024 is far above any real password and far below
 * anything that costs measurable time.
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Validate a candidate password. Returns the list of problems, so a UI can show
 * all of them at once rather than one per submit.
 *
 * Deliberately not a composition rule ("one uppercase, one symbol"): NIST
 * SP 800-63B advises against those, because they push users toward predictable
 * substitutions. Length is the requirement that matters.
 */
export function validatePassword(password: string): string[] {
  const problems: string[] = [];

  // Count code points, not UTF-16 units, so an emoji-containing passphrase is
  // not credited double toward the minimum.
  const length = [...password].length;

  if (length < MIN_PASSWORD_LENGTH) {
    problems.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (password.trim() === "" && password !== "") {
    problems.push("Password cannot be only whitespace.");
  }

  return problems;
}

export function assertPasswordAcceptable(password: string): void {
  const problems = validatePassword(password);
  if (problems.length > 0) {
    // Safe to surface: describes the policy, never the submitted value.
    throw new BosandaError("invalid_request", {
      internalDetail: `password rejected: ${problems.join(" ")}`,
    });
  }
}

/**
 * Hash a password for storage. The returned PHC string carries the algorithm,
 * parameters, and a per-hash random salt, so nothing else needs storing.
 */
export async function hashPassword(
  password: string,
  params: PasswordParams = PASSWORD_PARAMS,
): Promise<string> {
  assertPasswordAcceptable(password);
  return hash(password, {
    algorithm: ARGON2ID,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed or truncated stored hash: a
 * corrupted row must read as "wrong password", never as an exception that a
 * caller might mistake for success or that distinguishes account states to an
 * attacker.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash === "") return false;
  // Skip the Argon2 call for input that cannot be a valid password anyway,
  // so an oversized body cannot force the expensive path.
  if (password.length > MAX_PASSWORD_LENGTH) return false;

  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than current policy
 * and should be re-hashed after the next successful login.
 *
 * Parses the PHC string rather than trusting a stored parameter column, so the
 * answer comes from the hash itself.
 */
export function needsRehash(storedHash: string, params: PasswordParams = PASSWORD_PARAMS): boolean {
  const parsed = parsePhc(storedHash);
  // Unparseable or non-Argon2id: rehash on next login to migrate it.
  if (parsed === null) return true;
  return (
    parsed.memoryCost < params.memoryCost ||
    parsed.timeCost < params.timeCost ||
    parsed.parallelism !== params.parallelism
  );
}

export type ParsedPhc = PasswordParams & { algorithm: string; version: number };

/** Parse the `$argon2id$v=19$m=19456,t=2,p=1$salt$hash` header. */
export function parsePhc(storedHash: string): ParsedPhc | null {
  const parts = storedHash.split("$");
  // ["", "argon2id", "v=19", "m=...,t=...,p=...", salt, hash]
  if (parts.length < 6) return null;

  const algorithm = parts[1];
  if (algorithm !== "argon2id") return null;

  const versionField = parts[2];
  const paramField = parts[3];
  if (versionField === undefined || paramField === undefined) return null;

  const version = Number.parseInt(versionField.replace("v=", ""), 10);
  if (!Number.isInteger(version)) return null;

  const params = new Map<string, number>();
  for (const pair of paramField.split(",")) {
    const [key, rawValue] = pair.split("=");
    if (key === undefined || rawValue === undefined) return null;
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(value)) return null;
    params.set(key, value);
  }

  const memoryCost = params.get("m");
  const timeCost = params.get("t");
  const parallelism = params.get("p");
  if (memoryCost === undefined || timeCost === undefined || parallelism === undefined) {
    return null;
  }

  return { algorithm, version, memoryCost, timeCost, parallelism };
}
