# 本地 Nacos + Gateway 链路

这套编排用于在本机复现一期生产链路的入口关系，生产 Nginx 配置不改：

```text
浏览器 -> 本地 Nginx:8080 -> Gateway:9000 -> Nacos 服务发现
                                      ├─ /api/agent/** -> ask-metric-agent:8020
                                      └─ /api/**       -> ask-metric-python:8010
```

本地只启动一个 Python 和一个 Agent 实例，内存先按能启动和联调的下限设置。后续做集群时再复制实例，并把 Agent 会话存储改成共享数据库。

## 1. 启动

在 `ask-metric-v0.3-inquiry-integration` 目录执行：

```bash
docker compose -f gateway-local/compose.yaml build
docker compose -f gateway-local/compose.yaml up -d
```

访问地址：

- 前端：http://localhost:8080
- Gateway 健康：http://localhost:18080/actuator/health
- Gateway 路由：http://localhost:18080/actuator/gateway/routes
- Nacos API：http://localhost:8848/nacos
- Nacos 控制台：http://localhost:8081/

Nacos 使用本地 standalone 模式并关闭鉴权，宿主入口绑定回环地址。配置初始化容器会把 `nacos/znws_gateway.yaml` 发布到 `DEFAULT_GROUP`，Data ID 是 `znws_gateway.yaml`。

其他机器可通过 `ASK_METRIC_LOCAL_BACKEND_ENV_FILE` 和 `ASK_METRIC_LOCAL_AGENT_ENV_FILE` 指定各自的配置文件，建议使用绝对路径。查询库已在后端 env 配好的机器可设置 `ASK_METRIC_LOCAL_USE_LEGACY_METRIC_DATABASE=false`，沿用 env 中的连接配置。

### 使用正式部署包的门户入口

`formal/compose.yaml` 使用 1104 正式交付包中的 `prod-20261028-r1` Gateway JAR、Nacos 配置模板及 `8090.conf`，通过既有 Compose 网络访问本地 Nacos、Python 和 Agent。先启动上面的基础链路，在仓库根目录执行：

```bash
python3 gateway-local/formal/prepare_gateway.py /path/to/问数生产环境部署1104.zip
(
  cd frontend-vue
  VITE_BACKEND_NEXT_BASE_URL=/bgwblj/znws VITE_AGENT_API_PATH=/api/agent \
    npm run build -- --base /bgwblj/znws/static/ \
    --outDir ../gateway-local/formal/dist --emptyOutDir
)
docker compose -f gateway-local/formal/compose.yaml up -d
```

从 <http://127.0.0.1:8090/bgwblj/znws/static/> 访问门户版。Nacos 的 `ASK_METRIC_FORMAL_LOCAL` 分组发布 `znws_gateway.yaml`，服务发现仍用 `DEFAULT_GROUP`。Nginx 保留正式子路径、静态回退及认证 Cookie 路径改写。Nginx 去掉外围前缀后转发给 Gateway，Gateway 优先将 `/api/agent/**` 分流到 v0.3 Agent，其余 `/api/**` 到 Python，并为 Python 保留浏览器的 Host 以支持会话来源校验。

```bash
curl -fsS http://127.0.0.1:18081/actuator/health
curl -fsS http://127.0.0.1:8090/bgwblj/znws/api/v1/query-readiness
curl -fsS http://127.0.0.1:8090/bgwblj/znws/api/agent/health
```

更新路由时执行 `docker compose -f gateway-local/formal/compose.yaml run --rm formal-nacos-config-init`。停止门户验证实例使用 `docker compose -f gateway-local/formal/compose.yaml down`。两个入口复用同一套后端，使用同一账号再次登录会按后端现有的单会话规则替换旧会话。

## 2. 数据库配置

Compose 当前读取本机已有的 `ask-metric-v0.2-analysis-enhanced-windows/backend-next/.env`。应用库仍使用 `zbws-mysql-local` 的 `ask_metric_app`，用于用户、会话和配置。查询、指标目录和机构目录通过启动脚本切换到旧指标库 `zbws-mysql-import-20261023` 的 `3309/ads_lake`，数据库密码仍只来自旧环境文件，不会复制到仓库。两个 MySQL 容器都需要保持运行。

旧指标库只读核验过以下真实表，事实表约有 904 万行：

- `ads_lake.adm_rmt_pub_gnrl_drv_indcr_tab`
- `ads_lake.adm_rmt_pub_drv_indcr_cnfgon_infotab`
- `ads_lake.fdm_pub_org_inf_all`

Agent 读取本机已有的 `ask-metric-v0.2-analysis-enhanced-windows/agent-service/.env`，Compose 只覆盖容器内的后端地址、数据目录和服务监听地址。这样会复用当前已验证的方舟模型配置，不会把模型密钥写入 Compose 文件。模型诊断入口使用 `deepseek-v4-flash`，完整路径由 Agent 追加 `/chat/completions`。

Python 后端的模型配置保存于 `backend-runtime` 命名卷。首次启动时，`gateway-local/runtime/model-config.json` 只在目标文件不存在时初始化默认值，后续页面保存的模型切换会保留在卷中。当前本地配置使用 `openai_compatible`、`deepseek-v4-flash` 和 `/chat/completions`。

## 3. 验证入口

```bash
curl -i http://localhost:18080/actuator/health
curl -i http://localhost:8080/api/agent/health
curl -i http://localhost:8080/agent-api/health
curl -i http://localhost:8080/health/ready
```

`/agent-api/health` 是当前仓库开发构建产物的兼容入口，本地 Nginx 会把它转换为生产约定的 `/api/agent/health`。生产 Nginx 文件不在本任务中修改。

## 4. 查看和修改 Nacos 路由

```bash
docker compose -f gateway-local/compose.yaml logs -f gateway
docker compose -f gateway-local/compose.yaml exec nacos sh -c \
  'wget -qO- "http://127.0.0.1:8848/nacos/v3/client/cs/config?dataId=znws_gateway.yaml&groupName=DEFAULT_GROUP&namespaceId=public"'
```

修改本地文件后重新发布：

```bash
docker compose -f gateway-local/compose.yaml run --rm nacos-config-init
```

Gateway 监听 Nacos 刷新事件并发出路由刷新事件。若只看到配置已发布但路由未更新，先检查 Gateway 日志，再执行：

```bash
curl -X POST http://localhost:18080/actuator/gateway/refresh
```

## 5. 内存与停止

| 服务 | 初始上限 |
|---|---:|
| Nacos | 768 MB |
| Gateway | 256 MB |
| Python | 384 MB |
| Agent | 192 MB |
| Agent 注册 sidecar | 64 MB |
| Nginx | 32 MB |

总上限约 1.66 GB，不含 Docker 本身和文件缓存。Nacos 3.2.3 在当前机器上实际约占 750 MB，因此不能再按 512 MB 限制运行。查看是否触碰上限：

```bash
docker stats --no-stream
docker compose -f gateway-local/compose.yaml down
```

`down` 不删除 Nacos、Agent、Python 数据卷。确认不再需要本地数据时再单独执行 `docker volume ls` 和 `docker volume rm`。
