# Incident response

Playbooks for the incidents PLAN.md §16–§18 anticipate. Each one is ordered
**contain → diagnose → recover → record**, because containment is the only step
that gets harder the longer you spend thinking.

Scope note: none of these playbooks has been executed against a real deployment.
They were written from PLAN.md and from the code in `packages/`. Steps marked
**OWNER** need the real VPS, DNS, certificates, Kiro credentials, or the offline
GPG private key.

Single operator, no on-call rotation, no paging system. That is a v1 choice with
consequences recorded in `docs/security.md` → Residual risk. In practice it means
**you are the alert**: nothing here fires by itself.

## First 60 seconds, whatever the symptom

```sh
./scripts/healthcheck.sh                 # what is actually down
./scripts/healthcheck.sh --local         # is it the app, or nginx/TLS/DNS
systemctl status 'bosanda-*' --no-pager
journalctl -u bosanda-gateway -p err -n 50 --no-pager
curl -s http://127.0.0.1:4000/metrics | grep -E 'healthy_providers|circuit_state|compat_errors'
```

If you cannot explain what you are seeing within a few minutes, set
`KIRO_DIRECT_ENABLED=false` and restart the gateway. A sanitized 503 is a
recoverable customer experience. Leaking data or burning provider credit through a
protocol you no longer understand is not. Diagnose afterwards.

Never paste raw error output into a ticket or chat before reading it: gateway
errors are sanitized at the client boundary (§16), but the journald side is not,
and it may name a provider account or an internal path.

---

## Compatibility break (the expected incident)

The upstream is an observed, undocumented protocol (§2, §22). It **will** change
without notice. This is the incident the whole kill-switch design exists for.

**Signals.** `bosanda_adapter_compat_errors_total` rising, usually with
`bosanda_eventstream_failures_total`, circuits going to 2 (open) across _multiple_
accounts, and a rising 5xx share. Multiple accounts is the tell: one account
failing is an account problem, all accounts failing at once is a protocol problem.

**Contain.**

```sh
sudo vi /etc/bosanda/gateway.env        # KIRO_DIRECT_ENABLED=false
sudo systemctl restart bosanda-gateway
curl -s https://api.bosanda.dev/v1/models   # Kiro models must be gone
```

Also set stock to zero in the admin dashboard. §3 forbids activating a Kiro
package while the adapter is disabled, but zero stock stops customers reaching a
payment page they will only get refunded from.

If the symptom is specifically tool-shaped — text works, tool calls do not — try
`KIRO_TOOL_USE_ENABLED=false` first for a narrower blast radius. Be honest with
yourself about what that leaves: Claude Code is unusable without tools, so for
most customers this is not much better than the master switch.

If only one model or region is affected, `KIRO_DISABLED_MODELS` /
`KIRO_DISABLED_REGIONS` keep the rest earning.

**Diagnose.** Run the §19 compatibility fixtures against the live service. Compare
what the parser rejected with what the fixtures expect. The eventstream failure
counters distinguish the failure classes: CRC mismatch means framing changed,
schema failure means the event shape changed, unknown-event means they added
something new.

**Recover.** Fix the adapter, add a fixture that reproduces the new shape, get
tests green, deploy, re-enable behind low stock, and watch the compat counter for
a full day before raising stock. Re-enabling at full stock straight after a
protocol change is how you find the _second_ break with real customers attached.

**Record.** What changed upstream, what the fixture now covers, how long
customers were affected, and whether refunds are owed for expired-unused quota.

---

## No healthy providers

**Signal.** `bosanda_healthy_providers` = 0. Every request returns 503
`no_healthy_provider`. `bosanda_queue_depth` climbing.

This is a total outage of the paid product, but note what it is _not_: no data is
at risk and nothing needs to be undone. Do not rush into destructive changes.

**Diagnose, in this order.**

1. `bosanda_token_refresh_total` failures rising → credentials expired or revoked
   upstream. Most common cause.
2. All circuits open → see Compatibility break above.
3. Credit exhaustion on the Kiro side. **OWNER**: check the upstream account.
4. Every account manually disabled. It happens; check the dashboard before
   assuming something clever.
5. Egress broken — §16 allowlists gateway egress. A firewall change or expired
   upstream TLS chain looks exactly like a credential failure from inside.

**Recover.** Re-enable or replace accounts through the admin dashboard, never via
`psql` — a hand-inserted row will not decrypt, because the dashboard is what
writes the keyring version. Watch `bosanda_healthy_providers` come back up.

Running at 1 healthy account is not recovery, it is a single fault from another
outage. §21 item 9 requires _enough_ healthy accounts.

---

## Credential compromise

Covers a leaked provider refresh token, a leaked application secret, an exposed
`.env` file, or a suspected VPS compromise.

Assume compromise is real until proven otherwise. The reverse ordering — prove it
first, contain later — is how a small leak becomes a large one.

**Contain, immediately.**

| Leaked                                                | Do this first                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider credential                                   | Disable that account in the admin dashboard, then revoke it upstream (**OWNER**). Disabling alone stops Bosanda using it, not an attacker.                                                              |
| `SESSION_SECRET`                                      | Rotate it and restart. Every session is invalidated. Fast, cheap, and it locks an attacker out of hijacked sessions.                                                                                    |
| `API_KEY_LOOKUP_SECRET`                               | Read `scripts/rotate-keys.md` before touching it. Rotating invalidates **every live customer key at once**.                                                                                             |
| `PROVIDER_ENCRYPTION_KEY` or `API_KEY_ENCRYPTION_KEY` | Follow `scripts/rotate-keys.md`. Rotate the keyring version, re-encrypt, retire the old version last.                                                                                                   |
| `PAKASIR_WEBHOOK_SECRET`                              | Rotate in the Pakasir dashboard and in `/etc/bosanda/gateway.env` together. Until both match, webhooks fail authentication and orders will sit in `pending_payment` — reconciliation covers that gap.   |
| Whole VPS                                             | `KIRO_DIRECT_ENABLED=false`, revoke every provider credential upstream, rotate all five secrets, rebuild the host from scratch, restore data from a verified backup. Do not "clean" a compromised host. |

**Diagnose.** `audit_events` (§14) records administrative actions. journald has the
request-level picture. What you will _not_ find is prompts, responses, tool
payloads, or plaintext keys, because §16 forbids retaining them — that is a
deliberate trade: less forensic depth, far less to steal.

If you ever see a plaintext credential in a log, that is itself a §16 violation
and a second incident. Find the log line, fix the redaction, and treat every
credential visible in that log as compromised.

**Recover.** Rotate, verify with `./scripts/healthcheck.sh`, then confirm
customers can still authenticate and reveal keys. Rotation that silently breaks
key reveal is worse than the leak in customer perception.

**Record.** What leaked, how, blast radius, what was rotated, and what stops a
repeat. If customer data was reachable, disclosure may be owed.

---

## Database loss or corruption

The worst case in the system, because unlike everything above it is not
reversible by a restart. Referenced from `scripts/deploy.sh` and
`scripts/restore.sh`.

**Contain first — stop writes before you do anything else.**

```sh
sudo systemctl stop bosanda-gateway bosanda-worker
```

Every additional write on a damaged database widens the gap between what you have
and what a backup can give you. Accept the outage.

**Then take a snapshot of the damaged state before restoring anything.** Even a
corrupt database is evidence, and a restore overwrites it.

**Diagnose.**

```sh
pg_isready
journalctl -u postgresql -n 100 --no-pager
df -h                      # a full disk is the boring, common cause
./scripts/restore.sh --drill   # is the newest dump even usable?
```

A full disk is not corruption. Free space, restart, verify — do not restore.

**Recover.**

```sh
./scripts/restore.sh --drill                     # verify the dump first, always
./scripts/restore.sh --target bosanda --i-understand-this-destroys-data
```

The script refuses to run while the services are active, requires the typed
database name, and verifies the archive before touching anything. Let it.

After a restore, in this order:

1. Confirm `ENCRYPTION_KEY_VERSION` and both encryption keys match the restored
   ciphertext. A restored database with mismatched keys reads as total credential
   loss and it is not — it is a key alignment problem (§18).
2. Reconcile payments. Any order paid at Pakasir after the dump was taken exists
   there and not here. The worker's reconciliation loop is the correct instrument;
   it activates exactly once.
3. Audit quota balances against `quota_ledger`. §10 forbids a balance without
   matching ledger rows.
4. Expect customer-visible loss between the dump and the failure. Daily backups
   mean up to 24 hours. Say so plainly to affected customers rather than hoping
   nobody notices.

**Migrations do not roll back** (§14, by design). If a bad migration is the cause,
restoring the backup _is_ the rollback. Roll code back to match the restored
schema.

**Record.** Cause, data lost, customers affected, and what you changed so it
cannot recur.

---

## Quota ledger mismatch

**Signal.** §17 asks for a quota-ledger mismatch alert; the weekly drill's
spot-check for keys with no ledger rows is the poor-man's version. A customer
disputing their balance is the other signal.

Do **not** "correct" a balance with an `UPDATE`. §10 requires every balance change
to have a ledger row, and a bare update creates exactly the drift you are
investigating.

**Diagnose.** Sum the ledger for the key and compare with the stored balance. A
difference means either a write path bypassed the ledger — a bug worth finding —
or someone already did a manual update. Concurrent settlement losing entries is a
known §19 test case; check for a deploy or crash at the divergence time.

**Recover.** Fix the write path first, otherwise the drift returns. Then correct
the balance through a compensating ledger entry, so the audit trail explains
itself. Refund or credit generously if you cannot determine what the customer
actually consumed — the amounts are small and the trust is not.

---

## Repeated webhook authentication failures

**Signal.** `bosanda_payment_events_total` with an authentication-failure label,
repeatedly.

One failure is noise. A sustained pattern is either a misconfiguration or someone
probing for a forged-payment path, and §13 treats a forged webhook as a direct
attempt to steal quota.

**Diagnose.** Did `PAKASIR_WEBHOOK_SECRET` change on one side only? That is the
benign explanation and by far the most likely. Check the nginx access log for the
source: Pakasir's addresses versus something else.

**Contain** if it is not Pakasir: block the source at the edge, and confirm no
order activated on an unauthenticated event. Amount and currency are validated
against the immutable order snapshot, so a forged event with a wrong amount should
have been rejected on that ground too — verify both defences held rather than
assuming.

Genuine payments arriving while the secret is mismatched are not lost:
reconciliation polls Pakasir and activates them. Fix the secret and let it work.

---

## Certificate expiry

**Signal.** `healthcheck.sh` warns at 20 days. If it actually expires, every
client breaks simultaneously, including SDKs that will not let a user click
through a warning.

```sh
systemctl status certbot.timer
sudo certbot renew --dry-run
sudo certbot renew && sudo systemctl reload nginx
```

certbot renewal is silent when it fails, which is why the 20-day probe exists.
Reload nginx after renewal — a renewed certificate on disk is not the certificate
nginx is serving.

---

## Streaming works locally but not through nginx

Worth its own entry because the symptom is confusing and the cause is almost
always one line of config: responses arrive complete but all at once, or clients
time out on long turns.

```sh
./scripts/healthcheck.sh --local     # passes → fault is at the edge
sudo nginx -t
```

Check, in order: `proxy_buffering off`, `proxy_cache off`, `gzip off`,
`chunked_transfer_encoding on`, and `proxy_read_timeout 600s` in the API vhost.
Any of them silently reintroduced turns streaming into batch delivery. See
`deploy/nginx/README.md` → the two directives that break streaming.

`bosanda_ttfb_ms` jumping while `bosanda_duration_ms` holds steady is the
fingerprint of a buffering regression.

---

## Closing an incident

- Kill switches back to intended state, and recorded — a switch left flipped is a
  silent outage.
- `./scripts/healthcheck.sh` clean.
- A test covering the failure, where a test can cover it.
- Customers told, and refunded where quota expired unused through no fault of
  theirs.
- `docs/operations.md` or these playbooks updated if reality differed from what is
  written here.
