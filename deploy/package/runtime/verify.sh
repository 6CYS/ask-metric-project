#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BUNDLE_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$BUNDLE_ROOT/manifest.json" || ! -f "$BUNDLE_ROOT/checksums.sha256" ]]; then
  echo "ERROR: this script must be run from an extracted Ask Metric bundle" >&2
  exit 1
fi

command -v sha256sum >/dev/null 2>&1 || {
  echo "ERROR: sha256sum is required" >&2
  exit 1
}

cd "$BUNDLE_ROOT"
sha256sum --check --strict checksums.sha256
echo "Bundle verification passed: $BUNDLE_ROOT"
