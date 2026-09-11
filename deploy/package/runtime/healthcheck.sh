#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8010}"
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required" >&2; exit 1; }
curl --fail --silent --show-error "$BASE_URL/health"
echo
curl --fail --silent --show-error "$BASE_URL/health/ready"
echo
