# mention 抽取回归 diff：前缀省略通道（2026-09-23）

## 方法

- 基线：`mention-regression-baseline-2026-09-23.json`，在未修改的代码上生成。
- 对照：`mention-regression-after-prefix-2026-09-23.json`，新增 `_prefix_segment_mentions` 前缀省略通道后生成。
- 语料：`docs/acceptance/**/*.json` 中 `steps[].message` 及同类 `message`/`question` 字段的真实问句，去重后 72 条；真实启用目录 9306 条（只读）。
- 工具：`backend-next/verification/mention_regression.py --out <报告> [--baseline <基线>]`。

## diff 汇总

| 指标 | 数量 |
| --- | --- |
| 问句（前/后） | 72 / 72 |
| 新增 mention | 0 |
| 消失 mention | 0 |
| 状态变化 mention | 0 |
| 出现新增 mention 的问句 | 0（无清单） |

基线与对照各产出 40 条 mention（resolved 38、ambiguous 2），逐条 (start, end, text, status, codes) 完全一致。

## 结论

- 验收语料的 72 条真实问句中没有任何一条触发前缀省略通道：新增 mention 为 0，无消失、无状态变化，即对既有行为零影响、零误报。
- 故障问句「紫金农商行 2 月末100万以下贷款余额、保证金存款利息支出金额」不在验收语料中，单独复现验证：改动前仅 1 条 mention；改动后 2 条，第二条「保证金存款利息支出金额」为 needs_confirmation，candidates 含「保证金存款利息支出金额当日数」等 25 个保证金家族编码（真实目录验证）。
- 通道守卫（归一化后段长 ≥ 4、整段严格前缀、与既有 mention 不重叠、多编码只给 needs_confirmation）决定了它只在用户整段省略名称尾部口径时介入；语料中「各项存款」类通用词头场景未出现，合成用例（verification/test_metric_candidates.py、benchmark_metric_candidates.py）确认此类输入保持多候选待确认，不会自动选定。
