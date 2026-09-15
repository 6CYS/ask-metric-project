# 无 Docker 离线打包部署

部署说明由发布人员与压缩包、校验文件并列交付。本页面向 Linux 原生离线安装；源码本地启动见 [本地部署指南](../../docs/本地部署指南.md)。现有库按已审核的 GoldenDB 迁移版本升级，不能仅沿用历史“无需迁移”的结论；数据湖映射见 [DATA_LAKE_DEPLOY.md](DATA_LAKE_DEPLOY.md)。

这一套部署方式面向不能安装 Docker、但可运行 Linux、Python、systemd 和 Nginx 的行内环境。
构建产物包含 Vue 静态文件、后端项目及其全部 Linux Python wheel、GoldenDB 独立迁移链、
安装/校验/回滚脚本，不包含 `.env`、数据库口令、模型密钥或业务数据。

当前支持的目标组合：

- Linux x86_64（`linux-x86_64`）；
- Linux ARM64/aarch64（`linux-aarch64`）；
- CPython 3.11、3.12 或 3.13，推荐 3.12。

行内安全策略禁止 Bash 脚本时，使用 `--payload-only` 构建不含运维 Shell 脚本或自动数据库
写入动作的载荷包。再传入锁定并校验过的 Python standalone 归档，即可
把 Python 解释器和预装依赖一并放入最终包；目标机无需预装 Python 3.12。详细步骤见
[`KYLIN_PAYLOAD_DEPLOY.md`](KYLIN_PAYLOAD_DEPLOY.md)。

离线包与目标 CPU 架构、glibc 基线和 Python 次版本绑定。普通模式要求目标机预装相同次版本
Python；自带运行时模式不使用目标机 Python，也不创建 `venv`。构建机需要 Python、Node.js 22.12+（22.x）或 24.x/npm
和可访问 PyPI 或内部 Python 镜像源；目标机不访问互联网。Python 依赖由 `constraints.txt`
固定版本；升级依赖时必须重新执行后端全量测试和目标架构的打包检查。

## 1. 构建离线包

在仓库根目录执行。版本号只能包含字母、数字、点、下划线和短横线：

```powershell
python deploy/package/build_bundle.py `
  --version 20260824.1 `
  --platform linux-x86_64 `
  --python-version 3.12
```

ARM64 目标机使用：

```powershell
python deploy/package/build_bundle.py `
  --version 20260824.1 `
  --platform linux-aarch64 `
  --python-version 3.12
```

麒麟 V10 x86_64 自带 Python 运行时包使用锁定文件中的归档和 SHA-256：

```powershell
python deploy/package/build_bundle.py `
  --version intranet-kylin-20260825-r2-selfcontained `
  --platform linux-x86_64 `
  --python-version 3.12 `
  --payload-only `
  --python-runtime-archive deploy/.cache/python-build-standalone/cpython-3.12.14+20260814-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz `
  --python-runtime-sha256 5acfa3e9ba26b51ae161c83aff278da915b590d22373a424b2ba55b8afe91fcc
```

产物位于 `deploy/artifacts/`：

```text
ask-metric-<version>-<platform>-py<python>.tar.gz
ask-metric-<version>-<platform>-py<python>.tar.gz.sha256
```

构建器会重新执行 `npm ci` 和前端生产构建，并强制使用 Nginx 同源 `/api` 路由，不继承
开发机 `.env.local` 中的后端地址。构建器也会扫描最终静态文件；只要发现 `localhost` 或
`127.0.0.1` 后端 URL 就立即失败。仅在已单独确认 `frontend-vue/dist/` 是本次源码生成的
情况下，才可用 `--skip-frontend-build` 跳过编译，产物扫描仍不会跳过。

## 2. 传输与校验

把 `.tar.gz` 和同名 `.sha256` 一起传到目标机，然后执行：

```bash
sha256sum -c ask-metric-20260824.1-linux-x86_64-py3.12.tar.gz.sha256
tar -xzf ask-metric-20260824.1-linux-x86_64-py3.12.tar.gz
cd ask-metric-20260824.1-linux-x86_64-py3.12
./ops/verify.sh
```

外层校验确认传输文件完整，`verify.sh` 校验包内每个文件。任一校验失败都不要继续安装。

## 3. 首次安装

默认安装位置如下：

```text
/opt/ask-metric/releases/<version>/   不可变版本目录
/opt/ask-metric/current               当前版本软链接
/etc/ask-metric/backend.env           跨版本保留的配置
/var/lib/ask-metric/runtime-config/    模型、提示词和 SQL 模板（跨版本保留）
/var/lib/ask-metric/                   其他跨版本运行数据和配置历史
/home/appuser/log/                     行内规范日志目录（物理目录，禁止软链接）
```

首次运行安装器会离线创建版本目录和配置模板，但检测到模板占位值后不会激活或启动（退出码 2 为预期结果）：

```bash
sudo ./ops/install.sh
sudo vi /etc/ask-metric/backend.env
# 完成下文的密钥、配置路径、权限核对后，再执行：
sudo ./ops/install.sh
```

必须配置两个不同用途的数据库账号：

- `APP_DATABASE_URL`：应用元数据、账号、会话和审计库的读写账号；
- `QUERY_DATABASE_URL`：指标业务库的只读账号，数据库侧也应强制只读权限。

URL 中的特殊字符必须做百分号编码。配置文件不得放入发布包或提交到 Git。安装器默认创建
`askmetric` 系统账号，安装并启动 `ask-metric-backend.service`，并写入
`/etc/nginx/conf.d/ask-metric-backend.conf`。如果行内已有统一反向代理或服务管理平台，可执行：

模型地址、路径、模型名及认证方式可在系统管理员的“智能配置”页面维护。首次安装会从发布包
初始化运行时配置，后续升级不会覆盖已有配置。要允许页面保存、回滚和连接测试，还需在
`backend.env` 中设置 `MODEL_ADMIN_WRITE_ENABLED=true` 与独立的 `MODEL_ADMIN_TOKEN`；各模型
密钥只保存在该环境文件中，不写入运行时 JSON。

```bash
./ops/install.sh \
  --install-root /data/ask-metric \
  --state-root /data/ask-metric-state \
  --config /data/ask-metric-config/backend.env \
  --python python3.12 \
  --http-port 8080 \
  --backend-port 8010 \
  --service-name ask-metric-goldendb-backend \
  --no-systemd --no-nginx
```

这种模式不会创建系统服务。完成下文配置后，在有读取权限的终端或行内部署平台中加载环境文件并启动：

```bash
set -a
. /data/ask-metric-config/backend.env
set +a
cd /data/ask-metric/current/backend
/data/ask-metric/current/venv/bin/python -m uvicorn ask_metric.main:app \
  --host 127.0.0.1 --port 8010 --no-access-log
```

### 首次配置必须补齐的步骤

第一次安装尚未创建 `current` 链接，生成密钥和加密配置时应使用已暂存版本：

```bash
# 在 sudo/root 运维终端执行；替换为本次 manifest.json 中的 release。
RELEASE_ROOT=/opt/ask-metric/releases/<本次版本>
umask 077
# 仅第一次创建，已有主密钥必须复用，不能在升级时重新生成。
test -f /etc/ask-metric/config-sm4.key || openssl rand -hex 16 > /etc/ask-metric/config-sm4.key
chown root:askmetric /etc/ask-metric/config-sm4.key
chmod 0640 /etc/ask-metric/config-sm4.key
"$RELEASE_ROOT/venv/bin/python" "$RELEASE_ROOT/backend/scripts/generate_sm2_keypair.py" \
  --output /etc/ask-metric/sm2-initial.env
"$RELEASE_ROOT/venv/bin/python" -m ask_metric encrypt-config \
  --key-file /etc/ask-metric/config-sm4.key
```

加密命令通过隐藏输入读取一个值，重复执行以加密数据库 URL、JWT、追问签名密钥、SM2 私钥及模型凭据；两个签名密钥须各自随机生成，不使用示例常量。可在上述 `umask 077` 环境中用 `openssl rand -hex 48 > /etc/ask-metric/jwt-initial.secret` 生成临时签名文件，并用另一个新文件生成追问签名值；不得覆盖已有密钥。SM2 私钥取新生成文件中的值；导入验证后按现场流程清理临时明文文件。已有部署不要再运行私钥生成命令。

环境模板必须补齐 `ASK_METRIC_CONFIG_SM4_KEY_FILE`、所有启用服务的配置和日志标识；不用 Nacos/SSO 时关闭相应开关，并移除未启用项残留的 `<...>` 占位值。Shell 运维脚本会 source 环境文件，含空格的值（如 `APP_NAME`）应加引号，不能把未经转义的真实密码写成 Shell 语句。

**目录区别：**解压包是 `backend/runtime/`，`install.sh` 安装后是 `current/backend/`。模板还被载荷部署共用，编辑 `/etc/ask-metric/backend.env` 时需按当前安装方式显式校正以下路径，不能机械照抄 `current/backend/runtime/`：

```dotenv
MODEL_CONFIG_PATH=/var/lib/ask-metric/runtime-config/model-config.json
PROMPT_CONFIG_PATH=/var/lib/ask-metric/runtime-config/prompts.json
SEMANTIC_CONFIG_PATH=/opt/ask-metric/current/backend/config/semantic-config.json
QUERY_TEMPLATE_CONFIG_PATH=/var/lib/ask-metric/runtime-config/query-templates.json
SQL_RESOURCE_DIR=/var/lib/ask-metric/runtime-config/sql
MODEL_SECRET_ENV_PATH=/etc/ask-metric/backend.env
CONFIG_HISTORY_DIR=/var/lib/ask-metric/config-history
TEST_CENTER_DATA_DIR=/var/lib/ask-metric/test-center
TEST_CENTER_BASELINE_PATH=/opt/ask-metric/current/backend/resources/testing/accuracy-baseline.json
```

自定义安装路径时对应替换。持久状态由服务账号写入；首次安装后核对权限：

```bash
sudo chown -R askmetric:askmetric /var/lib/ask-metric
sudo chown root:askmetric /etc/ask-metric/backend.env
sudo chmod 0640 /etc/ask-metric/backend.env
```

### 行内日志配置

生产配置必须启用 `LOG_FILE_ENABLED=true`，并将 `LOG_DIRECTORY` 设置为物理目录；规范默认值为
`/home/appuser/log`。应用分别写入 `app.log`、`summary.log` 和 `alert.log`，单文件默认达到
50MB或跨日时转储到日期目录，默认仅保留最近3天。安装器会拒绝把 `--log-root` 指向软链接，
并为 systemd 服务授予该目录写权限；自定义 `--log-root` 时必须同时修改 `LOG_DIRECTORY`。

`LOG_DATA_CENTER_ID` 和 `LOG_ZONE_ID` 必须替换为行方资源配置值。调用方可传递
`X-Global-Business-Track-No`、`X-Service-Call-Seq-No`、`X-Service-Code`、`X-Trace-ID`、
`X-Segment-ID`、`X-Span-ID` 和 `X-Parent-Span-ID`；缺失的流水与链路标识由后端生成并在响应头
返回。`APP_NODE_CODE`、`APP_IDC`、`APP_UNIT` 必须分别使用主机 `/etc/profile` 中的
`App_Node_Code`、`App_IDC`、`App_Unit`；确实取不到时才使用规范兜底值 `8888888`、`888`、`8`。
全局流水号和SpanID分别采用 `G`、`R` 开头的六段40位格式；上游合法值保持透传，每次模型或
SSO下游调用生成新的SpanID并记录 SUBSTART/SUBEND。系统管理员可通过
`PUT /api/v1/logging/level` 动态调整日志级别，无需重启应用。

## 4. 数据库迁移

安装和版本切换永远不会自动迁移数据库。先生成 SQL，提交审核：

```bash
sudo /opt/ask-metric/current/ops/migrate.sh \
  --sql /tmp/ask-metric-goldendb-migration.sql
```

确认目标是 `APP_DATABASE_URL` 对应的应用库、SQL 已审批并完成备份后，才显式执行：

```bash
sudo /opt/ask-metric/current/ops/migrate.sh --apply
```

脚本只使用 `alembic-goldendb.ini` 与 `alembic_goldendb/`。

迁移完成后，受限环境可通过 Python 运维入口检查三类数据源并同步目录：

```bash
python /opt/ask-metric/current/ops/intranet_deploy.py database-check \
  --config /etc/ask-metric/backend.env
python /opt/ask-metric/current/ops/intranet_deploy.py sync-catalogs \
  --config /etc/ask-metric/backend.env --dry-run
python /opt/ask-metric/current/ops/intranet_deploy.py sync-catalogs \
  --config /etc/ask-metric/backend.env
```

When replacing external-test catalogs for the first time, back up the GoldenDB
application schema and run the guarded replacement command. It first synchronizes
both authoritative lake catalogs and refuses cleanup when either result is empty or
has errors. It deletes application `metric_values`, removes unsynchronized metric and
organization terms, retains aliases for synchronized metric codes, and preserves
users/conversations/tasks/audit data. Test users on obsolete organization codes are
reassigned to the synchronized head-office code (default `000`):

```bash
python /opt/ask-metric/current/ops/intranet_deploy.py initialize-synchronized-catalogs \
  --config /etc/ask-metric/backend.env \
  --user-org-code 000 \
  --apply --confirm INITIALIZE_SYNCHRONIZED_CATALOGS
```

Use a different `--user-org-code` only after confirming that code exists in the
synchronized organization catalog. This command is for the one-time test-data
replacement, not the recurring catalog synchronization job.

升级时会合并缺失的查询模板和 SQL 文件，不覆盖已有人工模板。已有 `backend.env` 不会自动
改写，切换 SIT 数据湖前必须人工补齐并复核 `QUERY_DATABASE_DIALECT=inceptor`、目录连接和
`SIT_*` 配置。

### 首个登录账户

迁移、正式目录同步成功后，选择目录中已启用的机构编号创建管理员，密码使用交互输入：

```bash
sudo /opt/ask-metric/current/venv/bin/python \
  /opt/ask-metric/current/backend/scripts/create_local_user.py \
  --config /etc/ask-metric/backend.env \
  --username <登录名> --display-name <显示名> --org-code <有效机构编码> --role-code SYSTEM_ADMIN
```

同名账户会被更新并使原会话失效；不要在升级时重复创建已有管理员。无内置默认密码。

### 升级已有实例

保留旧 release、配置及数据库备份。新包校验后执行 `install.sh`，所有自定义安装根、状态目录、端口和服务名参数须与原实例一致。需要增量迁移时先完成 DBA 审核与执行，再验收新版本。

当前安装器使用 `systemctl enable --now`，对已经运行的服务不等同于重启；切换版本后需要显式执行：

```bash
sudo systemctl restart ask-metric-backend.service
sudo nginx -t
sudo systemctl reload nginx
```

使用独立端口如 `--http-port 18080` 可避免抢占已有 80 端口站点；同机多个实例还必须使用不同的服务名、后端端口、安装目录、配置、状态及日志目录。只修改 Web 端口不能实现全部隔离。

## 5. 验证和回滚

服务启动后检查存活和应用库就绪状态（默认后端端口 8010；自定义端口时向 healthcheck.sh 传入对应 URL）：

```bash
/opt/ask-metric/current/ops/healthcheck.sh
systemctl status ask-metric-backend.service
```

升级安装新版本时旧 release 不会被删除。默认回滚到最近的另一个版本：

```bash
sudo /opt/ask-metric/current/ops/rollback.sh
```

也可以指定版本：

```bash
sudo /opt/ask-metric/current/ops/rollback.sh --release 20260824.1
```

回滚只切换应用文件，不反向修改数据库。若新版本包含不可向后兼容的迁移，应在变更评审中
单独准备数据库回退方案。

## 安全边界

- 安装器不读取构建机的 `backend-next/.env`，也不把它复制进离线包；
- 安装器不自动运行 Alembic，数据库变更必须显式执行；
- `QUERY_DATABASE_URL` 必须使用数据库侧只读账号；
- 不要在真实行内库上运行开发测试；
- 本文维护原生部署；已有 [腾讯云 Compose 部署](../cloud-next/README.md) 是另一套依赖预置双库的编排，不应混用两者的目录与初始化命令。

旧归因原型已退出运行链，升级原试验环境须同步前后端并合并持久提示词；详见 [后端升级说明](../../backend-next/README.md#旧归因原型退出与升级)。已有数据库迁移链不回退。

## 启动初始化与就绪检查

后端启动即分批初始化指标目录向量。`/health` 返回 200 而 `/health/ready` 返回 503 时，
可访问 `/api/v1/query-readiness` 查看初始化状态和进度；初始化完成后才允许问数和启动测试。
失败时前端显示提示，后台每隔 30 秒自动重试。大目录需按实际模型吞吐等待，不要因初始化尚未完成
反复重启或自动回滚；用于进程存活检测的探针应访问 `/health`。缓存仍为进程内缓存，每个 worker
分别预热且重启后重建。容量、批次参数和故障说明见 [后端向量缓存说明](../../backend-next/README.md#指标目录内存向量缓存)。
