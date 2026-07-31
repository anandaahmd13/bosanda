# First-time provisioning runbook

Bare Ubuntu VPS to a serving Bosanda deployment, in order. Every step is the
owner's: this sequence needs a real VPS, real DNS, and real certificates, none of
which existed where these artifacts were authored.

`docs/operations.md` is the day-2 companion (deploy, roll back, kill switches,
metrics). This file is the one-time path to the point where that one applies.

**Nothing below has been executed.** Treat it as a reviewed plan and expect to
fix a typo or two. Where a command can be rehearsed safely, the rehearsal is
given first.

## Before you start

Decisions to make now, because reversing them later is expensive:

| Decision                       | Notes                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kiro terms accepted?           | §21 item 12. The upstream is undocumented (§2). No code can make this call. If unresolved, stop here — do not provision a paid product.              |
| Where do encryption keys live? | Five distinct 32-byte secrets, backed up **offline and separately from the database**. A restored dump without its keys is unrecoverable ciphertext. |
| Admin exposure                 | Public with an IP allowlist, or WireGuard-only? WireGuard is safer; the allowlist is easier to lock yourself out with.                               |
| PostgreSQL local or managed?   | These artifacts assume local on the same host. Managed changes `DATABASE_URL` and the backup env.                                                    |

Prerequisites: Ubuntu 22.04+, root/sudo, DNS control for `bosanda.dev`, a Pakasir
account, and Kiro provider credentials.

## 1. DNS first

All three names must resolve to the VPS **before** certbot runs — HTTP-01
validation fails otherwise, and a failed run counts against Let's Encrypt rate
limits.

```sh
# A (and AAAA if you have IPv6) records:
#   bosanda.dev        → <vps-ip>
#   www.bosanda.dev    → <vps-ip>
#   admin.bosanda.dev  → <vps-ip>
#   api.bosanda.dev    → <vps-ip>

for h in bosanda.dev www.bosanda.dev admin.bosanda.dev api.bosanda.dev; do
  printf '%-22s %s\n' "$h" "$(dig +short "$h" | tr '\n' ' ')"
done
```

Do not continue until all four answer with the VPS address. Propagation can take
minutes to hours.

## 2. Base packages

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx postgresql certbot git curl gnupg
```

Node 22+ and pnpm 11.15.0 (matching `package.json` `engines` and
`packageManager`) via your preferred installer. Verify:

```sh
node --version    # must be >= 22.11.0
pnpm --version    # 11.15.0
```

## 3. Users, directories, env skeletons

```sh
sudo BOSANDA_DRY_RUN=1 ./scripts/provision.sh   # rehearse, changes nothing
sudo ./scripts/provision.sh                     # for real
```

Creates the `bosanda` and `bosanda-backup` system users (no login shell),
`/opt/bosanda`, `/etc/bosanda` at `0750`, `/var/backups/bosanda` at `0700`, the
certbot webroot, and five `0640` env skeletons.

It deliberately does **not** generate secrets, create the database, or touch the
firewall. Each needs a decision you should record.

## 4. PostgreSQL

```sh
sudo -u postgres createuser --pwprompt bosanda
sudo -u postgres createdb --owner=bosanda bosanda
```

Confirm it is not publicly reachable (§16) — `listen_addresses` should be
`localhost`:

```sh
sudo -u postgres psql -c 'SHOW listen_addresses;'
```

## 5. Secrets

Five distinct 32-byte base64 values. `packages/config` validates the length and
enforces distinctness at boot, so a mistake here fails loudly rather than
silently weakening anything.

```sh
for v in PROVIDER_ENCRYPTION_KEY API_KEY_ENCRYPTION_KEY API_KEY_LOOKUP_SECRET SESSION_SECRET; do
  printf '%s=%s\n' "$v" "$(openssl rand -base64 32)"
done
# PAKASIR_WEBHOOK_SECRET comes from Pakasir, not from openssl.
```

Paste into all five files under `/etc/bosanda/` per `deploy/env/.env.example`,
which documents every variable individually.

Note the thing that surprises people: `packages/config` validates the **whole**
schema in every process, so each service's env file needs `DATABASE_URL` and all
five secrets even if that service never uses one of them. Least privilege in v1 is
the split between the app users and the backup user, plus keeping
`PAKASIR_API_KEY` out of `web.env`.

**Back the keys up offline now**, before any data exists. Password manager or
encrypted offline media — not on this VPS, and not in the same place as the
database dumps.

Confirm nothing leaked into the shell history:

```sh
history | grep -c 'rand -base64'   # then clear if non-zero
```

## 6. nginx

```sh
sudo cp deploy/nginx/conf.d/00-bosanda-http.conf /etc/nginx/conf.d/
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/snippets/*.conf /etc/nginx/snippets/
sudo cp deploy/nginx/sites-available/*.conf /etc/nginx/sites-available/

# Ubuntu's default vhost owns "default_server"; leaving it enabled makes the
# first-listed server block answer for unknown hosts.
sudo rm -f /etc/nginx/sites-enabled/default

for s in bosanda.dev admin.bosanda.dev api.bosanda.dev; do
  sudo ln -sf "/etc/nginx/sites-available/$s.conf" "/etc/nginx/sites-enabled/$s.conf"
done

sudo nginx -t
```

`nginx -t` **will fail on this first attempt**, and that is expected: the
`ssl_certificate` paths in the vhosts do not exist until step 7. This is the
real syntax check — `nginx -t` was never run on these files (nginx was not
installed in the authoring environment). Fix any genuine syntax error now and
ignore the missing-certificate complaint.

See `deploy/nginx/README.md` for the layout and the ownership rules (rate-limit
zones live per-vhost; every `add_header` location must re-include the security
headers snippet, because nginx drops the entire inherited set).

## 7. Certificates

`certonly --webroot` so certbot never rewrites the hand-audited server blocks:

```sh
sudo certbot certonly --webroot -w /var/www/certbot \
  -d bosanda.dev -d www.bosanda.dev
sudo certbot certonly --webroot -w /var/www/certbot -d admin.bosanda.dev
sudo certbot certonly --webroot -w /var/www/certbot -d api.bosanda.dev

sudo nginx -t && sudo systemctl reload nginx
```

Reload on renewal:

```sh
printf '#!/bin/sh\nsystemctl reload nginx\n' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run
```

Do **not** submit to the HSTS preload list yet. The snippet sends `preload`, and
preload is a one-way door: every present and future subdomain must then serve
valid TLS or become unreachable. Wait until all three domains are stable.

## 8. systemd

```sh
sudo cp deploy/systemd/bosanda-* /etc/systemd/system/
sudo systemctl daemon-reload

# Never run before. Do this BEFORE enabling anything.
for u in gateway worker web admin backup restore-drill; do
  systemd-analyze verify "/etc/systemd/system/bosanda-$u.service" || true
done
```

`systemd-analyze verify` was not run on these units (no systemd where they were
authored). Expect to correct a directive name. Two hardening notes already
recorded in the units and worth not "fixing":

- `MemoryDenyWriteExecute=false` is required — V8's JIT needs W|X pages and
  `true` crashes Node at startup.
- `MemoryHigh`/`MemoryMax` are sized for a 2 GB droplet. Tune to your VPS.

Do not `enable --now` yet; the first deploy populates `/opt/bosanda/current`.

## 9. First deploy

```sh
sudo BOSANDA_DRY_RUN=1 /opt/bosanda/current/scripts/deploy.sh main   # rehearse
sudo ./scripts/deploy.sh main                                        # for real
```

Clone the repo somewhere readable for the very first run, since
`/opt/bosanda/current` does not exist yet. The script creates a timestamped
release, installs with a frozen lockfile, typechecks, builds both Next apps, runs
migrations, swaps the `current` symlink atomically, restarts services with the
gateway last, and health-checks — rolling back automatically on failure.

```sh
sudo systemctl enable --now bosanda-gateway bosanda-worker bosanda-web bosanda-admin
sudo systemctl enable --now bosanda-backup.timer bosanda-restore-drill.timer
systemctl list-timers 'bosanda-*'
```

## 10. First admin

One-time CLI, no web route (§15). Refuses to run if an admin already exists.

```sh
cd /opt/bosanda/current && sudo -u bosanda pnpm run admin:bootstrap
```

## 11. Verify

```sh
./scripts/healthcheck.sh --local   # bypasses nginx/DNS
./scripts/healthcheck.sh           # through the edge
```

If `--local` passes and the plain run fails, the fault is at the edge, not in the
application.

Then check the thing most likely to be silently broken — that streaming actually
streams. Timestamps must increase across chunks; if they all land at once, nginx
is buffering and `proxy_buffering off` did not take effect:

```sh
curl -N -s -H "Authorization: Bearer <test-key>" \
  -H 'content-type: application/json' \
  -d '{"model":"<published-model>","stream":true,"messages":[{"role":"user","content":"count slowly to twenty"}]}' \
  https://api.bosanda.dev/v1/chat/completions \
  | while IFS= read -r line; do printf '%s %s\n' "$(date +%T.%3N)" "$line"; done
```

Also confirm `/metrics` is refused from outside (it is denied at the edge; reach
it over an SSH tunnel) and that the admin origin is separate and hardened.

## 12. Backup, and prove it restores

```sh
sudo systemctl start bosanda-backup
sudo -u bosanda-backup ./scripts/restore.sh --drill
```

The on-box drill verifies the _archive_ only. Dumps are GPG-encrypted to a key
whose private half is offline, deliberately — a compromised VPS must not decrypt
its own backups.

**Do one genuine end-to-end restore on the machine holding the private key before
launch.** An untested private key is the same problem as an untested backup.
Quarterly after that. A restored database also needs the matching
`PROVIDER_ENCRYPTION_KEY` and `API_KEY_ENCRYPTION_KEY`, and an aligned
`ENCRYPTION_KEY_VERSION`.

## 13. Before enabling sales

`KIRO_DIRECT_ENABLED` defaults to `false` and must stay false until the §3 M0
gate has real PASS evidence in `docs/direct-adapter-gate.md`. Work through §21
go/no-go in full — particularly item 4 (complete Claude Code tool loop), item 5
(no context leaks between requests or users), and item 10 (kill switches
**tested**, not merely present).

Then follow §20 M5: registration and payment disabled, internal test keys,
limited stock, watch provider health and quota drift, expand stock only after
stable operation.

Still outstanding at this point, and recorded honestly in `docs/security.md` →
Residual risk: no alerting channel, no egress allowlist, and unbounded
`usage_events`/`audit_events` retention with journald retention unconfigured.
Decide each before taking real money.
