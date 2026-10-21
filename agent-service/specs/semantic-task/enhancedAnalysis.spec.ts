import {afterEach, expect, it, vi} from "vitest";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {prepareSemanticArguments, type EnhancedAnalysis} from "../../src/semantic-task/protocol.js";
import {businessEvidences} from "../../src/answerEvidence.js";
import {catalogBindingView} from "../../src/analysis/bindings.js";
import {runTool} from "../../src/tools/testUtils.js";
import {fixture} from "./fixtures.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {analysisFollowupSource} from "../../src/analysis/inquiry.js";

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
