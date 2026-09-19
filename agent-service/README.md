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

只输入具体指标名称时，仍交给 `metric_ask` 校验完整请求并创建正式澄清。局部目录搜索不能替代
完整指标覆盖校验；正式长名称中的“增幅、排名”保持原义，混入停用指标返回 `METRIC_DISABLED`，
不会静默执行剩余指标。连续追问引用最近成功查询，历史回读按原文明确的历史指代选择结果。

`metric_query_structured`（`/api/v1/basic-queries` 结构化快通道）能力保留，但不在普通自然语言
会话默认启用，避免绕过语义治理。

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
