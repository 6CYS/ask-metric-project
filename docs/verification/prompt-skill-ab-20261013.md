# System Prompt、工具说明和四 Skill 配对验证

最终完整目标达成由 8/11 变为 10/11，但错误调用仍为 3/14（21.4%），没有减少。无依据日期取数/排名提案从3次变为0，相关实际执行从1次变为0，已知条件下不必要澄清从1次变为0。此次单次配对没有证明全部优化目标达成。

真实模型：deepseek-ai/DeepSeek-V4-Flash；固定 8 场景 / 11 回合，各版本一次。目录、权限、事实与计算均为隔离合成桩，未访问任何真实业务数据库或生产服务。

| 指标 | 修改前 | 修改后 |
| --- | --- | --- |
| 完整目标达成回合 | 8 | 10 |
| 模型工具调用总数 | 14 | 14 |
| 错误调用次数 | 3 | 3 |
| 错误调用比例 | 21.4% | 21.4% |
| 预期业务能力拒绝（不计错误） | 2 | 1 |
| 无依据日期取数/排名提案（逐字段、逐次提交） | 3 | 0 |
| 无依据条件实际查询执行 | 1 | 0 |
| 无明确数量指代中生成数量约束（影响回合） | 0 | 0 |
| 已知条件下不必要澄清 | 1 | 0 |
| 同回合重复澄清 | 0 | 0 |
| 模型调用次数 | 24 | 24 |

同组结果：{"shared_pass": 8, "candidate_only_failure": 0, "baseline_only_failure": 2, "shared_failure": 1}。

| 场景 / 回合 | 前 | 后 | 分类 |
| --- | --- | --- | --- |
| clear_first_and_date_followup / 1 | 通过；错误0 | 通过；错误0 | shared_pass |
| clear_first_and_date_followup / 2 | 通过；错误0 | 通过；错误0 | shared_pass |
| ambiguous_month_ranking_and_recovery / 1 | 失败；错误1 | 失败；错误1 | shared_failure |
| ambiguous_month_ranking_and_recovery / 2 | 通过；错误0 | 通过；错误1 | shared_pass |
| unique_reference_without_count / 1 | 通过；错误0 | 通过；错误0 | shared_pass |
| two_sources_union_count / 1 | 通过；错误0 | 通过；错误1 | shared_pass |
| saved_candidate_confirm_and_date_change / 1 | 通过；错误0 | 通过；错误0 | shared_pass |
| real_prime_and_historical_calculation / 1 | 通过；错误0 | 通过；错误0 | shared_pass |
| real_prime_and_historical_calculation / 2 | 失败；错误2 | 通过；错误0 | baseline_only_failure |
| coverage_discovery / 1 | 失败；错误0 | 通过；错误0 | baseline_only_failure |
| unsupported_cause_boundary / 1 | 通过；错误0 | 通过；错误0 | shared_pass |

测量审核只使用既有回执，原始报告保留为 `.raw.json` / `.raw.md`。重复澄清统一只计同回合第2次及以后；已知条件下首次多问单独计不必要澄清。审计记录在 JSON 的 measurement_audit，只读审计不改既有模型请求或结果；执行器只经过已记录、已审阅的测量修补，旧新hash与patch保留。

每个版本仅一次，模型存在随机性，不能宣称统计显著改善。preRead 指定的场景通过实际 business_skill_read 原生回执控制已读正文，其他场景自然按需读取。历史种子不是模型建立的真实历史；计算首轮由实际模型查询。合成业务验收不代表真实目录、数据库或生产验收。

错误调用按原生 isError、ARGUMENT_ERROR/error/failed 计，分母为该回合模型全部工具调用，排除受控预读；unsupported 预期业务拒绝单列。无依据提案自动检查取数口径和排名条数，机构/指标/完整日期另纳入目标达成断言。无结构化回执的普通追问不算有效澄清，会导致目标失败。详细参数、回执、Frame 和正式 spec 供人工复核。额外数量约束逐阶段审核唯一无数量指代场景，不能把日期/排名自动计数为0泛称完全不猜条件。

详细报告：[修改前](prompt-skill-ab-20261013-before.md)、[本候选](prompt-skill-ab-20261013-after.md)。


## 六阶段完整结果

每个明确源码版本完整运行一次并保留全部失败。candidate2 第5回合模型 idle 失败后，测量脚本 Node assert 错误定位递归，先只读保存原生证据，再仅续跑未执行6回合；未重新采样已执行回合。最终候选使用已审阅的测量修补，原始/修补脚本与patch/hash全部保留。

| 指标 | 修改前 | candidate1 | candidate2 | candidate3 | candidate4 | 最终 candidate5 |
| --- | --- | --- | --- | --- | --- | --- |
| 完整目标达成回合 | 8 | 9 | 9 | 9 | 10 | 10 |
| 模型工具调用总数 | 14 | 17 | 21 | 12 | 19 | 14 |
| 错误调用次数 | 3 | 7 | 10 | 1 | 7 | 3 |
| 错误调用比例 | 21.4% | 41.2% | 47.6% | 8.3% | 36.8% | 21.4% |
| 预期业务能力拒绝（不计错误） | 2 | 1 | 1 | 1 | 1 | 1 |
| 无依据日期取数/排名提案（逐字段、逐次提交） | 3 | 4 | 5 | 0 | 0 | 0 |
| 无依据条件实际查询执行 | 1 | 1 | 0 | 0 | 0 | 0 |
| 无明确数量指代中生成数量约束（影响回合） | 0 | 0 | 0 | 1 | 0 | 0 |
| 已知条件下不必要澄清 | 1 | 0 | 0 | 1 | 0 | 0 |
| 同回合重复澄清 | 0 | 0 | 0 | 0 | 0 | 0 |
| 模型调用次数 | 24 | 28 | 30 | 21 | 29 | 24 |

中间版本完整报告：[candidate1](prompt-skill-ab-20261013-candidate1.md)、[candidate2](prompt-skill-ab-20261013-candidate2.md)、[candidate3](prompt-skill-ab-20261013-candidate3.md)、[candidate4](prompt-skill-ab-20261013-candidate4.md)。

测量修补：[instrumentation patch](prompt-skill-ab-20261013-instrumentation.patch)、[旧新hash及断言递归证据](prompt-skill-ab-20261013-instrumentation.json)。关键fixture/场景/请求不变，执行文件hash差异不被伪称相同；最终展示断言接受数学负号U+2212与ASCII负号等价，所有阶段离线按同一规则审核并保留原始pass/failure。单一历史来源允许明确唯一的整笔Frame base继承（须正式spec与三字段源绑定正确、inherit/null/null），不强制额外fromHistory包装；current仅在原生调用时焦点确为预期唯一seed且三字段来源与正式spec完整绑定时接受，保留事件序号与源身份证明。多源union仍必须字段来源结构，无法证明来源的current或正文表述不接受。


完整六阶段 src/skills 来源 hash 清单：[source-manifests](prompt-skill-ab-20261013-source-manifests.json)，包括 core 错误说明、modelView 与其他实际运行来源。执行脚本原始 hash 和统计审计脚本 hash 另分别保留，不将测量后处理当作模型重跑。


## 尚未解决的实际问题

- 月份排名首问仍有一次 selection 缺失校验错误；纠正时只保存 selection 待澄清，将 operation 遗漏为 missing。虽然没有猜条件执行查询，但未完整保存所有未决业务选择，因此这一回合失败。
- 用户补充日期口径和排名条数后，模型先将 baseReference 错传为裸 UUID，引发 SDK 工具 JSONSchema 错误；随后纠正完成。
- 多来源 union 首次将 base 传 null，引发 REFERENCE_IMPLIES_CONTINUATION；随后纠正完成。

最终唯一历史来源的 current 别名通过原生调用前状态确认：事件序号46、焦点为唯一预期 seed、机构/指标/日期三字段绑定同一来源、正式 spec 和执行完整。原始失败仍保留；[原生 JSONL](prompt-skill-ab-20261013-final-native/2026-10-13T14-35-46-208Z_01a135b0-dea0-74d5-bb0a-9b21ba716662.jsonl) 已原样归档，SHA-256 `2c82c758f9d2476b02b7a8cc569379165deb1ef3571891f26d948a127ae95052`。

## 落地与验证边界

本地 system prompt、工具说明、能力描述和四个 Skill 已统一。集成验证：1088/1088 测试（116 suites）、build、typecheck、diff check 通过。公开工具两套方言的参数与 prepareArguments、三个能力的字段/completeFields/validate 均未改变；11个业务核心文件与修改前逐字节一致，core AST 只改 FIELD_INTENT_INVALID 错误说明。最终116个来源文件与冻结快照 hash 一致。

本地入口 http://127.0.0.1:5173 可用，前端、Agent 及代理 health 均为200；Agent 已于最终源码修改后重载。未部署线上，未访问真实业务数据库。回退仅恢复本轮提示词、工具和 Skill 说明差异，保留此前业务修复和其他工作树改动。

最终真实模型运行脚本 hash 为 `3212847c43003f1bb14a0bee17a94c173ef7d23c0f47480ebcf5c3f0799fe4f9`；现存未来测量器 hash 为 `40c5a2e8972d061764bf3735b4ee164d43a99911a0f1e86118444bda6b0125d8`，只新增评分状态采集/契约断言并通过 strict tsc，未用其再次运行模型。只读审计脚本 hash 为 `dcf9f01fff0b3fe5b7b586b35ee97f342c39037b06c6c1a0b0baf982c9baf59c`。
