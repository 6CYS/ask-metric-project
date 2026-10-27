import {expect, it, vi} from "vitest";
import {BackendApiError, type BackendClient} from "../backendClient.js";
import type {BusinessFrame} from "../business-context/types.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../tools/testUtils.js";
import {createAnalysisCatalogTool, createAnalysisReportTool, createGeneralAnalysisTool} from "./tools.js";
import {analysisPlanProblem, validateAnalysisPlanShape, type AnalysisPlan} from "./contracts.js";
import {analysisBudget, analysisCandidates, analysisDiscoveryRounds, catalogBindingState, catalogBindingView, registerAnalysisPlan, resolveCatalogBindings, restoreAnalysisDiscovery} from "./bindings.js";
import {analysisCoverageReview, analysisPlanningReview} from "./coverage.js";
import {Compile} from "typebox/compile";
import {createBusinessReportTool} from "../tools/businessReport.js";

const plan: AnalysisPlan = {objective: "隔离样本盈利分析", scope_notice: "仅展示所选指标",
  requirements: [{id: "profit", question: "盈利表现如何"}], steps: [{id: "read", method: "observe",
    metric_refs: ["signed-reference"], answers: ["profit"], rationale: "先确认现状"}]};
const api = (value: unknown) => value as BackendClient;
const evidence = {kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1" as const,
  run_ref: "analysis:sample", scope_id: "op-1", analysis_date: "2026-08-27", org_codes: ["3200"],
  metric_descriptors: [], evidence_items: [{ref: "sample.f1", type: "fact", display: "合成值"}], rows: [], plan};

it("模型只看到必填body的报告契约，避免新旧可选分支让模型漏写正文", () => {
  for (const tool of [createAnalysisReportTool(), createBusinessReportTool()]) {
    const validator = Compile(tool.parameters);
    const common = {evidence_refs: ["e1"], ...(tool.name === "business_report_present" ? {metric_ids: ["total"]} : {})};
    expect(validator.Check(common)).toBe(false);
    expect(validator.Check({...common, body: "根据证据回答实际问题。"})).toBe(true);
    expect(validator.Check({...common, body: ""})).toBe(false);
    expect(validator.Check({...common, summary: "旧草案", sections: []})).toBe(false);
  }
});

it("泛称经营发现收益质量入口，明确指标检索不改写且不超关键词预算", async () => {
  const search = vi.fn(async (_keyword: string) => ({items: []}));
  const request = testRequestContext(api({analysisMethods: async () => ({}), analysisCatalog: search}), new MemoryCommandBridge());
  await runTool(createAnalysisCatalogTool(), {keywords: ["经营", "贷款", "存款", "规模"]}, request);
  expect(search.mock.calls.map(call => call[0])).toEqual(["利润", "不良", "贷款", "存款"]);
  search.mockClear();
  await runTool(createAnalysisCatalogTool(), {keywords: ["经营性贷款余额"]}, request);
  expect(search.mock.calls.map(call => call[0])).toEqual(["经营性贷款余额"]);
});

it("首次发现将已有覆盖门禁及正式比较前置为参考，不查数、不编造关系，不影响精确查询", async () => {
  const items = [
    {code: "total", metric_id: "total", section: "scale"},
    {code: "personal", metric_id: "personal", section: "structure"},
    {code: "personal_mom", metric_id: "personal", section: "growth", comparison: "mom", comparison_role: "difference"},
    {code: "unrelated", metric_id: "other", section: "growth", comparison: "mom", comparison_role: "difference"},
  ].map(item => ({code: item.code, name: `合成${item.code}`, binding_ref: `signed-${item.code}`,
    analysis_hint: {topic: "sample", topic_name: "合成主题", default_sections: ["scale", "structure"], ...item}}));
  const search = vi.fn(async () => ({items}));
  const request = testRequestContext(api({analysisMethods: async () => ({}), analysisCatalog: search}), new MemoryCommandBridge(),
    {originalMessage: "最近经营情况怎么样"});
  const result = await runTool(createAnalysisCatalogTool(), {keywords: ["合成主题"]}, request);
  const text = result.content.find((block: {type: string}) => block.type === "text");
  if (text?.type !== "text") throw new Error("missing body");
  expect(JSON.parse(text.text).planning_review).toEqual(analysisPlanningReview(request));
  expect(analysisPlanningReview(request)).toContainEqual(expect.objectContaining({aspect: "业务构成",
    candidates: [{binding_ref: "k2", name: "合成personal"}], comparisons: [{binding_ref: "k3", name: "合成personal_mom"}]}));
  expect(search).toHaveBeenCalledTimes(1);
  request.originalMessage = "这个指标值是多少";
  expect(analysisPlanningReview(request)).toEqual([]);
  const empty = testRequestContext(api({}), new MemoryCommandBridge(), {originalMessage: "最近经营情况怎么样"});
  expect(analysisPlanningReview(empty)).toEqual([]);
});

it("公共计划拒绝循环依赖与未覆盖问题，允许带明确缺口的子问题", () => {
  expect(validateAnalysisPlanShape(plan)).toBe(true);
  expect(analysisPlanProblem({...plan, steps: undefined})).toContain("缺少steps");
  expect(validateAnalysisPlanShape({...plan, steps: [{...plan.steps[0], depends_on: ["read"]}]})).toBe(false);
  expect(validateAnalysisPlanShape({...plan, steps: []})).toBe(false);
  expect(analysisPlanProblem({...plan, steps: [{...plan.steps[0], answers: ["盈利表现"]}]})).toContain('requirements.id：["profit"]');
  expect(analysisPlanProblem({...plan, steps: [{...plan.steps[0], method: "structure"}]})).toContain("改用observe");
  const unanswered = {...plan, requirements: [...plan.requirements, {id: "deposit", question: "存款的变化"}]};
  expect(analysisPlanProblem(unanswered)).toContain('"id":"deposit"');
  expect(analysisPlanProblem(unanswered)).toContain("analysis_catalog");
  expect(analysisPlanProblem({...unanswered, requirements: unanswered.requirements.map(item => item.id === "deposit"
    ? {...item, gap_reason: "已查目录未发现"} : item)})).toBeUndefined();
  const broad = (count: number) => ({...plan, steps: Array.from({length: Math.ceil(count / 12)}, (_, batch) => ({...plan.steps[0]!, id: `read${batch}`,
    metric_refs: Array.from({length: Math.min(12, count - batch * 12)}, (_, i) => `k${batch * 12 + i}`)}))});
  expect(analysisPlanProblem(broad(32))).toBeUndefined();
  expect(analysisPlanProblem(broad(33))).toContain("最多32个");
  expect(validateAnalysisPlanShape({...plan, steps: [], requirements: [{id: "x", question: "缺少什么", gap_reason: "未发现相关正式指标"}]})).toBe(true);
});
it("自由正文沿用后端数字日期引用校验，不再要求固定章节", async () => {
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "合成分析"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence}]});
  const result = await runTool(createAnalysisReportTool(), {evidence_refs: ["e1"], body: "先关注差异，再核查{{e1.v1}}。"}, request);
  expect(result.terminate).toBe(true);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({summary: "先关注差异，再核查{{sample.f1}}。", sections: []}), expect.anything());
});

it("内部规划按段移除，其余有效正文通过统一保留策略交付", async () => {
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "隔离事实"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence}]});
  const result = await runTool(createAnalysisReportTool(), {evidence_refs: ["e1"],
    body: "让我构造resolve_business_turn，再调用工具。\n\n已经核验{{e1.v1}}。"}, request);
  expect(result.terminate).toBe(true);
  expect(report).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({retain_valid: true, summary: "已经核验{{sample.f1}}。"}), expect.anything());
});

it("先核验判断短引用映射稳定，保留原始链路且可直接用于通用报告", async () => {
  const prepared = {...evidence, verified_findings: {version: "verified-findings-v1", boundary: "同日同机构",
    items: [{ref: "sample.j1", kind: "comparison_direction", text: "正式比较增加。", evidence_refs: ["sample.f1"]}]},
    evidence_items: [...evidence.evidence_items, {ref: "sample.j1", type: "observation", display: "正式比较增加。",
      judgment_kind: "comparison_direction", input_refs: ["sample.f1"]}]};
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "已核验判断"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence: prepared}]});
  const result = await runTool(createAnalysisReportTool(), {evidence_refs: ["e1.j1"], body: "{{e1.j1}}\n\n{{e1.v1}}"}, request);
  expect(result.terminate).toBe(true);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({run_refs: ["analysis:sample"],
    summary: "{{sample.j1}}\n\n{{sample.f1}}"}), expect.anything());
  const executeRequest = testRequestContext(api({createAgentQueryContext: async () => ({conversation_id: "sample"}),
    analysisExecute: async () => prepared}), new MemoryCommandBridge());
  const frame = {fields: {plan: {resolvedValue: plan}}} as unknown as BusinessFrame;
  const receipt = await runTool(createGeneralAnalysisTool(frame), {}, executeRequest);
  const view = JSON.parse((receipt.content[0] as {text: string}).text);
  expect(view.verified_findings.items).toEqual([{ref: "e1.j1", kind: "comparison_direction",
    text: "正式比较增加。", evidence_refs: ["e1.v1"]}]);
  expect(receipt.details.evidence_items.at(-1).input_refs).toEqual(["sample.f1"]);
});
it("重复转义的报告段落规范化后仍交给原后端校验，只调用一次", async () => {
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "隔离样本"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence}]});
  const result = await runTool(createAnalysisReportTool(), {evidence_refs: ["e1"], body: String.raw`## 观察\n\n已读取{{e1.v1}}。\n\n动因仍待核验。`}, request);
  expect(result.terminate).toBe(true);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({summary: "## 观察\n\n已读取{{sample.f1}}。\n\n动因仍待核验。", sections: []}), expect.anything());
});
it("成文提醒仅一次且不消耗事实纠错次数，重写仍调用原后端校验", async () => {
  const report = vi.fn(async () => { throw new BackendApiError(422, "未获证据支持的数值", "ANALYSIS_REPORT_NUMBER"); });
  const atoms = Array.from({length: 8}, (_, i) => ({ref: `sample.f${i}`, type: "fact", display: "隔离样本"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence: {...evidence, evidence_items: atoms}}]});
  const input = {evidence_refs: ["e1"], body: atoms.map((_, i) => `{{e1.v${i + 1}}}`).join("、")};
  const tool = createAnalysisReportTool();
  expect((await runTool(tool, input, request)).details.status).toBe("needs_revision");
  expect(report).not.toHaveBeenCalled();
  expect((await runTool(tool, input, request)).details.status).toBe("ARGUMENT_ERROR");
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[0]).not.toEqual(expect.arrayContaining([expect.objectContaining({fallback: true})]));
});
it("只有本轮重新读取的旧证据可标为背景，原始运行身份保持不变", async () => {
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "合成分析"}));
  const history = {...evidence, execution_turn_id: "previous-turn"};
  const current = {...evidence, run_ref: "analysis:current", execution_turn_id: "op-1"};
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {operationId: "op-1", answerEvidence: async () => [{ref: "e1", evidence: history}, {ref: "e2", evidence: current}]});
  await runTool(createAnalysisReportTool(), {evidence_refs: ["e1", "e2"], body: "结合已读取背景与本轮事实判断。"}, request);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({context_run_refs: [history.run_ref],
    run_refs: [history.run_ref, current.run_ref]}), expect.anything());
  expect(history.execution_turn_id).toBe("previous-turn");
});

it("只讨论旧分析时按真实正文引用创建追问视图，不伪造本轮新运行", async () => {
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "合成利润对比"}));
  const history = {...evidence, execution_turn_id: "previous-turn", evidence_items: [
    {ref: "old.loan", type: "fact", display: "合成贷款"}, {ref: "old.profit", type: "fact", display: "合成利润"},
  ]};
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {operationId: "op-1", originalMessage: "那利润呢", answerEvidence: async () => [{ref: "e1", evidence: history}]});
  const tool = createAnalysisReportTool();
  expect((await runTool(tool, {evidence_refs: ["e1"], body: "比较利润表现。"}, request)).details.status).toBe("needs_revision");
  expect(report).not.toHaveBeenCalled();
  const result = await runTool(tool, {evidence_refs: ["e1"], body: "利润观测{{e1.v2}}，原因仍待核查。"}, request);
  expect(result.terminate).toBe(true);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({context_run_refs: [history.run_ref],
    run_refs: [history.run_ref], focus_refs: ["old.profit"], summary: "利润观测{{old.profit}}，原因仍待核查。"}), expect.anything());
  expect(history.execution_turn_id).toBe("previous-turn");
});

it("追问cite确定范围但不展示次要数字，旧版回读标识也可识别且不接受猜测引用", async () => {
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "合成分析"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence: {...evidence, result_reused: true}}]});
  const tool = createAnalysisReportTool();
  expect((await runTool(tool, {evidence_refs: ["e1"], body: "{{e2.v1|cite}}"}, request)).details.status).toBe("ARGUMENT_ERROR");
  expect(report).not.toHaveBeenCalled();
  await runTool(tool, {evidence_refs: ["e1"], body: "按所选事实进一步核查。{{e1.v1|cite}}"}, request);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({focus_refs: ["sample.f1"], summary: "按所选事实进一步核查。{{sample.f1|cite}}"}), expect.anything());
});

it("存在本轮新分析时不能只选历史来源绕过原始目标覆盖", async () => {
  const report = vi.fn(async () => {throw new BackendApiError(422, "必须保留本轮分析", "ANALYSIS_REPORT_SCOPE");});
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {operationId: "op-1", answerEvidence: async () => [
      {ref: "e1", evidence: {...evidence, execution_turn_id: "previous"}},
      {ref: "e2", evidence: {...evidence, execution_turn_id: "op-1", run_ref: "analysis:current"}},
    ]});
  const result = await runTool(createAnalysisReportTool(), {evidence_refs: ["e1"], body: "{{e1.v1}}"}, request);
  expect(result.details.status).toBe("ARGUMENT_ERROR");
  expect(report).toHaveBeenCalledWith(expect.objectContaining({focus_refs: []}), expect.anything());
});

it("目录短引用稳定且隔离请求，持久化前还原真实签名", () => {
  const request = testRequestContext(api({}), new MemoryCommandBridge());
  expect(catalogBindingView(request, {items: [{binding_ref: "signed-one", code: "ORG_KNOWN"}, {binding_ref: "signed-two"}]}))
    .toEqual({items: [{binding_ref: "k1", code: "ORG_KNOWN"}, {binding_ref: "k2"}]});
  expect(catalogBindingView(request, {binding_ref: "signed-one"})).toEqual({binding_ref: "k1"});
  const short: AnalysisPlan = {...plan, steps: [{...plan.steps[0]!, metric_refs: ["k2"]}]};
  expect(resolveCatalogBindings(request, short).steps[0]?.metric_refs).toEqual(["signed-two"]);
  expect(() => resolveCatalogBindings(testRequestContext(api({}), new MemoryCommandBridge()), short)).toThrow("ANALYSIS_BINDING_INVALID");
  expect(resolveCatalogBindings(request, plan)).toEqual(plan);
  expect(resolveCatalogBindings(request, {...plan, steps: [{...plan.steps[0]!, metric_refs: ["ORG_KNOWN"]}]}).steps[0]?.metric_refs).toEqual(["signed-one"]);
  expect(() => resolveCatalogBindings(request, {...plan, steps: [{...plan.steps[0]!, metric_refs: ["ORG_FAKE"]}]})).toThrow("ANALYSIS_BINDING_INVALID");
  const recovered = testRequestContext(api({}), new MemoryCommandBridge());
  restoreAnalysisDiscovery(recovered, [{kind: "analysis_catalog", status: "succeeded", binding_map: catalogBindingState(request)}]);
  expect(resolveCatalogBindings(recovered, short).steps[0]?.metric_refs).toEqual(["signed-two"]);
  expect(resolveCatalogBindings(recovered, {...plan, steps: [{...plan.steps[0]!, metric_refs: ["ORG_KNOWN"]}]}).steps[0]?.metric_refs).toEqual(["signed-one"]);
  expect(analysisDiscoveryRounds(recovered)).toBe(1);
  restoreAnalysisDiscovery(recovered, []);
  expect(analysisDiscoveryRounds(recovered)).toBe(1);
});

it("报告短原子引用还原为实际回执引用，模型不能通过别名回填数值", async () => {
  const report = vi.fn(async (_input: unknown) => ({kind: "business_report", status: "succeeded", public_answer: "已核验报告"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence}]});
  await runTool(createAnalysisReportTool(), {evidence_refs: ["e1"], summary: "{{e1.v1}}", sections: [{title: "现状", text: "{{e1.v1}}", evidence_refs: ["e1.v1"]}]}, request);
  expect(report.mock.calls[0]?.[0]).toMatchObject({summary: "{{sample.f1}}", sections: [{text: "{{sample.f1}}", evidence_refs: ["sample.f1"]}]});
});

it("报告来源误填已知原子引用时按本轮证据准确归属并去重，未知引用仍拒绝", async () => {
  const report = vi.fn(async (_input: unknown) => ({kind: "business_report", status: "succeeded", public_answer: "已核验报告"}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(), {
    originalMessage: "指标值是多少", answerEvidence: async () => [
      {ref: "e1", evidence: {...evidence, evidence_items: [...evidence.evidence_items, {ref: "sample.f2", type: "fact", display: "合成比较值"}]}},
      {ref: "e2", evidence: {...evidence, run_ref: "analysis:next"}},
    ],
  });
  const tool = createAnalysisReportTool();
  const result = await runTool(tool, {evidence_refs: ["e1.v1", "e1.v2", "e2.v1"], body: "{{e1.v1}}，相关比较已核对{{e1.v2|cite}}。"}, request);
  expect(result.terminate).toBe(true);
  expect(report.mock.calls[0]?.[0]).toMatchObject({run_refs: ["analysis:sample", "analysis:next"], summary: "{{sample.f1}}，相关比较已核对{{sample.f2|cite}}。"});
  report.mockClear();
  expect((await runTool(tool, {evidence_refs: ["e1.v999"], summary: "现状", sections: []}, request)).details.status).toBe("ARGUMENT_ERROR");
  expect(report).not.toHaveBeenCalled();
});

it("目录服务失败不伪装成目录为空，鉴权失败直接传播", async () => {
  const backend = {analysisMethods: async () => ({}), analysisCatalog: async () => {throw new BackendApiError(503, "内部诊断", "UNAVAILABLE");}};
  const request = testRequestContext(api(backend), new MemoryCommandBridge());
  const result = await runTool(createAnalysisCatalogTool(), {keywords: ["收益"]}, request);
  expect(result.details).toMatchObject({status: "error", retryable: true});
  expect(JSON.stringify(result)).not.toContain("内部诊断");
  backend.analysisCatalog = async () => {throw new BackendApiError(403, "denied", "DENIED");};
  await expect(runTool(createAnalysisCatalogTool(), {keywords: ["收益"]}, request)).rejects.toMatchObject({status: 403});
});

it("目录发现四批后停止网络检索，保留已有正式引用供规划", async () => {
  const search = vi.fn(async () => ({items: [{binding_ref: "signed-sample", name: "合成指标", metadata_version: "private-version"}]}));
  const request = testRequestContext(api({analysisMethods: async () => ({}), analysisCatalog: search}), new MemoryCommandBridge());
  const tool = createAnalysisCatalogTool();
  for (let i = 0; i < 4; i++) {
    const receipt = await runTool(tool, {keywords: ["合成指标"]}, request);
    expect(JSON.stringify(receipt.content)).not.toContain("private-version");
    expect(JSON.stringify(receipt.content)).toContain("k1");
  }
  expect((await runTool(tool, {keywords: ["继续换词"]}, request)).details).toMatchObject({status: "budget_exhausted"});
  expect(search).toHaveBeenCalledTimes(4);
});

it("执行计划复用当前真实问题与会话，补查固定首轮截至日", async () => {
  const execute = vi.fn(async (_payload: Record<string, unknown>) => evidence);
  const commands = new MemoryCommandBridge();
  const request = testRequestContext(api({createAgentQueryContext: async () => ({conversation_id: "sample-conversation"}), analysisExecute: execute}), commands,
    {originalMessage: "最近盈利怎么样", answerEvidence: async () => [{ref: "e1", evidence}]});
  const frame = {fields: {plan: {resolvedValue: plan}, time: {resolvedValue: {date_selection: "latest_snapshot"}}}} as unknown as BusinessFrame;
  const result = await runTool(createGeneralAnalysisTool(frame), {}, request);
  expect(execute.mock.calls[0]?.[0]).toMatchObject({plan, date_selection: "latest_snapshot", anchor_date: "2026-08-27",
    conversation_id: "sample-conversation", calculation_context: {scope_id: "op-1", user_question: "最近盈利怎么样"}});
  expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("start");
  expect(result.details).toMatchObject({answer_policy: "general_analysis_evidence_v1"});
});

it.each(["ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_REFERENCE", "ANALYSIS_REPORT_COVERAGE"])("报告必须引用本轮回执；单次文案失败直接保留正式事实（%s）", async errorCode => {
  const report = vi.fn(async (input: {fallback?: boolean}) => {
    if (!input.fallback) throw new BackendApiError(422, "请引用事实", errorCode);
    return {kind: "business_report", status: "succeeded", public_answer: "已核验事实与缺口", tasks: [], org_codes: ["3200"]};
  });
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence}]});
  const tool = createAnalysisReportTool();
  const input = {evidence_refs: ["e1"], summary: "错误数字", sections: []};
  expect((await runTool(tool, {...input, evidence_refs: ["e99"]}, request)).details.status).toBe("ARGUMENT_ERROR");
  expect(report).not.toHaveBeenCalled();
  const result = await runTool(tool, input, request);
  expect(result.terminate).toBe(true);
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({run_refs: ["analysis:sample"], fallback: true, summary: "错误数字", sections: []});
});

it("多方面问题预算随正式主题和子问题增加，恢复后仍保留且有上限", () => {
  const request = testRequestContext(api({}), new MemoryCommandBridge());
  expect(analysisBudget(request)).toMatchObject({discovery: 4, executions: 3, tools: 24});
  catalogBindingView(request, {items: ["a", "b"].map((topic, i) => ({code: topic, name: "隔离指标", binding_ref: `signed-${i}`,
    analysis_hint: {topic, topic_name: topic, section: "scale", metric_id: "total", default_sections: ["scale", "structure"]}}))});
  expect(analysisBudget(request)).toMatchObject({discovery: 6, executions: 4});
  const recovered = testRequestContext(api({}), new MemoryCommandBridge());
  restoreAnalysisDiscovery(recovered, [{kind: "analysis_catalog", status: "succeeded", candidate_map: analysisCandidates(request)}]);
  expect(analysisBudget(recovered)).toEqual(analysisBudget(request));
  registerAnalysisPlan(recovered, {...plan, requirements: Array.from({length: 8}, (_, i) => ({id: `q${i}`, question: `子问题${i}`}))});
  expect(analysisBudget(recovered)).toEqual({discovery: 10, executions: 6, tools: 36});
});

it("目录覆盖方向不强制补齐，不把未选的探索方向标记成用户问题缺口", async () => {
  const report = vi.fn(async () => ({kind: "business_report", status: "succeeded", public_answer: "已核验现状", report: {summary: "现状", sections: []}}));
  const request = testRequestContext(api({analysisReport: report}), new MemoryCommandBridge(),
    {originalMessage: "最近经营情况怎么样", answerEvidence: async () => [{ref: "e1", evidence: {...evidence, metric_descriptors: [{code: "total", binding_ref: "signed-total"}]}}]});
  catalogBindingView(request, {items: ["total", "a", "b"].map((code, i) => ({code, name: `隔离${code}`, binding_ref: `signed-${code}`,
    analysis_hint: {topic: "sample", topic_name: "隔离主题", metric_id: code, section: i ? "structure" : "scale", default_sections: ["scale", "structure"]}}))});
  const result = await runTool(createAnalysisReportTool(), {evidence_refs: ["e1"], summary: "现状", sections: []}, request);
  expect(result.terminate).toBe(true);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({planning_gaps: []}), expect.anything());
  request.originalMessage = "这个指标值是多少";
  expect(analysisCoverageReview(request, [])).toEqual([]);
});

it("相同空指标计划只复用回执，不重复实际查询；不同日期仍可查询", async () => {
  const execute = vi.fn(async (_payload: Record<string, unknown>) => evidence);
  const prior = {...evidence, date_selection: "latest_snapshot", requested_start: null, requested_end: null,
    plan: {...plan, steps: [{...plan.steps[0]!, comparisons: [], top_n: 10, position: "top" as const, relation_id: undefined}]}};
  const request = testRequestContext(api({analysisExecute: execute}), new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence: prior}]});
  const frame = {fields: {plan: {resolvedValue: plan}, organizations: {resolvedValue: {codes: ["3200"]}}}} as unknown as BusinessFrame;
  await request.commands.setConversationId("isolated-conversation");
  expect((await runTool(createGeneralAnalysisTool(frame), {}, request)).details).toMatchObject({status: "succeeded", reused: true, evidence_ref: "e1"});
  expect(execute).not.toHaveBeenCalled();
  frame.fields.time = {resolvedValue: {start: "2026-07-31", end: "2026-07-31"}} as unknown as BusinessFrame["fields"][string];
  await runTool(createGeneralAnalysisTool(frame), {}, request);
  expect(execute).toHaveBeenCalledOnce();
});

it("复合简称拆为存款贷款分别发现，不能只召回存贷款利息收入", async () => {
  const search = vi.fn(async (_keyword: string) => ({items: []}));
  const request = testRequestContext(api({analysisMethods: async () => ({}), analysisCatalog: search}), new MemoryCommandBridge());
  await runTool(createAnalysisCatalogTool(), {keywords: ["存贷款", "利润"]}, request);
  expect(search.mock.calls.map(call => call[0])).toEqual(["存款", "贷款", "利润"]);
});

it("回读同一运行不重复消耗补查次数，新增主题使用原检查日而非利润旧观测日", async () => {
  const execute = vi.fn(async (_payload: Record<string, unknown>) => evidence);
  const prior = {...evidence, checked_on: "2026-10-15", analysis_date: "2026-07-31"};
  const request = testRequestContext(api({analysisExecute: execute}), new MemoryCommandBridge(),
    {answerEvidence: async () => ["e1", "e2", "e3"].map(ref => ({ref, evidence: prior}))});
  await request.commands.setConversationId("isolated-conversation");
  const frame = {fields: {plan: {resolvedValue: plan}}} as unknown as BusinessFrame;
  await runTool(createGeneralAnalysisTool(frame), {}, request);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]?.[0]).toMatchObject({anchor_date: "2026-10-15"});
});
