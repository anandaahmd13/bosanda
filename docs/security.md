# Security model

The PLAN.md §16 model as actually built, plus an honest account of what it does
not cover. Written against the code in `packages/config`, `packages/shared`,
`packages/protocol`, and `packages/observability`.

Nothing here has been penetration-tested. Claims about _design_ reflect the code
as read; claims about _runtime behaviour on the VPS_ are unverified and marked.

## What protects what

| Data                              | Treatment                                  | Key / mechanism                                                  |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Website passwords                 | **Hashed**, never recoverable              | Argon2id (`@node-rs/argon2`)                                     |
| Customer API keys                 | **Both** hashed and encrypted              | `API_KEY_LOOKUP_SECRET` (HMAC) + `API_KEY_ENCRYPTION_KEY` (AEAD) |
| Kiro provider credentials         | **Encrypted**, authenticated               | `PROVIDER_ENCRYPTION_KEY`, XChaCha20-Poly1305                    |
| Session cookies                   | **Signed**                                 | `SESSION_SECRET`                                                 |
| Pakasir webhooks                  | **Verified**                               | `PAKASIR_WEBHOOK_SECRET`                                         |
| Prompts, responses, tool payloads | **Neither** — not stored at all            | §16 privacy                                                      |
| Usage, ledger, audit rows         | **Plaintext** — operational data by design | Row-level access via app only                                    |

### Why customer keys are both hashed and encrypted

This looks redundant and is not. The two operations serve different reads (§12):

```
lookup_digest = HMAC-SHA-256(API_KEY_LOOKUP_SECRET, plaintext_key)
ciphertext    = XChaCha20-Poly1305(API_KEY_ENCRYPTION_KEY, plaintext_key)
```

- The **digest** authenticates a request. It is deterministic, so an incoming key
  can be looked up with one indexed query. It is keyed rather than a bare hash so
  that stealing the database does not let an attacker brute-force short keys
  offline without also stealing the HMAC secret.
- The **ciphertext** exists only so the dashboard eye toggle can show a customer
  their own key later (§12). Authentication never touches it.

Consequences worth knowing: losing `API_KEY_ENCRYPTION_KEY` breaks _reveal_ but
not _auth_. Losing `API_KEY_LOOKUP_SECRET` invalidates **every live key at once**,
because nothing will hash to a stored digest.

The eye toggle requires only a valid session — **no password re-entry**. §12 names
this a known tradeoff and it is: anyone with a hijacked session can read the
customer's keys. Mitigations are session hygiene (rotation after login, HTTP-only
same-site cookies) and the 24-hour key lifetime, not the toggle itself. Key
reveals are audited.

### Why the five secrets must be distinct

`assertSecretsAreDistinct()` in `packages/config/src/env.ts` throws `ConfigError`
and refuses to boot if any two of `PROVIDER_ENCRYPTION_KEY`,
`API_KEY_ENCRYPTION_KEY`, `API_KEY_LOOKUP_SECRET`, `SESSION_SECRET`,
`PAKASIR_WEBHOOK_SECRET` share a value.

This is enforced rather than documented because reuse collapses the blast radius
into one: a single leaked value would compromise credential encryption, key
lookup, sessions, and payment verification simultaneously. Four must be 32-byte
base64; the Pakasir secret is whatever Pakasir issues (min 16 chars).

Secret _values_ never appear in an error message — only variable names. That is
deliberate in the config layer and must stay that way.

### Versioned keys

Every encrypted row records `encryption_key_version`, and
`keyringFromEnv().keyForVersion()` throws on an unknown version rather than
silently returning wrong plaintext. Loud failure over silent corruption.

Note the current limit honestly: the keyring holds **one generation per purpose**,
so rotation needs a code change first. Full procedure and its prerequisites:
`scripts/rotate-keys.md`.

## What is never logged

Enforced in two independent layers, because one layer is a single point of
failure. `packages/shared/src/redact.ts` deep-redacts by key name before
serialization; `packages/observability/src/logger.ts` additionally configures
pino's own `redact` paths over the final object.

Never logged (§16 privacy, §17):

- Bosanda API keys, in whole or in part — a prefix of a secret is still a secret
- Kiro refresh tokens, access tokens, OIDC client secrets, profile ARNs
- Cookies and `Authorization` headers
- Pakasir secrets
- Prompt and response text
- Tool inputs and tool results
- Local filesystem paths (`scrubPaths`) and raw upstream payloads
- Stack traces are dropped from logged `Error` objects — they reliably leak paths

Deliberately **kept**: token _counts_. `inputTokens`, `weightedTokens` and
friends are operational metrics §17 requires; redacting them would blind usage
debugging. The redactor's key list excludes a bare `token` substring for exactly
this reason.

Request headers use an **allowlist**, not a denylist: unknown headers are dropped
and reported by name only, so an unexpected header is visible without its value
ever being written.

Metrics labels must stay low-cardinality — never a request ID, API key, or user
ID, or the in-process registry grows unbounded. That is a memory-safety rule as
much as a privacy one.

## The error boundary

Only `BosandaError.publicMessage` crosses to a client. `internalDetail` is
operator-only. The public message is derived from the error _code_ alone
(`PUBLIC_MESSAGE` in `packages/protocol/src/errors.ts`), so no upstream text,
credential, or payload can reach a client by interpolation.

This is why the taxonomy is closed: a provider failure becomes
`upstream_incompatible` → "The upstream provider returned an incompatible
response." The client learns the shape of the failure and nothing about our
infrastructure, provider identity, or account IDs.

## Admin / user isolation

Two separate origins, two separate Next apps, two separate systemd units, two
separate env files:

- `bosanda.dev` (`bosanda-web`, port 3000) — customers. Gets `SESSION_SECRET`
  and `DATABASE_URL`. Never decrypts Kiro credentials.
- `admin.bosanda.dev` (`bosanda-admin`, port 3001) — operators. Gets
  `API_KEY_ENCRYPTION_KEY` because §15 requires ledger inspection and §12
  requires key management.

Separate origins mean separate cookie scopes: a customer session cookie is not
sent to the admin host. `www` folds into the apex on HTTPS specifically so there
is only ever one session origin.

Admin capabilities are the reason this boundary matters: setting a password,
revoking keys, adjusting stock, reading the ledger. Every one of those is audited
with actor, target, timestamp, and reason (§12). Admin must never be able to read
a prompt — §15 says "inspect quota ledger without exposing prompts", and since
prompts are not stored, that holds structurally rather than by permission check.

Additional hardening available and **not enabled by default**: an IP allowlist or
VPN-only bind on the admin vhost (§16). The stanza is written and commented out in
`deploy/nginx/sites-available/admin.bosanda.dev.conf`. It is disabled because a
wrong value locks the sole operator out of their own admin panel with no recovery
channel — see Residual risk. **OWNER**: enable it, preferably as a WireGuard-only
bind, and test from mobile data before closing your SSH session.

Admin bootstrap is a one-time CLI command and must not silently create a second
initial admin (§19). The operator procedure is [`docs/admin-access.md`](./admin-access.md).

The Next admin proxy owns the Content Security Policy and adds a per-request nonce.
nginx must not emit a second CSP header; browsers enforce multiple policies as an
intersection. Development React tooling allows `unsafe-eval` only outside
production, while the production proxy remains strict.

## Abuse and rate limiting

Two layers, with different jobs.

**Authoritative, per API key, in the gateway (§7):**

- 100 requests/minute (`KEY_MAX_REQUESTS_PER_MINUTE`) → `rate_limit` 429
- 5 concurrent requests (`KEY_MAX_ACTIVE_REQUESTS`) → `concurrency_limit` 429
- Zero or negative quota → `quota_exhausted` 429

**Defence in depth, per IP, at the nginx edge:** deliberately _looser_ than the
per-key limits (300 r/m, 60 concurrent connections on the API vhost). nginx
cannot see the API key without parsing `Authorization`, and we do not want key
material in nginx memory or logs, so the edge limits by IP only. Its job is to
blunt an unauthenticated flood before it reaches Node — a legitimate customer must
never hit it first. Auth endpoints get a tighter bucket (§12), tightest of all on
admin login.

`nodelay` is used throughout: _delaying_ a streaming request looks identical to a
hang, so the edge rejects or admits rather than queues.

Parser safety (§16), enforced at decode time before any provider work:
`LIMITS.maxBodyBytes` = 8 MB, ≤400 messages, ≤3 M history chars, ≤128 tools,
bounded tool name/description/schema sizes, ≤128 k output tokens.
`client_max_body_size 8m` in the API vhost is set equal to `maxBodyBytes` on
purpose — if nginx were smaller, the gateway's protocol-shaped 400 would never
fire and clients would get nginx's HTML 413 instead.

Timeouts: 15 s for headers and body (slowloris), 5 s upstream connect, 600 s
upstream read to match `UPSTREAM_HARD_TIMEOUT_MS`, plus a 120 s idle timeout in
the gateway. Short where a delay means an attack, generous where a delay is a
legitimately long model turn.

Abort propagation matters commercially as well as technically: a dropped client
connection aborts the upstream fetch, which stops burning provider credit.

## Network posture

- PostgreSQL listens on localhost only and is never publicly reachable (§16).
- All three app processes bind `127.0.0.1`. nginx is the sole entry point; a Next
  app on `0.0.0.0` would bypass every header and rate limit in the vhost.
- TLS 1.2+, forward-secrecy-only cipher suites, HSTS (2 years, subdomains, no
  preload — preload is close to irreversible and must be a deliberate choice).
- TLS certificate validation on outbound calls is mandatory, and there is no
  implicit fallback from a configured proxy to direct egress (§16).
- Egress allowlisting to required Kiro and Pakasir hosts: **NOT YET
  IMPLEMENTED**. §16 says "where practical"; no firewall rules ship in this
  repository.
- CSP is strict with no `unsafe-inline` for scripts, but see the caveat below.

### The CSP caveat, stated plainly

Next.js emits inline hydration scripts, so a nonce-free strict CSP **will** break
the apps. The vhost headers are a fallback for responses the app did not set a CSP
on. Because `add_header` does not overwrite an upstream header of the same name, if
the Next app also sends a CSP the browser receives both and enforces the
intersection — which would break the nonce policy.

**OWNER ACTION, pick one before launch:** either the Next app owns CSP (delete the
`add_header` line) or nginx owns it (the app must not send the header, and you
accept `unsafe-inline` for scripts, which is weaker and not recommended). This is
**unverified** — no Next app was built or served during this work.

## Process hardening

Each service runs as a dedicated non-root user under systemd with
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`PrivateDevices`, an empty `CapabilityBoundingSet`, a `@system-service` syscall
filter, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, and explicit
`MemoryMax`/`LimitNOFILE`.

`MemoryDenyWriteExecute` is **false** and must stay false: V8's JIT needs W|X
pages and setting it true crashes Node at startup. It is annotated in every unit
so nobody "hardens" it later and breaks boot.

Env files are root-owned `0640` with the service group. systemd reads them as root
_before_ dropping to `User=`, so the service user needs read access only. Secrets
are never inherited by arbitrary subprocesses, and v1 needs no Kiro subprocess at
all (§16) — the Direct Adapter is HTTP, not a spawned CLI.

Backups run as a _separate_ `bosanda-backup` user so that compromising the gateway
does not grant the ability to destroy backups.

**NOT VERIFIED:** `systemd-analyze verify` has not been run — no systemd was
available where these units were authored. Run it on the VPS before trusting any
of the above.

## Secret rotation

Summary; full procedure in `scripts/rotate-keys.md`.

The invariant that prevents data loss: **add the new key, re-encrypt, then retire
the old key last — and only after proving nothing references it.**

- `SESSION_SECRET` — rotate freely, nothing to re-encrypt, everyone logs out.
  Also a fast containment action during a session-hijack incident.
- `PROVIDER_ENCRYPTION_KEY`, `API_KEY_ENCRYPTION_KEY` — need multi-generation
  keyring support (a code change) plus a batched re-encryption job. Neither
  exists yet.
- `API_KEY_LOOKUP_SECRET` — not a normal rotation. Recomputing digests requires
  the plaintext keys, recoverable only via `API_KEY_ENCRYPTION_KEY`. Given the
  24-hour key lifetime, revoking and reissuing is usually cheaper.
- Retired keys are **archived, not destroyed** — backups predating the rotation
  still need them.

## Residual risk

Honest accounting. None of these are hypothetical; all are consequences of
deliberate v1 scope choices.

**Single VPS.** No redundancy anywhere. One box runs nginx, both Next apps, the
gateway, the worker, and PostgreSQL. Any of a disk failure, a bad kernel upgrade,
a provider outage, or a full disk is a total outage. There is no failover and RTO
is however long a manual rebuild takes. A full disk is the most likely
self-inflicted version — journald and nginx logs are not capped by this
repository.

**Single operator.** No on-call rotation, no second pair of eyes on a destructive
command, and no separation of duties: the person who can deploy is the person who
can read the ledger and set passwords. Recovery depends on one human being awake
and reachable. Every playbook in `docs/incident-response.md` assumes that human.

**No HSM or KMS.** All five secrets sit in plaintext in root-owned files on the
same box that serves traffic. Root on that box is game over: provider
credentials, customer key ciphertext, and the keys to decrypt it are all
co-located. A KMS or HSM would keep key _use_ separable from key _possession_;
we have no such separation. The GPG-encrypted backups are the one place this is
mitigated, because the private half stays offline.

**Undocumented upstream.** The largest structural risk, and it is a business risk
as much as a technical one (§2). The Kiro generation endpoint and wire protocol
are not a documented public API; parts were reconstructed from observed traffic.
It can break without notice, and a successful integration does not establish
permission for resale or account pooling. The owner must review the Kiro terms and
accept or resolve that risk before launch (§21 item 12). Kill switches exist
precisely because this will eventually break.

**No email channel.** Account recovery is a human conversation over a published
support channel, with identity verification as an operational judgement call
(§12). That is a social-engineering surface with no technical mitigation: an
attacker who convincingly impersonates a customer gets a password reset. It also
means there is no out-of-band way to notify customers during an incident, and no
way to reach the operator if the admin panel is unreachable — which is why the
admin IP allowlist ships disabled.

**Manual recovery throughout.** Stock, provider accounts, refunds, stuck orders,
and Kiro credit reconciliation are all manual. Bosanda explicitly does not claim
its weighted-token ledger equals Kiro billing (§10). Drift is expected and
detected by inspection, not automatically.

**No alerting.** §17 lists eight alert conditions. None are wired to a
notification channel. Detection currently depends on the operator running
`scripts/healthcheck.sh` or looking at the dashboard. A failure at 03:00 is
noticed whenever someone next looks.

**Untested in production.** No nginx config has been loaded by nginx, no systemd
unit has been verified by systemd, no script has been executed, and the M0
compatibility gate (§3) has not been passed. Treat every deployment artifact in
`deploy/` and `scripts/` as a reviewed draft, not a proven configuration.

**Hidden-retry credit consumption.** Retrying onto another account before first
output can consume upstream credit twice if the first account accepted the prompt
then failed (§7). Bounded and measured, but real, and it costs money rather than
correctness.

**Bounded quota overage.** Up to 5 concurrent streams may each finish past a zero
balance (§10), because Bosanda will not cut a stream mid-token. Negative balances
are expected and bounded, not a bug.
