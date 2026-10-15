# Token 优化真实模型与开发数据库配对验收

模型：deepseek-ai/DeepSeek-V4-Flash。协议：semantic_v2。冻结语料：55d99e20d23f8ce62fb5de8b088181975989f99e35f68438cf222e25ccb26faf。完整计划：未完成，8/38 个版本任务。报告不含令牌和业务金额。

| 全部任务指标 | 冻结基线 | 候选 |
| --- | ---: | ---: |
| 通过任务 | 3 | 3 |
| 通过回合 | 8 | 7 |
| 模型调用 | 17 | 17 |
| 业务 SQL | 8 | 7 |
| 输入 token | 119384 | 112056 |
| 输出 token | 2127 | 3122 |
| 缓存输入 | 65024 | 46080 |
| 非缓存输入 | 54360 | 65976 |
| 总 token | 121511 | 115178 |
| 用量未知调用 | 0 | 0 |

全部计划任务输入减少 未知，调用减少 未知；双方成功的普通任务 2 对，输入减少 64.05%，调用减少 50.00%。失败及重试成本已包含，未知用量不计零。

分类：{"shared_pass":2,"candidate_only_failure":1,"baseline_only_failure":1,"shared_failure":0,"missing_candidate":0}。准确性及恢复门槛：未通过。

- Current authorized development database and configured real model; no production access.
- Real backend positive authorization and session ownership checked. Revocation and nested-source negative authorization use separate isolated tests; real account permissions were not changed.
- No supplier cache flush; AB/BA alternation reduces ordering bias, cache cost must be reported separately.
- Independent fixed query references validate precise numeric, NULL, unit, row order and target identities; final prose needs separate semantic assertions/manual review for unsupported claims.

详细每次唯一 usage_id、step、attempt、规范条件、结果 hash、旧 Frame 及恢复检查见 [原始脱敏报告](paired-final-2.json) 和 [审计 JSON](paired-final-2-audit.json)。
