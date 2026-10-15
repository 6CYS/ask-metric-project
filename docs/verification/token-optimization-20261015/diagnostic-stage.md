# Token 优化诊断阶段记录

本记录保存实施期间的真实诊断证据，**不是最终候选的配对验收结论**。各诊断只运行一次，代码版本与部分断言有变化，不能合并成同一版本的成功率或节省承诺。`paired-final-2.json` 因真实回归而中止；修复后固定矩阵另存 `paired-final-3.json`，不会覆盖这些记录。

## 环境与计量

- 模型：项目当前配置的 `deepseek-ai/DeepSeek-V4-Flash`，`semantic_v2`。
- 后端：`http://127.0.0.1:8010`，启动日志确认 `app_env=development`、MySQL；未访问生产环境。
- 业务查询只读；正常创建独立验收会话、查询任务及审计元数据。未更改真实账号权限。
- Bearer 由用户已登录开发页面合法复用，仅保存在权限 `0600` 的私有临时文件，不写入报告。
- 固定独立查询先取得参考结果，验收比较规范机构/指标/日期绑定、Decimal 数值、NULL、单位、结果行顺序和完整性。交付报告只保存 hash 和元数据，不保存金额。
- SDK 每个唯一 `usage_id` 的输入包含缓存读取，非缓存输入另列；缓存不能与总输入重复相加。未知用量不计为零。最终脚本同时记录每个 `before_request` 物理尝试并检查未报告 usage。

## 已保存的诊断

| 文件 | 版本与范围 | 回合结果 | 模型调用 | 已报告输入 token |
| --- | --- | ---: | ---: | ---: |
| `baseline-diagnostic.json` | 冻结旧源码，首问及四次追问/回读 | 5/5 | 11 | 80,840 |
| `baseline-diagnostic-boundaries.json` | 冻结旧源码，多目标、多指标、缺项确认、范围空结果、计算 | 5/6 | 19 | 142,513 |
| `baseline-diagnostic-empty-exact.json` | 冻结旧源码，追加单日空结果 | 0/1，断言误报 | 2 | 12,730 |
| `baseline-empty-exact-confirmed.json` | 修正空结果文字断言，原问题原样重跑 | 1/1 | 2 | 12,712 |
| `direct-only-diagnostic.json` | 早期冻结候选，`on/raw/full` | 10/11 | 40 | 400,479 |
| `candidate-2-affected-diagnostic.json` | 中间候选，`on/compact_v1/compact_v1` | 6/6 | 10 | 68,974 |

详尽来源 hash、逐次用量和失败保留在以上 JSON 及 [诊断汇总](diagnostic-summary.json)。这些版本均不能替代后续冻结候选的验收。

首轮普通查询的直接交付机制已在早期真实诊断中观察到：两次模型变一次，业务查询提交仍一次。确定追问和历史回读资格、目录别名覆盖及普通请求预读 Skill 的开销随后得到修正，因此需对最终固定源码重新验收。此处与报告 JSON 的 `query_count` / `sql_executions` 均计数 `basicQueries` 提交，不代表数据库物理 SQL 总数。

## 失败及证据边界

1. 原范围空结果问题保持原文和原范围：查询张家港农商行 2021-01-01 至 2025-12-31 所有日期的对公协定存款余额当日数。独立正式 spec 可执行并返回零行，但自然语言路径发生 `TIME_EXPRESSION_UNSUPPORTED`，ISO 修正又发生 `TIME_SCOPE_CONFLICT`。旧源码诊断 8 次模型后 `SEMANTIC_NO_PROGRESS` 停止；早期候选 24 次模型、零 SQL，直到同一 120 秒验收保护取消。后者不能标为成功或掩盖成节省。原生记录只留在私有临时目录，脱敏 trace 单独保存。
2. 单日空结果早期文字断言漏掉“未查询到/无记录”，造成验收误报。正式查询、零行、原生持久化及恢复均正常。修正断言后保留原报告并原样重跑，未修改业务问法或代码来迎合用例。
3. 中间 compact 候选曾对普通首问预读 Skill，增加调用；直接交付资格还曾漏掉合法机构别名。完整诊断保留，后续修复不能用中间版本结果冒充最终验收。
4. 最终矩阵第一次启动时在 `getMe` 前置检查收到 `401 AUTH_TOKEN_EXPIRED`，尚未发出模型请求。用户在开发页面重新登录后安全恢复合法 Bearer；未猜测密码、续签或绕过鉴权。
5. 真实开发环境验证读取权限及会话归属；撤权、多结果中单个来源失权、跨用户结果引用的负例使用隔离回归，未修改真实账号授权。
6. `candidate-final-2` 正式首轮发现候选新增缺项退化：首问只读目录并输出普通正文，未保存已知指标；用户补机构、日期后缺乏指标继承依据而停止。基线同两轮成功。根因此停止该付费版本，原 8 个完整版本任务保留，另有在途范围失败的 22 条已报告 usage；整个中止运行共 56 条已报告 usage，完整最终费用未知，不得以小计当总账。[中止账本](paired-final-2-stopped-ledger.json) 和 [缺项 trace](final-2-missing-conditions-trace.json) 保留。
7. `final-2` 一次历史回读最终准确，但使用 7 次模型：先读到最新焦点结果，再通过历史索引、分页和元数据找到第一次查询来源。直出守卫没有把错误来源当成目标，最终零 SQL；其额外成本完整保留，[历史 trace](final-2-history-rep1-trace.json) 可复核。不能只用前四次问数的单轮调用掩盖整个多轮任务开销。

## 最终矩阵计划

固定 `corpus-v2.json`，保留原范围失败；其余六组普通、多轮、确认、多结果、单日空结果和计算场景各做三次 AB/BA。原范围诊断按已核实的阻断每版一次，双方同一 120 秒保护。共 38 个版本任务、68 回合，每类样本数量明确记录。输出全部任务、双方成功的普通配对、完整 usage 配对子集及失败路径成本，不能混用权重。

冻结旧源码位于 `/private/tmp/ask-metric-token-optimization-20261015/baseline/agent-service`。修复后候选冻结为 `candidate-final-3` 并保存 manifest、脚本 hash；此前 `candidate-final` 和 `candidate-final-2` 快照保留，不能当作最终通过版本。真实页面验证另用独立前端 `5175`、候选 `8025` 及私有原生数据根，不修改用户已有服务。

`final-3` 先对受影响两组执行各一次配对；只有候选全部通过，才以相同脚本、模型参数、语料及冻结源码继续矩阵。已完成的诊断 rep1 原样纳入最终账本，基线失败也保留，不重复抽样。新脚本支持 task 边界停止，避免再次通过信号取消在途任务。

可复现命令（在 `agent-service` 下执行，需已有合法私有令牌文件和开发授权）：

```sh
AGENT_DIRECT_QUERY_DELIVERY=on AGENT_MODEL_CONTEXT_VIEW=compact_v1 AGENT_SEMANTIC_PROMPT_VARIANT=compact_v1 node --env-file=.env --import tsx scripts/check-token-optimization-live.ts --live --ack-development --mode=paired --candidate-root=/private/tmp/ask-metric-token-optimization-20261015/candidate-final-3/agent-service --repeat=3 --diagnostic-repeat=1 --corpus=../docs/verification/token-optimization-20261015/corpus-v2.json --report=../docs/verification/token-optimization-20261015/paired-final-3.json --run-id=paired-final-3
node scripts/audit-token-optimization.mjs ../docs/verification/token-optimization-20261015/paired-final-3.json
```
