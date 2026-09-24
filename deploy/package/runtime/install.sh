#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BUNDLE_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_ROOT="/opt/ask-metric"
CONFIG_FILE="/etc/ask-metric/backend.env"
STATE_ROOT="/var/lib/ask-metric"
LOG_ROOT="/home/appuser/log"
PYTHON_BIN="python3.12"
SERVICE_USER="askmetric"
SERVICE_GROUP="askmetric"
INSTALL_SYSTEMD=true
INSTALL_NGINX=true
HTTP_PORT="80"
BACKEND_PORT="8010"
AGENT_PORT="8020"
SERVICE_NAME="ask-metric-backend"
AGENT_SERVICE_NAME="ask-metric-agent"
AGENT_CONFIG_FILE="/etc/ask-metric/agent.env"
INSTALL_AGENT=true

usage() {
  cat <<'EOF'
Usage: ./ops/install.sh [options]
  --install-root PATH   Versioned installation root (default /opt/ask-metric)
  --config PATH         External backend environment file
  --state-root PATH     Persistent runtime data directory
  --log-root PATH       Physical application log directory (default /home/appuser/log)
  --python COMMAND      Target Python matching the bundle (default python3.12)
  --service-user USER   Linux service account (default askmetric)
  --service-group GROUP Linux service group (default askmetric)
  --http-port PORT      Nginx listen port (default 80)
  --backend-port PORT   Loopback backend port (default 8010)
  --agent-port PORT     Loopback agent-service port (default 8020)
  --agent-config PATH   External agent-service environment file
  --service-name NAME   systemd unit name without .service
  --no-agent            Do not install the agent-service unit or config
  --no-systemd          Do not install or restart the systemd unit
  --no-nginx            Do not install or reload the Nginx configuration
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --state-root) STATE_ROOT="$2"; shift 2 ;;
    --log-root) LOG_ROOT="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --service-group) SERVICE_GROUP="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --agent-port) AGENT_PORT="$2"; shift 2 ;;
    --agent-config) AGENT_CONFIG_FILE="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --no-agent) INSTALL_AGENT=false; shift ;;
    --no-systemd) INSTALL_SYSTEMD=false; shift ;;
    --no-nginx) INSTALL_NGINX=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ ! "$HTTP_PORT" =~ ^[0-9]{1,5}$ || ! "$BACKEND_PORT" =~ ^[0-9]{1,5}$ || ! "$AGENT_PORT" =~ ^[0-9]{1,5}$ ]]; then
  echo "ERROR: ports must be numeric values between 1 and 65535" >&2
  exit 1
fi
if (( HTTP_PORT < 1 || HTTP_PORT > 65535 || BACKEND_PORT < 1 || BACKEND_PORT > 65535 || AGENT_PORT < 1 || AGENT_PORT > 65535 )); then
  echo "ERROR: ports must be numeric values between 1 and 65535" >&2
  exit 1
fi
if [[ ! "$SERVICE_NAME" =~ ^[0-9A-Za-z][0-9A-Za-z_.@-]{0,63}$ || ! "$AGENT_SERVICE_NAME" =~ ^[0-9A-Za-z][0-9A-Za-z_.@-]{0,63}$ ]]; then
  echo "ERROR: unsafe service name" >&2
  exit 1
fi

for value in "$INSTALL_ROOT" "$CONFIG_FILE" "$STATE_ROOT" "$LOG_ROOT" "$AGENT_CONFIG_FILE"; do
  if [[ "$value" != /* || "$value" == *'|'* || "$value" =~ [[:space:]] ]]; then
    echo "ERROR: deployment paths must be absolute and may not contain whitespace or |" >&2
    exit 1
  fi
done

if [[ ! -f "$BUNDLE_ROOT/manifest.json" ]]; then
  echo "ERROR: bundle manifest is missing" >&2
  exit 1
fi
"$SCRIPT_DIR/verify.sh"

command -v "$PYTHON_BIN" >/dev/null 2>&1 || {
  echo "ERROR: $PYTHON_BIN is required on the target host" >&2
  exit 1
}

read_manifest() {
  "$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]])' "$BUNDLE_ROOT/manifest.json" "$1"
}

RELEASE="$(read_manifest release)"
TARGET_PYTHON="$(read_manifest target_python)"
TARGET_PLATFORM="$(read_manifest target_platform)"
if [[ ! "$RELEASE" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]]; then
  echo "ERROR: unsafe release identifier in manifest" >&2
  exit 1
fi

ACTUAL_PYTHON="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$ACTUAL_PYTHON" != "$TARGET_PYTHON" ]]; then
  echo "ERROR: bundle requires Python $TARGET_PYTHON, found $ACTUAL_PYTHON" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ACTUAL_PLATFORM="linux-x86_64" ;;
  aarch64|arm64) ACTUAL_PLATFORM="linux-aarch64" ;;
  *) echo "ERROR: unsupported machine architecture: $(uname -m)" >&2; exit 1 ;;
esac
if [[ "$ACTUAL_PLATFORM" != "$TARGET_PLATFORM" ]]; then
  echo "ERROR: bundle targets $TARGET_PLATFORM, host is $ACTUAL_PLATFORM" >&2
  exit 1
fi

if [[ "$INSTALL_SYSTEMD" == true || "$INSTALL_NGINX" == true ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: root is required unless both --no-systemd and --no-nginx are used" >&2
    exit 1
  fi
fi

if [[ "$(id -u)" -eq 0 ]] && ! getent group "$SERVICE_GROUP" >/dev/null; then
  groupadd --system "$SERVICE_GROUP"
fi
if [[ "$(id -u)" -eq 0 ]] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$STATE_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

if [[ -L "$LOG_ROOT" ]]; then
  echo "ERROR: log root must be a physical directory, not a symbolic link: $LOG_ROOT" >&2
  exit 1
fi
if [[ "$(id -u)" -eq 0 ]]; then
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$LOG_ROOT"
elif [[ ! -d "$LOG_ROOT" || ! -w "$LOG_ROOT" ]]; then
  echo "ERROR: log root must already exist and be writable: $LOG_ROOT" >&2
  exit 1
fi

RELEASES_DIR="$INSTALL_ROOT/releases"
FINAL_RELEASE="$RELEASES_DIR/$RELEASE"
STAGING_RELEASE="$RELEASES_DIR/.${RELEASE}.installing.$$"
RUNTIME_CONFIG_ROOT="$STATE_ROOT/runtime-config"
mkdir -p "$RELEASES_DIR" "$STATE_ROOT/config-history" \
  "$RUNTIME_CONFIG_ROOT"

cleanup() {
  if [[ -d "$STAGING_RELEASE" ]]; then
    rm -rf -- "$STAGING_RELEASE"
  fi
}
trap cleanup EXIT

if [[ ! -d "$FINAL_RELEASE" ]]; then
  mkdir -p "$STAGING_RELEASE"
  cp -a "$BUNDLE_ROOT/frontend" "$STAGING_RELEASE/frontend"
  cp -a "$BUNDLE_ROOT/backend/runtime" "$STAGING_RELEASE/backend"
  cp -a "$BUNDLE_ROOT/ops" "$STAGING_RELEASE/ops"
  cp "$BUNDLE_ROOT/manifest.json" "$STAGING_RELEASE/manifest.json"
  if [[ "$INSTALL_AGENT" == true && -d "$BUNDLE_ROOT/agent-service" ]]; then
    cp -a "$BUNDLE_ROOT/agent-service" "$STAGING_RELEASE/agent-service"
  fi
  if [[ "$INSTALL_AGENT" == true && -d "$BUNDLE_ROOT/node-runtime" ]]; then
    cp -a "$BUNDLE_ROOT/node-runtime" "$STAGING_RELEASE/node-runtime"
  fi
  "$PYTHON_BIN" -m venv "$STAGING_RELEASE/venv"
  PROJECT_WHEELS=("$BUNDLE_ROOT"/backend/wheels/ask_metric_backend_next-*.whl)
  if [[ ${#PROJECT_WHEELS[@]} -ne 1 || ! -f "${PROJECT_WHEELS[0]}" ]]; then
    echo "ERROR: expected exactly one application wheel" >&2
    exit 1
  fi
  "$STAGING_RELEASE/venv/bin/python" -m pip install \
    --no-index --find-links "$BUNDLE_ROOT/backend/wheels" "${PROJECT_WHEELS[0]}"
  # cp -a can preserve the upload user's restrictive modes/ownership. Releases
  # contain no secrets and must be readable by the service and Nginx users.
  chmod -R u=rwX,go=rX "$STAGING_RELEASE"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R root:root "$STAGING_RELEASE"
  fi
  mv "$STAGING_RELEASE" "$FINAL_RELEASE"
fi

# Runtime-editable configuration must live outside the immutable release. Seed
# it once, then preserve administrator changes across upgrades and rollbacks.
if [[ ! -f "$RUNTIME_CONFIG_ROOT/model-config.json" ]]; then
  cp "$FINAL_RELEASE/backend/config/model-config.json" \
    "$RUNTIME_CONFIG_ROOT/model-config.json"
fi
if [[ ! -f "$RUNTIME_CONFIG_ROOT/prompts.json" ]]; then
  cp "$FINAL_RELEASE/backend/config/prompts.json" "$RUNTIME_CONFIG_ROOT/prompts.json"
else
  "$FINAL_RELEASE/venv/bin/python" \
    "$FINAL_RELEASE/backend/scripts/merge_runtime_prompt_defaults.py" \
    "$RUNTIME_CONFIG_ROOT/prompts.json" \
    "$FINAL_RELEASE/backend/config/prompts.json"
fi
# SQL 由版本内 builder 生成；旧持久 SQL 文件留存供整包回退，不再读取或覆盖。
if [[ -f "$CONFIG_FILE" ]]; then
  "$FINAL_RELEASE/venv/bin/python" "$BUNDLE_ROOT/ops/intranet_deploy.py" \
    init-config \
    --config-root "$(dirname -- "$CONFIG_FILE")" \
    --state-root "$STATE_ROOT" \
    --backend-port "$BACKEND_PORT"
fi
chmod -R u=rwX,go=rX "$RUNTIME_CONFIG_ROOT"

if [[ "$(id -u)" -eq 0 ]]; then
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$STATE_ROOT"
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  mkdir -p "$(dirname -- "$CONFIG_FILE")"
  sed -e "s|@INSTALL_ROOT@|$INSTALL_ROOT|g" -e "s|@STATE_ROOT@|$STATE_ROOT|g" \
    -e "s|@CONFIG_FILE@|$CONFIG_FILE|g" \
    -e "s|@BACKEND_PORT@|$BACKEND_PORT|g" \
    "$SCRIPT_DIR/backend.env.example" > "$CONFIG_FILE"
  chmod 0640 "$CONFIG_FILE"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown "root:$SERVICE_GROUP" "$CONFIG_FILE"
  fi
  echo "Configuration template created: $CONFIG_FILE"
  echo "Replace all <...> placeholders, then run this installer again. Nothing was activated."
  exit 2
fi

# r3 and earlier pointed administrator-editable files into the immutable
# current release. Migrate only those exact legacy defaults; never rewrite
# database URLs, credentials, tokens, or custom configuration paths.
migrate_legacy_runtime_path() {
  local key="$1"
  local old_value="$2"
  local new_value="$3"
  if grep -Fqx "$key=$old_value" "$CONFIG_FILE"; then
    sed -i "s|^$key=$old_value\$|$key=$new_value|" "$CONFIG_FILE"
    echo "Migrated $key to persistent runtime configuration."
  fi
}
migrate_legacy_runtime_path "MODEL_CONFIG_PATH" \
  "$INSTALL_ROOT/current/backend/config/model-config.json" \
  "$RUNTIME_CONFIG_ROOT/model-config.json"
migrate_legacy_runtime_path "PROMPT_CONFIG_PATH" \
  "$INSTALL_ROOT/current/backend/config/prompts.json" \
  "$RUNTIME_CONFIG_ROOT/prompts.json"

if grep -Eq '<[^>]+>|development-only-change-me' "$CONFIG_FILE"; then
  echo "ERROR: unresolved placeholders or development secrets remain in $CONFIG_FILE" >&2
  echo "The release was staged but not activated." >&2
  exit 2
fi

# agent-service 配置与后端分离保存；同样只生成一次，升级与回滚不覆盖。
AGENT_READY=false
if [[ "$INSTALL_AGENT" == true ]]; then
  if [[ ! -f "$AGENT_CONFIG_FILE" ]]; then
    mkdir -p "$(dirname -- "$AGENT_CONFIG_FILE")"
    sed -e "s|@AGENT_PORT@|$AGENT_PORT|g" -e "s|@BACKEND_PORT@|$BACKEND_PORT|g" \
      -e "s|@STATE_ROOT@|$STATE_ROOT|g" \
      "$SCRIPT_DIR/agent.env.example" > "$AGENT_CONFIG_FILE"
    chmod 0640 "$AGENT_CONFIG_FILE"
    if [[ "$(id -u)" -eq 0 ]]; then
      chown "root:$SERVICE_GROUP" "$AGENT_CONFIG_FILE"
    fi
    echo "Agent configuration template created: $AGENT_CONFIG_FILE"
    echo "Replace all <...> placeholders, then run this installer again to enable the agent service."
  elif grep -Eq '<[^>]+>' "$AGENT_CONFIG_FILE"; then
    echo "WARNING: unresolved placeholders remain in $AGENT_CONFIG_FILE; agent service not activated." >&2
  else
    AGENT_READY=true
  fi
  # 优先使用发布包内嵌的 Node runtime，缺失时回退到目标机系统 Node（需 22.12+）
  NODE_BIN="$FINAL_RELEASE/node-runtime/node/bin/node"
  if [[ ! -x "$NODE_BIN" ]]; then
    NODE_BIN="$(command -v node || true)"
  fi
  if [[ "$AGENT_READY" == true && ( -z "$NODE_BIN" || ! -x "$NODE_BIN" ) ]]; then
    echo "WARNING: Node.js 22.12+ is required for agent-service; agent service not activated." >&2
    AGENT_READY=false
  fi
fi

LINK_TMP="$INSTALL_ROOT/.current.$$.tmp"
ln -s "$FINAL_RELEASE" "$LINK_TMP"
mv -Tf "$LINK_TMP" "$INSTALL_ROOT/current"

render_template() {
  sed \
    -e "s|@INSTALL_ROOT@|$INSTALL_ROOT|g" \
    -e "s|@STATE_ROOT@|$STATE_ROOT|g" \
    -e "s|@LOG_ROOT@|$LOG_ROOT|g" \
    -e "s|@CONFIG_FILE@|$CONFIG_FILE|g" \
    -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
    -e "s|@SERVICE_GROUP@|$SERVICE_GROUP|g" \
    -e "s|@HTTP_PORT@|$HTTP_PORT|g" \
    -e "s|@BACKEND_PORT@|$BACKEND_PORT|g" \
    -e "s|@AGENT_PORT@|$AGENT_PORT|g" \
    -e "s|@AGENT_CONFIG_FILE@|$AGENT_CONFIG_FILE|g" \
    -e "s|@NODE_BIN@|${NODE_BIN:-/usr/bin/node}|g" \
    -e "s|@SERVICE_NAME@|$SERVICE_NAME|g" \
    "$1" > "$2"
}

if [[ "$INSTALL_SYSTEMD" == true ]]; then
  command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemctl is unavailable" >&2; exit 1; }
  render_template "$SCRIPT_DIR/ask-metric-backend.service.template" \
    "/etc/systemd/system/$SERVICE_NAME.service"
  if [[ "$INSTALL_AGENT" == true && "$AGENT_READY" == true ]]; then
    render_template "$SCRIPT_DIR/ask-metric-agent.service.template" \
      "/etc/systemd/system/$AGENT_SERVICE_NAME.service"
  fi
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME.service"
  if [[ "$INSTALL_AGENT" == true && "$AGENT_READY" == true ]]; then
    systemctl enable --now "$AGENT_SERVICE_NAME.service"
  fi
fi

if [[ "$INSTALL_NGINX" == true ]]; then
  command -v nginx >/dev/null 2>&1 || { echo "ERROR: nginx is unavailable" >&2; exit 1; }
  mkdir -p /etc/nginx/conf.d
  render_template "$SCRIPT_DIR/nginx.conf.template" "/etc/nginx/conf.d/$SERVICE_NAME.conf"
  nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now nginx
    systemctl reload nginx
  fi
fi

echo "Activated Ask Metric release: $RELEASE"
echo "Database migrations were NOT run. Review and run current/ops/migrate.sh separately."
