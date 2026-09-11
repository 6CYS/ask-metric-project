# Ask Metric GoldenDB 后端

行内 GoldenDB + 只读 SIT 数据湖的配置、同步与待确认规则见
[`docs/sit-data-lake.md`](docs/sit-data-lake.md)。

FastAPI 后端负责账号与机构权限、指标目录、会话任务、语义解析、MySQL 模板查询和全过程审计。
应用元数据连接固定使用 `APP_DATABASE_URL`，经营指标查询固定使用只读
`QUERY_DATABASE_URL`；后者按配置使用 MySQL 或 Inceptor 查询模板。

当前机构目录采用扁平结构，`org_terms` 只依赖机构编号、名称、别名和启停状态，不要求
`org_type` 或 `parent_org_code`。普通用户只能查询自己的机构；系统管理员继续按管理权限访问。

## 查询结果展示与追溯

新执行的查询在 API、任务结果和下载明细中保留换算、展示舍入前的数值；数据库 Decimal
以字符串序列化，保留原精度。前端表格按原单位显示：一般指标保留两位小数，户数和排名等整数指标显示整数，不展示单位列；显示格式不回写原始值。
期间对比仍展示本期值、基期值和派生差值/变化率，其中原值不换算，变化率保持计算所得比例。
机构对比的下载明细与页面一样使用逐条结果，不以派生比较记录替代原始记录。

自然语言回复使用确定性规则：已有“元→万元”和金额/户数/排名的展示规则仅作用于回复文本；
百分比按四舍五入最多保留三位小数，并删除小数末尾的零（如 `0.0220055003%` → `0.022%`、
`1.230%` → `1.23%`）。已带 `%` 单位的指标不再乘 100，仅程序计算的变化比例转为百分比；
未知单位不猜测。审计事实仍绑定未换算数值。已有历史任务不会重写，需重新查询才能得到新版结果。

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
trace/segment/span链路标识。生产启动 Uvicorn 时使用 `--no-access-log`，避免默认访问日志与
规范格式混排。系统管理员可以调用 `GET/PUT /api/v1/logging/level` 查询或动态调整日志级别。

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

默认模糊匹配不依赖 Milvus。每个后端进程共享一个指标目录向量缓存：首次模糊匹配时，
将当前目录中的指标名称、别名和描述分批发送给 Embedding，结果保存在进程内存中；
后续请求只向 Embedding 发送当前查询文本，在内存中计算相似度，再按配置调用 Reranker。
精确匹配与关闭 Embedding 时的词面匹配不触发目录向量加载。

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

缓存不落盘，不保存用户查询向量；内存占用随当前目录规模和向量维度增加。
多 worker 各自持有缓存，重启后需要重新加载。**首次模糊查询仍有初始化耗时，不是启动时
后台预热**，建议上线验收时先执行一条模糊指标查询完成加载，再评估后续查询耗时。
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
