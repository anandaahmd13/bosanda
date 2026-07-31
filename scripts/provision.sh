#!/bin/sh
# First-time VPS provisioning (PLAN.md §16, §18, §20 M4).
#
# Creates the service users, directory layout, and env-file skeletons that
# deploy/systemd/*.service and scripts/deploy.sh assume already exist. It does
# NOT install nginx vhosts, issue certificates, or start any Bosanda service —
# those need real DNS and are documented in docs/runbook.md.
#
#   Usage: sudo ./scripts/provision.sh
#          sudo BOSANDA_DRY_RUN=1 ./scripts/provision.sh   # print, change nothing
#
# Idempotent by construction: every step checks for its own result first, so a
# re-run after a partial failure converges instead of erroring or duplicating.
# Safe to run again after adding a service.
#
# DELIBERATELY NOT DONE HERE, because each needs a human decision:
#   - No secret VALUES are generated into the env files. The placeholders must be
#     filled by the owner (see deploy/env/.env.example and the openssl command in
#     it). A script that invents secrets encourages nobody to record them, and an
#     unrecorded encryption key means unrecoverable ciphertext.
#   - No firewall rules. §16 wants egress allowlisting to Kiro/Pakasir "where
#     practical"; getting that wrong silently breaks the product.
#   - No PostgreSQL role or database creation: the owner chooses the password and
#     whether the DB is local or managed.
#
# OWNER ACTION: this script has NEVER been executed. It was authored on macOS
# with no systemd, no useradd, and no nginx. Read it, then run it once with
# BOSANDA_DRY_RUN=1.

set -eu
# shellcheck disable=SC3040
(set -o pipefail 2>/dev/null) && set -o pipefail

DRY_RUN="${BOSANDA_DRY_RUN:-0}"

APP_ROOT=/opt/bosanda
RELEASES_DIR="$APP_ROOT/releases"
ENV_DIR=/etc/bosanda
BACKUP_DIR=/var/backups/bosanda
CERTBOT_WEBROOT=/var/www/certbot

APP_USER=bosanda
APP_GROUP=bosanda
BACKUP_USER=bosanda-backup
BACKUP_GROUP=bosanda-backup

log()  { printf '[provision] %s\n' "$*"; }
skip() { printf '[provision]   skip   %s\n' "$*"; }
die()  { printf '[provision] FATAL: %s\n' "$*" >&2; exit 1; }

# Silent during a dry run: printing "done" next to "WOULD" would claim an action
# that did not happen, which is exactly the kind of false confidence a rehearsal
# is supposed to eliminate.
did() {
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  printf '[provision]   done   %s\n' "$*"
}

# Every mutating action goes through run(), so BOSANDA_DRY_RUN=1 is honoured
# everywhere rather than only in the places someone remembered.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[provision]   WOULD  %s\n' "$*"
  else
    "$@"
  fi
}

[ "$DRY_RUN" = "1" ] || [ "$(id -u)" = "0" ] || die "must run as root (creates users and /etc/bosanda)"

command -v systemctl >/dev/null 2>&1 || log "WARNING: systemctl not found — is this the target Ubuntu VPS?"

# ---------------------------------------------------------------------------
# 1. Service accounts
# ---------------------------------------------------------------------------
# System accounts (--system): no aging, no login shell, UID below 1000 so they
# never collide with a human. /usr/sbin/nologin means a stolen password is
# useless for shell access, which matters because these users can read the
# encryption keys via their env files.
#
# bosanda-backup is SEPARATE from bosanda on purpose (§16): the app user must not
# be able to read or delete backups, so a compromised gateway cannot destroy the
# evidence or the recovery path.
create_user() {
  _user="$1"
  _group="$2"
  _home="$3"

  if getent group "$_group" >/dev/null 2>&1; then
    skip "group $_group exists"
  else
    run groupadd --system "$_group"
    did "group $_group"
  fi

  if getent passwd "$_user" >/dev/null 2>&1; then
    skip "user $_user exists"
  else
    run useradd --system --gid "$_group" --home-dir "$_home" \
      --no-create-home --shell /usr/sbin/nologin "$_user"
    did "user $_user"
  fi
}

log "service accounts"
create_user "$APP_USER" "$APP_GROUP" "$APP_ROOT"
create_user "$BACKUP_USER" "$BACKUP_GROUP" "$BACKUP_DIR"

# ---------------------------------------------------------------------------
# 2. Directory layout
# ---------------------------------------------------------------------------
# Matches the table in docs/operations.md and the WorkingDirectory/ReadWritePaths
# in deploy/systemd/. If these disagree, systemd fails at start with a confusing
# namespace error, so keep them in sync.
ensure_dir() {
  _path="$1"; _owner="$2"; _mode="$3"; _why="$4"
  if [ -d "$_path" ]; then
    skip "dir $_path exists"
  else
    run install -d -o "${_owner%%:*}" -g "${_owner##*:}" -m "$_mode" "$_path"
    did "dir $_path ($_mode, $_owner) — $_why"
  fi
  # Re-assert ownership/mode even when the directory existed: a wrong mode here
  # is a security bug (0755 on the env dir would expose every secret), and it is
  # cheap to correct on every run.
  run chown "$_owner" "$_path"
  run chmod "$_mode" "$_path"
}

log "directory layout"
ensure_dir "$APP_ROOT"      "root:$APP_GROUP"          0755 "release root"
ensure_dir "$RELEASES_DIR"  "root:$APP_GROUP"          0755 "timestamped releases"

# 0750 root:bosanda — the app user can traverse in and read, nobody else can even
# list it. This directory holds all five encryption keys.
ensure_dir "$ENV_DIR"       "root:$APP_GROUP"          0750 "env files (secrets)"

# 0700 and owned by the backup user: not even the app group may read dumps.
ensure_dir "$BACKUP_DIR"    "$BACKUP_USER:$BACKUP_GROUP" 0700 "encrypted pg_dump output"

# world-readable: nginx serves the ACME challenge from here over plain HTTP.
ensure_dir "$CERTBOT_WEBROOT" "root:root"              0755 "certbot webroot"

# ---------------------------------------------------------------------------
# 3. Env file skeletons
# ---------------------------------------------------------------------------
# Created EMPTY-but-commented with 0640 root:<group> so the secrets are never
# world-readable even for the instant between creation and editing. Creating the
# file with the right mode first, then writing into it, avoids that window.
#
# Never overwritten: if the file already has real secrets in it, clobbering it
# would take the service down and lose the keys.
ensure_env_file() {
  _path="$1"; _group="$2"; _note="$3"
  if [ -f "$_path" ]; then
    skip "env $_path exists (not overwritten)"
    # Still correct the mode — a stray 0644 here leaks every secret.
    run chown "root:$_group" "$_path"
    run chmod 0640 "$_path"
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    printf '[provision]   WOULD  create %s (0640 root:%s)\n' "$_path" "$_group"
    return
  fi

  install -o root -g "$_group" -m 0640 /dev/null "$_path"
  cat >"$_path" <<EOF
# $_note
#
# Fill every value from deploy/env/.env.example, which documents each variable.
# All five secrets must be DISTINCT 32-byte base64 values — packages/config
# enforces this at boot and refuses to start otherwise.
#
# Generate one with:  openssl rand -base64 32
#
# This file is root:$_group 0640. Do not loosen it. Do not commit it.
EOF
  did "env $_path (0640 root:$_group, placeholders only)"
}

log "env file skeletons"
ensure_env_file "$ENV_DIR/gateway.env" "$APP_GROUP"    "Bosanda gateway environment"
ensure_env_file "$ENV_DIR/worker.env"  "$APP_GROUP"    "Bosanda worker environment"
ensure_env_file "$ENV_DIR/web.env"     "$APP_GROUP"    "Bosanda storefront environment"
ensure_env_file "$ENV_DIR/admin.env"   "$APP_GROUP"    "Bosanda admin environment"
ensure_env_file "$ENV_DIR/backup.env"  "$BACKUP_GROUP" "Bosanda backup environment (PG* + BOSANDA_BACKUP_*)"

# ---------------------------------------------------------------------------
# 4. Verify, do not assume
# ---------------------------------------------------------------------------
log "verification"

if [ "$DRY_RUN" = "1" ]; then
  log "dry run — nothing was changed"
else
  # Fail loudly if any secret-bearing path ended up group- or world-readable.
  for _p in "$ENV_DIR" "$BACKUP_DIR"; do
    _mode="$(stat -c '%a' "$_p" 2>/dev/null || echo '?')"
    case "$_p:$_mode" in
      "$ENV_DIR:750" | "$BACKUP_DIR:700") did "$_p mode $_mode" ;;
      *) die "$_p has unexpected mode $_mode — refusing to report success" ;;
    esac
  done

  for _f in gateway worker web admin backup; do
    _mode="$(stat -c '%a' "$ENV_DIR/$_f.env" 2>/dev/null || echo '?')"
    [ "$_mode" = "640" ] || die "$ENV_DIR/$_f.env has mode $_mode, expected 640"
  done
  did "all env files are 0640"
fi

cat <<'EOF'

[provision] Provisioning complete. NOT done automatically — owner steps next:

  1. Fill /etc/bosanda/*.env from deploy/env/.env.example.
     Generate each secret with: openssl rand -base64 32
     All five must be distinct or the services refuse to boot.

  2. Create the PostgreSQL role and database, then set DATABASE_URL.
     Keep PostgreSQL bound to localhost (§16).

  3. Install nginx config and issue certificates — needs live DNS.
     See deploy/nginx/README.md and docs/runbook.md.

  4. Install the systemd units:
       cp deploy/systemd/bosanda-* /etc/systemd/system/
       systemctl daemon-reload
       systemd-analyze verify /etc/systemd/system/bosanda-gateway.service
     Run the verify step BEFORE enabling anything — it has never been run.

  5. Deploy: sudo BOSANDA_DRY_RUN=1 ./scripts/deploy.sh main   (then for real)

  6. Bootstrap the first admin (one-time, §15):
       pnpm run admin:bootstrap

EOF
