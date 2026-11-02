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

新安装生成的 `backend.env` 已包含 Inceptor、指标事实表、指标配置表和机构维表配置。查询 SQL
统一由发布包内 builder 生成，升级不再合并或加载 SQL 模板；现场旧文件保留供整包回退。
已有 `backend.env` 不会被覆盖，需要人工补充并复核全部 `SIT_*` 表名和字段映射。
示例值对应当前测试湖，生产表名或字段名变化时只修改 `backend.env`，无需修改 SQL/Python。
行内必须保持 `QUERY_DATABASE_DIALECT=inceptor`；builder 的 MySQL 方言只用于采用
`metric_values` 表结构的外网/本地环境，不会被该运行模式选中。

应用库迁移审批并执行后，先进行只读连接检查和目录同步预演：

```text
python intranet_deploy.py database-check --config /etc/ask-metric/backend.env
python intranet_deploy.py sync-catalogs --config /etc/ask-metric/backend.env --dry-run
```

确认指标、机构数量及错误数后再正式同步：

```text
python intranet_deploy.py sync-catalogs --config /etc/ask-metric/backend.env
```

测试库首次切换时，如需清除外网模拟指标值、模拟指标目录和模拟机构目录，应先完成 GoldenDB
备份，再执行以下受保护命令。命令会先同步真实目录，任一目录为空或存在错误时拒绝清理；测试
用户、会话、任务和审计数据会保留，模拟机构下的测试用户统一调整到已同步的 `000` 机构：

```text
python intranet_deploy.py initialize-synchronized-catalogs --config /etc/ask-metric/backend.env --user-org-code 000 --apply --confirm INITIALIZE_SYNCHRONIZED_CATALOGS
```

该命令只在首次替换模拟数据时执行一次；后续定时任务继续使用 `sync-catalogs`。

机构同步范围由当前 `SIT_ORG_CORPORATION_CODE_*`、`SIT_ORG_*_HIER_CODE` 与 `SIT_ORG_EXPECTED_COUNT` 配置控制，具体字段以 `backend-next/.env.example` 和数据湖映射说明为准。数据湖连接账号必须保持只读，目录同步只写应用库。
