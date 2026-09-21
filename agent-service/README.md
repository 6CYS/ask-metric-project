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
- `POST /sessions/{id}/prompt`：提问，SSE 事件流。请求体为 `{protocol_version: 3, request_id, message, clarification_target?, selected_answers?}`；`request_id` 由浏览器每次确认发送生成，重试不变。旧协议请求返回 `CLIENT_UPGRADE_REQUIRED`。
- `GET /sessions/{id}/stream`：只读观察流（断线重连：快照 + 实时事件），不接纳新输入。
- `POST /sessions/{id}/cancel`：显式停止指定 operation（原生 requestAbort）。

SSE 事件：`accepted`（含快照）、`snapshot`、`tool_start`、`tool_end`、`run_terminal`
（分开表达 `run_status`/`answer_status`/`business_tasks`）、`error`；公共字段含
`protocol_version`、`session_id`，提问流另含 `operation_id`、`request_id`。
模型原始 `text_delta` 不直接交付；基础问数、澄清、目录总览和结果回读通过工具回执生成正文，
并经最终快照同步。普通成功继续原生循环，支持后续补查和计算；待澄清及不可继续的失败才结束本轮。
多条业务证据由 pi 调用 `answer_present` 选择本轮引用与顺序，正文原样取自工具回执；
未解决失败不能省略，中间目录/覆盖结果不自动拼接。最终快照对未选择的回执标记
`answer_selected: false`，前端保留执行日志但不渲染其业务正文和表格。单条证据允许直接交付。
`run_terminal.timings_ms` 在提问流中记录鉴权、外层模型、工具和总耗时；这些不等于页面可见耗时。

刷新或传输中断后，前端通过 GET 观察原会话，不重新 POST 问题。已认证 GET 会接管原生未完成
operation；是否存在 `current` 不能用来判断当前进程是否已有执行器。恢复仍使用原 request 和
各业务阶段的幂等键。普通文本由会话语义判断独立查询、追问或补充；只有当前缺项的纯目录选择携带 `clarification_target` 和 `selected_answers`。输入框不提供手动切换新问题的开关；旧 `send_as` 字段返回 400，需要同步更新前端。

除 `/health` 外均需 `Authorization: Bearer <后端访问令牌>`，身份每次请求经后端
`/api/v1/auth/me` 校验，不使用短期缓存。会话以原生 JSONL 持久化在
`AGENT_DATA_DIR/native-v1/u_<身份哈希>/`（默认 `./data`，生产为 `/var/lib/ask-metric/agent`），
重启后恢复；同一数据根只允许一个写实例（启动时 PID 锁保护）。用户令牌只保存在内存。
旧格式 JSON 会话（`AGENT_DATA_DIR` 根目录的 `*.json`）保留只读展示，不可续跑、不再写入。

## Agent 工具

默认工具由 pi 根据目标选择：

- `answer_present`：选择当前原生用户回合的 `evidence_refs`，返回 `business_answer_v1` 并结束。引用由原始分支记录投影，历史结果须先回读；没有自由生成数值的参数。

- `data_availability`：通过 `/api/v1/data-availability` 查询指定机构与可选日期范围内有记录的指标名称（`dimension=metrics`）或日期（`dimension=dates`）。指标发现不要求先指定指标；机构编码必须来自正式目录或已确认工具回执。后端继续校验目录、当前用户权限并执行只读模板 SQL。
- `metric_catalog_overview`：介绍启用指标目录、数量和名称示例，不代表某机构或时期实际有数据。指定机构或时间的覆盖问题不能用全目录概览代替。
- `metric_catalog_search` / `org_catalog_search`：确认正式实体编码，语义近似推荐不能直接锁定编码。
- `metric_query_structured`：pi 已确认指标编码、机构和绝对日期时调用 `/api/v1/basic-queries`，适用于覆盖查询后选定指标继续取数。返回真实任务版本与结果引用，支持后续回读；后端保留目录、权限和查询能力校验。区间全部数据用 `all_in_range`，不自动缩为今天或最后一期。
- `metric_ask`：基础自然语言取值及任务澄清。`new` 提交本轮原文；`clarify` 补充正式待澄清任务；`followup` 引用已完成任务修改条件；`clarify_context` 询问有歧义的历史来源。不把归因、异常、预测、血缘或指标发现交给此入口分类。
- `metric_read` / `session_history_read`：按用户权限读取正式结果、任务状态及当前会话历史。
- `business_capability_explain`：对尚未提供的归因、预测、血缘等分析返回明确能力说明并结束本轮，不自动改为取数。

覆盖回执保存实际 `request`、分页、名称和范围说明。pi 在多轮中沿用这些已确认条件，本轮明确修改优先；“我要指标名称”调整查询维度，“下一页”只调整页码。覆盖回执没有问数任务 ID，不可编造引用。结果正文由回执生成，实时、刷新和历史展示共用同一投影。

结构化基础取数的成功结果（指定日、区间最新值、区间全部记录）也可作为 `metric_ask` 追问来源。后端从正式执行条件恢复语义槽位，兼容旧任务，无需改写历史或迁移数据库；仍校验来源归属、会话、版本、启用目录和当前权限。结构化排名的范围机构与语义排名候选集合含义不同，暂不自动转换。明确月末日期使用 `exact` 和月末当天，不自行倒退或扩展查询范围。此修复需同时更新并重启后端与 Agent；原失败轮保留原记录，新轮重新查询。

归因、异常洞察等目标由 pi 判断所需能力；当前未注册相应分析工具时明确说明限制，不以普通取值冒充完成分析。后端基础问数不再调用高层 `intent_routing`，只进行提槽、目录/日期/操作校验、澄清和执行。未知或不支持的操作保留并拒绝，不能删除后执行普通查询。

升级需重启后端和 agent（`npm run build` 后使用 `npm start`，开发模式由 watch 加载）。无需数据库迁移或删除历史。旧会话与旧任务只读兼容保留。后端持久 prompts 中的 `intent_routing` 已退役且加载时忽略；自定义 `slot_extraction` 必须同步基础查询边界，保留业务模型配置与密钥。

## 模型输入与用量诊断

每次发送前使用 pi 原生 `transform_context` 投影过去已成功且有完整正式条件的结果回执，
省略历史 `rows/sample_rows/comparisons/facts`、格式化答案和对应 assistant 正文，保留结果引用、正式条件、目录、告警和分页信息。
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
可明确指定日期范围或 `page`、`page_size` 继续查询。成功后按用户完整目标判断是否需要后续工具，
不得通过改年份、删条件或拆指标扩大范围重试。下一次提问可结合当前会话条件继续查询。
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

业务工具完整提供给 pi，由 pi 根据问题、上下文和工具契约选择。业务知识是否读取不影响工具可见性或执行权限。
计算需要本轮事实引用，后端复核归属和权限。计算失败且未成功重算时，最终回复不发布模型自行推算的数值。

`AGENT_MODEL_TIMEOUT_MS` 控制单次模型请求的总时限，默认 30000 毫秒（包含生成过程），与 `BACKEND_TIMEOUT_MS` 独立。模型超时中止本轮并提示；已成功取数的结果表仍保留，不把文字生成超时报为数据库无数据。调整后重启 Agent 服务。

## 原生业务 skill 与受控计算

运行入口按需提供指标查询、数据覆盖、结果计算及分析能力边界四类 skill，普通成功回执不再自动终止整个问题。计算使用后端事实引用并复核权限；尚未支持的分析通过能力说明回执结束，不替换为取数。职责、发布文件、兼容与验收见 [说明](../docs/business-skills-runtime.md)。

业务 skill 仅承载指标、日期、范围、计算和能力边界等业务知识，不声明工具依赖或切换工具集。pi 可直接调用工具，也可按需读取多份知识；当前版本正文去重后进入系统上下文。压缩移除正文后可按需查阅，旧版本正文只在发送副本中标记失效，原生历史不改写。正式编码来源、任务归属、权限、参数和计算事实范围仍由工具及后端独立校验。

自动化回归使用 `npm test`。以下探针使用 `.env` 中配置的真实模型和隔离合成后端，会产生模型调用费用，但不连接业务数据库；验收报告输出到临时目录，不能替代真实数据库和页面验收：

```bash
node --env-file=.env --import tsx scripts/check-skill-regressions.ts
node --env-file=.env --import tsx scripts/check-skill-model.ts
```

修改 skill 文件后需重启 Agent；发布时先让活动操作完成，再同步切换代码和方法快照。无需清空历史或执行数据库迁移。

工具动作、执行前后审计、压缩恢复及真实多轮验收说明见 [工具调用治理与验收](../docs/tool-call-governance.md)。
