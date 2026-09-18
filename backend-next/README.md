# Ask Metric GoldenDB 后端

行内 GoldenDB + 只读 SIT 数据湖的配置、同步与待确认规则见
[`docs/sit-data-lake.md`](docs/sit-data-lake.md)。

FastAPI 后端负责账号与机构权限、指标目录、会话任务、语义解析、MySQL 模板查询和全过程审计。
应用元数据连接固定使用 `APP_DATABASE_URL`，经营指标查询固定使用只读
`QUERY_DATABASE_URL`；后者按配置使用 MySQL 或 Inceptor 查询模板。

当前机构目录采用扁平结构，`org_terms` 只依赖机构编号、名称、别名和启停状态，不要求
`org_type` 或 `parent_org_code`。普通用户只能查询自己的机构；系统管理员继续按管理权限访问。

## 查询能力校验与模型输出契约

### 通用表达式计算

`POST /api/v1/calculations` 按当前提问的数据引用执行表达式，采用 `simpleeval==1.0.8`
和 `Decimal`，计算证据复用任务 JSON 持久化，无数据库结构迁移。升级需同步后端、Agent
和前端，并把新增依赖纳入离线包。接口、精度、限制和验收见
[通用表达式计算工具](../docs/calculation-tools.md)。

### 结构化基础查询入口

`POST /api/v1/basic-queries` 接收正式 `metric_codes`、`org_codes`、显式日期范围和
`selection`（`exact`、`latest_in_range`、`all_in_range`），使用 Bearer 认证及必填
`Idempotency-Key`。该入口跳过意图与槽位模型，复用任务、目录/权限校验、模板执行和结果证据；
不接收 SQL、自然语言或同比等分析操作。完整合同与请求示例见
[外部 API 文档](../docs/external-api.md#结构化基础查询basic-queries)。

现有聊天入口保持原能力和不支持请求的明确拒绝。完整歧义别名也会在槽位模型调用前隐藏名称内部
的操作词，仍须通过原澄清流程选择编码；不会根据选中的指标名称删除已经识别出的外围操作。
上层 harness 可编排多次基础查询，将计算交给受控工具；本次没有接入 harness 运行器。
升级无需数据库迁移或新增配置，也不会修改旧失败任务的槽位。升级后使用明确编码与日期验证取数。


原句不再按“明细、详情、逐笔、流水”等关键词拦截。先保护正式指标与机构名称，
再由模型提取结构化操作；执行前由 `QueryPlanner` 统一核对查询形态、操作、维度和筛选条件。
系统仍只执行已登记的指标查询模板，不提供逐笔交易或原始流水查询。
合法但不支持的查询返回 `QUERY_UNSUPPORTED`，不会调用业务查询数据库；旧的
`INITIAL_SCOPE_UNSUPPORTED` 和“一期单指标”拒绝文案不再由新查询返回。

槽位模型必须显式返回 `ops` 数组，纯取值返回 `[]`。缺失或格式错误的操作，以及错误的
筛选、维度、参数或任务类型会使语义解析失败，返回 `SLOT_FRAME_VALIDATION_FAILED`；
不得删除错误条件后继续执行。这里收紧的是外部模型输出，历史 SlotFrame 的读取默认值保持兼容。

此契约通过现有 `slot_frame_schema_json` 注入槽位提示词，不新增模型调用、不改变模型 HTTP 接口或认证方式，
也不覆盖持久提示词。升级时确认 `PROMPT_CONFIG_PATH` 实际文件中的 `slot_extraction.user_template`
保留 `{slot_frame_schema_json}`；若现场自定义模板曾移除它，应按当前模板补回并联调。
字段完整性校验不能证明模型语义理解一定正确：模型明确返回 `ops: []` 但实际漏理解操作的情况，
仍需使用行内模型准确率用例验证，不能视为静态检查已解决。

`slot_extraction` 1.3.1 明确区分取值与额外计算：询问某机构某日的指标值返回 `ops: []`，
不能因机构名包含“汇总”、指标属于客户数/总额或编码中有数量缩写就生成 `aggregate/sum`。
正式目录候选只说明实体身份；真实的求和、动态排名、比较要求仍须保留并交由后端校验。
时间保留用户表达的粒度：“2026年4月”解析为 `2026-04-01至2026-04-30`，
“2026年4月末”解析为 `2026-04-30`；指标名称中的“当日数”等字样不能把整月缩成月末。
普通区间取值仍返回范围内最新一期，并在回复中说明查询范围及实际数据日期；
不等同于整月合计或每天明细，实际返回日期也不回写为用户查询范围。
升级时备份后合并实际 `PROMPT_CONFIG_PATH` 中该提示词的 `system` 和 `user_template`；
协议、占位符和模型鉴权不变，不整份覆盖其他自定义配置。失败历史不会自动重算，使用新问题验证。

后续上层 harness 可以复用相同的可信执行边界；目录、权限、日期、操作和模板校验仍由后端执行。

槽位提示词按实体保护、日期粒度、查询操作与机构范围分段约束；普通取值仍返回 `ops: []`，
明确提出的额外计算仍须保留并通过能力校验。升级时合并实际使用的槽位提示词，不覆盖其他自定义配置。

## 查询结果展示与追溯

新执行的查询在 API、任务结果和下载明细中保留换算、展示舍入前的数值；数据库 Decimal
以字符串序列化，保留原精度。前端表格按原单位显示：一般指标保留两位小数，户数和排名等整数指标显示整数，不展示单位列；显示格式不回写原始值。
期间对比仍展示本期值、基期值和派生差值/变化率，其中原值不换算，变化率保持计算所得比例。
机构对比的下载明细与页面一样使用逐条结果，不以派生比较记录替代原始记录。

自然语言回复使用确定性规则：已有“元→万元”和金额/户数/排名的展示规则仅作用于回复文本；
百分比按四舍五入最多保留三位小数，并删除小数末尾的零（如 `0.0220055003%` → `0.022%`、
`1.230%` → `1.23%`）。已带 `%` 单位的指标不再乘 100，仅程序计算的变化比例转为百分比；
未知单位不猜测。审计事实仍绑定未换算数值。已有历史任务不会重写，需重新查询才能得到新版结果。

## 独立问数与当前任务澄清

每次新问题只解析本次输入，模型调用不读取其他任务的条件或结果。查询完成后输入“那江阴呢？”
会创建新任务，并澄清缺失的指标、日期等条件。会话用于集中展示历史，不代表自动继承条件。
尚未完成的任务通过 `task_id`、版本和 `clarification_id` 补充条件，保留本任务已经确认的条件。
日期缺失时等待用户补充，不代填；正式指标名称仍先做目录匹配和实体保护。

机构不明确或不在目录中时必须澄清，不能用整个目录代替。槽位提示词 1.3.2 要求明确全机构
查询同时输出 `options.organization_scope=synchronized_catalog` 和原文依据
`options.organization_scope_text`；依据不得来自已保护的指标或机构名称。若缺少依据、同时
要求补充机构，或同时返回具体/未知机构，后端停止展开并要求选择机构，已确认的指标和日期保留。
这项修复需同时更新后端与实际 `PROMPT_CONFIG_PATH` 中的 `slot_extraction`，并重启后端；
仅更新仓库默认提示词不会替换生产持久配置。旧提示词返回无依据范围时会进入澄清，旧结果不改写。

历史会话及结果可查看、下载，不会重新查询业务库。自然语言历史指代、结果裁剪和基于历史结果
继续查询已退出；旧跨任务追问或指代任务尝试分析、澄清、执行时返回 `CROSS_TASK_CONTEXT_RETIRED`（409）。
已保存的结果和消息不改写，不提前接入 harness。

升级时同步部署前后端，并备份后合并实际 `PROMPT_CONFIG_PATH` 指向的持久配置：

- 删除 `conversation_contextualization`、`multiturn_context_patch`、`result_reference_selection` 提示词；
  合并默认 `intent_routing` 和 `slot_extraction` 中独立问题、缺失条件不猜测的要求，保留自定义模型协议。
- 移除运行环境的 `MULTITURN_*` 配置项；这些项已没有运行入口，不能恢复旧功能。
- 集成 `/api/v1/integrations/ask` 的 `history` / `messages` 仍兼容接收，但不参与解析；续澄清须传 `clarification_id`。
  `reply_to_task_id` 等旧引用仅保留请求协议兼容，不用于条件继承。
- 旧 `/multiturn/metrics`、`/multiturn/readiness`、`/multiturn/review-samples` 和任务 `multiturn-review` 接口已移除。
- 无数据库结构变更。重启后验证独立提问、同任务补日期/选指标、旧结果查看和下载。

## 旧归因原型退出与升级

当前版本仅维护单次可信问数、当前任务澄清和历史结果查看/导出。原 LangGraph 归因运行器、
专属 Skill/关系配置、归因模型参数和进度/取消接口已移除；不支持通过开关恢复旧原型。
归因请求返回 `INTENT_NOT_AVAILABLE`，不会转成普通取值或历史结果读取。
`POST /api/v1/query-tasks/{task_id}/analyze` 仍是普通查询的语义解析入口，继续保留。

升级原试验环境时：

1. 停止旧服务并备份持久配置。移除旧 `ANALYSIS_*` 环境项；无需为普通问数安装 LangGraph。
2. 合并仓库 `config/prompts.json` 到实际 `PROMPT_CONFIG_PATH` 指向的文件：更新
   `intent_routing`、`slot_extraction` 的独立查询协议，删除 `analysis_target` 和 `analysis_action`，
   并按上节移除跨任务提示词。
   保留已经维护的目录保护、澄清文案和其他自定义配置，不整份覆盖生产持久配置。
   新协议删除了分析历史占位符；管理页面不允许变更占位符集合，须通过受控的配置文件发布完成。
   `config/prompts.query-only.json` 保留客户已有部署的兼容路径；已使用该路径的环境无需改路径，
   仍须按同一查询协议合并实际持久配置并移除旧 `MULTITURN_*` 环境项。
   默认提示词与兼容文件分别按部署实际路径核对，不直接用其中一份覆盖另一环境的自定义配置。
3. 重新安装当前依赖并同步部署前后端，重启后验证独立查询、当前任务澄清、历史结果读取与导出。
   前端不再轮询 `analysis-progress` 或调用 `analysis-cancel`，这两个接口返回 404。

旧归因记录和结果保留只读展示与导出，读取时继续检查目标及证据机构权限。
旧澄清、旧分析及其内部取证任务不能续跑或重新执行，相关命令返回
`LEGACY_ANALYSIS_READ_ONLY`（409）；请新发起指标查询。
旧分析记录不参与查询条件解析，前端不再提供其澄清交互。

已有 `0003_analysis_checkpoints` 迁移及历史表映射保留，避免破坏既有迁移链；
普通查询不访问这些归因表。本次升级不执行删表、数据清理或迁移回退。
未来接入 harness 时复用查询、证据及权限能力，当前没有新的归因运行器。

## 运行

首次部署请先阅读 [本地部署指南](../docs/本地部署指南.md)，完成双库、非空签名密钥、
正式目录、模型配置和首个账户准备。不要把根目录环境模板当作后端模板。

在 `backend-next/`、已启用虚拟环境的终端执行：

```sh
python -m pip install -e .
python -m uvicorn ask_metric.main:app --app-dir src --host 127.0.0.1 --reload --port 8010 --no-access-log
```

开发检查才需要 `python -m pip install -e ".[dev]"`。配置参考 `.env.example`。
应用库结构只允许通过 `alembic-goldendb.ini` 管理；实际变更须先生成 SQL 供 DBA 审核。
离线导出也会检查结构变更开关，非专用测试库还需要第二个授权开关；完整命令见上述指南。

## 日志

开发环境默认打印受控控制台日志；生产环境默认强制写入可配置的 `LOG_DIRECTORY`，并拆分为
`app.log`、`summary.log` 和 `alert.log`。默认单文件上限50MB、保留3天，跨日或达到上限后归档
到日期目录。HTTP请求自动生成交易 START/END 摘要，并透传全局流水、服务调用流水及
trace/segment/span链路标识；模型和SSO外调生成新的40位 `R` 流水并输出 SUBSTART/SUBEND。
全局流水和SpanID采用六段40位格式，分别以 `G`、`R` 开头；生成所需的 `APP_NODE_CODE`、
`APP_IDC`、`APP_UNIT` 对应主机注入的 `App_Node_Code`、`App_IDC`、`App_Unit`。生产启动
Uvicorn 时使用 `--no-access-log`，避免默认访问日志与规范格式混排。系统管理员可以调用
`GET/PUT /api/v1/logging/level` 查询或动态调整日志级别。


异常日志保留异常类型、调用帧和因果链的定位信息；不输出原始异常正文、源码行或局部变量，避免模型响应、SQL 参数及业务数据进入日志。

### Nacos 集群与 Gateway

后端直连开发时 Nacos 默认关闭；经 Gateway 访问时，在 `.env` 中启用注册：

```dotenv
NACOS_ENABLED=true
NACOS_SERVER_ADDR=192.0.2.11:8848,192.0.2.12:8848,192.0.2.13:8848
NACOS_NAMESPACE=public
NACOS_GROUP=DEFAULT_GROUP
NACOS_SERVICE_NAME=ask-metric-python
NACOS_CLUSTER_NAME=DEFAULT
NACOS_INSTANCE_IP=192.0.2.10
NACOS_INSTANCE_PORT=8010
NACOS_INSTANCE_ID=ask-metric-01
NACOS_USERNAME=nacos
NACOS_PASSWORD=
NACOS_EPHEMERAL=true
NACOS_FAIL_FAST=false
```

`NACOS_INSTANCE_IP` 必须是 Gateway 可访问的后端内网地址，跨容器或跨主机时不能填写
`127.0.0.1`。各后端实例应使用不同的 IP/端口组合和 `NACOS_INSTANCE_ID`。SDK 维护临时实例
连接、心跳及重连，应用正常退出时主动注销。Nacos 暂时不可用默认不阻止后端启动；如果要求
注册失败即终止启动，设置 `NACOS_FAIL_FAST=true`。

Gateway 必须使用完全相同的 namespace、group 和 cluster，并将后端 URI 设置为
`lb://ask-metric-python`。Nacos 集群节点地址使用英文逗号分隔。网络策略除允许客户端访问
Nacos HTTP 端口（通常为 `8848`）外，还需允许 Nacos 客户端 gRPC 端口（通常为 `9848`）。

### SM4 加密运行配置

生产环境的 Nacos 密码、数据库 URL、模型 API Key、JWT/管理令牌和 SM2 私钥支持使用
`ENC[SM4:v1:...]` 密文保存。先生成独立的 16 字节主密钥（32 位 hex），将其放入仅运行
用户可读的文件；主密钥文件不得提交到 Git，也不得与密文写在同一个配置文件中：

```bash
umask 077
openssl rand -hex 16 > /etc/ask-metric/config-sm4.key
chown root:askmetric /etc/ask-metric/config-sm4.key
chmod 0640 /etc/ask-metric/config-sm4.key
python -m ask_metric encrypt-config --key-file /etc/ask-metric/config-sm4.key
```

命令会隐藏读取一个明文配置值并输出密文。将输出写入 `backend.env`，并配置：

```dotenv
ASK_METRIC_CONFIG_SM4_KEY_FILE=/etc/ask-metric/config-sm4.key
NACOS_PASSWORD=ENC[SM4:v1:...]
APP_DATABASE_URL=ENC[SM4:v1:...]
QUERY_DATABASE_URL=ENC[SM4:v1:...]
```

应用在配置校验前完成解密，数据库、Nacos、迁移及目录同步共用同一入口。密文使用随机 IV
的 SM4-CBC，并以 SM3-HMAC 校验完整性；缺少密钥、格式错误或密文被篡改时启动会失败。

### 登录有效期与刷新恢复

`JWT_EXPIRE_MINUTES` 控制登录后的固定有效期，默认 `480` 分钟（8 小时）；页面刷新不会重新
登录或延长有效期。调整实际环境配置并重启后，对新登录生效，已签发令牌仍按原 `exp` 过期。

浏览器登录及 SSO 通过同源 `/api/v1/auth/` 接口申请会话 Cookie。Cookie 使用 `HttpOnly`、
`SameSite=Strict`、限定 Path，不设置 Domain；生产使用 `__Secure-ask_metric_session`，强制
`Secure`。浏览器脚本不读取 Cookie，不把访问令牌写入 localStorage/sessionStorage。刷新时调用
`POST /api/v1/auth/session`，重新校验原 JWT 和当前账号、机构、角色、会话版本，返回原访问令牌
供页面内存使用；不签发新令牌、不续期。正常业务接口仍仅接受 Bearer，不接受 Cookie 认证。
退出登录撤销服务端会话并删除 Cookie；账号停用、角色或机构变化、其他位置重新登录后，旧会话
均不能恢复。网络暂时异常不视为令牌过期，退出请求失败会明确提示重试。

浏览器认证请求携带 `X-Ask-Metric-Session: 1`，服务端检查来源与 Fetch Metadata；响应禁止缓存。
旧 API 客户端不带此头时保持原 Bearer 登录协议。CORS 仍不允许跨域携带凭据。

部署与升级要求：

- 同步更新前后端；升级后首次需要正常登录一次，建立新的恢复 Cookie，无数据库迁移。
- 生产浏览器入口必须为 HTTPS，可由行内网关终止 TLS。仅内部代理到后端可使用 HTTP；生产
  HTTP 入口无法保存 Secure Cookie，不可通过关闭 Secure 或改成开发环境绕过。
- 保留浏览器原始 Host（含端口），并由可信代理传递正确的协议。若多层代理导致后端看到内部
  地址，在 `CORS_ORIGINS` 中明确登记浏览器入口的完整 origin（协议、主机、端口，不含路径），
  不使用通配符。这只用于已有允许来源配置，不开启跨域 Cookie。
- `development/test` 的本机 HTTP 使用独立名称 `ask_metric_session_dev`；本机 HTTPS 仍使用
  Secure Cookie。Vite 代理和正式 Nginx 同源 `/api` 均须指向同一个后端。

### 数字农商单点登录

生产环境启用 SSO 时，在环境文件中配置 `SSO_ENABLED=true` 和数字农商用户信息校验接口的完整 URL：

```dotenv
SSO_ENABLED=true
SSO_USER_INFO_URL=https://<digital-rural-host>/yusp-app-oca/api/ssoconfig/userInfo
SSO_TIMEOUT_SECONDS=10
SSO_SOURCE_SYSTEM=jsrcb
```

前端入口使用 `/login?token={数字农商token}`。后端会在服务端携带 Bearer token 调用上游接口，
校验成功后签发本系统 JWT；浏览器不会直接调用数字农商接口。上游返回的机构必须已登记在
`org_terms` 机构目录中。

## 模型与模板配置

`config/model-config.json` 使用通用 OpenAI 兼容配置，不绑定厂商。Chat、Embedding 和 Reranker
分别支持：

- 独立启停、API 路径、模型名和超时；Base URL 通过 `MODEL_CHAT_BASE_URL`、
  `MODEL_EMBEDDING_BASE_URL`、`MODEL_RERANK_BASE_URL` 从进程环境或外置环境文件读取，
  不在源码配置中固化厂商公网地址或行内 IP；
- 无认证、Bearer 或自定义 Header 认证；
- 独立密钥环境变量，密钥不写入 JSON、日志或 API 响应；
- Chat JSON 输出、`chat_template_kwargs`、Embedding 维度、Reranker 的
  `documents`/`texts` 字段等差异；
- 三类模型均支持受校验的 `extra_body` JSON，可透传 `top_p`、`seed` 和厂商扩展参数，
  无需修改请求代码。系统管理的核心字段和鉴权字段不能由 `extra_body` 覆盖。

提示词位于 `config/prompts.json`，SQL 注册表位于 `config/query-templates.json`，MySQL 与
Inceptor 模板分别位于 `resources/sql/mysql/` 和 `resources/sql/inceptor/`。MySQL 模板保留给
外网/本地模式；行内设置 `QUERY_DATABASE_DIALECT=inceptor` 后只选择 Inceptor 模板。Inceptor
模板中的事实表及核心字段均由 `SIT_*` 环境变量渲染，当前行内测试表名只是默认值。生产安装会
把这些可编辑文件初始化到持久状态目录，使管理员界面
可以发布、试跑和回滚且不受版本升级覆盖。

配置读取要求系统管理员。要允许写入和连通性测试，还必须设置：

```dotenv
MODEL_ADMIN_WRITE_ENABLED=true
MODEL_ADMIN_TOKEN=ENC[SM4:v1:...]
```

本机开发可改为 `MODEL_ADMIN_TOKEN_REQUIRED=false`，此时已登录的系统管理员无需再填写管理
令牌即可保存和测试模型配置。该模式仅允许用于 `APP_ENV=development` 或 `test`；生产环境启动时
会拒绝关闭二次令牌校验。

浏览器提交管理令牌时使用 `X-Model-Admin-Token`；后端不会返回任何模型密钥。命令行连通性检查：

```powershell
python scripts/verify_model_provider.py
```

当前行内测试接口使用以下兼容配置：Chat 通过自定义 `accessKey` 请求头认证，发送
`chat_template_kwargs.enable_thinking=false`，并在用户消息末尾追加 `/no_think`；Embedding
发送 `model=atom`、`encoding_format=float` 和 `user=user`；
Reranker 只发送 `query` 与 `texts`。上述请求参数差异由 `model-config.json` 中的开关控制，
可在管理员页面修改。真实 accessKey 只填写到 `MODEL_CHAT_API_KEY`，不得
提交到 Git。

重排响应兼容两种格式：标准 `results: [{index, relevance_score}]`，以及行内
`scores: [分数, ...]` 与 `texts: [候选文本, ...]` 并列数组。行内格式要求两个数组
与请求候选数量一致，`texts` 与请求文本顺序、内容完全一致，分数必须是有限数值；
后端按原候选位置转换为 `index/relevance_score`，由语义引擎按分数排序和筛选。
不接受缺失、重排或替换文本的响应，避免将分数关联到错误指标。该适配无需新增配置，
不影响内存向量缓存。结构不符时记录 `model_rerank_response_invalid reason=...`，
不记录原始响应或候选正文；HTTP 200 日志仅表示传输成功，不能代替响应校验。

### 指标目录内存向量缓存

默认模糊匹配不依赖外部向量库。每个后端进程共享一个指标目录向量缓存：后端启动时即在后台
将当前目录中的指标名称、别名和描述分批发送给 Embedding，结果保存在进程内存中；
后续请求只向 Embedding 发送当前查询文本，在内存中计算相似度，再按配置调用 Reranker。
在线精确匹配不调用 Embedding；配置中关闭 Embedding 时跳过启动向量预热，沿用词面匹配。

配置位于实际 `SEMANTIC_CONFIG_PATH` 文件中的 `metric_matching`：

```json
{
  "embedding_batch_size": 16,
  "embedding_cache_wait_seconds": 60
}
```

每批默认 16 条（允许 1～128），等待其他请求加载目录的上限默认 60 秒（允许大于 0、
不超过 600）。旧持久配置缺少这两项时自动使用默认值，无需覆盖原配置。
这两个参数不改变模型 HTTP 超时；HTTP 超时仍由实际 `MODEL_CONFIG_PATH` 中 Embedding 的
`timeout_seconds` 控制。分批降低单次请求负载，但不能保证模型服务本身永不超时。

目录名称、别名或描述变化后，仅补算变化的文本，并淘汰已删除文本；目录顺序变化不重算。
Embedding 模型、有效服务地址、维度、请求配置或凭据变化时重新加载，防止混用不同向量空间。
同一地址与模型名背后的模型若被直接替换且配置未变，需重启后端使缓存失效。
并发冷请求只允许一个请求加载目录；其他请求超出等待上限会返回忙碌，可稍后重试。
成功批次会保留，失败批次下次重试；只有完整、数量和维度一致且数值有效的目录才用于检索。

目录向量使用 Python 标准库 `array('f')` 连续 float32 矩阵，按行只读访问，无新增离线依赖；
10,000 条 × 1,024 维的矩阵本体为 40,960,000 字节，约 39.1 MiB，另有目录文本、行索引和批次响应开销。
不改变模型调用协议、指标文本构造、余弦计算公式、召回数量与重排规则，不改变业务查询原始数值精度。
float32 转换可能使极近分数或阈值边界出现微小差异，不能承诺任意输入排序逐位一致。
缓存不落盘，不保存用户查询向量；多 worker 各自持有缓存、分别预热，重启后重新加载。
目录更新时为正在执行的查询保留旧矩阵快照，更新期间会短暂同时占用新旧矩阵内存。

启动期间 HTTP 服务可访问，`GET /api/v1/query-readiness` 返回 `initializing`、`ready` 或 `failed`，
及脱敏提示、已完成条数和总条数（相同文本去重）。前端显示“问数系统指标检索功能正在初始化”，
禁用提问和澄清提交，完成后自动开放；历史结果仍可查看。失败后每隔 30 秒自动重试并复用成功批次。
后端同步对提问、解析、执行、补充条件、集成问数和测试中心启动返回 HTTP 503；不会创建半成品任务。
`/health` 只检查进程存活；`/health/ready` 在目录初始化完成且原有应用表检查通过后返回 200。
初始化期间 `/health/ready` 返回 503 属于预期状态，不应据此反复重启进程；一万条目录默认分约 625 批，
部署就绪等待时间应覆盖模型实际吞吐。可通过初始化状态接口查看进度后再做模型和真实查询验收。
就绪仅代表目录预热完成，不代替理解模型、重排模型和查询数据库的端到端验收。
生产正常启动默认开启预热；`APP_ENV=test` 的隔离测试默认不联系外部服务，启动测试显式启用并注入桩。
缓存只用于当前请求目录的候选召回，不改变正式目录校验、机构授权或查询能力校验。

`app.log` 中的 `catalog_vectors` 记录目录条数、此次补算/复用条数与加载耗时，不记录指标文本、
向量或密钥。正常热查询应显示 `embedded=0`；`model_api` 日志仍可区分各模型接口耗时。
`/v1/embeddings`、`/v1/rerank` 等路径发生错误时，任务阶段归类为 `ENTITY_RESOLUTION`。

## 安全边界

- 登录密码国密链路：前端从 `GET /api/v1/auth/sm2-public-key` 取 SM2 公钥，每次登录生成
  一次性 SM4 密钥，密码用 SM4-CBC 加密、SM4 密钥用 SM2（C1C3C2）加密后传输，链路上不出现
  明文密码；密码在库中使用加盐 SM3 哈希存储（`sm3$` 前缀），存量 argon2 账号登录成功后
  透明迁移。SM2 私钥只配置在 `SM2_PRIVATE_KEY`，生产环境必填。使用
  `python scripts/generate_sm2_keypair.py --output /protected/path/sm2.env` 生成新文件，
  再通过既有配置加密流程导入；工具不打印私钥、不覆盖已有文件，Linux 文件权限为 0600。
  Windows 下应选用仅部署管理员可访问的目录（文件权限由目录 ACL 控制）；
- 模型只返回槽位、意图和总结，不生成 SQL；
- SQL 只能来自登记模板，标识符不接受模型或用户输入，业务参数全部绑定；
- 查询连接必须使用数据库侧只读账号，应用 Unit of Work 不会复用查询连接；
- 普通用户只能查询其账号机构，系统管理员权限也由服务端账号记录决定；
- Schema 变更、生产库测试、配置写入均有独立显式开关。

## 代码检查

语义边界回归测试使用固定模型响应，不连接数据库或真实模型：

```powershell
python -m unittest discover -s tests -v
```

语义解析保留通过结构校验的模型操作、排序参数、日期和时间模式，不再通过中文关键词
增删操作或按指标名称删除对比、重写排名。正式指标与机构仍由目录校验，确定名称在模型
调用前通过占位符保护；日期合法性、机构权限和查询模板能力仍由后端检查。模型识别出
暂不支持的明细、汇总或动态期间对比时，查询能力检查会明确拒绝，不会降级为普通取值。

`config/semantic-config.json` 的 `clarification_prompts` 同时控制澄清字段的 `message`
和最终澄清提示中的对应文案：

- `metrics_with_options`：指标候选提示，支持 `{options}`。
- `metrics_without_options`：没有候选指标时的提示，不含占位符。
- `missing_fields`：缺失字段汇总提示，支持 `{fields}`。
- `field_labels`：按 `metrics`、`time`、`orgs` 等字段设置名称。
- `scenarios`：场景文案优先于通用指标文案；支持 `metric_missing`、`metric_ambiguous`、
  `metric_not_found`、`invalid_date`、`year_required`、`time_missing`、
  `organization_missing`、`organization_unknown`，占位符可用 `{time}`、`{metric}`、
  `{organization}`、`{options}`。未配置的非指标场景沿用内置文案。

模板中的字面花括号使用 `{{` 和 `}}`；不支持的占位符、格式化选项或不完整花括号会在
配置加载时拒绝。请修改运行环境实际使用的 `SEMANTIC_CONFIG_PATH` 文件；生产环境可能
使用持久状态目录中的副本，而不是仓库中的默认文件。固定的开场与回复示例仍由程序生成。

```powershell
python -m ruff check src scripts
```

## 部署前同步正式指标目录

在已安装依赖的后端目录执行正式 CLI。先按部署方式向进程注入实际环境配置；源码启动读取
该目录的 `.env`，服务部署使用实际 `backend.env` 的受控环境加载方式。命令不接受 `--config`。
指标目录源连接优先使用 `METRIC_CATALOG_DATABASE_URL`，未设置时使用
`QUERY_DATABASE_URL`，均须只读；应用目录写入 `APP_DATABASE_URL`；
表名、字段名和配置版本排序复用 `SIT_*`，不得把凭据直接写入命令。

```bash
python -m ask_metric sync-metric-catalog --all-snapshots --dry-run
python -m ask_metric sync-metric-catalog --all-snapshots
```

第一条只预览，确认汇总后才执行第二条写入应用库；正式 CLI 不带 `--dry-run` 就会写入。
默认只读最新事实快照；`--all-snapshots` 扫描全部快照中的不同指标定义。
配置表 `indcr_no` 严格关联事实表 `orig_indcr_no`，配置名称仅去掉开头一次“机构”，
再直接拼接事实表 `indcr_nm`。最终编码来自事实表 `indcr_no`，不猜测或改写正式口径。
缺少关联的记录计入跳过数量；同编码不同名称时整批中止，不写入应用库。

可用 `--units /path/to/metric-units.json` 提供完整名称到原始单位的 JSON 对象；
`--infer-units` 按已确认规则补充单位，未知单位中止写入，业务数值不参与换算。
未传单位参数时保留现有单位。不使用 `--full` 做普通增量同步；该参数有额外目录清理语义。
重复同步按编码更新并启用，保留原有别名及未出现的目录项，不同步指标数值、不修改源库。
同步成功后重启后端刷新目录缓存和向量，初始化完成后再开放问数。

## 指定机构快照及范围校验

机构目录源连接优先使用 `ORG_CATALOG_DATABASE_URL`，未设置时使用 `QUERY_DATABASE_URL`；
以 `org_no`、`org_chn_nm` 写入正式机构目录，源账号须只读。
默认读取最新快照，`--snapshot-date YYYY-MM-DD` 可指定已核对的源快照。
在完成上节环境配置后，先预览再写入：

```bash
python -m ask_metric sync-org-catalog --strict-scope --dry-run
python -m ask_metric sync-org-catalog --strict-scope
```

`--org-aliases /path/to/org-aliases.json` 接收机构编码到别名数组的映射，只允许本次范围内编码，
追加并去重，不覆盖原有人工别名。空值、超长编码或名称、同码异名、机构数量不符时中止。
默认确认范围为 61 家；`--strict-scope` 同时拒绝应用库中已启用的范围外机构。
遇到编码或范围冲突先核对权限和历史引用，不通过扩大同步范围消除错误。
这些操作不变更数据库结构，也不修改数据湖；目录变更后重启服务刷新缓存。

### 普通用户全行查询授权

普通用户默认仅查询所属机构。需要全行查询时，在后端环境配置
`ALL_ORGANIZATION_USER_IDS='["用户ID"]'` 并重启后端。仅指定的已认证、所属机构
仍有效的用户可查询全部启用机构，角色仍为 `USER`，管理接口权限不变；
空机构条件仍默认本人机构。撤销时移除 ID 并重启，不接受前端或模型声明此授权。

## 目录概览

`GET /api/v1/catalog/overview?catalog=metrics&limit=8` 返回启用指标总数及有限示例；
`catalog=organizations` 返回当前账号查询权限内的启用机构数量及示例。
需要现有 Bearer 登录鉴权，机构权限复用查询授权规则；`limit` 为 1–20，默认 8。
返回 `total`、`examples`、`examples_only`、`data_availability`，不返回完整目录或查询编码。

`CATALOG_OVERVIEW_METRIC_CODES` 为 JSON 编码数组，最多 100 个，配置默认示例见 `.env.example`。
按配置顺序展示并去重，停用及无效编码自动过滤；不足时不随机补齐，空数组仅显示数量。
示例配置不影响正式目录、语义匹配及查询权限。修改部署环境配置后重启后端生效。
目录当前没有可复用分类字段，因此首版不生成类别或假设业务覆盖日期；实际数据需查询确认。
无数据库结构变更，不依赖真实数据湖取数，未添加跨用户摘要缓存。
