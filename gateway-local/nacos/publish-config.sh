#!/bin/sh
set -eu

NACOS_ADDR="${NACOS_ADDR:-http://nacos:8848}"
DATA_ID="${NACOS_CONFIG_DATA_ID:-znws_gateway.yaml}"
GROUP="${NACOS_CONFIG_GROUP:-DEFAULT_GROUP}"
CONFIG_FILE="${NACOS_CONFIG_FILE:-/config/znws_gateway.yaml}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "配置文件不存在: $CONFIG_FILE" >&2
  exit 1
fi

ready_url="$NACOS_ADDR/nacos/v1/ns/operator/metrics"
publish_url="$NACOS_ADDR/nacos/v3/admin/cs/config"

i=0
while ! curl -fsS --max-time 3 "$ready_url" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "Nacos 在等待时间内未就绪: $NACOS_ADDR" >&2
    exit 1
  fi
  sleep 2
done

curl -fsS --max-time 10 -X POST "$publish_url" \
  --data-urlencode "dataId=$DATA_ID" \
  --data-urlencode "groupName=$GROUP" \
  --data-urlencode "namespaceId=public" \
  --data-urlencode "type=yaml" \
  --data-urlencode "content@${CONFIG_FILE}" \
  | grep -Eq '"code"[[:space:]]*:[[:space:]]*0.*"data"[[:space:]]*:[[:space:]]*true'

echo "已发布 Nacos 配置 dataId=$DATA_ID group=$GROUP"
