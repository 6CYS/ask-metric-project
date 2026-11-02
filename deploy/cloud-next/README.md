# 独立 Docker Compose 部署

本目录保留后端、Agent 和前端三服务容器编排，不含特定服务器的账户初始化、演示数据和现场验收脚本。首次部署需先按 [本地部署指南](../../docs/本地部署指南.md) 准备应用库、正式目录、只读数据湖连接、模型和账户。容器启动不会迁移数据库。

## 构建

从仓库根目录执行，以下版本号应替换为本次发布版本：

```sh
docker build --platform linux/amd64 -t ask-metric-next-backend:20260911.1 ./backend-next
docker build --platform linux/amd64 -t ask-metric-next-agent:20260911.1 ./agent-service
docker build --platform linux/amd64 --build-arg VITE_BACKEND_NEXT_BASE_URL= -t ask-metric-next-frontend:20260911.1 ./frontend-vue
```

ARM64 目标应更换为对应平台。不同构建机通过 `docker save`/`docker load` 或授权镜像仓库传递镜像，不上传镜像到源码仓库。

## 运行目录与配置

在部署主机建立独立目录并复制本目录的 `compose.yaml`：

```text
部署目录/
  compose.yaml
  .env
  backend.env
  agent.env
  runtime-config/
  model-secrets/
  state/
  logs/
  secrets/config-sm4.key
```

`.env` 仅设置发布变量：

```dotenv
RELEASE_TAG=20260911.1
WEB_PORT=18080
```

`backend.env` 按 `backend-next/.env.example` 配置生产环境，完整填写双库连接、独立签名密钥、SM2 私钥、模型服务、日志与多轮开关。敏感值通过既有 SM4 配置加密命令生成，设置 `ASK_METRIC_CONFIG_SM4_KEY_FILE=/run/secrets/config_sm4_key`。主密钥由 Compose secrets 挂载，不存入镜像。

若复制仓库的 `backend-next/config/` 到 `runtime-config/`，可设置以下路径；SQL 统一由版本内 builder 生成，不复制或加载模板目录：

```dotenv
APP_ENV=production
LOG_FILE_ENABLED=true
LOG_CONSOLE_ENABLED=false
LOG_DIRECTORY=/app/logs
MODEL_CONFIG_PATH=/app/runtime-config/model-config.json
PROMPT_CONFIG_PATH=/app/runtime-config/prompts.json
SEMANTIC_CONFIG_PATH=/app/runtime-config/semantic-config.json
MODEL_SECRET_ENV_PATH=/app/model-secrets/runtime.env
CONFIG_HISTORY_DIR=/app/state/config-history
MULTITURN_V2_ENABLED=true
```

Agent 配置 `agent.env` 参考 `agent-service/.env.example`，设置
`AGENT_SERVICE_HOST=0.0.0.0`、`BACKEND_BASE_URL=http://backend:8010`、
`AGENT_DATA_DIR=/app/data`，填写模型配置；使用加密密钥时设置
`ASK_METRIC_CONFIG_SM4_KEY_FILE=/run/secrets/config_sm4_key`。
提前创建 `state/agent` 并授权 UID 1000 写入，升级保留该目录。
前端同源 `/agent-api/` 代理到 Agent，关闭 SSE 缓冲；不向公网暴露 Agent 或数据库端口。

模型地址及密钥写入外置 `model-secrets/runtime.env`，模型 JSON 的名称、路径和鉴权头须匹配实际服务。旧分析流程已退出运行链。

后端以 UID 10001 运行：配置、state、logs 需具备相应读写权限，主密钥只读。目录需在启动前创建；不要把主机上的绝对路径直接当作容器路径。

编排依赖外部 Docker 网络 `ask-metric-cloud-db`，由部署人员预先创建/核对，并让已有数据库容器加入；使用远程数据库时也需保证该网络与目标地址可达。连接 URL 中的数据库主机必须是容器可解析的地址，不能把宿主机的 localhost 当数据库服务。

## 启动与升级

在部署目录执行：

```sh
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180
docker compose ps
curl -fsS http://127.0.0.1:18080/health/ready
```

浏览器经 Web 端口访问，API 使用同源 `/api`。默认 Web 18080 不占用 80，但容器名固定；同机再部署另一实例还需调整名称、网络及挂载目录，不能只修改端口。

升级前保存旧镜像版本并备份运行配置和数据，加载新镜像后修改 `RELEASE_TAG` 并重建本项目。前端可用 `FRONTEND_RELEASE_TAG` 独立指定版本；整套升级时需同步更新或移除该值。持久配置保留，不会随镜像更新。回退使用原镜像版本并核对数据库兼容性，不删除数据库卷。

就绪检查只证明部分应用表可用，部署完成还需验证登录、真实模型调用、数据湖查询和当前任务澄清。公网访问另取决于主机和云防火墙的入站规则。

## 启动初始化与就绪检查

后端启动即后台初始化指标目录向量，前端显示进度，完成后才能提问和启动测试。
`/health` 只判断存活；`/health/ready` 等目录初始化和应用库检查完成后才返回 200。
初始化期间返回 503，可访问 `/api/v1/query-readiness` 查看状态；失败后每隔 30 秒重试。
大目录应按模型吞吐预留等待时间，不因尚未就绪而反复重启。多 worker 分别预热。
