/**
 * Provider credential handling (PLAN.md §6 "Authentication data", §3 G0, §16).
 *
 * Three responsibilities, deliberately kept in one file because they share the
 * invariant that plaintext credential material never escapes:
 *
 *  1. The credential SHAPE and its validation (§6).
 *  2. Sealing/opening with the `provider-credentials` keyring purpose in a
 *     self-describing versioned envelope (§16 "authenticated encryption",
 *     "versioned key").
 *  3. Access-token refresh with per-account single-flight (§3 G0.4) and an
 *     optimistic-concurrency guard for refresh-token rotation (§6).
 *
 * The envelope format mirrors `@bosanda/api-keys` (`v<version>.<nonce>.<ct>`)
 * but uses a DIFFERENT AAD string and a different keyring purpose. That is the
 * point: a provider-credential ciphertext moved into the customer-API-key column
 * fails authentication rather than decrypting into a plausible value.
 *
 * Nothing here logs. The caller gets structured, already-sanitized outcomes and
 * decides what to record; a token, refresh token, or client secret must never
 * reach a log line or an error message (§17).
 */

import { randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { z } from "zod";
import type { SecretKeyring } from "@bosanda/config";
import { BosandaError } from "@bosanda/protocol";
import type { Persona, ProviderCredentials } from "@bosanda/provider-core";
import { type Clock, isExpired, singleFlight, systemClock } from "@bosanda/shared";

const NONCE_BYTES = 24;

/** Domain separation: distinct from the api-keys AAD by construction. */
const AAD = new TextEncoder().encode("bosanda/provider-credentials/v1");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Refresh a token this long before it actually expires, so a request that
 * begins just under the wire does not race the expiry mid-flight.
 */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Wire schema for the sealed JSON. Validated on open so a corrupted or
 * hand-edited row fails loudly instead of producing a half-populated
 * credential. Datetimes are ISO-8601 UTC (§14).
 */
const credentialSchema = z.object({
  authMethod: z.enum(["social", "idc", "api_key"]),
  refreshToken: z.string().min(1).nullable().default(null),
  accessToken: z.string().min(1).nullable().default(null),
  accessTokenExpiresAt: z.string().datetime().nullable().default(null),
  region: z.string().min(1),
  profileArn: z.string().min(1).nullable().default(null),
  clientId: z.string().min(1).nullable().default(null),
  clientSecret: z.string().min(1).nullable().default(null),
  persona: z.enum(["cli", "ide"]),
  credentialVersion: z.number().int().min(0),
});

/**
 * Rules that must hold for a credential to be usable at all (§3 G0.1, G0.2).
 * Checked at import time so an unusable account is rejected by an operator
 * action rather than discovered on a customer's request.
 */
export function assertUsableCredentials(credentials: ProviderCredentials): void {
  const problems: string[] = [];

  if (credentials.authMethod === "idc" && credentials.clientId === null) {
    problems.push("idc auth requires clientId");
  }
  if (credentials.refreshToken === null && credentials.accessToken === null) {
    problems.push("credential has neither a refresh token nor an access token");
  }
  // An access token with no refresh token cannot survive its own expiry.
  if (credentials.refreshToken === null && credentials.accessTokenExpiresAt !== null) {
    problems.push("expiring access token has no refresh token to renew it");
  }

  if (problems.length > 0) {
    throw new BosandaError("invalid_request", {
      // Names the defects, never the values.
      internalDetail: `provider credential is unusable: ${problems.join("; ")}`,
    });
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/**
 * Encrypts a credential with the CURRENT keyring version.
 *
 * A fresh 24-byte nonce per call means resealing the same credential produces
 * different ciphertext, so database read access cannot reveal that two accounts
 * share a token.
 */
export function sealCredentials(
  credentials: ProviderCredentials,
  keyring: SecretKeyring,
): { envelope: string; keyVersion: number } {
  const version = keyring.currentVersion;
  const key = keyring.keyFor("provider-credentials");
  const nonce = new Uint8Array(randomBytes(NONCE_BYTES));

  const plaintext = JSON.stringify({
    authMethod: credentials.authMethod,
    refreshToken: credentials.refreshToken,
    accessToken: credentials.accessToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt?.toISOString() ?? null,
    region: credentials.region,
    profileArn: credentials.profileArn,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    persona: credentials.persona,
    credentialVersion: credentials.credentialVersion,
  });

  const sealed = xchacha20poly1305(key, nonce, AAD).encrypt(encoder.encode(plaintext));

  return {
    envelope: `v${version}.${toBase64Url(nonce)}.${toBase64Url(sealed)}`,
    keyVersion: version,
  };
}

/**
 * Decrypts a credential envelope.
 *
 * Fails closed on every fault, and no thrown error contains any part of the
 * envelope, the ciphertext, or the plaintext — an error message is the easiest
 * accidental exfiltration path for a secret.
 */
export function openCredentials(envelope: string, keyring: SecretKeyring): ProviderCredentials {
  const parts = envelope.split(".");
  const [versionPart, noncePart, ciphertextPart] = parts;
  if (
    parts.length !== 3 ||
    versionPart === undefined ||
    noncePart === undefined ||
    ciphertextPart === undefined ||
    !versionPart.startsWith("v")
  ) {
    throw new BosandaError("internal_error", {
      internalDetail: "provider credential envelope is malformed",
    });
  }

  const version = Number.parseInt(versionPart.slice(1), 10);
  if (!Number.isInteger(version) || version < 1) {
    throw new BosandaError("internal_error", {
      internalDetail: "provider credential envelope has an invalid key version",
    });
  }

  const nonce = fromBase64Url(noncePart);
  if (nonce.length !== NONCE_BYTES) {
    throw new BosandaError("internal_error", {
      internalDetail: `provider credential envelope nonce must be ${NONCE_BYTES} bytes`,
    });
  }

  // Throws loudly when the generation is no longer held, rather than trying the
  // current key and reporting a confusing authentication failure.
  const key = keyring.keyForVersion("provider-credentials", version);

  let opened: Uint8Array;
  try {
    opened = xchacha20poly1305(key, nonce, AAD).decrypt(fromBase64Url(ciphertextPart));
  } catch (error) {
    throw new BosandaError("internal_error", {
      internalDetail: "provider credential envelope failed authentication",
      cause: error,
    });
  }

  let parsed: z.infer<typeof credentialSchema>;
  try {
    parsed = credentialSchema.parse(JSON.parse(decoder.decode(opened)) as unknown);
  } catch (error) {
    throw new BosandaError("internal_error", {
      // Zod issue paths name FIELDS, not values, so they are safe. The cause is
      // deliberately dropped from the message.
      internalDetail: "provider credential envelope contents failed schema validation",
      cause: error,
    });
  }

  return {
    authMethod: parsed.authMethod,
    refreshToken: parsed.refreshToken,
    accessToken: parsed.accessToken,
    accessTokenExpiresAt:
      parsed.accessTokenExpiresAt === null ? null : new Date(parsed.accessTokenExpiresAt),
    region: parsed.region,
    profileArn: parsed.profileArn,
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
    persona: parsed.persona,
    credentialVersion: parsed.credentialVersion,
  };
}

/** Reads the key version an envelope was sealed with, without decrypting. */
export function credentialEnvelopeVersion(envelope: string): number | null {
  const versionPart = envelope.split(".")[0];
  if (versionPart === undefined || !versionPart.startsWith("v")) return null;
  const version = Number.parseInt(versionPart.slice(1), 10);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

/**
 * Whether the access token needs renewing, allowing for clock skew.
 * A credential with no expiry recorded is treated as needing a refresh unless it
 * carries no refresh token at all (a static `api_key` credential).
 */
export function needsRefresh(credentials: ProviderCredentials, now: Date): boolean {
  if (credentials.accessToken === null) return true;
  if (credentials.accessTokenExpiresAt === null) {
    return credentials.refreshToken !== null && credentials.authMethod !== "api_key";
  }
  return isExpired(
    credentials.accessTokenExpiresAt,
    new Date(now.getTime() + TOKEN_REFRESH_SKEW_MS),
  );
}

/** What an upstream token endpoint returns. Rotation is optional per §6. */
export type RefreshResult = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** Present when the upstream rotated the refresh token; null when unchanged. */
  refreshToken?: string | null;
};

/**
 * Loads and persists credentials. Implemented over PostgreSQL by the account
 * repository; the adapter depends only on this narrow port so its tests need no
 * database.
 */
export type CredentialStore = {
  /** Decrypted credential for `accountId`, or null when unknown. */
  load(accountId: string): Promise<ProviderCredentials | null>;
  /**
   * Persists rotated material.
   *
   * MUST be a single transaction with a compare-and-swap on
   * `expectedVersion` (§6 "database transaction and optimistic version check",
   * §3 G0.3). Returns the stored credential on success, or null when the
   * version no longer matched — meaning another process rotated first, and the
   * caller should reload rather than overwrite.
   */
  persistRefresh(
    accountId: string,
    expectedVersion: number,
    next: RefreshResult,
  ): Promise<ProviderCredentials | null>;
};

/** Performs the upstream token exchange. Injected so tests never hit network. */
export type TokenRefresher = (
  credentials: ProviderCredentials,
  signal: AbortSignal,
) => Promise<RefreshResult>;

export type CredentialManagerOptions = {
  store: CredentialStore;
  refresher: TokenRefresher;
  clock?: Clock;
  /** Called on each refresh outcome. Receives NO token material. */
  onRefresh?: (event: { accountId: string; outcome: "success" | "failure" | "conflict" }) => void;
};

/**
 * Per-account credential access with collapsed refreshes.
 *
 * §3 G0.4 requires that concurrent requests for one account produce exactly one
 * upstream refresh. `singleFlight` from `@bosanda/shared` is keyed on the
 * account ID, so two accounts refresh in parallel (G0.7: accounts never share
 * tokens or metadata) while five requests on one account collapse to one call.
 *
 * The single-flight window is deliberately drawn around load + refresh +
 * persist, not just the HTTP call: if it covered only the HTTP call, two callers
 * could each write a rotated refresh token and the loser would persist a token
 * the upstream has already invalidated.
 */
export class CredentialManager {
  private readonly store: CredentialStore;
  private readonly refresher: TokenRefresher;
  private readonly clock: Clock;
  private readonly onRefresh: CredentialManagerOptions["onRefresh"];
  private readonly inFlight = singleFlight<string, ProviderCredentials>();

  constructor(options: CredentialManagerOptions) {
    this.store = options.store;
    this.refresher = options.refresher;
    this.clock = options.clock ?? systemClock;
    this.onRefresh = options.onRefresh;
  }

  /**
   * Returns credentials with a usable access token, refreshing if needed.
   *
   * `authentication_error` (401) is raised for a revoked or unrecoverable
   * credential, which §7 escalates to disabling the account until admin action.
   * It is NOT provider-retryable, so the scheduler will not burn every account
   * in the pool on the same bad-credential path.
   */
  async access(accountId: string, signal: AbortSignal): Promise<ProviderCredentials> {
    const current = await this.load(accountId);
    if (!needsRefresh(current, this.clock.now())) return current;

    return this.inFlight(accountId, async () => {
      // Re-read inside the lock: a refresh may have completed while we queued,
      // in which case there is nothing to do.
      const fresh = await this.load(accountId);
      if (!needsRefresh(fresh, this.clock.now())) return fresh;
      return this.refresh(accountId, fresh, signal);
    });
  }

  /** Forces a refresh, still collapsed per account. */
  async forceRefresh(accountId: string, signal: AbortSignal): Promise<ProviderCredentials> {
    return this.inFlight(accountId, async () => {
      const current = await this.load(accountId);
      return this.refresh(accountId, current, signal);
    });
  }

  private async load(accountId: string): Promise<ProviderCredentials> {
    const credentials = await this.store.load(accountId);
    if (credentials === null) {
      throw new BosandaError("not_found", {
        internalDetail: `provider account ${accountId} has no stored credential`,
        providerAccountId: accountId,
      });
    }
    return credentials;
  }

  private async refresh(
    accountId: string,
    current: ProviderCredentials,
    signal: AbortSignal,
  ): Promise<ProviderCredentials> {
    if (current.refreshToken === null) {
      this.onRefresh?.({ accountId, outcome: "failure" });
      throw new BosandaError("authentication_error", {
        internalDetail: "access token expired and no refresh token is stored",
        providerAccountId: accountId,
      });
    }

    let result: RefreshResult;
    try {
      result = await this.refresher(current, signal);
    } catch (error) {
      this.onRefresh?.({ accountId, outcome: "failure" });
      // Re-throw a classified error, never the upstream body (§12/§16).
      throw error instanceof BosandaError
        ? error
        : new BosandaError("authentication_error", {
            internalDetail: "provider token refresh failed",
            cause: error,
            providerAccountId: accountId,
          });
    }

    const persisted = await this.store.persistRefresh(accountId, current.credentialVersion, result);

    if (persisted === null) {
      // Another process rotated first. Its token is the valid one; ours may
      // already be invalidated upstream, so adopt the stored value.
      this.onRefresh?.({ accountId, outcome: "conflict" });
      const reloaded = await this.load(accountId);
      if (needsRefresh(reloaded, this.clock.now())) {
        throw new BosandaError("authentication_error", {
          internalDetail:
            "refresh lost the version race and the reloaded credential is still stale",
          providerAccountId: accountId,
        });
      }
      return reloaded;
    }

    this.onRefresh?.({ accountId, outcome: "success" });
    return persisted;
  }
}

/**
 * Operator-safe view of a credential. This is the ONLY shape that may be logged
 * or rendered in the admin UI (§15 "Kiro provider pool", §17). Presence flags
 * replace values; `profileArn` is omitted entirely because `redactValue` treats
 * it as sensitive and an ARN identifies a provider account.
 */
export function describeCredentials(credentials: ProviderCredentials): {
  authMethod: ProviderCredentials["authMethod"];
  persona: Persona;
  region: string;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  hasProfileArn: boolean;
  accessTokenExpiresAt: string | null;
  credentialVersion: number;
} {
  return {
    authMethod: credentials.authMethod,
    persona: credentials.persona,
    region: credentials.region,
    hasRefreshToken: credentials.refreshToken !== null,
    hasAccessToken: credentials.accessToken !== null,
    hasProfileArn: credentials.profileArn !== null,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt?.toISOString() ?? null,
    credentialVersion: credentials.credentialVersion,
  };
}
