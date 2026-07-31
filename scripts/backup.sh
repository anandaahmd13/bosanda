#!/bin/sh
# Encrypted PostgreSQL backup (PLAN.md §18: "PostgreSQL backups are encrypted and
# restoration is tested").
#
# Invoked by deploy/systemd/bosanda-backup.service (daily 03:15) or by hand.
# Idempotent: two runs in the same second would collide on the filename, so the
# name carries a UTC timestamp AND the script refuses to overwrite.
#
#   Usage: ./scripts/backup.sh
#   Env:   /etc/bosanda/backup.env (see deploy/env/.env.example)
#
# OWNER ACTION: never executed — authored without PostgreSQL or gpg available.

set -eu
# shellcheck disable=SC3040
(set -o pipefail 2>/dev/null) && set -o pipefail

BACKUP_DIR="${BOSANDA_BACKUP_DIR:-/var/backups/bosanda}"
RETENTION_DAYS="${BOSANDA_BACKUP_RETENTION_DAYS:-14}"
GPG_RECIPIENT="${BOSANDA_BACKUP_GPG_RECIPIENT:-}"
DB="${PGDATABASE:-bosanda}"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] FATAL: %s\n' "$*" >&2; exit 1; }

command -v pg_dump >/dev/null 2>&1 || die "pg_dump not found"

[ -d "$BACKUP_DIR" ] || die "backup dir does not exist: $BACKUP_DIR (create it, owned bosanda-backup, mode 0700)"
[ -w "$BACKUP_DIR" ] || die "backup dir not writable: $BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$BACKUP_DIR/bosanda-$stamp"

# --- Format choice ---------------------------------------------------------
# -Fc (custom format) rather than plain SQL: it is compressed, and pg_restore can
# read it selectively and in parallel. It is also self-describing, which is what
# lets restore.sh VERIFY a dump without restoring it.
dump="$base.dump"

log "dumping database '$DB' to $dump"
[ -e "$dump" ] && die "refusing to overwrite existing $dump"

# --no-owner / --no-acl: the restore target may use a different role name, and a
# dump that hard-codes ownership fails to restore on a rebuilt VPS — exactly the
# scenario a backup exists for.
#
# Write to a .partial name first, then rename. A dump interrupted halfway (OOM,
# reboot, disk full) must never be left behind under a name that looks complete,
# or the restore drill will happily "verify" a truncated file.
if ! pg_dump --format=custom --compress=9 --no-owner --no-acl \
     --file="$dump.partial" "$DB"; then
  rm -f "$dump.partial"
  die "pg_dump failed for database '$DB'"
fi
mv "$dump.partial" "$dump"

# --- Integrity check BEFORE encrypting -------------------------------------
# pg_restore --list reads the archive's table of contents. If this fails, the file
# is not a valid archive and there is no point keeping or encrypting it.
if command -v pg_restore >/dev/null 2>&1; then
  if pg_restore --list "$dump" >/dev/null 2>&1; then
    log "dump structure verified (pg_restore --list succeeded)"
  else
    rm -f "$dump"
    die "dump failed structural verification and was deleted; investigate PostgreSQL health"
  fi
else
  log "WARN: pg_restore unavailable; skipped structural verification"
fi

# --- Encrypt (§18) ---------------------------------------------------------
# The dump contains password hashes, API key ciphertext, provider credential
# ciphertext, and the full order/ledger history. It must not sit on disk in the
# clear.
#
# Public-key encryption, not symmetric: the VPS holds only the PUBLIC key, so a
# compromised VPS cannot decrypt its own backups (§16 blast radius). Keep the
# private key OFFLINE.
#
# Note the layering (§18: "encryption keys are stored separately"): the API key
# and provider credential columns inside this dump are ALREADY ciphertext under
# the application keyring. GPG protects the rest — usernames, password hashes,
# orders, ledger. Restoring a dump is useless without the application keys too,
# which is deliberate.
final="$dump"
if [ -n "$GPG_RECIPIENT" ]; then
  command -v gpg >/dev/null 2>&1 || die "BOSANDA_BACKUP_GPG_RECIPIENT set but gpg not found"
  log "encrypting for $GPG_RECIPIENT"
  if ! gpg --batch --yes --trust-model always \
       --recipient "$GPG_RECIPIENT" \
       --output "$dump.gpg" --encrypt "$dump"; then
    rm -f "$dump.gpg"
    die "gpg encryption failed; plaintext dump left at $dump — encrypt or remove it manually"
  fi
  # Only remove the plaintext once the ciphertext exists and is non-empty.
  [ -s "$dump.gpg" ] || die "encrypted output is empty; keeping plaintext $dump"
  rm -f "$dump"
  final="$dump.gpg"
else
  # Loud, not silent. An unencrypted backup contradicts §18, so it must be a
  # visible choice rather than an accident of an unset variable.
  printf '[backup] WARN: BOSANDA_BACKUP_GPG_RECIPIENT is unset — dump is NOT ENCRYPTED.\n' >&2
  printf '[backup] WARN: this violates PLAN.md §18. Set the recipient before launch.\n' >&2
fi

chmod 0600 "$final"

size="$(wc -c < "$final" | tr -d ' ')"
log "backup complete: $final ($size bytes)"

# A suspiciously small dump usually means an empty or wrong database. Warn rather
# than fail, because a genuinely fresh install IS small.
if [ "$size" -lt 4096 ]; then
  printf '[backup] WARN: dump is only %s bytes — verify it covers the real database.\n' "$size" >&2
fi

# --- Retention -------------------------------------------------------------
# Prune by mtime. Runs AFTER a successful new backup, so a failing backup can
# never delete the last good one.
log "pruning backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'bosanda-*.dump' -o -name 'bosanda-*.dump.gpg' \) \
  -mtime "+$RETENTION_DAYS" -print -delete

# Clean up any stale .partial files from previous interrupted runs.
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.partial' -mtime +1 -print -delete

remaining="$(find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'bosanda-*.dump' -o -name 'bosanda-*.dump.gpg' \) | wc -l | tr -d ' ')"
log "$remaining backup(s) retained in $BACKUP_DIR"

# Zero retained backups after a successful run is impossible unless something is
# badly wrong with the directory. Fail loudly.
[ "$remaining" -gt 0 ] || die "no backups present after run; check $BACKUP_DIR permissions"

# Reminder that a backup is not a backup until restored (§18).
log "NOTE: restore drill runs weekly via bosanda-restore-drill.timer"
log "      run it now with: ./scripts/restore.sh --drill"
