#!/bin/sh
# Probe all three vhosts plus the worker (PLAN.md §17, §18).
#
# Exit 0 = everything healthy. Exit 1 = at least one probe failed.
# Safe to run from cron/monitoring: read-only, no side effects, no auth needed.
#
#   Usage: ./scripts/healthcheck.sh [--local]
#          --local  probe 127.0.0.1 ports directly, bypassing nginx and DNS.
#                   Use this to tell "app is down" apart from "nginx/TLS/DNS is
#                   broken": if --local passes and the default run fails, the
#                   fault is at the edge, not in the application.
#
# OWNER ACTION: never executed against a real deployment.

set -eu
# shellcheck disable=SC3040
(set -o pipefail 2>/dev/null) && set -o pipefail

LOCAL=0
[ "${1:-}" = "--local" ] && LOCAL=1

FAILURES=0
TIMEOUT="${BOSANDA_HEALTH_TIMEOUT:-5}"

log()  { printf '[health] %s\n' "$*"; }
ok()   { printf '[health]   OK      %s\n' "$*"; }
fail() { printf '[health]   FAIL    %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
skip() { printf '[health]   SKIP    %s\n' "$*"; }

command -v curl >/dev/null 2>&1 || { printf 'curl is required\n' >&2; exit 2; }

# --- HTTP probe ------------------------------------------------------------
# Checks the status code only. Deliberately does NOT log the response body: an
# error body could contain operator detail we do not want in a monitoring log
# (§16 — only publicMessage crosses the boundary, and this output may be shipped).
probe() {
  label="$1"
  url="$2"
  expect="${3:-200}"

  code="$(curl --silent --show-error --output /dev/null \
            --max-time "$TIMEOUT" --write-out '%{http_code}' \
            "$url" 2>/dev/null || echo 000)"

  if [ "$code" = "$expect" ]; then
    ok "$label -> $code"
  elif [ "$code" = "000" ]; then
    fail "$label -> no response (DNS, TLS, connection refused, or timeout after ${TIMEOUT}s)"
  else
    fail "$label -> HTTP $code (expected $expect)"
  fi
}

if [ "$LOCAL" = "1" ]; then
  log "probing local ports directly (bypassing nginx/TLS/DNS)"
  probe "gateway  127.0.0.1:4000/health" "http://127.0.0.1:4000/health"
  probe "web      127.0.0.1:3000"        "http://127.0.0.1:3000"
  probe "admin    127.0.0.1:3001"        "http://127.0.0.1:3001" 200
else
  log "probing public vhosts"

  # Gateway health endpoint. This is the probe scripts/deploy.sh gates on.
  probe "api.bosanda.dev/health" "https://api.bosanda.dev/health"

  # The API root should NOT be 200 — an unauthenticated request must be rejected.
  # A 200 here would mean the auth boundary is broken, so 401 is the healthy
  # answer (§8 error mapping: authentication_error -> 401).
  probe "api.bosanda.dev/v1/models (expect 401 unauthenticated)" \
        "https://api.bosanda.dev/v1/models" 401

  probe "bosanda.dev"       "https://bosanda.dev"
  probe "admin.bosanda.dev" "https://admin.bosanda.dev"

  # /metrics must be denied at the edge (§17: operator-only).
  # 403 is the healthy answer. A 200 means the metrics endpoint is world-readable.
  code="$(curl --silent --output /dev/null --max-time "$TIMEOUT" \
            --write-out '%{http_code}' "https://api.bosanda.dev/metrics" 2>/dev/null || echo 000)"
  case "$code" in
    403|404) ok "api.bosanda.dev/metrics is not public -> $code" ;;
    200)     fail "api.bosanda.dev/metrics returned 200 — METRICS ARE PUBLIC, fix the vhost deny rule" ;;
    *)       fail "api.bosanda.dev/metrics -> unexpected $code" ;;
  esac

  # HTTP->HTTPS redirect (§16 / §18).
  for host in bosanda.dev admin.bosanda.dev api.bosanda.dev; do
    code="$(curl --silent --output /dev/null --max-time "$TIMEOUT" \
              --write-out '%{http_code}' "http://$host" 2>/dev/null || echo 000)"
    case "$code" in
      301|308) ok "http://$host redirects -> $code" ;;
      *)       fail "http://$host did not redirect (got $code) — check the port 80 server block" ;;
    esac
  done

  # HSTS must be present (§16).
  if curl --silent --head --max-time "$TIMEOUT" https://api.bosanda.dev/health 2>/dev/null \
       | grep -qi '^strict-transport-security:'; then
    ok "HSTS header present on api.bosanda.dev"
  else
    fail "HSTS header MISSING on api.bosanda.dev — check the security-headers snippet"
  fi
fi

# --- Worker ----------------------------------------------------------------
# The worker takes no inbound traffic, so there is no port to probe. Liveness is
# systemd's view plus evidence it is actually doing work.
if command -v systemctl >/dev/null 2>&1; then
  for service in bosanda-worker bosanda-gateway bosanda-web bosanda-admin; do
    if systemctl is-active --quiet "$service" 2>/dev/null; then
      ok "systemd: $service active"
    else
      state="$(systemctl is-active "$service" 2>/dev/null || echo unknown)"
      fail "systemd: $service is $state  (journalctl -u $service -n 50 --no-pager)"
    fi
  done

  # A worker that is "active" but wedged is the failure mode a port probe would
  # miss entirely. If it has logged nothing in 15 minutes, treat it as suspect:
  # the reconciliation loop should tick well within that window.
  if systemctl is-active --quiet bosanda-worker 2>/dev/null; then
    if journalctl -u bosanda-worker --since '15 min ago' --no-pager -q 2>/dev/null | grep -q .; then
      ok "worker has logged activity in the last 15 minutes"
    else
      fail "worker is active but SILENT for 15 minutes — possibly wedged, check for a stuck job"
    fi
  fi

  # Backup timer should exist and be scheduled (§18).
  if systemctl list-timers bosanda-backup.timer --no-pager 2>/dev/null | grep -q bosanda-backup; then
    ok "backup timer is scheduled"
  else
    fail "bosanda-backup.timer is not scheduled — backups are NOT running"
  fi
else
  skip "systemctl unavailable; cannot check worker or timers from this host"
fi

# --- PostgreSQL ------------------------------------------------------------
if command -v pg_isready >/dev/null 2>&1; then
  if pg_isready --quiet --timeout="$TIMEOUT" 2>/dev/null; then
    ok "postgresql accepting connections"
  else
    fail "postgresql NOT accepting connections"
  fi
else
  skip "pg_isready unavailable"
fi

# --- Certificate expiry ----------------------------------------------------
# certbot renews automatically, but a broken renewal timer is silent until the
# cert actually expires and every client breaks at once. 20 days of warning.
if [ "$LOCAL" != "1" ] && command -v openssl >/dev/null 2>&1; then
  for host in bosanda.dev admin.bosanda.dev api.bosanda.dev; do
    if expiry="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
                  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"; then
      if [ -n "$expiry" ]; then
        # -checkend needs seconds; 20 days = 1728000.
        if echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
             | openssl x509 -noout -checkend 1728000 >/dev/null 2>&1; then
          ok "cert for $host valid >20 days (expires $expiry)"
        else
          fail "cert for $host expires within 20 days ($expiry) — check certbot.timer"
        fi
      else
        skip "could not read cert expiry for $host"
      fi
    else
      skip "could not connect to $host:443 for cert check"
    fi
  done
fi

# --- Summary ---------------------------------------------------------------
if [ "$FAILURES" -eq 0 ]; then
  log "all checks passed"
  exit 0
fi

log "$FAILURES check(s) FAILED"
exit 1
