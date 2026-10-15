# 历史引用、确认和恢复的真实模型验收

最终稳定代码的关联复验 **2/2 case、3/3 用户回合通过**。最近一次完整八项的实际结果仍为 **7/8 case、8/9 回合通过**；其中空候选恢复失败已在后续代码修复并独立复验。最终代码未重跑完整八项，不把跨批结果拼成“单批 8/8”。

模型：deepseek-ai/DeepSeek-V4-Flash；compact=false；maxTokens=8192，配置未改。使用生产默认上下文布局，每回合 180 秒验收上限，原生取消入口；最终关联复验未触发取消。所有目录、权限、业务查询和结果读取均为隔离合成桩，未访问生产服务器或真实业务数据库。

## 最终代码关联复验

| 场景与回合 | 实际业务解析次数 | 实际查询次数 | 耗时 | 持久化终态 |
| --- | --- | --- | --- | --- |
| 空候选，用户回复“是” | 1 | 0 | 2.221 秒 | clarifying |
| 重开恢复：先回复“是” | 1 | 0 | 5.198 秒 | clarifying |
| 重开后补具体甲、乙、丙 | 1 | 1 | 16.049 秒 | success |

前两回合直接返回 NEEDS_CLARIFICATION、HISTORY_REFERENCE_EVIDENCE_MISSING、retryable=false，无连续参数改写。第三回合正式 spec 为 O1/O2/O3、指标 M1、2026-07-31、selection=exact、ranking top3，完整继承原指标、日期和排名目标，执行一次并有本轮 success Frame。重开恢复整个 case 耗时 21.251 秒。

这些是收窄恢复预检之后的最终代码结果，原始参数、回执、spec、Frame 和最终回复保存在 JSON 的 follow_up_model_runs。此前预检尚未收窄的两项通过结果也保留为 additional_diagnostics，未混用代码阶段。

## 最近完整批次及历史证据

最近完整批次时间：2026-10-13T02:05:03.369Z。原八项始终使用 index-only fixture：两笔可信成功 Frame 的机构分别为 O1、O2/O3，指标 M1、日期 2026-07-31；待确认场景另有对应用户与助手消息。未补聊天替换压力样本，业务期望未改。

| 场景 | 初轮 1/6 | 第二轮 3/8 | 前轮 7/8 | 最近完整批次 7/8 | 各回合查询数 |
| --- | --- | --- | --- | --- | --- |
| incident_wording | 失败 | 失败 | 失败 | 通过 | 1 |
| rephrased_union | 失败 | 通过 | 通过 | 通过 | 1 |
| single_source | 通过 | 通过 | 通过 | 通过 | 1 |
| count_mismatch | 失败 | 失败 | 通过 | 通过 | 0 |
| legacy_empty_confirmation | 失败 | 失败 | 通过 | 失败 | 0 |
| legacy_explicit_repair | 失败 | 失败 | 通过 | 通过 | 0；1 |
| history_plus_current_addition | 未覆盖 | 通过 | 通过 | 通过 | 1 |
| compound_confirmation_date_change | 未覆盖 | 失败 | 通过 | 通过 | 1 |

原事故“对以上三家机构进行排名”在最近完整批次实际提交了两个历史 frameId、combine=union、expectedCount=3，正式查询 O1/O2/O3，仅查询一次，Frame 最终 success。前轮错误 inherit/null、误用第二笔两家，以及其他旧失败参数均原样保留。

最近完整批次的空候选失败链：当前用户原文“是”，模型先用旧助手“以上三家”声明 set，返回 FIELD_INTENT_EVIDENCE_INVALID；第二次只改引用的 sourceText，目标声明仍旧，重复同错误；第三次声明 confirm 却提交 set/fromHistory，返回 FIELD_INTENT_MODE_MISMATCH。三次可重试参数错误遮住了应有的澄清终态，最终触发停止重试保护。该批次未执行业务查询，但仍按失败记录。修复后仅复验关联路径，结果见上节。

JSON 顶层 reports/passed 保存最近完整批次的真实 7/8；previous_runs 包含初轮 1/6、第二轮 3/8、前轮 7/8 的完整原始报告。初轮数量不符场景曾有过严的“最多一次解析”断言；后续允许技术参数修复，但收到澄清回执后不得自动再解析，其他业务断言未放宽。

独立诊断不计入完整批次通过率：早前补正常历史聊天的 seeded-chat 事故单例通过；状态块前置布局诊断失败、零查询，生产布局因此未改；通用来源事实摘要代码的 index-only 事故单例通过。不同 fixture 和不同代码阶段不作为单变量归因。最后稳定代码未另跑 seeded-chat。

## 验证边界

验收同时检查真实模型工具参数、字段数量声明、结构化历史来源、正式业务 spec、指标日期和排名目标、调用次数、持久化 Frame 终态及重开恢复。纯文字分析正确、零查询或最终答复正常都不足以判成功；需要用户补充时必须形成澄清回执，不能以三次参数错误停止保护冒充恢复。

最终静态检查：Vitest **982/982 tests、103 suites 全通过**，已独立读取原始 JSON 计数；build 与业务源码 typecheck 通过为实施方提供的最终结果。两份模型验证脚本的独立 TypeScript 检查、合成 fixture 校验和相关 git diff --check 通过。

本报告证明有限合成样本下的配置模型与本地宿主行为，未证明生产部署、真实目录权限或数据库验收。详细证据见 [JSON 报告](history-reference-recovery-20261013.json)。
