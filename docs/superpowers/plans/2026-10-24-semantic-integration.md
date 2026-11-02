# Ask Metric 业务理解融合实施计划

> **执行说明：** 实施时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，按任务推进并记录证据。用户现已授权执行本计划；不包含 Git 提交、推送或发布授权。实际进度与证据见[验收清单](../../业务理解融合验收清单-2026-10-24.md)。

**Goal：** 在现有指标问数链路内接入适用的业务知识和完整指标查证，改善自然业务表达、必要澄清与连续追问，交付可在真实页面验证的首期能力。

**Architecture：** 维持 Ask Metric 的单 Agent、语义提案、任务账本和受控查询入口。复用指标目录、Skill、向量缓存和既有恢复预算；把 mfws 相关知识按适用范围映射到现有资产，不移植其通用 SQL、模板案例执行器或前置分类服务。

**Tech Stack：** 当前 Node/TypeScript、Pi Agent、Python/FastAPI、MySQL 与 Vue；沿用锁定依赖和现有测试工具。

**Spec：** [目标与设计](../specs/2026-10-24-semantic-integration-design.md)。

## 全局约束

- 保留当前前端体验、权限边界和受控 SQL；不新建第二套 Agent、会话、知识库平台或任意 SQL/Python 执行路径，不新增运行依赖。
- 参考 mfws 已提交 `jjccb-release`，不切换或覆盖其工作区。迁移资产注明出处及适用范围。
- 保留 Ask 当前用户和同事的改动，不把已有改动全部计入本任务。默认不提交、不推送、不发布。
- 实际验收使用用户指定的真实模型与 `3309 / ads_lake`；不改写业务源数据，不使用演示账号或演示数据替代。
- 优先复用既有目录和 Skill 的维护、加载和版本处理；不复制多份正式口径。知识更新后核对实际生效版本，不能只验证文件保存成功。

## 重点检查

1. 同义表达仍可能指向不同口径：候选必须与完整定义核对，不能按最高分自动执行。
2. 指标定义缺失或更新：无依据时说明缺口，旧定义和旧签发引用不能继续当现行依据。
3. 候选有结果但数据无结果：不能换指标、放宽日期或把空值当零。
4. 待澄清时插问定义：原问题版本、有效条件和待办必须保留，回复旧版本或撤权历史不能执行。
5. 检索服务失败或无进展：保留可用确定性检索与真实错误，遵守恢复预算，不无限循环或追加固定模型调用。

## Task 1：固定问题、知识依据和变更基线（M0）

**Files：**
- 创建 `docs/业务理解融合验收清单-2026-10-24.md`，存放脱敏问题、预期行为、知识适用性与执行结果，不保存凭据。
- 读取现有 `.runtime/local/intent-20261024/` 和 `docs/意图理解优化说明-2026-10-24.md`，复用已有证据，不重复计算为新成果。
- 读取 mfws 已提交 `agent.py`、`tools/domain_knowledge.py`、`tools/metric_search.py` 及与当前指标相关的知识资产。

**输入/输出：** 当前真实目录、既有会话证据和 mfws 参考资料 → 固定的 12 个单轮与 4 组多轮清单，以及“来源—适用指标—正式定义—冲突/缺失—目标维护位置”映射。

- [x] 记录当前分支、实际未提交差异、模型配置标识和目录版本，避免基线误用为干净 HEAD；不导出连接凭据。
- [x] 从既有问法和当前真实目录选定正式问题，逐项确定预期意图、指标范围、机构、日期和是否应追问；真实源值通过授权只读查询核对。
- [x] 对知识标记“可复用、需要业务确认、不适用”；不能将 mfws 示例 SQL、数值或未核实名称转换当成当前业务事实。
- [ ] 固定清单后只对缺少基线证据的用例补测；至少选择一条依赖完整业务含义的自然问法进入 Task 2，不能只选精确名称。

**结束条件：** 问题、正确行为和知识来源可以逐项核查。对真实知识缺失，先列明确资料问题，技术机制工作仍可推进；缺失不能被当成已完成业务理解验收。

## Task 2：知识参与指标发现，打通第一条链路（M1）

**Files：**
- 修改 `backend-next/src/ask_metric/infrastructure/model/catalog_vectors.py:catalog_embedding_texts`。
- 复用 `backend-next/src/ask_metric/api/routes/catalogs.py:_metric_hit_payload` 和 `agent-service/src/tools/catalog.ts:createCatalogTool` 的已有说明返回。
- 复用现有指标维护接口及 `agent-service/src/businessSkills.ts` 的注册、读取和正文版本处理。只对 Task 1 已确认适用的资产做定向更新，不覆盖用户已有内容。
- 扩展 `backend-next/verification/test_catalog_knowledge.py`、`agent-service/tests/catalogKnowledge.test.ts`。

**接口：** 保留 `catalog_embedding_texts(metrics: Sequence[MetricCatalogItem]) -> list[str]`，输出仍逐指标对应；将 `explanation` 加入名称、别名和 `description` 的现有表示。保留既有 `metric_explanation`、`description` 返回字段和空值语义；不新增业务事实生成接口。

- [x] 增加 `test_embedding_texts_include_explanation`：说明进入表示、与条目顺序一一对应、空说明不补造内容；先运行该测试确认原实现不能满足新增要求。
- [x] 增加定义更新回归：说明变更后使用更新的检索文本及返回值，不复用旧正文当作现行依据；沿用缓存按文本和模型识别的机制。
- [ ] 实现最小表示补充；必要的业务知识按 Task 1 映射进入已有目录或 Skill，并验证实际运行时收到的是该版本资料。
- [ ] Python：在 `backend-next` 的现有开发环境运行 `python -m pytest verification/test_catalog_knowledge.py -q`；Agent：在 `agent-service` 运行 `npm test -- tests/catalogKnowledge.test.ts tests/queryDefinitionDelivery.test.ts`，要求全部通过。
- [ ] 通过真实链路验证自然问法、口径解释和后续条件修改；保留实际提供给模型的资料及正式查询条件，不能仅检查提示词存在某句话。

**结束条件：** 至少一条有适用知识依据的完整业务链路成功；有内容和资料缺失两种情况均如实交付。若该链仍受恢复检索限制，保持 M1 未完成，接着完成 Task 3 后复验。

## Task 3：恢复检索使用已有能力，保留正式绑定边界（M1/M2）

**Files：**
- 修改 `backend-next/src/ask_metric/api/routes/analysis.py:discover_metrics`。
- 修改 `backend-next/src/ask_metric/application/metric_semantics.py:MetricSemantics.search`。
- 复用 `backend-next/src/ask_metric/application/catalog_search.py:metric_embedding_scores/search_metrics`。
- 调整 `agent-service/src/analysis/tools.ts:createAnalysisCatalogTool` 与 `agent-service/src/analysis/bindings.ts:catalogBindingView` 的候选展示，保持近似推荐与正式绑定分离。
- 按失败回归所需调整 `agent-service/src/semantic-task/queryRecovery.ts` 与 `agent-service/src/harnessHost.ts` 的恢复工具约束，保留旧协议和冻结条件。
- 扩展 `backend-next/verification/test_catalog_knowledge.py`；创建 `agent-service/tests/queryRecovery.test.ts`。

**接口：** 给 `MetricSemantics.search` 增加可选关键字参数 `embedding_scores: dict[str, float] | None = None`，原有调用行为兼容；路由按已有配置调用 `metric_embedding_scores`。语义候选与确定性命中分开返回，候选不得直接进入可执行绑定。沿用当前正式名称/编码查证和已有引用协议，查证后才可形成原有提案；同主题推荐也不证明用户要求选择该指标。

- [x] 增加分析目录回归：自然说法只有语义推荐时可发现候选，但候选本身不具备正式执行引用；完整名称查证后才能沿现有绑定执行。原有精确匹配和分页行为不变。
- [x] 增加错误回归：模型不可用与零命中可区分；有确定性命中时仍可使用，不能伪造语义分数或以空集合掩盖服务失败。
- [x] 增加 `queryRecovery.test.ts`，验证恢复后只修正指标解释，机构、日期、排序和原意保留；无进展遵守现有两轮预算，不能通过新工具名绕过。
- [ ] 实现共用召回与候选查证衔接；检索返回的近似推荐须保留到实际模型上下文，不能被 `catalogBindingView` 丢弃，也不能注册为已确认引用。检查 `queryRecoveryPhase` 及宿主当前强制工具顺序，让必要的查证动作在既有预算内可达。精确查询不增加前置模型调用。
- [ ] 运行 Task 2 的 Python 检查及 `npm test -- tests/queryRecovery.test.ts tests/queryDefaults.test.ts`，要求通过。
- [ ] 重跑原来的未命中自然问法，并增加未写入提示词的同义表达；检查候选、定义、正式绑定及最终结果四者一致。

**结束条件：** 恢复阶段实际用得上检索能力，且“找到相似项”不会直接变成“确认了指标”。不得以放松绑定或扩大查询范围换取成功。

## Task 4：续问、澄清与交付回归（M2）

**Files：**
- 扩展 `agent-service/tests/queryDefinitionDelivery.test.ts` 和 Task 3 的恢复测试。
- 仅在回归失败定位到具体原因时修改 `semantic-task/planService.ts:SemanticPlanService.resolve`、`questions.ts:normalizeAnswerForQuestion`、`contextMemory.ts:permissionFilteredContext` 或已有交付逻辑，不重写状态框架。

**接口：** 继续使用既有 `query/analyze/calculate/reuse`、任务引用、待确认问题 ID/version 和答案协议；不增加第二份“理解结果状态”。

- [ ] 固定设计中的四组多轮回归，验证只改指定字段、插问不清空工作目标、回答澄清后继续原任务以及历史重开后的权限核验。
- [ ] 覆盖同义但口径不同、旧问题版本、定义更新、资料缺失、明确历史日期无数等边界；先复现再修复。
- [ ] 对已正确的流程只增加必要回归，不为显示“融合”而重写；答案若包含内部字段，定位实际交付来源后修正，不能只在提示词里继续叠禁令。
- [ ] 在 `agent-service` 运行受影响测试、`npm run typecheck` 和 `npm run build`。后端运行受影响验证；无新增失败或具体疑点后不扩展为全平台回归。

**结束条件：** 首批清单每项结果可追溯，正确执行与诚实澄清分别统计；没有遗失条件、错误默认或超预算重试。

## Task 5：真实桌面验收与交付（M3）

**Files：** 更新 Task 1 的验收清单；必要的脱敏原始证据保存在 `.runtime/local/`，不把凭据、完整敏感日志或测试数据加入产品。

- [ ] 复用现有启动方式和正常登录，使用真实模型、`3309/ads_lake` 完成桌面提问、澄清、插问和历史重开。仅桌面视口。
- [ ] 对照源数据核对指标、机构、日期、单位和值；资料不足、数据为空和执行失败分别记录。
- [ ] 按设计复验三类核心新行为，保留原始失败；同条件比较正确性、无必要追问、工具调用和耗时，不用一次成功或不同模型比较宣称架构优越。
- [ ] 完成一次独立代码检查及最终 diff 核对，确认新增行为、权限、版本和范围边界，以及无无关改动或凭据。
- [ ] 写明实际变更、适用知识清单、验证结果、未解决问题和对应的定向回退方法；不使用全仓库重置，不覆盖同事配置。

**结束条件：** 设计第 7 节全部满足才标记首期完成。归因超时或复杂计算等已知范围外事项单列，不能把路由成功写成这些能力已通过验收。

## 本次规划交付说明

本计划已进入实施。已完成指标说明检索文本、恢复目录查证与边界修复，并执行真实问数和桌面历史续问。正式业务定义与实际向量服务仍缺，完整知识正例不能标记完成；澄清纠错和最终验收结果以验收清单为准。未勾选项表示尚未满足整项全部条件，不能据此断言其内部工作完全未开始。
