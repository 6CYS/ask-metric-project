# Ask Metric 智能助手服务

基于 pi AgentHarness 原生运行时（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）的问数代理服务。
pi 是唯一的 Agent 运行与对话控制核心：会话、模型上下文、压缩、执行状态与恢复全部使用原生能力
（`JsonlSessionRepo` + `main` lane）；本服务承载鉴权、可信输入绑定、原生接线、Schema 驱动的业务 Frame 及页面投影。

普通文本问数使用下文的直接工具循环（`inquiry_v1`）；结构化请求保留 `semantic_v2` 兼容路径。
`fixed_v1` 协议及 `AGENT_BUSINESS_PROTOCOL`、`AGENT_COMPACT_TURN_ARGS` 配置已退役，不再是配置回退选项；
旧 fixed 会话保留历史消息、工具回执与结果展示，仅只读查看，继续提问返回明确的只读状态，在途旧操作不再自动恢复。
问数与多轮上下文的当前实现见[实现说明](../docs/pi-semantic-task/implementation-multiturn-context.md)，对话验收契约见[研发说明](../docs/问数与多轮上下文重构研发说明.md)。
历史结构化链路的实现及回退见[阶段4说明](../docs/pi-semantic-task/implementation-phase4.md)。
Agent 的业务取数只调用 FastAPI 后端受治理接口并透传用户 Bearer，目录校验、权限裁剪、
SQL builder 生成和执行与受控计算全部保留在后端；本服务不生成或执行 SQL；Frame 仅保留字段、结果引用和摘要，结果快照按需读取。

当前普通文本问数使用直接工具循环：`metric_search` 找正式指标，`metric_query` 查询，
模型根据真实差异决定是否补查，用 `analysis_calculate` 比较已取到的同指标事实，
用 `analysis_chart` 选择已有来源配图，再直接撰写正文。
宿主通过内部 `analysis_answer` 校验正文与图表。它不再经过
计划、Frame 许可和多层报告修复；工具内部仅生成当前批次执行所需的后端参数。
`analysis_read` 只能读取当前分支中出现过的运行，后端重新核验权限和会话归属。
结果计算只提交被比较与参照事实的引用；跨机构须同日，跨日期须同机构。后端复用已有
Decimal 计算与回执存储，报告重新核对全部输入来源，不重复查询，也不接收任意公式或手填业务值。
当前支持原值差额及现有计算器支持的金额增幅；比例编码不明时不可计算，零或负基期不输出相对增幅。
算术比较不证明机构贡献或业务原因，贡献仍需正式汇总关系。升级时先部署后端再部署 Agent；
旧报告请求省略新增的 `calculation_refs` 字段即可继续使用，无需数据库迁移。
指定统计期没有数据时，`metric_availability` 按已授权指标和机构读取真实可用日期；报告中引用的日期
由后端重新查询确认，只用于说明，不替换原统计期，也不生成金额或排名依据。
取数和日期发现统一使用 `scope=named` 配合 `org_names`（名称、别名或正式编码），或用 `all_banks` 查询有权农商行集合。
模型依据本轮问题、账号资料和已授权历史明确选择机构；工具不再按历史第一/最后一笔查询或账号自动选取。
旧 `current` 参数不再执行，可按参数反馈修正后继续；旧会话仍可读取。历史集合只保留语义，下次查询重新解析权限与签名。
已查到数据后的自由正文直接接到同一报告校验工具，不再额外调用模型包装正文。

完整证据留在原生回执，模型只接收保留引用的紧凑表格、定义及缺口；未知单位或比例编码
不提供可误用的数值引用。分析方法通过已有 `business_skill_read` 按需读取。
最近已完成回合先重新核验权限，再保留问题与正式回答；来源条件单独放入模型参考资料，
不追加到历史助手正文。中间目录与纠错过程不再挤掉整轮上下文，本轮调用保持完整。
默认保留最近三轮；更早的回指通过已有 `session_history_read` 分页定位和分段读取，
`analysis_read` 再从当前分支成功回执定位来源、复核原回合权限并向后端重读，返回本轮引用。
历史正文仅帮助找回条件和运行身份，不代替可交付事实；不扩大常驻历史窗口。
追问默认沿用已确认的实际统计期；不同指标原本日期
不同时分别保留，不能静默换成最新数据或拼成同日比较。
首次取数采用后端已解析的原文明确日期；目标期查空后可另查参考期，但保留原目标缺数回执。
已有本轮证据时通过报告出口交付，预算内仍可定向补查；走错普通回复出口不占报告正文的修正次数，总工具预算仍有效。
报告数值错误最多修正一次；正文持续失败时丢弃草稿，由后端核验已有来源并交付事实或缺数说明，
不额外调用模型或重复取数。查询成功但原始结果确实为零行时，保留已核实的缺数说明；
单位不明、解析失败或接口报错不视为没有记录。跨机构比较使用分别授权的来源，报告层不要求机构集合互相包含。
鉴权失败立即停止，无法完成的回答如实交付未完成状态；数值校验不等于证明业务因果。
取数后的模型终态异常复用已有部分交付工具：保留现有重试顺序，仅对本轮新查询重新授权并渲染事实，
明确分析尚未完成。该内部动作不向模型开放，不追加查询或模型请求；仅有历史结果、未解决的来源错误、
用户取消和上下文溢出不自动转成事实报告。重新核验失败时不输出缓存数值，并保留服务错误类别。

每个请求持久化 `executionFlow=inquiry_v1`，升级前在途操作和结构化澄清点击仍走原路径。
后端 `execution_mode=inquiry` 只允许分批覆盖问题，指标签名、权限、范围、幂等和取消不变。
无需数据库迁移或新依赖。原 Frame 链路的说明保留在 [通用分析底座实施说明](../docs/通用分析底座实施说明.md)。

## 本地运行

普通问数先按本轮原问检索已有业务知识，取数后按本轮实际指标补充相关资料，不自动续接上一轮主题。
资料不足时，模型可在取数前使用 `business_knowledge_search`，结合本轮问题及已授权历史明确检索主题。
两条入口复用现有检索接口，每次最多 3 条、总计 8000 字；显式检索计入调查预算，不要求每问调用。
本轮知识保留供模型继续调查，旧轮正文不带入下一轮；新轮读取当前启用内容。只取相关正文，不复制候选目录或助手草稿。
知识用于分析方法，不能替代正式口径和事实。取数与配图共用正式来源，补查仍按当前权限执行。
分析主动配有助理解的图；两个机构同日同指标的数据也可自动生成比较柱图，简单单值不强制绘图。
表格与图表可以同时交付；仅在明确只要文字、表格或不要图时抑制配图。
旧报告仍按原结构兼容显示。

```bash
npm ci
cp .env.example .env   # 按需修改
npm run dev            # 默认 127.0.0.1:8020
```

常用检查：`npm run typecheck`、`npm run build`、`npm run test`。

## 配置

见 `.env.example`。默认示例指向 DeepSeek 官方 OpenAI 兼容接口
（`AGENT_MODEL_BASE_URL=https://api.deepseek.com`、`AGENT_MODEL_NAME=deepseek-flash`）；
`AGENT_MODEL_API_KEY` 需填入 DeepSeek API Key，支持 `ENC[SM4:v1:...]` 密文，格式与后端
`backend-next/src/ask_metric/core/config_crypto.py` 一致，主密钥经
`ASK_METRIC_CONFIG_SM4_KEY_FILE`（推荐）或 `ASK_METRIC_CONFIG_SM4_KEY` 提供。
如改回行内网关，同步调整 `AGENT_MODEL_BASE_URL`、`AGENT_MODEL_NAME` 与
`AGENT_MODEL_EXTRA_BODY`（官方接口的 thinking 开关与部分网关的 `enable_thinking` 不同）。

行内模型使用 `accessKey` 鉴权时，设置 `AGENT_MODEL_AUTH_HEADER=accessKey`、
`AGENT_MODEL_AUTH_PREFIX=`；密钥仍由 `AGENT_MODEL_API_KEY` 提供。接入层同时把密钥交给
原生 SDK 并按配置发送鉴权头，自定义头模式不会额外发送默认的 `Authorization: Bearer`。
后端合成模型检查通过后，还需验证 Agent 的实际提问；两者使用不同的模型调用实现。

业务工具的通用 JSON 值通过 `anyOf` 分别声明字符串、数字、布尔、空值、对象和数组，
兼容 Outlines 网关对工具参数的解析；保留原字段描述和服务端业务校验。
接入验证需携带完整工具定义并覆盖实际使用的 `tool_choice`，简单工具样例不能替代这项验证。

`AGENT_MODEL_TOOL_CHOICE_POLICY=native|auto` 默认 `native`，保留宿主要求的工具选择策略。
部分兼容服务在 `required` 模式返回错误而 `auto` 可用时，可显式配置 `auto` 并重启 Agent。
该配置只调整模型请求参数，严格工具 Schema、任务许可、机构权限与答案证据校验仍然生效；
不能用它绕过工具调用或直接交付无证据的业务答案。

压缩配置只映射原生 `CompactionSettings`（`AGENT_COMPACTION_*`），启动时校验
`reserveTokens + keepRecentTokens < contextWindow` 且 `maxTokens < contextWindow`，不成立即拒绝启动。

旧 Frame 路径的普通取值可用 `AGENT_DIRECT_QUERY_DELIVERY=on|observe|off` 控制最后一轮模型总结：默认 `on`，
只有当前计划、全部目标、正式结果、完整性、当前授权及纯结果交付要求全部核验通过才直接交付。
分析、解释、排名、计算、未知语言要求、混合工具批次及不完整结果继续原流程；权限失败或执行未知
分别停止/回查原命令，不交给模型绕过。`observe` 记录资格但仍由Pi回答，`off` 关闭新operation直接交付。
接纳时冻结策略；版本化答案随真实工具回执持久化，关闭后仍能刷新和恢复已保存交付，不伪造模型消息。

旧 Frame 路径的 `AGENT_MODEL_CONTEXT_VIEW=compact_v1|raw` 默认 `compact_v1`：普通查询仅去除完全重复的表示；
已识别的成功分析回执采用工具生成的模型正文，完整绑定、计算及恢复明细仍保存在原生记录，
模型保留证据引用、机构日期、缺口、补查和报告依据。不兼容正文保留完整回执。
Skill 全文留在首次可见的读取回执，动态业务状态仅放在发送尾部，减少前缀缓存失效；授权校验保持实时。
`AGENT_SEMANTIC_PROMPT_VARIANT=compact_v1|full` 默认 `compact_v1`，
合并重复规则，工具集合和严格Schema不变。三项配置非法值拒绝启动，修改后重启服务。
这些旧配置不切换 `inquiry_v1` 主流程；新流程回退需恢复对应服务版本，并保留可读取新回执的历史投影。
无需业务数据库结构迁移。验收、完整性与权限边界见[Token优化实施说明](../docs/token-optimization.md)。

模型超时分两个阶段：`AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS` 控制发出请求后首次有效输出的等待，
`AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS` 控制开始输出后相邻有效输出之间的空闲时间，均默认 30000 毫秒。
非空文本、思考及工具参数增量均刷新空闲计时；响应头、开始事件、空增量不算进展。
持续输出不会因整次调用达到固定总时长而中断；首次响应超时或输出停顿（`MODEL_STREAM_IDLE_EXCEEDED`）
按既有模型重试配置重试未完成的生成，默认最多一次。截断或中断的工具参数不执行，已完成的工具不重放。
重试耗尽后重新授权呈现已有部分证据，并明确分析未完成；没有证据时保留失败状态。

旧 `AGENT_MODEL_TIMEOUT_MS` 仅在新空闲变量未设置或为空白时作为空闲时限后备，语义已从总时限改为空闲时限。
更新后重启 Agent 服务生效，无需数据库或会话迁移。回滚旧版本前核对保留的环境文件：旧版本会重新按总时限
解释 `AGENT_MODEL_TIMEOUT_MS`，且不识别新空闲变量；旧 `MODEL_DEADLINE_EXCEEDED` 历史记录仍兼容展示。

## 接口（协议 V3）

- `GET /health`：健康检查（无需鉴权）。
- `POST /sessions`、`GET /sessions`、`GET /sessions/{id}`、`DELETE /sessions/{id}`：会话管理；历史消息由原生记录投影（含工具回执引用），删除活动会话返回 409。
- `POST /sessions/{id}/prompt`：提问，SSE 事件流。请求体为 `{protocol_version: 3, request_id, message, answers?, clarification_target?, selected_answers?, time_override?}`；`request_id` 由浏览器每次确认发送生成，重试不变。旧协议请求返回 `CLIENT_UPGRADE_REQUIRED`。
- `GET /sessions/{id}/stream`：只读观察流（断线重连：快照 + 实时事件），不接纳新输入。
- `POST /sessions/{id}/cancel`：传operation_id停止指定操作，或传request_id取消尚未收到accepted的请求；两者恰好一个。

`answers` 是前端点选已发布字段问题的结构化输入，元素仅含 `question_id`、`version` 和 `choice`，不得携带模型证据、channel 或正式编码。纯点选允许 `message=""`，但必须有非空 `answers`；空文本且无回答仍拒收。实时工具回执携带 `pending_questions` / `answer_receipts`，会话详情及 accepted/snapshot 快照携带当前 `question_states`。

SSE 事件：`accepted`（含快照）、`snapshot`、`tool_start`、`tool_end`、`run_terminal`
（分开表达 `run_status`/`answer_status`/`business_tasks`）、`error`；公共字段含
`protocol_version`、`session_id`，提问流另含 `operation_id`、`request_id`。
模型原始 `text_delta` 不直接交付。Pi根据正式工具事实组织解释与分析；完整普通取值由宿主核验后复制后端正式正文，
按目标组织结构块，答案随真实回执保存并统一投影到实时、历史和最终快照。宿主不进行数值推理或另建对话运行时。
已校验的 `READY + execute` 和 `REUSE_RESULT` 必须接续原生执行/回读工具；模型在此处的提前确认响应会转换为该Frame的确定下一动作。
失败不自动重试。步骤结果可提前展示，不能把中间成功当成整轮完成。
新用户消息持久化 `businessProtocol=semantic_v2`，投影返回 `business_protocol`，历史、重连与实时正文保持一致；旧 fixed/frame 历史只读兼容。
`run_terminal.timings_ms` 在提问流中记录鉴权、外层模型、工具和总耗时，另有
`first_visible_ms`（首次发送回答正文）与 `model_first_token_ms`（各次调用首次输出）。
首字指标在服务端发送 SSE 时记录，不含网络和浏览器渲染耗时；同名字段写入 `agent_request_timing` 日志。
`agent_tool_call` 的 `executed` 和 `finished` 阶段通过 `tool_call_id` 对应实际工具执行；
`finished.duration_ms` 记录工具执行耗时，`execution_outcome` 区分 `returned`、`threw`、`aborted`。
`returned` 只表示工具返回，业务是否成功仍看正式回执；准入拒绝或参数校验失败不记录执行耗时。
这些日志只保留参数摘要，不记录工具结果或异常正文；模型等待和浏览器渲染不计入工具耗时。

一期回答流式开关 `AGENT_ANSWER_STREAMING` 默认 `false`。开启时，提问流增加
`answer_delta`（`call_seq`、`mode: text/reply`、累计 `text`）与 `answer_reset`（同调用撤回）；
仅向请求头声明 `X-Agent-Answer-Streaming: v1` 的新前端发送，旧页面继续原事件序列。
80ms 合并发送，模型结束补齐。工具调用、重试或失败可撤回临时正文，最终快照整体替换。
临时文本不参与存档、复制或导出；GET 重连流保持快照投影。关闭开关并重启 agent-service 即回退。

模型统一以 semantic_v2 版本2协议调用 `resolve_business_turn`：新查询按 `target.query` 一次提交结构化机构、指标、时间、取数方式及操作；历史继承和局部修改使用 `operations`，排序修改提交结构化 `queryOperation`。程序绑定正式身份与权限并生成既有执行参数，结构化路径不再二次解析排序描述。原生会话和业务 Frame 不改写。
协议格式见[语义任务协议](../docs/pi-semantic-task/protocol.md)。
存贷款专项及通用分析在同一入口的衔接见[经营分析扩展](../docs/pi-semantic-task/enhanced-analysis.md)。

提议的字段及类型来自能力契约，值仍由业务服务核验目录、来源和权限；机构集合和下辖范围使用固定范围结构。
参数纠错须保留同一来源及本轮全部有效变化。已核验的候选确认独立保存；未完成的修改如实保留，不能靠省略字段绕过恢复。正式指标错字的自动纠正、原文审计与排名证据校验见[确认与恢复契约](../docs/business-context-reference-recovery.md)。
空授权范围、不支持的查询组合和不支持的覆盖查询范围返回 `retryable=false`；宿主结束本轮业务动作并交付原因，下一用户轮可继续新请求。
确定失败修复和完整日期表达解析规则继续生效。

`release` 不包含开发对照脚本和测试代码；相关验证在开发分支中维护。
`answer_stream_started` / `answer_stream_reset` 日志只记录请求、调用编号和撤回原因。

刷新或传输中断后，前端通过 GET 观察原会话，不重新 POST 问题。已认证 GET 会接管原生未完成
operation；是否存在 `current` 不能用来判断当前进程是否已有执行器。恢复仍使用原 request 和
各业务阶段的幂等键。新 Frame 澄清通过现有输入框补充，由 Pi 输出结构化变化；`clarification_target` 和 `selected_answers` 仅保留旧卡片协议兼容。输入框不新增模式开关。

除 `/health` 外均需 `Authorization: Bearer <后端访问令牌>`，身份每次请求经后端
`/api/v1/auth/me` 校验，不使用短期缓存。会话以原生 JSONL 持久化在
`AGENT_DATA_DIR/native-v1/u_<身份哈希>/`（默认 `./data`，生产为 `/var/lib/ask-metric/agent`），
重启后恢复；同一数据根只允许一个写实例（启动时 PID 锁保护）。用户令牌只保存在内存。
旧格式 JSON 会话（`AGENT_DATA_DIR` 根目录的 `*.json`）保留只读展示，不可续跑、不再写入。

## 通用多轮业务上下文

默认工具：`resolve_business_turn`、`business_context_read`、`execute_business_frame`、`read_business_result`、
`catalog`、`read`、`business_skill_read`、`business_capability_explain`。

Pi 输出能力、历史引用、本轮字段目标声明、字段变化和执行意图；通用 Schema/Resolver 确定业务事实并验证 READY，
执行工具仅接受本轮 frameId。待用户澄清时，宿主按已保存 Frame 交付问题并结束本轮；新用户回合补充后产生新 Frame。
基础取值、覆盖、排名和计算均经过这条链路，原页面入口不变。
取值与排名通过独立 operation 表达，selection 只表达时间选择。机构集合由后端
`business-context/resolve-scope` 按正式层级和账号权限解析，执行前复核指纹；不使用空机构数组表示全行。

Frame 使用 Pi 原生事务 values 持久化，支持历史分支、独立焦点、CAS、请求幂等和服务重启。
取值快照复用后端 result_id；覆盖/计算快照与 Frame 分开保存。历史发送副本移除大型业务结果，
按引用读取时重新检查当前权限。

目录检索保留最多四项批量读取，失败项及近似候选不能被当作已确认字段。
旧查询工具不再向新回合提供；旧结果继续兼容只读，不重写历史。

完整契约、可复现检查、升级与回退见 [Pi 通用多轮业务上下文](../docs/pi-business-context.md)。
内部目标声明、历史字段引用、确认及恢复契约见 [历史字段引用、确认与恢复](../docs/business-context-reference-recovery.md)。
配套升级后端、Agent、前端，先排空活动回合；不增加依赖或数据库迁移。

运行阶段、计划版本、交付完成条件及恢复预算统一接入现有语义任务账本，详见[运行控制](../docs/pi-semantic-task/runtime-control.md)。业务正文从正式回执交付；目录/Skill 成功不能替代查询完成。旧会话回放沿用相同正文检查，不批量改写原记录。
