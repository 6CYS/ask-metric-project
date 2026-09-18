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

SSE 事件：`accepted`（含快照）、`text_delta`、`tool_start`、`tool_end`、`message_done`、`run_terminal`
（分开表达 `run_status`/`answer_status`/`business_tasks`）、`error`；公共字段含
`protocol_version`、`session_id`、`operation_id`、`request_id`。

除 `/health` 外均需 `Authorization: Bearer <后端访问令牌>`，身份每次请求经后端
`/api/v1/auth/me` 校验，不使用短期缓存。会话以原生 JSONL 持久化在
`AGENT_DATA_DIR/native-v1/u_<身份哈希>/`（默认 `./data`，生产为 `/var/lib/ask-metric/agent`），
重启后恢复；同一数据根只允许一个写实例（启动时 PID 锁保护）。用户令牌只保存在内存。
旧格式 JSON 会话（`AGENT_DATA_DIR` 根目录的 `*.json`）保留只读展示，不可续跑、不再写入。

## Agent 工具

默认五个工具（普通自然语言会话）：

- `metric_ask`：受治理问数的三种动作。`new` 提交新问题（提交→提槽→条件齐全则查询）；`clarify` 把用户本轮补充精确提交到原任务的澄清（同 task/version/clarification_id，受控版本刷新最多一次）；`followup` 引用一笔已完成查询做单字段机构或日期替换（后端 `query_reference` 校验后创建新任务）。
- `metric_read`：只读任务状态（`kind=task`）或分页读取不可变结果（`kind=result`，默认 20 行、最多 100 行）。
- `session_history_read`：原生分支历史回读（list/entry，跨压缩条目，只读当前分支祖先）。
- `metric_catalog_search` / `org_catalog_search`：正式指标/机构目录检索，委托后端受治理检索接口按确定性命中排序；只有 exact/contains/lexical 命中可锁定编码。

`metric_query_structured`（`/api/v1/basic-queries` 结构化快通道）能力保留，但不在普通自然语言
会话默认启用，避免绕过语义治理。

幂等：业务命令键由（owner+session+request+业务负载）指纹派生，同一 operation 只接纳一个独立
写意图，第二个不同写意图返回 `TURN_QUERY_LIMIT`；提交/澄清/执行各阶段使用稳定派生键，
不使用随机键。成功执行的重放从后端 ResultArtifact 回读完整明细，不重跑 SQL。
