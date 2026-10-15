# System Prompt、工具说明和四 Skill 配对验证

真实模型：deepseek-ai/DeepSeek-V4-Flash；固定 8 场景 / 11 回合，各版本一次。目录、权限、事实与计算均为隔离合成桩，未访问任何真实业务数据库或生产服务。

| 指标 | 修改前 | 修改后 |
| --- | --- | --- |
| 完整目标达成回合 | 8 | 9 |
| 模型工具调用总数 | 14 | 12 |
| 错误调用次数 | 3 | 1 |
| 错误调用比例 | 21.4% | 8.3% |
| 预期业务能力拒绝（不计错误） | 2 | 1 |
| 无依据日期取数/排名提案（逐字段、逐次提交） | 3 | 0 |
| 无依据条件实际查询执行 | 1 | 0 |
| 无明确数量指代中生成数量约束（影响回合） | 0 | 1 |
| 已知条件下不必要澄清 | 1 | 1 |
| 同回合重复澄清 | 0 | 0 |
| 模型调用次数 | 24 | 21 |

同组结果：{"shared_pass": 6, "candidate_only_failure": 2, "baseline_only_failure": 3, "shared_failure": 0}。

| 场景 / 回合 | 前 | 后 | 分类 |
| --- | --- | --- | --- |
| clear_first_and_date_followup / 1 | 通过；错误0 | 通过；错误0 | shared_pass |
| clear_first_and_date_followup / 2 | 通过；错误0 | 通过；错误0 | shared_pass |
| ambiguous_month_ranking_and_recovery / 1 | 失败；错误1 | 通过；错误0 | baseline_only_failure |
| ambiguous_month_ranking_and_recovery / 2 | 通过；错误0 | 通过；错误0 | shared_pass |
| unique_reference_without_count / 1 | 通过；错误0 | 通过；错误1 | shared_pass |
| two_sources_union_count / 1 | 通过；错误0 | 失败；错误0 | candidate_only_failure |
| saved_candidate_confirm_and_date_change / 1 | 通过；错误0 | 失败；错误0 | candidate_only_failure |
| real_prime_and_historical_calculation / 1 | 通过；错误0 | 通过；错误0 | shared_pass |
| real_prime_and_historical_calculation / 2 | 失败；错误2 | 通过；错误0 | baseline_only_failure |
| coverage_discovery / 1 | 失败；错误0 | 通过；错误0 | baseline_only_failure |
| unsupported_cause_boundary / 1 | 通过；错误0 | 通过；错误0 | shared_pass |

测量审核只使用既有回执，原始报告保留为 `.raw.json` / `.raw.md`。重复澄清统一只计同回合第2次及以后；已知条件下首次多问单独计不必要澄清。审计记录在 JSON 的 measurement_audit，只读审计不改既有模型请求或结果；执行器只经过已记录、已审阅的测量修补，旧新hash与patch保留。

每个版本仅一次，模型存在随机性，不能宣称统计显著改善。preRead 指定的场景通过实际 business_skill_read 原生回执控制已读正文，其他场景自然按需读取。历史种子不是模型建立的真实历史；计算首轮由实际模型查询。合成业务验收不代表真实目录、数据库或生产验收。

错误调用按原生 isError、ARGUMENT_ERROR/error/failed 计，分母为该回合模型全部工具调用，排除受控预读；unsupported 预期业务拒绝单列。无依据提案自动检查取数口径和排名条数，机构/指标/完整日期另纳入目标达成断言。无结构化回执的普通追问不算有效澄清，会导致目标失败。详细参数、回执、Frame 和正式 spec 供人工复核。额外数量约束逐阶段审核唯一无数量指代场景，不能把日期/排名自动计数为0泛称完全不猜条件。

详细报告：[修改前](prompt-skill-ab-20261013-before.md)、[本候选](prompt-skill-ab-20261013-candidate3.md)。
