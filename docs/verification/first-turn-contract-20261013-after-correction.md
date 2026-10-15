# 空历史首问工具契约真实模型验收：纠错回执增强后

时间：2026-10-13T02:52:26.755Z

模型：deepseek-ai/DeepSeek-V4-Flash；compact 参数：false。

仅调用配置模型；业务目录、权限、查询及结果全部是隔离合成桩，未访问生产业务服务或任何真实业务数据库。每个首问独立新建空聊天、空 Frame；恢复回合沿用同一诊断会话。

此次未重跑前三个明确首问；事故原句诊断 1/1 可接受，同会话恢复 1/1 通过。本结论仅限本次所选合成场景。事故原句另作为独立诊断，缺少月范围取数方式及排名条数，不能通过自动月末、latest 或 top10 获得虚假的成功。

| 场景 | 结果 | 查询次数 | 说明 |
| --- | --- | --- | --- |
| incident_ambiguous_month_ranking | 独立诊断，不并入通过率 | 0 | structured_clarification_with_known_target_preserved |
| incident_explicit_followup_recovery | 通过 | 1 | 完整目标与重开一致 |

明确目标通过条件同时检查工具参数、正式查询 spec 的机构/指标/完整日期范围/selection/排名条数、查询次数恰为一次、成功 Frame、重开后的 Frame 与最终消息。零查询或文字正常不算通过；格式等价不允许改年/月/日或裁掉日期限定、排名和机构。

事故原句诊断需要结构化澄清及已给目标的持久化证据。原契约将普通回答限定于非业务对话，selection 缺失视为模型参数错误，ranking 输入又要求完整 position/top_n；诊断要求通过公开的字段澄清契约保留已知目标和两项未决业务选择，不能用普通文字或参数兜底代替。

详细工具参数、回执、正式 spec、持久化 Frame 及失败见 [JSON 报告](first-turn-contract-20261013-after-correction.json)。本报告仅证明这些合成样本的本地宿主行为，不代表生产部署、真实目录、数据库或任意自然语言均已验收。

本阶段只复验事故原句一次，未重跑前三个明确目标样本。实际链路：`ARGUMENT_ERROR`（operation 的 top_n 为 null）→ `ARGUMENT_ERROR`（selection 缺失）→ 第三次同时将两字段存为业务未决，返回 `NEEDS_CLARIFICATION` 并结束，0 次业务查询。随后在同一会话只追加一次用户明确补充，完整保留机构、指标、月份，`latest_in_range + top3` 查询 1 次并成功；两个回合的状态与消息均验证重开一致。

报告快照审计：初次生成JSON时，诊断条目的 `query_specs` 持有可变数组引用，被后续恢复追加；已按当时断言的 `query_count=0` 更正为空，恢复 spec 原样保留在恢复条目。累计目录调用未分割，已显式标注其包括恢复复核。未更正原件保留在 `/private/tmp/first-turn-contract-after-correction-unreviewed-20261013.json`。此更正不改变任何模型参数、回执、正式查询或Frame；未额外运行模型。

根代理最终实际检查：1084/1084 测试通过，typecheck、build、git diff --check通过，独立审查无新增确定问题；本地Agent端口8020已重载，5173代理health和query-readiness均HTTP 200、状态ready。真实模型验收业务后端仍为合成桩，未访问真实业务数据库。
