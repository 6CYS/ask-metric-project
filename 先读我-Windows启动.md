# Windows 本机快速启动

适用于从源码 ZIP 或 Git 检出启动当前 Pi 问数版本。先把整个目录解压到可写位置（例如 `D:\work\ask-metric`），再在项目根目录打开 PowerShell。脚本支持含空格的路径，不需要管理员权限。

## 1. 环境与首次安装

- Python 3.11～3.13，推荐 3.12，确保 `python --version` 指向实际 Python。
- Node.js 22.12+（22.x）或 24.x，包含 npm。
- 首次安装需联网下载 Python/npm 依赖；有 uv 时按 `backend-next/uv.lock` 安装，否则通过 pip 按 `pyproject.toml` 安装。建议提前安装 uv 以复用锁定版本。
- 可访问的 GoldenDB/MySQL 应用库、独立只读指标查询库及 Chat 模型服务。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-local.ps1 -Action Setup
```

可用 `-Python C:\Python312\python.exe` 指定 Python。Setup 安装后端、Agent、前端依赖并构建 Agent，只在配置不存在时复制模板，只在 JWT_SECRET 为空时生成随机密钥；不修改数据库、不创建账号、不覆盖已有配置。依赖安装失败时解决网络问题后重跑 Setup 即可。不要在服务运行时重装依赖。

## 2. 填写配置并准备账号

编辑 **`backend-next/.env`**：

| 配置 | 内容 |
| --- | --- |
| `APP_DATABASE_URL` | 已建好并完成应用迁移的 GoldenDB/MySQL 应用库，读写账号 |
| `QUERY_DATABASE_URL` | 已有业务指标库，独立只读账号 |
| `QUERY_DATABASE_DIALECT` 和 `SIT_*` | 与实际查询表结构匹配，详见[本地部署指南](docs/本地部署指南.md) |
| `JWT_SECRET` | Setup 已生成；保留本机值，不共享 |
| `MODEL_CHAT_BASE_URL`、`MODEL_CHAT_API_KEY` | 可访问的模型服务及本人获授权的密钥 |
| `NACOS_ENABLED`、`NACOS_CONFIG_ENABLED`、`SSO_ENABLED` | 本机直连均为 `false` |

同时核对 `backend-next/config/model-config.json` 的 Chat 模型名、请求路径、鉴权及额外参数。需要修改时复制到 `backend-next/.runtime/local-config/model-config.json`，并在 `.env` 的 `MODEL_CONFIG_PATH` 指向该本机副本。Embedding/Reranker 未提供时保持关闭。

编辑 **`agent-service/.env`**：填写 `AGENT_MODEL_BASE_URL`、`AGENT_MODEL_NAME`、`AGENT_MODEL_API_KEY`，核对 `AGENT_MODEL_AUTH_HEADER`、`AGENT_MODEL_AUTH_PREFIX`、`AGENT_MODEL_EXTRA_BODY` 与网关一致。默认模板为 DeepSeek 兼容接口；其他服务应以实际提供方参数为准。当前问数需要同时运行后端和 Agent。

真实配置、密钥、业务数据、现有会话和登录账号均不在分享包内。可复用获授权的测试应用库与账户；首次新建应用库须按[本地部署指南第 4～5 节](docs/本地部署指南.md#4-审核并初始化应用表)审核迁移、同步正式目录并创建账户。迁移不能建立外部业务指标表。脚本不会自动迁移或清空数据库。

创建独立本地账户时，在 `backend-next` 目录执行（替换尖括号内容，密码通过隐藏输入设置）：

```powershell
.\.venv\Scripts\python.exe scripts/create_local_user.py --username <登录名> --display-name <姓名> --org-code <已启用的真实机构编码> --role-code SYSTEM_ADMIN --config .env
```

没有默认账号密码。同名账户存在时此命令会重置其密码和会话，请先核对用户名。

## 3. 检查、启动与停止

```powershell
# 仅检查依赖和配置格式，不调用模型或数据库
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-local.ps1 -Action Check
# 后台启动三个服务并检查 HTTP 存活
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-local.ps1 -Action Start
# 查看此目录启动的进程
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-local.ps1 -Action Status
# 仅停止此目录启动且身份仍匹配的进程
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-local.ps1 -Action Stop
```

浏览器打开 **http://127.0.0.1:5173**，用准备好的账户登录。默认后端 8010、Agent 8020；端口被占用时不会停止其他服务。可自选三个不同端口，代理会自动对应：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-local.ps1 -Action Start -BackendPort 18110 -AgentPort 18120 -FrontendPort 15173
```

日志、进程记录和 Agent 会话位于 `.runtime/windows-local/`。Stop 不删除会话。环境文件或源码修改后，执行 Stop 后重新 Start；Agent 源码变更先到 `agent-service` 执行 `npm run build`。启动器不启用热重载。终端中已有同名环境变量优先于 `.env`，配置不生效时先核对环境变量。

## 4. 验收与常见问题

- **Check 通过**只表示依赖和基本配置格式正确，不能证明密钥有效、数据库可达。
- **HTTP 启动成功**只代表服务存活；后端 `/health/ready` 还检查查询预热及应用库就绪。未就绪时先看 `backend.err.log`，核对数据库连接、迁移、目录与模型预热。
- **业务验收**：登录后，选正式目录中的机构、指标和确有记录的日期完成查询，再在同一会话追问最高/最低或机构对比；确认明细与正文一致。真实模型查询可能产生调用费用。
- 模型 401/超时：检查后端与 Agent 两套模型配置、权限和网关参数，不能只改其中一处。
- 页面 502：检查三个服务是否存活及日志；模型名称和地址不应带工具接口后缀。
- 空结果：核对指定日期的业务记录、权限和数据湖映射，不把缺失记录当作零值。

此为 Windows 联网开发启动方案；未附 Windows 运行时和离线依赖。行内离线升级继续使用 [UAT 交接说明](docs/行内UAT部署交接与打包说明.md)及现有部署工具。
