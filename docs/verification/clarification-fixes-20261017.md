# 问数澄清与多轮续接修复记录（2026-10-17 续修）

依据：[问数澄清与多轮续接修复方案-2026-10-17](../../问数澄清与多轮续接修复方案-2026-10-17.md)。
本轮在既有改动基础上补齐失败点；不新增状态机、重试层或配置体系，复用现有字段解析、问题记录、任务续接和整批准入。

## 本轮修改

| 修复项 | 修改 | 主要位置 |
| --- | --- | --- |
| ① 默认口径/文字交互 | 时间值恰好补全当前基础指标的唯一目录口径成员（如“较上月”“当日数”）时，按指标口径切换并保留原日期；`time` 若同时被写成同一指标口径后缀，明确要求只改指标口径。目录返回基础名与价值口径供宿主核验，不从名称字符串拼造指标；跨轮准入对同一基础名、且口径词确在本轮原文的变更复用该目录事实。 | `semantic-task/service.ts`、`application/field_resolution.py`、`application/semantic_transition.py`、`semantic-task/prompt.ts` |
| ② 问题发布与回答受理 | `reject`/`none_of_these` 不再进入字段操作集合，避免整批准入二次受理（相同 operationId、空 operations）用空操作覆盖已解析机构；已发布问题的回复序号必须与展示清单一致，未展示序号不能借序号选中；部分回答只拒绝同组候选时，同一未决槽位签发新的 open 题版本，不只留下无题可答的 pending 文本。 | `semantic-task/service.ts`、`semantic-task/planService.ts`、`semantic-task/store.ts` |
| ③ 机构纠错限定槽位 | 槽位原值确为本轮连续原文时补记错字依据；模型把原文错字预纠成规范名时，后端回记原文片段，宿主按原文重新解析并保留纠正痕迹；整批准入复用 `org_answers.field_resolution`，完整原问仍只做精确覆盖。验收桥的机构解析改为调用与 HTTP 接口相同的实现，避免绕过该修复。 | `api/routes/business_context.py`、`application/field_resolution.py`、`semantic-task/planService.ts`、`semantic-task/service.ts`、`scripts/clarification-acceptance-fixture.py` |
| ⑤ 时间处理接线 | 待补计划续接时，本轮刚采纳的日历随步骤 `model_value` 上送准入；只给出一端（“到2026年9月末”）的区间先按确定性形状判为不完整，拒绝模型单点换算并追问缺失端。 | `semantic-task/planService.ts`、`semantic-task/service.ts`、`application/field_resolution.py` |
| 结算需求刷新 | 澄清续补完成后，需求检查同步为已完成步骤的最终指标、机构、日期；离散时点按日期成员核对。不再用最初占位默认日期判定未满足。 | `semantic-task/planService.ts` |
| 追问正文精简 | 宿主不再在澄清/失败回答末尾追加“已保存条件”段落；条件仍随结构化回执投影；前端仅隐藏旧消息遗留的该段落后缀。 | `semantic-task/feedback.ts`、`lib/assistantMarkdown.ts` |
| DeepSeek 官方接口兼容 | `read`/`catalog` 等聚合工具的 `function.parameters` 顶层补 `type:"object"`，避免官方接口以 schema 不是 object 拒绝；字段问题文字回答附带的 `context_action=resume` 在没有 `clarify_business_turn` 备选时按普通续接处理。 | `tools/readTools.ts`、`tools/catalog.ts`、`semantic-task/planService.ts` |

同步更新 `docs/pi-semantic-task/implementation-multiturn-context.md` 的准入/口径说明，以及受影响测试的断言。

## 模型接口切换

Agent 与后端 Chat 均切到 DeepSeek 官方 OpenAI 兼容接口：`https://api.deepseek.com`、模型 `deepseek-flash`（官方当前 Flash，服务版本 DeepSeek-V4.1-Flash-1017），非思考模式（`thinking.type=disabled`）。`deepseek-flash` 官方默认开启 thinking，而 Agent 使用 `tool_choice=required`，该参数只在非思考模式支持。密钥按项目既有 SM4 机制加密存放在本地 `.env`，未写入源码、文档或日志。Embedding/Reranker 未随 Chat 切换（当前均未启用，且 DeepSeek 官方不提供 embedding 接口）。

官方接口对 `function.parameters` 的顶层 `type` 校验更严格，本轮补齐了 `read`/`catalog` 聚合工具的 `type:"object"`，否则真实调用直接返回 400。

## 自动化检查结果

| 检查 | 结果 |
| --- | --- |
| `backend-next` pytest（`verification/`，含机构纠错、采纳日历、语义计划/准入、口径变更准入） | 723 passed |
| `agent-service` typecheck（src + specs） | 通过 |
| `agent-service` vitest | 83 files / 1313 tests passed |
| `frontend-vue` typecheck、vitest、build | 通过（18 files / 88 tests） |
| `git diff --check` | 通过 |
| 验收 fixture 离线校验 | `fixtures_valid`（15 机构、5 指标、21 行区间数据） |

说明：本机 `NO_PROXY` 含 `[::1]` 会令 httpx 解析代理时报 `Invalid port`，后端测试需以 `NO_PROXY=localhost,127.0.0.1` 运行；该失败与业务代码无关。

## 真实模型验收（A1—A8，DeepSeek 官方）

模型接口已切到 DeepSeek 官方 OpenAI 兼容接口（`https://api.deepseek.com`，`deepseek-flash`，非思考模式）。
用当前代码与真实 DeepSeek 模型重跑 `scripts/check-clarification-acceptance.ts --live`，A1—A8 与 R1/R2 **13 个场景全部首次通过**：

| 场景 | 结果 | 尝试次数 |
| --- | --- | --- |
| A1、A2、A3、A4 | 通过 | 1 |
| A5a、A5b、A5c、A5d | 通过 | 1 |
| A6、A7、A8 | 通过 | 1 |
| R1-candidate-cap、R2-fullname-independent | 通过 | 1 |

报告：[clarification-acceptance-20261017-deepseek.json](clarification-acceptance-20261017-deepseek.json)（`environment=real_model_synthetic_catalog_in_memory_SQL`、`real_database=false`，即真实模型 + 合成目录/内存 SQL，不连接业务库）。

对应的自动化回归：

- 序号越界、部分回答重开候选：`candidateReplyEdgeCases.spec.ts`、`questionFlow.spec.ts`；
- 旧候选拒绝后改填新机构、空 operations 二次受理：`questionFlow.spec.ts`；
- 模型预纠错字与按原文重新解析：`questionFlow.spec.ts`、`test_org_typo_scope.py`；
- 口径词被写进 time、按口径切换并保留日期：`questionFlow.spec.ts`；
- 待补计划采纳日历续接、需求条件刷新、无备选 resume：`plan.spec.ts`；
- 单侧区间拒绝模型单点换算：`test_adopted_calendar.py`；
- 口径变更跨轮准入：`test_semantic_transition.py`。

真实浏览器刷新恢复与页面手工验收仍需按方案执行；上述报告覆盖真实模型、真实 Python 解析/准入与合成查询回执。
