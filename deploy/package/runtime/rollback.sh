#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="/opt/ask-metric"
TARGET_RELEASE=""
RESTART_SERVICE=true
SERVICE_NAME="ask-metric-backend"

usage() {
  echo "Usage: rollback.sh [--install-root PATH] [--release VERSION] [--service-name NAME] [--no-restart]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --release) TARGET_RELEASE="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --no-restart) RESTART_SERVICE=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

RELEASES_DIR="$INSTALL_ROOT/releases"
CURRENT_TARGET=""
if [[ -L "$INSTALL_ROOT/current" ]]; then
  CURRENT_TARGET="$(readlink -f "$INSTALL_ROOT/current")"
fi

if [[ -z "$TARGET_RELEASE" ]]; then
  mapfile -t CANDIDATES < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d \
    ! -name '.*.installing.*' -printf '%T@ %p\n' | sort -rn | awk '{print $2}')
  for candidate in "${CANDIDATES[@]}"; do
    if [[ "$candidate" != "$CURRENT_TARGET" ]]; then
      TARGET_RELEASE="$(basename -- "$candidate")"
      break
    fi
  done
fi

if [[ -z "$TARGET_RELEASE" || ! "$TARGET_RELEASE" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]]; then
  echo "ERROR: no valid rollback release was selected" >&2
  exit 1
fi
TARGET_PATH="$RELEASES_DIR/$TARGET_RELEASE"
if [[ ! -d "$TARGET_PATH" || ! -x "$TARGET_PATH/venv/bin/python" ]]; then
  echo "ERROR: installed release not found: $TARGET_RELEASE" >&2
  exit 1
fi

LINK_TMP="$INSTALL_ROOT/.current.$$.tmp"
ln -s "$TARGET_PATH" "$LINK_TMP"
mv -Tf "$LINK_TMP" "$INSTALL_ROOT/current"

if [[ "$RESTART_SERVICE" == true ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl restart "$SERVICE_NAME.service"
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  fi
fi
echo "Rolled back to release: $TARGET_RELEASE"
