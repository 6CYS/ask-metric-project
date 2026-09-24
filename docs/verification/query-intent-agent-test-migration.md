# Agent 查询协议回归迁移记录

2026-09-22。旧 `metric_ask` 执行器和其 SDK 写方法已经删除，历史回执只读类型迁至 `tools/shared.ts`。以下映射说明原测试的有效业务断言保留位置；不再维持旧 `new/clarify/followup/compose` 执行协议。

| 原测试目标 | 新链路验证位置 |
| --- | --- |
| 初始问题执行、事实与真实结果引用 | `business-context/context.spec.ts` 实际工具闭环；`queryIntentV2.spec.ts` 指定日排名完整执行 |
| 成功回执的回答块与缺省行为 | `tools/readTools.test.ts` result 模式 answer_blocks 透传；普通查询结果和事实由 `tools.structured.test.ts` 保留 |
| 缺项补充保留已知条件，不重复查询 | `context.spec.ts` 新查询/缺项/补充/继承；低分候选下一轮确认且仅查询一次 |
| 澄清版本冲突/目标卡片不一致 | 旧卡片任务写协议停用；新 Frame 的 CAS、不可变快照、候选回合绑定、未声明字段拒绝覆盖同类并发与来源边界 |
| 同一操作重复命令幂等、响应丢失后恢复 | `context.spec.ts` 重复执行复用；后端503响应丢失保留 executing、相同幂等键；快照完成但成功Frame未提交恢复 |
| 第二个不同意图限制 | 旧“一轮仅一次查询”与当前合法取数后计算不一致，删除旧限制断言；`harnessHost.test.ts` 原生组合取数后计算与执行预算验证现行合同 |
| followup/compose 继承与来源选择 | `context.spec.ts` 明确Selector、多匹配/无匹配、跨能力继承；`queryIntentV2.spec.ts` 换日期/条数/取消排名/独立新问题 |
| 字符串化source还原 | 新 Frame 严格对象契约不接受字符串引用；`harnessHost.test.ts` 真实Pi schema拒绝错误引用，纠正后继续Frame流程 |
| 在途任务恢复不重复分析/澄清 | 旧分析阶段已删除；新Frame只解析一次并使用固定执行键，`context.spec.ts` 和 Host 原生重开测试覆盖 |
| 历史来源不可用不伪造新任务 | `context.spec.ts` Selector无匹配、失败不可继承；`harnessHost.test.ts` 编造Frame来源不得执行 |
| 目录读取不擅自改变模型来源 | `harnessHost.test.ts` 改为纯合成工具验证宿主透传与重开，去除对已退休执行器依赖 |
| 429不得伪装成功或注入证据 | `harnessHost.test.ts` 原断言保留，使用当前工具集 |
| 月份覆盖分组与截断说明 | `tools/composedQuery.test.ts` 原有效断言保留 |
| 旧活动操作不可恢复、新会话正常 | `routes.test.ts` 旧业务工具会话只读，GET/SSE标记，POST明确409，保留历史 |

`check-skill-regressions.ts` 与 `check-composed-model.ts` 的合成后端已迁至 Frame 字段解析、scope与结构化取数，真实模型探针不再允许旧自然语言任务入口算通过。探针使用真实模型时仍需独立执行并保存结果；静态类型检查不代表模型验收通过。
