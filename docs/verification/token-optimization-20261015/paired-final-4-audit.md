# Token 优化真实模型与开发数据库配对验收

模型：deepseek-ai/DeepSeek-V4-Flash。协议：semantic_v2。冻结语料：55d99e20d23f8ce62fb5de8b088181975989f99e35f68438cf222e25ccb26faf。完整计划：已完成，16/16 个版本任务。报告不含令牌和业务金额。

| 全部任务指标 | 冻结基线 | 候选 |
| --- | ---: | ---: |
| 通过任务 | 7 | 8 |
| 通过回合 | 14 | 15 |
| 模型调用 | 31 | 18 |
| 业务取数请求 | 13 | 13 |
| 输入 token | 221802 | 106830 |
| 输出 token | 4405 | 3155 |
| 缓存输入 | 108544 | 71936 |
| 非缓存输入 | 113258 | 34894 |
| 总 token | 226207 | 109985 |
| 用量未知调用 | 0 | 0 |

全部计划任务输入减少 51.84%，调用减少 41.94%；双方成功的普通任务 2 对，输入减少 63.47%，调用减少 50.00%。失败及重试成本已包含，未知用量不计零。sql_executions 是兼容字段名，实际计数 basicQueries 业务取数请求，不代表数据库物理 SQL。

分类：{"shared_pass":7,"candidate_only_failure":0,"baseline_only_failure":1,"shared_failure":0,"missing_candidate":0}。准确性及恢复门槛：通过。

- Current authorized development database and configured real model; no production access.
- Real backend positive authorization and session ownership checked. Revocation and nested-source negative authorization use separate isolated tests; real account permissions were not changed.
- No supplier cache flush; AB/BA alternation reduces ordering bias, cache cost must be reported separately.
- Independent fixed query references validate precise numeric, NULL, unit, row order and target identities; final prose needs separate semantic assertions/manual review for unsupported claims.

详细每次唯一 usage_id、step、attempt、规范条件、结果 hash、旧 Frame 及恢复检查见 [原始脱敏报告](paired-final-4.json) 和 [审计 JSON](paired-final-4-audit.json)。
