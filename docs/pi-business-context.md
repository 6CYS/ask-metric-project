# Pi 通用多轮业务上下文

现有智能问数页面继续使用原 Pi Session / main lane 入口；没有新增产品入口或第二套 Agent。
Pi 理解原文、历史指代和本轮变化，业务上下文层只处理结构化 Delta。后端不再为这条问数链路调用第二次语义模型。

## 实际调用链

用户原文 → 服务端指标算法匹配 → Pi（理解目标、引用算法片段）→ `resolve_business_turn` → FrameSelector → Capability Schema → Field Resolver → Schema Validator
→ READY → `execute_business_frame` → 现有受控查询/覆盖/计算接口 → resultRef → 不可变 success Frame → Pi 交付。

NEEDS_CLARIFICATION 不调用业务数据查询，由 Pi 只针对 issues 和 candidates 提问。补充后产生新 Frame，旧字段不被覆盖。
`resolve_more` 即使字段齐全也不能执行；`reuse_result` 禁止夹带字段修改，只引用已有结果。

解析回执后的执行衔接由 `business-context/continuation.ts` 依据当前原生 Frame 约束：`READY + execute` 接 `execute_business_frame`，`REUSE_RESULT` 接 `read_business_result`。先给模型指定对应工具；若模型仍返回多余确认或错误调用，宿主把该响应转换为引用同一已校验 Frame 的原生工具调用。调用继续经过原生工具门禁、权限、幂等与日志，不直接绕过工具执行后端。它不解析问句、不决定新目标，也不创建第二份流程状态；`resolve_more`、待澄清、模型错误/中止和业务执行尝试后不触发自动续接，不自动重试失败查询。

跨轮不能直接执行旧 Frame。`FRAME_NOT_CURRENT_TURN` 对本会话旧引用返回可纠正的 `ARGUMENT_ERROR`：先继承/引用旧条件，生成本轮 Frame，再执行。没有字段变化时 `fieldChanges=[]`；不重新提取确认话语。模型视图同时提供续接契约。

2026-09-22 衔接修复验证：Agent 219 项测试、类型检查、构建通过。`node --env-file=.env --import tsx scripts/check-multiturn-model.ts --live --handoff` 的真实模型四轮通过，覆盖查询、改日期、重开会话后换指标、历史结果回读。使用合成目录与取数桩，前三轮各查询一次，最后一轮仅回读一次；第3轮曾发生日期原文参数错误，原状态保留并在同轮纠正。模型调用耗时仍存在，未将此验证作为业务数据库或浏览器验收。详见 [验证记录](verification/business-handoff-2026-09-22.json)。

## 工具与能力

| 工具 | 契约 |
| --- | --- |
| resolve_business_turn | capabilityHint、baseReference、fieldChanges、executionMode；身份和会话标识由宿主绑定 |
| business_context_read | 读取 Schema、焦点、分页历史和单个 Frame，不读取整张历史结果表 |
| execute_business_frame | 仅接受本轮 READY 的 frameId，服务端从 Frame 构造标准参数 |
| read_business_result | frameId、offset、limit；复查当前权限后读取已有快照，不重新执行指标查询 |
| catalog / read | 目录浏览、旧任务结果兼容读取与 Pi 原生历史查阅 |
| Pi 最终回答 | 依据工具事实直接组织正文；不额外调用 answer_present |

三个 Capability：`metric_query`（取值、区间序列、排名）、`data_availability`（指标/日期覆盖）、`metric_calculate`（受控表达式）。
知识读取和能力边界说明仍由原工具提供，知识不改变工具权限。

通用算法位于 `agent-service/src/business-context/core.ts`；能力字段及交叉约束位于 `capabilities.ts`，
字段解析位于 `resolvers.ts`，参数映射位于 `adapters.ts`。新增字段注册 Schema/Resolver；新增业务工具注册适配器，
不修改 Frame、Selector、Merge 或 Validator 的核心循环。

## 事实与校验边界

系统提示词、工具参数说明与 Schema 均以“仅提交本轮变化”为前提，未变化的日期/机构不能按历史原文重新 set。焦点视图区分 currentTurn：本轮 READY 给执行动作，历史 READY/待澄清给本轮续接契约。模型发送副本保留历史解析的字段、状态和引用，去除过时的 next_action、arguments 与指令 message；本轮回执与原始会话记录不变。历史助手的确认或错误解释不作为新的执行约束。业务知识中的名称映射以目录解析结果为准，不与高置信度自动采用规则冲突。

此轮提示词调整后，223 项自动测试、类型检查与构建通过。基础提示词及加载正式业务知识目录的两组真实模型四轮回归均通过：各轮一次解析后执行/回读，没有重填历史日期的参数错误；取数各一次，历史回读不重查。测试使用合成后端，加载目录不代表模型逐项读取了业务知识正文。详见 [提示词与上下文验证记录](verification/prompt-context-2026-09-22.json)。

- 指标由后端 `/api/v1/business-context/metric-mentions` 直接匹配宿主绑定的完整用户原文，每轮只解析一次。Pi 新指标传 `{fromQuestion:true}`；涉及排除或替换时用从 1 开始的 `mentionIndexes` 引用算法片段，不自行切分或纠正名称。机构仍提交原文名称；候选确认通过 `resolve-field` 重新核对目录。
- 指标唯一完整名称/别名命中，或完整片段算法相似度的唯一最高分达到 95%，返回 resolved 并直接采用。低分、不同编码并列最高、同名/同别名多项仍需澄清，不能截断后当唯一命中；机构沿用原精确匹配与候选确认规则。
- 确认上轮候选使用 `{candidateIndex}`。序号仅选择当前父 Frame 的候选，确认原文由宿主绑定且必须来自新回合；重新查询目录后才接受业务值。旧 `sourceText` 参数兼容读取但不参与校验，防止模型误填上一轮名称导致确认失败。
- 日期直接复用后端 `parse_time_expression`，业务日期按 Asia/Shanghai 取得。省略年份的日历表达继承同年历史标准日期的年份；明确相对今天的表达仍以当前业务日期计算。已有季度、半年、近期等规则继续有效；latest 等无确定起止日期的状态保持 invalid，不猜测数据日期。
- 日期、指标或机构表达必须来自本轮原文，继承则使用服务端已保存的字段。Pi 不能自行换算最终日期或提交伪造编码。
- 所有已提供但未确定的字段均阻止执行，包括可选筛选条件；不以丢弃条件扩大查询范围。
- 计算 bindings 必须引用本轮成功查询的 fact_id，解析时重新核对快照、scope、权限和截断情况；计算后端仍复查完整性、单位、表达式及常量。
- 当前结构化查询继续使用原后端的目录、权限、SQL builder 与参数绑定，不增加模型 SQL。
- 不在多轮核心中按自然语言关键词、具体指标或机构名称分支。日期文法只属于 DateResolver。
- 枚举值拼写等工具参数错误返回 `ARGUMENT_ERROR`，不落盘为待澄清焦点；Pi 同轮修正。真实业务缺项/歧义继续澄清，不向用户展示内部枚举。
- 已有指标字段时，新 `set` 必须有本轮算法片段；无片段返回 `METRIC_MENTION_NOT_FOUND` 并保留焦点/候选。它不自动执行旧指标：模型须区分继续查询与未匹配的新目标。新问题无片段仍保存 `not_found`；有低分候选的替换正常保存并澄清。旧名称参数必须来自本轮原文，历史名称不能伪装成新输入。所有调用契约错误均在保存新 Frame 前拒绝，机构和日期的原文校验同样保留。

指标算法采用 HanLP 独立 Trie、拼音倒排和 RapidFuzz，完整名称优先，近似匹配按上述 95% 规则确定或返回候选。
算法、基准与离线部署边界见 [指标匹配方案](metric-matching.md)。

## Frame、历史及焦点

Frame 包含 sessionId、turnId、requestId、capability、字段状态及来源、parentFrameId、operationFrameId、issues、resultRef、摘要。
字段为字典，记录 explicit/inherited/confirmed、resolver 和 sourceFrameId。
ready、executing、success、failed 分别追加新快照。一次用户业务操作的根 ID 稳定，执行状态快照不占用历史操作序号。

`baseReference=null` 表示独立问题；省略表示当前焦点；对象表示明确历史选择。
selector 支持 frameId、从 1 开始的 ordinal、0 为最新的 relativePosition、capability、businessConstraints、resultRequired。
条件取交集，无法唯一确定必须澄清。结果引用允许从同一次操作的 READY/executing 快照定位其 SUCCESS 快照，不跨操作猜测，也不修改原 Frame。constraints 比较已保存的原始值、标准值或编码，不做自然语言相似猜测。
failed/executing 不自动继承，不从失败操作静默回退到旧成功条件。跨能力只继承 Schema 明确许可的字段。

## 持久化、并发及结果

沿用 Pi `JsonlSessionRepo`，命名空间为 `askmetric.business.v1`。不增加数据库表或迁移，不依赖进程内单例。
`Session.mutate` 在同一事务写入 Frame、操作索引、focus、session version 和幂等键。
CAS 冲突返回可识别错误；同一次请求的等价 Delta（包括字段顺序变化）复用原 Frame。
完成较旧执行只追加快照，不覆盖已切换的新焦点。

后端查询/计算继续使用稳定幂等键。超时或 5xx 无法证明业务失败，保留 executing；原 Frame 重试沿用原键。
后端明确失败创建 failed Frame。部署仍要求一个数据根只有一个写实例，不能把本实现视为多主节点共享文件方案。

取值结果引用后端不可变快照；覆盖/计算完整回执单独保存在 Pi result values，不放入 Frame。
结果引用组件进行 URL 编码，允许现有 `result:task-id` 格式。历史查询支持分页。
查询快照读取复查后端权限；覆盖快照读取重新检查当前目录及机构授权；计算快照读取重新检查各输入任务的当前权限和有效期。
结果随会话生命周期管理，删除原生会话同时删除 Frame 和本地结果快照；后端快照仍遵循已有期限与清理规则。

历史新工具的模型发送副本仅保留 Frame/结果引用、行数、分页和截断标记，移除行值、facts、覆盖列表和计算金额。
不反复解析历史整张业务结果来还原当前条件；焦点来自独立业务 values。原生会话历史不改写。

## 可观测性

`business_frame` 日志记录 session/turn/frame/parent、capability、状态、字段来源、Resolver、问题原因及结果引用。
完整原文、字段值及候选保留在按用户隔离的业务状态中，不写入公开日志。
原工具审计保留 proposed/admitted/blocked/executed 及参数指纹，现有耗时日志覆盖解析和执行工具。

## 验证与验收边界

### 对照方案的实现落点

| 阶段 | 实现 | 本地验证 |
| --- | --- | --- |
| T1 Frame 基础设施 | types/store/service；原生 Session 事务保存、不可变快照、焦点、版本与幂等 | 重启、并发冲突、重复执行、旧执行完成不覆盖新焦点 |
| T2 Schema 主流程 | core/capabilities；通用合并、继承、清除与执行门禁 | 缺项及可选错误字段阻断；新增合成字段不改主流程 |
| T3 字段解析 | resolvers 与后端 resolve-field；目录和原有日期文法 | 精确、别名、同名歧义、候选确认后重新授权、异常 |
| T4 Pi 接入 | 原 Harness 和 businessContext 工具接入 Delta/Selector | 现有入口闭环、连续澄清、历史分支；真实模型连续多轮及候选确认脚本 |
| T5 结果引用 | 原后端查询快照、原生结果 values、read_business_result | 分页、权限撤回、不重复取数、历史模型上下文裁剪 |
| T6 回归与可观测性 | context.spec、后端 verification、语义改写脚本、结构化 trace | 离线回归、防特判与真实模型合成数据验收；正式数据另行验收 |

### 2026-09-21 复核发现及调整

| 方案要求 | 原实现问题 | 调整 |
| --- | --- | --- |
| 第 6/28 节：Pi 决策并生成回答 | 宿主强制交付、模板替换和补救调用覆盖 Pi | 删除宿主旧路由和回答接管；保留原生会话、鉴权、门禁和诊断 |
| 第 16/19 节：Resolver 确定事实，按 Schema 继承 | 日期原文规则与历史年份解析不配套 | DateResolver 将可信历史年份交给后端；多个参数错误一次反馈，不切换焦点 |
| 第 21 节：只询问缺失部分 | 确认后焦点丢失，待澄清仍重复工具调用 | 候选记录来源回合；澄清阶段仅生成文本并设置工具门禁 |
| 第 24/25 节：按引用复用结果 | READY 引用找不到随后生成的 SUCCESS 结果 | 依据同一 operationFrameId 定位完成快照并复查权限 |
| 第 44.5 节：控制上下文与性能 | 完整字段溯源和重复状态读取反复进入模型 | 紧凑 Schema/焦点、历史结果引用、当前轮分页读取；计算必要 Schema 一次提供 |

`harnessHost.ts` 是 Pi 原生运行的接入层，不是另一个 Agent。删除的旧逻辑包括强制旧澄清工具、旧追问来源选择、回答证据补救与正文拼接。字段选择、合并与校验在 business-context；语义选择与最终回答由 Pi 负责。

### 复现命令

- Agent：`npm run typecheck`、`npm test`、`npm run build`。
- 多轮单测：`npm test -- src/business-context/context.spec.ts`，使用临时 JSONL 与合成后端。
- 后端：`.venv/bin/python -m pytest -q verification/test_business_context.py tests`。
- 连续多轮真实模型：`node --env-file=.env --import tsx scripts/check-multiturn-model.ts --live`。使用合成目录与结果、真实 Python 日期解析；覆盖换机构、无年份月份、必要口径澄清、历史复用、重开分支及缺项补充。
- 候选确认：`node --env-file=.env --import tsx scripts/check-confirmation-model.ts --live`。
- 受控计算：`node --env-file=.env --import tsx scripts/check-skill-model.ts`。使用真实模型、合成事实与真实 Python Decimal 表达式引擎。
- 前端：`npm run typecheck`、`npm test`、`npm run build`。

前两种真实模型脚本不加 `--live` 只校验测试定义，不发起模型请求。测试报告明确区分真实模型、合成事实和真实业务数据库。
真实模型存在延迟及参数生成波动，不能用一次成功或离线测试宣称所有自然语言问法稳定。

### 实际验证结果

- Agent：26 个文件、197 项测试通过；TypeScript 类型检查与构建通过。
- 后端：285 项本地测试通过；新增字段解析接口、实现和回归文件的 Ruff 检查通过。保留两条依赖弃用警告。
- 前端：17 项测试、类型检查与构建通过；构建仍提示大于 500 kB 的分包。
- 真实模型连续七轮通过：五轮各取数一次，缺项澄清零取数，历史复用一次回读且零取数；每轮不超过两次业务工具调用，没有回答补救或额外交付调用。单轮耗时约 11～35 秒。
- 九种语义改写通过：前八种首次通过，第九种因同值 set 与 retain 的测试等价判定过严，修正断言后单独复验通过；未为此修改生产逻辑。
- 两种候选确认通过：确认前零取数，确认后各一次解析、一次执行。
- 取数后计算通过：一次取数、一次 Decimal 计算；总耗时约 78.5 秒，其中模型约 78.4 秒，业务工具约 0.13 秒。包含一次参数修正；不据此声称模型延迟已解决。
- 本地后端 8011、Agent 8020、前端 127.0.0.1:5173 已重启，健康及就绪、前端代理均返回 200。
- 浏览器只核验登录页。未验证登录后的界面交互、真实业务数据库或生产环境。

机器可读记录见 [验收记录](verification/pi-context-2026-09-21.json)，同时保留前几次真实模型失败记录。合成数据测试不代表真实业务数据正确性，单轮成功也不证明所有改写稳定。

## 升级与回退

配套升级后端、Agent 和前端。新增接口要求后端先就绪，再切换 Agent；不新增依赖，也不自动执行数据库 DDL。
升级前让活动回合结束。旧自然语言查询工具不再对新回合开放，旧未完成查询不得绕过 Frame 门禁继续执行。
已有旧查询结果仍可通过 read 回放；旧会话没有 Frame 的历史条件不会被静默导入成可信状态，重新提供条件建立首个 Frame。

回退前结束活动回合，恢复配套版本并保留整个 AGENT_DATA_DIR。旧版本不能理解新 Frame 工具语义，应新建会话继续；
已保存的后端结果无需数据回退，原生历史文件不要删除或改写。
