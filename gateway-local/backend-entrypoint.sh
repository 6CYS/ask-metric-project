#!/bin/sh
set -eu

replace_database_host() {
  printf '%s' "${1:-}" \
    | sed \
      -e 's#127\.0\.0\.1:3308#host.docker.internal:3308#g' \
      -e 's#127\.0\.0\.1:3309#host.docker.internal:3309#g'
}

use_legacy_metric_database() {
  printf '%s' "${1:-}" \
    | sed -E 's#(mysql\+pymysql://[^@]+@)[^/]+/[^?]+#\1host.docker.internal:3309/ads_lake#'
}

export APP_DATABASE_URL="$(replace_database_host "${APP_DATABASE_URL:-}")"
export QUERY_DATABASE_URL="$(replace_database_host "${QUERY_DATABASE_URL:-}")"

# 本地联调用旧环境的指标测试库，保留当前应用库中的用户、会话和配置。
if [ "${USE_LEGACY_METRIC_DATABASE:-false}" = "true" ]; then
  export QUERY_DATABASE_URL="$(use_legacy_metric_database "${QUERY_DATABASE_URL:-}")"
  export METRIC_CATALOG_DATABASE_URL="$(use_legacy_metric_database "${METRIC_CATALOG_DATABASE_URL:-${QUERY_DATABASE_URL:-}}")"
  export ORG_CATALOG_DATABASE_URL="$(use_legacy_metric_database "${ORG_CATALOG_DATABASE_URL:-${QUERY_DATABASE_URL:-}}")"
  # 旧库保存的是数据湖事实表，查询构造必须使用事实表方言，不能读取应用库 metric_values。
  export QUERY_DATABASE_DIALECT="inceptor"
  # 旧指标库是导入 MySQL 的数据湖表。当前运行镜像中的 SQLGlot 在
  # Inceptor→MySQL 转换时会把安全数值清洗识别为 TRY_CAST 并直接拒绝，
  # 因此使用 Inceptor 适配器的 Hive 兼容输出。截图中的事实查询已在本地
  # MySQL 8 旧指标库上验证可执行。
  export SIT_SQL_DIALECT="hive"
fi

exec python -m uvicorn ask_metric.main:app --host 0.0.0.0 --port "${PORT:-8010}"
