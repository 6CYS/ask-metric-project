# 空历史首问工具契约真实模型验收：纠错回执增强前

时间：2026-10-13T02:47:21.887Z

模型：deepseek-ai/DeepSeek-V4-Flash；compact 参数：false。

仅调用配置模型；业务目录、权限、查询及结果全部是隔离合成桩，未访问生产业务服务或任何真实业务数据库。每例独立新建空聊天、空 Frame 的会话。

明确目标用例 3/3 通过；事故诊断不接受，整体契约目标尚未通过。事故原句另作为独立诊断，缺少月范围取数方式及排名条数，不能通过自动月末、latest 或 top10 获得虚假的成功。

| 场景 | 结果 | 查询次数 | 说明 |
| --- | --- | --- | --- |
| month_spaced_last_available_top3 | 通过 | 1 | 完整目标与重开一致 |
| month_fullwidth_last_available_top3 | 通过 | 1 | 完整目标与重开一致 |
| single_day_top3 | 通过 | 1 | 完整目标与重开一致 |
| incident_ambiguous_month_ranking | 独立诊断，不并入通过率 | 1 | executed_without_user_time_or_rank_limit_basis |

明确目标通过条件同时检查工具参数、正式查询 spec 的机构/指标/完整日期范围/selection/排名条数、查询次数恰为一次、成功 Frame、重开后的 Frame 与最终消息。零查询或文字正常不算通过；格式等价不允许改年/月/日或裁掉日期限定、排名和机构。

事故原句诊断需要结构化澄清及已给目标的持久化证据。原契约将普通回答限定于非业务对话，selection 缺失视为模型参数错误，ranking 输入又要求完整 position/top_n；诊断要求通过公开的字段澄清契约保留已知目标和两项未决业务选择，不能用普通文字或参数兜底代替。

详细工具参数、回执、正式 spec、持久化 Frame 及失败见 [JSON 报告](first-turn-contract-20261013-before-correction.json)。本报告仅证明这些合成样本的本地宿主行为，不代表生产部署、真实目录、数据库或任意自然语言均已验收。

事故原句实际链路：第一次模型提交 `latest_in_range` 和 `top_n:null`，收到 `FIELD_INPUT_SCHEMA_INVALID`；第二次把条数改成 `10` 并执行查询。用户原句未提供这两项选择，因此这次成功执行不作为修复成功。未执行后续恢复回合，因为没有形成合法待澄清状态。未对相同代码重复抽样求过。
