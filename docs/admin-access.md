# Admin access

The operator console is `admin.bosanda.dev` and listens on `127.0.0.1:3001`; nginx is the only public entry point. It is a separate Next.js app from the customer site, uses a separate session-cookie name, and does not expose a registration page.

> **Pre-release:** the repository is not deployed or cleared for production. `KIRO_DIRECT_ENABLED` remains `false`, and no payment or customer sale is authorized until the live gates in [`direct-adapter-gate.md`](./direct-adapter-gate.md) pass.

## Create the first operator

Run this on the host that can reach the Bosanda PostgreSQL database, from the repository root, after migrations have completed:

```bash
pnpm db:migrate
pnpm admin:bootstrap
```

`admin:bootstrap` prompts for a username, password, and confirmation. Password input is hidden on a TTY. The password is Argon2id-hashed before it is written; the plaintext is never placed in argv, environment variables, logs, or output. Usernames are normalized and validated by `@bosanda/auth`.

Bootstrap is one-time. A transaction-scoped PostgreSQL advisory lock and a second admin check prevent two concurrent invocations from creating multiple first admins. A later invocation exits non-zero with an already-exists error; it does not reset or overwrite the existing account.

Do not run the command through a shell history capture or paste the password into a command line. To operate against a remote database, use the normal root environment/configuration procedure; never add secrets to this repository.

## Start and sign in

1. Ensure the gateway and admin environment files are installed with the permissions described in [`../deploy/env/.env.example`](../deploy/env/.env.example).
2. Start or reload the database, gateway, and admin systemd units according to the deployment runbook.
3. Open `https://admin.bosanda.dev/login` in the operator browser.
4. Sign in with the bootstrap username and password.

The session is an opaque HttpOnly cookie. It is not returned in the page or made available to browser JavaScript. Mutating forms require the dashboard's CSRF token and an operator-supplied reason; GET requests do not mutate state.

Development fixture mode is enabled by default only outside production. It can be disabled with `ADMIN_USE_FIXTURES=false` and `ADMIN_API_BASE_URL=http://127.0.0.1:4000`. Production always refuses fixture data, even if the flag is set. The dashboard header labels fixture mode as `FIXTURE DATA` and live mode as `LIVE`.

## Lockout and recovery

There is no self-service registration or email recovery in v1. If the only admin credential is lost, use the approved operator recovery procedure against the database; do not manually edit password hashes or create a second row. Password reset through the admin UI revokes the target user's sessions and requires an audited reason.

## Hardening before exposure

The admin nginx vhost contains a commented IP allowlist and WireGuard-only alternative. Choose one before exposing the management surface to the public internet, then test from an independent network before ending the maintenance SSH session. The allowlist is intentionally an owner decision because an incorrect rule can lock out the sole operator.

The Content Security Policy is owned by `apps/admin/proxy.ts`, which generates a per-request nonce. Do not add another CSP header in nginx: browsers enforce multiple CSP headers as an intersection. Development React tooling permits `unsafe-eval`; the production proxy does not.

## What is not proven here

Offline tests and `app.inject()` checks do not prove a listening socket, PostgreSQL concurrency, nginx behavior, TLS, systemd, or a live payment provider. Run the owner-gated checks in [`testing.md`](./testing.md) and update [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md) with observed evidence rather than treating this document as deployment proof.
