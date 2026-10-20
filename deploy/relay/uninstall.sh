#!/usr/bin/env bash
# Roll back install.sh: remove ONLY the nginx site file, container/network/image and
# state files that install.sh created. Existing nginx files are never touched.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'USAGE'
Usage: uninstall.sh [--env-file relay.env] [--dry-run]
Removes the vibe-relay nginx site file (after nginx -t), the compose project and its local image.
USAGE
}

parse_common_args "$@"
load_env
MANIFEST="$STATE_DIR/manifest"

if [ "$DRY_RUN" = 0 ]; then
  require_root_and_tools
fi

# 1. nginx site file: only if it carries our marker; restore it if nginx -t then fails
if [ "$DRY_RUN" = 1 ]; then
  echo "+ [if $SITE_FILE contains '$SITE_MARKER'] remove $SITE_FILE; nginx -t; nginx -s reload (restore the file and abort if nginx -t fails)"
elif [ -f "$SITE_FILE" ]; then
  grep -qF "$SITE_MARKER" "$SITE_FILE" || die "$SITE_FILE is not managed by vibe-relay; leaving it alone"
  cp -f "$SITE_FILE" "$SITE_FILE.uninstall-bak"
  rm -f "${SITE_FILE:?}"
  if nginx -t; then
    nginx -s reload
    rm -f "${SITE_FILE:?}.uninstall-bak"
  else
    mv -f "$SITE_FILE.uninstall-bak" "$SITE_FILE"
    die "nginx -t failed after removal; site file restored, nothing reloaded"
  fi
else
  log "site file already absent: $SITE_FILE"
fi

# 2. container, network and locally built image (no volumes are used)
compose down --rmi local --remove-orphans

# 3. state files we created (non-recursive); keep the app env file if it has content
if [ "$DRY_RUN" = 1 ]; then
  echo "+ remove $MANIFEST, $STATE_DIR/nginx-summary-*.txt, $STATE_DIR/*.prev-*; remove $PUSH_ENV_FILE if install.sh created it; rmdir $STATE_DIR if empty"
else
  if [ -f "$MANIFEST" ] && grep -q '^PUSH_ENV_CREATED=.' "$MANIFEST"; then
    rm -f "${PUSH_ENV_FILE:?}"
  elif [ -f "$PUSH_ENV_FILE" ]; then
    log "kept $PUSH_ENV_FILE (not created by install.sh); delete it by hand if no longer needed"
  fi
  rm -f "${MANIFEST:?}" "${STATE_DIR:?}"/nginx-summary-*.txt "${STATE_DIR:?}"/*.prev-*
  rmdir "$STATE_DIR" 2>/dev/null || true
fi
log "Rollback complete."
