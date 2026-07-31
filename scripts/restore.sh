#!/bin/sh
# Restore / restore-drill for Bosanda PostgreSQL backups (PLAN.md §18).
#
# A backup you have never restored is not a backup, it is a hope. This script
# exists in two modes:
#
#   --drill            VERIFY the newest dump by restoring into a scratch database,
#                      running sanity queries, then dropping it. Touches nothing
#                      real. Run weekly by bosanda-restore-drill.timer.
#
#   --target <dbname>  Restore into a named database you have already created.
#
# Restoring over the LIVE database is deliberately awkward: it requires
# --i-understand-this-destroys-data plus an interactive typed confirmation. That
# friction is the point — this is the most destructive command in the repository.
#
#   Usage: ./scripts/restore.sh --drill
#          ./scripts/restore.sh --target bosanda_staging [--file <dump>]
#          ./scripts/restore.sh --target bosanda --i-understand-this-destroys-data
#
# OWNER ACTION: never executed — no PostgreSQL available where this was authored.

set -eu
# shellcheck disable=SC3040
(set -o pipefail 2>/dev/null) && set -o pipefail

BACKUP_DIR="${BOSANDA_BACKUP_DIR:-/var/backups/bosanda}"
LIVE_DB="${PGDATABASE:-bosanda}"

MODE=""
TARGET=""
DUMP_FILE=""
CONFIRMED=0

log() { printf '[restore] %s\n' "$*"; }
die() { printf '[restore] FATAL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  restore.sh --drill                       verify newest dump in a scratch DB
  restore.sh --target <db> [--file <dump>]  restore into <db>
  restore.sh --target <live-db> --i-understand-this-destroys-data

Options:
  --file <path>   dump to use (default: newest in $BOSANDA_BACKUP_DIR)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --drill) MODE="drill" ;;
    --target) MODE="target"; shift; TARGET="${1:-}" ;;
    --file) shift; DUMP_FILE="${1:-}" ;;
    --i-understand-this-destroys-data) CONFIRMED=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$MODE" ] || { usage; die "specify --drill or --target <db>"; }

command -v pg_restore >/dev/null 2>&1 || die "pg_restore not found"
command -v psql >/dev/null 2>&1 || die "psql not found"

# --- Locate the dump -------------------------------------------------------
if [ -z "$DUMP_FILE" ]; then
  # Newest by name; backup.sh names files with a sortable UTC stamp.
  DUMP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'bosanda-*.dump' -o -name 'bosanda-*.dump.gpg' \) \
    | sort | tail -n 1)"
  [ -n "$DUMP_FILE" ] || die "no backup found in $BACKUP_DIR"
fi
[ -f "$DUMP_FILE" ] || die "dump not found: $DUMP_FILE"

log "using dump: $DUMP_FILE"

# --- Decrypt if needed -----------------------------------------------------
# Decrypt into a private temp dir. PrivateTmp=true in the systemd unit means this
# directory is destroyed when the unit stops, so plaintext never outlives the run.
WORK_DIR="$(mktemp -d)"
# Always clean up, including on failure — the decrypted dump is sensitive.
# shellcheck disable=SC2064
trap "rm -rf '$WORK_DIR'" EXIT INT TERM

case "$DUMP_FILE" in
  *.gpg)
    command -v gpg >/dev/null 2>&1 || die "encrypted dump but gpg not found"
    log "decrypting (requires the PRIVATE key — normally offline, so this step"
    log "  is expected to FAIL on the VPS by design; run it on the machine that"
    log "  holds the private key)"
    plain="$WORK_DIR/restore.dump"
    gpg --batch --yes --output "$plain" --decrypt "$DUMP_FILE" \
      || die "gpg decryption failed — is the private key present on this host?"
    ;;
  *)
    plain="$DUMP_FILE"
    log "dump is not encrypted"
    ;;
esac

# --- VERIFY BEFORE RESTORING ----------------------------------------------
# This is the step that distinguishes a real restore procedure from a hopeful one.
# pg_restore --list parses the archive header and full table of contents; a
# truncated, corrupted, or non-archive file fails here, before we have dropped
# anything.
log "verifying archive integrity"
toc="$WORK_DIR/toc.txt"
pg_restore --list "$plain" > "$toc" 2>/dev/null \
  || die "archive is CORRUPT or not a pg_dump custom archive: $DUMP_FILE"

entries="$(grep -c '^[0-9]' "$toc" || true)"
log "archive table of contents: $entries entries"
[ "${entries:-0}" -gt 0 ] || die "archive contains no restorable entries"

# Sanity: the dump must actually contain the tables PLAN.md §14 requires. A dump
# of the wrong database would pass the integrity check but be useless.
for expected in users api_keys orders quota_ledger provider_accounts; do
  if grep -q "TABLE.* $expected " "$toc" || grep -q " $expected " "$toc"; then
    log "  found expected table: $expected"
  else
    printf '[restore] WARN: expected table "%s" not visible in TOC\n' "$expected" >&2
  fi
done

# --- Drill mode ------------------------------------------------------------
if [ "$MODE" = "drill" ]; then
  # Unique scratch name so a drill can never collide with anything real, and so
  # two overlapping drills do not fight.
  scratch="bosanda_drill_$(date -u +%Y%m%d%H%M%S)_$$"
  log "drill: restoring into scratch database $scratch"

  # Guard against the one catastrophic typo: a scratch name equal to the live DB.
  [ "$scratch" != "$LIVE_DB" ] || die "refusing: scratch name equals live database"

  createdb "$scratch" || die "could not create scratch database $scratch"

  # Always drop the scratch DB, even if verification fails below.
  # shellcheck disable=SC2064
  trap "psql -q -d postgres -c 'DROP DATABASE IF EXISTS \"$scratch\"' >/dev/null 2>&1; rm -rf '$WORK_DIR'" EXIT INT TERM

  # --exit-on-error: a partial restore that "mostly worked" is a failed drill.
  if pg_restore --dbname="$scratch" --no-owner --no-acl --exit-on-error "$plain" >/dev/null 2>&1; then
    log "drill: restore completed without error"
  else
    die "DRILL FAILED: pg_restore could not restore the newest backup.
     The backups are NOT usable. Treat this as an incident:
     see docs/incident-response.md -> 'Database loss or corruption'."
  fi

  # Sanity queries: a schema-only restore would pass the step above, so confirm
  # the tables exist and are queryable.
  log "drill: running sanity queries"
  for table in users api_keys orders quota_ledger provider_accounts models; do
    if count="$(psql -tAX -d "$scratch" -c "SELECT count(*) FROM $table" 2>/dev/null)"; then
      log "  $table: $count row(s)"
    else
      printf '[restore] WARN: could not query table %s in the restored copy\n' "$table" >&2
    fi
  done

  # Ledger integrity spot-check (§10: no balance without a matching ledger row).
  # A drill is a good moment to notice drift, since we already have a queryable copy.
  if drift="$(psql -tAX -d "$scratch" -c \
      "SELECT count(*) FROM api_keys k WHERE NOT EXISTS (
         SELECT 1 FROM quota_ledger l WHERE l.api_key_id = k.id)" 2>/dev/null)"; then
    if [ "${drift:-0}" -gt 0 ]; then
      printf '[restore] WARN: %s api_key row(s) have no ledger entry at all — investigate (§10).\n' "$drift" >&2
    else
      log "  ledger spot-check: every api_key has at least one ledger row"
    fi
  fi

  log "DRILL PASSED: $DUMP_FILE is restorable"
  log "scratch database $scratch will now be dropped"
  exit 0
fi

# --- Targeted restore ------------------------------------------------------
[ -n "$TARGET" ] || die "--target requires a database name"

if [ "$TARGET" = "$LIVE_DB" ]; then
  [ "$CONFIRMED" = "1" ] || die "refusing to restore over the LIVE database '$LIVE_DB'.
     This DESTROYS all current data: every order, key, and ledger row written
     since the dump was taken is lost and CANNOT be recovered.
     If that is genuinely what you want, re-run with:
       --i-understand-this-destroys-data
     Before you do, read docs/incident-response.md -> 'Database loss or corruption'
     and STOP the application services first, or in-flight writes will race the
     restore and leave inconsistent state."

  # Even with the flag, require a typed confirmation when a human is present.
  if [ -t 0 ]; then
    printf '[restore] Type the database name "%s" to confirm destruction: ' "$TARGET"
    read -r typed
    [ "$typed" = "$TARGET" ] || die "confirmation did not match; aborting"
  else
    log "non-interactive: proceeding on the strength of the explicit flag"
  fi

  # Refuse while the app is still writing. A restore under live traffic produces
  # a database that matches neither the backup nor the previous state.
  if command -v systemctl >/dev/null 2>&1; then
    for service in bosanda-gateway bosanda-worker; do
      if systemctl is-active --quiet "$service" 2>/dev/null; then
        die "$service is still running. Stop it first:
     systemctl stop bosanda-gateway bosanda-worker"
      fi
    done
  fi
fi

log "restoring into $TARGET"
# --clean --if-exists drops existing objects first so the restore is idempotent
# and does not fail on pre-existing tables.
if pg_restore --dbname="$TARGET" --no-owner --no-acl --clean --if-exists \
     --exit-on-error "$plain"; then
  log "restore into $TARGET completed"
else
  die "restore into $TARGET FAILED. The database is likely in a PARTIAL state.
     Do not start the services. Either re-run the restore or rebuild the
     database from scratch, then follow docs/incident-response.md."
fi

log "post-restore checks"
for table in users api_keys orders quota_ledger; do
  count="$(psql -tAX -d "$TARGET" -c "SELECT count(*) FROM $table" 2>/dev/null || echo '?')"
  log "  $table: $count row(s)"
done

cat <<'EOF'
[restore] NEXT STEPS (do not skip):
  1. Confirm the application encryption keys match this dump's era. Ciphertext in
     api_keys.encrypted_key and provider_accounts.encrypted_credentials is
     readable ONLY with the keyring that wrote it. A restored database plus the
     wrong PROVIDER_ENCRYPTION_KEY / API_KEY_ENCRYPTION_KEY means every provider
     account and key reveal fails. Check ENCRYPTION_KEY_VERSION alignment.
  2. Run pending migrations:  pnpm run db:migrate
  3. Start services:          systemctl start bosanda-gateway bosanda-worker
  4. Verify:                  ./scripts/healthcheck.sh
  5. Reconcile any orders paid after the dump timestamp — those payments exist at
     Pakasir but not in this database. See docs/incident-response.md.
EOF
