/**
 * The PostgreSQL-backed `CredentialStore` and the live `TokenRefresher`
 * (PLAN.md §6 authentication data, §3 gate G0).
 *
 * `@bosanda/provider-kiro` declares both as ports and ships neither, so the adapter
 * can be tested without a database or a network. These are the production
 * implementations, and they are the only place decrypted provider credentials exist
 * outside `CredentialManager`.
 *
 * ── THE COMPARE-AND-SWAP IS THE WHOLE POINT OF `persistRefresh` ───────────
 * §6 requires refresh-token rotation to be "a database transaction and optimistic
 * version check". The failure it prevents is specific and unrecoverable: Kiro
 * invalidates the old refresh token when it issues a new one, so if two gateway
 * processes refresh the same account concurrently and both write, the second write
 * stores a refresh token that upstream has already retired. The account is then
 * permanently unauthenticated and needs an operator to re-link it — no retry fixes
 * it. `rotateCredentials` does the CAS in SQL (`WHERE credential_version =
 * expectedVersion`), and a mismatch returns null so `CredentialManager` reloads the
 * winner's token instead of overwriting it.
 *
 * ── WHAT MAY BE LOGGED HERE ───────────────────────────────────────────────
 * Nothing derived from token material. Not the token, not its length, not a prefix,
 * not a hash — §16 invariant 1 admits no exceptions, and `describeCredentials()`
 * exists precisely so an operator can see credential STATE without its content.
 * Errors thrown here name the defect and the account, never the value.
 */

import { BosandaError } from "@bosanda/protocol";
import type { ProviderCredentials } from "@bosanda/provider-core";
import {
  openCredentials,
  sealCredentials,
  type CredentialStore,
  type RefreshResult,
  type TokenRefresher,
  type UpstreamTransport,
} from "@bosanda/provider-kiro";
import type { SecretKeyring } from "@bosanda/config";
import type { Executor, ProviderAccountsRepository } from "@bosanda/database";
import { providerAccountsRepository } from "@bosanda/database";
import type { Clock } from "@bosanda/shared";
import type { Logger } from "@bosanda/observability";

export type CredentialStoreOptions = {
  sql: Executor;
  keyring: SecretKeyring;
  clock: Clock;
  logger: Logger;
};

/**
 * Builds the `CredentialStore` over `provider_accounts`.
 *
 * `load` returns null for an unknown account rather than throwing, because
 * `CredentialManager` classifies that as `not_found` (404) itself and a store that
 * threw would produce two different errors for the same condition depending on
 * which layer noticed first.
 */
export function postgresCredentialStore(options: CredentialStoreOptions): CredentialStore {
  const { sql, keyring, clock, logger } = options;
  const accounts: ProviderAccountsRepository = providerAccountsRepository(sql);

  return {
    async load(accountId: string): Promise<ProviderCredentials | null> {
      const row = await accounts.readCredentials(accountId);
      if (row === null) return null;

      // Throws `internal_error` on a malformed envelope, a retired key version, or
      // a failed authentication tag — all operator problems, none of which should
      // be reported to a customer as an authentication failure.
      const credentials = openCredentials(row.encryptedCredentials, keyring);

      // The ROW's version is authoritative, not the one inside the envelope: the
      // row is what the CAS compares against. They can differ only if a write
      // sealed a stale version, and trusting the envelope there would make every
      // subsequent CAS fail with no way to recover.
      return { ...credentials, credentialVersion: row.credentialVersion };
    },

    async persistRefresh(
      accountId: string,
      expectedVersion: number,
      next: RefreshResult,
    ): Promise<ProviderCredentials | null> {
      const current = await accounts.readCredentials(accountId);
      if (current === null) {
        // The account was deleted between the refresh and the write. Reporting a
        // conflict (null) rather than throwing lets the manager reload and fail
        // with `not_found`, which is the accurate outcome.
        return null;
      }

      const opened = openCredentials(current.encryptedCredentials, keyring);

      const rotated: ProviderCredentials = {
        ...opened,
        accessToken: next.accessToken,
        accessTokenExpiresAt: next.accessTokenExpiresAt,
        // `refreshToken: undefined` means upstream did not rotate it — keep the
        // existing one. An explicit `null` means it is gone. The distinction
        // matters: collapsing undefined to null would discard a working token.
        refreshToken: next.refreshToken === undefined ? opened.refreshToken : next.refreshToken,
        credentialVersion: expectedVersion + 1,
      };

      const sealed = sealCredentials(rotated, keyring);

      const outcome = await accounts.rotateCredentials({
        accountId,
        expectedVersion,
        encryptedCredentials: sealed.envelope,
        encryptionKeyVersion: sealed.keyVersion,
        at: clock.now(),
      });

      if (!outcome.ok) {
        // Another process won the race, or the account vanished. Not an error: the
        // other writer's token is the valid one, and the manager will reload it.
        logger.warn(
          {
            providerAccountId: accountId,
            expectedVersion,
            reason: outcome.reason,
            currentVersion: outcome.currentVersion,
          },
          "credential rotation lost the compare-and-swap; reloading",
        );
        return null;
      }

      logger.info(
        { providerAccountId: accountId, credentialVersion: rotated.credentialVersion },
        "provider credential rotated",
      );

      return rotated;
    },
  };
}

/**
 * The upstream token exchange.
 *
 * NOT VERIFIED AGAINST LIVE KIRO. The M0 gate (§3, §20) has not been executed, so
 * the endpoint and payload shapes here are drawn from the fixtures and are marked
 * unverified for the same reason `ADAPTER_VERSION` carries a `-draft` suffix. G0.1
 * ("refresh token works against the real endpoint") is exactly what will confirm or
 * correct this function. It is wired up so the gate has something to run; it must
 * not be trusted until the gate passes.
 *
 * Errors are classified, never wrapped raw: an upstream 400/401 means the refresh
 * token is dead and no retry will help (`authentication_error`, deliberately NOT in
 * the provider-retryable set), while a 5xx or a transport fault is transient
 * (`upstream_timeout`, which IS retryable and triggers a cooldown).
 */
export type TokenRefresherOptions = {
  /** Injected so tests never touch the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Refresh endpoint. Unverified until G0.1. */
  endpoint?: string;
  timeoutMs?: number;
};

const DEFAULT_REFRESH_ENDPOINT = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

export function createTokenRefresher(options: TokenRefresherOptions = {}): TokenRefresher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_REFRESH_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async (credentials: ProviderCredentials, signal: AbortSignal): Promise<RefreshResult> => {
    if (credentials.refreshToken === null || credentials.refreshToken.length === 0) {
      throw new BosandaError("authentication_error", {
        internalDetail: "provider credential has no refresh token",
      });
    }

    // A per-attempt timeout chained to the caller's signal: the caller's abort must
    // still win, and an upstream that never answers must not hold the single-flight
    // lock open for every queued request on this account.
    const timeout = AbortSignal.timeout(timeoutMs);
    const composite = AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refreshToken: credentials.refreshToken }),
        signal: composite,
      });
    } catch (error) {
      // Transport-level: DNS, TLS, reset, or our own timeout. Retryable.
      throw new BosandaError("upstream_timeout", {
        internalDetail: "provider token refresh transport failure",
        cause: error,
      });
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Terminal. The refresh token has been revoked or rotated away; the account
      // needs an operator, and retrying on another account is meaningless.
      throw new BosandaError("authentication_error", {
        internalDetail: `provider token refresh rejected with ${response.status}`,
      });
    }
    if (!response.ok) {
      throw new BosandaError("upstream_timeout", {
        internalDetail: `provider token refresh failed with ${response.status}`,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new BosandaError("upstream_incompatible", {
        internalDetail: "provider token refresh returned a non-JSON body",
        cause: error,
      });
    }

    return parseRefreshResponse(payload);
  };
}

/**
 * Reads a refresh response into `RefreshResult`.
 *
 * Exported for the M0 gate to exercise against captured live responses without
 * performing a network call. Every failure says WHICH field was wrong and never
 * echoes the body, since the body contains a token.
 */
export function parseRefreshResponse(payload: unknown): RefreshResult {
  if (typeof payload !== "object" || payload === null) {
    throw new BosandaError("upstream_incompatible", {
      internalDetail: "provider token refresh body is not an object",
    });
  }
  const body = payload as Record<string, unknown>;

  const accessToken = body["accessToken"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new BosandaError("upstream_incompatible", {
      internalDetail: "provider token refresh body has no accessToken",
    });
  }

  const expiresAt = readExpiry(body);
  const refreshToken = body["refreshToken"];
  if (refreshToken !== undefined && refreshToken !== null && typeof refreshToken !== "string") {
    throw new BosandaError("upstream_incompatible", {
      internalDetail: "provider token refresh body has a non-string refreshToken",
    });
  }

  return {
    accessToken,
    accessTokenExpiresAt: expiresAt,
    ...(refreshToken === undefined ? {} : { refreshToken: refreshToken as string | null }),
  };
}

/**
 * Resolves the access-token expiry.
 *
 * Accepts either an absolute `expiresAt` or a relative `expiresIn` (seconds),
 * because the fixtures show both spellings and G0.1 has not yet settled which one
 * the live endpoint uses. An unusable value is an error rather than a guessed
 * default: an invented expiry would either refresh constantly or, far worse, treat
 * a dead token as valid and fail every request on the account.
 */
function readExpiry(body: Record<string, unknown>): Date {
  const absolute = body["expiresAt"];
  if (typeof absolute === "string") {
    const parsed = new Date(absolute);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const relative = body["expiresIn"];
  if (typeof relative === "number" && Number.isFinite(relative) && relative > 0) {
    return new Date(Date.now() + relative * 1000);
  }

  throw new BosandaError("upstream_incompatible", {
    internalDetail: "provider token refresh body has no usable expiresAt or expiresIn",
  });
}

/**
 * The production `UpstreamTransport`: a thin `fetch` wrapper (§3 gate G2).
 *
 * Thin is the requirement, not a shortcut. The adapter owns EventStream framing,
 * the idle timeout, and abort propagation, so the only jobs here are to hand back
 * an UNBUFFERED byte stream and to not paper over a failure.
 *
 * ── WHY THE BODY IS NOT READ HERE ─────────────────────────────────────────
 * `response.body` is passed through as the raw stream. Calling `.text()` or
 * `.json()` first would buffer the whole upstream response before the adapter saw a
 * byte, which destroys time-to-first-byte and defeats §18 streaming end to end —
 * the customer would wait for the full completion and then receive it at once.
 *
 * ── WHY A TRANSPORT ERROR IS NOT CLASSIFIED HERE ──────────────────────────
 * A rejected `fetch` propagates as-is. The adapter distinguishes "failed before any
 * byte reached the client" from "failed mid-stream", and only it knows which side
 * of that line the request was on — the rule in §7/§16 is that a retry is allowed
 * only while zero bytes have been emitted. Classifying here would either lose that
 * distinction or duplicate the decision in a second place.
 *
 * A non-2xx status is NOT thrown: it is returned with `body` intact so the adapter
 * can read the upstream error payload and map it (a 429 from Kiro is a cooldown
 * signal, not a generic failure).
 */
export function createUpstreamTransport(fetchImpl: typeof fetch = fetch): UpstreamTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });

    return {
      status: response.status,
      // `Headers.get` is already case-insensitive, which is what the port requires.
      header: (name) => response.headers.get(name),
      // `ReadableStream` is async-iterable on Node ≥18, satisfying the port's
      // `AsyncIterable<Uint8Array>` without an adapter layer.
      body: response.body,
    };
  };
}
