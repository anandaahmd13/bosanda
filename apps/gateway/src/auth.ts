/**
 * Request authentication for the public API (PLAN.md §8 auth headers, §12 keys).
 *
 * Accepts, per §8:
 *   - `Authorization: Bearer <key>`  (OpenAI surface, and Anthropic for
 *     compatibility — §8 says bearer "may also be accepted")
 *   - `x-api-key: <key>`             (Anthropic surface)
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not compare key strings, hash
 * anything itself, or decide quota. `@bosanda/api-keys` owns the digest and
 * `@bosanda/database`'s `decideKeyAuth` owns the verdict; metering owns quota.
 * This is only header extraction plus one indexed lookup, so the "never store or
 * compare plaintext" property in §12 stays checkable in one place.
 *
 * THE NO-ORACLE RULE (§12). Every authentication failure — unknown key,
 * malformed key, revoked key, expired key, suspended user — produces exactly one
 * outward-facing result: `authentication_error` (401) with the same frozen
 * public message. The distinction is recorded in `internalDetail` for operators
 * and as a metric label, never in the response. A client that could tell
 * "revoked" from "never existed" could enumerate valid keys.
 */

import { BosandaError } from "@bosanda/protocol";
import type { SecretKeyring } from "@bosanda/config";
import { looksLikeApiKey, lookupDigest } from "@bosanda/api-keys";
import { decideKeyAuth, type AuthenticatedApiKey, type ApiKeysRepository } from "@bosanda/database";

/** Lowercased header bag — Fastify and Node both give us lowercase keys. */
export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Why a discriminated union rather than a thrown error for the *reason*: the
 * caller needs the reason for logging and metrics, but must not let it reach the
 * client. Returning it forces an explicit decision at the call site instead of
 * carrying it inside an exception that something might serialize.
 */
export type AuthFailureReason =
  | "missing_header"
  | "malformed_header"
  | "malformed_key"
  | "unknown_key"
  | "key_revoked"
  | "key_expired"
  | "user_suspended";

export type AuthResult =
  { ok: true; authenticated: AuthenticatedApiKey } | { ok: false; reason: AuthFailureReason };

/**
 * The single 401 every failure maps to. One instance shape, one message, so no
 * call site can accidentally widen it.
 */
export function authenticationError(reason: AuthFailureReason): BosandaError {
  return new BosandaError("authentication_error", {
    // Operator-only. The reason is safe to log: it names a CLASS of failure and
    // contains no key material.
    internalDetail: `api key authentication failed: ${reason}`,
  });
}

/**
 * Pulls the presented key out of the headers without validating it.
 *
 * `x-api-key` is checked first: on the Anthropic surface it is the documented
 * header, and Claude Code sends it. If both are present and disagree we take
 * `x-api-key` rather than guessing — trying both would double the lookup cost and
 * turn a client bug into a silent fallback.
 *
 * An array-valued header (duplicated by a proxy) is rejected rather than joined:
 * two different keys in one request is not something to resolve by picking one.
 */
export function extractKey(headers: HeaderBag): { key: string } | { reason: AuthFailureReason } {
  const apiKeyHeader = headers["x-api-key"];
  if (apiKeyHeader !== undefined) {
    if (Array.isArray(apiKeyHeader)) return { reason: "malformed_header" };
    const value = apiKeyHeader.trim();
    if (value.length === 0) return { reason: "malformed_header" };
    return { key: value };
  }

  const authorization = headers["authorization"];
  if (authorization === undefined) return { reason: "missing_header" };
  if (Array.isArray(authorization)) return { reason: "malformed_header" };

  // Case-insensitive scheme per RFC 7235; exactly one space, then the token.
  const match = /^bearer[ \t]+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  if (token === undefined || token.length === 0) return { reason: "malformed_header" };
  return { key: token };
}

export type AuthenticateDeps = {
  apiKeys: Pick<ApiKeysRepository, "findByLookupDigest">;
  /** Keyring holding the `api-key-lookup` HMAC secret (§12). */
  keyring: SecretKeyring;
};

/**
 * Header bag → authenticated key, or a reason.
 *
 * `looksLikeApiKey` runs BEFORE the digest so a junk value (a session cookie, an
 * OpenAI `sk-` key pasted by mistake, a 2 MB string) costs one regex instead of
 * an HMAC and a database round trip. It is a shape check only — passing it says
 * nothing about validity.
 */
export async function authenticate(
  headers: HeaderBag,
  deps: AuthenticateDeps,
): Promise<AuthResult> {
  const extracted = extractKey(headers);
  if ("reason" in extracted) return { ok: false, reason: extracted.reason };

  if (!looksLikeApiKey(extracted.key)) return { ok: false, reason: "malformed_key" };

  const digest = lookupDigest(extracted.key, deps.keyring);
  const found = await deps.apiKeys.findByLookupDigest(digest);

  const verdict = decideKeyAuth(
    found === null ? null : { key: { status: found.key.status }, userStatus: found.userStatus },
  );
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  // `found` is non-null here: decideKeyAuth returns unknown_key for null, which
  // the check above already returned on. Narrowed explicitly rather than with `!`
  // because non-null assertions are banned outside tests.
  if (found === null) return { ok: false, reason: "unknown_key" };

  return { ok: true, authenticated: found };
}
