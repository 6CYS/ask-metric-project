# Ask Metric GoldenDB 智能问数系统

Ask Metric 是面向行内 GoldenDB/MySQL 应用库与只读数据湖的智能问数系统。系统把自然语言问题解析为受治理的语义结构，再通过已登记的 SQL 模板执行查询；模型不直接生成或执行 SQL。前端、后端、模型配置、目录同步、权限控制、审计与原生离线部署均包含在本仓库中。

## 系统组成

| 目录 | 作用 |
| --- | --- |
| `frontend-vue/` | Vue 3 前端，提供登录、智能问数、指标与机构管理、查询记录、模型与 SQL 配置、准确率管理等页面 |
| `backend-next/` | FastAPI 后端，提供认证、权限、会话任务、语义解析、模板查询、目录同步、配置管理和审计能力 |
| `deploy/package/` | Linux x86_64/aarch64 无 Docker 离线构建、安装、升级、健康检查和回滚工具 |
| `docs/` | 对外接口和系统对接文档 |

生产环境由 Nginx 提供前端静态资源并代理同源 `/api`，后端可向 Nacos 注册为 `ask-metric-python`，由 Gateway 通过 `lb://ask-metric-python` 发现实例。

## 核心链路与职责边界

初次维护代码可从 [关键代码阅读指南](docs/关键代码阅读指南.md) 开始，按启动、提问、澄清、查询执行和历史结果的顺序阅读；其中附有本项目 `lambda`、依赖注入、事务和向量缓存的写法说明。

当前运行版本维护单次可信问数、当前任务澄清和历史结果查看/导出。旧归因分析原型已退出运行链，
原因分析、分项贡献等请求会明确返回当前不支持；数值取值、两期对比和历史结果操作继续可用。
后续 harness 接入将复用现有查询和证据能力，目前未接入新的分析运行器。
升级原归因试验环境见 [后端升级说明](backend-next/README.md#旧归因原型退出与升级)。

```text
用户认证与机构权限
→ 创建问数任务
→ 指标、机构目录精确匹配并保护确定名称
→ 可选 Embedding 召回与 Reranker 重排
→ Chat 模型理解日期、多样化机构范围和查询操作
→ 后端校验模型槽位、展开受控目录范围并裁剪用户权限
→ 生成 Logical DSL
→ 选择已登记的 MySQL/Inceptor SQL 模板并绑定参数
→ 只读查询库执行
→ 结果整理、自然语言总结与全过程审计
```

日期表达以及“各家、各个、全省农商行”等泛化表达由模型负责理解。规则只保护用户问题中已明确出现的指标和机构，模型输出必须经过目录、权限、查询形态和参数合法性校验。机构范围只能展开到目录中的有效机构，并按当前用户授权范围裁剪；模型不能自由生成机构编号。所有业务 SQL 来自 `backend-next/resources/sql/`，注册信息位于 `backend-next/config/query-templates.json`。

## 环境要求

- Python 3.11、3.12 或 3.13，推荐 3.12；
- Node.js 22.12+（22.x）或 24.x 与 npm，用于构建 Vue 前端；
- GoldenDB/MySQL 应用库；
- GoldenDB/MySQL 或 Inceptor 只读指标查询库；
- 问数需要可访问的 Chat 模型服务；Embedding、Reranker 为可选角色；
- 生产部署可选 Nginx、systemd、Nacos 与统一 Gateway。

## 本地启动

首次安装请按 [本地部署指南](docs/本地部署指南.md) 完成以下步骤，不能只复制环境模板后直接启动：

1. 创建 Python 虚拟环境，安装后端依赖；前端使用 `npm ci` 安装锁定依赖。
2. 以 `backend-next/.env.example` 配置两个数据库连接、独立签名密钥和模型服务。
3. 审核并初始化应用库，配置数据湖映射、同步正式目录，创建首个登录账户。
4. 启动后端 `127.0.0.1:8010` 和前端 `localhost:5173`，检查登录、数据源及模型查询。
5. 每次新问题独立查询；当前任务缺少条件时继续澄清。跨任务追问与历史指代执行已退出，无恢复开关，详见 [后端升级说明](backend-next/README.md#独立问数与当前任务澄清)。

指南包含 Windows/Linux 命令、迁移开关、密码生成方式和常见错误处理。正式发布使用同源 `/api`，不得把本机后端 URL 写入产物。

## 配置文件

后端使用环境变量或 `backend-next/.env`。完整字段和默认说明见 `backend-next/.env.example`；原生部署使用 `deploy/package/runtime/backend.env.example` 生成 `/etc/ask-metric/backend.env`。

最少需要确认以下配置：

```dotenv
APP_ENV=production

# 应用元数据、账号、会话和审计库，使用读写账号
APP_DATABASE_URL=ENC[SM4:v1:...]
APP_DATABASE_DIALECT=mysql

# 经营指标查询库，数据库侧必须授予只读权限
QUERY_DATABASE_URL=ENC[SM4:v1:...]
QUERY_DATABASE_DIALECT=inceptor

# 目录库未单独配置时复用 QUERY_DATABASE_URL
METRIC_CATALOG_DATABASE_URL=
ORG_CATALOG_DATABASE_URL=

CONTINUATION_TOKEN_SECRET=ENC[SM4:v1:...]
JWT_SECRET=ENC[SM4:v1:...]
SM2_PRIVATE_KEY=ENC[SM4:v1:...]
ASK_METRIC_CONFIG_SM4_KEY_FILE=/etc/ask-metric/config-sm4.key
```

`APP_DATABASE_URL` 与 `QUERY_DATABASE_URL` 必须使用不同用途的账号。数据库密码可能包含 `@`、`:`、`/`、`#` 等 URL 特殊字符，因此建议把完整数据库 URL 作为一个值加密，不要只加密 URL 中的密码片段。

### SM4 加密配置

下列敏感项支持 `ENC[SM4:v1:...]` 格式：

- `NACOS_PASSWORD`；
- `APP_DATABASE_URL`、`QUERY_DATABASE_URL`、`METRIC_CATALOG_DATABASE_URL`、`ORG_CATALOG_DATABASE_URL`；
- `CONTINUATION_TOKEN_SECRET`、`MODEL_ADMIN_TOKEN`、`TRUSTED_PROXY_TOKEN`、`JWT_SECRET`；
- `SM2_PRIVATE_KEY`；
- 模型配置所引用的 `MODEL_CHAT_API_KEY`、`MODEL_EMBEDDING_API_KEY`、`MODEL_RERANK_API_KEY` 等密钥环境变量。

先在目标环境生成 16 字节主密钥，即 32 个十六进制字符。主密钥文件不能提交到代码仓库，也不能与密文一起打包：

```bash
umask 077
openssl rand -hex 16 > /etc/ask-metric/config-sm4.key
chown root:askmetric /etc/ask-metric/config-sm4.key
chmod 0640 /etc/ask-metric/config-sm4.key
```

安装后端依赖后，逐项执行加密命令。命令通过隐藏输入读取明文，不把密码留在命令行历史中：

```bash
cd /opt/ask-metric/current/backend
/opt/ask-metric/current/venv/bin/python -m ask_metric encrypt-config \
  --key-file /etc/ask-metric/config-sm4.key
```

把命令输出的完整密文写入 `backend.env`：

```dotenv
ASK_METRIC_CONFIG_SM4_KEY_FILE=/etc/ask-metric/config-sm4.key
NACOS_PASSWORD=ENC[SM4:v1:<iv>:<ciphertext>:<tag>]
APP_DATABASE_URL=ENC[SM4:v1:<iv>:<ciphertext>:<tag>]
QUERY_DATABASE_URL=ENC[SM4:v1:<iv>:<ciphertext>:<tag>]
MODEL_CHAT_API_KEY=ENC[SM4:v1:<iv>:<ciphertext>:<tag>]
JWT_SECRET=ENC[SM4:v1:<iv>:<ciphertext>:<tag>]
```

服务读取配置时先校验密文完整性，再解密并创建数据库、Nacos 或模型连接。每次加密使用随机 IV，相同明文会生成不同密文；密钥缺失、格式错误或密文被修改时服务会拒绝启动。实现使用 SM4-CBC 加密与 SM3-HMAC 完整性校验。

也可以临时通过 `ASK_METRIC_CONFIG_SM4_KEY` 传入 32 位 hex 主密钥，但不能同时配置 `ASK_METRIC_CONFIG_SM4_KEY_FILE`。生产环境推荐独立密钥文件，并由运行账号只读挂载。

### Nacos 与 Gateway

```dotenv
NACOS_ENABLED=true
NACOS_SERVER_ADDR=192.0.2.11:8848,192.0.2.12:8848,192.0.2.13:8848
NACOS_NAMESPACE=public
NACOS_GROUP=DEFAULT_GROUP
NACOS_SERVICE_NAME=ask-metric-python
NACOS_CLUSTER_NAME=DEFAULT
NACOS_INSTANCE_IP=<Gateway可访问的后端内网IP>
NACOS_INSTANCE_PORT=8010
NACOS_INSTANCE_ID=ask-metric-01
NACOS_USERNAME=<用户名>
NACOS_PASSWORD=ENC[SM4:v1:...]
NACOS_EPHEMERAL=true
NACOS_FAIL_FAST=false
```

多实例必须使用不同的 IP/端口组合和 `NACOS_INSTANCE_ID`。Gateway 与后端应使用相同的 namespace、group 和 cluster；网络策略需同时允许 Nacos HTTP 端口和客户端 gRPC 端口。

### 模型、提示词与 SQL 模板

模型基础配置位于 `backend-next/config/model-config.json`。Chat、Embedding、Reranker 可分别设置 API 路径、模型名、认证方式、密钥环境变量、超时和厂商扩展参数；服务地址分别由 `MODEL_CHAT_BASE_URL`、`MODEL_EMBEDDING_BASE_URL`、`MODEL_RERANK_BASE_URL` 从外置环境读取。模型地址和密钥均不写入源码配置、日志或查询响应。

管理员页面需要写入配置时设置：

```dotenv
MODEL_ADMIN_WRITE_ENABLED=true
MODEL_ADMIN_TOKEN_REQUIRED=true
MODEL_ADMIN_TOKEN=ENC[SM4:v1:...]
```

提示词位于 `backend-next/config/prompts.json`，语义配置位于 `backend-next/config/semantic-config.json`，SQL 注册表位于 `backend-next/config/query-templates.json`。生产安装会把这些文件初始化到持久状态目录，升级只补充缺失项，不覆盖管理员已发布的版本。

### 数字农商统一单点登录

```dotenv
SSO_ENABLED=true
SSO_USER_INFO_URL=https://<digital-rural-host>/yusp-app-oca/api/ssoconfig/userInfo
SSO_TIMEOUT_SECONDS=10
SSO_SOURCE_SYSTEM=jsrcb
JWT_SECRET=ENC[SM4:v1:...]
SM2_PRIVATE_KEY=ENC[SM4:v1:...]
```

前端使用 `/login?token=<数字农商token>` 进入。后端在服务端校验上游 token 并签发本地 JWT。用户名密码登录采用 SM2 加密一次性 SM4 密钥、SM4-CBC 加密密码的传输链路；密码落库使用加盐 SM3 哈希。登录加密和运行配置加密是两套独立用途，不能复用密钥材料。

## 数据库与目录

应用库结构只通过 GoldenDB Alembic 链管理。生产变更先生成离线 SQL 交 DBA 审核。当前 Alembic 对离线导出也检查变更开关；仅在运维进程中临时启用，用完关闭：

```powershell
cd backend-next
$env:BACKEND_NEXT_ALLOW_SCHEMA_CHANGES="true"
$env:BACKEND_NEXT_ALLOW_NON_TEST_DATABASE="true"
python -m alembic -c alembic-goldendb.ini upgrade head --sql
Remove-Item Env:BACKEND_NEXT_ALLOW_SCHEMA_CHANGES
Remove-Item Env:BACKEND_NEXT_ALLOW_NON_TEST_DATABASE
```

审批、备份并确认目标库后才允许执行：

```powershell
$env:BACKEND_NEXT_ALLOW_SCHEMA_CHANGES="true"
$env:BACKEND_NEXT_ALLOW_NON_TEST_DATABASE="true"
python -m alembic -c alembic-goldendb.ini upgrade head
Remove-Item Env:BACKEND_NEXT_ALLOW_SCHEMA_CHANGES
Remove-Item Env:BACKEND_NEXT_ALLOW_NON_TEST_DATABASE
```

Inceptor 数据湖表名、字段名、快照和批次规则由 `SIT_*` 配置控制。目录同步应先执行 `--dry-run`，首次切换权威目录可使用带确认口令的 `initialize-synchronized-catalogs` 命令；具体参数见部署文档。

## 生产部署

行内无 Docker 环境使用原生离线包：

```powershell
python deploy/package/build_bundle.py `
  --version 20260903.1 `
  --platform linux-x86_64 `
  --python-version 3.12
```

发布包不包含 `.env`、数据库口令、模型密钥、SM4 主密钥或业务数据。目标机先校验 SHA-256，再运行安装器；安装和升级不会自动执行数据库迁移。完整流程见 `deploy/package/README.md`。

## 安全要求

- 查询账号必须由数据库侧强制只读，不能与应用库读写账号复用；
- 模型只能输出受约束语义结构，不能提交 SQL、表名、字段名或机构编码；
- SQL 只从登记模板加载，业务值全部使用绑定参数；
- 明确机构和指标由目录保护，泛化机构范围须经目录展开和权限裁剪；
- 生产密钥不得明文提交，不得打印到日志，不得出现在前端响应；
- 配置密文与 SM4 主密钥必须分开保存，密钥文件权限建议为 `0640` 或更严格；
- Schema 变更、配置写入和目录初始化均需要独立开关或确认口令；
- 运行日志、查询任务、SQL 模板版本和配置变更均保留审计信息。

## 相关文档

- [本地部署指南](docs/本地部署指南.md)：首次安装、密钥、目录、账号、模型和查询就绪状态；
- `backend-next/README.md`：后端运行、安全和配置说明；
- `frontend-vue/README.md`：前端运行与代理配置；
- `deploy/package/README.md`：无 Docker 离线部署、升级和回滚；
- `deploy/package/DATA_LAKE_DEPLOY.md`：数据湖连接与目录同步；
- `docs/external-api.md`：外部系统接入协议。

## 源码交付范围

本仓库包含当前应用源码、运行配置模板、SQL、GoldenDB 迁移、前端构建资源和部署工具。
不包含维护仓库的自动化测试、现场验收脚本与报告、演示数据生成工具、凭据、数据库备份和构建产物。
准确率管理是现有应用功能，因此保留其服务代码、运行脚本及默认基线资源；这些不代表当前环境已通过业务验收。
源码快照独立建立提交历史，未导入旧仓库的测试及现场历史记录。配置示例中的地址仅供说明，接收方必须替换。
