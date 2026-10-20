#!/usr/bin/env bash
# Shared helpers for install.sh / uninstall.sh. Sourced, not executed.
# shellcheck shell=bash

DRY_RUN=0
SITE_MARKER="# managed-by: vibe-relay"

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# run <cmd...>: print the command in dry-run mode, otherwise execute it.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# write_file <path> <mode>  (content on stdin): print in dry-run, else atomic write.
write_file() {
  local path="$1" mode="$2" tmp
  if [ "$DRY_RUN" = 1 ]; then
    printf -- '--- would write %s (mode %s) ---\n' "$path" "$mode"
    cat
    printf -- '--- end %s ---\n' "$path"
    return 0
  fi
  tmp="$(mktemp "${path}.tmp.XXXXXX")"
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
}

# parse_common_args "$@": sets DRY_RUN and ENV_FILE.
ENV_FILE=""
parse_common_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --env-file) [ $# -ge 2 ] || die "--env-file needs a path"; ENV_FILE="$2"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
}

# load_env: source ENV_FILE (if any) on top of the current environment, apply defaults.
load_env() {
  if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
  : "${NGINX_SITE_NAME:=vibe-relay.conf}"
  : "${NGINX_CONF_DIR:=/etc/nginx/conf.d}"
  : "${RELAY_CONTAINER_PORT:=4000}"
  : "${RELAY_PROJECT:=vibe-relay}"
  : "${RELAY_MEM_LIMIT:=512m}"
  : "${RELAY_CPUS:=1.0}"
  : "${RELAY_PIDS_LIMIT:=256}"
  : "${PUSH_PORT:=}"
  : "${STATE_DIR:=/var/lib/vibe-relay}"
  : "${PUSH_ENV_FILE:=$STATE_DIR/push-gateway.env}"
  : "${RELAY_MEMORY_WATERMARK_BYTES:=0}"
  : "${RELAY_REF:=unset}"
  : "${RELAY_PORT:=0}"
  RELAY_REF_TAG="${RELAY_REF//\//-}"
  export RELAY_PROJECT RELAY_PORT RELAY_REF RELAY_REF_TAG RELAY_CONTAINER_PORT PUSH_ENV_FILE PUSH_PORT
  export RELAY_MEMORY_WATERMARK_BYTES
  if [ -n "${HEX_MIRROR:-}" ]; then export HEX_MIRROR; fi
  if [ -n "${DEBIAN_MIRROR:-}" ]; then export DEBIAN_MIRROR; fi
  if [ -n "$PUSH_PORT" ]; then export COMPOSE_PROFILES=push; else unset COMPOSE_PROFILES; fi
  export RELAY_MEM_LIMIT RELAY_CPUS RELAY_PIDS_LIMIT
  SITE_FILE="$NGINX_CONF_DIR/$NGINX_SITE_NAME"
  COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
  # RELAY_BUILD_MIRRORS=1: build through package mirrors (docker-compose.mirrors.yml).
  COMPOSE_FILES=(-f "$COMPOSE_FILE")
  if [ "${RELAY_BUILD_MIRRORS:-0}" = 1 ]; then
    COMPOSE_FILES+=(-f "$SCRIPT_DIR/docker-compose.mirrors.yml")
  fi
}

validate_install_env() {
  local v
  for v in RELAY_DOMAIN RELAY_PORT RELAY_REF TLS_CERT TLS_KEY; do
    [ -n "${!v:-}" ] || die "$v is required (set it in the env file or environment)"
  done
  [ "$RELAY_REF" != unset ] || die "RELAY_REF is required"
  [ "$RELAY_PORT" != 0 ] || die "RELAY_PORT is required"
  [[ "$RELAY_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "invalid RELAY_DOMAIN: $RELAY_DOMAIN"
  [[ "$RELAY_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid RELAY_REF (placeholder?): $RELAY_REF"
  [[ "$RELAY_PORT" =~ ^[0-9]+$ ]] || die "RELAY_PORT must be a number"
  [[ "$RELAY_MEMORY_WATERMARK_BYTES" =~ ^[0-9]+$ ]] || die "RELAY_MEMORY_WATERMARK_BYTES must be a number"
  [ -z "$PUSH_PORT" ] || [ "$PUSH_PORT" != "$RELAY_PORT" ] || die "PUSH_PORT must differ from RELAY_PORT"
  [[ "$RELAY_CONTAINER_PORT" =~ ^[0-9]+$ ]] || die "RELAY_CONTAINER_PORT must be a number"
  [[ -z "$PUSH_PORT" || "$PUSH_PORT" =~ ^[0-9]+$ ]] || die "PUSH_PORT must be a number or empty"
  [[ "$NGINX_SITE_NAME" =~ ^[A-Za-z0-9._-]+\.conf$ ]] || die "NGINX_SITE_NAME must be a plain file name ending in .conf"
  [[ "$RELAY_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid RELAY_PROJECT"
}

compose() {
  run docker compose --project-name "$RELAY_PROJECT" "${COMPOSE_FILES[@]}" "$@"
}

require_root_and_tools() {
  [ "$(id -u)" = 0 ] || die "run as root (needs docker, nginx reload and /etc/nginx/conf.d write access)"
  command -v docker >/dev/null || die "docker not found"
  docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
  command -v nginx >/dev/null || die "nginx not found"
}
