# 外部系统 API 对接文档

本文档面向数字农商、鼎鼎及其他不使用 Ask Metric Vue 页面的系统，说明当前可用 API、任务调用
顺序、鉴权、幂等、澄清和结果处理，并定义后续流式与异步渠道的建设边界。

## 维护标记

> **API合同文档，必须同步维护。** 新增、删除或修改任何后端路由、请求字段、响应字段、HTTP
> 状态码、鉴权方式、权限语义、错误码、任务状态或流式事件时，必须在同一代码变更中更新本文档。
> 代码评审和发布验收应把“API文档已更新”作为必检项。

维护范围包括：

- `backend-next/src/ask_metric/api/routes/`中的路由；
- Pydantic请求/响应模型；
- JWT、服务账号、渠道签名和机构权限；
- `Idempotency-Key`、`X-Request-ID`和`expected_version`；
- SSE、WebSocket、Webhook事件及事件顺序；
- Nginx代理超时、缓冲和连接行为；
- 错误响应结构和重试语义。

当前合同版本：`v1`。当前实现以FastAPI OpenAPI `/docs`和本文档共同为准；两者不一致时停止
对接并修正文档或代码，不能由调用方自行猜测。

## 1. 当前能力状态

### 通用表达式计算（calculations）

新增 `POST /api/v1/agent-query-contexts`（Bearer，正文 `session_id: UUID`），返回
`conversation_id: agent:<session_id>`，用于 Agent 与后端会话关联。其他用户的同名关联
返回 404；超出会话数量上限返回 409。普通查询不会自动重建已删除的 `agent:` 会话。

新增 `POST /api/v1/calculations`（Bearer、必填 `Idempotency-Key`）：
请求字段为 `conversation_id`、`scope_id`、`expressions`、`bindings` 和可选 `constants`。
`expressions` 中每项包含 `name`、`label`、`expression`，可选 `display` 和 `decimal_places`；
`bindings` 为变量到 `{fact_id}` 的映射；`constants` 为变量到 `{value, source_text}` 的映射。
数值不由模型抄写：服务端从已保存的当前范围查询结果读取原始数据，复核权限后计算。

查询执行响应新增 `facts` 数组，包含 `fact_id`、`task_id`、`field`、十进制字符串 `value`、
正式 `unit`、指标编码/名称、机构及日期。无精确原值或缺少单位时不发放引用。
查询执行幂等重放统一先复核当前权限和目录，再返回保存的原始结果及相同引用；
机构权限范围变化后不能通过重放读取原结果。
普通问题可携带 `channel_context.calculation_context`；基础查询新增可选
`calculation_context: {scope_id, user_question}`。这些字段不允许作为身份或权限依据。

计算成功返回 `calculation_id`、`task_id`、`scope_id`、`status`、`results`、`inputs`、
`precision`、`rounding`、`created_at`；每项结果保留原公式、内部数值字符串、展示数值和单位。
首次会话提问生成独立范围，明确澄清沿用原任务范围。旧历史结果不自动发放计算引用。

| HTTP / 错误码 | 含义 |
| --- | --- |
| 422 / `CALCULATION_INVALID` | 引用、范围、状态、单位、常数来源、表达式或数值不满足计算要求 |
| 422 / `CALCULATION_CONTEXT_INVALID` | 提问时的计算范围元数据格式错误 |
| 422 / `CALCULATION_CATALOG_CHANGED` | 引用的目录项已停用或不可用 |
| 403 / `CALCULATION_FORBIDDEN` | 当前机构权限不再允许访问输入数据 |
| 404 / `CALCULATION_CONTEXT_NOT_FOUND` | 关联会话不存在、已删除或不属于当前用户 |
| 409 / `CALCULATION_CONFLICT` | 同一幂等键更换计算内容 |

Pydantic 请求格式错误仍使用既有 422 校验响应；缺失或无效 Bearer 使用既有认证错误。
结果及计算记录保存在现有任务 JSON 和会话消息中，无新增表/列。
计算接口不调用模型或业务查询库，不要求向量初始化就绪；新取数接口仍保留就绪门禁。
完整示例、表达式白名单、精度及生命周期见 [计算工具合同](calculation-tools.md)。

### 结构化基础查询（basic-queries）

Agent 调用时通过 `calculation_context.user_question` 携带宿主绑定的当前用户原文。
若所选编码来自短名称/别名，却与原文中更完整的正式指标名冲突，后端在创建任务前返回
HTTP 422、`QUERY_METRIC_REFERENCE_CONFLICT`，由 pi 核对完整名称后重试；后端不静默替换编码。
该校验复用正式目录最长名称匹配，不是通用意图识别或权限判断；不带该上下文的编码接口保持原契约，权限校验仍独立执行。

`POST /api/v1/basic-queries` 为上层工具编排提供不调用模型的基础取数。使用现有
Bearer 认证，必填 `Idempotency-Key`（1～128 字符）。仍受查询就绪检查、当前用户权限和
启用目录约束；请求中的编码不是授权凭据。接口不接受 SQL、自然语言、身份声明、
`ops`、筛选、任意 DSL 或分析指令，多余字段返回 422，不静默忽略。

```json
{
  "metric_codes": ["ORG_DEDMDPT_BAL_PRPR_CMP_SAMEPRD"],
  "org_codes": ["101999"],
  "time": {"start": "2026-03-01", "end": "2026-03-31"},
  "selection": "latest_in_range"
}
```

可选 `conversation_id` 用于归档本次工具查询，不用于继承条件；省略时按用户和幂等键
建立稳定会话。`metric_codes` 最多 100 项，`org_codes` 最多 1000 项，均为非空编码数组，
重复项去重。日期必须为 `YYYY-MM-DD`，起止均包含在范围内，开始不得晚于结束。

| selection | 语义 |
| --- | --- |
| `exact` | 指定日原值，起止必须同日；缺数不向前回退 |
| `latest_in_range` | 各指标、各机构在指定范围内最后一个可用日期的原值，不代表平均值或求和 |
| `all_in_range` | 范围内已有数据点的原值，复用趋势取数模板，不补零或自动聚合 |
| `ranking` | 排名榜单/名次反查：`org_codes` 至多一个范围机构（空数组=层级根节点），候选集合为其直接下级并按当前用户权限取交集；起止同日按当日排名，区间按范围内最新一期排名；`order`（asc/desc，缺省 desc）与 `top_n`（1～100，缺省 5）仅本模式可用；结果行带机构、数值与名次 |


响应为 `{"query": <规范化请求>, "result": <QueryExecutionResult>}`。
`result` 保留 `task_id`、`run_id`、`status`、`rows`、`columns`、`row_count`、`truncated`、
`error_code` 和 `message` 等公共字段；`rows` 中实际数据日期和原始单位/数值为事实依据。
原值不按回答文案的展示精度舍入；不同指标/机构的实际日期可能不同。

成功结果增加公共 `evidence` 字段，包含授权后的 `logical_dsl`、本次使用的 `catalog`
（指标编码/名称/单位与机构编码/名称）、`template`、`coverage_notice` 和
`missing_metric_notice`。该字段也随结果证据持久化，不包含 SQL 或连接信息。
无数据为成功的空数组；`truncated=true` 表示结果不完整，上层不能把截断数据当作完整集合计算。

相同用户/会话/幂等键和请求条件重复调用返回同一任务结果，`idempotent_replay=true`，
包含持久化原值，不重复执行 SQL；成功结果重放前重新核对当前权限和目录。
同键改条件返回 409 `IDEMPOTENCY_KEY_REUSED`；正在执行的重试返回 409
`QUERY_ALREADY_RUNNING`。失败结果沿用原幂等结果，主动重试需新幂等键。
首次目录/能力拒绝返回 HTTP 200、`result.status=unsupported` 和 `QUERY_UNSUPPORTED`；
首次越权返回 HTTP 200、`result.status=failed` 和 `ORG_SCOPE_FORBIDDEN`。
成功结果重放时权限撤销按公共权限异常返回 403，目录停用返回 422 `QUERY_UNSUPPORTED`。
无有效认证为 401；查询未就绪为 503。HTTP 200 本身不代表查询成功，必须检查 `result.status`。

旧 `/questions → analyze → execute` 和渠道自然语言入口继续可用，并保留不支持请求的明确拒绝。
完整但多码的别名先保护名称文字，再澄清编码；不会按指标名称事后删除外围操作。
上层 harness 负责区分正式“较同期”指标与另行计算同比的需求，编排基础查询并调用受控计算工具。
本接口不增加 harness 运行器，也不会自动修复或重跑历史失败任务。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| JWT登录 | 已实现 | 本地账号换取Bearer Token |
| 任务式问数JSON API | 已实现 | 创建、分析、澄清、执行分步调用 |
| 会话与任务查询 | 已实现 | 查询任务状态和会话快照 |
| 独立问数与当前任务澄清 | 已实现 | 新问题不继承历史条件，补充回答通过澄清标识关联当前任务 |
| 指标/机构目录读取 | 已实现 | 需要Bearer Token |
| 请求幂等 | 已实现 | `Idempotency-Key`和任务内请求记录 |
| 机构权限 | 已实现 | 普通用户限定所属机构，管理员可全行 |
| SSE流式问数 | **未实现** | 当前生产后端没有`text/event-stream`路由 |
| WebSocket | **未实现** | 当前没有WebSocket路由 |
| 单请求自动完成问数 | **未实现** | 调用方当前需要编排创建、分析、执行 |
| 鼎鼎签名验签/身份映射 | **未实现** | 只有通用渠道关联基础能力 |
| 异步Webhook回调 | **未实现** | 需要后续定义签名、重试和去重 |

`frontend-vue/src/lib/api.ts`中仍有旧后端SSE客户端代码，但正式`backend-next`没有对应路由，
该代码不能作为外部对接合同。独立 Node `agent-service` 已提供协议 V3 的 SSE 提问与重连，
其路径和生命周期见 [Agent 服务说明](../agent-service/README.md)，不可与本文后端路由混用。

### 独立查询边界

同一会话中的新问题默认独立解析，不凭 `conversation_id` 隐式继承上一轮条件。
智能助手的追问显式提交 `query_reference`（来源 task_id、version，change_field 默认 compose），
后端校验来源归属、版本、成功状态和权限后冻结条件；支持组合修改机构、指标、日期和查询目标。
旧 orgs/time 仍按单字段协议校验。模型提取的修改清单必须与实际新值一致，不允许忽略限制后执行。
数据覆盖查询返回 `query_shape=metric_availability`，日期是输出，可省略时间筛选。
完整合同与升级要求见[通用追问与数据覆盖查询](通用追问与数据覆盖查询.md)。
当前未完成任务通过任务版本和澄清编号继续；历史结果使用读取/下载接口，不重新执行取数。

## 2. 基础约定

### 2.1 地址与协议

生产建议使用HTTPS域名：

```text
Base URL：https://问数服务域名
Content-Type：application/json; charset=utf-8
字符集：UTF-8
API前缀：/api/v1
```

当前腾讯云部署通过Nginx的`/api/`转发到`ask-metric-backend:8010`。外部系统不要直接访问
容器内8010端口或数据库5432端口。

### 2.2 通用请求头

```http
Authorization: Bearer <access_token>
Content-Type: application/json
X-Request-ID: digital-rural-20260730-000001
Idempotency-Key: digital-rural-message-000001
```

| 请求头 | 是否必需 | 说明 |
| --- | --- | --- |
| `Authorization` | 除登录、健康检查外必需 | JWT Bearer Token |
| `Content-Type` | 有JSON请求体时必需 | `application/json` |
| `X-Request-ID` | 强烈建议 | 1至128位字母、数字、点、下划线、冒号或短横线；响应原样返回 |
| `Idempotency-Key` | 创建问题和执行时强烈建议 | 1至128位；渠道重试必须复用原值 |

未提供合法`X-Request-ID`时服务端会生成UUID，并在响应头中返回。

### 2.3 时间和数值

- 日期使用`YYYY-MM-DD`；
- 时间戳使用ISO 8601；
- 金额和指标值在JSON中可能是字符串或数字，调用方应使用Decimal语义处理；
- 不依赖JSON对象字段顺序；
- 未知扩展字段应忽略，不能导致反序列化失败。

## 3. 鉴权与权限

### 3.1 数字农商统一单点登录

数字农商平台可将用户跳转到本系统并在 URL 中携带一次性访问令牌：

```text
https://问数系统地址/login?token={数字农商token}
```

前端会自动调用本系统的 SSO 接口，后端再向配置的数字农商用户信息接口发起校验：

```http
POST /api/v1/auth/sso
Content-Type: application/json

{"token":"{数字农商token}"}
```

后端校验请求使用 `Authorization: Bearer {token}` 调用
`SSO_USER_INFO_URL`（规范接口路径为 `/yusp-app-oca/api/ssoconfig/userInfo`），仅信任返回
`code=0` 且包含 `data.userCode`、`data.userName` 和机构编码的数据。用户会映射为本系统影子账号，
并继续使用本系统的机构权限和 JWT 会话控制。`SSO_ENABLED` 默认为 `false`，启用前必须配置可访问的
完整 URL；机构必须已经登记在本系统机构目录中。

成功响应与普通登录接口相同，返回本系统 JWT；前端收到后会清理地址栏中的原始 token。

### 3.2 登录

```http
POST /api/v1/auth/login
Content-Type: application/json
```

请求：

```json
{
  "username": "integration_user",
  "password": "********"
}
```

响应：

```json
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 28800,
  "user": {
    "id": "user-uuid",
    "username": "integration_user",
    "display_name": "数字农商接口账号",
    "org_code": "ORG_E0F12002",
    "org_name": "机构名称",
    "role_code": "USER"
  }
}
```

调用方应在内存或安全凭据存储中缓存Token，在401时重新登录；不要把密码、Token写入日志。

其他认证接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/auth/me` | 获取当前Token对应账号 |
| POST | `/api/v1/auth/logout` | 注销当前会话并使Token失效，成功返回204 |

### 3.3 账号选择

- 单机构对接：使用该机构的`USER`服务账号，服务端强制限定其机构范围；
- 全行对接：只有明确需要全行数据时才使用独立`SYSTEM_ADMIN`服务账号；
- 不要多个系统共用个人管理员账号；
- 不要把Token下发到不可信客户端或小程序前端；
- 当前没有OAuth2 Client Credentials，服务账号仍通过登录接口换取JWT。

### 3.4 外部身份声明

`external_user_id`、`external_session_id`、`identity_claims`可用于渠道关联和审计，但不能决定权限。

```json
{
  "external_user_id": "dingding-user-123",
  "identity_claims": {
    "org_id": "ORG_ANY"
  }
}
```

上述`org_id`不会覆盖JWT账号机构。生产API也不信任`X-Authenticated-User-Id`或
`X-Authenticated-Org-Id`等代理头。若数字农商、鼎鼎需要按每个外部用户映射机构权限，必须新增
可信渠道适配器，完成签名验证和服务端身份映射后再生成ActorContext。

## 4. 当前问数调用流程

当前API不是单次问答接口。标准流程：

```text
登录
→ POST /questions 创建任务
→ POST /query-tasks/{id}/analyze 语义分析
→ WAITING_USER ? 提交澄清 : 继续
→ POST /query-tasks/{id}/execute 执行
→ 返回自然语言message和结构化rows
```

每次推进都必须使用上一响应中的最新`version`作为`expected_version`。

### 4.1 创建问题

```http
POST /api/v1/questions
Authorization: Bearer <token>
Idempotency-Key: dingding-msg-20260730-001
X-Request-ID: dingding-msg-20260730-001
Content-Type: application/json
```

`message`为必填的自然语言问题，长度为 1 至 1000 个字符。超过限制时接口返回`422`，且不会创建
QueryTask或调用模型；调用方应在提交前提示用户缩短问题。

最小请求：

```json
{
  "message": "查询江阴农商行最新各项贷款余额"
}
```

外部渠道建议请求：

```json
{
  "conversation_id": "channel-generated-stable-id",
  "message": "查询江阴农商行最新各项贷款余额",
  "idempotency_key": "dingding-msg-20260730-001",
  "external_user_id": "dingding-user-123",
  "external_session_id": "dingding-conversation-456",
  "external_message_id": "dingding-msg-20260730-001",
  "business_context": {
    "source_system": "dingding"
  },
  "channel_context": {
    "tenant": "tenant-1"
  },
  "metadata": {},
  "debug": false
}
```

当前路由内部仍将初始问题渠道记为`web`；外部字段用于关联和审计，不代表正式鼎鼎适配已经完成。

响应示例：

```json
{
  "task_id": "task-uuid",
  "conversation_id": "conversation-uuid",
  "version": 0,
  "status": "RUNNING",
  "current_stage": "INTENT_ROUTING",
  "message_id": "message-uuid",
  "idempotent_replay": false,
  "clarification": null,
  "continuation_token": null,
  "slot_frame": null,
  "logical_dsl": null,
  "missing": [],
  "query_shape": null,
  "error_code": null,
  "error_message": null,
  "timings_ms": {},
  "debug": {}
}
```

### 4.2 语义分析

```http
POST /api/v1/query-tasks/{task_id}/analyze
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: analyze:<stable-command-key>
```

```json
{
  "expected_version": 0
}
```

`Idempotency-Key` 可选；Agent 恢复时复用原分析阶段键。相同键与原 `expected_version`
返回已处理任务的当前状态，不再次调用模型；同键用于不同版本返回 `IDEMPOTENCY_KEY_REUSED`。
未提供时使用本次请求关联标识，不保证跨请求重放。

可能结果：

1. `RUNNING/LOGICAL_DSL`：语义完整，可以执行；
2. `WAITING_USER/CLARIFICATION`：需要把澄清问题返回给用户；
3. `SUCCEEDED`且`NON_METRIC_QUERY_UNSUPPORTED`：非指标闲聊已终止；
4. `FAILED`：读取`error_code`和`error_message`。

可执行响应关键字段：

```json
{
  "task_id": "task-uuid",
  "version": 1,
  "status": "RUNNING",
  "current_stage": "LOGICAL_DSL",
  "query_shape": "metric_value",
  "slot_frame": {
    "task": "metric_query",
    "raw_metric_text": "各项贷款余额",
    "raw_metric_texts": ["各项贷款余额"],
    "metrics": [{"code": "M001", "name": "各项贷款余额"}],
    "time": null,
    "orgs": ["江阴农商行"],
    "dimensions": [],
    "filters": [],
    "ops": [],
    "options": {},
    "missing": []
  },
  "logical_dsl": {
    "v": 1,
    "task": "metric_query",
    "metrics": ["M001"],
    "time": {"start": null, "end": null, "preset": "latest"},
    "orgs": ["ORG_E0F12002"],
    "dimensions": [],
    "filters": [],
    "ops": [],
    "options": {}
  }
}
```

`raw_metric_text`保留兼容用的原始指标文本，`raw_metric_texts`是从用户原问题中确定性拆分出的
原始指标短语列表；`metrics`是这些短语经过标准名、别名、
向量召回和Rerank解析后的正式指标。标准名或别名唯一命中时直接采用；模糊候选只有在分数达到
服务端自动采用阈值且明显领先第二名时才直接采用，否则返回指标候选进入澄清。调用方不得把
`raw_metric_text`当作正式指标编码或绕过澄清自行执行。

### 4.3 处理澄清

`WAITING_USER`响应包含：

```json
{
  "version": 1,
  "status": "WAITING_USER",
  "current_stage": "CLARIFICATION",
  "clarification": {
    "id": "clarification-uuid",
    "type": "semantic_slots",
    "prompt": "我已经识别到机构为紫金农商行，但还需要补充一些信息。\n\n还需要确认：\n1. 请补充要查询的具体指标名称。\n\n您可以直接回复：‘个人活期存款余额当日数’。",
    "options": [],
    "understood": {
      "orgs": ["紫金农商行"]
    },
    "reply_examples": ["个人活期存款余额当日数"],
    "fields": [
      {
        "field": "metrics.0",
        "target_field": "metrics",
        "type": "metric",
        "label": "查询指标 1",
        "reason": "metric_ambiguous",
        "message": "指标存在多个可能匹配，请确认一个标准指标。",
        "selection_mode": "single",
        "min_selections": 1,
        "max_selections": 1,
        "options": [
          {"code": "M001", "name": "各项贷款余额", "kind": "metric"}
        ],
        "preserved_options": []
      }
    ],
    "missing": ["metrics"],
    "task_version": 1
  },
  "continuation_token": "signed-opaque-token"
}
```

结构化澄清字段规则：

- `prompt`是可直接展示的对话式追问，会先说明已经理解的条件，再解释仍需补充的内容；
- `understood`列出已经识别的指标、机构、时间和操作，客户端可用于辅助展示，不应替代`prompt`；
- `reply_examples`提供一条或多条自然语言回复示例；自然语言补充是默认交互，`fields/options`是需要精确选择时的备用入口；
- `field`是当前澄清项的唯一标识；并列指标或机构使用`metrics.0`、`metrics.1`、`orgs.0`等标识；
- `target_field`是最终回填的SlotFrame字段，目前目录选择主要为`metrics`或`orgs`；
- `selection_mode=single`表示该原始名称的候选互斥，只能确认一个；
- `selection_mode=multiple`表示用户正在补充查询范围，可以选择多个指标或机构；
- `min_selections/max_selections`定义选择数量；`max_selections=null`表示不设上限；
- `preserved_options`是已经可靠识别的标准项，客户端提交时不得丢弃；服务端也会在并列指标或机构
  澄清恢复时合并这些已确认项；
- 多个并列名称各自有歧义时，调用方应逐项完成选择，最后把所有选择合并到一次`answers.set`提交。

Web兼容接口：

```http
POST /api/v1/query-tasks/{task_id}/clarifications
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "expected_version": 1,
  "clarification_id": "clarification-uuid",
  "answers": {
    "set": {
      "metrics": [{"code": "M001", "name": "各项贷款余额"}]
    },
    "add_ops": [],
    "remove_ops": []
  },
  "channel_context": {}
}
```

也可以直接提交用户的自然语言回复，服务端会只从当前任务缺失的槽位中提取条件，并继续同一任务：

```json
{
  "expected_version": 1,
  "clarification_id": "clarification-uuid",
  "answers": "个人活期存款余额当日数，2026年3月末",
  "channel_context": {}
}
```

客户端应优先复用会话主输入框提交这段文本；只有用户主动展开“精确选择”时，才提交结构化
`SemanticPatch`。若一次回复仍未补齐全部条件，服务端会返回新的对话式追问。

渠道关联接口：

```http
POST /api/v1/clarifications
```

可通过完整任务引用、`continuation_token`、回复消息映射或外部会话定位待澄清任务。鼎鼎等渠道
优先保存并回传`continuation_token`，不要只依赖“最近一条待澄清任务”。

澄清后可能再次`WAITING_USER`，调用方必须循环处理，直到出现`logical_dsl`或终态。

用户取消当前澄清时调用：

```http
POST /api/v1/query-tasks/{task_id}/clarifications/cancel
```

```json
{
  "expected_version": 1,
  "clarification_id": "clarification-uuid"
}
```

### 4.4 执行查询

```http
POST /api/v1/query-tasks/{task_id}/execute
Authorization: Bearer <token>
Idempotency-Key: execute-task-uuid
Content-Type: application/json
```

```json
{
  "expected_version": 1
}
```

成功响应示例：

```json
{
  "run_id": 1001,
  "task_id": "task-uuid",
  "status": "succeeded",
  "query_shape": "metric_value",
  "columns": ["org_name", "metric_code", "metric_name", "metric_value", "stat_date"],
  "rows": [
    {
      "org_name": "江阴农村商业银行",
      "metric_code": "M001",
      "metric_name": "各项贷款余额",
      "metric_value": "123456.78",
      "stat_date": "2026-07-29"
    }
  ],
  "comparisons": [],
  "row_count": 1,
  "truncated": false,
  "latency_ms": 12,
  "message": "江阴农村商业银行截至2026年7月29日的各项贷款余额为123456.78。",
  "task_version": 3,
  "task_status": "SUCCEEDED",
  "idempotent_replay": false,
  "timings_ms": {},
  "debug": {}
}
```

外部系统可直接展示`message`；需要表格或图表时使用`columns`和`rows`。不要解析自然语言回答来
恢复数值。

`status`取值：

- `succeeded`：查询成功；
- `failed`：规划、权限、数据库或执行失败；
- `unsupported`：语义已识别，但当前SQL模板不支持该场景。

管驾表问数的执行边界：均值、较同期、较上月、较年初、增量、增幅和单机构排名必须解析为
指标目录中的正式预计算指标，不由API动态计算。指定单日Top N严格匹配该日；月份或日期区间
只在范围内选择最新一期；只有明确使用“截至/截止”时才会向前选择最近一期。动态聚合、下钻、
多日期排名、单机构对普通值指标临时算名次，以及“排名+期间比较/趋势”等复合操作返回
`unsupported / QUERY_UNSUPPORTED`。

`row_count`表示本次响应实际返回的行数；`truncated=true`表示查询结果超过服务端上限，响应和
确定性答案只包含上限内的前若干行，并会在`message`中明确提示。

### 4.5 获取任务状态

```http
GET /api/v1/query-tasks/{task_id}
Authorization: Bearer <token>
```

适用于调用超时后的状态恢复、409冲突后的版本刷新和外部任务轮询。

任务状态：

```text
RUNNING
WAITING_USER
SUCCEEDED
FAILED
CANCELLED
EXPIRED
```

任务阶段：

```text
INTENT_ROUTING
SLOT_EXTRACTION
ENTITY_RESOLUTION
VALIDATION
CLARIFICATION
LOGICAL_DSL
PLANNING
EXECUTION
RESULT_FORMATTING
```

### 4.8 不可变结果读取

`GET /api/v1/query-tasks/{task_id}/result?offset=0&limit=100` 按任务归属读取已执行结果，不重新查询。

Agent 对用户原文所指的历史结果使用同路径的 `POST`，请求体为：

```json
{"original_question":"刚才江阴3月的数据再显示一下","offset":0,"limit":20}
```

该 POST 是只读校验与分页读取，不创建任务或执行业务 SQL。后端用当前目录的无歧义名称、别名匹配原文中的机构和指标，与不可变结果的正式 DSL 核对；包括零行结果在内，冲突返回 HTTP 409、`RESULT_REFERENCE_CONFLICT`，不返回业务事实。Agent 可据此重新选择已有结果，不能改成新查询。它不负责猜测原文未明示的实体或解析任意自然语言历史指代；GET 兼容原有页面结果加载与分页。

## 5. 会话接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/conversations?limit=12&offset=0` | 当前账号可见会话分页列表，返回 `has_more` |
| GET | `/api/v1/conversations/{conversation_id}` | 消息和任务快照 |
| PATCH | `/api/v1/conversations/{conversation_id}` | 修改会话名称，请求体为 `{"title":"新名称"}` |
| GET | `/api/v1/conversations/{conversation_id}/export` | 导出当前账号所属会话的 Excel 记录 |
| GET | `/api/v1/query-tasks/{task_id}/result-export` | 导出当前账号所属任务的完整 Excel 查询结果 |
| DELETE | `/api/v1/conversations/{conversation_id}` | 删除会话及关联数据 |

普通账号只能访问自己拥有的会话。系统管理员也不能绕过任务所有权直接执行他人任务，外部系统应
使用创建任务时相同的服务账号继续推进。

## 6. 目录与管理接口

所有接口都需要Bearer Token。写接口还要求`SYSTEM_ADMIN`。

### 6.1 指标与向量状态

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/catalog/metrics` | 登录用户 | 指标、同义词、启停用和向量状态 |
| GET | `/api/v1/catalog/metrics/search?keyword=&limit=` | 登录用户 | 指标目录检索：确定性命中（exact/contains/lexical）计入`total`，embedding top-k 仅作`semantic_suggestions`近似推荐 |
| GET | `/api/v1/catalog/metrics/overview` | 登录用户 | 实时启用指标总数及按单位分组的数量与名称示例；不执行问数 |
| POST | `/api/v1/catalog/metrics` | 系统管理员 | 新增指标，自动触发向量同步 |
| PUT | `/api/v1/catalog/metrics/{metric_code}` | 系统管理员 | 修改指标和同义词 |
| DELETE | `/api/v1/catalog/metrics/{metric_code}` | 系统管理员 | 逻辑停用指标 |
| GET | `/api/v1/catalog/metric-index/status` | 系统管理员 | `pending/ready/failed/disabled`计数 |

### 6.2 机构、数据集和运行日志

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/catalog/organizations` | 登录用户 | 机构目录 |
| GET | `/api/v1/catalog/organizations/search?keyword=&limit=` | 登录用户 | 机构目录检索：仅确定性档位（exact/前缀/包含），不做模糊匹配 |
| POST | `/api/v1/catalog/organizations` | 系统管理员 | 新增机构 |
| PUT | `/api/v1/catalog/organizations/{org_code}` | 系统管理员 | 修改机构 |
| DELETE | `/api/v1/catalog/organizations/{org_code}` | 系统管理员 | 逻辑停用机构 |
| GET | `/api/v1/catalog/datasets` | 登录用户 | 当前数据集目录 |
| POST | `/api/v1/catalog/datasets` | 系统管理员 | 新增数据集 |
| PUT | `/api/v1/catalog/datasets/{dataset_id}` | 系统管理员 | 修改数据集配置或启停状态 |
| DELETE | `/api/v1/catalog/datasets/{dataset_id}` | 系统管理员 | 逻辑停用数据集 |
| GET | `/api/v1/catalog/query-runs` | 登录用户 | 可见范围内问数运行日志 |
| GET | `/api/v1/catalog/query-runs/{task_id}` | 登录用户 | 单任务轨迹、耗时和调试信息 |

数据集写操作统一使用`/api/v1/catalog/datasets`路由；历史`/api/datasets`接口不属于正式合同。

### 6.3 模型、提示词和SQL模板

前缀：`/api/v1/model-config`。读取需要`SYSTEM_ADMIN`；写入还要求服务端开启
`MODEL_ADMIN_WRITE_ENABLED`并提供`X-Model-Admin-Token`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/model-config` | 模型、提示词和API Key配置状态 |
| PUT | `/api/v1/model-config` | 同时提交模型配置；提示词发生变化时会拒绝并要求使用版本化接口 |
| PUT | `/api/v1/model-config/model` | 更新模型节点配置 |
| PUT | `/api/v1/model-config/prompts/{prompt_name}` | 发布提示词新版本 |
| GET | `/api/v1/model-config/prompts/{prompt_name}/versions` | 提示词版本记录 |
| POST | `/api/v1/model-config/prompts/{prompt_name}/versions/{version_id}/rollback` | 回滚提示词 |
| GET | `/api/v1/model-config/sql-templates` | SQL模板列表 |
| POST | `/api/v1/model-config/sql-templates/validate` | 只读安全和参数校验 |
| POST | `/api/v1/model-config/sql-templates/trial-run` | 只读试运行，最多20行 |
| PUT | `/api/v1/model-config/sql-templates/{dialect}/{template}` | 发布SQL模板新版本 |
| GET | `/api/v1/model-config/sql-templates/{dialect}/{template}/versions` | SQL版本记录 |
| POST | `/api/v1/model-config/sql-templates/{dialect}/{template}/versions/{version_id}/rollback` | 回滚SQL模板 |

这些是管理接口，不建议开放给数字农商或鼎鼎普通问数调用方。

### 6.4 已退出的跨任务接口

`/api/v1/multiturn/metrics`、`/api/v1/multiturn/readiness`、`/api/v1/multiturn/review-samples`
以及 `PUT /api/v1/query-tasks/{task_id}/multiturn-review` 已移除，返回 404。
旧跨任务追问、历史指代任务的分析、澄清、执行返回 `CROSS_TASK_CONTEXT_RETIRED`（409），
提示新建完整问题；任务和会话的历史读取、导出不受该执行限制影响，仍需校验用户归属。
`MULTITURN_*` 不再是有效运行开关。升级须同步前后端和实际持久提示词。
上述退出规则针对旧上下文协议；当前显式 `query_reference` 的受控追问不属于旧接口。

## 7. 幂等、并发和重试

### 7.1 幂等键

- 创建问题：同一外部消息重试必须复用同一个`Idempotency-Key`；
- 执行查询：建议使用`execute:{task_id}`等稳定键；
- 相同键和相同内容返回已有结果，`idempotent_replay=true`；
- 相同键被不同内容复用返回`IDEMPOTENCY_KEY_REUSED`。

不要每次网络重试都生成新幂等键，否则会创建重复任务。

### 7.2 乐观锁

所有推进任务的请求携带`expected_version`。并发更新导致：

```json
{
  "code": "TASK_VERSION_CONFLICT",
  "message": "The QueryTask was updated by another request",
  "request_id": "...",
  "details": {
    "task_id": "task-uuid",
    "expected_version": 1,
    "actual_version": 2
  }
}
```

处理方式：GET任务最新状态；如果任务已成功则直接使用结果或会话快照，如果仍可推进则使用最新
版本继续。不能盲目重复旧`expected_version`。

### 7.3 超时和重试建议

- 连接超时：5至10秒；
- 单次分析/执行读取超时：至少190秒，与当前Nginx代理配置一致；
- 只对网络中断、502、503、504和明确可重试错误重试；
- 401重新认证后重试；
- 409先读取任务状态，不直接重放；
- 4xx参数、权限和unsupported错误不自动重试；
- 所有重试复用原`X-Request-ID`关联值和`Idempotency-Key`。

## 8. 错误响应

领域错误标准结构：

```json
{
  "code": "ORG_SCOPE_FORBIDDEN",
  "message": "无权查询所属机构之外的数据",
  "request_id": "request-id",
  "details": null
}
```

参数校验失败（HTTP 422）同样返回标准结构，`details.fields` 给出字段级定位（不回显输入值）：

```json
{
  "code": "REQUEST_INVALID",
  "message": "请求参数未通过校验。",
  "request_id": "request-id",
  "details": {
    "fields": [
      {"path": "constants._", "rule": "string_pattern_mismatch", "expected": {"pattern": "^[a-zA-Z][a-zA-Z0-9_]{0,31}$"}}
    ]
  }
}
```

反向代理等中间层仍可能返回非标准错误正文（如`{"detail": "..."}`或纯文本），调用方应保留对非标准正文的容忍。

常见错误：

| HTTP | 错误码/类型 | 处理 |
| --- | --- | --- |
| 401 | `AUTH_TOKEN_INVALID` | 重新登录 |
| 401 | `AUTH_SSO_TOKEN_INVALID` | 从数字农商平台重新发起跳转 |
| 401 | `AUTH_SSO_DISABLED` | 联系系统管理员启用 SSO |
| 502 | `AUTH_SSO_UPSTREAM_ERROR` | 检查统一认证服务连通性后重试 |
| 401 | `AUTH_SESSION_REPLACED` | Token已失效，重新登录 |
| 403 | `ORG_SCOPE_FORBIDDEN` | 不重试，检查服务账号机构 |
| 403 | `CONFIG_ADMIN_REQUIRED` | 需要系统管理员 |
| 404 | `TASK_NOT_FOUND` | 检查任务和账号所有权 |
| 409 | `TASK_VERSION_CONFLICT` | GET最新任务后决定下一步 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 修正幂等键生成逻辑 |
| 409 | 澄清引用过期/不匹配 | 使用最新澄清或continuation token |
| 400/422 | `REQUEST_INVALID` 等请求校验失败 | 按`details.fields`修正请求，不自动重试 |
| 200 + `unsupported` | `QUERY_UNSUPPORTED` | 场景尚未实现 |
| 200 + 任务 `FAILED` | `QUERY_CALCULATION_REQUIRED` | 语义入口确认条件完整的 sum/avg/min/max 运算；可由上层按完整目标重新取数并调用 calculations，不可将中间原值当作完成 |
| 200 + 任务 `FAILED` | `SLOT_FRAME_VALIDATION_FAILED` | 后端已尝试一次结构纠正仍不合法；保留任务及字段诊断，未执行 SQL |
| 200 + `failed` | `QUERY_EXECUTION_FAILED`等 | 记录task_id和request_id后排查 |
| 500 | `INTERNAL_SERVER_ERROR` | 有限重试并告警 |

## 9. 统一外部问数接口

鼎鼎及后续外部系统优先调用统一聚合入口，不需要自行编排创建、分析和执行三个内部接口：

```http
POST /api/v1/integrations/ask
Content-Type: application/json
```

当前第一阶段信任接入方传递的数字农商用户信息，不要求本地JWT。系统会校验用户机构已登记，
并为外部用户创建或更新不可使用密码登录的影子账号，以保存会话归属、任务和审计记录。

普通提问示例：

```json
{
  "schema_version": "1.0",
  "source_system": "dingding",
  "message_id": "ding-message-001",
  "conversation_id": "c27dd01b5f0f4182ad995e5fad65e682",
  "user_input": "查询姜堰农商行贷款余额",
  "messages": [
    {"role": "user", "text": "查询上个月贷款余额"},
    {"role": "assistant", "text": "上个月贷款余额为……"}
  ],
  "user_info": {
    "user_code": "12500355",
    "user_name": "曹操",
    "corpo_code": "125",
    "corpo_name": "姜堰农商行",
    "org_code": "321284000",
    "org_name": "江苏姜堰农村商业银行",
    "dept_code": "321284953",
    "dept_name": "姜堰科技管理部"
  }
}
```

兼容字段：`messages`也可写作`history`，`user_info`也可写作`user`。历史消息最多50条，
这些字段仅为旧客户端协议兼容而接收，不参与解析、改写或继承条件，也不保存为任务的推理上下文。
`user_input` 每次按独立问题解析；当前任务的补充回答必须传 `clarification_id`。

`message_id`当前为可选字段：

- 提供时，同一会话内相同`message_id`用于请求幂等；相同消息重试不会重复创建和执行任务；
- 相同`message_id`用于不同请求内容时返回`IDEMPOTENCY_KEY_REUSED`；
- 未提供时，系统以每次HTTP请求的`request_id`处理，调用方重试可能创建新任务；
- 历史消息不要求逐条提供消息ID，`message_id`只标识本轮`user_input`。

需要澄清时返回：

```json
{
  "request_id": "request-001",
  "message_id": "ding-message-001",
  "conversation_id": "c27dd01b5f0f4182ad995e5fad65e682",
  "task_id": "task-001",
  "status": "waiting_user",
  "type": "clarification",
  "answer": "请确认您要查询的指标",
  "data": null,
  "clarification": {
    "id": "clarification-001",
    "prompt": "请确认您要查询的指标",
    "type": "semantic_slots",
    "options": []
  },
  "error": null,
  "idempotent_replay": false
}
```

澄清回答继续调用同一接口，只需原样回传`clarification_id`：

```json
{
  "source_system": "dingding",
  "message_id": "ding-message-002",
  "conversation_id": "c27dd01b5f0f4182ad995e5fad65e682",
  "clarification_id": "clarification-001",
  "user_input": "贷款余额",
  "user_info": {
    "user_code": "12500355",
    "user_name": "曹操",
    "org_code": "321284000"
  }
}
```

`clarification_id`会按来源系统、外部用户和外部会话校验，调用方不需要保存内部任务版本或
`continuation_token`。

机构权限来自问数机构目录的`org_type`和`parent_org_code`：`HEAD_OFFICE`用户可查询自身及
后代机构；`BRANCH`用户只能查询自身。总行用户没有因此获得模型、SQL模板或目录管理权限。
未明确指定机构时，无论总行还是分行都默认查询用户自己的机构，不自动展开全辖查询。

## 10. 流式输出说明

### 10.1 当前生产行为

当前所有`backend-next`问数接口返回完整JSON，不返回token级模型流，也没有SSE进度流。调用方必须
以HTTP响应完成为准，不能连接以下未实现路径：

```text
/api/chat/messages/stream
/api/v1/questions/stream
/api/v1/query-tasks/{task_id}/events
```

数字农商或鼎鼎当前应采用：

1. 任务式JSON编排；
2. 请求超时后通过GET任务恢复；
3. 澄清时把`prompt/options`渲染成卡片或文本；
4. 最终展示`message`，结构化数据按平台能力展示。

### 10.2 推荐的后续异步形态（规划，尚未实现）

当前统一同步聚合接口已经实现。若后续渠道的同步响应时限不足，SSE可采用“两步式任务 +
事件流”：

```text
POST /api/v1/integrations/questions
GET  /api/v1/query-tasks/{task_id}/events
Content-Type: text/event-stream
```

建议事件：

```text
event: task.created
event: stage.changed
event: clarification.required
event: result.completed
event: task.failed
event: heartbeat
```

每个事件至少包含：

```json
{
  "event_id": "monotonic-id",
  "task_id": "task-uuid",
  "version": 2,
  "occurred_at": "2026-07-30T08:00:00Z",
  "data": {}
}
```

流式实现必须处理：

- 断线重连和`Last-Event-ID`；
- 15至30秒heartbeat；
- 终态事件后关闭连接；
- 每个事件可重复消费，调用方按`event_id`去重；
- SSE只发送阶段和业务结果，不转发模型思考过程；
- Nginx设置`proxy_buffering off`、`proxy_cache off`和足够读取超时；
- 如果使用原生EventSource，需解决其无法自定义Authorization头的问题，优先使用短期签名流Token
  或支持流读取的`fetch`；
- 客户端必须在收到终态前保留task_id，以便断线后通过任务接口恢复。

以上路径和事件在实现前只是设计建议，不能提供给外部系统联调。

### 10.3 鼎鼎等消息渠道

消息平台通常有较短的同步响应时限，更适合：

```text
平台回调
→ 服务端验签并快速返回ACK
→ 异步执行QueryTask
→ 主动回调/机器人消息发送澄清或最终结果
```

正式渠道适配器还需要定义：

- 鼎鼎签名、时间戳和重放保护；
- 外部租户、用户、机构到本地账号/权限的可信映射；
- 外部消息ID到`Idempotency-Key`的稳定映射；
- `external_session_id`和`conversation_id`映射；
- 澄清卡片的`continuation_token`回传；
- 回调签名、失败重试、死信和人工补偿；
- 平台文本长度、卡片、表格和文件限制。

## 11. 健康与联调检查

无需鉴权：

```http
GET /health
GET /health/ready
```

响应：

```json
{"status": "ok"}
```

```json
{"status": "ready"}
```

联调顺序建议：

1. 健康检查；
2. 登录和`GET /api/v1/auth/me`；
3. 创建问题幂等重放；
4. 无澄清的完整问数；
5. 指标歧义澄清；
6. 普通账号跨机构权限拒绝；
7. 网络超时后GET任务恢复；
8. 相同`expected_version`并发冲突；
9. 空结果、unsupported和模型不可用；
10. 日志中通过`X-Request-ID`完成端到端定位。

## 12. API变更检查清单

每次API相关变更至少检查：

- [ ] 路由表和OpenAPI是否变化；
- [ ] 本文档当前能力状态是否变化；
- [ ] 请求/响应示例是否仍能通过Pydantic校验；
- [ ] 新字段是否说明必填、默认值、长度和兼容策略；
- [ ] 状态码、错误码和重试语义是否更新；
- [ ] 鉴权、角色和机构范围是否更新；
- [ ] 幂等键和任务版本行为是否更新；
- [ ] 流式事件、顺序、心跳和重连规则是否更新；
- [ ] Nginx超时或缓冲配置是否同步；
- [ ] 数字农商、鼎鼎适配器和Vue调用是否同步回归；
- [ ] README和技术栈文档中的能力描述是否同步。


### 完整新问题与澄清提交边界

语义澄清接口收到纯文本答案时，若正式目录与完整查询语法能够确认它已独立包含指标、机构和日期，返回 HTTP 409 / `CLARIFICATION_INDEPENDENT_QUERY`，`details.write_applied=false`、`next_action=new`。该校验在追加消息、更新任务与记录幂等结果之前执行，旧任务及版本保持原样；客户端应以新查询提交原文。

仅补日期/指标的文字仍走原澄清流程。用户显式指定澄清卡片的结构化答案（包括 `{text: ...}`）保持指定任务语义。Agent 只对上述明确未写入的拒绝允许模型同轮纠正为 `new`；超时、响应丢失和未知错误不能据此更换写命令。

## 确定性业务字段解析（Pi 内部适配）

`POST /api/v1/business-context/resolve-field`，使用现有 Bearer 身份认证。

`POST /api/v1/business-context/metric-mentions` 同样要求 Bearer，接收 `{"question":"完整用户原文"}`（1～8000 字符），返回 `mentions`：每项含原文 `text`、Unicode 码点 `start/end`（左闭右开）和 `resolution`。完整名称/别名唯一命中，或按完整片段计算的字符/拼音相似度唯一最高分达到 0.95（含）时返回 resolved；后者的 metadata 包含 match=high_confidence、score 和 autoSelectThreshold。低分、不同编码并列最高及描述匹配仍返回候选。分数是算法相似度，不是概率。该接口不执行 SQL、不调用模型；取数权限在正式执行时校验。详细算法与离线依赖见 [指标匹配方案](metric-matching.md)。
请求为 `{ "entity": "metric|organization|date", "raw_values": ["原始表达"] }`；每项非空且不超过 200 字符，最多 100 项，date 仅允许一项。
响应统一为 `{status, value?, candidates?, metadata?}`。
唯一精确名称、受控别名或编码命中返回 resolved；指标的近似匹配同样使用完整片段唯一最高分达到 0.95 的自动采用规则。其余候选返回 ambiguous/needs_confirmation，未命中返回 not_found。
机构候选在返回前裁剪到当前用户授权范围，日期复用后端确定性解析规则，以 Asia/Shanghai 为当前业务日期。
接口不调用模型、不查询指标数值、不接受 SQL。正式执行和结果回读仍须分别校验当前权限。

Business Frame、历史引用、字段变化及唯一页面入口的调用关系见 [Pi 通用多轮业务上下文](pi-business-context.md)。
