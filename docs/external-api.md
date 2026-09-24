# 外部系统 API 对接文档

本文档说明 `backend-next` 当前存活的后端 API：结构化基础查询、表达式计算、确定性业务字段
解析、数据覆盖查询、任务与结果读取、目录与管理接口、鉴权与健康检查。主要消费方为独立
Node `agent-service`（Pi Agent）；其自然语言提问入口与 SSE 生命周期见
[Agent 服务说明](../agent-service/README.md)，不属于本文档范围。

旧自然语言任务链路（`POST /questions`、`/query-tasks/{id}/analyze`、`/execute`、
`/clarifications`、`/conversations/*`、`/integrations/ask` 及 `continuation_token` 渠道协议）
已随外部渠道迁移完整删除，相关请求返回 404；本文档不再描述这些接口。

## 维护标记

> **API合同文档，必须同步维护。** 新增、删除或修改任何后端路由、请求字段、响应字段、HTTP
> 状态码、鉴权方式、权限语义或错误码时，必须在同一代码变更中更新本文档。
> 代码评审和发布验收应把“API文档已更新”作为必检项。

维护范围包括：

- `backend-next/src/ask_metric/api/routes/`中的路由；
- Pydantic请求/响应模型；
- JWT、单点登录和机构权限；
- `Idempotency-Key`、`X-Request-ID`；
- 错误响应结构和重试语义。

当前合同版本：`v1`。当前实现以FastAPI OpenAPI `/docs`和本文档共同为准；两者不一致时停止
对接并修正文档或代码，不能由调用方自行猜测。

## 1. 基础约定

### 1.1 地址与协议

生产建议使用HTTPS域名：

```text
Base URL：https://问数服务域名
Content-Type：application/json; charset=utf-8
字符集：UTF-8
API前缀：/api/v1
```

当前腾讯云部署通过Nginx的`/api/`转发到`ask-metric-backend:8010`。外部系统不要直接访问
容器内8010端口或数据库5432端口。

### 1.2 通用请求头

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
| `Idempotency-Key` | basic-queries 与 calculations 必需 | 1至128位；重试必须复用原值 |

未提供合法`X-Request-ID`时服务端会生成UUID，并在响应头中返回。

### 1.3 时间和数值

- 日期使用`YYYY-MM-DD`；
- 时间戳使用ISO 8601；
- 金额和指标值在JSON中可能是字符串或数字，调用方应使用Decimal语义处理；
- 不依赖JSON对象字段顺序；
- 未知扩展字段应忽略，不能导致反序列化失败。

## 2. 鉴权与权限

### 2.1 数字农商统一单点登录

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

### 2.2 登录

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

### 2.3 账号选择

- 单机构对接：使用该机构的`USER`服务账号，服务端强制限定其机构范围；
- 全行对接：只有明确需要全行数据时才使用独立`SYSTEM_ADMIN`服务账号；
- 不要多个系统共用个人管理员账号；
- 不要把Token下发到不可信客户端或小程序前端；
- 当前没有OAuth2 Client Credentials，服务账号仍通过登录接口换取JWT。

身份只来自认证链路；请求体中的任何身份声明字段都不会覆盖 JWT 账号机构，生产 API 也不信任
`X-Authenticated-User-Id` 或 `X-Authenticated-Org-Id` 等代理头。

## 3. 结构化基础查询（basic-queries）

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
建立稳定会话。`metric_codes` 最多 100 项，`org_codes` 最多 1000 项，具体机构模式下为非空编码数组，
重复项去重；集合模式省略 org_codes，使用下述范围对象和指纹。日期必须为 `YYYY-MM-DD`，起止均包含在范围内，开始不得晚于结束。

| selection | 语义 |
| --- | --- |
| `exact` | 指定日原值，起止必须同日；缺数不向前回退 |
| `latest_in_range` | 各指标、各机构在指定范围内最后一个可用日期的原值，不代表平均值或求和 |
| `all_in_range` | 范围内已有数据点的原值，复用趋势取数模板，不补零或自动聚合 |

查询契约版本为 `schema_version=2`（缺省2）。排名独立通过 `operation` 表达：

- 普通取值：省略 operation 或传 `{"kind":"value"}`。
- 排名：`{"kind":"ranking","order":"desc","top_n":3}`。方向与条数必须显式提供；条数1～100，不在后端猜测排名条件。
- `exact` 可与排名组合。`latest_in_range` 排名按每指标在授权候选内的最新有效日期统一排序，缺数机构不混入其较早日期。
- `all_in_range + ranking` 尚不支持并拒绝，不能截成一期。
- 旧 `selection=ranking` 和顶层 order/top_n 已删除，返回422；所有调用方须配套升级。

机构编码始终代表实际参与查询的机构，不再表示上级范围，也不通过空数组推断全省或本人下级。集合先调用
`POST /api/v1/business-context/resolve-scope`，输入如下之一：

```json
{"kind":"authorized_cohort","cohort":"rural_commercial_banks","source_text":"各家农商行"}
```

```json
{"kind":"children_of","parent_name":"用户原文中的具体机构名称","source_text":"该机构下属各支行"}
```

后端使用当前账号与严格正式层级，返回 FieldResolution；成功时 value 包含 codes、names、scope、scope_fingerprint。
未确定父机构返回候选；层级配置错误、权限不足、空授权范围返回明确错误，不伪装成名称缺项。
将返回的 scope 与指纹提交到基础查询，不能混用 org_codes：

```json
{
  "schema_version":2,
  "metric_codes":["已确认的指标编码"],
  "organization_scope":{"kind":"authorized_cohort","cohort":"rural_commercial_banks"},
  "scope_fingerprint":"解析回执中的64位十六进制指纹",
  "time":{"start":"2026-04-30","end":"2026-04-30"},
  "selection":"exact",
  "operation":{"kind":"ranking","order":"desc","top_n":3}
}
```

执行前和发布结果前复核范围及指纹，变化返回 `SCOPE_CHANGED`，不得直接沿用旧集合。
范围解析端点不调用模型、不执行指标SQL；source_text为来源原文，不是授权凭据。

响应为 `{"query": <规范化请求>, "result": <QueryExecutionResult>}`。
`result` 保留 `task_id`、`run_id`、`status`、`rows`、`columns`、`row_count`、`truncated`、
`error_code` 和 `message` 等公共字段；`rows` 中实际数据日期和原始单位/数值为事实依据。
原值不按回答文案的展示精度舍入；不同指标/机构的实际日期可能不同。

成功结果增加公共 `evidence` 字段，包含授权后的 `logical_dsl`、本次使用的 `catalog`
（指标编码/名称/单位与机构编码/名称）、`template`、`coverage_notice` 和
`missing_metric_notice`。排名另有 `ranking` 列表，按指标记录 date、authorized_candidates、with_data、without_data、returned 与 tie_policy。MySQL 同日事实重复、Inceptor 最高批次事实重复时返回 DATA_CONFLICT，不发布整榜。该字段也随结果证据持久化，不包含 SQL 或连接信息。
无数据为成功的空数组；`truncated=true` 表示结果不完整，上层不能把截断数据当作完整集合计算。

相同用户/会话/幂等键和请求条件重复调用返回同一任务结果，`idempotent_replay=true`，
包含持久化原值，不重复执行 SQL；成功结果重放前重新核对当前权限和目录。
同键改条件返回 409 `IDEMPOTENCY_KEY_REUSED`；正在执行的重试返回 409
`QUERY_ALREADY_RUNNING`。失败结果沿用原幂等结果，主动重试需新幂等键。
首次目录/能力拒绝返回 HTTP 200、`result.status=unsupported` 和 `QUERY_UNSUPPORTED`；
首次越权返回 HTTP 200、`result.status=failed` 和 `ORG_SCOPE_FORBIDDEN`。
成功结果重放时权限撤销按公共权限异常返回 403，目录停用返回 422 `QUERY_UNSUPPORTED`。
无有效认证为 401；查询未就绪为 503。HTTP 200 本身不代表查询成功，必须检查 `result.status`。

上层 harness 负责区分正式“较同期”指标与另行计算同比的需求，编排基础查询并调用受控计算工具。
本接口不增加 harness 运行器，也不会自动修复或重跑历史失败任务。

## 4. 通用表达式计算（calculations）

`POST /api/v1/agent-query-contexts`（Bearer，正文 `session_id: UUID`），返回
`conversation_id: agent:<session_id>`，用于 Agent 与后端会话关联。其他用户的同名关联
返回 404；超出会话数量上限返回 409。普通查询不会自动重建已删除的 `agent:` 会话。

`POST /api/v1/calculations`（Bearer、必填 `Idempotency-Key`）：
请求字段为 `conversation_id`、`scope_id`、`expressions`、`bindings` 和可选 `constants`。
`expressions` 中每项包含 `name`、`label`、`expression`，可选 `display` 和 `decimal_places`；
`bindings` 为变量到 `{fact_id}` 的映射；`constants` 为变量到 `{value, source_text}` 的映射。
数值不由模型抄写：服务端从已保存的当前范围查询结果读取原始数据，复核权限后计算。

查询执行响应包含 `facts` 数组，含 `fact_id`、`task_id`、`field`、十进制字符串 `value`、
正式 `unit`、指标编码/名称、机构及日期。无精确原值或缺少单位时不发放引用。
查询执行幂等重放统一先复核当前权限和目录，再返回保存的原始结果及相同引用；
机构权限范围变化后不能通过重放读取原结果。
基础查询可携带可选 `calculation_context: {scope_id, user_question}`。该字段不允许作为身份或权限依据。

计算成功返回 `calculation_id`、`task_id`、`scope_id`、`status`、`results`、`inputs`、
`precision`、`rounding`、`created_at`；每项结果保留原公式、内部数值字符串、展示数值和单位。

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

## 5. 确定性业务字段解析（Pi 内部适配）

`POST /api/v1/business-context/resolve-field`，使用现有 Bearer 身份认证。

`POST /api/v1/business-context/metric-mentions` 同样要求 Bearer，接收 `{"question":"完整用户原文"}`（1～8000 字符），返回 `mentions`：每项含原文 `text`、Unicode 码点 `start/end`（左闭右开）和 `resolution`。完整名称/别名唯一命中，或按完整片段计算的字符/拼音相似度唯一最高分达到 0.95（含）时返回 resolved；后者的 metadata 包含 match=high_confidence、score 和 autoSelectThreshold。低分、不同编码并列最高及描述匹配仍返回候选。分数是算法相似度，不是概率。该接口不执行 SQL、不调用模型；取数权限在正式执行时校验。详细算法与离线依赖见 [指标匹配方案](metric-matching.md)。
请求为 `{ "entity": "metric|organization|date", "raw_values": ["原始表达"] }`；每项非空且不超过 200 字符，最多 100 项，date 仅允许一项。
响应统一为 `{status, value?, candidates?, metadata?}`。
唯一精确名称、受控别名或编码命中返回 resolved；指标的近似匹配同样使用完整片段唯一最高分达到 0.95 的自动采用规则。其余候选返回 ambiguous/needs_confirmation，未命中返回 not_found。
机构候选在返回前裁剪到当前用户授权范围，日期复用后端确定性解析规则，以 Asia/Shanghai 为当前业务日期。
接口不调用模型、不查询指标数值、不接受 SQL。正式执行和结果回读仍须分别校验当前权限。

Business Frame、历史引用、字段变化及唯一页面入口的调用关系见 [Pi 通用多轮业务上下文](pi-business-context.md)。

## 6. 数据覆盖查询

`POST /api/v1/data-availability`（Bearer，受查询就绪门禁）。请求字段：`dimension`
（`dates` 或 `metrics`）、`metric_codes`（最多 100 项）、`org_codes`（最多 100 项）、
`match`（`any`/`all`）、可选 `start`/`end` 日期范围、分页 `page`/`page_size`。
返回所选机构、指标在范围内的数据覆盖情况；越权返回 403，机构、指标或日期范围无效返回
422，覆盖模板未部署或查询失败返回 503。

## 7. 任务状态与结果读取

### 7.1 获取任务状态

```http
GET /api/v1/query-tasks/{task_id}
Authorization: Bearer <token>
```

适用于调用超时后的状态恢复和外部任务轮询。任务归属按当前账号校验，他人任务返回 404。

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

`WAITING_USER`/`CLARIFICATION` 等旧语义链路阶段只出现在历史任务记录中；新链路任务由
basic-queries 一次创建并执行，不会产生待澄清状态。

### 7.2 不可变结果读取

`GET /api/v1/query-tasks/{task_id}/result?offset=0&limit=100` 按任务归属读取已执行结果，不重新查询。

Agent 对用户原文所指的历史结果使用同路径的 `POST`，请求体为：

```json
{"original_question":"刚才江阴3月的数据再显示一下","offset":0,"limit":20}
```

该 POST 是只读校验与分页读取，不创建任务或执行业务 SQL。后端用当前目录的无歧义名称、别名匹配原文中的机构和指标，与不可变结果的正式 DSL 核对；包括零行结果在内，冲突返回 HTTP 409、`RESULT_REFERENCE_CONFLICT`，不返回业务事实。Agent 可据此重新选择已有结果，不能改成新查询。它不负责猜测原文未明示的实体或解析任意自然语言历史指代；GET 兼容原有页面结果加载与分页。

### 7.3 结果导出

`GET /api/v1/query-tasks/{task_id}/result-export` 导出当前账号所属任务的完整 Excel 查询结果。

## 8. 目录与管理接口

所有接口都需要Bearer Token。写接口还要求`SYSTEM_ADMIN`。

### 8.1 指标与向量状态

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/catalog/metrics` | 登录用户 | 指标、同义词、启停用和向量状态 |
| GET | `/api/v1/catalog/metrics/search?keyword=&limit=` | 登录用户 | 指标目录检索：确定性命中（exact/contains/lexical）计入`total`，embedding top-k 仅作`semantic_suggestions`近似推荐 |
| GET | `/api/v1/catalog/metrics/overview` | 登录用户 | 实时启用指标总数及按单位分组的数量与名称示例；不执行问数 |
| POST | `/api/v1/catalog/metrics` | 系统管理员 | 新增指标，自动触发向量同步 |
| PUT | `/api/v1/catalog/metrics/{metric_code}` | 系统管理员 | 修改指标和同义词 |
| DELETE | `/api/v1/catalog/metrics/{metric_code}` | 系统管理员 | 逻辑停用指标 |

### 8.2 机构、数据集和运行日志

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

### 8.3 模型与提示词配置

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

这些是管理接口，不建议开放给普通问数调用方。SQL 模板管理接口已移除，返回404；查询统一由 builder 生成。

## 9. 幂等、并发和重试

### 9.1 幂等键

- basic-queries 与 calculations：`Idempotency-Key` 必填，同一逻辑请求的重试必须复用同一个键；
- 相同键和相同内容返回已有结果，`idempotent_replay=true`；
- 相同键被不同内容复用返回`IDEMPOTENCY_KEY_REUSED`。

不要每次网络重试都生成新幂等键，否则会创建重复任务。

### 9.2 超时和重试建议

- 连接超时：5至10秒；
- 单次查询/计算读取超时：至少190秒，与当前Nginx代理配置一致；
- 只对网络中断、502、503、504和明确可重试错误重试；
- 401重新认证后重试；
- 409先读取任务状态，不直接重放；
- 4xx参数、权限和unsupported错误不自动重试；
- 所有重试复用原`X-Request-ID`关联值和`Idempotency-Key`。

## 10. 错误响应

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
| 409 | `IDEMPOTENCY_KEY_REUSED` | 修正幂等键生成逻辑 |
| 400/422 | `REQUEST_INVALID` 等请求校验失败 | 按`details.fields`修正请求，不自动重试 |
| 200 + `unsupported` | `QUERY_UNSUPPORTED` | 场景尚未实现 |
| 200 + `failed` | `QUERY_EXECUTION_FAILED`等 | 记录task_id和request_id后排查 |
| 500 | `INTERNAL_SERVER_ERROR` | 有限重试并告警 |

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
3. basic-queries 幂等重放；
4. 普通账号跨机构权限拒绝；
5. 空结果、unsupported和模型不可用；
6. 日志中通过`X-Request-ID`完成端到端定位。

## 12. API变更检查清单

每次API相关变更至少检查：

- [ ] 路由表和OpenAPI是否变化；
- [ ] 本文档当前能力状态是否变化；
- [ ] 请求/响应示例是否仍能通过Pydantic校验；
- [ ] 新字段是否说明必填、默认值、长度和兼容策略；
- [ ] 状态码、错误码和重试语义是否更新；
- [ ] 鉴权、角色和机构范围是否更新；
- [ ] 幂等键行为是否更新；
- [ ] Nginx超时或缓冲配置是否同步；
- [ ] agent-service 和 Vue 调用是否同步回归；
- [ ] README和技术栈文档中的能力描述是否同步。
