# Test plan status

This document maps PLAN.md §19 to what the repository can verify offline and what still
requires an owner-run environment. It is deliberately conservative: synthetic fixtures
and unit tests do not clear a live compatibility or deployment gate.

## Automated baseline

As of 2026-07-31:

- **55 test files / 1,480 tests pass** with `pnpm run test`.
- `pnpm run typecheck` covers the root project plus both Next.js apps.
- `pnpm run build:apps` builds the web and admin apps in production mode.
- `pnpm run verify` runs format, lint, all typechecks, all tests, and both app builds.
- `pnpm run audit:prod` reports no known production dependency vulnerabilities.

Test discovery is limited to:

```text
packages/*/test/**/*.test.ts
apps/*/test/**/*.test.ts
spikes/*/test/**/*.test.ts
```

A test placed elsewhere is not executed by Vitest.

## Offline coverage by package

| Package         | Files | Tests | Main coverage                                                                |
| --------------- | ----: | ----: | ---------------------------------------------------------------------------- |
| `anthropic`     |     4 |   151 | request decode, stream/non-stream encode, errors, local count_tokens         |
| `api-keys`      |     4 |    60 | format, HMAC lookup, envelopes, audited reveal                               |
| `auth`          |     6 |   161 | passwords, usernames, sessions, cookies/CSRF, login, recovery                |
| `config`        |     2 |    38 | env validation, distinct/versioned secrets                                   |
| `database`      |     4 |   144 | migrations/schema contracts, transaction dispatch, pure repository decisions |
| `metering`      |     5 |   109 | counters, usage resolution, multipliers, quota, weighted arithmetic          |
| `observability` |     2 |    17 | redaction and metrics registration                                           |
| `openai`        |     5 |   136 | request decode, stream/non-stream encode, errors, models, round trips        |
| `payments`      |     5 |   146 | activation, Pakasir, reconciliation, stock, webhooks                         |
| `protocol`      |     2 |    26 | public errors and request limits                                             |
| `provider-core` |     6 |   119 | scheduler, retry boundary, cooldown, breaker, health, kill switches          |
| `provider-kiro` |     6 |   320 | adapter, credentials, EventStream, models, streaming, transforms             |
| `shared`        |     4 |    53 | async timeouts/single-flight, IDs, redaction, clock helpers                  |

These are unit and contract tests. Database tests inspect real migration/repository
source but do not connect to PostgreSQL. Provider tests use injected transports and
synthetic EventStream frames; they do not establish live Kiro compatibility.

## PLAN.md §19 status

### Direct adapter

Offline tests cover credential envelopes and refresh races, request transformation,
model mapping, progressive EventStream parsing at arbitrary chunk boundaries, CRC
validation, malformed/oversized/truncated frames, event mapping, abort/timeout
classification, and backpressure-oriented async iteration.

Still **OWNER / M0**:

- obtain and refresh the credential form accepted by the live upstream;
- capture and sanitize current request/event fixtures;
- prove real progressive delivery, cancellation, timeouts, and backpressure;
- reconcile real `metricsEvent` fields and provider credit;
- record every result in `docs/direct-adapter-gate.md`.

### Claude Code

Offline codec and adapter tests cover tool definitions, fragmented input JSON, multiple
tool calls, tool results/errors, stable IDs, stop reasons, and the structural rule that
Bosanda may not inject tools the client did not declare.

Still **OWNER / M0**: run a real Claude Code session against a disposable repository and
prove the complete client-side Read/Edit/Bash loop. Observe the server while it runs to
confirm no tool process or customer filesystem operation occurs there.

### Pool and retry

Offline tests cover least-loaded selection, disabled/cooldown filtering, one attempt per
account, retry only before first output, abort propagation, cooldown escalation, and
circuit states.

Still **OWNER**: load-test the real upstream because version 1 intentionally has no hard
per-provider concurrency cap.

### Protocol compatibility

Offline tests cover OpenAI and Anthropic request/response shapes, tool deltas, finish
reasons, usage, sanitized errors, Anthropic content-block ordering, OpenAI `[DONE]`, and
Anthropic's absence of `[DONE]`. The Anthropic token-count operation is structurally
provider-free and synchronous.

Still **OWNER**: official OpenAI SDK, Anthropic SDK, and Claude Code tests through the
production nginx domains. This must be through nginx because edge buffering can break a
stream that works on localhost.

### Commerce, quota, and security

Offline tests cover password/API-key cryptography, generic auth failures, session policy,
CSRF helpers, payment decisions, webhook verification, stock/quota rules, migration
constraints, SQL construction contracts, and redacted logging.

Still **OWNER with live PostgreSQL**:

- migrations against a fresh database;
- concurrent quota settlement with no lost ledger entries;
- duplicate webhook idempotency through the real unique constraint;
- stock/order activation in one real transaction;
- encrypted customer/provider secret inspection at rest;
- registration/login/admin authorization and bootstrap HTTP flows once those runtimes
  exist.

## Owner-run environments

### PostgreSQL

Use a disposable database, never production:

```sh
createdb bosanda_test
export DATABASE_URL='postgres://localhost/bosanda_test'
pnpm run db:migrate
```

Integration tests added for this environment must skip when `DATABASE_URL` is absent and
fail when it is present but broken.

### Real Kiro accounts

Use at least two service-owned test accounts and keep credential files outside the
repository:

```sh
pnpm --filter @bosanda/spike-kiro-direct gate:offline
KIRO_DIRECT_ENABLED=true pnpm --filter @bosanda/spike-kiro-direct gate \
  -- --credentials=/absolute/path/outside/repo/kiro-test-account.json
```

Offline mode proves only local harness invariants. Live output must be reviewed,
sanitized, and copied into `docs/direct-adapter-gate.md`; the harness does not sign off
M0 automatically.

### Production domains

After the gateway and worker runtimes exist and deployment is otherwise ready, verify
streaming through nginx with `curl -N`, then the OpenAI SDK, Anthropic SDK, and Claude
Code. Confirm chunks arrive progressively rather than as one buffered response.

## Infrastructure checks

- `sh -n scripts/*.sh` is a syntax check only.
- Validate nginx with `nginx -t` on the VPS.
- Validate systemd units with `systemd-analyze verify` on Linux.
- Run `shellcheck -s sh scripts/*.sh` where ShellCheck is installed.
- Complete and document an encrypted backup/restore round trip before launch.

## Launch boundary

Passing `pnpm verify` means the offline repository is internally consistent. It does
**not** clear paid sales. Launch additionally requires the live M0 evidence, real
PostgreSQL transactional tests, working gateway/worker runtimes, and official clients
passing through production nginx.
