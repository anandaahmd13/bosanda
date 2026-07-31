/**
 * Provider credential tests (PLAN.md §6 "Authentication data", §3 G0, §16, §17).
 *
 * This is the module where a mistake costs the most: it holds the only plaintext
 * provider tokens in the system. So the coverage here is organised around the
 * ways a secret escapes, not around the functions:
 *
 *  - CIPHERTEXT. Domain separation is tested by actually attempting a
 *    cross-purpose decrypt with a real keyring, not by comparing AAD constants.
 *    §16 says a provider ciphertext moved into the customer-API-key column must
 *    fail authentication; that only means something if it is executed.
 *  - ERROR MESSAGES. Every failure path is driven with a credential whose every
 *    field is a marker string, and the whole error (including `cause`, whose own
 *    message a Zod issue or cipher failure may carry) is searched for it. An
 *    error message is the easiest accidental exfiltration path for a secret.
 *  - CONCURRENCY. §3 G0.4 requires that N concurrent requests for one account
 *    produce exactly ONE upstream refresh, and G0.7 that two accounts never
 *    share. Both are tested by racing real promises and counting calls, because
 *    a single-flight bug is invisible to a sequential test.
 *  - THE LOST RACE. §6's compare-and-swap exists so the loser of a rotation race
 *    adopts the winner's token instead of persisting one the upstream already
 *    invalidated. That path is the one most likely to be wrong and least likely
 *    to be exercised in production before it matters.
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { SecretKeyring, SecretPurpose } from "@bosanda/config";
import { BosandaError } from "@bosanda/protocol";
import type { ProviderCredentials } from "@bosanda/provider-core";
import {
  CredentialManager,
  TOKEN_REFRESH_SKEW_MS,
  assertUsableCredentials,
  credentialEnvelopeVersion,
  describeCredentials,
  needsRefresh,
  openCredentials,
  sealCredentials,
  type CredentialStore,
  type RefreshResult,
} from "../src/credentials.js";

// --- fixtures ---------------------------------------------------------------

/**
 * Every secret-bearing field is a distinct marker, so a leak test can name which
 * field escaped rather than just that something did.
 */
const MARKERS = {
  refreshToken: "MARKER-REFRESH-TOKEN-a1",
  accessToken: "MARKER-ACCESS-TOKEN-b2",
  clientId: "MARKER-CLIENT-ID-c3",
  clientSecret: "MARKER-CLIENT-SECRET-d4",
  profileArn: "arn:aws:codewhisperer:us-east-1:MARKER-ACCOUNT-e5:profile/MARKER-PROFILE-f6",
} as const;

function credentials(overrides: Partial<ProviderCredentials> = {}): ProviderCredentials {
  return {
    authMethod: "social",
    refreshToken: MARKERS.refreshToken,
    accessToken: MARKERS.accessToken,
    accessTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    region: "us-east-1",
    profileArn: MARKERS.profileArn,
    clientId: null,
    clientSecret: null,
    persona: "cli",
    credentialVersion: 1,
    ...overrides,
  };
}

/**
 * A keyring with real random keys, one generation per purpose per version.
 *
 * `keys` is injectable so a rotation test can build two keyrings that differ
 * ONLY in currentVersion over the same key material — which is what a real key
 * rotation looks like. Without that, a "rotation" test compares two unrelated
 * random keyrings and proves nothing.
 */
function keyring(
  currentVersion = 1,
  versions: readonly number[] = [1],
  keys = new Map<string, Uint8Array>(),
): SecretKeyring {
  const keyAt = (purpose: SecretPurpose, version: number): Uint8Array => {
    const id = `${purpose}/${version}`;
    let key = keys.get(id);
    if (key === undefined) {
      key = new Uint8Array(randomBytes(32));
      keys.set(id, key);
    }
    return key;
  };
  return {
    currentVersion,
    keyFor: (purpose) => keyAt(purpose, currentVersion),
    keyForVersion: (purpose, version) => {
      if (!versions.includes(version)) {
        throw new Error(`key version ${version} for ${purpose} is not held`);
      }
      return keyAt(purpose, version);
    },
  };
}

/**
 * Serializes an error and everything reachable from it. `cause` matters most
 * here: a Zod issue or a cipher error carries its own message, and that is where
 * a leak would actually hide.
 */
function fullText(error: unknown): string {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string => {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "";
    seen.add(value);
    const parts: string[] = [];
    if (value instanceof Error) {
      parts.push(value.name, value.message, value.stack ?? "", walk(value.cause));
    }
    if (Array.isArray(value)) for (const item of value) parts.push(walk(item));
    for (const key of Object.keys(value)) {
      parts.push(key, walk((value as Record<string, unknown>)[key]));
    }
    return parts.join(" ");
  };
  return walk(error);
}

function expectNoMarkers(subject: string): void {
  for (const [field, marker] of Object.entries(MARKERS)) {
    expect(subject, `leaked ${field}`).not.toContain(marker);
  }
}

/** A store that records every call, so ordering and counts are assertable. */
function fakeStore(initial: ProviderCredentials | null = credentials()): CredentialStore & {
  loads: string[];
  persists: { accountId: string; expectedVersion: number; next: RefreshResult }[];
  state: ProviderCredentials | null;
  /** Set to make persistRefresh report a lost version race. */
  conflict: boolean;
} {
  return {
    loads: [],
    persists: [],
    state: initial,
    conflict: false,
    async load(accountId) {
      this.loads.push(accountId);
      return this.state;
    },
    async persistRefresh(accountId, expectedVersion, next) {
      this.persists.push({ accountId, expectedVersion, next });
      if (this.conflict) return null;
      if (this.state === null) return null;
      this.state = {
        ...this.state,
        accessToken: next.accessToken,
        accessTokenExpiresAt: next.accessTokenExpiresAt,
        refreshToken: next.refreshToken ?? this.state.refreshToken,
        credentialVersion: this.state.credentialVersion + 1,
      };
      return this.state;
    },
  };
}

const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const fixedClock = (now: Date) => ({ now: () => now });
const signal = () => new AbortController().signal;

// --- sealing and opening ----------------------------------------------------

describe("sealCredentials / openCredentials (§16)", () => {
  it("round-trips every field, including the Date", () => {
    const ring = keyring();
    const original = credentials({
      clientId: MARKERS.clientId,
      clientSecret: MARKERS.clientSecret,
    });
    const { envelope } = sealCredentials(original, ring);
    expect(openCredentials(envelope, ring)).toEqual(original);
  });

  it("round-trips nulls without turning them into empty strings", () => {
    // An empty-string token would pass a `!== null` check and be sent upstream.
    const ring = keyring();
    const sparse = credentials({
      refreshToken: null,
      accessToken: null,
      accessTokenExpiresAt: null,
      profileArn: null,
      authMethod: "api_key",
    });
    const opened = openCredentials(sealCredentials(sparse, ring).envelope, ring);
    expect(opened.refreshToken).toBeNull();
    expect(opened.accessToken).toBeNull();
    expect(opened.accessTokenExpiresAt).toBeNull();
    expect(opened.profileArn).toBeNull();
  });

  it("produces different ciphertext each time for identical input", () => {
    // A deterministic envelope would let database read access reveal that two
    // accounts share a token.
    const ring = keyring();
    const input = credentials();
    const envelopes = new Set(
      Array.from({ length: 20 }, () => sealCredentials(input, ring).envelope),
    );
    expect(envelopes.size).toBe(20);
  });

  it("stamps and reports the current key version", () => {
    const ring = keyring(3, [1, 2, 3]);
    const { envelope, keyVersion } = sealCredentials(credentials(), ring);
    expect(keyVersion).toBe(3);
    expect(envelope.startsWith("v3.")).toBe(true);
    expect(credentialEnvelopeVersion(envelope)).toBe(3);
  });

  it("opens an envelope sealed under an older still-held generation", () => {
    // Rotation must not orphan existing rows: a row sealed under v1 has to keep
    // opening after the current version moves to v2. Shared key material, so
    // this is a genuine cross-version decrypt rather than two unrelated rings.
    const material = new Map<string, Uint8Array>();
    const before = keyring(1, [1, 2], material);
    const sealed = sealCredentials(credentials(), before).envelope;

    const after = keyring(2, [1, 2], material);
    expect(credentialEnvelopeVersion(sealed)).toBe(1);
    expect(openCredentials(sealed, after)).toEqual(credentials());
    // And new writes go out under the new generation.
    expect(sealCredentials(credentials(), after).keyVersion).toBe(2);
  });

  it("stops opening a generation that has been retired", () => {
    // The other half of rotation: once v1 is removed from the keyring, a v1 row
    // must fail loudly rather than silently decrypt under v2's key.
    const material = new Map<string, Uint8Array>();
    const sealed = sealCredentials(credentials(), keyring(1, [1], material)).envelope;
    const retired = keyring(2, [2], material);
    expect(() => openCredentials(sealed, retired)).toThrow(/version 1/);
  });

  it("puts no plaintext in the envelope", () => {
    const { envelope } = sealCredentials(
      credentials({ clientId: MARKERS.clientId, clientSecret: MARKERS.clientSecret }),
      keyring(),
    );
    expectNoMarkers(envelope);
    // Also check the decoded ciphertext, in case base64url hid a substring.
    const parts = envelope.split(".");
    expectNoMarkers(Buffer.from(parts[2]!, "base64url").toString("latin1"));
  });

  it("fails authentication when opened with the customer-api-key purpose (§16)", () => {
    // The point of the distinct AAD and purpose: a provider ciphertext moved
    // into the customer-API-key column must NOT decrypt into a plausible value.
    // Executed, not asserted against a constant.
    const ring = keyring();
    const { envelope } = sealCredentials(credentials(), ring);
    const wrongPurpose: SecretKeyring = {
      currentVersion: ring.currentVersion,
      keyFor: () => ring.keyFor("customer-api-key"),
      keyForVersion: (_purpose, version) => ring.keyForVersion("customer-api-key", version),
    };
    expect(() => openCredentials(envelope, wrongPurpose)).toThrow(/failed authentication/);
  });

  it("fails authentication under a different keyring entirely", () => {
    const { envelope } = sealCredentials(credentials(), keyring());
    expect(() => openCredentials(envelope, keyring())).toThrow(/failed authentication/);
  });

  it("rejects a tampered ciphertext byte", () => {
    // AEAD, not just encryption: a flipped bit must fail rather than decrypt to
    // garbage that the schema might partially accept.
    const ring = keyring();
    const { envelope } = sealCredentials(credentials(), ring);
    const [version, nonce, ciphertext] = envelope.split(".");
    const bytes = Buffer.from(ciphertext!, "base64url");
    bytes[0] = bytes[0]! ^ 0x01;
    const tampered = `${version}.${nonce}.${bytes.toString("base64url")}`;
    expect(() => openCredentials(tampered, ring)).toThrow(/failed authentication/);
  });

  it("rejects a tampered nonce", () => {
    const ring = keyring();
    const { envelope } = sealCredentials(credentials(), ring);
    const [version, nonce, ciphertext] = envelope.split(".");
    const bytes = Buffer.from(nonce!, "base64url");
    bytes[0] = bytes[0]! ^ 0x01;
    expect(() =>
      openCredentials(`${version}.${bytes.toString("base64url")}.${ciphertext!}`, ring),
    ).toThrow(BosandaError);
  });

  it("rejects a malformed envelope shape", () => {
    const ring = keyring();
    for (const bad of ["", "notanenvelope", "v1.onlytwo", "v1.a.b.c", "1.a.b", "x1.a.b"]) {
      expect(() => openCredentials(bad, ring), bad).toThrow(BosandaError);
    }
  });

  it("rejects an invalid or zero key version", () => {
    const ring = keyring();
    for (const bad of ["v0.a.b", "v-1.a.b", "vabc.a.b", "v.a.b"]) {
      expect(() => openCredentials(bad, ring), bad).toThrow(/invalid key version|malformed/);
    }
  });

  it("rejects a nonce of the wrong length before attempting a decrypt", () => {
    const ring = keyring();
    const short = Buffer.alloc(8).toString("base64url");
    expect(() => openCredentials(`v1.${short}.${short}`, ring)).toThrow(/nonce must be 24 bytes/);
  });

  it("surfaces an unheld key version loudly rather than trying the current key", () => {
    // Silently falling back would report a confusing authentication failure and
    // could mask a premature key removal.
    const ring = keyring(1, [1]);
    const nonce = Buffer.alloc(24).toString("base64url");
    expect(() => openCredentials(`v7.${nonce}.AAAA`, ring)).toThrow(/version 7/);
  });

  it("rejects contents that decrypt but fail the schema", () => {
    // A hand-edited row must fail loudly, not produce a half-populated
    // credential that looks usable.
    const ring = keyring();
    const bogus = sealArbitrary({ authMethod: "social", region: "us-east-1" }, ring);
    expect(() => openCredentials(bogus, ring)).toThrow(/schema validation/);
  });

  it("rejects an empty-string token in the sealed contents", () => {
    // `.min(1)` matters: an empty token would pass a null check downstream.
    const ring = keyring();
    const bogus = sealArbitrary(
      { ...plain(credentials()), accessToken: "", refreshToken: "" },
      ring,
    );
    expect(() => openCredentials(bogus, ring)).toThrow(/schema validation/);
  });

  it("rejects a negative credentialVersion", () => {
    const ring = keyring();
    const bogus = sealArbitrary({ ...plain(credentials()), credentialVersion: -1 }, ring);
    expect(() => openCredentials(bogus, ring)).toThrow(/schema validation/);
  });

  it("rejects an unknown persona or authMethod", () => {
    const ring = keyring();
    for (const patch of [{ persona: "vscode" }, { authMethod: "oauth2" }]) {
      const bogus = sealArbitrary({ ...plain(credentials()), ...patch }, ring);
      expect(() => openCredentials(bogus, ring), JSON.stringify(patch)).toThrow(
        /schema validation/,
      );
    }
  });

  it("leaks nothing from any open() failure path, cause included (§17)", () => {
    const ring = keyring();
    const { envelope } = sealCredentials(
      credentials({ clientId: MARKERS.clientId, clientSecret: MARKERS.clientSecret }),
      ring,
    );
    const cases: string[] = [
      envelope, // opened under the wrong purpose, below
      "v1.short.short",
      `v1.${Buffer.alloc(24).toString("base64url")}.${Buffer.from(MARKERS.accessToken).toString("base64url")}`,
      sealArbitrary({ ...plain(credentials()), region: "" }, ring),
    ];
    const wrongPurpose: SecretKeyring = {
      currentVersion: 1,
      keyFor: () => ring.keyFor("customer-api-key"),
      keyForVersion: (_p, v) => ring.keyForVersion("customer-api-key", v),
    };
    for (const [index, candidate] of cases.entries()) {
      try {
        openCredentials(candidate, index === 0 ? wrongPurpose : ring);
        // Only the schema case may succeed; assert it did not.
        expect.unreachable(`case ${index} should have thrown`);
      } catch (error) {
        expect(error).toBeInstanceOf(BosandaError);
        expectNoMarkers(fullText(error));
      }
    }
  });

  it("classifies every envelope fault as internal_error, not a client error", () => {
    // A corrupt row is a Bosanda-side problem. Reporting it as invalid_request
    // would blame the customer and return a 400 for an operator's mistake.
    const ring = keyring();
    for (const bad of ["", "v1.a.b", "v0.a.b"]) {
      try {
        openCredentials(bad, ring);
        expect.unreachable("expected a throw");
      } catch (error) {
        expect((error as BosandaError).code).toBe("internal_error");
        expect((error as BosandaError).status).toBe(500);
      }
    }
  });
});

/** Seals arbitrary JSON with the provider purpose, to test the open() guards. */
function sealArbitrary(contents: unknown, ring: SecretKeyring): string {
  // Mirrors sealCredentials' envelope construction so only the CONTENTS differ.
  const real = sealCredentials(credentials(), ring);
  const nonce = real.envelope.split(".")[1]!;
  // Re-encrypting under the same nonce is fine here: this is a test fixture
  // exercising a decode path, not a production write.
  const sealed = xchacha20poly1305(
    ring.keyFor("provider-credentials"),
    new Uint8Array(Buffer.from(nonce, "base64url")),
    new TextEncoder().encode("bosanda/provider-credentials/v1"),
  ).encrypt(new TextEncoder().encode(JSON.stringify(contents)));
  return `v${ring.currentVersion}.${nonce}.${Buffer.from(sealed).toString("base64url")}`;
}

function plain(source: ProviderCredentials): Record<string, unknown> {
  return {
    authMethod: source.authMethod,
    refreshToken: source.refreshToken,
    accessToken: source.accessToken,
    accessTokenExpiresAt: source.accessTokenExpiresAt?.toISOString() ?? null,
    region: source.region,
    profileArn: source.profileArn,
    clientId: source.clientId,
    clientSecret: source.clientSecret,
    persona: source.persona,
    credentialVersion: source.credentialVersion,
  };
}

describe("credentialEnvelopeVersion", () => {
  it("reads the version without decrypting", () => {
    expect(credentialEnvelopeVersion("v4.abc.def")).toBe(4);
  });

  it("returns null for anything unparseable", () => {
    for (const bad of ["", "abc", "1.a.b", "v.a.b", "vx.a.b", "v0.a.b", "v-2.a.b"]) {
      expect(credentialEnvelopeVersion(bad), bad).toBeNull();
    }
  });
});

// --- validation -------------------------------------------------------------

describe("assertUsableCredentials (§3 G0.1, G0.2)", () => {
  it("accepts a well-formed social credential", () => {
    expect(() => assertUsableCredentials(credentials())).not.toThrow();
  });

  it("accepts a static api_key credential with no refresh token", () => {
    expect(() =>
      assertUsableCredentials(
        credentials({ authMethod: "api_key", refreshToken: null, accessTokenExpiresAt: null }),
      ),
    ).not.toThrow();
  });

  it("requires a clientId for idc auth", () => {
    expect(() => assertUsableCredentials(credentials({ authMethod: "idc" }))).toThrow(
      /idc auth requires clientId/,
    );
    expect(() =>
      assertUsableCredentials(credentials({ authMethod: "idc", clientId: MARKERS.clientId })),
    ).not.toThrow();
  });

  it("rejects a credential with no token of any kind", () => {
    expect(() =>
      assertUsableCredentials(
        credentials({ refreshToken: null, accessToken: null, accessTokenExpiresAt: null }),
      ),
    ).toThrow(/neither a refresh token nor an access token/);
  });

  it("rejects an expiring access token with no way to renew it", () => {
    // Otherwise the account works until the token expires and then fails on a
    // paying customer's request.
    expect(() => assertUsableCredentials(credentials({ refreshToken: null }))).toThrow(
      /no refresh token to renew it/,
    );
  });

  it("reports every problem at once", () => {
    try {
      assertUsableCredentials(
        credentials({ authMethod: "idc", clientId: null, refreshToken: null, accessToken: null }),
      );
      expect.unreachable("expected a throw");
    } catch (error) {
      const detail = (error as BosandaError).internalDetail ?? "";
      expect(detail).toContain("idc auth requires clientId");
      expect(detail).toContain("neither a refresh token");
    }
  });

  it("names the defect without quoting any value (§17)", () => {
    try {
      assertUsableCredentials(credentials({ authMethod: "idc" }));
      expect.unreachable("expected a throw");
    } catch (error) {
      expectNoMarkers(fullText(error));
    }
  });
});

describe("needsRefresh", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");

  it("refreshes when there is no access token", () => {
    expect(needsRefresh(credentials({ accessToken: null }), now)).toBe(true);
  });

  it("does not refresh a token expiring comfortably later", () => {
    expect(needsRefresh(credentials({ accessTokenExpiresAt: FUTURE }), now)).toBe(false);
  });

  it("refreshes a token already expired", () => {
    expect(
      needsRefresh(credentials({ accessTokenExpiresAt: new Date(now.getTime() - 1) }), now),
    ).toBe(true);
  });

  it("refreshes inside the skew window, so a request does not race the expiry", () => {
    const justInside = new Date(now.getTime() + TOKEN_REFRESH_SKEW_MS - 1_000);
    const justOutside = new Date(now.getTime() + TOKEN_REFRESH_SKEW_MS + 1_000);
    expect(needsRefresh(credentials({ accessTokenExpiresAt: justInside }), now)).toBe(true);
    expect(needsRefresh(credentials({ accessTokenExpiresAt: justOutside }), now)).toBe(false);
  });

  it("treats the exact skew boundary as needing a refresh", () => {
    const boundary = new Date(now.getTime() + TOKEN_REFRESH_SKEW_MS);
    expect(needsRefresh(credentials({ accessTokenExpiresAt: boundary }), now)).toBe(true);
  });

  it("refreshes an unknown-expiry token when a refresh token exists", () => {
    expect(
      needsRefresh(credentials({ accessTokenExpiresAt: null, authMethod: "social" }), now),
    ).toBe(true);
  });

  it("does not refresh a static api_key credential with no recorded expiry", () => {
    // There is nothing to refresh, and trying would fail every request.
    expect(
      needsRefresh(
        credentials({ authMethod: "api_key", accessTokenExpiresAt: null, refreshToken: null }),
        now,
      ),
    ).toBe(false);
    expect(
      needsRefresh(credentials({ authMethod: "api_key", accessTokenExpiresAt: null }), now),
    ).toBe(false);
  });

  it("does not refresh an unknown-expiry token with no refresh token", () => {
    expect(needsRefresh(credentials({ accessTokenExpiresAt: null, refreshToken: null }), now)).toBe(
      false,
    );
  });
});

// --- CredentialManager ------------------------------------------------------

describe("CredentialManager.access", () => {
  const refreshed = (token = "fresh-access-token"): RefreshResult => ({
    accessToken: token,
    accessTokenExpiresAt: FUTURE,
  });

  it("returns a valid credential without refreshing", async () => {
    const store = fakeStore();
    let refreshes = 0;
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        refreshes += 1;
        return refreshed();
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    const result = await manager.access("acct_1", signal());
    expect(result.accessToken).toBe(MARKERS.accessToken);
    expect(refreshes).toBe(0);
    expect(store.persists).toEqual([]);
  });

  it("refreshes an expired token and persists the result", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const manager = new CredentialManager({
      store,
      refresher: async () => refreshed(),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    const result = await manager.access("acct_1", signal());
    expect(result.accessToken).toBe("fresh-access-token");
    expect(store.persists).toHaveLength(1);
  });

  it("compare-and-swaps on the version it read (§6, §3 G0.3)", async () => {
    // Passing anything other than the observed version defeats the guard.
    const store = fakeStore(
      credentials({ accessTokenExpiresAt: new Date("2020-01-01"), credentialVersion: 7 }),
    );
    const manager = new CredentialManager({
      store,
      refresher: async () => refreshed(),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await manager.access("acct_1", signal());
    expect(store.persists[0]!.expectedVersion).toBe(7);
  });

  it("collapses concurrent access into exactly one refresh (§3 G0.4)", async () => {
    // The gate requirement. A sequential test cannot detect a single-flight bug.
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    let refreshes = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        refreshes += 1;
        await gate;
        return refreshed();
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });

    const inflight = Array.from({ length: 8 }, () => manager.access("acct_1", signal()));
    await Promise.resolve();
    release?.();
    const results = await Promise.all(inflight);

    expect(refreshes).toBe(1);
    expect(store.persists).toHaveLength(1);
    for (const result of results) expect(result.accessToken).toBe("fresh-access-token");
  });

  it("refreshes two accounts in parallel without sharing state (§3 G0.7)", async () => {
    const stores = new Map<string, ProviderCredentials>([
      [
        "acct_a",
        credentials({ accessTokenExpiresAt: new Date("2020-01-01"), region: "us-east-1" }),
      ],
      [
        "acct_b",
        credentials({ accessTokenExpiresAt: new Date("2020-01-01"), region: "eu-west-1" }),
      ],
    ]);
    const seen: string[] = [];
    const manager = new CredentialManager({
      store: {
        async load(accountId) {
          return stores.get(accountId) ?? null;
        },
        async persistRefresh(accountId, _version, next) {
          const current = stores.get(accountId)!;
          const updated = { ...current, accessToken: next.accessToken };
          stores.set(accountId, updated);
          return updated;
        },
      },
      refresher: async (current) => {
        seen.push(current.region);
        return refreshed(`token-for-${current.region}`);
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });

    const [a, b] = await Promise.all([
      manager.access("acct_a", signal()),
      manager.access("acct_b", signal()),
    ]);
    expect(seen.sort()).toEqual(["eu-west-1", "us-east-1"]);
    expect(a.accessToken).toBe("token-for-us-east-1");
    expect(b.accessToken).toBe("token-for-eu-west-1");
  });

  it("re-reads inside the lock and skips a refresh another caller completed", async () => {
    // Without the re-read, the second caller refreshes a token that is already
    // fresh, burning an upstream call and possibly rotating a valid token away.
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    let refreshes = 0;
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        refreshes += 1;
        return refreshed();
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await manager.access("acct_1", signal());
    await manager.access("acct_1", signal());
    expect(refreshes).toBe(1);
  });

  it("does not poison later attempts after a failed refresh", async () => {
    // singleFlight clears its slot on rejection; if it did not, one transient
    // failure would wedge the account permanently.
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    let attempts = 0;
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient upstream failure");
        return refreshed();
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await expect(manager.access("acct_1", signal())).rejects.toThrow(BosandaError);
    await expect(manager.access("acct_1", signal())).resolves.toMatchObject({
      accessToken: "fresh-access-token",
    });
  });

  it("raises not_found for an unknown account", async () => {
    const manager = new CredentialManager({
      store: fakeStore(null),
      refresher: async () => refreshed(),
    });
    try {
      await manager.access("acct_missing", signal());
      expect.unreachable("expected not_found");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.code).toBe("not_found");
      expect(bosanda.providerAccountId).toBe("acct_missing");
    }
  });

  it("raises authentication_error when a stale token has no refresh token", async () => {
    // §7 escalates authentication_error to disabling the account until admin
    // action, and it is NOT provider-retryable, so the scheduler will not burn
    // the whole pool on the same bad-credential path.
    const store = fakeStore(
      credentials({ refreshToken: null, accessTokenExpiresAt: new Date("2020-01-01") }),
    );
    const manager = new CredentialManager({
      store,
      refresher: async () => refreshed(),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    try {
      await manager.access("acct_1", signal());
      expect.unreachable("expected authentication_error");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.code).toBe("authentication_error");
      expect(bosanda.isProviderRetryable).toBe(false);
      expect(bosanda.shouldCooldownProvider).toBe(false);
    }
  });

  it("classifies an unclassified refresher failure as authentication_error", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await expect(manager.access("acct_1", signal())).rejects.toMatchObject({
      code: "authentication_error",
    });
  });

  it("preserves a BosandaError the refresher already classified", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const original = new BosandaError("rate_limit", { internalDetail: "token endpoint throttled" });
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        throw original;
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await expect(manager.access("acct_1", signal())).rejects.toBe(original);
  });

  it("keeps the upstream body out of a refresh failure (§12/§16)", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        throw new Error(`token endpoint said: ${MARKERS.refreshToken}`);
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    try {
      await manager.access("acct_1", signal());
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as BosandaError).internalDetail).not.toContain(MARKERS.refreshToken);
    }
  });

  it("passes the caller's signal to the refresher", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const manager = new CredentialManager({
      store,
      refresher: async (_credentials, signalIn) => {
        received = signalIn;
        return refreshed();
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await manager.access("acct_1", controller.signal);
    expect(received).toBe(controller.signal);
  });

  it("persists a rotated refresh token when upstream supplies one", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const manager = new CredentialManager({
      store,
      refresher: async () => ({
        accessToken: "fresh",
        accessTokenExpiresAt: FUTURE,
        refreshToken: "rotated-refresh-token",
      }),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    const result = await manager.access("acct_1", signal());
    expect(store.persists[0]!.next.refreshToken).toBe("rotated-refresh-token");
    expect(result.refreshToken).toBe("rotated-refresh-token");
  });

  it("keeps the existing refresh token when upstream did not rotate", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const manager = new CredentialManager({
      store,
      refresher: async () => refreshed(),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    const result = await manager.access("acct_1", signal());
    expect(result.refreshToken).toBe(MARKERS.refreshToken);
  });
});

describe("CredentialManager — the lost version race (§6, §3 G0.3)", () => {
  it("adopts the winner's credential instead of overwriting it", async () => {
    // Our token may already be invalidated upstream, so persisting it would
    // leave the account holding a dead token.
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    store.conflict = true;
    const outcomes: string[] = [];
    let loads = 0;
    const manager = new CredentialManager({
      store: {
        async load(accountId) {
          loads += 1;
          // The third load is the post-conflict reload: by then the winner has
          // written a fresh token.
          return loads >= 3
            ? credentials({ accessToken: "winner-token", accessTokenExpiresAt: FUTURE })
            : store.load(accountId);
        },
        persistRefresh: async () => null,
      },
      refresher: async () => ({ accessToken: "loser-token", accessTokenExpiresAt: FUTURE }),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
      onRefresh: (event) => outcomes.push(event.outcome),
    });

    const result = await manager.access("acct_1", signal());
    expect(result.accessToken).toBe("winner-token");
    expect(outcomes).toEqual(["conflict"]);
  });

  it("fails rather than looping when the reloaded credential is still stale", async () => {
    // A retry loop here would hammer the token endpoint; failing hands the
    // decision to §7.
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    store.conflict = true;
    const manager = new CredentialManager({
      store,
      refresher: async () => ({ accessToken: "loser", accessTokenExpiresAt: FUTURE }),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await expect(manager.access("acct_1", signal())).rejects.toMatchObject({
      code: "authentication_error",
    });
  });
});

describe("CredentialManager.forceRefresh", () => {
  it("refreshes even when the current token is still valid", async () => {
    const store = fakeStore();
    let refreshes = 0;
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        refreshes += 1;
        return { accessToken: "forced", accessTokenExpiresAt: FUTURE };
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    const result = await manager.forceRefresh("acct_1", signal());
    expect(refreshes).toBe(1);
    expect(result.accessToken).toBe("forced");
  });

  it("is still collapsed per account", async () => {
    const store = fakeStore();
    let refreshes = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new CredentialManager({
      store,
      refresher: async () => {
        refreshes += 1;
        await gate;
        return { accessToken: "forced", accessTokenExpiresAt: FUTURE };
      },
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    const inflight = Array.from({ length: 5 }, () => manager.forceRefresh("acct_1", signal()));
    await Promise.resolve();
    release?.();
    await Promise.all(inflight);
    expect(refreshes).toBe(1);
  });
});

describe("onRefresh telemetry (§17)", () => {
  it("reports success, failure, and conflict without token material", async () => {
    const events: { accountId: string; outcome: string }[] = [];
    const push = (event: { accountId: string; outcome: string }) => events.push(event);

    const ok = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    await new CredentialManager({
      store: ok,
      refresher: async () => ({ accessToken: "fresh", accessTokenExpiresAt: FUTURE }),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
      onRefresh: push,
    }).access("acct_ok", signal());

    const bad = fakeStore(
      credentials({ refreshToken: null, accessTokenExpiresAt: new Date("2020-01-01") }),
    );
    await new CredentialManager({
      store: bad,
      refresher: async () => ({ accessToken: "x", accessTokenExpiresAt: FUTURE }),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
      onRefresh: push,
    })
      .access("acct_bad", signal())
      .catch(() => undefined);

    expect(events.map((event) => event.outcome)).toEqual(["success", "failure"]);
    expectNoMarkers(JSON.stringify(events));
    for (const event of events) expect(Object.keys(event).sort()).toEqual(["accountId", "outcome"]);
  });

  it("runs without a callback configured", async () => {
    const store = fakeStore(credentials({ accessTokenExpiresAt: new Date("2020-01-01") }));
    const manager = new CredentialManager({
      store,
      refresher: async () => ({ accessToken: "fresh", accessTokenExpiresAt: FUTURE }),
      clock: fixedClock(new Date("2026-07-31T12:00:00.000Z")),
    });
    await expect(manager.access("acct_1", signal())).resolves.toBeDefined();
  });
});

// --- describeCredentials ----------------------------------------------------

describe("describeCredentials (§15, §17)", () => {
  it("replaces every secret with a presence flag", () => {
    const described = describeCredentials(
      credentials({ clientId: MARKERS.clientId, clientSecret: MARKERS.clientSecret }),
    );
    expect(described).toEqual({
      authMethod: "social",
      persona: "cli",
      region: "us-east-1",
      hasRefreshToken: true,
      hasAccessToken: true,
      hasProfileArn: true,
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      credentialVersion: 1,
    });
  });

  it("leaks no marker, including the ARN (§17)", () => {
    // The ARN is omitted entirely rather than redacted: it identifies a provider
    // account, which is exactly what must not appear in the admin UI or a log.
    const described = describeCredentials(
      credentials({ clientId: MARKERS.clientId, clientSecret: MARKERS.clientSecret }),
    );
    expectNoMarkers(JSON.stringify(described));
    expect(JSON.stringify(described)).not.toContain("arn:aws");
  });

  it("exposes no key beyond the documented shape", () => {
    // A future field added to ProviderCredentials must not flow through here by
    // accident, so the key set is pinned.
    expect(Object.keys(describeCredentials(credentials())).sort()).toEqual([
      "accessTokenExpiresAt",
      "authMethod",
      "credentialVersion",
      "hasAccessToken",
      "hasProfileArn",
      "hasRefreshToken",
      "persona",
      "region",
    ]);
  });

  it("reports absence as false and a null expiry as null", () => {
    const described = describeCredentials(
      credentials({
        refreshToken: null,
        accessToken: null,
        profileArn: null,
        accessTokenExpiresAt: null,
        authMethod: "api_key",
      }),
    );
    expect(described.hasRefreshToken).toBe(false);
    expect(described.hasAccessToken).toBe(false);
    expect(described.hasProfileArn).toBe(false);
    expect(described.accessTokenExpiresAt).toBeNull();
  });

  it("formats the expiry as ISO-8601 UTC (§14)", () => {
    const described = describeCredentials(
      credentials({ accessTokenExpiresAt: new Date(Date.UTC(2026, 6, 31, 12, 0, 0)) }),
    );
    expect(described.accessTokenExpiresAt).toBe("2026-07-31T12:00:00.000Z");
  });
});
