/**
 * Masked display and the audited reveal path (PLAN.md §12).
 *
 * §12 requires that a key is shown masked by default, that the eye toggle decrypts
 * only for an authenticated website session, and that every reveal is audited. This
 * module is the ONLY place that turns an envelope back into a plaintext key for
 * display, so the audit write cannot be bypassed by calling something lower-level:
 * `revealApiKey` records the attempt before it decrypts, and records failures too.
 */

import type { SecretKeyring } from "@bosanda/config";
import { BosandaError } from "@bosanda/protocol";
import type { Clock } from "@bosanda/shared";
import { KEY_TAG, PREFIX_BODY_CHARS, SECRET_BODY_CHARS, prefixOf } from "./generate.js";
import { open } from "./envelope.js";

/** Character used to stand in for the withheld secret body. */
const MASK_CHAR = "•";

/**
 * How much of the prefix is safe to show. §12 forbids logging a full prefix, and the
 * prefix is also a lookup handle, so the masked form shows only its leading half.
 */
const VISIBLE_PREFIX_CHARS = 4;

/**
 * Renders a key for display without decrypting anything.
 *
 * Takes the stored prefix, not the plaintext, so a masked view never needs the
 * encryption key at all — the dashboard list can render entirely from the database.
 */
export function maskKey(prefix: string): string {
  const body = prefix.startsWith(KEY_TAG) ? prefix.slice(KEY_TAG.length) : prefix;
  const visible = body.slice(0, VISIBLE_PREFIX_CHARS);
  const hiddenPrefix = MASK_CHAR.repeat(Math.max(0, PREFIX_BODY_CHARS - VISIBLE_PREFIX_CHARS));
  return `${KEY_TAG}${visible}${hiddenPrefix}${MASK_CHAR.repeat(SECRET_BODY_CHARS)}`;
}

/** The stored, non-secret half of a key record. */
export type StoredApiKey = {
  readonly id: string;
  readonly prefix: string;
  /** Envelope from `seal()`. Never logged, never returned to a client. */
  readonly ciphertext: string;
  readonly revokedAt: Date | null;
};

/** Who asked, and from where — recorded verbatim in the audit entry. */
export type RevealActor = {
  /** Authenticated user id from the website session. Never an API key. */
  readonly userId: string;
  readonly sessionId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
};

export type RevealAuditEntry = {
  readonly action: "api_key.reveal";
  readonly apiKeyId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly at: Date;
  readonly outcome: "succeeded" | "denied" | "failed";
  /** Why a non-success happened. Contains no key material. */
  readonly reason: string | null;
};

/** Sink for audit entries. The caller supplies a durable implementation. */
export type RevealAuditSink = {
  record(entry: RevealAuditEntry): void | Promise<void>;
};

export type RevealInput = {
  readonly key: StoredApiKey;
  readonly actor: RevealActor;
  readonly keyring: SecretKeyring;
  readonly clock: Clock;
  readonly audit: RevealAuditSink;
};

/**
 * Decrypts a key for the dashboard eye toggle, writing an audit entry either way.
 *
 * The audit write is awaited BEFORE the plaintext is returned. If auditing fails the
 * reveal fails — an unrecorded reveal is worse than a broken toggle.
 */
export async function revealApiKey(input: RevealInput): Promise<string> {
  const { key, actor, keyring, clock, audit } = input;
  const at = clock.now();

  const base = {
    action: "api_key.reveal",
    apiKeyId: key.id,
    userId: actor.userId,
    sessionId: actor.sessionId,
    ip: actor.ip,
    userAgent: actor.userAgent,
    at,
  } as const;

  if (key.revokedAt !== null) {
    await audit.record({ ...base, outcome: "denied", reason: "key is revoked" });
    throw new BosandaError("not_found", {
      internalDetail: `reveal denied: api key ${key.id} is revoked`,
    });
  }

  let plaintext: string;
  try {
    plaintext = open(key.ciphertext, keyring);
  } catch (error) {
    const failure = BosandaError.from(error);
    await audit.record({
      ...base,
      outcome: "failed",
      // internalDetail is authored by envelope.ts and carries no key material.
      reason: failure.internalDetail ?? failure.code,
    });
    throw failure;
  }

  // A ciphertext that decrypts cleanly but does not match the stored prefix means the
  // row is inconsistent (wrong ciphertext copied in, or a prefix edited by hand).
  // Returning it would show one key while metering another.
  if (prefixOf(plaintext) !== key.prefix) {
    await audit.record({
      ...base,
      outcome: "failed",
      reason: "decrypted key does not match stored prefix",
    });
    throw new BosandaError("internal_error", {
      internalDetail: `api key ${key.id} ciphertext does not match its stored prefix`,
    });
  }

  await audit.record({ ...base, outcome: "succeeded", reason: null });
  return plaintext;
}
