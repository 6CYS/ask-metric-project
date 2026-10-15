# Prompt / Skills 真实模型：after

模型：deepseek-ai/DeepSeek-V4-Flash；2026-10-13T14:37:24.674Z。各版本每场景一次，失败不重新抽样。真实模型＋隔离合成目录、权限、记录与计算；未访问任何真实业务数据库或生产业务服务。

{
  "cases": 8,
  "turns": 11,
  "achieved_turns": 9,
  "tool_calls": 14,
  "error_calls": 3,
  "error_rate": 0.21428571428571427,
  "expected_business_refusals": 1,
  "ungrounded_condition_proposals": 0,
  "ungrounded_condition_executions": 0,
  "unnecessary_clarifications": 0,
  "repeated_clarifications": 0,
  "model_calls": 24
}

| 场景 / 回合 | 目标 | 错误调用/全部调用 | 无依据提案/执行 | 不必要/重复澄清 | 说明 |
| --- | --- | --- | --- | --- | --- |
| clear_first_and_date_followup / 1 | 通过 | 0/1 | 0/0 | 0/0 | 条件与目标完整 |
| clear_first_and_date_followup / 2 | 通过 | 0/1 | 0/0 | 0/0 | 条件与目标完整 |
| ambiguous_month_ranking_and_recovery / 1 | 失败 | 1/2 | 0/0 | 0/0 | Expected values to be strictly equal: + actual - expected  + 'missing' - 'ambiguous'  |
| ambiguous_month_ranking_and_recovery / 2 | 通过 | 1/2 | 0/0 | 0/0 | 条件与目标完整 |
| unique_reference_without_count / 1 | 失败 | 0/1 | 0/0 | 0/0 | 指代须有唯一整笔Frame来源或单源字段引用，不能仅依靠current或正文 |
| two_sources_union_count / 1 | 通过 | 1/2 | 0/0 | 0/0 | 条件与目标完整 |
| saved_candidate_confirm_and_date_change / 1 | 通过 | 0/1 | 0/0 | 0/0 | 条件与目标完整 |
| real_prime_and_historical_calculation / 1 | 通过 | 0/1 | 0/0 | 0/0 | 条件与目标完整 |
| real_prime_and_historical_calculation / 2 | 通过 | 0/1 | 0/0 | 0/0 | 条件与目标完整 |
| coverage_discovery / 1 | 通过 | 0/1 | 0/0 | 0/0 | 条件与目标完整 |
| unsupported_cause_boundary / 1 | 通过 | 0/1 | 0/0 | 0/0 | 条件与目标完整 |

历史引用与确认采用已通过业务字段校验的隔离种子 Frame，不是模型建立的真实历史；计算场景首轮由实际模型查询再继续计算。preRead 场景通过真实 business_skill_read 生成工具原生回执后加入上下文，仅控制已读正文；未插入业务成功回执或额外答案提示。其他场景由模型自然按需读取。前后模型、场景、干预相同，并记录脚本 hash 与源码 hash。

错误调用按 isError、ARGUMENT_ERROR/error/failed 回执计数，unsupported 预期业务拒绝单列、不计错误。分母为回合内模型全部工具调用，排除受控预读。无依据提案自动检查取数口径与排名条数，执行检查完整 spec；机构/指标/日期来源另以完整目标断言与原始记录核验。已知条件回合结构化 NEEDS_CLARIFICATION 计不必要澄清；应澄清回合超过一次计重复。正文追问但无结构化回执不算有效澄清，按目标失败保留供人工复核。单次小样本不能证明统计显著改善，合成业务验收不代表生产或真实数据库验收。

完整参数、回执、Frame、spec 见同名 JSON。
