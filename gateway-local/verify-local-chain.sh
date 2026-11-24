#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/gateway-local/compose.yaml"

docker compose -f "$COMPOSE_FILE" config >/dev/null
docker compose -f "$COMPOSE_FILE" ps

curl --fail --silent --show-error http://localhost:18080/actuator/health >/dev/null
curl --fail --silent --show-error http://localhost:8080/api/agent/health >/dev/null
curl --fail --silent --show-error http://localhost:8080/health >/dev/null

echo "本地 Nginx、Gateway、Agent、Python 健康链路通过"
