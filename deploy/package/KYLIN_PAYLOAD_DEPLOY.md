# 麒麟 V10 自带 Python 离线部署

适用于行内 Kylin Linux V10 x86_64、glibc 2.28、不能使用 Docker、不能在线安装 Python、
不能执行运维 Shell 脚本且普通账号无 `sudo` 的环境。

最终发布包包含：

- CPython 3.12.14 解释器、标准库及 OpenSSL；
- 预装完成的 Linux x86_64 后端依赖，不需要 `pip install` 或 `venv`；
- 后端 wheel、GoldenDB 迁移链、配置资源和 Python 运维程序；
- 已生产构建并固定为同源 `/api` 的 Vue 前端；
- 外层和包内两级 SHA-256 校验。

不包含数据库密码、模型密钥、业务数据、演示数据加载器或自动数据库写入动作。目标机不使用
系统 Python 3.7，不执行 `bash -c`、`/dev/tcp`、`nc`、`nohup` 或任何运维 `.sh`。

## 外部构建

先按 [`python-runtime-lock.json`](python-runtime-lock.json) 下载 Python standalone 归档并核对
SHA-256，再在仓库根目录执行：

```powershell
python deploy/package/build_bundle.py `
  --version intranet-kylin-20260825-r2-selfcontained `
  --platform linux-x86_64 `
  --python-version 3.12 `
  --payload-only `
  --python-runtime-archive deploy/.cache/python-build-standalone/cpython-3.12.14+20260814-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz `
  --python-runtime-sha256 5acfa3e9ba26b51ae161c83aff278da915b590d22373a424b2ba55b8afe91fcc
```

构建器会强制核对 Python 运行时哈希、重新生成后端 wheelhouse、把依赖预装到自带运行时中，
并检查前端不存在 `localhost` 或 `127.0.0.1` 后端地址。

## 发布物

```text
deploy/artifacts/ask-metric-intranet-kylin-20260825-r2-selfcontained-linux-x86_64-py3.12.tar.gz
deploy/artifacts/ask-metric-intranet-kylin-20260825-r2-selfcontained-linux-x86_64-py3.12.tar.gz.sha256
```

运行配置与数据库边界见 [原生部署说明](README.md) 和 [数据湖映射说明](DATA_LAKE_DEPLOY.md)。此模式使用解压包中的自带 Python 与 `backend/runtime/`，不能套用普通安装的 `current/venv` 路径；发布人员须按目标机路径补充启动命令。

## 数据边界

同事准备的 PostgreSQL 测试数据迁移脚本独立审批和传输，本包不会执行它。业务数据进入 QUERY
数据库后，运行时必须改用数据库侧只读账号。APP 数据库的账号、组织、会话和审计结构先由本包
生成离线 SQL，只有 DBA 确认目标为空、完成备份并批准后才允许应用；如果数据迁移脚本已经创建
APP 表，则不得直接运行基线迁移。

## Nginx 与端口边界

后端默认只绑定 `127.0.0.1:8010`。行内现有 Nginx 继续使用 80，由管理员添加独立
`server_name` 并把 `/api/` 代理到后端；不新建第二个 Nginx。GoldenDB 的 8885 仅作为出站连接
目标，应用不会监听或修改该端口。

## SIT 数据湖配置与目录同步

新安装生成的 `backend.env` 已包含 Inceptor、指标事实表、指标配置表和机构维表配置。升级已有
安装时，运维工具会把缺失的 Inceptor 模板和 SQL 文件合并到运行目录，但不会覆盖已有的人工
模板；已有 `backend.env` 也不会被覆盖，需要人工补充并复核全部 `SIT_*` 表名和字段映射。
示例值对应当前测试湖，生产表名或字段名变化时只修改 `backend.env`，无需修改 SQL/Python。
行内必须保持 `QUERY_DATABASE_DIALECT=inceptor`；配置文件中同时存在的 MySQL 模板只用于
外网/本地回退，不会被该运行模式选中。

应用库迁移审批并执行后，按 [主数据、可选别名和模型验收](CATALOG_AND_MODELS.md) 先检查模型与数据源，再独立同步主数据。该流程的 `PY` 必须使用自带 Python 的绝对路径。

`sync_catalog_data.py` 默认预览，机构须显式指定审核快照日期，指标使用已确认单位映射；正式同步须追加 `--apply`。指标和机构别名通过 `sync_catalog_aliases.py` 单独预览与补录，不是启动前置条件。普通部署不得执行 `initialize-synchronized-catalogs` 清理主数据。

内网模型配置使用 `response_format="json_object"`、`send_response_format=false`，请求不发送 `response_format`，仍携带 `chat_template_kwargs: {"enable_thinking":false}`。检查不得因发送开关为 false 失败；`check_models.py --live` 校验正文 JSON 和意图结构通过后，再验收正式名称问数。

机构同步范围由当前 `SIT_ORG_CORPORATION_CODE_*`、`SIT_ORG_*_HIER_CODE` 与 `SIT_ORG_EXPECTED_COUNT` 配置控制，具体字段以 `backend-next/.env.example` 和数据湖映射说明为准。数据湖连接账号必须保持只读，目录同步只写应用库。
