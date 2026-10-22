import {afterEach, expect, it, vi} from "vitest";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {prepareSemanticArguments, type EnhancedAnalysis, type SemanticOperation} from "../../src/semantic-task/protocol.js";
import {businessEvidences} from "../../src/answerEvidence.js";
import {catalogBindingView} from "../../src/analysis/bindings.js";
import {runTool} from "../../src/tools/testUtils.js";
import {fixture} from "./fixtures.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {analysisFollowupSource} from "../../src/analysis/inquiry.js";
import type {AnalysisPlan} from "../../src/analysis/contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
const overview: EnhancedAnalysis = {kind: "business_overview", plan: {topic: "loan", goal: "overview", sections: ["scale", "growth", "structure", "quality"]}};
function input(analysis = overview, source: {kind: "new" | "current"} = {kind: "new"}) {
  return prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [{source, analysis,
    operations: source.kind === "new" ? [{action: "set", field: "organizations", value: "合成机构甲"}] : []}]});
}
async function setup() {
  const f = await fixture(); cleanup.push(f.close);
  const backend = Object.assign(f.backend, {
    businessTopic: vi.fn(async () => ({version: "synthetic-v1", method: "business-overview-v1", metrics: [{id: "total"}]})),
    businessOverview: vi.fn(async () => ({kind: "business_overview", status: "succeeded", delivery: "business_evidence_v1",
      topic: "loan", public_answer: "隔离合成结果", org_codes: ["O1"], org_name: "合成机构甲", analysis_date: "2026-08-27",
      tasks: [], gaps: [], table_rows: [], complete: true})),
    analysisValidate: vi.fn(async () => ({valid: true})),
    analysisExecute: vi.fn(async () => ({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
      run_ref: "synthetic-run", scope_id: "synthetic-scope", org_codes: ["O1"], tasks: [], rows: [], gaps: [], evidence_items: [], metric_descriptors: []})),
  });
  return {...f, backend};
}

it.each(["analysis", "redundant", "query", "reference-query", "analysis-operation-only"])("最低后追问最高继承机构、日期和指标，提案方式=%s", async mode => {
  const f = await setup(), firstRequest = f.request("rank-bottom", "合成机构甲和合成机构乙近期合成指标甲最低的是哪家？");
  const rankPlan = (position: "top" | "bottom", top_n = 1): AnalysisPlan => ({objective: "比较合成指标极值",
    scope_notice: "隔离合成数据", requirements: [{id: "extreme", question: "哪家机构指标极值？"}],
    steps: [{id: "rank", method: "ranking", metric_refs: ["signed-ranking"], answers: ["extreme"],
      position, top_n, rationale: "完整集合比较"}]});
  f.backend.analysisExecute.mockResolvedValue({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
    run_ref: "synthetic-ranking", scope_id: "synthetic", org_codes: ["O1", "O2"], tasks: [], rows: [], gaps: [], evidence_items: [], metric_descriptors: []});
  const first = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
    operations: [{action: "set", field: "organizations", value: "合成机构甲和合成机构乙"}, {action: "set", field: "time", value: "近期"}],
    analysis: {kind: "business_analysis", plan: rankPlan("bottom")}}]}, firstRequest);
  expect(first.details.status, JSON.stringify(first.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: first.details.state.task_ref, target_ref: first.details.state.targets[0]!.target_ref}, firstRequest);
  const saved = await firstRequest.semanticTasks!.plan(first.details.state.task_ref!);
  for (const [index, position, top_n, question] of [
    [1, "top", 1, "那哪家农商行利润最高呢？"],
    [2, "bottom", 1, "那最低呢？"],
    [3, "top", 3, "那前三家呢？"],
  ] as const) {
    const request = f.request(`rank-follow-${index}`, question);
    const current = (await request.semanticTasks!.plan((await request.semanticTasks!.planIndex()).focus!))!;
    const source = mode === "reference-query" ? {kind: "reference", task_ref: current.ref, target_ref: current.steps[0]!.targetRef} : {kind: "current"};
    const isQuery = mode.endsWith("query");
    const operationOnly = isQuery || mode === "analysis-operation-only";
    const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: isQuery ? "query" : "analyze", targets: [{source,
      operations: mode === "redundant" || operationOnly ? [{action: "set", field: "operation", queryOperation: {kind: "ranking", position, top_n}}] : [],
      ...(operationOnly ? {} : {analysis: {kind: "business_analysis", plan: rankPlan(position, top_n)}})}]}, request);
    expect(ready.details.status, JSON.stringify(ready.details)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state.task_ref, target_ref: ready.details.state.targets[0]!.target_ref}, request);
    expect(f.backend.analysisExecute).toHaveBeenLastCalledWith(expect.objectContaining({org_codes: ["O1", "O2"],
      date_selection: "latest_snapshot", plan: expect.objectContaining({steps: [expect.objectContaining({metric_refs: ["signed-ranking"], position, top_n})]})}),
    expect.any(String), expect.anything());
  }
  expect(await firstRequest.semanticTasks!.plan(first.details.state.task_ref!)).toEqual(saved);
});
it.each(["missing", "conflict-direction", "conflict-count", "non-ranking", "duplicate"])("重复排名操作规范化并拒绝歧义：%s", async mode => {
  const f = await setup(), request = f.request("ranking-contract", "合成机构甲合成指标甲最高的是哪家？");
  const step: AnalysisPlan["steps"][number] = {id: "rank", method: mode === "non-ranking" ? "observe" : "ranking",
    metric_refs: ["signed-ranking"], answers: ["extreme"], rationale: "隔离合成排名契约",
    ...(mode === "missing" ? {} : {position: mode === "conflict-direction" ? "bottom" : "top", top_n: mode === "conflict-count" ? 2 : 1})};
  const operation = {action: "set", field: "operation",
    queryOperation: {kind: "ranking", position: "top", top_n: 1}} as const;
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
    operations: [{action: "set", field: "organizations", value: "合成机构甲"}, operation, ...(mode === "duplicate" ? [operation] : [])],
    analysis: {kind: "business_analysis", plan: {objective: "极值", scope_notice: "合成范围",
      requirements: [{id: "extreme", question: "最高机构"}], steps: [step]}}}]}, request);
  if (mode === "missing") {
    expect(result.details.status, JSON.stringify(result.details)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: result.details.state.task_ref,
      target_ref: result.details.state.targets[0]!.target_ref}, request);
    expect(f.backend.analysisExecute).toHaveBeenCalledWith(expect.objectContaining({plan: expect.objectContaining({
      steps: [expect.objectContaining({position: "top", top_n: 1})]})}), expect.any(String), expect.anything());
  } else {
    expect(result.details.status).toBe("needs_interpretation");
    expect(result.details.issues).toContainEqual(expect.objectContaining({code: mode === "duplicate"
      ? "FIELD_MULTIPLE_ASSIGNMENTS" : "ANALYSIS_RANKING_OPERATION_CONFLICT"}));
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  }
});
it("完整分析计划可省略空的范围变更，普通空目标与混用query仍拒绝", () => {
  const raw = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"}, analysis: overview}]};
  expect(prepareSemanticArguments(raw).targets[0]?.operations).toEqual([]);
  expect(() => prepareSemanticArguments({...raw, targets: [{source: {kind: "new"}}]})).toThrow();
  expect(() => prepareSemanticArguments({...raw, targets: [{...raw.targets[0], query: {}}]})).toThrow();
});
it("分析请求中的query:null明确表示未选查询分支，非空query与无分析的null仍拒绝", () => {
  const target = {source: {kind: "new"}, analysis: overview, query: null};
  expect(prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [target]}).targets[0])
    .toEqual({source: {kind: "new"}, analysis: overview, operations: []});
  expect(target).toHaveProperty("query", null);
  for (const value of [{}, "null", false, []])
    expect(() => prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [{...target, query: value}]})).toThrow();
  expect(() => prepareSemanticArguments({protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, query: null}]})).toThrow();
});
it("补查在执行前校验触发证据，不能引用目录或未来事实", async () => {
  const f = await setup(), request = f.request("inquiry", "合成机构甲最近贷款情况怎么样？");
  request.answerEvidence = async () => [{ref: "e1", evidence: {kind: "business_overview", status: "succeeded",
    execution_turn_id: request.operationId,
    evidence_items: [{ref: "personal.mom.difference", type: "fact", value: "-1", display: "合成差额"}]}}];
  const initial = await new SemanticPlanService(request).resolve(input());
  expect(initial.status).toBe("needs_interpretation");
  expect(JSON.stringify(initial)).toContain("缺少inquiry");
  expect(f.backend.businessOverview).not.toHaveBeenCalled();
  const withInquiry: EnhancedAnalysis = {...overview, plan: {...overview.plan, inquiry: {
    question: "分类变化是否与总量一致？", prior_judgment: "已有分类减少。", basis_refs: ["personal.mom.difference"],
    expected_change: "核对其他分类，限定总量变化判断。"}}};
  expect(prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"}, analysis: withInquiry}]})).toBeDefined();
  const result = await new SemanticPlanService(request).resolve(input(withInquiry));
  expect(result.status, JSON.stringify(result)).toBe("ready");
});
it.each([undefined, "previous-operation"])("回读历史分析不把新一轮首批取数误判为补查：%s", async executionTurn => {
  const f = await setup(), request = f.request("new-after-read", "合成机构甲最近贷款质量怎么样？");
  request.answerEvidence = async () => [{ref: "e1", evidence: {kind: "business_overview", status: "succeeded",
    ...(executionTurn ? {execution_turn_id: executionTurn} : {}),
    evidence_items: [{ref: "quality.current", type: "fact", value: "1", display: "历史合成证据"}]}}];
  const result = await new SemanticPlanService(request).resolve(input());
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref,
    target_ref: result.state.targets[0]!.target_ref}, request);
  expect(execution.details.status).toBe("succeeded");
  expect(businessEvidences(execution.details)).toContainEqual(expect.objectContaining({execution_turn_id: request.operationId}));
});
it("专项计划混入通用字段时精确提示删除scope_notice，不误报为另一个分析kind", async () => {
  const f = await setup(), request = f.request();
  const raw = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
    analysis: {...overview, plan: {...overview.plan, scope_notice: "private-invalid-input"}}}]};
  const result = await runTool(createSemanticResolveTool(), raw, request);
  expect(result.details.status).toBe("invalid_input");
  expect(result.details.issues).toEqual([expect.objectContaining({field: "/targets/0/analysis/plan",
    message: expect.stringContaining('删除未定义字段：["scope_notice"]')})]);
  expect(JSON.stringify(result)).not.toContain("private-invalid-input");
  expect(f.backend.businessOverview).not.toHaveBeenCalled();
  expect(() => prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"}, analysis: overview}]})).not.toThrow();
});
it("current混入引用字段时提示实际多余字段，未知kind与错误协议仍严格拒绝", () => {
  const raw = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current", task_ref: "private-id", target_ref: "private-id"}, analysis: overview}]};
  try {prepareSemanticArguments(raw); throw new Error("should reject");} catch (error) {
    expect((error as {problems: unknown}).problems).toEqual([expect.objectContaining({path: "/targets/0/source",
      rule: "additionalProperties", hint: expect.stringContaining("task_ref")})]);
  }
  expect(() => prepareSemanticArguments({...raw, protocol_version: "2", targets: [{source: {kind: "current"}, analysis: overview}]})).toThrow("SHAPE_INVALID");
  expect(() => prepareSemanticArguments({...raw, targets: [{source: {kind: "invented"}, analysis: overview}]})).toThrow("SHAPE_INVALID");
});
it("结构错误返回具体字段位置供模型修正，不回显原参数或执行查询", async () => {
  const f = await setup(), request = f.request();
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: "private-invalid-input"}, request);
  expect(result.details.status).toBe("invalid_input");
  expect(result.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({field: "/targets", code: "INPUT_SHAPE_INVALID"})]));
  expect(JSON.stringify(result)).not.toContain("private-invalid-input");
  expect(f.backend.businessOverview).not.toHaveBeenCalled();
});
it("专项分析经统一语义入口生成许可，执行后仍保留分析证据", async () => {
  const f = await setup(), request = f.request("overview", "合成机构甲最近贷款情况怎么样？");
  const result = await new SemanticPlanService(request).resolve(input());
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
  const task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  expect(task.capability).toBe("business_overview");
  expect(task.permit?.consumed).toBe(false);
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref,
    target_ref: result.state.targets[0]!.target_ref}, request);
  expect(execution.details.status, JSON.stringify(execution.details)).toBe("succeeded");
  expect(businessEvidences(execution.details).some(item => item.kind === "business_overview")).toBe(true);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("同轮由同一来源派生不同补查目标时执行身份独立，重放不会留下永久ready目标", async () => {
  const f = await setup(), request = f.request("multi-inquiry", "合成机构甲最近贷款情况怎么样？");
  const service = new SemanticPlanService(request);
  const first = await service.resolve(input());
  const source = {kind: "reference" as const, task_ref: first.state.task_ref!, target_ref: first.state.targets[0]!.target_ref};
  await runTool(createSemanticExecuteTool(), {task_ref: source.task_ref, target_ref: source.target_ref}, request);
  const followup = prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: ["growth", "quality"].map(section => ({
    source, operations: [{action: "set", field: "organizations", value: "合成机构甲"}],
    analysis: {...overview, plan: {...overview.plan, goal: section, sections: [section]}}}))});
  const ready = await service.resolve(followup);
  expect(ready.status, JSON.stringify(ready.issues)).toBe("ready");
  const plan = (await request.semanticTasks!.plan(ready.state.task_ref!))!;
  expect(plan.steps).toHaveLength(2);
  for (const field of ["operationId", "taskRef", "targetRef"] as const)
    expect(new Set(plan.steps.map(step => step[field])).size, field).toBe(2);
  for (const step of plan.steps) {
    const child = {...request, operationId: step.operationId,
      semanticStep: {planRef: plan.ref, rootOperationId: request.operationId, revision: plan.revision,
        kind: step.kind, analysis: true, multipleTargets: true}};
    expect(await analysisFollowupSource(child)).toEqual({kind: "reference", task_ref: plan.ref, target_ref: step.targetRef});
    expect(await analysisFollowupSource({...child, actor: {...child.actor, id: "other-owner"}})).toBeUndefined();
    const execution = await runTool(createSemanticExecuteTool(), {task_ref: plan.ref, target_ref: step.targetRef}, request);
    expect(execution.details.status).toBe(step === plan.steps.at(-1) ? "succeeded" : "ready");
  }
  expect(f.backend.businessOverview).toHaveBeenCalledTimes(3);
  const replay = await service.resolve(followup);
  expect(replay.status, JSON.stringify(replay.issues)).toBe("succeeded");
  expect(f.backend.businessOverview).toHaveBeenCalledTimes(3);
  expect((await request.semanticTasks!.plan(plan.ref))!.steps).toHaveLength(2);
});
it("未指定机构的分析将认证账户默认范围交后端处理，不解析空机构清单", async () => {
  const f = await setup(), request = f.request("default-scope", "最近贷款情况怎么样？");
  const result = await new SemanticPlanService(request).resolve(prepareSemanticArguments({protocol_version: 2,
    intent: "analyze", targets: [{source: {kind: "new"}, analysis: overview}]}));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref,
    target_ref: result.state.targets[0]!.target_ref}, request);
  expect(execution.details.status, JSON.stringify(execution.details)).toBe("succeeded");
  expect(f.backend.businessOverview).toHaveBeenCalledWith(expect.objectContaining({org_codes: []}), expect.any(String), expect.anything());
  expect(f.backend.resolveBusinessField.mock.calls.some(([entity, values]) => entity === "organization" && !values.length)).toBe(false);
});
it("语义入口将规范机构名绑定为原文正式身份后，分析适配不再误拒为模型补造编码", async () => {
  const f = await setup(), request = f.request("bound-scope", "合成机构甲最近贷款情况怎么样？");
  const result = await new SemanticPlanService(request).resolve(prepareSemanticArguments({protocol_version: 2,
    intent: "analyze", targets: [{source: {kind: "new"}, analysis: overview,
      operations: [{action: "set", field: "organizations", value: "合成机构甲总行",
        suggestion: {code: "O1", name: "合成机构甲总行", excerpt: "合成机构甲"}}]}]}));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref,
    target_ref: result.state.targets[0]!.target_ref}, request);
  expect(execution.details.status, JSON.stringify(execution.details)).toBe("succeeded");
  expect(f.backend.businessOverview).toHaveBeenCalledWith(expect.objectContaining({org_codes: ["O1"]}), expect.any(String), expect.anything());
  expect(f.backend.resolveBusinessField.mock.calls.some(([entity, raw]) => entity === "organization" && raw[0] === "O1")).toBe(true);
});
it.each([["O1"], ["O2", "O3"], ["O1", "O1"]])("正式机构绑定不允许缩小、替换或重复身份：%j", async (...codes) => {
  const schema = createCapabilities().get("business_overview").fields.organizations!;
  const resolveCatalog = vi.fn();
  await expect(createFieldResolvers().getResolver(schema).resolve(codes, schema, {originalMessage: "两家合成机构",
    currentDate: "2026-10-19", turnId: "bound-test", boundOrganizationCodes: ["O1", "O2"], resolveCatalog}))
    .rejects.toMatchObject({code: "FIELD_INPUT_NOT_CURRENT"});
  expect(resolveCatalog).not.toHaveBeenCalled();
});
it("完整的正式绑定仍需目录权限复核，不把已识别编码当成执行授权", async () => {
  const schema = createCapabilities().get("business_overview").fields.organizations!;
  const resolveCatalog = vi.fn(async () => {throw new Error("SCOPE_CHANGED");});
  await expect(createFieldResolvers().getResolver(schema).resolve(["O1"], schema, {originalMessage: "合成机构甲",
    currentDate: "2026-10-19", turnId: "bound-auth", boundOrganizationCodes: ["O1"], resolveCatalog}))
    .rejects.toThrow("SCOPE_CHANGED");
  expect(resolveCatalog).toHaveBeenCalledWith("organization", ["O1"]);
});
it("原文机构已被正式绑定时，模型省略范围操作也不能改用账号默认机构", async () => {
  const f = await setup(), request = f.request("explicit-scope", "合成机构乙最近贷款情况怎么样？");
  const result = await new SemanticPlanService(request).resolve(prepareSemanticArguments({protocol_version: 2,
    intent: "analyze", targets: [{source: {kind: "new"}, analysis: overview}]}));
  expect(result.status).toBe("needs_interpretation");
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({code: "ANALYSIS_EXPLICIT_ORGANIZATION_REQUIRED"})]));
  expect(f.backend.businessOverview).not.toHaveBeenCalled();
  const corrected = await new SemanticPlanService(request).resolve(prepareSemanticArguments({protocol_version: 2,
    intent: "analyze", targets: [{source: {kind: "new"}, analysis: overview,
      operations: [{action: "set", field: "organizations", value: "合成机构乙"}]}]}));
  expect(corrected.status, JSON.stringify(corrected.issues)).toBe("ready");
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: corrected.state.task_ref,
    target_ref: corrected.state.targets[0]!.target_ref}, request);
  expect(execution.details.status, JSON.stringify(execution.details)).toBe("succeeded");
  expect(f.backend.businessOverview).toHaveBeenCalledWith(expect.objectContaining({org_codes: ["O2"]}), expect.any(String), expect.anything());
});
it("通用分析向语义子任务传递当前目录短引用，并经后端验证", async () => {
  const f = await setup(), request = f.request("general", "合成机构甲最近盈利表现如何？");
  catalogBindingView(request, {items: [{code: "SYNTH_PROFIT", binding_ref: "signed-synthetic-profit"}]});
  const analysis: EnhancedAnalysis = {kind: "business_analysis", plan: {objective: "盈利分析", scope_notice: "隔离合成测试",
    requirements: [{id: "profit", question: "盈利表现"}], steps: [{id: "observe", method: "observe", metric_refs: ["k1"],
      answers: ["profit"], rationale: "先获取正式盈利指标"}]}};
  const result = await new SemanticPlanService(request).resolve(input(analysis));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
  const task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  expect(task.capability).toBe("business_analysis");
  expect(task.target.fields.plan?.resolvedValue).toMatchObject({steps: [{metric_refs: ["signed-synthetic-profit"]}]});
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref,
    target_ref: result.state.targets[0]!.target_ref}, request);
  expect(execution.details.status, JSON.stringify(execution.details)).toBe("succeeded");
  expect(businessEvidences(execution.details).some(item => item.kind === "analysis_evidence")).toBe(true);
  expect(f.backend.analysisExecute).toHaveBeenCalledWith(expect.objectContaining({plan: expect.objectContaining({
    steps: [expect.objectContaining({metric_refs: ["signed-synthetic-profit"]})],
  })}), expect.any(String), expect.anything());
});
it.each(["comma", "chinese-comma", "separate", "overlapping"])("多机构通用分析首次提案即可绑定并执行完整范围：%s", async mode => {
  const f = await setup(), request = f.request(`multi-${mode}`, "合成机构甲和合成机构乙最近经营情况如何？");
  catalogBindingView(request, {items: [{code: "SYNTH_PROFIT", binding_ref: "signed-synthetic-profit"}]});
  const analysis: EnhancedAnalysis = {kind: "business_analysis", plan: {objective: "多机构经营分析", scope_notice: "隔离合成测试",
    requirements: [{id: "profit", question: "两家机构的盈利表现"}], steps: [{id: "observe", method: "observe", metric_refs: ["k1"],
      answers: ["profit"], rationale: "分别获取两家机构的正式指标"}]}};
  const values = mode === "separate" ? ["合成机构甲", "合成机构乙"]
    : mode === "overlapping" ? ["合成机构甲,合成机构乙", "合成机构乙"]
    : [mode === "comma" ? "合成机构甲,合成机构乙" : "合成机构甲，合成机构乙"];
  const operations: SemanticOperation[] = values.map(value => ({action: "set", field: "organizations", value,
    suggestion: {code: "O1", name: "合成机构甲", excerpt: "合成机构甲"}}));
  const args = prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"}, analysis, operations}]});
  const before = structuredClone(args);
  const result = await new SemanticPlanService(request).resolve(args);
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  expect(args).toEqual(before);
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref,
    target_ref: result.state.targets[0]!.target_ref}, request);
  expect(execution.details.status, JSON.stringify(execution.details)).toBe("succeeded");
  expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
  expect(f.backend.analysisExecute).toHaveBeenCalledWith(expect.objectContaining({org_codes: ["O1", "O2"]}), expect.any(String), expect.anything());
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("未知目录短引用不能生成分析执行许可", async () => {
  const f = await setup(), request = f.request("invalid", "合成机构甲最近盈利表现如何？");
  const analysis: EnhancedAnalysis = {kind: "business_analysis", plan: {objective: "盈利分析", scope_notice: "隔离合成测试",
    requirements: [{id: "profit", question: "盈利表现"}], steps: [{id: "observe", method: "observe", metric_refs: ["k999"],
      answers: ["profit"], rationale: "先取数"}]}};
  const result = await new SemanticPlanService(request).resolve(input(analysis));
  expect(result.status).toBe("needs_interpretation");
  expect(JSON.stringify(result.issues)).toContain("ANALYSIS_BINDING_INVALID");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("贷款转存款的追问先拒绝new且保留原焦点，修正current后继承机构并派生新计划", async () => {
  const f = await setup(), firstRequest = f.request("loan-start", "合成机构甲最近贷款情况怎么样？");
  const first = await new SemanticPlanService(firstRequest).resolve(input());
  await runTool(createSemanticExecuteTool(), {task_ref: first.state.task_ref,
    target_ref: first.state.targets[0]!.target_ref}, firstRequest);
  const nextRequest = f.request("deposit-follow", "那存款呢？");
  const deposit: EnhancedAnalysis = {kind: "business_overview", plan: {topic: "deposit", goal: "overview", sections: ["scale", "growth", "structure"]}};
  await expect(new SemanticPlanService(nextRequest).resolve(prepareSemanticArguments({protocol_version: 2,
    intent: "analyze", targets: [{source: {kind: "new"}, analysis: deposit}]})))
    .rejects.toMatchObject({issue: {code: "ANALYSIS_CONTINUATION_SOURCE_REQUIRED"}});
  expect((await nextRequest.semanticTasks!.planIndex()).focus).toBe(first.state.task_ref);
  const next = await new SemanticPlanService(nextRequest).resolve(input(deposit, {kind: "current"}));
  expect(next.status, JSON.stringify(next.issues)).toBe("ready");
  expect(next.state.task_ref).not.toBe(first.state.task_ref);
  const execution = await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref,
    target_ref: next.state.targets[0]!.target_ref}, nextRequest);
  expect(execution.details.status, JSON.stringify(execution.details)).toBe("succeeded");
  expect(f.backend.businessOverview).toHaveBeenLastCalledWith(expect.objectContaining({topic: "deposit", org_codes: ["O1"]}), expect.any(String), expect.anything());
});
