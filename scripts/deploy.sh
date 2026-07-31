#!/bin/sh
# Bosanda deployment (PLAN.md §18, §20 M4).
#
# Build -> migrate -> restart -> health check, with an explicit rollback path.
#
# POSIX sh. Idempotent: running it twice on the same commit converges to the same
# state. Fails loudly: any non-zero command aborts before the next stage.
#
#   Usage: sudo ./scripts/deploy.sh [git-ref]
#          sudo ./scripts/deploy.sh --rollback
#
# OWNER ACTION: this script has NEVER been executed. It was authored on a machine
# with no systemd, no nginx, and no PostgreSQL. Read it, then run it the first
# time with BOSANDA_DRY_RUN=1 to print the plan without touching anything.
#
# PORTABILITY: the shell syntax is POSIX (verified with `dash -n`), but three
# utilities are GNU coreutils extensions and are used deliberately:
#   mv -T        treat the destination as a file, never as a directory — this is
#                what makes the symlink swap atomic instead of creating
#                current/<release> when current already exists.
#   readlink -f  resolve the symlink target.
#   env -C dir   run in a directory without a subshell `cd`.
# All three are present on Ubuntu 22.04+ (the §22 target platform). This script
# will NOT run correctly on macOS or BSD without gnu coreutils installed.

set -eu
# Pipelines fail on the first failing stage, not just the last. `set -o pipefail`
# is not in POSIX sh but dash/bash on Ubuntu both support it; guard so the script
# still runs under a shell that does not.
# shellcheck disable=SC3040
(set -o pipefail 2>/dev/null) && set -o pipefail

# --- Configuration ---------------------------------------------------------
APP_ROOT="${BOSANDA_APP_ROOT:-/opt/bosanda}"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
REPO_URL="${BOSANDA_REPO_URL:-https://github.com/bosanda/bosanda.git}"
HEALTH_URL="${BOSANDA_HEALTH_URL:-https://api.bosanda.dev/health}"
KEEP_RELEASES="${BOSANDA_KEEP_RELEASES:-5}"
DRY_RUN="${BOSANDA_DRY_RUN:-0}"

# Order matters on start: worker and apps first, gateway LAST so it only starts
# accepting customer traffic once its dependencies are already up.
SERVICES="bosanda-worker bosanda-web bosanda-admin bosanda-gateway"

log()  { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] WARN: %s\n' "$*" >&2; }
die()  { printf '[deploy] FATAL: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[deploy] DRY-RUN would run: %s\n' "$*"
  else
    "$@"
  fi
}

require_root() {
  [ "$(id -u)" = "0" ] || die "must run as root (systemctl and /etc/bosanda access)"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# --- Health check ----------------------------------------------------------
# Polls until the gateway reports healthy. This is what makes the deploy
# verifiable rather than hopeful: without it, a deploy that starts a crashlooping
# process would report success.
wait_for_health() {
  attempts="${1:-30}"
  i=0
  while [ "$i" -lt "$attempts" ]; do
    i=$((i + 1))
    # --fail turns a 5xx into a non-zero exit. --max-time bounds a hung socket.
    if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "health check passed after ${i} attempt(s)"
      return 0
    fi
    sleep 2
  done
  return 1
}

# --- Rollback --------------------------------------------------------------
#
# THE ROLLBACK CONTRACT, stated plainly:
#
#   Code rolls back. DATABASE MIGRATIONS DO NOT.
#
# PLAN.md §14 requires migrations to be ordered and immutable after release, and
# this script deliberately has no `migrate:down`. Rolling the schema backwards
# automatically is how you turn a bad deploy into data loss.
#
# The practical consequence: every migration must be BACKWARD COMPATIBLE with the
# previous release (add columns nullable or with defaults, never rename or drop in
# the same release that starts using the new shape). Then rolling code back to
# N-1 against an N schema is safe. Enforce this in review; nothing here can check
# it for you.
#
# If a migration is NOT backward compatible and it has already run, do not use
# this rollback. Go to docs/incident-response.md -> "Database loss or corruption"
# and restore from backup instead, accepting the data loss window.
rollback() {
  previous="$(find "$RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d | sort | tail -n 2 | head -n 1)"
  [ -n "$previous" ] || die "no previous release to roll back to"
  [ -d "$previous" ] || die "previous release is not a directory: $previous"

  current_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo none)"
  if [ "$previous" = "$current_target" ]; then
    die "previous release IS the current release; nothing to roll back to"
  fi

  log "rolling back to $previous"
  # Atomic symlink swap: ln -sfn to a temp name then mv, so there is never a
  # moment where `current` does not exist.
  run ln -sfn "$previous" "$CURRENT_LINK.tmp"
  run mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"

  for service in $SERVICES; do
    log "restarting $service"
    run systemctl restart "$service"
  done

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: skipping health check"
    return 0
  fi

  if wait_for_health 30; then
    log "ROLLBACK COMPLETE and healthy: $previous"
  else
    die "ROLLBACK FAILED health check. The box is now serving $previous and still
     unhealthy, which means the fault is probably NOT in the application code.
     Check, in order:
       systemctl status bosanda-gateway
       journalctl -u bosanda-gateway -n 200 --no-pager
       systemctl status postgresql
       nginx -t && systemctl status nginx
     Then follow docs/incident-response.md."
  fi
}

# --- Main ------------------------------------------------------------------
main() {
  require_root

  if [ "${1:-}" = "--rollback" ]; then
    rollback
    return 0
  fi

  ref="${1:-main}"

  require_cmd git
  require_cmd curl
  require_cmd systemctl
  require_cmd pnpm

  # Refuse to deploy without the env files: better to stop here than to restart
  # services into a ConfigError crashloop.
  for envfile in gateway worker web admin; do
    [ -f "/etc/bosanda/$envfile.env" ] \
      || die "missing /etc/bosanda/$envfile.env (see deploy/env/.env.example)"
  done

  mkdir -p "$RELEASES_DIR"

  # Release directories are timestamped so they sort chronologically, which is
  # what the rollback logic relies on.
  release="$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
  log "deploying ref '$ref' into $release"

  # --- Fetch ---------------------------------------------------------------
  run git clone --depth 1 --branch "$ref" "$REPO_URL" "$release" \
    || die "clone failed for ref '$ref'"

  if [ "$DRY_RUN" != "1" ]; then
    deployed_sha="$(git -C "$release" rev-parse --short HEAD)"
    log "deploying commit $deployed_sha"
  fi

  # --- Install and build ---------------------------------------------------
  # --frozen-lockfile: a deploy must never silently resolve a different dependency
  # tree than the one that passed CI.
  log "installing dependencies"
  run env -C "$release" pnpm install --frozen-lockfile --prod=false

  # Verify before building. Cheap insurance: catches a bad merge before the
  # symlink moves.
  log "typechecking"
  run env -C "$release" pnpm run typecheck

  log "building Next apps"
  run env -C "$release" pnpm --filter ./apps/web build
  run env -C "$release" pnpm --filter ./apps/admin build

  run chown -R bosanda:bosanda "$release"

  # --- Migrate -------------------------------------------------------------
  # Runs BEFORE the symlink swap and BEFORE restart, so the new code never sees
  # an old schema. Requires migrations to be backward compatible — see the
  # rollback() comment above.
  #
  # A failed migration aborts here, leaving `current` untouched and the running
  # services on the old release. That is the safe outcome.
  log "running migrations"
  if ! run env -C "$release" pnpm run db:migrate; then
    warn "migration FAILED — current release left untouched, services not restarted"
    warn "inspect, fix, then re-run. Partial migration state may need manual repair:"
    warn "  journalctl -u bosanda-gateway -n 50 --no-pager"
    die "aborting deploy after migration failure"
  fi

  # --- Activate ------------------------------------------------------------
  previous_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo none)"
  log "previous release was $previous_target"

  log "switching $CURRENT_LINK -> $release"
  run ln -sfn "$release" "$CURRENT_LINK.tmp"
  run mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"

  # --- Restart -------------------------------------------------------------
  # Gateway restarts LAST (see $SERVICES ordering). Its SIGTERM handler drains
  # in-flight streams first; TimeoutStopSec=660 in the unit gives a long turn
  # room to finish, so a restart during traffic does not cut a customer's stream
  # mid-token.
  for service in $SERVICES; do
    log "restarting $service"
    run systemctl restart "$service" \
      || warn "systemctl restart $service returned non-zero; health check will decide"
  done

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN complete; no changes were made"
    return 0
  fi

  # --- Verify --------------------------------------------------------------
  if wait_for_health 30; then
    log "deploy OK: $release ($deployed_sha)"
  else
    warn "health check FAILED after restart — rolling back automatically"
    rollback
    die "deploy of $release failed health check and was rolled back"
  fi

  # --- Prune ---------------------------------------------------------------
  # Keep the last N releases so rollback has somewhere to go. Never prune the
  # release `current` points at.
  log "pruning old releases (keeping $KEEP_RELEASES)"
  find "$RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d \
    | sort -r \
    | tail -n +$((KEEP_RELEASES + 1)) \
    | while IFS= read -r old; do
        if [ "$old" = "$(readlink -f "$CURRENT_LINK")" ]; then
          continue
        fi
        log "removing old release $old"
        rm -rf "$old"
      done

  log "done"
}

main "$@"
