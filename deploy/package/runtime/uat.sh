#!/bin/sh
# 普通 appuser 的部署入口；不更改系统服务，不读取或覆盖原站点配置。
set -eu
R=$(cd "$(dirname "$0")/.." && pwd)
B=${AM_UAT_ROOT:-/home/appuser/ask-metric-pi}
export AM_RELEASE_DIR="$R" AM_UAT_ROOT="$B"
case "${1:-}" in
  install)
    python3.12 -m venv "$R/venv"
    "$R/venv/bin/python" -m pip install --no-index --find-links "$R/backend/wheels" --constraint "$R/ops/constraints.txt" ask-metric-backend-next uvloop
    "$R/venv/bin/python" -m pip check
    "$R/node-runtime/node/bin/node" --version
    mkdir -p "$B/config" "$B/state/agent" "$B/logs" "$B/run"
    ;;
  front)
    mkdir -p "$B/run" "$B/logs" "$B/tmp/client" "$B/tmp/proxy" "$B/tmp/fastcgi" "$B/tmp/uwsgi" "$B/tmp/scgi"
    test ! -e "$B/nginx.conf" || { echo 'nginx.conf already exists; keep it and use front-start'; exit 1; }
    sed "s|@RELEASE@|$R|g;s|@BACKEND_IP@|${AM_BACKEND_IP:-77.16.60.204}|g;s|@WEB_PORT@|${AM_WEB_PORT:-8090}|g" "$R/ops/uat-nginx.conf" > "$B/nginx.conf.new"
    nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf.new" -t
    mv "$B/nginx.conf.new" "$B/nginx.conf"
    nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf"
    curl --fail --max-time 10 "http://127.0.0.1:${AM_WEB_PORT:-8090}/" -o /dev/null
    ;;
  front-start|front-check|front-stop)
    mkdir -p "$B/run" "$B/logs"
    nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf" -t
    case "$1" in
      front-start) nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf" ;;
      front-stop) nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf" -s quit ;;
    esac
    ;;
  model)
    shift
    exec "$R/venv/bin/python" "$R/ops/model_check.py" "$@"
    ;;
  prepare|publish|db|sql|sync|start|stop|check)
    exec "$R/venv/bin/python" "$R/ops/uat_deploy.py" "$@"
    ;;
  *) echo 'Usage: sh ops/uat.sh install|prepare|model|publish|db|sql|sync|start|stop|check|front|front-check|front-stop|front-start'; exit 2 ;;
esac
