#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RELEASE_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="/etc/ask-metric/backend.env"
MODE="sql"
OUTPUT_FILE=""

usage() {
  cat <<'EOF'
Usage: migrate.sh [--config PATH] [--sql [OUTPUT.sql] | --apply]
  --sql     Generate GoldenDB migration SQL for review; this is the default.
  --apply   Apply the reviewed migration. This is an explicit database write.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --sql)
      MODE="sql"
      if [[ $# -gt 1 && "$2" != --* ]]; then OUTPUT_FILE="$2"; shift 2; else shift; fi
      ;;
    --apply) MODE="apply"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: configuration file not found: $CONFIG_FILE" >&2
  exit 1
fi
if grep -Eq '<[^>]+>|development-only-change-me' "$CONFIG_FILE"; then
  echo "ERROR: unresolved placeholders or development secrets remain in $CONFIG_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a
export BACKEND_NEXT_ALLOW_SCHEMA_CHANGES=true
export BACKEND_NEXT_ALLOW_NON_TEST_DATABASE=true

cd "$RELEASE_ROOT/backend"
ALEMBIC=("$RELEASE_ROOT/venv/bin/python" -m alembic -c alembic-goldendb.ini upgrade head)
if [[ "$MODE" == "sql" ]]; then
  if [[ -z "$OUTPUT_FILE" ]]; then
    OUTPUT_FILE="$PWD/goldendb-migration.sql"
  fi
  "${ALEMBIC[@]}" --sql > "$OUTPUT_FILE"
  chmod 0600 "$OUTPUT_FILE"
  echo "Offline migration SQL written for review: $OUTPUT_FILE"
else
  echo "Applying the GoldenDB migration to APP_DATABASE_URL..."
  "${ALEMBIC[@]}"
  echo "GoldenDB migration completed."
fi
