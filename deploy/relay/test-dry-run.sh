#!/usr/bin/env bash
# Offline checks for the relay deploy scripts: no docker, nginx or network needed.
# Usage: bash deploy/relay/test-dry-run.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
FAILS=0

ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
expect_contains() { grep -qF -- "$2" <<<"$1" && ok "$3" || bad "$3 (missing: $2)"; }
expect_absent() { grep -qF -- "$2" <<<"$1" && bad "$3 (found: $2)" || ok "$3"; }

sed -e 's/<PINNED_TAG_OR_SHA>/v0.0.0-example/' -e 's/^PUSH_PORT=18787$/PUSH_PORT=18787/' \
  "$DIR/relay.env.example" >"$TMP/relay.env"

out="$(bash "$DIR/install.sh" --env-file "$TMP/relay.env" --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "install --dry-run exits 0" || bad "install --dry-run exits 0 (rc=$rc)"
expect_contains "$out" "server_name relay.example.com;" "site has server_name"
expect_contains "$out" "proxy_pass http://127.0.0.1:14000;" "relay proxied to loopback port"
expect_contains "$out" "proxy_pass http://127.0.0.1:18787/;" "push location rendered"
expect_contains "$out" 'proxy_set_header Upgrade $http_upgrade;' "websocket upgrade header"
expect_contains "$out" "proxy_read_timeout 3600s;" "long timeout"
expect_contains "$out" "+ nginx -t" "nginx -t is run"
expect_contains "$out" "nginx-summary" "nginx -T summary backup"
expect_contains "$out" "up -d --build" "compose up"
expect_contains "$out" "VIBE_PUSH_AUTH_TOKEN=<random-hex generated at install>" "push token generated into env file (placeholder in dry-run)"
expect_contains "$out" "push gateway /healthz" "push smoke check"
expect_contains "$out" "ssl_certificate     /etc/ssl/vibe-relay/fullchain.pem;" "existing cert referenced by path"
expect_absent "$out" "openssl x509" "certificate is never modified or inspected in dry-run"
expect_absent "$out" "@" "no unreplaced @placeholders@"
# nginx -t must come before reload
pos_t="$(grep -n '^+ nginx -t' <<<"$out" | head -1 | cut -d: -f1)"
pos_r="$(grep -n '^+ nginx -s reload' <<<"$out" | head -1 | cut -d: -f1)"
[ -n "$pos_t" ] && [ -n "$pos_r" ] && [ "$pos_t" -lt "$pos_r" ] && ok "nginx -t precedes reload" || bad "nginx -t precedes reload"

# without PUSH_PORT there is no push location
sed -e 's/<PINNED_TAG_OR_SHA>/v0.0.0-example/' -e 's/^PUSH_PORT=.*/PUSH_PORT=/' "$DIR/relay.env.example" >"$TMP/nopush.env"
out2="$(bash "$DIR/install.sh" --env-file "$TMP/nopush.env" --dry-run 2>&1)"
expect_absent "$out2" "location /push/" "no push location when PUSH_PORT empty"
expect_absent "$out2" "VIBE_PUSH_AUTH_TOKEN" "no push env file when PUSH_PORT empty"

# placeholder ref and missing vars are rejected
bash "$DIR/install.sh" --env-file "$DIR/relay.env.example" --dry-run >/dev/null 2>&1 && bad "placeholder RELAY_REF rejected" || ok "placeholder RELAY_REF rejected"
env -u RELAY_DOMAIN bash "$DIR/install.sh" --dry-run >/dev/null 2>&1 && bad "missing vars rejected" || ok "missing vars rejected"

# compose: both services bind loopback only, relay needs no env file
c="$(cat "$DIR/docker-compose.yml")"
expect_contains "$c" '127.0.0.1:${RELAY_PORT' "relay port bound to loopback"
expect_contains "$c" '127.0.0.1:${PUSH_PORT' "push port bound to loopback"
expect_absent "$c" "RELAY_APP_ENV_FILE" "relay has no app env file requirement"

# PUSH_PORT equal to RELAY_PORT is rejected
sed -e 's/<PINNED_TAG_OR_SHA>/v0.0.0-example/' -e 's/^PUSH_PORT=.*/PUSH_PORT=14000/' "$DIR/relay.env.example" >"$TMP/clash.env"
bash "$DIR/install.sh" --env-file "$TMP/clash.env" --dry-run >/dev/null 2>&1 && bad "PUSH_PORT == RELAY_PORT rejected" || ok "PUSH_PORT == RELAY_PORT rejected"

# uninstall dry-run
uout="$(bash "$DIR/uninstall.sh" --env-file "$TMP/relay.env" --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "uninstall --dry-run exits 0" || bad "uninstall --dry-run exits 0 (rc=$rc)"
expect_contains "$uout" "down --rmi local" "uninstall removes compose project"

# no real hosts / IPs in committed files
if grep -rEn '([0-9]{1,3}\.){3}[0-9]{1,3}' "$DIR" --include='*' -I 2>/dev/null | grep -v -E '127\.0\.0\.1|0\.0\.0\.0|test-dry-run.sh' | grep -q .; then
  bad "no non-loopback IPs in deploy/relay"
else ok "no non-loopback IPs in deploy/relay"; fi

if command -v shellcheck >/dev/null; then
  shellcheck "$DIR"/*.sh && ok "shellcheck" || bad "shellcheck"
else echo "skip - shellcheck not installed"; fi

: >"$TMP/app.env"
if command -v docker >/dev/null; then
  (cd "$DIR" && RELAY_REF=v0 RELAY_REF_TAG=v0 RELAY_PORT=14000 PUSH_PORT=18787 PUSH_ENV_FILE="$TMP/app.env" COMPOSE_PROFILES=push \
    docker compose -f docker-compose.yml config -q) && ok "docker compose config" || bad "docker compose config"
else echo "skip - docker not installed (docker compose config not run)"; fi

echo "failures: $FAILS"
[ "$FAILS" = 0 ]
