# Token 优化真实模型与开发数据库配对验收

模型：deepseek-ai/DeepSeek-V4-Flash。协议：semantic_v2。冻结语料：31f12c5239a377e1e15078cd2ef82a22ba3fdcaedc40f75bdfef98e2f663d0d5。完整计划：未完成，1/1 个版本任务。报告不含令牌和业务金额。

| 全部任务指标 | 冻结基线 | 候选 |
| --- | ---: | ---: |
| 通过任务 | 1 | 0 |
| 通过回合 | 5 | 0 |
| 模型调用 | 11 | 0 |
| 业务 SQL | 4 | 0 |
| 输入 token | 80840 |  |
| 输出 token | 1125 |  |
| 缓存输入 | 35072 |  |
| 非缓存输入 | 45768 |  |
| 总 token | 81965 |  |
| 用量未知调用 | 0 | 0 |

全部计划任务输入减少 未知，调用减少 未知；双方成功的普通任务 0 对，输入减少 未知，调用减少 未知。失败及重试成本已包含，未知用量不计零。

分类：{"shared_pass":0,"candidate_only_failure":0,"baseline_only_failure":0,"shared_failure":0,"missing_candidate":1}。准确性及恢复门槛：未通过。

- Current authorized development database and configured real model; no production access.
- Real backend positive authorization and session ownership checked. Revocation and nested-source negative authorization use separate isolated tests; real account permissions were not changed.
- No supplier cache flush; AB/BA alternation reduces ordering bias, cache cost must be reported separately.
- Independent fixed query references validate precise numeric, NULL, unit, row order and target identities; final prose needs separate semantic assertions/manual review for unsupported claims.

详细每次唯一 usage_id、step、attempt、规范条件、结果 hash、旧 Frame 及恢复检查见 [原始脱敏报告](baseline-diagnostic.json) 和 [审计 JSON](baseline-diagnostic-audit.json)。
