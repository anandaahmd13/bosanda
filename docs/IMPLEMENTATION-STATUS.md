# Implementation status & binding contracts

Read this before writing code. It records what already exists and the contracts
that are **frozen** — do not redefine, re-export, or "improve" them, or parallel
work will conflict.

## Toolchain (already installed at the repo root — do NOT run `pnpm add`)

pnpm 11 workspace, Node 25, ESM everywhere (`"type": "module"`).
Installed: `zod@4.4.3`, `postgres@3.4.9`, `pino@10.3.1`, `pino-pretty@13.1.3`,
`fastify@5.11.0`, `@fastify/{cookie,cors,helmet,rate-limit}`,
`@noble/ciphers@2.2.0`, `@node-rs/argon2@2.0.2`, `undici@8.9.0`,
`next@16.2.12`, `react@19.2.8`, `recharts@3.10.1`, `typescript@5.9.3`,
`vitest@4.1.10`, `tsx`, `eslint@9`, `prettier@3.9.6`.

If you genuinely need a new dependency, say so in your report instead of
installing it — a concurrent `pnpm add` corrupts the lockfile.

Verify with `pnpm verify`; run `pnpm run audit:prod` for the production dependency audit.

## Conventions

- Import siblings via the `@bosanda/*` aliases (wired in `tsconfig.json` and
  `vitest.config.ts`). Relative imports inside a package use the `.js`
  extension (`./foo.js`) — required by `verbatimModuleSyntax`.
- Each package: `package.json` (`main`/`types` → `./src/index.ts`), `src/index.ts`
  barrel, tests in `packages/<name>/test/*.test.ts`.
- `noUncheckedIndexedAccess` and `noUnusedLocals` are ON. Array access yields
  `T | undefined`; narrow explicitly.
- ESLint bans `console.*` (except `console.error`) outside `cli/`, `scripts/`,
  `spikes/`, and tests. Use the `@bosanda/observability` logger.
- ESLint bans non-null assertions (`!`) outside tests, `shared/src/ids.ts`, and
  `provider-kiro/**`.
- All timestamps UTC. Money is integer rupiah (`price_idr`), never a float.

## Frozen contracts

### `@bosanda/protocol`

- `CanonicalRequest`, `CanonicalMessage`, `CanonicalContent`, `CanonicalTool`,
  `CanonicalToolChoice`, `CanonicalEvent`, `CanonicalUsage`, `FinishReason`,
  `Surface` — exactly PLAN.md §5. **Do not add provider- or client-specific
  fields.**
- `BosandaError` + `ErrorCode` — the only error type crossing package
  boundaries. `code` → HTTP status per PLAN.md §8. `publicMessage` is
  client-safe; `internalDetail` is operator-only and must never be sent to a
  client. `isProviderRetryable` gates scheduler failover;
  `shouldCooldownProvider` gates cooldown.
- `LIMITS` + `assertWithinLimits(request)` — call this in every surface decoder
  after decoding, before any provider work.

### `@bosanda/shared`

`ulid`, `requestId`, `toolCallId`, `messageId`, `conversationId`;
`singleFlight`, `withTimeout`, `withIdleTimeout`, `abortPromise`, `sleep`,
`TimeoutError`; `redactHeaders`, `redactValue`, `maskApiKey`, `isSensitiveKey`,
`scrubPaths`; `Clock`/`systemClock`/`fixedClock`, `addMs`, `isExpired`,
`secondsUntil`, `backoffMs`, `KEY_VALIDITY_MS`.

Take a `Clock` for anything time-dependent so tests stay deterministic.

### `@bosanda/config`

`loadEnv(source?)` → `Env`, `env()` cached accessor, `ConfigError`,
`keyringFromEnv(env)` → `SecretKeyring` with purposes
`provider-credentials` | `customer-api-key` | `api-key-lookup` | `session`.
Add new variables to `envSchema` in `packages/config/src/env.ts`; secrets must be
32-byte base64 and mutually distinct (enforced). **Never put a secret value in an
error message — variable names only.**

### `@bosanda/observability`

`createLogger({service, level?, pretty?})`, `requestLogger(logger, ctx)`,
`Registry`/`createRegistry()` with the PLAN.md §17 metric set pre-registered.
`registry.increment/setGauge/addGauge/observe` throw on an unregistered name —
register new metrics in `createRegistry` rather than ad hoc.

### `@bosanda/provider-core`

`ProviderAdapter` (`validateAccount`, `listModels`, `stream`), `AccountHealth`,
`ProviderModel`, `ProviderCredentials`, `KillSwitches`, `Persona`,
`AccountStatus`, `ProviderType`. Frozen — the scheduler and every adapter code
against these.

Routing layer on top (also frozen): `AdapterRegistry`/`createAdapterRegistry`,
`Scheduler` (`Lease`, `Rejection`, `RejectionReason`), `CooldownRegistry`,
`CircuitBreakerRegistry`, `streamWithFailover`/`collectWithFailover` (`Sink`,
`Attempt`, `FailoverOptions`), `evaluateKillSwitches`/`killSwitchesFromEnv`/
`isModelPubliclyVisible`, `HealthTracker`.

### `@bosanda/metering`

PLAN.md §10 in full. `rawTokens`, `weightedTokens`, `weightedFromTokens`
(one `ceil` applied once — never round per-part); `MultiplierRegistry`
(`current(model, now)` ignores staged future versions; `atVersion` throws rather
than falling back); `countRequestInputTokens` (**pure** — this is what makes
`count_tokens` safe without touching a provider), `countOutputTokens`,
`COUNTER_VERSION`; `resolveUsage`/`METER_VERSION`/`UsageSource` (partial upstream
usage is NEVER authoritative); `canStartRequest`, `allowStreamToFinish`,
`settle`, `validateTopUp`, `priceForQuota`, `worstCaseOverage`.

An unsupported model raises `model_not_allowed` (403). **`model_unavailable`
does not exist in `ErrorCode`** despite PLAN.md §8 naming it — see "Open
questions".

### `@bosanda/auth`

PLAN.md §12. Argon2id via `@node-rs/argon2` with `PASSWORD_PARAMS` pinned
(`hashPassword`, `verifyPassword`, `needsRehash`, `parsePhc`) — the PHC string
carries its own parameters, so a later cost increase rehashes on next login
instead of invalidating stored hashes. `validatePassword`/`validateUsername` and
their `assert*` counterparts; `normalizeUsername` + `isReservedUsername`.

Sessions are **opaque tokens, not JWTs**: `generateSessionToken` +
`sessionDigest` (only the digest is stored), `startSession`, `evaluateSession`/
`assertSessionValid` against both `SESSION_LIFETIME_MS` and
`SESSION_IDLE_TIMEOUT_MS`, `digestsMatch` constant-time. Cookies:
`SESSION_COOKIE`/`CSRF_COOKIE`/`CSRF_FIELD`/`CSRF_HEADER`, `sessionCookie`,
`csrfCookie`, `clearedCookie`, `csrfTokensMatch`, `parseCookies`,
`serializeCookie` — double-submit CSRF, `SameSite=Lax`.

`attemptLogin`/`assertLoginSucceeded` + `createDecoyHash`: an unknown username
still performs a verify against a decoy hash, so the response time does not
reveal whether an account exists. `prepareRegistration` returns a `NewUser` for
the caller to persist. `resetPasswordAsAdmin` (§12 manual recovery) requires a
reason of at least `MIN_RESET_REASON_LENGTH` and writes the audit entry through
a `ResetAuditSink` **before** the change lands — a failed audit write fails the
reset, matching `revealApiKey`'s ordering in `@bosanda/api-keys`.

### `@bosanda/openai`, `@bosanda/anthropic`

PLAN.md §8. Both are **pure codecs**: wire format ↔ canonical protocol, no HTTP,
no provider, no state beyond one response's own accumulation. Decoders call
`assertWithinLimits` after decoding. OpenAI streams end with `DONE_FRAME`;
Anthropic never emits one and instead follows the §8 event order
(`message_start` → `content_block_start` → deltas → `content_block_stop` →
`message_delta` → `message_stop`). `requireAnthropicVersion` enforces and records
`anthropic-version`. `countTokens`/`countTokensForRequest` back
`/v1/messages/count_tokens` locally, so it never reaches a provider.

### `@bosanda/payments`

PLAN.md §11/§13. **Every module is side-effect free by design**: it decides, the
caller executes. §10/§16 require the ledger row, balance update, stock decrement,
and key creation to land in one transaction, and only `@bosanda/database` can
guarantee that. So `decideActivation`, `decideWebhookAction`, and the stock and
reconcile helpers return outcomes rather than performing writes.

Pakasir transport is injected (`PakasirDeps`/`PakasirTransport`), so tests never
touch the network. `redactPakasirUrl` keeps the API key out of logs.
Webhooks: `verifySignature` (constant-time), `parseWebhookEvent`, and
idempotency on `provider_event_key`, which the schema indexes `UNIQUE` — replay
cannot double-credit. An event that cannot be resolved becomes
`review_required`; nothing guesses in favour of either side.

### `@bosanda/api-keys`

PLAN.md §12. Format `bsk_` + 8-char public prefix + 32-char secret, Crockford
base32 (200 bits total, 160 secret). `generateApiKey`, `prefixOf`,
`looksLikeApiKey`, `constantTimeEqual` (absorbs the length-mismatch throw so the
exception path is not a length oracle); `lookupDigest` (domain-separated
HMAC-SHA-256, hex, `UNIQUE`-indexable) + `isLookupDigest`; `seal`/`open`/
`envelopeVersion` — self-describing `v<version>.<nonce>.<ciphertext+tag>`
envelope, XChaCha20-Poly1305, fresh 24-byte nonce per seal, AAD-bound, decrypts
any retained generation and raises loudly on a missing one; `maskKey` (renders
from the stored prefix alone, no key needed) and `revealApiKey` — the **only**
path from envelope to plaintext, which audits before it decrypts and fails the
reveal if the audit write fails.

### `@bosanda/database`

PLAN.md §14. `createClient`/`createClientFromEnv`/`checkConnection`/
`closeClient` and the `Sql` type — the `postgres` tagged template is the
project's SQL-injection boundary, so **all** query construction goes through the
tag, never string concatenation. `tx.unsafe()` appears exactly once, in
`migration-store.ts`, for DDL that cannot be parameterized.

Migrations are ordered and immutable after release, and that is **enforced**:
`checksumOf` records a SHA-256 per applied migration and `planMigrations`
refuses to proceed when a released migration's contents changed, when a recorded
migration is missing from disk, or when a new migration sorts before one already
applied. `migrate(store, available, clock)` applies pending migrations in id
order, recording each in the same transaction as its DDL. Migration SQL lives in
`src/migrations/NNNN_lower_snake_case.sql`; `loadMigrations` rejects any other
filename because ordering is load-bearing. There is deliberately **no down
path** — recovery is a restore plus a forward fix.

`0001_initial_schema.sql` creates exactly the 14 tables §14 lists, with
lifecycle invariants as CHECK constraints rather than prose: order status is
PLAN.md §13's vocabulary (`draft` → `pending_payment` → `paid` → `activated`,
plus `expired`/`cancelled`/`review_required` — refunds go through review, never
by deleting history), a top-up order must name a target key and a new-key order
must not, an order cannot be activated unless paid, a ledger debit must be
non-positive and a grant positive, a balance can never go negative, a per-request
debit is uniquely indexed so a retried settle cannot double-charge, the
`payment_events` provider event key is `UNIQUE` so webhook replay cannot
double-credit, and a model may only be `published` once its compatibility gate
reports `passing` or `degraded`. Tests assert against the real `.sql` file, so a
table added later without its constraints fails the suite.

## Security invariants (non-negotiable, PLAN.md §12/§16/§17)

1. Never store or log a plaintext API key, credential, token, prompt, response
   text, tool input, or tool result. Customer keys: HMAC lookup digest **and**
   XChaCha20-Poly1305 ciphertext, both keyed from the keyring.
2. Passwords: Argon2id via `@node-rs/argon2`.
3. Provider credentials: authenticated encryption, versioned key.
4. Quota changes are append-only ledger + transactionally maintained balance. No
   code path may adjust a balance without a matching ledger row.
5. Stock, quota, token refresh, and order activation use row locks or
   compare-and-swap. Webhook processing is idempotent on a provider event key.
6. `provider-kiro` never injects filesystem/shell/MCP tools and never puts
   Bosanda secrets, paths, or env vars into a prompt.
7. A fresh upstream conversation ID per request; never reuse hidden context
   between requests or users.
8. Retry only while zero bytes have reached the client.

## Verified baseline

As of 2026-07-31, the offline suite passes **1,480 tests across 55 files**. Root and
both Next.js TypeScript projects pass, both Next.js production builds pass, lint and
format checks pass, and the production dependency audit reports no known
vulnerabilities.

Per-package counts:

| Package         | Files | Tests |
| --------------- | ----: | ----: |
| `anthropic`     |     4 |   151 |
| `api-keys`      |     4 |    60 |
| `auth`          |     6 |   161 |
| `config`        |     2 |    38 |
| `database`      |     4 |   144 |
| `metering`      |     5 |   109 |
| `observability` |     2 |    17 |
| `openai`        |     5 |   136 |
| `payments`      |     5 |   146 |
| `protocol`      |     2 |    26 |
| `provider-core` |     6 |   119 |
| `provider-kiro` |     6 |   320 |
| `shared`        |     4 |    53 |

`pnpm verify` is the release check: formatting, lint, root plus both Next.js
typechecks, all tests, and both Next.js production builds. CI then runs the production
dependency audit.

## Implemented

- All packages listed in the repository layout, including the PostgreSQL repository
  layer and the Kiro Direct adapter implementation.
- Provider credential sealing/refresh, request transformation, EventStream parsing,
  upstream stream classification, scheduler/failover/circuit logic, both public wire
  codecs, metering, payments, auth, sessions, and API-key security.
- `spikes/kiro-direct` has an offline/live evidence harness. Offline checks use
  synthetic frames and prove local invariants only.
- `apps/web` and `apps/admin` provide their documented Next.js surfaces and build in
  production mode.
- `apps/gateway` currently exports only API-key authentication and per-key limiter
  primitives. It is a library skeleton, not a running Fastify service.
- Deployment templates, operational scripts, CI, and runbooks exist.

## Not implemented or not yet proven

- There is no `apps/gateway/src/main.ts`; no public Fastify server or HTTP routes are
  runnable yet. No document or package script should imply otherwise.
- `apps/worker` and the admin-bootstrap CLI are not implemented.
- Session persistence now carries `last_used_at`, but the absent HTTP session routes
  do not yet call `touchLastUsed`; end-to-end sliding-session behaviour is therefore
  not claimed.
- Live PostgreSQL concurrency/integration tests, official SDK tests through nginx,
  and production deployment checks still require owner-run environments described in
  `docs/testing.md`.

## Open questions (do not resolve these unilaterally)

- **`model_unavailable`.** PLAN.md §8 names it in the error mapping, but the frozen
  `ErrorCode` union does not contain it. Current code uses `model_not_allowed` (403)
  for package scope and `adapter_disabled` (503) for a switched-off model. The owner
  decides whether the code or PLAN.md changes.

## Hard launch blocker

M0 (PLAN.md §3, §20) still requires real Kiro credentials, at least two provider
accounts, live upstream traffic, and a real Claude Code tool-use session. **No live
sub-gate G0–G4 has been executed.** Offline adapter and harness tests do not substitute
for that evidence.

Every row in `docs/direct-adapter-gate.md` remains `NOT-YET-EXECUTED` until the owner
records real observations. `KIRO_DIRECT_ENABLED` defaults to `false` and must stay
false. The project is not cleared for deployment or paid sales.
