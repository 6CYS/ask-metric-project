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
