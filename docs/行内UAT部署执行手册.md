# 问数新版 UAT 部署执行手册

版本：uat-pi-20261009-r1。先按第 1～5 节执行，后面的内容用于配置核对和排障。

本包已完成本机 Docker 模拟验证；行内部署使用普通 appuser，不使用 sudo，不需要 Docker，也不需要联网安装 npm/pip 依赖。

## 1. 部署位置与需要确认的三件事

| 服务器 | 部署内容 | 端口 |
| --- | --- | --- |
| 77.6.79.36 | 新版前端、appuser 独立 Nginx | 8090 |
| 77.16.60.204 | Python 后端、Pi Agent、包内 Node | 8010、8020 |
| 原 UAT Nacos 三节点 | 继续提供配置中心和服务注册，不重新安装 | .204/.40/.91:8848，客户端 gRPC 9848 |

浏览器访问 `http://77.6.79.36:8090`。Nginx 的 `/api/` 转到 `.204:8010`，`/agent-api/` 转到 `.204:8020`；Agent 在后端机通过 `127.0.0.1:8010` 调用 Python。Python 和 Agent 向 Nacos 读取业务配置，Python 另向 Nacos 注册服务。网页请求不转发到 Nacos 8848。

原 8089 Nginx、三台 9000 Gateway 和 Nacos 服务继续保留。新版注册名使用 `ask-metric-python-pi-uat`，避免原 Gateway 自动分流到尚未验收的新版本。

已完成的系统、权限、IP、原文件路径检查不用重做。部署前只需协调以下三类确认，不需要再逐条手敲环境调查命令：

1. **网络与入口**：允许浏览器访问 `.36:8090`；允许 `.36 → .204:8010/8020`；后端机能访问原 Nacos 的 8848/9848、两个数据库、模型和 SSO。如果行内必须经原 Gateway，先由网关维护方补齐新版两个 API 路由，再安排入口切换。
2. **配置与模型**：原 Nacos 账号能读写新配置组；现场原 env/密钥及其引用的资源文件完整。Agent 模型入口支持 OpenAI Chat Completions 的 SSE 和 tools，实际上下文窗口已确认。原 SSO 仍须在行内真实验证。
3. **数据库与权限**：DBA 确认实际应用库迁移版本、已有列、备份及增量执行安排；正式机构目录的机构码与事实表机构码一致，用户机构权限正确。

## 2. 上传与解压：两台服务器各执行 5 条

先在本机解压外层 ZIP，将 `pi-uat.tgz` 和 `pi-uat.tgz.sha256` 上传到两台服务器的 appuser 家目录。外层 ZIP 内另有本手册、验证报告和数据库参考 SQL。

两台服务器分别执行：

```sh
cd ~
sha256sum -c pi-uat.tgz.sha256
mkdir pi
tar xzf pi-uat.tgz -C pi --strip-components=1
cd pi
```

校验应显示 `pi-uat.tgz: OK`。`~/pi` 必须是本次新建的目录；已经存在时不要覆盖解压，先确认是否为本次版本或换一个空目录。

程序在 `~/pi`。配置、日志和会话状态在 `~/ask-metric-pi`，升级程序时保留后者。原程序和 `/home/appuser/ask-metric-config-uat` 不覆盖。

## 3. 后端机 .204：按顺序执行

### 3.1 离线安装：1 条

```sh
sh ops/uat.sh install
```

预期：依赖安装完成，`No broken requirements found.`，Node 显示 `v22.23.2`。本步骤使用现有 Python 3.12 创建虚拟环境，不要求 PATH 中已有 Node。

### 3.2 从现场旧配置生成新版配置：1 条

```sh
sh ops/uat.sh prepare
```

默认读取实际旧配置 `/home/appuser/ask-metric-config-uat/backend.env`，以及其中引用的模型、提示词、语义配置和原 SM4 主密钥文件。不会执行 env 内容，不生成新主密钥。

预期：生成 **8 个 SM4 配置文档及两个引导文件**。

| 文件 | 用途 |
| --- | --- |
| `~/ask-metric-pi/config/backend.env` | 后端本机引导，只有 Nacos、密钥引用、节点和本地路径等 |
| `~/ask-metric-pi/config/agent.env` | Agent 本机引导 |
| `~/ask-metric-pi/config/nacos/` | 待发布的 8 个配置文档和 export-report.json |

**此时核对一次配置，再继续发布。** 用现场文件工具查看 `export-report.json` 的退役字段名称，以及 `sznsznws_agent_runtime.json` 中模型地址、名称、认证方式、上下文窗口。模型密钥等敏感值已加密，不需要在聊天中提供文件内容。

Agent 默认上下文窗口为 128000；必须按真实模型能力确认或修改，不能把默认数值当成模型事实。标准 `/v1/chat/completions` 路径会自动转换成 Agent 的 `/v1` BASE_URL。自定义 Chat 路径会停止准备，须先取得兼容入口。

只有确认实际值后才使用这些可选参数，**不要照抄示例地址/窗口**：

```sh
sh ops/uat.sh prepare --agent-base-url 模型兼容入口 --context-window 实际窗口
```

该命令用于尚未生成配置时。已生成配置后，在现场受控文件工具中修改待发布的 Agent JSON，再执行 publish；prepare 拒绝覆盖已有配置。

原 env 若缺少 Nacos 账号，先由现场维护人员在受控配置中补齐；若出现旧省级机构权限字段提示，先核对当前机构权限合同，再整理源配置。不能为通过检查直接扩大权限。

### 3.3 发布到新 Nacos 配置组：1 条

```sh
sh ops/uat.sh publish
```

默认 namespace 为现场原值 `public`，**配置组固定为 `ASK_METRIC_CONFIG_PI_UAT_R1`**。与服务注册组 `DEFAULT_GROUP` 分开。

预期：Agent 本地配置校验通过；8 行 `published and verified`；最后提示后端按真实启动入口完成 Nacos 校验。账号权限不足、字段错误、密文错误或回读不一致都会退出。未全部成功时不启动，修正后可重新 publish；不会写入旧配置组。

### 3.4 核对并生成数据库增量：1 条

```sh
sh ops/uat.sh sql
```

本命令只做两个库的 `SELECT 1`、读取实际版本/列，并生成 `~/ask-metric-pi/db-increment.sql`，**不执行迁移**。

把生成的 SQL 交 DBA：备份应用库，核对当前版本及已有列，审核并执行真正缺失的增量；GoldenDB 的 DDL、锁影响和发布窗口由 DBA 确认。已存在的列须跳过，不能直接重跑全部 ALTER。包内 `数据库增量参考-0003到0005.sql` 只用于对照，现场以本命令生成的实际版本增量为准。

| 现场版本 | 本次处理 |
| --- | --- |
| 0003_analysis_checkpoints | 0004 + 0005 |
| 0004_org_hierarchy_and_org_code | 仅 0005 |
| 0005_metric_source_structure | 核对字段，通常不再执行增量 |
| 其他版本／没有版本表 | 停在数据库步骤，由 DBA 核对；不初始化、不猜测版本 |

DBA 完成后再执行以下命令。不要在现有库执行 init-db，也不要全量导入历史测试数据。

### 3.5 检查、同步目录、启动：4 条

```sh
sh ops/uat.sh db
sh ops/uat.sh sync
sh ops/uat.sh start
sh ops/uat.sh check
```

| 命令 | 预期结果 |
| --- | --- |
| db | APP、QUERY 的 SELECT 1 OK；missing columns 为 `{}` |
| sync | 正式指标与机构目录同步成功；会写应用库目录，读取原目录数据源 |
| start | 输出 backend/agent 的 PID，等待就绪，最终两项 HTTP 200；节点故障切换时可能需要等待 |
| check | `backend: HTTP 200`、`agent: HTTP 200` |

start 会检查数据库与端口；只启动本包进程，不自动改数据库。原旧后端已停止，若 8010 后续被别的进程占用，先查明进程，不重复使用历史 PID 停进程。

## 4. 前端机 .36：解压后执行 2 条

无需在前端机执行 install，不需要 Node/npm/Python 来运行页面。使用已经存在的 Nginx 二进制：

```sh
sh ops/uat.sh front
sh ops/uat.sh front-check
```

预期：配置测试成功，首页请求成功。配置、PID、日志以及 client/proxy/fastcgi/uwsgi/scgi 临时目录均在 `~/ask-metric-pi`，不会引用受限系统日志/PID目录。

`front` 用于首次生成并启动；重复运行会拒绝覆盖已有 nginx.conf。已有本版本配置时使用 `front-start`。不要在本方案执行系统实例的 nginx -s reload。

## 5. 最终确认命令与页面验收

在前端机执行 3 条：

```sh
curl -I http://127.0.0.1:8090/
curl -s http://77.16.60.204:8010/health/ready
curl -s http://77.16.60.204:8020/health
```

预期：首页 HTTP 200；后端 ready；Agent ok。第 2、3 条同时确认前端机到后端机网络连通。

在 Nacos 控制台确认：新组有 8 个 Data ID；`public / DEFAULT_GROUP` 下 `ask-metric-python-pi-uat` 的 `.204:8010` 为健康实例。Agent 通过配置中心读取配置，不注册为 Python 服务。

浏览器打开 `http://77.6.79.36:8090`，按实际行内账号验证：

1. 实际登录／SSO，确认身份与机构权限。
2. 查询一条已知日期、指标和机构，核对真实数值；再追问另一日期或机构。
3. 刷新后恢复会话，查看查询结果和旧历史；验证现有导出入口。
4. 在验收窗口重启本包服务，再确认会话/结果可恢复。

健康接口通过不能替代真实模型、权限和业务取数验收。新入口通过后，再由行内发布流程决定是否接入原 Gateway/域名。

**首次部署主流程共 20 条短命令**：两台上传后解压各 5 条、后端 8 条、前端 2 条；另外最终连通确认 3 条。DBA 审核执行、受控配置核对与页面验收另计。遇到错误才使用下面的诊断命令，不需要提前全部执行。

## 6. 出错时只查对应项

以下默认在 `~/pi` 执行。

| 现象 | 确认命令／处理 |
| --- | --- |
| 安装失败 | 确认 tar 校验为 OK；查看 install 输出，不联网升级包 |
| publish 失败 | 本机核对原 Nacos 账号授权、配置组和待发布文件；不能改为读本地业务配置来绕过 |
| 数据库缺列 | `sh ops/uat.sh sql`；DBA 完成后 `sh ops/uat.sh db` |
| 后端／Agent 启动失败 | 分别查看下面两条日志；只发脱敏错误行 |
| 网页可开、接口不通 | 前端机执行第 5 节两个健康请求，确认网络/目标端口 |
| 健康但问数为空／无权限 | 核对真实机构码、用户权限、指标 source_metric_code、事实表日期与数据源映射 |
| SSE 中断／模型超时 | 核对 Agent 模型 SSE/tools 支持、模型入口与 30 秒默认超时；按行内性能调整 Nacos 参数 |

```sh
tail -n 30 ~/ask-metric-pi/logs/backend-console.log
tail -n 30 ~/ask-metric-pi/logs/agent-console.log
tail -n 30 ~/ask-metric-pi/logs/nginx-error.log
```

后端 PID/端口排查只在需要时执行：

```sh
ss -lntp | grep -E ':8010|:8020'
```

## 7. 停启、配置生效与回退

后端机：

```sh
sh ops/uat.sh stop
sh ops/uat.sh start
```

前端机：

```sh
sh ops/uat.sh front-stop
sh ops/uat.sh front-start
```

后端 stop 核对本包记录的 PID 和启动命令指纹，不停其他服务。Nginx 命令只针对本用户独立实例。

Nacos 中的后端标量业务配置、Agent 配置变更后，按以上命令重启。后端模型/提示词/语义资源按资源读取入口从中心加载；模型管理写入会更新 Nacos，敏感凭据保持 SM4 密文。

回退时停止本包，保留 `~/ask-metric-pi/state`、日志和已生成配置，按现场原发布记录恢复旧程序/入口。原 8089/Gateway/旧配置组未改动。0004/0005 为新增列，不自动删列或回写版本号；数据库回退由 DBA 结合备份确认。原 SM4 主密钥始终保留，不能重新生成。

## 8. 配置与资源包明细

新配置组中实际使用的 8 项如下。Agent 两项为 **JSON**：

| Data ID | 内容 |
| --- | --- |
| sznsznws_backend_runtime.yaml | 后端运行、限制等业务参数 |
| sznsznws_backend_datasource.yaml | 数据库 URL 密文、方言、连接参数、SIT 表列映射 |
| sznsznws_backend_security.yaml | JWT、SM2、SSO、权限、管理令牌、后端模型密钥等 |
| sznsznws_backend_model.json | Chat／Embedding／Reranker 角色配置 |
| sznsznws_backend_prompts.json | 后端当前支持的提示词 |
| sznsznws_backend_semantic.json | 语义匹配配置 |
| sznsznws_agent_runtime.json | Agent 模型、上下文预算、超时、重试、压缩等 |
| sznsznws_agent_security.json | Agent 模型 API key 的 SM4 密文 |

配置中心不可用或文档不完整时拒绝启动，不回退到本地业务变量/默认密码。缺失、重复、未知、敏感明文和节点路径字段会被校验。旧 SQL 模板 Data ID 保留在旧组；当前受治理 SQL builder 不加载旧模板，新版业务验收须核对原定制口径。

tar 内包含前端产物、后端 wheel 和完整 Linux 依赖、Agent dist/生产依赖/skills、Node 22.23.2、迁移资源和本手册对应运维入口。Python 和 Nginx 复用服务器现有安装。包内不含行内真实配置、主密钥、数据库备份、Docker 模拟密码或令牌。

0004/0005 核对的 6 个新增列：metric_values.org_code；org_terms.parent_org_code、hierarchy_level；metric_terms.source_metric_code、base_name、value_basis。

本机验证范围和未验证项见同包《部署验证结果.md》。请只使用本手册的 `sh ops/uat.sh` 入口；包内其他通用系统安装脚本不适用于本次无 sudo 的部署。
