# Operations

Day-2 runbook for the Bosanda VPS. Covers deploy, rollback, provider accounts,
stock, stuck orders, metrics interpretation, kill switches, logs, and the backup
drill cadence.

Scope note: nothing in this document has been executed against a real
deployment. It was written from PLAN.md §16–§21 and from the code in
`packages/`. Every step marked **OWNER** needs the real VPS, DNS,
certificates, or Kiro credentials, and must be validated by the owner before
launch. See `docs/runbook.md` for first-time provisioning.

## Topology

```
Internet → nginx (TLS)
             ├── bosanda.dev        → 127.0.0.1:3000  bosanda-web
             ├── admin.bosanda.dev  → 127.0.0.1:3001  bosanda-admin
             └── api.bosanda.dev    → 127.0.0.1:4000  bosanda-gateway
                                        ├── bosanda-worker (no inbound port)
                                        └── PostgreSQL (localhost only)
```

Single VPS, single operator. That is a deliberate v1 choice and its consequences
are listed honestly in `docs/security.md` → Residual risk.

| Thing         | Location                                                 |
| ------------- | -------------------------------------------------------- |
| Releases      | `/opt/bosanda/releases/<UTC timestamp>`                  |
| Live symlink  | `/opt/bosanda/current`                                   |
| Env files     | `/etc/bosanda/{gateway,worker,web,admin,backup}.env`     |
| Backups       | `/var/backups/bosanda`                                   |
| nginx vhosts  | `/etc/nginx/sites-available/` (from `deploy/nginx/`)     |
| systemd units | `/etc/systemd/system/bosanda-*` (from `deploy/systemd/`) |

## Deploy

```sh
sudo BOSANDA_DRY_RUN=1 /opt/bosanda/current/scripts/deploy.sh main   # rehearse
sudo /opt/bosanda/current/scripts/deploy.sh main                     # for real
```

The script clones the ref into a new timestamped release, installs with a frozen
lockfile, typechecks, builds both Next apps, runs migrations, swaps the `current`
symlink atomically, restarts services (gateway **last**), and polls
`https://api.bosanda.dev/health`. If the health check fails it rolls back
automatically and exits non-zero.

Restarting the gateway during traffic is safe: its `SIGTERM` handler stops
accepting new requests and lets in-flight streams drain, and
`TimeoutStopSec=660` in the unit gives a 600 s turn room to finish. A deploy will
therefore feel slow if long streams are open. That is correct behaviour, not a
hang.

## Roll back

```sh
sudo /opt/bosanda/current/scripts/deploy.sh --rollback
```

**Code rolls back. Migrations do not.** There is no `migrate:down`, by design —
§14 requires migrations to be immutable after release, and automatic reverse
migrations turn a bad deploy into data loss.

The consequence you must honour in review: every migration has to be backward
compatible with the previous release (add nullable columns or columns with
defaults; never rename or drop in the same release that starts relying on the new
shape). Then rolling code back to N-1 against an N schema is safe.

If a non-backward-compatible migration has already run, do **not** roll back.
Go to `docs/incident-response.md` → "Database loss or corruption".

## Add or rotate a Kiro provider account

**OWNER** — requires real Kiro credentials, which do not exist in this
environment. The M0 gate (§3) has not been passed; see
`docs/direct-adapter-gate.md` (owned by another agent).

1. Obtain the credential material for the account. §6 lists what may be needed:
   refresh token, auth method, region, profile ARN, and OIDC client ID/secret
   where required.
2. Add it through the admin dashboard (§15 "Kiro provider pool"). Never via
   `psql`: the dashboard encrypts with the keyring and writes the
   `encryption_key_version`. A hand-inserted row will not decrypt.
3. Confirm `validateAccount` reports healthy, then watch
   `bosanda_healthy_providers` rise by one.
4. Never paste credentials into a shell, a log, a ticket, or a chat. They are
   encrypted at rest with `PROVIDER_ENCRYPTION_KEY` and must exist in plaintext
   only inside the admin request that stores them.

To rotate a compromised account: disable it first (kill switch below), then
replace the credential, then re-enable. Disabling first means no in-flight
request is using it while you swap.

To retire one: disable, wait for `bosanda_active_requests` for that account to
reach zero, then remove it. Removing an account with live requests will surface
as `no_healthy_provider` errors to whoever was mid-turn.

## Add stock

Stock is manual and per package size (§11). Admin dashboard → Commerce → Stock,
set `available` for each of the 10M…100M sizes.

Two rules worth internalising:

- Stock is **reserved** while payment is pending, and the reservation is released
  when the order expires or is cancelled. So `available` alone understates
  capacity; look at `reserved` too.
- A successful new-key order consumes one unit of that size. Webhook processing
  is idempotent on the provider event key, so a duplicate callback cannot
  double-decrement.

During controlled launch (§20 M5) keep stock deliberately low and raise it only
after stable operation. Stock is the throttle on customer exposure while the
upstream is unproven.

## Activate a stuck order

An order sitting in `pending_payment` that the customer insists they paid is the
most common support case. Order states are
`draft → pending_payment → paid → activated`, with `expired`, `cancelled`, and
`review_required` as terminal branches (§13).

Diagnose in this order:

1. **Did the webhook arrive?** Check `payment_events` for the provider event key,
   and `bosanda_payment_events_total` for the outcome label. If there is no row,
   Pakasir never reached us.
2. **Did it fail authentication?** A forged or misconfigured webhook is recorded
   with an error code. Repeated auth failures are an incident, not a support
   case — see `docs/incident-response.md`.
3. **Is the worker running?** The reconciliation loop polls Pakasir for pending
   or ambiguous orders and can activate a genuinely paid order when a webhook was
   lost. `systemctl status bosanda-worker`.

Preferred fix: let reconciliation do it. It uses the _same_ idempotent activation
transaction as the webhook path, so it cannot double-activate or double-decrement
stock.

If you must intervene, use the admin dashboard's order controls. Never activate
an order by hand in SQL: §10 forbids adjusting a quota balance without a matching
ledger row, and the dashboard path writes both atomically. A manual `UPDATE`
creates exactly the ledger drift described in the incident playbook.

Verify the customer actually paid at Pakasir before activating anything. Amount
and currency are validated against the immutable order snapshot precisely because
browser-supplied data is untrusted (§13).

## Reading the metrics

The gateway exposes Prometheus text at `/metrics`, denied at the nginx edge
(§17 operator-only). Reach it over the loopback:

```sh
ssh -L 4000:127.0.0.1:4000 vps    # then curl http://127.0.0.1:4000/metrics
curl -s http://127.0.0.1:4000/metrics | grep -v '^#'   # on the box
```

Names below are exactly those registered in
`packages/observability/src/metrics.ts`.

### Provider health — look here first

| Metric                                | Good              | Bad, and what it means                                                                                                                   |
| ------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bosanda_healthy_providers`           | ≥ 2               | **0 = total outage.** Every request returns 503 `no_healthy_provider`. Page yourself. 1 = no redundancy; one more failure is an outage.  |
| `bosanda_provider_circuit_state`      | 0                 | 0 closed, 1 half-open, 2 open. Sustained 2 on every account is an upstream break — check the compat counter next.                        |
| `bosanda_provider_cooldown_seconds`   | 0                 | Non-zero is normal transiently (30 s default). Climbing toward `PROVIDER_COOLDOWN_MAX_MS` (900 s) means escalating repeated failures.    |
| `bosanda_adapter_compat_errors_total` | flat              | **Any sustained rise is the §3 kill-switch signal.** The undocumented upstream protocol has probably changed.                            |
| `bosanda_eventstream_failures_total`  | flat              | CRC/parse/schema failures. A spike alongside compat errors confirms a wire-format change. Isolated failures may just be a flaky network. |
| `bosanda_token_refresh_total`         | success ≫ failure | A failure spike means credentials are expiring or revoked. Accounts will start dropping out.                                             |

### Traffic and latency

| Metric                                          | Interpretation                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bosanda_requests_total`                        | By surface/model/status. A rising 5xx share is the headline symptom of everything else on this page.                                                                                                                  |
| `bosanda_ttfb_ms`                               | Time to first byte. This is the number customers _feel_. Degradation usually means upstream slowness or a buffering regression at the edge — if TTFB jumped after an nginx change, check `proxy_buffering off` first. |
| `bosanda_duration_ms`                           | Full turn. Approaching 600 s means turns are hitting `UPSTREAM_HARD_TIMEOUT_MS`.                                                                                                                                      |
| `bosanda_active_requests`                       | Per key and per account. Per-key should never exceed 5 (`KEY_MAX_ACTIVE_REQUESTS`); if it does, the concurrency guard is broken.                                                                                      |
| `bosanda_queue_depth` / `bosanda_queue_wait_ms` | Sustained depth means not enough healthy accounts for demand. Add accounts or reduce stock.                                                                                                                           |
| `bosanda_upstream_retries_total`                | Rising relative to attempts means accounts are failing pre-first-byte. Retries only ever happen before any output reaches the client (§7).                                                                            |
| `bosanda_stream_bytes_total` / `_events_total`  | Flat while `requests_total` climbs = requests accepted but nothing streaming. Suspect buffering or an upstream stall.                                                                                                 |

### Money and quota

| Metric                                 | Interpretation                                                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bosanda_tokens_total`                 | By kind: input/output/cached/weighted. Weighted is the billable unit (§10).                                                                                                                                                       |
| `bosanda_usage_estimated_total`        | Authoritative vs estimated. **A rising estimated share directly degrades billing accuracy** — it means `metricsEvent` stopped supplying complete usage, and Bosanda fell back to counting. Investigate as a compatibility signal. |
| `bosanda_payment_events_total`         | Webhook and reconciliation outcomes. Any authentication-failure label deserves immediate attention.                                                                                                                               |
| `bosanda_rpm_rejections_total`         | Customers hitting 100 RPM. A single key dominating suggests either a runaway client or abuse.                                                                                                                                     |
| `bosanda_concurrency_rejections_total` | Customers hitting 5 concurrent. Normal in small amounts for Claude Code, which fans out.                                                                                                                                          |
| `bosanda_tool_use_turns_total`         | Turns emitting ≥1 tool call. Dropping to zero while traffic continues means tool use broke — the Claude Code loop is mandatory (§3 G3), so this is serious.                                                                       |

Alert thresholds §17 asks for: no healthy providers, compatibility error spike,
refresh failure spike, Kiro credit exhaustion, quota-ledger mismatch, payment
activation failure, repeated webhook auth failures, PostgreSQL health/storage.
**NOT YET IMPLEMENTED** — there is no alertmanager or notification channel in the
repository. Until one exists, alerting is the operator running
`scripts/healthcheck.sh` and reading the dashboard. That gap is a launch risk and
is recorded in `docs/security.md`.

## Kill switches

All are env changes in `/etc/bosanda/gateway.env` followed by
`systemctl restart bosanda-gateway`, except where the admin dashboard offers a
per-account toggle. §3 requires all of them, and §21 item 10 requires them
**tested** before launch.

| Switch                         | Effect                                                                                                                                                              | Use when                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIRO_DIRECT_ENABLED=false`    | **Master.** All Kiro models hidden from `/v1/models`, all API requests get a sanitized 503, and no payment may activate a Kiro package. Existing keys stay visible. | The upstream protocol broke, credentials are compromised, or you cannot yet explain a compatibility spike. Reach for this one first and diagnose afterwards.                                      |
| `KIRO_TOOL_USE_ENABLED=false`  | Tool use only. Plain text generation keeps working.                                                                                                                 | Tool calls break but chat is fine. Narrower blast radius — prefer it over the master switch when the symptom is specifically tool-shaped. Note Claude Code is effectively unusable without tools. |
| `KIRO_DISABLED_MODELS=a,b`     | Per-model.                                                                                                                                                          | One model fails the compatibility probe while others are healthy.                                                                                                                                 |
| `KIRO_DISABLED_REGIONS=r1,r2`  | Per-region.                                                                                                                                                         | A region is degraded or you want to concentrate traffic.                                                                                                                                          |
| Per-account disable (admin UI) | One provider account.                                                                                                                                               | An account is rate-limited, out of credit, or its credential is suspect.                                                                                                                          |
| Automatic circuit breaker      | Opens per account/model on repeated compatibility or auth failures.                                                                                                 | Nothing to do — it is already protecting you. Sustained open circuits mean investigate.                                                                                                           |

Sales/stock is the commercial kill switch: set stock to zero to stop new orders
without touching the API for existing customers.

After any kill switch: verify with `./scripts/healthcheck.sh`, confirm
`/v1/models` reflects the change, and write down what you did and why. Restoring
service without recording the cause is how the same outage happens twice.

## Logs

Everything goes to journald. The application logger (pino) redacts credentials,
prompts, responses, tool payloads, and local paths **before** the bytes leave the
process — journald is not a security boundary and must not be treated as one
(§17).

```sh
journalctl -u bosanda-gateway -f                    # follow
journalctl -u bosanda-gateway --since '1 hour ago'  # window
journalctl -u bosanda-worker -p err --no-pager      # errors only
journalctl -u bosanda-gateway | grep req_01J...     # by request ID
```

nginx logs separately, per vhost, at `/var/log/nginx/{api,admin,}bosanda.dev.{access,error}.log`.

Retention:

- **journald** — set `SystemMaxUse` and `MaxRetentionSec` in
  `/etc/systemd/journald.conf`. **OWNER**: not configured by this repository.
  30 days is a reasonable default; unbounded journals fill the disk and taking
  PostgreSQL down with a full disk is a self-inflicted outage.
- **nginx** — logrotate handles it on Ubuntu by default (14 days). Access logs
  contain IPs and URLs; they are personal data, so do not keep them longer than
  useful.
- **Database** — §14 requires usage and audit retention to be documented.
  `usage_events` and `audit_events` grow without bound and there is no pruning
  job. **NOT YET IMPLEMENTED.** Decide a policy before the tables get large;
  audit events supporting a dispute should outlive routine usage rows.

Prompt and response bodies are never stored (§16 privacy), so there is nothing to
purge for them. That is by design and it also means you cannot debug a customer's
bad output by reading it back. Ask for a request ID instead.

## Backups and the restore drill

Daily at 03:15 via `bosanda-backup.timer`; weekly drill Monday 04:30 via
`bosanda-restore-drill.timer`.

```sh
systemctl list-timers 'bosanda-*'          # confirm both are scheduled
systemctl start bosanda-backup             # ad-hoc backup now
./scripts/restore.sh --drill               # ad-hoc drill now
journalctl -u bosanda-restore-drill -n 50  # last drill result
```

The drill restores the newest dump into a scratch database, verifies the archive,
counts rows in the tables §14 requires, spot-checks for keys with no ledger rows,
and drops the scratch database. It never touches production.

**A failed drill is an incident.** It means the backups are not usable, which you
would otherwise discover only during a real recovery.

Two things the drill cannot prove, and you must not forget:

1. **The dumps are GPG-encrypted to a public key whose private half is offline.**
   That is deliberate (§16: a compromised VPS must not be able to decrypt its own
   backups) — but it means the drill on the VPS can only verify the _archive_, and
   a genuine end-to-end restore has to happen on the machine holding the private
   key. **OWNER: do that at least once before launch.** An untested private key
   is the same problem as an untested backup.
2. **Encryption keys are stored separately from the ciphertext** (§18). A restored
   database is useless without the matching `PROVIDER_ENCRYPTION_KEY` and
   `API_KEY_ENCRYPTION_KEY`. Back those up offline, separately, and confirm
   `ENCRYPTION_KEY_VERSION` alignment after any restore.

Cadence summary: backup daily, drill weekly, full offline restore test before
launch and then quarterly, and re-read `scripts/rotate-keys.md` before retiring
any key while old backups still exist.
