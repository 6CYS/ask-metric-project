# 自主分析后端部署、兼容与回退

本文描述当前改造的部署条件，不表示已在真实数据库执行迁移或已通过生产验收。自动回归使用隔离 SQLite / 合成数据；另按用户允许的 metric_values 范围执行了真实只读取数与独立 SELECT 对照，应用状态和授权身份仍完全隔离。其来源与缺口见 `data-preflight-summary.md`，真实读取证据见 `metric-values-actual-backend-acceptance.json`。

## 数据库增量

新增 Alembic revision `0006_analysis_constraints`，文件为 `backend-next/alembic_goldendb/versions/0006_analysis_constraint_snapshots.py`，前序为 `0005_metric_source_structure`。

迁移仅新增 `analysis_constraint_snapshots`：按会话、analysis_id、constraint_version 唯一保存固定目标、原文来源、逐 target 绑定及版本哈希。原有指标表、事实值、账号、权限、会话和查询结果不被替换。新表纳入既有 schema_governance 受治理对象清单。

查询准备复用 `query_tasks.state_json.analysis_execution_v1`，新增生命周期 `PREPARED / ANALYSIS_PREPARED`。准备阶段只做目录、权限、固定范围、来源、规划和只读 SQL 结构验证，不执行 SQL。执行阶段继续使用原执行器和不可变结果快照。

正式部署前按现有 `backend-next/scripts/run_goldendb_migration.py` 生成从已部署实际 revision 到 head 的离线 SQL，先检查备份与应用库目标，再走环境已有审批。不得把查询数据湖当成应用库目标，不改写已发布迁移历史。本次没有执行 `--apply`，也没有设置现库 schema 变更许可。

## 双端配置和开关

| 配置 | 当前用途 | 缺省与兼容 |
| --- | --- | --- |
| 后端 `AGENT_SERVICE_TOKEN` | 验证 `X-Agent-Service-Token`；签发并验证正式目录引用 | 空值时 `/api/v1/analysis/*` 返回 ANALYSIS_DISABLED；旧基础查询不依赖此配置 |
| Agent `AGENT_SERVICE_TOKEN` | 分析 HTTP 调用附带同名服务头 | 必须与后端解密后的实际值完全一致；缺少时不能开启分析 |
| Agent `AGENT_TURN_CONTRACT_V2` | 新操作使用简化工具输入协议 | 默认 false；旧 legacy/compact 解码继续用于兼容 |
| Agent `AGENT_ANALYSIS_PLANNING` | 注册分析工具、加载分析 Skill、启用新分析能力 | 默认 false；开启前必须同时启用 V2 和服务凭据 |
| Agent `AGENT_ANALYSIS_ACCEPT_NEW` | 仅控制 analysis_task.create 接纳新任务 | 默认 true；false 时既有 read/revise/complete 及恢复保留 |
| Agent `AGENT_ANALYSIS_CATALOG_FILE` | 可选的受审阅分析目录发现元数据 | 默认空；不因此向正式目录写入指标、公式、单位或数据值 |

两端服务凭据支持既有 `ENC[SM4:v1:...]` 安全配置方式。凭据不可放在浏览器、工具 Schema、模型上下文或日志中。服务凭据不代替用户 Bearer：目录签发、约束登记、准备、执行及按键回查全部继续验证正常用户身份和会话归属；执行、重放与结果读取仍复核当前权限和正式目录。

## 安全发布顺序

1. 固定当前直接查询、多轮继承、确认、排名/位次、历史读取、计算和重启恢复基线。真实模型和真实源数据验收分别记账，不把桩结果算作湖结果。
2. 部署包含新契约和执行来源门禁的后端，分析功能保持关闭；通过原查询回归后，在已批准的应用库执行受审阅的 0006 增量迁移。
3. 部署 Agent 兼容版本，保留同一个持久 `AGENT_DATA_DIR`、正常用户 Bearer、历史 Frame / operationFrameId / fact_id 及旧协议解码。先开启 V2，分析保持关闭，确认精准查询没有增加强制探索前置。
4. 配置两端一致的服务凭据，完成真实跨语言请求契约验证，再按受控范围开启分析。Skill 修改通过服务正常重启加载，不能把修改磁盘文件当成正在运行的实例已经生效。
5. 验收后再扩大使用范围。当前分析 v1 支持显式机构、原值取数、正式目录选择及已部署的方法；现有精确排名/位次仍使用原路径。未提供正式组成关系的 Excel 行不得推导业务公式。

## 固定目标及多轮兼容

- 初次真正登记快照的 constraint_version 可以大于 1：本地澄清可能已经发生多轮，但此前没有准备或执行。已有后端版本后，必须递增一版并指向最新 prior_constraint_ref。
- 未声明指标更新时，原 target 的固定指标不能在修订中静默丢失；合法改机构、改日期保留指标。显式指标替换、追加、移除使用有类型的 fixed_metric_updates；后端核对旧新集合、正式身份和本轮原文片段。
- “第一个”等合法候选确认保留原始 metric_source_question、完整 source_metric_bindings / exclusions 和宿主保存的真实 source_history。来源原文分别保存，不拼接或冒充用户句子，不先查询来伪造历史来源。绑定和哈希证明结构与身份一致，不能独立证明自然语言接受语义；接受仍由宿主既有确认门禁处理。
- 目录发现、指标选择和每个 prepared query 都继续按实际正式编码复核。catalog 策略允许后续探索新的正式指标，但不能扩展固定机构、日期，也不能抹掉用户点名的要求。
- 一个步骤可以取目标子集；任务完成仍应逐项检查用户固定要求和实际证据覆盖。单步成功、辅助指标成功、局部日期或局部机构取数均不能自动代表整项完成。

## 幂等和恢复

宿主发送 prepare 前保存固定 prepare_key、任务/步骤/约束版本及冻结规范。后端同一个 prepare_key 只接受同一规范；同一 analysis/constraint/step/revision 不接受换键另建。响应丢失后先 GET `/api/v1/analysis/prepared/{prepare_key}` 按原会话回查，不生成新键或重新抄写参数。

执行仅发送 prepared_query_ref，Idempotency-Key 必须等于原 prepare_key。实际 SQL 参数来自不可变准备记录，不接受执行时覆盖。普通 task 执行缺少服务间来源资格时拒绝分析任务。执行结果已成功时，重放原键恢复完整 rows/facts/比较结果；进行中状态、已中断状态和失败终态不能伪装成新的成功查询。

约束修订使旧版本 prepared 引用失效。迟到结果可保留审计，不能完成新版本要求或抢当前讨论焦点。源目录、单位、权限发生变化时，原目录签名可能失效，需要按正式流程重新探索并创建新步骤版本。

## 回退边界

回退基线必须是认识 analysis.v1、新准备态及来源门禁的兼容版本。不能直接退回没有分析来源门禁的旧后端，再让它执行已保存的分析 RUNNING / LOGICAL_DSL 任务。不能删去 analysis_execution_v1 或改写状态来强行让旧引擎接管。

回退先设置 `AGENT_ANALYSIS_ACCEPT_NEW=false`，仅停止接纳新的 create；保留 `AGENT_ANALYSIS_PLANNING=true`、V2、两端服务凭据与正常用户 Bearer，使既有 read/revise/complete、按键回查及结果恢复继续工作。待已有 active / waiting_user 分析完成，或明确 partial 并保存缺口后，再关总开关或调整模型协议。不能在收敛前清空 token。

总开关 `AGENT_ANALYSIS_PLANNING=false` 会移除 analysis_task；它不是在途任务排空开关。若直接关闭总开关、清空后端 token 或退旧版本，已有任务不能保证继续收敛。

不要通过删除新表做功能回退。新快照、准备记录、查询结果及 Pi analysis.v1 原生记录保留，便于恢复和审计。迁移 downgrade 会删除约束表，不是日常功能回滚方式；只有经过独立备份、任务收敛与数据保留评审后才能执行，本次没有执行。

服务 token 同时也是目录引用签名密钥。轮换两端 token 会使旧目录引用失效；不要在未收敛任务中把轮换当成无损操作。确需轮换时保留旧准备审计，按新凭据重新签发目录引用并创建新步骤版本，不能在同一 prepare_key 下替换已冻结签名。

## 本次真实后端证据

`run_metric_values_acceptance.py` 使用原 QUERY_DATABASE_URL 与真实 MySqlDataSourceAdapter / SQL builder / QueryExecutionService，在专用临时 SQLite 记录应用状态和正式目录最小镜像。精准取数、换机构、换日期三个结构化规范均与独立只读 SELECT 的原始十进制完全相等；analysis prepare 没有执行业务 SQL，execute 执行一次，重放没有额外 SQL。现有应用库与数据源未被写入，测试没有中断现有服务或执行迁移。

测试授权用户和服务 token 仅为进程内隔离 fixture，不代表当前登录用户的授权验收；上游湖来源未据此证明。脚本不调用模型，不能替代真实模型对意图识别、多轮续接和动态规划的验收。

跨语言契约测试消费实际 NativeAnalysisStore / BusinessToolRegistry 导出的 `runtime-analysis-contract-fixture.json`，只替换后端动态签发引用，然后真正经过 Python Pydantic、API、约束持久化、准备、执行与快照重放。另保留 query 多余字段与字符串 catalog_refs 的 422 负例，避免两侧独立桩同时通过却没有实际接通。
