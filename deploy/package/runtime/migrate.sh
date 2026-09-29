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
# 下面会切换到 backend 目录后再读取配置，先固定为绝对路径。
CONFIG_FILE="$(CDPATH= cd -- "$(dirname -- "$CONFIG_FILE")" && pwd)/$(basename -- "$CONFIG_FILE")"

PYTHON="$RELEASE_ROOT/venv/bin/python"

# 配置文件是 systemd EnvironmentFile 格式，不是 shell 脚本：用 dotenv 按值解析
# （不做 ${} 展开，与 site_upgrade.py 一致），避免带空格的值被 shell 当成命令，
# 也避免 root 执行文件中的 $(...)。解析后 exec alembic，文件值覆盖继承的环境，
# 迁移开关最后强制打开。
run_with_config() {
  "$PYTHON" -c '
import os
import sys

from dotenv import dotenv_values

config = dotenv_values(sys.argv[1], interpolate=False)
os.environ.update({key: value for key, value in config.items() if value is not None})
os.environ["BACKEND_NEXT_ALLOW_SCHEMA_CHANGES"] = "true"
os.environ["BACKEND_NEXT_ALLOW_NON_TEST_DATABASE"] = "true"
os.execv(sys.executable, [sys.executable, *sys.argv[2:]])
' "$CONFIG_FILE" "$@"
}

cd "$RELEASE_ROOT/backend"
ALEMBIC=(run_with_config -m alembic -c alembic-goldendb.ini upgrade head)
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
