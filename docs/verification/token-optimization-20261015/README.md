# Token 优化验证证据

后续主开发切换已完成：8010 / 8020 / 5173 已加载最终代码，必填配置已写入开发环境，真实页面三轮问数及刷新、重启恢复通过。见 [5173 主开发验收](main-development-5173.md)。

`final-4` 付费实测快照的**选定主路径通过**。双方整个任务成功的 7 组配对，输入 token 减少 47.10%、总 token 减少 46.64%、模型调用减少 36.84%。最终 post-review 的三端也已实际重启并自动恢复同一会话，零新增模型/业务取数。全部费用账、基线历史失败、早期候选回归和原范围失败均保留；不能宣称所有路径通过。

- [最终主路径摘要与边界](summary.md)、[完整原始账本](paired-final-4.json)、[成功整任务子集](final-4-success-cohort.json)、[主路径审计](paired-final-4-audit.md)。
- [当前合并工程检查](implementation-checks.md)、[冻结源码 manifest](candidate-final-4-manifest.json)、[隔离后端配置](final-4-backend-preflight.json)、[独立参考结果](final-4-backend-reference-check.json)。
- [完整计算复核](final-4-calculation-review.json)、[浏览器最终恢复](browser-post-review.json)、[原刷新失败](browser-refresh-failure-trace.json)。
- [最终源码 manifest](candidate-post-review-manifest.json)、[最终源码一致性及付费实测边界](post-review-source-consistency.json)。

主开发入口：[http://127.0.0.1:5173/chat](http://127.0.0.1:5173/chat)。原隔离结果页 5175 仍保留。新增 6 个机构必填配置已补齐到开发 `.env`；含金额截图仅存私有临时目录。

`final-3` 的 38 个任务、68 回合和失败仍在 [完整矩阵摘要](final-3-summary.md)，未被后续成功数据替换：

- [final-3 原始矩阵](paired-final-3.json)、[审计](paired-final-3-audit.md)、[冻结源 manifest](candidate-final-3-manifest.json)。
- [缺项追问回归 trace](final-3-missing-rep3-trace.json)、[范围失败跨版投影](paired-final-3-range-projection.json)。
- [诊断阶段与复现命令](diagnostic-stage.md)、[final-2 中止账本](paired-final-2-stopped-ledger.json)。
- [早期冻结源差异（历史记录）](final-source-consistency.json)、[早期运行后端证据](backend-source-drift.json)。最终当前状态以 [post-review 源码一致性](post-review-source-consistency.json) 为准。

所有公开结果只保存脱敏元数据和 hash，不含令牌或业务金额。原生会话及独立参考结果留在私有临时目录。真实开发验证与隔离权限负例分别记载，均不代表生产验收。
