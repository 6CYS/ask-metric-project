# Ask Metric 智能助手服务

基于 pi agent harness（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）的问数代理服务。
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

## 接口

- `GET /health`：健康检查（无需鉴权）。
- `POST /sessions`、`GET /sessions`、`GET /sessions/{id}`、`DELETE /sessions/{id}`：会话管理；历史消息含工具结果明细（结果表、`task_id`、澄清结构），供前端还原表格与导出。
- `POST /sessions/{id}/prompt`：SSE 事件流（`text_delta`、`tool_start`、`tool_end`、`message_done`、`done`、`error`）。

除 `/health` 外均需 `Authorization: Bearer <后端访问令牌>`。会话以 JSON 文件持久化在
`AGENT_DATA_DIR`（默认 `./data`，生产为 `/var/lib/ask-metric/agent`），重启后恢复；
用户令牌只保存在内存，恢复会话的首次提问按当次请求令牌重建后端客户端。

## Agent 工具

- `data_availability`：查询授权范围的数据可用日期、所选组合的覆盖情况及共同日期；具体名称先经目录检索确认。
- `catalog_overview`：介绍可查询哪些指标或机构，一次读取受权限约束的目录摘要。

- `metric_ask`：提交问题→语义解析→执行查询的完整受治理链路（`/api/v1/questions` + `/analyze` + `/execute`）。
- `metric_catalog_search` / `org_catalog_search`：正式指标/机构目录检索（`/api/v1/catalog/...`）。
- `metric_query_structured`：用正式编码和明确日期调用 `/api/v1/basic-queries`。
- `metric_calculate`：将当前提问的数据引用与表达式交给后端计算，页面直接展示结果及来源。

目录概览调用 `GET /api/v1/catalog/overview?catalog=metrics|organizations&limit=8`，
示例上限为 20。它不接受搜索词；具体名称使用目录检索工具，取数使用查询工具。
纯目录概览由前端根据工具结果生成中文介绍，实时与历史共用；组合取数任务仍继续执行，
不会因概览强制结束。概览不证明某机构、日期存在数据，也不推断分类、更新频率或覆盖期。
后端 `CATALOG_OVERVIEW_METRIC_CODES` 可配置代表性指标，详见后端 README。
升级需同步后端、Agent 和前端，无数据库迁移；旧历史缺少概览结果时保持原展示。

同一会话的消息和工具结果交给 harness 理解追问，沿用已确认条件，本轮明确条件优先；调用后端时提交完整问题。待澄清任务按任务与澄清编号补充。Agent 会话与后端会话关联，删除和自动
清理同时清理后端结果，失败可重试。参数、限制和升级说明见
[通用表达式计算工具](../docs/calculation-tools.md)。

目录澄清支持一次选择多个指标：前端向 `/sessions/:id/prompt` 传入 `message`，并可附带
`clarification: { clarification_id, entities: [{ kind, code, name }] }`。服务端核对当前澄清编号及
名称仍在正文中，再将选择按追加方式交给后端，后端继续校验正式目录和查询权限。
旧客户端仅传文字时仍支持多个明确指标；已确认条件保留，只追问剩余缺失条件。
过期澄清编号返回 409，需重新加载会话。收到待补充结果后，本轮停止提供工具给模型，
仅整理回复；同一轮重复提交补充复用结果，下一轮恢复工具。升级时应同步前端与 Agent，
并更新后端的多指标文本澄清逻辑，不涉及数据库结构变更。

模型调用收尾后只发送一个终态：成功为 `done`，失败或空回答为 `error`。历史助手消息附带面向用户的 `error` 提示（如有），不向前端透传原始异常或思考内容。

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
页面兼容过滤旧回复中已知的该类提示。

问数时间下方、回复正文上方的“执行过程”默认折叠，执行中在同一位置显示当前阶段，
完成后显示用时；展开后按调用开始顺序展示中文步骤名称（不显示英文工具标识）、
执行状态和已记录的工具耗时；同名工具多次调用分别展示。此处展示实际工具记录，
不展示模型内部思考、原始调用参数或完整工具响应。原有耗时和调试入口继续保留。

SSE 的工具事件附带 `callId`，结束事件附带 `elapsedMs`；历史接口通过
`tool_calls`、`call_id` 和 `elapsed_ms` 恢复记录。工具耗时随现有会话 JSON
在本轮收尾时保存，不新增数据库表。旧会话缺少的耗时不补造，缺少结果的调用
显示“未记录执行结果”；本轮总耗时仍以页面已有测量为准，旧历史不推算总耗时。

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
