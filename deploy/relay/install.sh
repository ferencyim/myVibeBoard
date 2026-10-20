#!/usr/bin/env bash
# Deploy the paseo relay as an isolated docker container plus ONE new nginx site file.
# Run by hand on the server. Never edits existing nginx files. See README.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'USAGE'
Usage: install.sh [--env-file relay.env] [--dry-run]

  --env-file F   KEY=VALUE file (see relay.env.example); environment variables also work.
  --dry-run      Print every command and file that would be written; change nothing.

Required: RELAY_DOMAIN RELAY_PORT RELAY_REF TLS_CERT TLS_KEY
USAGE
}

parse_common_args "$@"
load_env
validate_install_env

MANIFEST="$STATE_DIR/manifest"
STAMP="$(date +%Y%m%d-%H%M%S)"
SITE_CREATED=0      # this run created SITE_FILE (it did not exist before)
SITE_PREV=""        # backup of our own previous site file, restored on failure
STACK_CREATED=0     # this run creates the compose project (no containers before)

render_site() {
  local push="" out
  if [ -n "$PUSH_PORT" ]; then
    push="$(sed "s|@PUSH_PORT@|$PUSH_PORT|g" "$SCRIPT_DIR/nginx-push-location.template")"
    push="$push"$'\n'
  fi
  out="$(sed -e "s|@RELAY_DOMAIN@|$RELAY_DOMAIN|g" -e "s|@TLS_CERT@|$TLS_CERT|g" \
    -e "s|@TLS_KEY@|$TLS_KEY|g" -e "s|@RELAY_PORT@|$RELAY_PORT|g" \
    "$SCRIPT_DIR/nginx-site.conf.template")"
  printf '%s\n' "${out//@PUSH_LOCATION@/$push}"
}

rollback() {
  log "Install failed; rolling back what this run added."
  if [ "$SITE_CREATED" = 1 ]; then
    rm -f "${SITE_FILE:?}" && log "removed $SITE_FILE"
  elif [ -n "$SITE_PREV" ] && [ -f "$SITE_PREV" ]; then
    cp -f "$SITE_PREV" "$SITE_FILE" && log "restored previous $SITE_FILE"
  fi
  if [ "$STACK_CREATED" = 1 ]; then
    docker compose --project-name "$RELAY_PROJECT" -f "$COMPOSE_FILE" down || true
  fi
}

preflight() {
  if [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] skipping preflight (root/docker/nginx present, TLS files readable, port free, domain/site file not in use)"
    return 0
  fi
  require_root_and_tools
  [ -r "$TLS_CERT" ] || die "TLS_CERT not readable: $TLS_CERT"
  [ -r "$TLS_KEY" ] || die "TLS_KEY not readable: $TLS_KEY"
  if command -v openssl >/dev/null && ! openssl x509 -in "$TLS_CERT" -noout -checkhost "$RELAY_DOMAIN" 2>/dev/null | grep -q 'does match'; then
    die "TLS_CERT does not cover $RELAY_DOMAIN (read-only check; the certificate is never modified)"
  fi
  if [ -n "$PUSH_PORT" ]; then
    [ -f "$SCRIPT_DIR/../../services/vibe-push-gateway/Dockerfile" ] || die "PUSH_PORT is set but services/vibe-push-gateway is not next to deploy/ (copy both directories)"
    if ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:${PUSH_PORT}[[:space:]]" && [ -z "$(docker compose --project-name "$RELAY_PROJECT" ps -q 2>/dev/null)" ]; then
      die "127.0.0.1:$PUSH_PORT is already in use by something else"
    fi
  fi
  if [ -e "$SITE_FILE" ] && ! grep -qF "$SITE_MARKER" "$SITE_FILE"; then
    die "$SITE_FILE exists and was not created by vibe-relay; refusing to touch it (pick another NGINX_SITE_NAME)"
  fi
  local domain_re="${RELAY_DOMAIN//./\\.}"
  if [ ! -e "$SITE_FILE" ] && nginx -T 2>/dev/null | grep -E "^[[:space:]]*server_name[[:space:]].*[[:space:]]${domain_re}[[:space:];]" >/dev/null; then
    die "$RELAY_DOMAIN already appears in an existing nginx server_name; refusing"
  fi
  if [ -z "$(docker compose --project-name "$RELAY_PROJECT" ps -q 2>/dev/null)" ]; then
    STACK_CREATED=1
    if ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:${RELAY_PORT}[[:space:]]"; then
      die "127.0.0.1:$RELAY_PORT is already in use by something else"
    fi
  fi
}

preflight

# 1. state dir + nginx -T summary backup (read-only on nginx)
run mkdir -p "$STATE_DIR"
if [ "$DRY_RUN" = 1 ]; then
  echo "+ nginx -T | grep -E 'configuration file|server_name|listen' > $STATE_DIR/nginx-summary-$STAMP.txt"
else
  nginx -T 2>&1 | grep -E 'configuration file|server_name|listen' >"$STATE_DIR/nginx-summary-$STAMP.txt" || true
fi

# 2. push gateway env file (holds the generated shared token; mode 600; never printed)
PUSH_ENV_CREATED=""
if [ -n "$PUSH_PORT" ] && { [ "$DRY_RUN" = 1 ] || [ ! -e "$PUSH_ENV_FILE" ]; }; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "VIBE_PUSH_AUTH_TOKEN=<random-hex generated at install>" | write_file "$PUSH_ENV_FILE" 600
  else
    echo "VIBE_PUSH_AUTH_TOKEN=$(openssl rand -hex 32)" | write_file "$PUSH_ENV_FILE" 600
  fi
  PUSH_ENV_CREATED="$PUSH_ENV_FILE"
fi

# 3. build + start the container (loopback-only port)
compose config -q
trap rollback ERR
compose up -d --build

# 4. new nginx site file, validated before reload
if [ "$DRY_RUN" = 0 ]; then
  if [ -e "$SITE_FILE" ]; then
    SITE_PREV="$STATE_DIR/$NGINX_SITE_NAME.prev-$STAMP"
    cp -f "$SITE_FILE" "$SITE_PREV"
  else
    SITE_CREATED=1
  fi
fi
render_site | write_file "$SITE_FILE" 644
run nginx -t
run nginx -s reload
trap - ERR

# 5. manifest (what uninstall.sh may remove)
{
  echo "SITE_FILE=$SITE_FILE"
  echo "RELAY_PROJECT=$RELAY_PROJECT"
  echo "PUSH_ENV_CREATED=$PUSH_ENV_CREATED"
  echo "INSTALLED_AT=$STAMP"
} | write_file "$MANIFEST" 600

# 6. non-fatal smoke check
if [ "$DRY_RUN" = 1 ]; then
  echo "+ curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$RELAY_PORT/health (and push gateway /healthz)"
else
  sleep 3
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$RELAY_PORT/health" || true)"
  log "relay /health answered HTTP ${code:-none} on 127.0.0.1:$RELAY_PORT (expect 200)"
  if [ -n "$PUSH_PORT" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PUSH_PORT/healthz" || true)"
    log "push gateway /healthz answered HTTP ${code:-none} on 127.0.0.1:$PUSH_PORT (expect 200)"
  fi
fi
log "Done. Daemon config: relay endpoint ${RELAY_DOMAIN}:443, useTls=true."
[ -z "$PUSH_PORT" ] || log "Push gateway token (daemon PASEO_PUSH_GATEWAY_TOKEN): see $PUSH_ENV_FILE"
