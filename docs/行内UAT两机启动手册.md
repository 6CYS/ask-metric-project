# 问数两台服务器启动手册

目的：先把一套新版问数跑起来。前端一台、后端一台，各一个实例。

使用普通 appuser；不用 sudo，不用 Docker，不安装系统 Node，不执行 npm。本包自带 Node，后端脚本统一管理 Python 和 Agent 两个进程。

## 1. 把包放对机器

先在本机解压《问数UAT两机单实例-20261009-r2.zip》（模型参数迁移修正版）：

| 上传机器 | 上传到 appuser 家目录的文件 | 用途 |
| --- | --- | --- |
| 77.16.60.204 | back.tgz、back.tgz.sha256 | 后端完整包：Python、Agent、Node 和依赖 |
| 77.6.79.36 | front.tgz、front.tgz.sha256 | 前端静态文件、用户态 Nginx 配置 |

两边程序均解压到 `~/ws`。配置、日志和会话保留在 `~/ask-metric-pi`，原 UAT 配置/密钥不覆盖。`~/ws` 应为空的新目录，不覆盖已有程序。

复用原 Nacos、数据库、模型与 SSO。原 8089/Gateway/Nacos 不动，新页面入口是 `http://77.6.79.36:8090`。

## 2. 后端机 .204：先执行这 7 条

```sh
cd ~
sha256sum -c back.tgz.sha256
mkdir ws
tar xzf back.tgz -C ws --strip-components=1
cd ws
sh run.sh install
sh run.sh prepare
```

预期：back.tgz 校验 OK；Python 依赖检查通过；包内 Node 显示 v22.23.2；生成 8 个加密配置文档和两个引导文件。

prepare 默认读取现场有效文件 `/home/appuser/ask-metric-config-uat/backend.env` 及其资源/密钥引用。原 SM4 主密钥复用，不重新生成。原 Nacos 账号须具有新配置组读写权限；缺少账号或资源时会停止。

**生成后先核对模型，再发布。** 待发布文件在 `~/ask-metric-pi/config/nacos`：

- `sznsznws_agent_runtime.json`：模型兼容地址、模型名、认证方式、上下文窗口、超时。
- `export-report.json`：退役字段名称。
- 模型/数据库密码已经加密，不需要在聊天中提供 API key、配置密文或主密钥。

r2 会保留原 Chat 的 `user_message_suffix`、输出上限和超时，例如截图中的 `/no_think`、1024 token、60 秒；Chat 的自定义 `accessKey` 请求头及 `chat_template_kwargs` 同样保留。Agent 工具调用不强制 `json_object` 内容模式。

默认模型窗口 128000 仅为生成初值，须按真实模型能力确认或修改；修改窗口时同时核对输出和压缩预算，publish 会校验。原 Chat 路径若是标准 `/v1/chat/completions` 会自动转换；非标准路径会提示先确认 Agent 兼容入口。尚未生成配置时，可按真实值执行：

```sh
sh run.sh prepare --agent-base-url 兼容入口 --context-window 实际窗口
```

不要照抄占位文字。已生成配置时，用现场文件工具修改 Agent runtime JSON，再继续 publish。prepare 拒绝覆盖已有配置。

若此前已按 r1 生成 `~/ask-metric-pi/config`，跳过 prepare，并在发布前补齐 Agent runtime JSON 的 `AGENT_MODEL_USER_SUFFIX`、`AGENT_MODEL_MAX_TOKENS`、`AGENT_MODEL_TIMEOUT_MS`、`AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS`（按原 UAT 实际值）。r2 不会自动改写已经生成或发布的配置。若此前已启动新版，先通过原包的 stop 停掉旧实例再启动本包；不同时运行两套后端，不重复使用历史旧 PID。

## 3. 发布配置、处理数据库：2 条

```sh
sh run.sh publish
sh run.sh sql
```

publish 先校验后端配置和 Agent 的真实启动入口，再发布回读 8 项。配置组为 `ASK_METRIC_CONFIG_PI_UAT_R1`，namespace 复用原 public，不覆盖旧组。

sql 只检查连接、实际版本/字段，并生成 `~/ask-metric-pi/db-increment.sql`，不会执行数据库迁移。**把 SQL 交 DBA 备份、审核并执行所需增量，再往下走。**

| 行内应用库版本 | 要补的增量 |
| --- | --- |
| 0003 | 0004 + 0005 |
| 0004 | 0005 |
| 0005 | 核对字段，通常不用再补 |
| 其他版本或缺少版本表 | DBA 先核对，不能初始化现有库 |

本机原模拟库为 0004；腾讯云当前为 0005。本机补齐 0005 后的副本与云 14 张应用表一致，数据湖实际使用的三张表结构一致。本次包继续沿用这条迁移链。行内已有列须跳过，不盲目重跑全部 ALTER。

## 4. DBA 完成后，后端机执行 4 条

```sh
sh run.sh db
sh run.sh sync
sh run.sh start
sh run.sh check
```

预期：两个连接 SELECT 1 OK，missing columns 为 `{}`；正式目录同步成功；最后 backend/agent 均 HTTP 200。

start 一次启动本包 Python :8010 和 Agent :8020，最长等待约 180 秒；Node 使用包内二进制。业务配置来自 Nacos，Agent 同机调用 `127.0.0.1:8010`。健康检查不代表真实模型问数已通过。

## 5. 前端机 .36：执行这 7 条

```sh
cd ~
sha256sum -c front.tgz.sha256
mkdir ws
tar xzf front.tgz -C ws --strip-components=1
cd ws
sh run.sh start
sh run.sh check
```

预期：front.tgz 校验 OK，Nginx 配置测试成功，首页请求 HTTP 200。前端不用执行 install，不需要 Python/Node。

前端配置、PID、日志和全部临时路径在用户目录。`/api/` 转到 `.204:8010`，`/agent-api/` 转到 `.204:8020`，不经过原 9000 Gateway，不把网页请求转到 Nacos。

如果已有本方案 nginx.conf，start 使用现有配置；确认其 root 指向本次前端目录。如果原独立 8090 实例仍在运行，先通过原包停止，再启动此包；不停止系统 8089 实例。

## 6. 先确认“跑起来”：前端机 3 条

```sh
curl -I http://127.0.0.1:8090/
curl -s http://77.16.60.204:8010/health/ready
curl -s http://77.16.60.204:8020/health
```

打开 `http://77.6.79.36:8090`，检查页面和登录。Nacos 中应有 8 项新组配置，以及 `public / DEFAULT_GROUP / ask-metric-python-pi-uat` 的健康 `.204:8010` 实例。

首次主流程共 **20 条短部署命令 + 3 条连通确认命令**。DBA 操作和模型/配置核对另计。

## 7. 模型需要确认什么

可以先准备/安装资源；首次真实问数前需要确认：

1. 原 UAT Chat 模型名和兼容入口，例如 BASE_URL 是否应包含 `/v1`。
2. 该入口支持 SSE 流式响应，以及 tools/tool_calls 工具调用。
3. 实际上下文窗口（token 数），据此核对输出和压缩预算；超时沿用原 Chat 值，可按实际响应性能调整。

在后端机 `.204` 安装完成后，用 **1 条命令**检查模型：

```sh
sh run.sh model
```

它读取 `.204` 原 UAT 的 backend.env、实际 MODEL_CONFIG_PATH、凭据文件及 SM4 密钥，仅发送合成文本。分别检查 Chat 的 SSE/tool_calls/工具结果回送、Embedding 数组、Reranker 响应格式，不显示密钥或响应正文。把输出中的 PASS/FAIL 发回来即可；每次调用最多等待原配置的超时（截图中 60 秒）。这项检查额外于前述 20+3 条命令。

已提供的 SIT 截图配置为：Chat `http://77.6.200.23:18094/v1/chat/completions`（accessKey、无前缀），Embedding `http://77.6.200.11:8011/v1/embeddings`（atom、无鉴权），Reranker `http://77.6.200.11:8012/v1/rerank`（bge-reranker-v2-m3、texts 参数、无鉴权）。截图不能证明 UAT 使用同一入口；脚本会显示实际配置来源和地址。1024 是单次输出上限，不是上下文窗口。

“不知道”也可以，先把已有模型服务文档或不含凭据的说明给开发侧确认。API key 在行内沿用，不发聊天。没有确认工具调用能力时，不能把页面打开或健康 200 当成模型已适配。

真实模型确认后，登录询问一个已知机构、指标和日期，核对非空结果，再追问一次。云/本机结构一致也不替代真实 GoldenDB/Inceptor 的取数验证；行内 SIT 表名/字段映射继续沿用现场值，不能复制云的快照库名。

## 8. 出错时只用这几条

后端机分别查对应日志：

```sh
tail -n 30 ~/ask-metric-pi/logs/backend-console.log
tail -n 30 ~/ask-metric-pi/logs/agent-console.log
```

前端机：

```sh
tail -n 30 ~/ask-metric-pi/logs/nginx-error.log
```

两台各自停启均在 `~/ws` 执行：

```sh
sh run.sh stop
sh run.sh start
```

只停止本包实例；保留配置、主密钥和 `~/ask-metric-pi/state`。publish 失败先修正配置，db 缺列先处理增量，端口占用先查明进程。不要跳过数据库或配置错误强行启动，不执行系统 Nginx 重载或 init-db。

仍需允许浏览器访问 `.36:8090`，以及 `.36 → .204:8010/8020`、后端到原 Nacos/数据库/模型/SSO 的连接。其余已确认的基础环境检查不重复手敲。
