/**
 * Username rules (PLAN.md §12: username + password, no email in version 1).
 *
 * Because the username is the only account identifier, it is also the only
 * thing an admin has to go on during manual recovery. So the rules exclude
 * characters that make two accounts look identical in a support conversation.
 */

import { BosandaError } from "@bosanda/protocol";

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;

/** Lowercase letters, digits, underscore, hyphen. Must start alphanumeric. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Names reserved so a customer cannot register something that reads as staff or
 * shadows a route on the dashboard.
 */
const RESERVED = new Set([
  "admin",
  "administrator",
  "root",
  "bosanda",
  "support",
  "help",
  "billing",
  "security",
  "system",
  "api",
  "www",
  "mail",
  "moderator",
  "staff",
  "owner",
  "operator",
  "me",
  "null",
  "undefined",
]);

/**
 * Canonical form used for uniqueness and lookup.
 *
 * Unicode NFKC first, then lowercase: without normalization, visually identical
 * names with different code points would be distinct rows, which is exactly the
 * confusion manual recovery cannot afford. The database enforces the same rule
 * with a `lower(username)` unique index.
 */
export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLowerCase();
}

export function validateUsername(username: string): string[] {
  const problems: string[] = [];
  const normalized = normalizeUsername(username);

  if (normalized.length < MIN_USERNAME_LENGTH) {
    problems.push(`Username must be at least ${MIN_USERNAME_LENGTH} characters.`);
  }
  if (normalized.length > MAX_USERNAME_LENGTH) {
    problems.push(`Username must be at most ${MAX_USERNAME_LENGTH} characters.`);
  }
  if (normalized !== "" && !USERNAME_PATTERN.test(normalized)) {
    problems.push(
      "Username may contain only lowercase letters, digits, underscore, and hyphen, " +
        "and must start with a letter or digit.",
    );
  }
  if (RESERVED.has(normalized)) {
    problems.push("That username is reserved.");
  }

  return problems;
}

export function assertUsernameAcceptable(username: string): void {
  const problems = validateUsername(username);
  if (problems.length > 0) {
    throw new BosandaError("invalid_request", {
      internalDetail: `username rejected: ${problems.join(" ")}`,
    });
  }
}

export function isReservedUsername(username: string): boolean {
  return RESERVED.has(normalizeUsername(username));
}
