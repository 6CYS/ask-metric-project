# Ask Metric 智能助手服务

基于 pi AgentHarness 原生运行时（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）的问数代理服务。
pi 是唯一的 Agent 运行与对话控制核心：会话、模型上下文、压缩、执行状态与恢复全部使用原生能力
（`JsonlSessionRepo` + `main` lane）；本服务只做鉴权、可信输入绑定、原生接线和页面投影。
Agent 的业务取数只调用 FastAPI 后端受治理接口并透传用户 Bearer，目录校验、权限裁剪、
SQL 模板执行与受控计算全部保留在后端；本服务不生成或执行 SQL，不缓存业务数据。

## 本地运行

```bash
npm ci
cp .env.example .env   # 按需修改
npm run dev            # 默认 127.0.0.1:8020
```

常用检查：`npm run typecheck`、`npm run build`、`npm run test`。

## 配置

见 `.env.example`。`AGENT_MODEL_API_KEY` 支持 `ENC[SM4:v1:...]` 密文，格式与后端
`backend-next/src/ask_metric/core/config_crypto.py` 一致，主密钥经
`ASK_METRIC_CONFIG_SM4_KEY_FILE`（推荐）或 `ASK_METRIC_CONFIG_SM4_KEY` 提供。

压缩配置只映射原生 `CompactionSettings`（`AGENT_COMPACTION_*`），启动时校验
`reserveTokens + keepRecentTokens < contextWindow` 且 `maxTokens < contextWindow`，不成立即拒绝启动。

## 接口（协议 V3）

- `GET /health`：健康检查（无需鉴权）。
- `POST /sessions`、`GET /sessions`、`GET /sessions/{id}`、`DELETE /sessions/{id}`：会话管理；历史消息由原生记录投影（含工具回执引用），删除活动会话返回 409。
- `POST /sessions/{id}/prompt`：提问，SSE 事件流。请求体为 `{protocol_version: 3, request_id, message, send_as?, clarification_target?, selected_answers?}`；`request_id` 由浏览器每次确认发送生成，重试不变。旧协议请求返回 `CLIENT_UPGRADE_REQUIRED`。
- `GET /sessions/{id}/stream`：只读观察流（断线重连：快照 + 实时事件），不接纳新输入。
- `POST /sessions/{id}/cancel`：显式停止指定 operation（原生 requestAbort）。

SSE 事件：`accepted`（含快照）、`snapshot`、`tool_start`、`tool_end`、`run_terminal`
（分开表达 `run_status`/`answer_status`/`business_tasks`）、`error`；公共字段含
`protocol_version`、`session_id`，提问流另含 `operation_id`、`request_id`。
模型原始 `text_delta` 不直接交付；基础问数、澄清、目录总览和结果回读通过工具回执生成正文，
并经最终快照同步。成功取数后使用原生 `after_tool` 结束本轮，省去模型复述。
`run_terminal.timings_ms` 在提问流中记录鉴权、外层模型、工具和总耗时；这些不等于页面可见耗时。

刷新或传输中断后，前端通过 GET 观察原会话，不重新 POST 问题。已认证 GET 会接管原生未完成
operation；是否存在 `current` 不能用来判断当前进程是否已有执行器。恢复仍使用原 request 和
各业务阶段的幂等键。`send_as=new_question` 与 `clarification_target` 互斥，非法输入整体拒绝。

除 `/health` 外均需 `Authorization: Bearer <后端访问令牌>`，身份每次请求经后端
`/api/v1/auth/me` 校验，不使用短期缓存。会话以原生 JSONL 持久化在
`AGENT_DATA_DIR/native-v1/u_<身份哈希>/`（默认 `./data`，生产为 `/var/lib/ask-metric/agent`），
重启后恢复；同一数据根只允许一个写实例（启动时 PID 锁保护）。用户令牌只保存在内存。
旧格式 JSON 会话（`AGENT_DATA_DIR` 根目录的 `*.json`）保留只读展示，不可续跑、不再写入。

## Agent 工具

默认六个工具（普通自然语言会话）：

- `metric_ask`：受治理问数与上下文澄清。`new` 提交新问题（提交→提槽→条件齐全则查询）；`clarify` 把用户本轮补充精确提交到原任务的澄清（同 task/version/clarification_id，受控版本刷新最多一次）；`followup` 引用一笔已完成查询组合修改条件（统一提交 `query_reference.change_field=compose`，具体修改由后端解析和校验）；`clarify_context` 在来源或修改含义不明确时询问用户，不创建取数任务。
- `metric_read`：只读任务状态（`kind=task`）或分页读取不可变结果（`kind=result`，默认 20 行、最多 100 行）。
- `session_history_read`：原生分支历史回读（list/entry，跨压缩条目，只读当前分支祖先）。
- `metric_catalog_search` / `org_catalog_search`：正式指标/机构目录检索，委托后端受治理检索接口按确定性命中排序；只有 exact/contains/lexical 命中可锁定编码。
- `metric_catalog_overview`：实时启用指标数量、单位分组和示例，经 `/api/v1/catalog/metrics/overview` 读取；不要求机构和日期，不创建问数任务。

另提供以下专项工具：

- `data_availability`：查询授权范围的数据可用日期、所选组合的覆盖情况及共同日期；具体名称先经目录检索确认。
- `catalog_overview`：介绍可查询哪些指标或机构，一次读取受权限约束的目录摘要。
- `metric_calculate`：将当前提问的数据引用与表达式交给后端计算，页面直接展示结果及来源。

只输入具体指标名称时，仍交给 `metric_ask` 校验完整请求并创建正式澄清。局部目录搜索不能替代
完整指标覆盖校验；正式长名称中的“增幅、排名”保持原义，混入停用指标返回 `METRIC_DISABLED`，
不会静默执行剩余指标。连续追问引用最近成功查询，历史回读按原文明确的历史指代选择结果。

`metric_query_structured`（`/api/v1/basic-queries` 结构化快通道）能力保留，但不在普通自然语言
会话默认启用，避免绕过语义治理。

`catalog_overview` 调用 `GET /api/v1/catalog/overview?catalog=metrics|organizations&limit=8`，
示例上限为 20。它不接受搜索词；具体名称使用目录检索工具，取数使用查询工具。
纯目录概览由前端根据工具结果生成中文介绍，实时与历史共用；组合取数任务仍继续执行，
不会因概览强制结束。概览不证明某机构、日期存在数据，也不推断分类、更新频率或覆盖期。
后端 `CATALOG_OVERVIEW_METRIC_CODES` 可配置代表性指标，详见后端 README。
升级需同步后端、Agent 和前端，无数据库迁移；旧历史缺少概览结果时保持原展示。

同一会话的消息和工具结果交给 harness 理解追问，沿用已确认条件，本轮明确条件优先；调用后端时提交完整问题。待澄清任务按任务与澄清编号补充。参数、限制和升级说明见
[通用表达式计算工具](../docs/calculation-tools.md)。

幂等：业务命令键由（owner+session+request+业务负载）指纹派生，同一 operation 只接纳一个独立
写意图，第二个不同写意图返回 `TURN_QUERY_LIMIT`；提交/分析/澄清/执行各阶段使用稳定派生键，
不使用随机键。成功执行的重放从后端 ResultArtifact 回读完整明细，不重跑 SQL。

## 模型输入与用量诊断

每次发送前使用 pi 原生 `transform_context` 投影过去已成功且有完整正式条件的结果回执，
省略历史 `rows/sample_rows/comparisons`，保留结果引用、正式条件、目录、告警和分页信息。
当前轮、失败、澄清及证据不完整的回执不裁剪；原生 JSONL 不修改，需要旧数值时仍经
`metric_read` 鉴权回读。查询索引按 task/result 去重，保留原问题与版本，最新基准仅列一次。
没有显式历史指代的 followup 使用最近展示的成功结果，避免换机构回退日期、回读后追问串机构。

`model_usage` 结构化日志来自 pi 原生 usage 事件，涵盖 assistant、compaction、branch_summary，
包含 `request_id/session_id/operation_id/usage_id/step/attempt/model` 及输入、输出、缓存 Token。
`input_tokens` 包含缓存读取/写入，和兼容接口的 `prompt_tokens` 对齐；原生全零或无有效输入
用量记为 `usage_known=false`、计数为 null，不当成免费调用。`payload_bytes` 是字节而非 Token。
模型单价未配置时不输出估算费用。日志不包含用户问题、提示词、工具行值、回答或凭据。

同一问答的后端调用携带 `X-Trace-ID=request_id`，各阶段原有 `X-Request-ID` 与幂等键不变。
将 Agent 的 `request_id` 与后端 `model_usage.trace_id` 连接，即可合计一轮问答的模型用量；
必须保留未知用量、重试、失败和压缩调用，不能将一次工具调用当成一次模型请求。
摘要步骤不强制业务工具，也不经过业务回答替换；保持 pi 的压缩阈值及原生持久化机制。

本次真实配对验收和限制见 `../docs/acceptance/token-optimization-2026-09-19.md`。
无需数据库迁移或新增配置。部署需同时更新后端和 Agent 并重启；回退使用上一版应用构建，
原生会话和业务结果格式保持兼容，无需清空历史。

## 查看工具执行过程

回复展示采用统一纯文本：前端解析 Markdown 的加粗、列表和链接等格式，仅展示文字，
不执行 HTML 或加载模型提供的图片。澄清使用后端澄清结构；查询无数据使用工具明细中的
`message`，旧记录缺少该字段时显示通用无数据文案；失败和不支持状态使用固定中文提示，
不使用模型对这些状态的额外解释。查询工具明细附带 `message` 与 `error_code`，实时和
历史展示共用规则。成功有数据时保留模型整理及原始结果表；该规则不等于完整的事实校验器。

金额展示统一使用后端规则：查询 `facts` 和计算 `results` 对元、万元提供
`reply_value`、`reply_unit`，正文直接引用万元展示值（两位小数），无需额外调用换算工具。
原始 `value`、`unit` 和结果行仍用于计算证据、明细及导出；表格仅去除小数末尾的零，
不舍入、不转换单位。百分比等其他单位沿用原有规则。缺少金额展示字段时不由模型心算兜底。
升级应同时更新后端与助手；历史回复正文不自动重写，新查询生成新的展示字段。

查询工具结果不再附带内部 `display_hint` 文案，避免模型将展示指令复述为答案。
页面兼容过滤旧回复中已知的该类提示。账号区显示中文机构简称、角色和服务端返回的查询范围；
登录账号及完整所属机构放入悬停说明。地方机构普通用户仅查询本机构，省级机构按服务端
正式编码配置可查全行，不再使用个人用户白名单扩大地方机构账号权限。

问数时间下方、回复正文上方的“执行过程”默认折叠，执行中在同一位置显示当前阶段，
完成后显示用时；展开后按调用开始顺序展示中文步骤名称（不显示英文工具标识）、
执行状态和已记录的工具耗时；同名工具多次调用分别展示。此处展示实际工具记录，
不展示模型内部思考、原始调用参数或完整工具响应。原有耗时和调试入口继续保留。

## 数据可用日期工具

`data_availability` 调用 `POST /api/v1/data-availability`，按业务日期 `data_dt` 去重，
返回日期总数、最早最新日期和有限日期列表。省略指标时不增加指标目录筛选；
机构始终限制在当前账号查询权限内。可指定正式机构、指标编码和用户明确给出的时间范围。
`match=any` 为默认，表示至少一项有记录；仅明确要求“都有数据”时用 `match=all`，
并同时指定机构和指标，最多100个组合。这里统计有记录的日期，不保证指标值有效。

前端只展示一段自然语言，日期多时明确说明仅列部分；不生成覆盖表或分页按钮。
可明确指定日期范围或 `page`、`page_size` 继续查询。每轮只执行一次日期查询，返回后
停止本轮后续工具调用；模型不能通过改年份或拆指标继续重试。下一次提问可结合当前会话条件继续查询。
工具与错误记录保留在执行过程；旧历史同轮多个日期结果仅展示首个，不重复堆叠表格。
该工具不自动选择业务查询日期，不返回业务数值或计算证据。

同步升级前后端、Agent 与 `data_availability` SQL 模板，保留其他持久模板修改；无数据库迁移。


### 按机构和日期发现有记录的指标

`data_availability` / `POST /api/v1/data-availability` 新增 `dimension`：默认 `dates` 保持日期查询；
`metrics` 按授权机构、业务日期及可选指标条件查询有记录的正式启用指标。
例如 `{"dimension":"metrics","org_codes":["320000000"],"start":"2026-06-30","end":"2026-06-30"}`。
单次 SQL 去重计数并分页，响应 `mode=metrics`、`metric_count`、`items`（指标编码和名称）；
默认每页 10 项、最多 50 项，按编码稳定排序。前端用自然语言显示总数及本页名称，不展开日期表。
未指定时间不自动补日期；范围内至少一条记录即计入，不保证每个机构、日期都有有效数值。
此模式仅支持 `match=any`，共同日期查询仍使用 `dimension=dates`。
升级须同步 Agent、前后端和实际持久配置中的 `data_available_metrics` 模板登记，
部署对应方言的 `data_available_metrics.sql`；无需建表或数据库迁移。

智能助手保留当前会话上下文（含重启恢复的消息），不同会话不共享上下文。历史数值不能直接作为本轮数值答案或计算证据，须重新取数并通过权限校验。

工具可用性在每次模型请求时同步至 pi 运行循环：可用范围查询结束后停止本轮工具；计算工具仅在本轮已有数据引用后开放。计算失败且未成功重算时，最终回复不发布模型自行推算的数值。

`AGENT_MODEL_TIMEOUT_MS` 控制单次模型请求的总时限，默认 30000 毫秒（包含生成过程），与 `BACKEND_TIMEOUT_MS` 独立。模型超时中止本轮并提示；已成功取数的结果表仍保留，不把文字生成超时报为数据库无数据。调整后重启 Agent 服务。
