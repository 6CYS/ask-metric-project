# Ask Metric 行内 UAT 部署交接与打包说明

更新日期：2026-10-20。用途：交给新窗口中的 Codex 或部署同事，依据本文件准备与目标源码对应的离线升级包，并用少量命令完成现有行内环境升级。

**已验证的现场组合是：`20261019-1721063` 升级包 + 工具选择兼容补丁。用户已于 2026-10-20 确认应用补丁后部署成功。后续完整升级包应内置两者的必要适配，不再让部署人员手改 JavaScript 或单独补打旧补丁。**

本文件保存可独立交接的环境事实、适配代码、打包与验收要求，以及已用过的脚本模板。它适用于现有两机、普通用户、本地配置、`run.sh` 管理的 UAT 升级。首次安装新服务器、接入 Nacos/SSO、数据库结构升级和切换服务管理器，应单独核对条件，不能把本次成功结论直接套用。

## 1. 给下一位 Codex 的任务

将本文件交给 Codex，可以直接附上下面这段话：

> 请按这份说明，为当前项目准备行内 UAT 离线升级包。先核对实际仓库、目标提交、当前改动和部署入口；保留开发区未交付功能，不覆盖或重置。若本轮已指定目标版本，按指定版本构建；未指定时先报告当前 HEAD 与未提交功能范围，仅确认需要交付的源码版本，不再重复询问文档中已明确的环境信息。请将 accessKey SDK 鉴权和 tool_choice=auto 兼容适配集成到成包源码，保留现场配置、SM4 密钥、账号、权限与会话。完成构建、离线安装及升级/回退演练后，交付带 SHA-256 的前后端包、配套升级脚本、源码清单和每台机器三条部署命令。没有实际执行的验证明确列出，不把旧版测试结果当成本次结果。遵循当前工作区适用的 AGENTS.md 和用户最新要求。

**输入条件：**Codex 还需要能读取待发布的源码仓库和构建依赖。这份文档不能替代源码、Node 二进制、Python wheel 或服务器私有配置。配置和密钥保留在服务器，不需要发给新窗口或同事。构建资产缺失时，优先从可信旧包提取，或在允许联网的构建环境按锁定版本重新准备并验证；不能让行内服务器临时联网补依赖。

本文件附录含关键运维脚本模板与已验证约束，其他机器没有原聊天、旧 worktree 或 `local-artifacts/` 时，也能据此重建工具。模板中与日期、版本、源码结构有关的部分必须按本次目标适配并重新验证。

## 2. 给部署人员的简短操作

以下是**未来已集成兼容修复的完整升级包应提供的操作入口**。打包人员必须先完成第 5～9 节，再把与本次版本配套的文件交给部署人员；不能只把历史脚本换个文件名就用于新版本。

安排维护时间，结束在途问数。先在本机解压交付 ZIP；上传对应节点的三个文件，不在旧 `~/ws` 内直接解压覆盖 `.tgz`。

### 2.1 先升级后端：77.16.60.204

上传 `back.tgz`、`back.tgz.sha256`、`up.py` 至后端 `~/ws`，使用原 `appuser`：

```sh
cd ~/ws
venv/bin/python up.py check
venv/bin/python up.py apply
```

应看到后端、Agent 健康检查均 `HTTP 200`，以及 `UPGRADE OK`。`check` 失败时先保留输出排查；它不应停止当前服务。旁路安装/配置/数据库检查失败，也应发生在停服前。

### 2.2 再升级前端：77.6.79.36

上传 `front.tgz`、`front.tgz.sha256`、`front-up.sh` 至前端 `~/ws`：

```sh
cd ~/ws
sh front-up.sh check
sh front-up.sh apply
```

应看到 Nginx 配置检查通过及 `UPGRADE OK`。保持现有站点配置、代理和用户态 Nginx；升级脚本保留旧 hash 资源，减少已打开页面加载旧资源失败。

### 2.3 浏览器验收

打开 `http://77.6.79.36:8090/chat`，刷新并用现有账号登录：

1. 新建会话发送“你好”，确认模型能够正常响应。
2. 查询有权限、已启用机构的已知日期与指标，核对工具返回值和最终答案。
3. 连续测试改日期、改机构、增加指标、澄清后继续；使用同一前置会话和同一问题重复数次，分别记录成功与失败。
4. 刷新恢复会话、查看旧历史。此版含业务状态协议升级，旧协议会话按实际只读规则处理；不能承诺所有旧会话可继续追问。

健康检查通过、模型响应成功、真实问数正确、多轮稳定，是四个不同的验收层次。

### 2.4 回退

两台都已更新时，先在前端执行：

```sh
cd ~/ws
sh front-up.sh rollback
```

再在后端执行：

```sh
cd ~/ws
venv/bin/python up.py rollback
```

脚本应保留 `~/ws-before-<本次版本>`，并将失败版本留在 `~/ws-failed-<本次版本>`。回退恢复程序；不回滚共享数据库、用户账号、升级后产生的会话或其他人员的新配置。必须事先核对新旧状态协议与数据库结构的兼容性。

### 2.5 日常启停与服务器重启后的人工恢复

后端仍使用：

```sh
cd ~/ws
sh run.sh stop
sh run.sh start
sh run.sh check
```

前端使用 `sh run.sh front-check`、`sh run.sh front-start`、`sh run.sh front-stop`。**当前尚无现场证据证明开机自启、异常自动重启已安装；服务器重启后仍可能需要人工恢复。自动恢复实施要求见第 11 节。**

## 3. 当前现场事实

| 项目 | 已知值与要求 |
| --- | --- |
| 部署模式 | 两机、单实例、普通 `appuser`，目标机不使用 Docker |
| 前端 | `77.6.79.36:8090`，已有独立用户态 Nginx |
| 后端 | `77.16.60.204:8010`，Python / FastAPI |
| Agent | `77.16.60.204:8020`，包内 Node / TypeScript 编译产物 |
| 程序路径 | 两台各自的 `/home/appuser/ws`，现有脚本要求物理目录，不能直接改成软链接 |
| 持久根目录 | 两台各自的 `/home/appuser/ask-metric-pi` |
| 后端配置 | `~/ask-metric-pi/config/backend.env` |
| Agent 配置 | `~/ask-metric-pi/config/agent.env` |
| SM4 主密钥引用 | 历史实际路径 `/home/appuser/ask-metric-config-uat/config-sm4-uat.key`；最终以原配置 `ASK_METRIC_CONFIG_SM4_KEY_FILE` 为准 |
| 模型 | 行内 `DeepSeek-V4-Flash`，保留实际大小写与连字符 |
| Agent 模型 base URL | `http://77.6.65.47:8099/api/model/8ffa3e9e-1f76-4b77-acd5-85283eb1c3b7` |
| Chat 完整请求路径 | 在上述 base URL 后接 `/chat/completions`；不能在 SDK base URL 内重复追加 |
| 模型认证 | `accessKey` 自定义请求头，前缀为空；密钥使用已有 `ENC[SM4:v1:...]` 密文 |
| 工具选择 | 当前已修复环境显式使用 `AGENT_MODEL_TOOL_CHOICE_POLICY="auto"` |
| 运行时 | Linux x86_64、CPython 3.12、包内 Node 22.23.2；Node 锁文件要求 glibc 至少 2.28，发包前核对目标实际兼容性 |
| 配置中心 | 当前成功路径为本地配置；`NACOS_CONFIG_ENABLED=false`、`NACOS_ENABLED=false` |
| 原 Gateway / 正式 SSO | 未纳入本次成功验收，不自动启用或切换 |
| 管理方式 | 用户明确确认仍为 `sh run.sh start/stop`，PID 标记在 `~/ask-metric-pi/run/` |

请求链路：浏览器 → 前端 Nginx → `/api/` 到后端 8010、`/agent-api/` 到 Agent 8020 → 行内模型/后端治理接口 → 业务数据源。SSE 代理配置须保留关闭缓冲等已有设置。

历史文档中的 Qwen 地址、首次 Nacos prepare/publish 流程、系统级 `/opt` 安装路径或 Docker 启动方式，不能取代这里已验证的当前部署路径。现场状态若已变更，先核对差异，再调整包与操作说明。

## 4. 必须保留的内容

- 原 `backend.env`、`agent.env`、模型/提示词/语义运行时 JSON 及其路径；某些本地 JSON 位于 `config/nacos/`，目录名不等于正在使用 Nacos。
- 模型地址、模型名、认证头/前缀、API Key 密文、SM4 主密钥及读取权限。不得为升级重新生成主密钥或把密文改成明文。
- 应用数据库、业务数据源、现有用户及密码摘要、用户机构归属、启用状态与权限。
- `~/ask-metric-pi/state/agent/` 中的会话及其他原持久目录；旧会话协议的续问限制按产品实际行为说明。
- 原 Nginx 配置、8090 站点、现有代理、用户日志/PID/临时目录，以及与本实例无关的服务。
- 六项实际机构范围及其升级快照。原 `backend.env` 中显式同名值仍优先。

发布包中不得包含现场 `.env`、API Key、SM4 主密钥、JWT/数据库秘密、真实账号表、日志和业务数据。清单可以记录文件相对路径与哈希；不要采集秘密值。服务器上的受控备份也不要作为打包输入上传。

如果必须补充工具选择开关，只允许白名单修改这一非敏感项，并逐项证明其他配置值未变；已有 `auto` 应保留。不要用模板整份覆盖 env，也不要顺手重设超时、Token、上下文预算、Embedding/Reranker 或机构范围。

## 5. Codex 准备源码与必要适配

### 5.1 固定来源，隔离构建

先读取项目 AGENTS.md、README、当前部署代码与本文件。核对 `git status`、HEAD、实际远程 URL 和用户指定提交；目标分支名会变化，最终来源记录完整 commit SHA。

10 月 19 日现场包基线为 `17210638777beab522006e8921e024ff957838d9`，当时对应同事的 `customer/yubo-dev`。它是历史依据，不是未来每次必须发布的目标。

当时本地开发区另有经营概览、通用分析等未交付功能。**只交付同事版本时，独立 worktree/checkout 从目标提交构建，再补必要部署适配；不能在混合开发目录 reset、stash 丢改动，或把所有未提交功能一起打入。**若用户明确要交付本地功能，先形成可核对的文件/代码块清单，再纳入独立构建来源。

构建清单记录：基础提交、实际补丁/差异、涉及文件 SHA-256、依赖锁定、构建命令、兼容项和测试结果。存在补丁时不能只写基础 commit 就声称产物与该提交完全相同。保留本次源码差异或快照，保证换机器可重建。

### 5.2 accessKey 与 SDK 认证

源码入口：`agent-service/src/models.ts` 的 `createAskMetricModels`。现场曾报 `No API key for provider: ask-metric`，只设置自定义请求头不够，原生 SDK 还要求 `apiKey`。

已验证结构如下，按目标 SDK 的实际类型与调用链合入；变量沿用现有代码：

```ts
resolve: async () => ({
  auth: apiKey
    ? {apiKey, headers: {Authorization: null, [authHeader]: headerValue}}
    : {},
}),
```

保留 `authHeader`、`headerValue` 对现场配置的处理。删除 SDK 多余默认 Bearer 头后，再设置配置所需认证头；不能把凭据写死。验证自定义 accessKey、标准 Bearer、自定义前缀三类行为，不能只搜索字符串。

### 5.3 工具选择兼容：完整包必须包含

10 月 19 日新包部署与健康检查均成功，但“你好”立即失败，真实会话错误为：

```text
Failed to compile structural_tag grammar
Invalid structural tag error: Only the last element in a sequence can be unlimited
```

这是推理服务结构化输出语法编译阶段的具体失败。已交付基线会设置 `tool_choice=required` 或指定函数；仅在 Postman 测一个小工具成功，不能证明完整业务工具集可用。现场应用下面的兼容开关后，用户确认部署成功。

`agent-service/src/config.ts` 的配置类型增加：

```ts
modelToolChoicePolicy?: "native" | "auto";
```

`loadConfig` 读取、验证并返回：

```ts
const modelToolChoicePolicy = env.AGENT_MODEL_TOOL_CHOICE_POLICY?.trim() || "native";
if (!["native", "auto"].includes(modelToolChoicePolicy)) {
  throw new Error("AGENT_MODEL_TOOL_CHOICE_POLICY 必须为 native 或 auto");
}
// 在返回的配置对象中加入：
// modelToolChoicePolicy: modelToolChoicePolicy as "native" | "auto",
```

`agent-service/src/harnessHost.ts` 中，在所有工具裁剪与强制工具选择分支之后、最终诊断和实际 HTTP 发出之前，调整最终 payload：

```ts
if (this.config.modelToolChoicePolicy === "auto"
  && Array.isArray(decision.payload.tools)
  && decision.payload.tools.length
  && decision.payload.tool_choice !== "none") {
  decision.payload = {...decision.payload, tool_choice: "auto"};
}
```

默认 `native` 保持其他环境行为；本行内实例显式 `auto`。保留完整工具 Schema、参数校验、执行权限、业务状态和答案证据守卫，保留 `none` 与无工具终态。不能靠删除 tools、禁用校验或允许模型编造数据来让请求“成功”。

目标源码可能已包含该适配，应按调用链核对并测试，不重复打补丁或全局替换。若 SDK/Host 结构变化，上述是行为要求，不能机械套入旧行号。

**成包要求：**重新编译 Agent，归档中的 `dist/config.js`、`dist/harnessHost.js` 必须来自已修复源码；现场有效开关为 `auto`。当前补丁后的现场已有该值；旧环境缺失时，升级器需受控补充该项、备份并验证，不静默改写其他值。如果现场显式指定其他策略，先报告差异。

### 5.4 Schema 与历史错误不能混为一谈

更早的 Qwen/旧协议曾报 `Unsupported JSON Schema structure` / Outlines，原因是任意 JSON 字段缺少明确类型。旧解决方法为六类 JSON 值的 `anyOf`；这与上面的 structural_tag 错误不同。

新版本必须检查**实际最终发送的工具 Schema**及多轮历史消息。不要把旧协议的 `Type.Unknown` sed 补丁重复施加到新 semantic_v2 协议，更不能在 `node_modules` 或整份 JS 中盲目替换。

### 5.5 skills、运行资源与依赖

- `deploy/package/build_bundle.py` 的 Agent 暂存构建路径必须复制 `agent-service/skills/`，随后构建、裁剪生产依赖并把 skills 一并入包；曾遗漏复制，导致编译后打包失败。
- 后端从干净的最小源码副本构建 wheel，不能复用开发目录残留 `build/` 导致混入已删除或未交付模块。
- 后端 runtime 要包含当前版本实际依赖的 config、迁移资源及 scripts；创建用户脚本的实际包内路径为 `backend/runtime/scripts/create_local_user.py`，不是 `backend/scripts/`。
- 构建产物不夹带验证脚本、测试夹具、开发 `.env`、缓存或其他任务的新增功能；生产依赖按当前实际调用关系保留。

## 6. 离线构建与交付格式

### 6.1 可用构建入口

标准打包器为 `deploy/package/build_bundle.py`，用于前端编译、Agent dist/生产依赖/skills、后端 wheel 与目标依赖、Node runtime 和校验清单。普通 `/opt` 安装产物不能直接作为现有 `~/ws` 升级器，需要组装为下述两机角色包并替换为本地 UAT 运维入口。

按实际源码检查以下入口，使用项目锁文件：

```text
agent-service: npm ci → npm run typecheck → npm run build → npm test
frontend-vue: npm ci → npm run typecheck → npm run build
backend-next: python -m pytest（按该版本 pyproject.toml 的测试目录）
```

这些是构建机检查，不是要求部署人员在行内手敲执行。测试后仅在打包暂存副本裁剪生产依赖，不破坏开发区测试依赖。

前端构建使用同源路由：构建进程显式设置 `VITE_BACKEND_NEXT_BASE_URL` 为空；不得把本机 `.env.local` 的 localhost/127.0.0.1 API 地址写进静态包。检查实际产物。

### 6.2 Python 与 Node

现场组合是 CPython 3.12 / Linux x86_64。Python 原生 wheel 必须匹配目标架构、解释器 ABI 与 glibc；不能将 Windows wheel、Windows venv 或任意开发机 node_modules 当作 Linux 成包依赖。

优先沿用附录 D 的已验证依赖集合，包含 `protobuf==6.33.6`；历史源码中的 `7.36.0` 与已缓存集合不配套。`gmssl`、`pycryptodomex`、`simpleeval`、`sqlglot` 及 HanLP 轻量 Trie 依赖不能遗漏。新应用依赖与旧锁不兼容时，重新生成配套 wheelhouse 并测试，不能盲目锁旧版本。

Linux 新虚拟环境中实际执行：

```sh
venv/bin/python -m pip install --no-index --find-links backend/wheels --constraint ops/constraints.txt ask-metric-backend-next uvloop
venv/bin/python -m pip check
```

构建机可用 Docker/临时 Linux 做上述验证；行内运行本身不依赖 Docker。首次离线安装也要确认 venv 所需 pip/ensurepip 可用。

已验证包内 Node：`node-v22.23.2-linux-x64.tar.gz`，SHA-256：

```text
b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a
```

锁文件 `deploy/package/node-runtime-lock.json` 记录来源与架构。解包到 `node-runtime/node/bin/node`。Windows 打包时保留 Linux 符号链接语义与可执行权限，不能把符号链接展开成错误内容。更换 Node 时重新核对锁文件、glibc 和 Linux 验证。

### 6.3 两个角色包

```text
交付 ZIP/
  back.tgz                 # 根层级为下面的后端内容，不能多包一层目录
  back.tgz.sha256
  up.py
  front.tgz                # 根层级为下面的前端内容
  front.tgz.sha256
  front-up.sh
  升级说明.md              # 本次版本、上传位置、六条操作、回退与未验证项
  source-manifest.json     # 基础提交、差异、兼容项、运行时、校验和

back.tgz/
  backend/wheels/
  backend/runtime/
  agent-service/dist/
  agent-service/skills/
  agent-service/node_modules/   # 仅经核对的生产依赖
  agent-service/package.json
  node-runtime/node/
  ops/uat_deploy.py
  ops/constraints.txt
  run.sh
  up.py
  manifest.json
  checksums.sha256

front.tgz/
  frontend/index.html
  frontend/assets/
  run.sh
  front-up.sh
  manifest.json
  checksums.sha256
```

外层 ZIP 和两个 tgz 都有 SHA-256。每个包内逐文件校验，校验文件与 Shell 脚本统一 UTF-8/LF；校验行格式为 `SHA256` + 两空格 + 相对文件名。任何字节修改后都重算内外清单。

**脚本必须同时出现在外层与新角色包里。**否则升级后切换到新 `~/ws`，会找不到回退入口。发布版本标识必须与 manifest、升级脚本、备份/暂存/失败目录及 marker 一致，且不复用历史版本号。

最终包应包含工具选择修复的代码和配置生效路径，不要求额外上传 `model-fix.py`。旧补丁只识别特定版本及文件哈希，不能作为未来通用升级器。

## 7. 升级器的实现契约

附录 A～C 是历史已验证模板。未来 Codex 按本节适配后验证，而不是原样重复运行日期写死的脚本。

### 7.1 后端旁路安装与切换

1. 确认当前普通用户、物理 `~/ws`、本地配置模式、Python/Node/架构、端口和原 PID 标记；确认没有 systemd/其他守护器同时拉起旧程序。
2. 验证外部 SHA、磁盘余量、安全归档路径及链接。已有同版本暂存、备份、失败目录或 marker 时拒绝继续；不要为通过检查删除历史证据。
3. 读取**旧程序启动时实际使用的配置与机构范围**，在停服前验证可获得六个值。
4. 在 `~/ws-next-<版本>` 解包，检查包内逐文件 SHA，创建新 Python 3.12 venv，离线安装、`pip check`。
5. 使用新版本真实配置解析器校验后端 JSON/Agent/SM4 密文，不打印解密值。工具选择必须确实生效；健康检查不发模型请求。
6. 只读检查应用库表/列及 `SELECT 1`。目标版本迁移目录有变化时先分析增量及回退，缺表缺列就停在旧服务仍运行的阶段，由 DBA 流程处理。
7. 停止旧 Agent、后端；核对 PID 所属 UID 与 `/proc/<pid>/cmdline` 的 `command_sha256`，只 SIGTERM 本包进程。标记不匹配时拒绝误杀。
8. 旧 `ws` 整份改名备份，再把旁路新目录改为 `ws`；新程序用原外置配置启动，检查 8010/8020 健康。
9. 切换后启动失败时尝试停止本次新进程、恢复旧程序、恢复旧健康；保留失败目录和日志。恢复失败要明确报告，不能只打印“已回退”。

预装后目录移动会改变 venv 的绝对路径。服务启动使用 `venv/bin/python -m ...`，不依赖暂存路径写入的控制台 shebang；Linux 演练中验证移动后实际可运行。

### 7.2 机构范围的续版继承：必须处理

已部署版本把六项旧设置保存到：

```text
~/ask-metric-pi/config/upgrade-20261019-scope.json
```

原 `backend.env` 未必显式包含这些值；`ops/uat_deploy.py.environment("backend")` 会先加载范围快照，再由 env 同名项覆盖。**下一次升级不能只读取 backend.env 后调用 Settings，否则可能遗漏仍在快照中生效的必填机构范围。**

下一版升级器应通过旧版本实际配置加载入口（例如在独立子进程加载旧 `ops/uat_deploy.py` 的 `environment("backend")`），合并快照，再调用旧版 `get_settings()`。显式设定旧 `AM_RELEASE_DIR` / `AM_UAT_ROOT`，避免继承其他构建环境路径。旧部署没有该入口时，检查并支持其已知旧配置方式；不要假定任意 Python helper 都兼容。

保持“原 backend.env 显式值优先”；只允许六项范围键。新旧快照名称若变化，写入与新进程读取必须成对适配，且先证明含义和值相同。重复发布若遇到不同快照，拒绝静默覆盖。

以下仅是 10 月 19 日现场记录，供比对，不得当成所有机构环境的默认值：

| 键 | 当时值 |
| --- | --- |
| SIT_ORG_CORPORATION_CODE_MAX | 134 |
| SIT_ORG_EXCLUDED_CORPORATION_CODE | 086 |
| SIT_ORG_HEAD_OFFICE_CORPORATION_CODE | 000 |
| SIT_ORG_LEGAL_ENTITY_HIER_CODE | 3 |
| SIT_ORG_HEAD_OFFICE_HIER_CODE | 1 |
| SIT_ORG_EXPECTED_COUNT | 61 |

### 7.3 配置与数据不随程序替换

按 dotenv 语义读取，`interpolate=False`；不能把含密码/密文的 env 当作 Shell source 执行。SM4 继续读取原外置主密钥。模型/提示词/语义文件按配置实际路径解析，不从包模板覆盖。

当前升级不运行 prepare、publish、配置同步、目录同步、用户重建、数据初始化或自动迁移。附录历史 helper 的 `sql` 是只读结构检查别名，不生成 SQL；不能与早期首次部署工具的 `sql` 混淆。真正迁移使用目标版本明确的迁移链并走 DBA 流程。

受控增加非敏感配置时，应在服务器私有目录备份并校验其余值未变，失败只回退本次变更；回退前检查后续编辑，不能覆盖他人新改动。数据库和会话状态共享，程序备份不等于数据备份。

### 7.4 前端

保留 `/home/appuser/ws/frontend` 这个静态路径和原 Nginx 实例；检查、启动、停止统一带用户参数：

```sh
nginx -e "$HOME/ask-metric-pi/logs/nginx-error.log" -p "$HOME/ask-metric-pi/" -c "$HOME/ask-metric-pi/nginx.conf" -t
```

不能用系统默认 Nginx 配置/日志目录处理本实例。旁路解包并校验，保留旧 assets，切换后检查 8090；失败恢复原静态目录。不要混入默认连接本机后端的开发构建。

## 8. 发包前必须完成的验证

| 检查 | 最低证据 |
| --- | --- |
| 源码来源 | 基础 SHA、实际差异、应用 wheel/Agent dist/前端资源与目标源码对应；未交付功能未混入 |
| 类型与构建 | 当前版本 Agent/前端相关 typecheck、build；后端 wheel 可导入 |
| 模型适配回归 | native/auto/非法值；自定义认证；auto 后完整 Schema 不变；none 保留；非法工具参数和无证据答案仍被拒绝 |
| Linux 离线运行 | Python 3.12 离线 pip install + pip check，包内 Node 可执行，真实配置解析器可读取合成 SM4 密文 |
| 升级控制流 | 普通用户旧包 → 新包 → 健康 → stop/start → 手动回退；错误校验在停服前拒绝；新 Agent 启动失败可恢复旧版 |
| 续版范围继承 | 旧 env 缺六项但旧快照有值，升级仍正确；env 显式值优先；冲突或不完整时拒绝 |
| 配置和持久化 | 合成账号/机构/历史哨兵及主密钥、其他 env 值不变；配置回退不覆盖后续编辑 |
| 前端 | 普通用户 Nginx 配置检查、首页/旧 assets 访问、升级/回退；原配置不变 |
| 归档与安全 | 逐文件 SHA、LF、安全路径/链接/权限；无 env/主密钥/真实数据；脚本与版本、两个角色匹配 |
| 本次差异 | Git 工作树执行 git diff --check；未跟踪文档另检查空白与链接 |

优先在临时 Linux 环境用随机密钥、合成配置、专用可丢弃数据库完成控制流验证；这不能冒充真实 GoldenDB、真实模型或行内稳定性验收。部署前收集私有配置的哈希，在服务器本地比较即可，不回传秘密值。

历史证据：10 月 19 日 Agent 1,238 项断言经分批复核通过，原始全量曾有计时/挂载问题；后端覆盖 559 项；工具选择补丁专项 27 项通过，且 Linux 升级/重复应用/回退演练通过。**这些数字只描述历史，不可直接填到未来版本的测试报告。**

本文件整理时没有重新运行模型、数据库或部署；现场成功信息来自用户 10 月 20 日反馈，完整多轮稳定性、服务器自动恢复仍需专项验收。

## 9. 最终交付检查单

- 交付一个完整 ZIP 与同名 `.sha256`；每台三文件，六条主操作；不让用户手敲大段程序。
- 完整包中已合入 accessKey 与 tool_choice=auto，配置生效路径已验证，不把旧 `model-fix.py` 当成通用安装步骤。
- 说明准确的上传位置、操作用户、顺序、成功提示、备份位置、回退命令和适用前提。
- `source-manifest.json` 区分基础提交与部署补丁；保存可重建差异及依赖锁。版本号唯一，所有入口一致。
- 报告本次实际验证及未验证项。明确数据库/协议兼容和自动恢复状态；保留旧目录到业务验收结束。
- 本地构建产物和版本专用辅助工具放 `local-artifacts/`；不因生成了部署包就自动提交或推送源码。

## 10. 短命令排查与已知坑

后端先检查服务：

```sh
cd ~/ws
sh run.sh check
```

必要时分别查看少量日志；共享前脱敏：

```sh
tail -n 20 ~/ask-metric-pi/logs/agent-console.log
tail -n 20 ~/ask-metric-pi/logs/backend-console.log
```

重现一次失败后，在**同一终端**定位最新会话并提取错误摘要：

```sh
cd ~/ask-metric-pi/state/agent
p=$(ls -t native-v1/*/*/*.jsonl | head -1)
grep -o '"errorMessage"[^,]*' "$p" | tail -2
```

多用户同时测试时，最新文件可能属于其他会话，需核对测试时间/会话；新 SSH 窗口不保留 `$p`。空输出可能是变量、文件、日志字段或匹配范围不对，不能说明“没有错误”。上述 grep 只是短摘要，逗号或换行可能截断详情，必要时用结构化 JSONL 解析。

| 现象 | 优先判断与处理 |
| --- | --- |
| No API key for provider: ask-metric | 核对 SDK 是否收到 apiKey，自定义头与解密配置是否生效；不要换明文试探 |
| Failed to compile structural_tag grammar | 核对最终 tool_choice 与完整 tools；本现场 auto 已解决这次阻塞，不重放旧 Schema sed |
| Unsupported JSON Schema / Outlines | 看具体字段与最终 Schema；与 structural_tag 区分，按当前协议适配 |
| BACKEND_403 / 000403 | 检查真实用户授权与机构 enabled；历史曾因机构停用，改用已启用且已授权机构后问数成功 |
| FIELD_CHANGES_INVALID | 看当前协议实际工具参数和具体校验错误；不能只凭字段名断言模型接口不通 |
| stopReason=pending/toolUse/stop | 这些记录本身不能证明网络不稳定，也不能证明业务成功；关联具体请求、工具结果和错误 |
| 同题偶发失败 | 固定完整 messages、tools、参数、配置和前置会话比较成功/失败，记录请求时间与关联 ID；核对限流/超时/网关与解析，不能仅凭页面归因模型 |
| 页面拒绝连接 / 登录 502 | 分别检查前端 Nginx、后端和 Agent；两台都重启过，可能进程未自动拉起 |
| PID marker exists | 核对进程/UID/命令哈希，用本包 stop/check；不直接删 marker 或 kill 所有 Python/Node |
| sha256 文件名带 CR | 重新传输保持 LF；仅确认是文本换行后修正并重验，不跳过校验 |
| 创建用户脚本找不到 | 查实际 `backend/runtime/scripts/create_local_user.py`；不重建账号作为升级步骤 |

需要更新模型凭据时，在现场复用原主密钥和已有加密入口，隐藏输入生成密文；不重新生成主密钥、不在命令行参数中传明文。已安装 CLI 的入口可核对 `venv/bin/python -m ask_metric encrypt-config --help`，再用 `encrypt-config --key-file <原密钥路径>`；本次普通升级不需要执行。

## 11. 开机启动与异常自动重启

这是已识别但**尚未在行内完成安装/验收**的运维项，必须在交付状态中单列。`nohup`、一次手动 start、关闭 SSH 后仍运行，都不能证明服务器重启后自动恢复。

目前升级器按 `run.sh`/PID marker 工作，不能在仍自动重启的守护器下面直接换目录，否则旧进程可能被拉起或端口冲突。若现场已改成 systemd/其他平台，先适配升级器的 stop/start/回退与维护状态，再生成包；不能让两套管理器并行。

由行内运维安装管理器时，分别管理后端、Agent 和用户态 Nginx，仍以 `appuser` 运行，读取本地 env/范围快照/SM4；不夹带迁移和配置初始化。采用前台进程入口并 `exec` 实际进程，不能把派生后台进程后立即返回的 `sh run.sh start` 直接设成 `Type=simple`。

建议准备 `service_foreground.py` 与三个独立 unit，后端 loader 复用第 7 节的配置合并逻辑，Agent loader 保留 auto 开关。Nginx 使用用户态路径和 `daemon off;`。退出恢复设置、权限和启动目标按行内 systemd 版本核对；附录 E 保存此前文档中的实施模板，**属于待部署方案，不是现场已生效事实**。

启用前停止原实例：后端用 `sh run.sh stop`，前端用 `sh run.sh front-stop`。核对端口及所有权后，由有权限的运维部署 unit。后续只使用服务管理器启停；`run.sh check` 可继续作 HTTP 检查。用户级 systemd 还需验证未登录情况下的用户管理器/linger 策略，不能仅靠 `systemctl --user enable` 宣称完成。

必须记录：退出 SSH 后可用；两台真实重启后无需人工拉起；分别退出三个服务后能恢复；主动 stop 保持停止；依赖延迟恢复后健康；原配置/账号/会话不变且真实问数通过。真实重启/故障注入由运维在授权维护窗口进行，不在普通打包时远程执行。

## 12. 历史产物与本机查找入口

以下相对路径均以项目仓库根目录为基准；其他机器无需相同盘符。`local-artifacts/` 和旧 worktree 属本机保存内容，不保证在 Git 中；缺失时使用本文件附录与当前源码重建，不把找不到它们当作需要读取旧聊天的前提。

| 用途 | 本机路径 |
| --- | --- |
| 历史完整 ZIP | local-artifacts/packages/ask-metric-pi-uat-upgrade-20261019-1721063.zip |
| 历史角色包/manifest | local-artifacts/packages/intranet-upgrade-20261019/ |
| 成功工具选择补丁 | local-artifacts/packages/model-tool-choice-fix-20261019/model-fix.py |
| 旧本地配置 helper | local-artifacts/tools/uat_local_20261019.py |
| 旧后端/前端升级器 | local-artifacts/tools/intranet_up_20261019.py、intranet_front_up_20261019.sh |
| 构建参考 | local-artifacts/tools/prepare_intranet_upgrade_20261019.py、build_intranet_upgrade_20261019.py |
| 校验/控制流参考 | local-artifacts/tools/verify_upgrade_payload_20261019.py、test_upgrade_flow_20261019.py、test_front_flow_20261019.py、test_model_tool_choice_fix_20261019.py |
| 本地验证记录 | local-artifacts/reports/intranet-upgrade-20261019/ |
| 早期详细复盘 | local-artifacts/notes/pi版本指标问数智能体行内环境部署问题及解决办法.md |
| 已验证 wheelhouse | deploy/.build-package/198ac31ab835/bundle/backend/wheels/，或历史 back.tgz 中 backend/wheels/ |
| Node 归档 | local-artifacts/packages/node-v22.23.2-linux-x64.tar.gz |

历史隔离发布区：`C:/Users/96145/.codex/worktrees/uat-upgrade-20261019/ask-metric-harness-project`；原开发区：`E:/ask-metric-harness-project`。前者在基础提交上有尚未提交的兼容改动，不能只 checkout 基础 SHA 就说包含所有修复。新的工作区可使用任意合适路径。

历史文件 SHA-256（仅核对这些原文件；修改/重建后必须生成新值）：

```text
ask-metric-pi-uat-upgrade-20261019-1721063.zip
a28d3abc17d48a9635efda82963844aa8cf63ddb4fc246b0b5638d2ca6f24c23
back.tgz
e9c95159547e960018472ca3081c190f349ddc0309f3dc94d898f794d8bd4080
front.tgz
6501c0394259056f0d8cf6af6d0eb74e726311c77c3f5554e96bb254056f253f
model-fix.py
c960122940274a6c77c2e300aae3b095359f43694e348f841c540c9b5103d82d
```

**原 ZIP 没有 tool_choice 补丁；不能把原 ZIP 单独复用就认定是当前成功版本。**当前成功组合包括后续补丁。不要为更新交接说明而改写原归档或复用其 SHA。

## 附录使用约定

以下代码供 Codex 从本文件提取，部署人员不需要手敲。A～D 为 10 月 19 日已经用过的模板/约束快照；E 为当时记录、尚未实施的自动恢复模板。新版本按第 5～9 节修改版本、继承当前范围快照、集成配置策略并执行本次验证。

附录不是新的通用发布脚本：历史 `up.py` 的版本常量、范围快照名称及只读结构校验必须按目标适配；特别是其 `old_scope()` 需要按第 7.2 节读取当前已部署 helper 的有效配置后，才适用于下一次续版升级。

## 附录 A：本地配置与进程管理模板

提取为新角色包的 `ops/uat_deploy.py`，按正文适配本次版本。此模板会读取历史范围快照，不会自动迁移或调用模型。

```python
"""现有两机 UAT 的本地配置启停入口；不初始化数据、不读取 Nacos。"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from dotenv import dotenv_values

RELEASE = Path(os.environ.get('AM_RELEASE_DIR', Path(__file__).resolve().parents[1])).resolve()
BASE = Path(os.environ.get('AM_UAT_ROOT', str(Path.home() / 'ask-metric-pi'))).resolve()
SCOPE_KEYS = ('SIT_ORG_CORPORATION_CODE_MAX', 'SIT_ORG_EXCLUDED_CORPORATION_CODE',
              'SIT_ORG_HEAD_OFFICE_CORPORATION_CODE', 'SIT_ORG_LEGAL_ENTITY_HIER_CODE',
              'SIT_ORG_HEAD_OFFICE_HIER_CODE', 'SIT_ORG_EXPECTED_COUNT')


def environment(name='backend'):
    path = BASE / 'config' / f'{name}.env'
    if not path.is_file():
        raise RuntimeError(f'Missing {name} configuration')
    values = dotenv_values(path, interpolate=False)
    # 新版要求显式机构口径；升级文件只保存旧进程实际生效的这六项非敏感值。
    # 主配置仍优先，模型地址、密钥和其它配置均不从升级文件读取。
    scope = BASE / 'config/upgrade-20261019-scope.json'
    if name == 'backend' and scope.is_file():
        inherited = json.loads(scope.read_text())
        if set(inherited) != set(SCOPE_KEYS):
            raise RuntimeError('Invalid upgrade organization scope snapshot')
        values = {**{k: str(v) for k, v in inherited.items()}, **values}
    if any(str(values.get(k, 'false')).lower() not in ('false', '0', '')
           for k in ('NACOS_ENABLED', 'NACOS_CONFIG_ENABLED')):
        raise RuntimeError('This upgrade requires the existing local configuration mode')
    env = dict(os.environ)
    env.update({k: v for k, v in values.items() if v is not None})
    env.update(NACOS_ENABLED='false', NACOS_CONFIG_ENABLED='false')
    return env


def load_backend():
    os.environ.update(environment())
    from ask_metric.core.config import get_settings
    get_settings.cache_clear()
    return get_settings()


def validate():
    settings = load_backend()
    from ask_metric.infrastructure.model.configuration import ModelConfigRepository, PromptConfigRepository
    from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository
    ModelConfigRepository(settings.model_config_path).load()
    PromptConfigRepository(settings.prompt_config_path).load()
    SemanticConfigRepository(settings.semantic_config_path).load()
    # 由实际 Agent 配置解析器验证密文、预算和自定义鉴权设置，不请求模型。
    script = "import {loadConfig} from './dist/config.js';loadConfig();console.log('Agent config OK')"
    subprocess.run([str(RELEASE / 'node-runtime/node/bin/node'), '--input-type=module', '-e', script],
                   cwd=RELEASE / 'agent-service', env=environment('agent'), check=True)
    print('Local configuration OK; no model request or database write')


def database():
    load_backend()
    from sqlalchemy import inspect, text
    from ask_metric.infrastructure.db.models import Base
    from ask_metric.infrastructure.db.session import get_app_engine
    engine = get_app_engine()
    engine.hide_parameters = True
    engine.echo = False
    inspector = inspect(engine)
    missing = []
    for name, table in Base.metadata.tables.items():
        if not inspector.has_table(name):
            missing.append(name)
            continue
        present = {c['name'] for c in inspector.get_columns(name)}
        missing.extend(f'{name}.{c.name}' for c in table.columns if c.name not in present)
    if missing:
        raise RuntimeError('Schema requires DBA review: ' + ', '.join(missing))
    with engine.connect() as connection:
        connection.execute(text('SELECT 1'))
    print('Application database schema OK (read-only)')


def check():
    import httpx
    for name, url in [('backend', 'http://127.0.0.1:8010/health/ready'),
                      ('agent', 'http://127.0.0.1:8020/health')]:
        response = httpx.get(url, timeout=10, trust_env=False)
        if response.status_code != 200:
            raise RuntimeError(f'{name}: HTTP {response.status_code}')
        print(f'{name}: HTTP 200')


def stop():
    for name in ('agent', 'backend'):
        path = BASE / 'run' / f'{name}.json'
        if not path.exists():
            continue
        saved = json.loads(path.read_text())
        pid = int(saved['pid'])
        if pid <= 1:
            raise RuntimeError('Invalid process marker')
        cmdline = Path(f'/proc/{pid}/cmdline')
        if cmdline.exists() and cmdline.read_bytes():
            if cmdline.stat().st_uid != os.getuid() or hashlib.sha256(cmdline.read_bytes()).hexdigest() != saved['command_sha256']:
                raise RuntimeError(f'{name}: PID ownership or command mismatch; not stopped')
            os.kill(pid, signal.SIGTERM)
            for _ in range(100):
                if not cmdline.exists() or not cmdline.read_bytes():
                    break
                time.sleep(.2)
            else:
                raise RuntimeError(f'{name} still running; marker retained')
        path.unlink()
        print(f'stopped {name}')


def start():
    import socket
    validate()
    database()
    (BASE / 'run').mkdir(parents=True, exist_ok=True)
    (BASE / 'logs').mkdir(parents=True, exist_ok=True)
    commands = {
        'backend': [str(RELEASE / 'venv/bin/python'), '-I', '-m', 'uvicorn', 'ask_metric.main:app',
                    '--host', '0.0.0.0', '--port', '8010', '--no-access-log'],
        'agent': [str(RELEASE / 'node-runtime/node/bin/node'), str(RELEASE / 'agent-service/dist/server.js')],
    }
    # 先检查两个端口和标记，避免启动一半后才发现另一个实例。
    for name, port in [('backend', 8010), ('agent', 8020)]:
        if (BASE / 'run' / f'{name}.json').exists():
            raise RuntimeError(f'{name} PID marker exists; run stop/check first')
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('0.0.0.0', port))
    for name, command in commands.items():
        with (BASE / 'logs' / f'{name}-console.log').open('ab') as log:
            child = subprocess.Popen(command, cwd=RELEASE / 'agent-service' if name == 'agent' else RELEASE,
                                     env=environment(name), stdout=log, stderr=log, start_new_session=True)
        time.sleep(2)
        if child.poll() is not None:
            raise RuntimeError(f'{name} startup failed; inspect its console log')
        marker = {'pid': child.pid, 'command_sha256': hashlib.sha256(Path(f'/proc/{child.pid}/cmdline').read_bytes()).hexdigest()}
        target = BASE / 'run' / f'{name}.json'
        with target.open('x') as output:
            json.dump(marker, output)
        target.chmod(0o600)
    for _ in range(60):
        try:
            check()
            return
        except Exception:
            time.sleep(2)
    raise RuntimeError('Readiness timeout; inspect local logs')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        command = sys.argv[1] if len(sys.argv) == 2 else ''
        actions = {'start': start, 'stop': stop, 'check': check, 'validate': validate,
                   'db': database, 'sql': database}
        if command not in actions:
            raise RuntimeError('Usage: sh run.sh start|stop|check|validate|db|sql; no prepare/publish/sync')
        actions[command]()
    except Exception as error:
        # 仅报告校验位置和类型，不回显可能含凭据的输入值。
        from pydantic import ValidationError
        if isinstance(error, ValidationError):
            for item in error.errors(include_input=False, include_context=False, include_url=False):
                print('Invalid config field: ' + '.'.join(map(str, item['loc'])) + ' (' + item['type'] + ')', file=sys.stderr)
        print(f'Operation failed ({type(error).__name__}); inspect the local configuration/logs.', file=sys.stderr)
        raise SystemExit(1)
```

后端 `run.sh`：

```sh
#!/bin/sh
set -eu
R=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export AM_RELEASE_DIR="$R"
exec "$R/venv/bin/python" "$R/ops/uat_deploy.py" "$@"
```

前端 `run.sh`：

```sh
#!/bin/sh
set -eu
B=${AM_UAT_ROOT:-$HOME/ask-metric-pi}
case "${1:-}" in
front-check) exec nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf" -t ;;
front-start) exec nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf" ;;
front-stop) exec nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf" -s quit ;;
*) echo 'Usage: sh run.sh front-check|front-start|front-stop'; exit 2 ;;
esac
```

## 附录 B：历史后端升级器模板

提取为 `up.py`。**此模板的 `old_scope()` 只读取旧 env；当前现场已使用范围快照，下一次发布必须先按第 7.2 节修正有效配置继承，并添加续版回归。**同时替换所有本次版本常量、快照和 marker 命名，核对配置策略与新旧协议；不能原样用于下一版本。

```python
"""同目录上传 up.py 与 front/back.tgz 后，分节点校验、预装、切换及回退。"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

VERSION = '20261019-1721063'
SCOPE_KEYS = ('SIT_ORG_CORPORATION_CODE_MAX', 'SIT_ORG_EXCLUDED_CORPORATION_CODE',
              'SIT_ORG_HEAD_OFFICE_CORPORATION_CODE', 'SIT_ORG_LEGAL_ENTITY_HIER_CODE',
              'SIT_ORG_HEAD_OFFICE_HIER_CODE', 'SIT_ORG_EXPECTED_COUNT')


def old_scope(release, state):
    script = '''
import json, os, sys
from dotenv import dotenv_values
values=dotenv_values(sys.argv[1],interpolate=False)
os.environ.update({k:v for k,v in values.items() if v is not None})
if any(str(os.environ.get(k,'false')).lower() not in ('false','0','') for k in ('NACOS_ENABLED','NACOS_CONFIG_ENABLED')):
    raise RuntimeError('Expected local configuration mode')
from ask_metric.core.config import get_settings
settings=get_settings()
keys=json.loads(sys.argv[2])
print(json.dumps({k:getattr(settings,k.lower()) for k in keys}))
'''
    result = subprocess.run([str(release/'venv/bin/python'), '-c', script,
                             str(state/'config/backend.env'), json.dumps(SCOPE_KEYS)],
                            cwd=release, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Cannot read old effective organization scope; old program was not changed')
    scope = json.loads(result.stdout.strip().splitlines()[-1])
    if set(scope) != set(SCOPE_KEYS) or any(v is None or str(v) == '' for v in scope.values()):
        raise RuntimeError('Old effective organization scope is incomplete')
    print('Existing organization scope (retained explicitly): ' + json.dumps(scope, ensure_ascii=False))
    return scope


def run(args, *, cwd, env=None):
    subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def extract(archive, stage):
    with tarfile.open(archive, 'r:gz') as tar:
        for item in tar:
            path = stage / item.name
            if item.name.startswith('/') or '..' in Path(item.name).parts or not path.resolve().is_relative_to(stage):
                raise RuntimeError('Unsafe archive member')
            if not (item.isfile() or item.isdir() or item.issym() or item.islnk()):
                raise RuntimeError('Unsupported archive member')
            if item.issym() or item.islnk():
                target = path.parent / item.linkname if item.issym() else stage / item.linkname
                if Path(item.linkname).is_absolute() or not target.resolve().is_relative_to(stage):
                    raise RuntimeError('Unsafe archive link')
            tar.extract(item, stage, filter='data')
    manifest = json.loads((stage / 'manifest.json').read_text())
    if manifest['release'] != VERSION:
        raise RuntimeError('Unexpected package version')
    for line in (stage / 'checksums.sha256').read_text().splitlines():
        sha, name = line.split('  ', 1)
        path = stage / name
        if not path.resolve().is_relative_to(stage) or not path.is_file() or digest(path) != sha:
            raise RuntimeError('Extracted file verification failed')


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('check', 'apply', 'rollback'):
        raise SystemExit('Usage: python3.12 up.py check|apply|rollback')
    os.umask(0o077)
    release = Path.cwd().resolve()
    expected_release = Path.home().resolve() / 'ws'
    if expected_release.is_symlink() or release != expected_release:
        raise RuntimeError('Run from the existing ~/ws directory')
    state = Path.home() / 'ask-metric-pi'
    is_backend = (state / 'config/backend.env').is_file()
    role = 'back' if is_backend else 'front'
    if not is_backend and not (state / 'nginx.conf').is_file():
        raise RuntimeError('Existing UAT node was not identified')
    archive = release / f'{role}.tgz'
    stage = release.parent / f'ws-next-{VERSION}'
    previous = release.parent / f'ws-before-{VERSION}'
    failed = release.parent / f'ws-failed-{VERSION}'
    assert all(p.parent == release.parent and p != release for p in (stage, previous, failed))
    marker = state / f'upgrade-{VERSION}.json'

    if sys.argv[1] == 'rollback':
        if not previous.is_dir() or failed.exists():
            raise RuntimeError('Expected backup missing or failed-version directory already exists')
        if is_backend:
            run(['sh', 'run.sh', 'stop'], cwd=release)
        os.chdir(release.parent)
        os.replace(release, failed)
        os.replace(previous, release)
        if is_backend:
            run(['sh', 'run.sh', 'start'], cwd=release)
        print('Previous program restored; persistent configuration/data retained')
        return

    expected = (archive.with_name(archive.name + '.sha256')).read_text().split()[0]
    if digest(archive) != expected:
        raise RuntimeError('Archive checksum mismatch')
    if stage.exists() or previous.exists() or failed.exists() or marker.exists():
        raise RuntimeError('Upgrade staging/backup/marker already exists; inspect before repeating')
    free = shutil.disk_usage(release.parent).free
    with tarfile.open(archive) as tar:
        required = sum(item.size for item in tar if item.isfile())
    if free < required * 3 + 512 * 1024 * 1024:
        raise RuntimeError('Insufficient space for staging, venv and retained backup')
    if is_backend:
        if sys.version_info[:2] != (3, 12):
            raise RuntimeError('Run with the existing venv/bin/python (Python 3.12)')
        for name in ('backend', 'agent'):
            if not (state / 'run' / f'{name}.json').is_file():
                raise RuntimeError('Expected run.sh process markers missing; verify existing service management')
        scope = old_scope(release, state)
    print(f'{role}: checksum and preflight OK; old program/configuration unchanged')
    if sys.argv[1] == 'check':
        return

    stage.mkdir(mode=0o700)
    extract(archive, stage)
    if is_backend:
        # 预装发生在旁路目录；安装失败不会停止或覆盖原服务。
        run([sys.executable, '-m', 'venv', stage / 'venv'], cwd=release)
        python = stage / 'venv/bin/python'
        run([python, '-m', 'pip', 'install', '--no-index', '--find-links', stage / 'backend/wheels',
             '--constraint', stage / 'ops/constraints.txt', 'ask-metric-backend-next', 'uvloop'], cwd=stage)
        run([python, '-m', 'pip', 'check'], cwd=stage)
        # 将旧运行配置的实际范围显式固化，不能用新版模板猜测行内口径。
        snapshot = state/'config/upgrade-20261019-scope.json'
        if snapshot.exists():
            if json.loads(snapshot.read_text()) != scope:
                raise RuntimeError('Existing organization scope snapshot differs; review before upgrading')
        else:
            with snapshot.open('x') as stream:
                json.dump(scope, stream, ensure_ascii=False, indent=2)
            snapshot.chmod(0o600)
        env = dict(os.environ, AM_RELEASE_DIR=str(stage), AM_UAT_ROOT=str(state))
        run([python, stage / 'ops/uat_deploy.py', 'validate'], cwd=stage, env=env)
        run([python, stage / 'ops/uat_deploy.py', 'db'], cwd=stage, env=env)
    else:
        # 留存旧 hash 资源，已打开页面在升级后仍能加载其依赖。
        old_assets, new_assets = release / 'frontend/assets', stage / 'frontend/assets'
        if old_assets.is_dir():
            for source in old_assets.iterdir():
                target = new_assets / source.name
                if source.is_file() and not target.exists():
                    shutil.copy2(source, target)
        run(['nginx', '-e', state / 'logs/nginx-error.log', '-p', str(state) + '/',
             '-c', state / 'nginx.conf', '-t'], cwd=release)

    # 启停入口与持久配置完全分离；旧目录整份留存，失败只回退程序。
    switched = False
    stop_requested = False
    try:
        if is_backend:
            stop_requested = True
            run(['sh', 'run.sh', 'stop'], cwd=release)
        os.chdir(release.parent)
        os.replace(release, previous)
        try:
            os.replace(stage, release)
        except BaseException:
            os.replace(previous, release)
            raise
        switched = True
        if is_backend:
            run(['sh', 'run.sh', 'start'], cwd=release)
            run(['sh', 'run.sh', 'check'], cwd=release)
        else:
            import urllib.request
            with urllib.request.urlopen('http://127.0.0.1:8090/', timeout=10) as response:
                if response.status != 200:
                    raise RuntimeError('Frontend readiness failed')
        marker.write_text(json.dumps({'release': VERSION, 'role': role, 'backup': str(previous),
                                      'updated_at': time.time()}, indent=2))
        print('UPGRADE OK; backup: ' + str(previous))
    except BaseException:
        if switched:
            if is_backend:
                run(['sh', 'run.sh', 'stop'], cwd=release)
            os.replace(release, failed)
            os.replace(previous, release)
        if is_backend and stop_requested:
            run(['sh', 'run.sh', 'start'], cwd=release)
        print('Old program restored; inspect local error output before retrying', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
```

## 附录 C：历史前端升级器模板

提取为 `front-up.sh`，替换版本号与 manifest 检查中的对应字符串。目标路径和管理方式变化时同步适配。

```sh
#!/bin/sh
# 仅替换现有用户态 Nginx 对应的静态资源，不安装软件或修改配置。
set -eu
V=20261019-1721063
R=$(pwd -P)
test "$R" = "$HOME/ws" && test ! -L "$HOME/ws" || { echo 'Run from existing ~/ws'; exit 1; }
B="$HOME/ask-metric-pi"
N="$HOME/ws-next-$V"
O="$HOME/ws-before-$V"
F="$HOME/ws-failed-$V"
test -f "$B/nginx.conf" && test ! -f "$B/config/backend.env" || { echo 'Not the frontend node'; exit 1; }
case "${1:-}" in
rollback)
  test -d "$O" && test ! -e "$F"
  cd "$HOME"
  mv "$R" "$F"
  mv "$O" "$R"
  echo 'Previous frontend restored; Nginx configuration unchanged'
  exit 0
  ;;
check|apply) ;;
*) echo 'Usage: sh front-up.sh check|apply|rollback'; exit 2 ;;
esac
sha256sum -c front.tgz.sha256
test ! -e "$N" && test ! -e "$O" && test ! -e "$F"
nginx -e "$B/logs/nginx-error.log" -p "$B/" -c "$B/nginx.conf" -t
test "${1:-}" = apply || { echo 'Frontend preflight OK'; exit 0; }
mkdir -m 700 "$N"
tar -xzf front.tgz -C "$N"
(cd "$N" && sha256sum -c checksums.sha256 >/dev/null)
grep -Fq '"release": "20261019-1721063"' "$N/manifest.json"
if test -d "$R/frontend/assets"; then
  for p in "$R"/frontend/assets/*; do
    test -f "$p" || continue
    t="$N/frontend/assets/$(basename "$p")"
    test -e "$t" || cp "$p" "$t"
  done
fi
done_switch=false
recover() {
  rc=$?
  if test "$rc" -ne 0 && test -d "$O"; then
    cd "$HOME"
    if test "$done_switch" = true; then mv "$R" "$F"; fi
    mv "$O" "$R"
    echo 'Old frontend restored' >&2
  fi
  exit "$rc"
}
trap recover EXIT
trap 'exit 1' HUP INT TERM
cd "$HOME"
mv "$R" "$O"
mv "$N" "$R"
done_switch=true
curl --fail --max-time 10 http://127.0.0.1:8090/ -o /dev/null
echo "UPGRADE OK; backup: $O"
```

## 附录 D：已验证的离线依赖约束快照

提取为 `ops/constraints.txt` 的参考。来自已交付 `back.tgz` 的实际约束；新版本依赖变化时重新求解并验证，不强行使用不兼容锁定。该文本不包含 wheel 二进制。

```text
# Reproducible native deployment dependency set.
# Refresh intentionally after running the complete backend test suite.
defusedxml==0.7.1
alembic==1.19.1
aiofiles==24.1.0
aiohappyeyeballs==2.7.1
aiohttp==3.14.3
aiosignal==1.4.0
alibabacloud-credentials==1.0.12
alibabacloud-credentials-api==1.0.1
alibabacloud-darabonba-encode-util==0.0.3
alibabacloud-darabonba-string==0.0.4
alibabacloud-gateway-pop==0.1.3
alibabacloud-gateway-spi==0.0.4
alibabacloud-kms20160120==3.2.0
alibabacloud-openapi-util==0.2.4
alibabacloud-tea==0.4.3
alibabacloud-tea-openapi==0.4.6
alibabacloud-tea-util==0.3.15
alibabacloud_darabonba_array==0.1.0
alibabacloud_darabonba_map==0.0.1
alibabacloud_darabonba_signature_util==0.0.4
alibabacloud_endpoint_util==0.0.4
alibabacloud_tea_xml==0.0.3
annotated-doc==0.0.5
annotated-types==0.8.0
anyio==4.14.2
APScheduler==3.11.3
argon2-cffi==25.1.0
argon2-cffi-bindings==21.2.0
attrs==26.1.0
certifi==2026.7.22
cffi==2.1.1
charset-normalizer==3.5.1
click==8.4.2
colorama==0.4.6
cryptography==50.0.0
darabonba-core==1.0.8
fastapi==0.141.1
frozenlist==1.8.0
greenlet==3.2.5
grpcio==1.83.0
h11==0.16.0
httptools==0.8.0
httpcore==1.0.9
httpx==0.28.1
hanlp-trie==0.0.5
hanlp-common==0.0.23
phrasetree==0.0.9
pypinyin==0.55.0
rapidfuzz==3.13.0
idna==3.19
Mako==1.4.1
MarkupSafe==3.0.3
multidict==6.7.1
nacos-sdk-python==2.0.11
propcache==0.5.2
protobuf==6.33.6
psutil==7.2.2
pwdlib==0.3.1
pycparser==3.0
pycryptodome==3.23.0
pydantic==2.10.6
pydantic-core==2.27.2
pydantic-settings==2.7.1
PyJWT==2.13.0
PyMySQL==1.2.0
python-dotenv==1.2.3
PyYAML==6.0.3
requests==2.34.2
SQLAlchemy==2.0.52
starlette==1.6.0
typing-extensions==4.16.0
typing-inspection==0.4.4
tzdata==2026.3
tzlocal==5.4.4
urllib3==2.7.0
uvicorn==0.52.4
uvloop==0.22.1
watchfiles==1.2.0
websocket-client==1.9.0
websockets==15.0.1
yarl==1.24.5
simpleeval==1.0.8
sqlglot==30.18.0
gmssl==3.2.2
pycryptodomex==3.23.0
```

## 附录 E：自动恢复实施模板（尚未行内安装验收）

这些模板来自前次复盘，供运维与后续 Codex 继续准备；不属于已验证的手动升级步骤。使用前需核对当前源码的配置加载方式、版本、实际 Nginx 路径、systemd 版本与行内权限，按第 11 节适配升级器后再切换。

### E.1 后端前台 loader 与两个 unit

以下文件由运维按现场目录落地，不需要重新安装应用依赖。后端虚拟环境已包含 python-dotenv。固定目录不是本机生产默认值，若现场路径调整，必须同步修改入口与 unit。

先在后端节点保存 `/home/appuser/ask-metric-pi/ops/service_foreground.py`：

```python
import os
import sys
import json
from pathlib import Path
from dotenv import dotenv_values

role = sys.argv[1]
if role not in {"backend", "agent"}:
    raise SystemExit("service role must be backend or agent")

release = Path("/home/appuser/ws")
base = Path("/home/appuser/ask-metric-pi")
config = base / "config" / f"{role}.env"
if not config.is_file():
    raise SystemExit("service configuration file is missing")

values = dotenv_values(config, interpolate=False)
# 2026-10-19 升级版会把旧进程实际机构范围显式保存在独立文件中。
# 原 backend.env 的同名项优先；这里只读取六项非敏感机构口径。
scope_file = base / "config/upgrade-20261019-scope.json"
if role == "backend" and scope_file.is_file():
    scope = json.loads(scope_file.read_text(encoding="utf-8"))
    allowed = {"SIT_ORG_CORPORATION_CODE_MAX", "SIT_ORG_EXCLUDED_CORPORATION_CODE",
               "SIT_ORG_HEAD_OFFICE_CORPORATION_CODE", "SIT_ORG_LEGAL_ENTITY_HIER_CODE",
               "SIT_ORG_HEAD_OFFICE_HIER_CODE", "SIT_ORG_EXPECTED_COUNT"}
    if set(scope) != allowed:
        raise SystemExit("organization scope snapshot is invalid")
    values = {**{k: str(v) for k, v in scope.items()}, **values}
env = dict(os.environ)
env.update({k: v for k, v in values.items() if v is not None})
if role == "backend":
    os.chdir(release)
    command = [str(release / "venv/bin/python"), "-I", "-m", "uvicorn",
               "ask_metric.main:app", "--host", "0.0.0.0", "--port", "8010",
               "--no-access-log"]
else:
    os.chdir(release / "agent-service")
    command = [str(release / "node-runtime/node/bin/node"),
               str(release / "agent-service/dist/server.js")]

# 用实际应用替换加载进程，systemd 的主 PID 始终对应前台服务。
os.execve(command[0], command, env)
```

该入口只加载配置并以前台方式启动应用，不输出配置值、不修改数据库、不创建旧启动脚本的 PID 标记。源码文件应允许 `appuser` 读取；现有配置文件和密钥的受控权限保持不变。

保存 `/etc/systemd/system/ask-metric-pi-backend.service`：

```ini
[Unit]
Description=Ask Metric pi UAT backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=appuser
WorkingDirectory=/home/appuser/ws
ExecStart=/home/appuser/ws/venv/bin/python -I /home/appuser/ask-metric-pi/ops/service_foreground.py backend
Restart=always
RestartSec=10s
TimeoutStopSec=60s
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

保存 `/etc/systemd/system/ask-metric-pi-agent.service`：

```ini
[Unit]
Description=Ask Metric pi UAT agent
After=network-online.target ask-metric-pi-backend.service
Wants=network-online.target ask-metric-pi-backend.service

[Service]
Type=simple
User=appuser
WorkingDirectory=/home/appuser/ws/agent-service
ExecStart=/home/appuser/ws/venv/bin/python -I /home/appuser/ask-metric-pi/ops/service_foreground.py agent
Restart=always
RestartSec=10s
TimeoutStopSec=60s
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

`After` 只约束启动顺序，不代表后端业务已经就绪。两个服务分别管理和恢复，不以 `Requires` 把后端的一次退出直接传播为 Agent 停止。依赖恢复后仍需按正文第 11 节检查端到端状态。

### E.2 前端 Nginx unit

保存 `/etc/systemd/system/ask-metric-pi-front.service`。**先将模板中的 `@NGINX_BIN@` 替换为现场 `command -v nginx` 返回的绝对路径**，不能保留占位符。确认现有 nginx.conf 未另设冲突的 `daemon` 指令，已有运行目录和临时目录仍由 `appuser` 使用。

```ini
[Unit]
Description=Ask Metric pi UAT frontend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=appuser
WorkingDirectory=/home/appuser/ws
ExecStartPre=@NGINX_BIN@ -e /home/appuser/ask-metric-pi/logs/nginx-error.log -p /home/appuser/ask-metric-pi/ -c /home/appuser/ask-metric-pi/nginx.conf -t
ExecStart=@NGINX_BIN@ -e /home/appuser/ask-metric-pi/logs/nginx-error.log -p /home/appuser/ask-metric-pi/ -c /home/appuser/ask-metric-pi/nginx.conf -g "daemon off;"
ExecReload=@NGINX_BIN@ -e /home/appuser/ask-metric-pi/logs/nginx-error.log -p /home/appuser/ask-metric-pi/ -c /home/appuser/ask-metric-pi/nginx.conf -s reload
Restart=always
RestartSec=10s
KillSignal=SIGQUIT
KillMode=mixed
TimeoutStopSec=60s
UMask=0077

[Install]
WantedBy=multi-user.target
```

这里用 `daemon off;` 让 systemd 跟踪 Nginx 主进程；保留用户日志路径以避免系统目录权限问题。只管理本包独立 8090 实例，不替换或停止原系统 Nginx 站点。

### E.3 运维安装与验收

先停止手动管理的实例并确认无守护器抢占，再由具备权限的运维安装/验证 unit；前端占位符必须替换成 `command -v nginx` 的真实绝对路径。以下只在已完成模板审查后执行。

后端节点：

```sh
systemctl daemon-reload
systemctl enable --now ask-metric-pi-backend.service ask-metric-pi-agent.service
systemctl status ask-metric-pi-backend.service ask-metric-pi-agent.service
```

前端节点：

```sh
systemctl daemon-reload
systemctl enable --now ask-metric-pi-front.service
systemctl status ask-metric-pi-front.service
```

完成管理器切换后，原基于 PID marker 的 `up.py` 不再可直接照用；必须先交付管理器对应的升级/回退入口，日常只通过管理器启停。单次 `enable/start` 不能代替真实重启与故障恢复验收；自动恢复不会保证在途请求无感继续，进程卡死仍需要健康监控。
