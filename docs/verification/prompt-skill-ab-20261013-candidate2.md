# Prompt / Skills 真实模型：candidate2

完整8场景11回合，各回合仅采样一次；前4回合完成，第5回合原生MODEL_STREAM_IDLE_EXCEEDED结束后，Node24 assert源码定位递归使测量卡住。已保存原生JSONL，离线复原前5回合；仅从冻结candidate2源码续跑此前未执行的6回合。未重跑、未替换第5失败。

{
  "cases": 8,
  "turns": 11,
  "achieved_turns": 9,
  "tool_calls": 21,
  "error_calls": 10,
  "expected_business_refusals": 1,
  "ungrounded_condition_proposals": 5,
  "ungrounded_condition_executions": 0,
  "unnecessary_clarifications": 0,
  "repeated_clarifications": 0,
  "model_calls": 30,
  "error_rate": 0.47619047619047616
}

| 场景 / 回合 | 目标 | 错误 / 调用 | 说明 |
| --- | --- | --- | --- |
| clear_first_and_date_followup / 1 | 通过 | 1/2 | 条件与目标完整 |
| clear_first_and_date_followup / 2 | 通过 | 1/2 | 条件与目标完整 |
| ambiguous_month_ranking_and_recovery / 1 | 失败 | 3/4 | Expected values to be strictly equal: + actual - expected  + 'resolved' - 'ambiguous'  |
| ambiguous_month_ranking_and_recovery / 2 | 通过 | 1/2 | 条件与目标完整 |
| unique_reference_without_count / 1 | 失败 | 1/2 | MODEL_STREAM_IDLE_EXCEEDED; model returned error before correction tool execution; original runner then hung in Node assert source location |
| two_sources_union_count / 1 | 通过 | 1/2 | 条件与目标完整 |
| saved_candidate_confirm_and_date_change / 1 | 通过 | 0/1 | 条件与目标完整 |
| real_prime_and_historical_calculation / 1 | 通过 | 0/1 | 条件与目标完整 |
| real_prime_and_historical_calculation / 2 | 通过 | 1/2 | 条件与目标完整 |
| coverage_discovery / 1 | 通过 | 1/2 | 条件与目标完整 |
| unsupported_cause_boundary / 1 | 通过 | 0/1 | 条件与目标完整 |

完整原始参数、回执、正式spec与Frame见同名JSON；前5恢复证据及校验见 first5.offline.json，剩余模型原报告见 candidate2-remaining.json，原生JSONL见 candidate2-native/。instrumentation.json/patch记录脚本改动，仅影响测量失败捕获、统计和续跑，不改生产、模型配置或fixtures。业务始终为隔离合成桩，未访问真实业务数据库或生产。


## 统一测量审计

原始模型回执与统计保留在同名 `.raw.json` / `.raw.md`。以下修订只读使用既有回执，不调用模型、不改请求或结果。重复澄清只计同回合第2次及以后；已知条件下首次多问单独计不必要澄清。原文上方的原始 repeated 统计以本节为准。

```json
{
  "cases": 8,
  "turns": 11,
  "achieved_turns": 9,
  "tool_calls": 21,
  "error_calls": 10,
  "expected_business_refusals": 1,
  "ungrounded_condition_proposals": 5,
  "ungrounded_condition_executions": 0,
  "unnecessary_clarifications": 0,
  "repeated_clarifications": 0,
  "model_calls": 30,
  "error_rate": 0.47619047619047616,
  "ungrounded_reference_count_turns": 0
}
```
