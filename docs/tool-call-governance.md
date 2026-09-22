# 工具调用治理与验收

当前智能问数统一采用 [Pi 通用多轮业务上下文](pi-business-context.md)。Pi 是唯一 Agent，业务知识、结构化状态和后端事实职责分离。

| 用户目标 | 当前动作 | 执行边界 |
| --- | --- | --- |
| 新问题 | resolve_business_turn，baseReference=null | 原文字段由 Resolver 解析；不完整则澄清 |
| 补充、替换或清除字段 | resolve_business_turn，fieldChanges | 按 Schema 合并，追加新 Frame |
| 回到历史操作 | FrameSelector | 必须唯一定位，歧义不执行 |
| 取值、覆盖或计算 | execute_business_frame | 仅本轮 READY 引用，标准参数由服务端生成 |
| 历史结果重显 | reuse_result → read_business_result | 使用快照，读取时复查权限，不重新取数 |
| 目录浏览 | catalog | 支持最多四项批量检索；候选不等同确认 |
| 多步结果交付 | Pi 根据工具事实生成回答 | 不隐藏失败或截断，不再调用额外交付工具 |

公开工具不接受模型生成的业务编码。旧 metric_ask、metric_query_structured、data_availability、metric_calculate 不再作为模型可直接调用的查询入口。
底层结构化查询、覆盖和计算实现继续被执行适配器复用。read 保留旧结果与原生历史的兼容查阅。

日志区分 proposed/admitted/blocked/executed，参数只记录指纹、控制字段和数量。
Frame 日志解释来源、继承、解析及校验结果。按会话隔离的持久化状态供排错，不向普通日志复制敏感字段值。

解析后已确定的执行/回读动作由原生工具循环接续，不允许模型用重复确认替代执行；只解析、待澄清、中止与失败不触发自动执行或重试。旧 Frame 跨轮执行返回调用纠正指引；无本轮指标片段的替换不会覆盖已有字段，也不会自动查询旧指标。具体契约见通用多轮文档。

## 验证

当前离线验收以 `agent-service/src/business-context/context.spec.ts`、Pi 宿主/HTTP 恢复回归及
`backend-next/verification/test_business_context.py` 为准。真实模型改写测试使用
`agent-service/scripts/check-context-semantics.ts --live`，后端为合成桩，不连接真实业务数据库。

原 `scripts/tool-governance/` 保留历史端到端验收资产；其中旧工具首选动作统计针对旧协议，不能直接当作新 Frame 协议的合格证明。
复用真实环境验收时必须按新协议解释工具选择、Delta、Frame 和结果证据，并单独确认环境授权。
旧现场报告、模型桩和合成数据均不代表本次已通过真实模型、数据库或页面验收。

新能力的验收必须同时检查原文改写、指标/机构替换、字段顺序变化、新增 Schema 字段，以及缺项、歧义、失败、权限变化和恢复。
禁止把验收语句复制进生产 Prompt、问法字典或条件分支。

升级与回退按通用多轮文档执行：配套发布后端/Agent/前端、排空活动回合、保留数据目录，无数据库迁移。
