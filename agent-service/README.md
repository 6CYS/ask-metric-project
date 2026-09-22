# Ask Metric 智能助手服务

基于 pi AgentHarness 原生运行时（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）的问数代理服务。
pi 是唯一的 Agent 运行与对话控制核心：会话、模型上下文、压缩、执行状态与恢复全部使用原生能力
（`JsonlSessionRepo` + `main` lane）；本服务承载鉴权、可信输入绑定、原生接线、Schema 驱动的业务 Frame 及页面投影。
Agent 的业务取数只调用 FastAPI 后端受治理接口并透传用户 Bearer，目录校验、权限裁剪、
SQL 模板执行与受控计算全部保留在后端；本服务不生成或执行 SQL；Frame 仅保留字段、结果引用和摘要，结果快照按需读取。

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
模型原始 `text_delta` 不直接交付。Pi 根据工具事实组织最终说明和澄清，最终快照同步到页面。
宿主不拼接业务正文或多条证据、不注入回答补救或强制交付工具。已校验的 `READY + execute` 和 `REUSE_RESULT` 必须接续原生执行/回读工具；模型在此处的提前确认响应会转换为该 Frame 的确定下一动作，工具结果后再组织回答。失败不自动重试。步骤结果可提前展示，不能把中间成功当成整轮完成。
新用户消息持久化 `businessProtocol=frame_v1`，投影返回 `business_protocol`，历史、重连与实时正文保持一致；旧历史按原协议只读兼容。
`run_terminal.timings_ms` 在提问流中记录鉴权、外层模型、工具和总耗时；这些不等于页面可见耗时。

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

Pi 输出能力、历史引用、字段变化和执行意图；通用 Schema/Resolver 确定业务事实并验证 READY，
执行工具仅接受本轮 frameId。自然语言澄清由 Pi 根据 issues 组织，新用户回合补充后产生新 Frame。
基础取值、覆盖、排名和计算均经过这条链路，原页面入口不变。

Frame 使用 Pi 原生事务 values 持久化，支持历史分支、独立焦点、CAS、请求幂等和服务重启。
取值快照复用后端 result_id；覆盖/计算快照与 Frame 分开保存。历史发送副本移除大型业务结果，
按引用读取时重新检查当前权限。

目录检索保留最多四项批量读取，失败项及近似候选不能被当作已确认字段。
旧查询工具不再向新回合提供；旧结果继续兼容只读，不重写历史。

完整契约、可复现检查、升级与回退见 [Pi 通用多轮业务上下文](../docs/pi-business-context.md)。
配套升级后端、Agent、前端，先排空活动回合；不增加依赖或数据库迁移。
