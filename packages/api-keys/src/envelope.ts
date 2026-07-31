/**
 * Authenticated-encryption envelope for dashboard key recovery (PLAN.md §12):
 *
 *   ciphertext = XChaCha20-Poly1305(API_KEY_ENCRYPTION_KEY, plaintext_key)
 *
 * The envelope is SELF-DESCRIBING: it carries the key version it was sealed with, so
 * §12's "encryption keys are versioned to allow rotation" works without a migration.
 * `open()` reads the version out of the envelope and asks the keyring for that
 * generation's key rather than assuming the current one.
 *
 * Wire format (all one base64url string, so it stores in a single text column):
 *
 *   v<version>.<base64url nonce (24 bytes)>.<base64url ciphertext+tag>
 *
 * XChaCha20 is used specifically for its 192-bit nonce: at that size a random nonce per
 * seal has negligible collision probability, so no counter or coordination is needed —
 * which matters because keys are sealed from multiple processes.
 */

import { randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { SecretKeyring } from "@bosanda/config";
import { BosandaError } from "@bosanda/protocol";

const NONCE_BYTES = 24;

/**
 * Additional authenticated data. Binds the ciphertext to its purpose, so an envelope
 * sealed for an API key cannot be moved into a column expecting provider credentials
 * and silently decrypted there.
 */
const AAD = new TextEncoder().encode("bosanda/api-key/v1");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/**
 * Encrypts a plaintext key with the CURRENT keyring version.
 *
 * A fresh random nonce is drawn per call, so sealing the same key twice produces
 * different ciphertext — required, because a deterministic ciphertext would let anyone
 * with database read access tell whether two rows hold the same key.
 */
export function seal(plaintextKey: string, keyring: SecretKeyring): string {
  const version = keyring.currentVersion;
  const key = keyring.keyFor("customer-api-key");
  const nonce = new Uint8Array(randomBytes(NONCE_BYTES));

  const sealed = xchacha20poly1305(key, nonce, AAD).encrypt(encoder.encode(plaintextKey));

  return `v${version}.${toBase64Url(nonce)}.${toBase64Url(sealed)}`;
}

/**
 * Decrypts an envelope.
 *
 * Fails closed on every fault: an unparseable envelope, an unknown key version, a
 * tampered nonce, a tampered ciphertext, a truncated tag, or AAD mismatch all raise
 * rather than returning a plausible-looking wrong value. Poly1305 gives us that
 * guarantee for the ciphertext itself; the parsing checks cover the framing.
 *
 * The thrown error never contains any part of the envelope or the plaintext.
 */
export function open(envelope: string, keyring: SecretKeyring): string {
  const parts = envelope.split(".");
  if (parts.length !== 3) {
    throw new BosandaError("internal_error", {
      internalDetail: "api key envelope is malformed (expected 3 dot-separated parts)",
    });
  }

  const [versionPart, noncePart, ciphertextPart] = parts;
  if (
    versionPart === undefined ||
    noncePart === undefined ||
    ciphertextPart === undefined ||
    !versionPart.startsWith("v")
  ) {
    throw new BosandaError("internal_error", {
      internalDetail: "api key envelope is malformed (bad version tag)",
    });
  }

  const version = Number.parseInt(versionPart.slice(1), 10);
  if (!Number.isInteger(version) || version < 1) {
    throw new BosandaError("internal_error", {
      internalDetail: "api key envelope has an invalid key version",
    });
  }

  const nonce = fromBase64Url(noncePart);
  if (nonce.length !== NONCE_BYTES) {
    throw new BosandaError("internal_error", {
      internalDetail: `api key envelope nonce must be ${NONCE_BYTES} bytes`,
    });
  }

  // Throws loudly when the version is no longer held, rather than trying the current
  // key and reporting a confusing authentication failure.
  const key = keyring.keyForVersion("customer-api-key", version);

  let opened: Uint8Array;
  try {
    opened = xchacha20poly1305(key, nonce, AAD).decrypt(fromBase64Url(ciphertextPart));
  } catch (error) {
    throw new BosandaError("internal_error", {
      // Deliberately does not include the envelope or the underlying message, which
      // could echo ciphertext bytes.
      internalDetail: "api key envelope failed authentication",
      cause: error,
    });
  }

  return decoder.decode(opened);
}

/** Reads the key version an envelope was sealed with, without decrypting it. */
export function envelopeVersion(envelope: string): number | null {
  const versionPart = envelope.split(".")[0];
  if (versionPart === undefined || !versionPart.startsWith("v")) return null;
  const version = Number.parseInt(versionPart.slice(1), 10);
  return Number.isInteger(version) && version >= 1 ? version : null;
}
