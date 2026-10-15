# Token 优化真实模型与开发数据库配对验收

模型：deepseek-ai/DeepSeek-V4-Flash。协议：semantic_v2。冻结语料：55d99e20d23f8ce62fb5de8b088181975989f99e35f68438cf222e25ccb26faf。完整计划：已完成，38/38 个版本任务。报告不含令牌和业务金额。

| 全部任务指标 | 冻结基线 | 候选 |
| --- | ---: | ---: |
| 通过任务 | 17 | 17 |
| 通过回合 | 32 | 32 |
| 模型调用 | 94 | 73 |
| 业务 SQL | 34 | 33 |
| 输入 token |  |  |
| 输出 token |  |  |
| 缓存输入 |  |  |
| 非缓存输入 |  |  |
| 总 token |  |  |
| 用量未知调用 | 1 | 2 |

全部计划任务输入减少 未知，调用减少 22.34%；双方成功的普通任务 8 对，输入减少 49.00%，调用减少 38.24%。失败及重试成本已包含，未知用量不计零。

分类：{"shared_pass":16,"candidate_only_failure":1,"baseline_only_failure":1,"shared_failure":1,"missing_candidate":0}。准确性及恢复门槛：未通过。

- Current authorized development database and configured real model; no production access.
- Real backend positive authorization and session ownership checked. Revocation and nested-source negative authorization use separate isolated tests; real account permissions were not changed.
- No supplier cache flush; AB/BA alternation reduces ordering bias, cache cost must be reported separately.
- Independent fixed query references validate precise numeric, NULL, unit, row order and target identities; final prose needs separate semantic assertions/manual review for unsupported claims.

详细每次唯一 usage_id、step、attempt、规范条件、结果 hash、旧 Frame 及恢复检查见 [原始脱敏报告](paired-final-3.json) 和 [审计 JSON](paired-final-3-audit.json)。
