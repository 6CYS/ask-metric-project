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

- `metric_ask`：提交问题→语义解析→执行查询的完整受治理链路（`/api/v1/questions` + `/analyze` + `/execute`）。
- `metric_catalog_search` / `org_catalog_search`：正式指标/机构目录检索（`/api/v1/catalog/...`）。
- `metric_query_structured`：用正式编码和明确日期调用 `/api/v1/basic-queries`。
- `metric_calculate`：将当前提问的数据引用与表达式交给后端计算，页面直接展示结果及来源。

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
智能助手保留当前会话上下文（含重启恢复的消息），不同会话不共享上下文。历史数值不能直接作为本轮数值答案或计算证据，须重新取数并通过权限校验。
