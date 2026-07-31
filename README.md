# Bosanda

A paid, public AI gateway that speaks both the **OpenAI** and **Anthropic** wire protocols over a
pool of service-owned Kiro accounts.

Customers buy weighted-token packages, get an API key, and point any OpenAI- or Anthropic-compatible
client (including Claude Code) at Bosanda by changing one base URL.

> **Status: pre-release. Not deployed, and not cleared for deployment.**
> The upstream Kiro generation protocol is undocumented and reconstructed from observed traffic. The
> M0 feasibility gate in [`PLAN.md`](./PLAN.md) §3 has **not** been executed — it requires real Kiro
> credentials and live traffic that this repository does not contain. `KIRO_DIRECT_ENABLED` defaults
> to `false` and must stay that way until the owner records PASS evidence in
> `docs/direct-adapter-gate.md`. See [`docs/IMPLEMENTATION-STATUS.md`](./docs/IMPLEMENTATION-STATUS.md)
> for what is actually built versus still missing.

## Documents

| File                                                               | What it is                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`PLAN.md`](./PLAN.md)                                             | The implementation spec. Section numbers (§5, §8, §14…) are cited throughout the code and are the authority when code and intuition disagree. |
| [`DESIGN.md`](./DESIGN.md)                                         | The "glass-on-dark-navy" Vision UI design system — the CSS tokens the frontends must use.                                                     |
| [`docs/IMPLEMENTATION-STATUS.md`](./docs/IMPLEMENTATION-STATUS.md) | Frozen contracts, conventions, security invariants, and honest progress. Read this first before writing code.                                 |

## Layout

```
packages/
  protocol/         canonical provider-neutral request/event types, error taxonomy, request limits
  shared/           ULIDs, single-flight, timeouts, redaction, clock
  config/           zod-validated env, versioned secret keyring
  observability/    pino logger (redacting), Prometheus metrics registry
  provider-core/    ProviderAdapter contract, scheduling, cooldown, breaker, retry, kill switches
  provider-kiro/    Kiro Direct HTTP adapter + AWS binary EventStream decoder
  openai/           OpenAI-compatible request decode / response + SSE encode
  anthropic/        Anthropic-compatible surface (required for Claude Code)
  metering/         weighted-token arithmetic, multiplier versioning, quota decisions
  database/         PostgreSQL schema, migrations, repositories (no ORM)
  auth/             Argon2id passwords, sessions, CSRF, roles
  api-keys/         HMAC lookup digests + XChaCha20-Poly1305 key envelopes
  payments/         Pakasir integration, webhook verification, order state machine
apps/
  gateway/          Fastify API primitives; HTTP runtime not implemented yet
  web/              Next.js storefront + user dashboard -> bosanda.dev
  admin/            Next.js operator dashboard  -> admin.bosanda.dev
  worker/           planned reconciliation/maintenance runtime; not implemented
spikes/
  kiro-direct/      operator harness for producing the M0 gate evidence
deploy/             nginx vhosts, systemd units, env template
scripts/            deploy, backup/restore, healthcheck, key rotation
```

The dependency direction is one-way: `apps` depend on `packages`; the client-facing protocol packages
(`openai`, `anthropic`) and the provider packages (`provider-kiro`) never import each other. They meet
only at the canonical protocol in `packages/protocol`, which is what makes a second provider or a
third wire format additive rather than invasive.

## Toolchain

Node 25, pnpm 11 workspace, TypeScript 5.9, ESM throughout (`"type": "module"` — relative imports
carry a `.js` extension). TypeScript is deliberately held at 5.9 rather than 7.x: typescript-eslint 8
and Next 16 are only validated against 5.x.

```bash
pnpm install          # at the repo root only
pnpm verify           # format -> lint -> all typechecks -> tests -> Next builds
pnpm audit --prod --audit-level=high         # production dependency advisories
pnpm exec vitest run packages/protocol       # one package
```

**Do not run `pnpm add` inside a package.** All dependencies are installed at the root so parallel
work cannot race the lockfile.

## Non-negotiables

These are enforced by tests and are not stylistic preferences:

- Prompts, responses, tool inputs, and tool results are **never** logged or persisted. Token _counts_
  are. Error _classes_ are.
- Plaintext API keys and provider credentials are never logged, never stored in the clear, and never
  rendered in the admin UI.
- Only `BosandaError.publicMessage` crosses the client boundary — never an internal detail, stack,
  upstream body, or provider account ID.
- Quota changes write an append-only ledger row and the balance update in the **same** transaction.
- Tools execute **client-side only**. The server never executes a tool and never injects a
  filesystem, shell, or MCP tool into an upstream request.
- A request may be retried on a different account **only before the first output byte** reaches the
  client.
- Payment webhooks are authenticated over the raw body, idempotent on the provider event key, and
  validated against the server-created order snapshot — never against amounts or quotas supplied by
  the caller.
