#!/usr/bin/env bash
set -euo pipefail

# 只管理当前应用机上的 Python 后端和 Node Agent。
# 不执行 SQL，不发布 Nacos 配置，不修改 Gateway、Nginx 或数据库。

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [[ -d "$HERE/../backend/runtime" ]]; then
  ROOT="$(CDPATH= cd -- "$HERE/.." && pwd)"
else
  ROOT="${ASK_METRIC_ROOT:-$HERE}"
fi

CONFIG_ROOT="${ASK_METRIC_CONFIG_ROOT:-$HOME/ask-metric-config-phase2}"
BACKEND_ENV="${ASK_METRIC_BACKEND_ENV:-$CONFIG_ROOT/backend.env}"
AGENT_ENV="${ASK_METRIC_AGENT_ENV:-$CONFIG_ROOT/agent.env}"
STATE_ROOT="${ASK_METRIC_STATE_ROOT:-$HOME/ask-metric-state-phase2}"
VENV="${ASK_METRIC_VENV:-$HOME/venv-phase2}"
PYTHON_BIN="${ASK_METRIC_PYTHON:-python3.12}"
BACKEND_PORT="${ASK_METRIC_BACKEND_PORT:-8010}"
AGENT_PORT="${ASK_METRIC_AGENT_PORT:-8020}"

NODE_BIN="$ROOT/node-runtime/node/bin/node"
BACKEND_DIR="$ROOT/backend/runtime"
AGENT_DIR="$ROOT/agent-service"
PID_DIR="$STATE_ROOT/run"
LOG_DIR="$STATE_ROOT/logs"
BACKEND_PID="$PID_DIR/backend.pid"
AGENT_PID="$PID_DIR/agent.pid"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
用法：
  bash ops/ask-metric-app-services.sh install
  bash ops/ask-metric-app-services.sh start
  bash ops/ask-metric-app-services.sh stop
  bash ops/ask-metric-app-services.sh restart
  bash ops/ask-metric-app-services.sh status
  bash ops/ask-metric-app-services.sh check
HELP
}

env_value() {
  awk -F= -v key="$2" '
    /^[[:space:]]*#/ { next }
    $1 == key {
      sub(/^[^=]*=/, "", $0)
      value=$0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^\047.*\047$/ || value ~ /^".*"$/)
        value=substr(value, 2, length(value)-2)
      print value
      exit
    }
  ' "$1"
}

check_bundle() {
  [[ -d "$BACKEND_DIR" ]] || die "缺少 $BACKEND_DIR"
  [[ -d "$ROOT/backend/wheels" ]] || die "缺少 $ROOT/backend/wheels"
  compgen -G "$ROOT/backend/wheels/ask_metric_backend_next-*.whl" >/dev/null || die "缺少后端 wheel"
  [[ -f "$AGENT_DIR/dist/server.js" ]] || die "缺少 $AGENT_DIR/dist/server.js"
  [[ -x "$NODE_BIN" ]] || die "缺少随包 Node：$NODE_BIN"
}

find_python() {
  if [[ "$PYTHON_BIN" != */* ]]; then
    PYTHON_BIN="$(command -v "$PYTHON_BIN" 2>/dev/null || true)"
  fi
  [[ -x "$PYTHON_BIN" ]] || die "找不到 Python 3.12，请设置 ASK_METRIC_PYTHON=/绝对路径/bin/python"
  "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' ||
    die "Python 必须是 3.12"
}

prepare_dirs() {
  umask 077
  mkdir -p "$PID_DIR" "$LOG_DIR"
  chmod 700 "$PID_DIR" "$LOG_DIR"
}

create_agent_env() {
  [[ -f "$AGENT_ENV" ]] && return
  mkdir -p "$(dirname -- "$AGENT_ENV")"
  cat > "$AGENT_ENV" <<EOF
# 请补齐下面三项后再执行 start
AGENT_SERVICE_HOST=0.0.0.0
AGENT_SERVICE_PORT=$AGENT_PORT
BACKEND_BASE_URL=http://127.0.0.1:$BACKEND_PORT
BUSINESS_CONFIGURATION_STORAGE=database
AGENT_SESSION_STORAGE=database
AGENT_DEPLOYMENT_REPLICAS=2
AGENT_SESSION_DATABASE_URL=
AGENT_MODEL_API_KEY=
ASK_METRIC_CONFIG_SM4_KEY_FILE=

# 现有 Nacos 没有确认 Agent 配置文档，默认使用本地配置。
NACOS_CONFIG_ENABLED=false
# 只有 Gateway 已配置 ask-metric-agent 服务发现时才改为 true。
NACOS_REGISTER_ENABLED=false
NACOS_SERVICE_NAME=ask-metric-agent
NACOS_INSTANCE_PORT=$AGENT_PORT
AGENT_DATA_DIR=$STATE_ROOT/agent-data
EOF
  chmod 600 "$AGENT_ENV"
  echo "已生成 $AGENT_ENV，请补齐 Agent 配置后重新执行 start"
}

install_cmd() {
  check_bundle
  find_python
  prepare_dirs
  if [[ ! -x "$VENV/bin/python" ]]; then
    "$PYTHON_BIN" -m venv "$VENV" || {
      "$PYTHON_BIN" -m ensurepip --upgrade
      "$PYTHON_BIN" -m venv "$VENV"
    }
  fi
  "$VENV/bin/python" -m pip --version >/dev/null 2>&1 ||
    "$VENV/bin/python" -m ensurepip --upgrade
  if [[ -f "$ROOT/ops/constraints.txt" ]]; then
    "$VENV/bin/python" -m pip install --no-index --find-links "$ROOT/backend/wheels"       --constraint "$ROOT/ops/constraints.txt" ask-metric-backend-next uvloop
  else
    "$VENV/bin/python" -m pip install --no-index --find-links "$ROOT/backend/wheels"       ask-metric-backend-next uvloop
  fi
  "$VENV/bin/python" -m pip check
  "$VENV/bin/python" -c 'import ask_metric, uvicorn'
  create_agent_env
  echo "INSTALL_OK"
}

need_files() {
  [[ -f "$BACKEND_ENV" ]] || die "缺少 $BACKEND_ENV"
  [[ -f "$AGENT_ENV" ]] || die "缺少 $AGENT_ENV，请先执行 install"
  [[ -x "$VENV/bin/python" ]] || die "缺少 $VENV/bin/python，请先执行 install"
  [[ -n "$(env_value "$AGENT_ENV" AGENT_SESSION_DATABASE_URL)" ]] ||
    die "请在 agent.env 填写 AGENT_SESSION_DATABASE_URL"
  [[ -n "$(env_value "$AGENT_ENV" AGENT_MODEL_API_KEY)" ]] ||
    die "请在 agent.env 填写 AGENT_MODEL_API_KEY"
  [[ -n "$(env_value "$AGENT_ENV" ASK_METRIC_CONFIG_SM4_KEY_FILE)" ]] ||
    die "请在 agent.env 填写 ASK_METRIC_CONFIG_SM4_KEY_FILE"
  [[ -f "$(env_value "$AGENT_ENV" ASK_METRIC_CONFIG_SM4_KEY_FILE)" ]] ||
    die "SM4 主密钥文件不存在"
}

pid_alive() {
  local file="$1" pid
  [[ -s "$file" ]] || return 1
  pid="$(cat "$file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

our_process() {
  local kind="$1" pid="$2" cmd
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$kind" == backend ]]; then
    [[ "$cmd" == *"$VENV/bin/python"* && "$cmd" == *"uvicorn ask_metric.main:app"* ]]
  else
    [[ "$cmd" == *"$NODE_BIN"* && "$cmd" == *"$AGENT_DIR/dist/server.js"* ]]
  fi
}

wait_url() {
  local url="$1" i
  command -v curl >/dev/null 2>&1 || die "需要 curl"
  for i in {1..60}; do
    curl --fail --silent --max-time 3 "$url" >/dev/null 2>&1 && return
    sleep 1
  done
  return 1
}

start_cmd() {
  check_bundle
  need_files
  prepare_dirs

  if pid="$(pid_alive "$BACKEND_PID")" && our_process backend "$pid"; then
    echo "Python 已运行，PID=$pid"
  else
    rm -f "$BACKEND_PID"
    (cd "$BACKEND_DIR" && nohup "$VENV/bin/python" -I -m uvicorn ask_metric.main:app       --env-file "$BACKEND_ENV" --host 0.0.0.0 --port "$BACKEND_PORT" --no-access-log       >>"$LOG_DIR/backend.log" 2>&1 < /dev/null & echo $! > "$BACKEND_PID")
    pid="$(cat "$BACKEND_PID")"
    our_process backend "$pid" || die "Python 启动失败，请查看 $LOG_DIR/backend.log"
  fi
  wait_url "http://127.0.0.1:$BACKEND_PORT/health/ready" || die "Python 未通过健康检查"

  if pid="$(pid_alive "$AGENT_PID")" && our_process agent "$pid"; then
    echo "Agent 已运行，PID=$pid"
  else
    rm -f "$AGENT_PID"
    (cd "$AGENT_DIR" && nohup "$NODE_BIN" --env-file="$AGENT_ENV" "$AGENT_DIR/dist/server.js"       >>"$LOG_DIR/agent.log" 2>&1 < /dev/null & echo $! > "$AGENT_PID")
    pid="$(cat "$AGENT_PID")"
    our_process agent "$pid" || die "Agent 启动失败，请查看 $LOG_DIR/agent.log"
  fi
  wait_url "http://127.0.0.1:$AGENT_PORT/health/ready" || die "Agent 未通过健康检查"
  echo "START_OK: Python $BACKEND_PORT, Agent $AGENT_PORT"
}

stop_one() {
  local kind="$1" file="$2" pid
  pid="$(pid_alive "$file" || true)"
  if [[ -n "$pid" ]] && our_process "$kind" "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..15}; do
      our_process "$kind" "$pid" || break
      sleep 1
    done
  fi
  rm -f "$file"
}

stop_cmd() {
  stop_one agent "$AGENT_PID"
  stop_one backend "$BACKEND_PID"
  echo "STOP_OK"
}

status_cmd() {
  local pid
  if pid="$(pid_alive "$BACKEND_PID")" && our_process backend "$pid"; then
    echo "Python: running (pid=$pid)"
  else
    echo "Python: stopped"
  fi
  if pid="$(pid_alive "$AGENT_PID")" && our_process agent "$pid"; then
    echo "Agent: running (pid=$pid)"
  else
    echo "Agent: stopped"
  fi
}

check_cmd() {
  command -v curl >/dev/null 2>&1 || die "需要 curl"
  curl --fail --silent --max-time 10 "http://127.0.0.1:$BACKEND_PORT/health/ready" >/dev/null
  curl --fail --silent --max-time 10 "http://127.0.0.1:$AGENT_PORT/health/ready" >/dev/null
  echo "CHECK_OK"
}

case "${1:-}" in
  install) install_cmd ;;
  start) start_cmd ;;
  stop) stop_cmd ;;
  restart) stop_cmd; start_cmd ;;
  status) status_cmd ;;
  check) check_cmd ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
