import {afterEach, expect, it, vi} from "vitest";
import {BackendApiError} from "../../src/backendClient.js";
import {catalogBindingView} from "../../src/analysis/bindings.js";
import {completeExplicitMetricCoverage} from "../../src/analysis/metricCoverage.js";
import {organizationScopeInput} from "../../src/business-context/organizationScope.js";
import type {AnalysisPlan} from "../../src/analysis/contracts.js";
import {analysisRecoveryPhase} from "../../src/semantic-task/analysisRecovery.js";
import {createAnalysisRepairTool, createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import {fixture} from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
const metric = (code: string, name: string) => ({code, name, binding_ref: `signed-${code}`});
const step = (id: string, ref: string, answers = ["q1"]): AnalysisPlan["steps"][number] =>
  ({id, method: "observe", metric_refs: [ref], answers, rationale: "隔离样本读取正式指标"});
const plan = (steps = [step("read", "k1")]): AnalysisPlan => ({objective: "查询指标", scope_notice: "隔离合成范围",
  requirements: [{id: "q1", question: "合成指标甲是多少？"}], steps});
async function setup() {
  const f = await fixture(); cleanup.push(f.close);
  const backend = Object.assign(f.backend, {
    analysisValidate: vi.fn(async () => ({valid: true})),
    analysisExecute: vi.fn(async () => ({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
      run_ref: "isolated-run", scope_id: "isolated", org_codes: ["O1"], tasks: [], rows: [], gaps: [],
      evidence_items: [], metric_descriptors: [], complete: true})),
  });
  return {...f, backend};
}
const input = (value: AnalysisPlan, operations: unknown[] = [], source = {kind: "new"}) => ({protocol_version: 2,
  intent: "analyze", targets: [{source, operations, analysis: {kind: "business_analysis", plan: value}}]});

it.each(["各家农商行", "各个农商行", "全省各行"].flatMap(text => [2, 10, 20, 61].map(count => ({text, count}))))(
  "$text 的 $count 家集合在分析与基础查询中使用同一范围解析，不采纳单机构suggestion", async ({text, count}) => {
    const f = await setup();
    const value = {codes: Array.from({length: count}, (_, i) => `O${i + 1}`), names: Array.from({length: count}, (_, i) => `机构${i + 1}`),
      scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}, scope_fingerprint: "a".repeat(64)};
    const resolve = vi.fn(async () => ({status: "resolved", value}));
    Object.assign(f.backend, {resolveOrganizationScope: resolve});
    const originalResolve = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "organization"
      && args[1].every(code => value.codes.includes(code)) ? {status: "resolved", value: {codes: value.codes, names: value.names}}
      : originalResolve(...args));
    for (const intent of ["query", "analyze"] as const) {
      const request = f.request(`cohort-${intent}`, `${text}2025年末合成指标甲是多少？`);
      catalogBindingView(request, [metric("M1", "合成指标甲")]);
      const operations = [{action: "set", field: "organizations", value: text,
        suggestion: {code: "wrong-aggregate", name: "省级汇总"}}, {action: "set", field: "time", value: "2025年末"}];
      const result = await runTool(createSemanticResolveTool(), intent === "analyze" ? input(plan(), operations)
        : {protocol_version: 2, intent, targets: [{source: {kind: "new"}, operations: [...operations,
          {action: "set", field: "metrics", value: "合成指标甲"}]}]}, request);
      expect(result.details.status, JSON.stringify(result.details)).toBe("ready");
      const saved = (await request.semanticTasks!.plan(result.details.state.task_ref!))!;
      const task = (await request.semanticTasks!.get(saved.steps[0]!.taskRef!))!;
      expect(task.target.fields.organizations?.resolvedValue).toEqual(value);
      expect(resolve).toHaveBeenLastCalledWith({kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: text}, expect.anything());
      const executed = await runTool(createSemanticExecuteTool(), {task_ref: saved.ref, target_ref: saved.steps[0]!.targetRef}, request);
      expect(executed.details.status, JSON.stringify(executed.details)).toBe("succeeded");
    }
    expect(f.backend.analysisExecute).toHaveBeenCalledWith(expect.objectContaining({organization_scope: value.scope,
      scope_fingerprint: value.scope_fingerprint}), expect.any(String), expect.anything());
  });

it("遗漏已明确且已发现的两项指标时程序补齐，重复metrics参数不再阻断追问，机构日期沿用", async () => {
  const f = await setup(), firstRequest = f.request("first", "合成机构甲近期合成指标甲是多少？");
  catalogBindingView(firstRequest, [metric("M1", "合成指标甲")]);
  const first = await runTool(createSemanticResolveTool(), input(plan(), [{action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "time", value: "近期"}]), firstRequest);
  await runTool(createSemanticExecuteTool(), {task_ref: first.details.state.task_ref, target_ref: first.details.state.targets[0]!.target_ref}, firstRequest);
  const request = f.request("follow", "具体到合成指标乙和合成指标丙");
  catalogBindingView(request, [metric("M1", "合成指标甲"), metric("M2", "合成指标乙"), metric("M3", "合成指标丙")]);
  const value = {...plan(), requirements: [{id: "q1", question: "合成指标乙是多少？"}, {id: "q2", question: "合成指标丙是多少？"}],
    steps: [step("wrong_old_metric", "k1", ["q1", "q2"])]};
  const result = await runTool(createSemanticResolveTool(), input(value,
    [{action: "set", field: "metrics", value: "合成指标乙,合成指标丙"}], {kind: "current"}), request);
  expect(result.details.status, JSON.stringify(result.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.details.state.task_ref, target_ref: result.details.state.targets[0]!.target_ref}, request);
  expect(f.backend.analysisExecute).toHaveBeenLastCalledWith(expect.objectContaining({org_codes: ["O1"], date_selection: "latest_snapshot",
    plan: expect.objectContaining({steps: expect.arrayContaining([expect.objectContaining({metric_refs: ["signed-M2"], answers: ["q1"]}),
      expect.objectContaining({metric_refs: ["signed-M3"], answers: ["q2"]})])})}), expect.any(String), expect.anything());
});

it("明确指标尚未发现时发出定向发现与局部补丁任务，不重复原提案", async () => {
  const f = await setup(), request = f.request("missing", "合成机构甲2025年末合成指标乙是多少？");
  catalogBindingView(request, [metric("M1", "合成指标甲")]);
  const value = {...plan(), requirements: [{id: "q1", question: "合成指标乙是多少？"}]};
  const result = await runTool(createSemanticResolveTool(), input(value,
    [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2025年末"}]), request);
  expect(result.details.analysis_recovery, JSON.stringify(result.details)).toMatchObject({diagnostics: [{code: "EXPLICIT_METRIC_MISSING",
    missing_metrics: [{code: "M2", name: "合成指标乙"}], step_ids: ["read"]}], next_action: "discover_metrics"});
  const phase = analysisRecoveryPhase([{role: "toolResult", toolCallId: "test", toolName: "resolve_business_turn",
    content: [], details: result.details, isError: false, timestamp: Date.now()}]);
  expect(phase?.discovery.keywords).toEqual(["合成指标乙"]);
  catalogBindingView(request, [metric("M2", "合成指标乙")]);
  const recovery = result.details.analysis_recovery!;
  const repaired = await runTool(createAnalysisRepairTool(), {task_ref: recovery.task_ref, target_ref: recovery.target_ref,
    revision: recovery.revision, steps: [step("read", "k2")]}, request);
  expect(repaired.details.status, JSON.stringify(repaired.details)).toBe("ready");
  expect(f.backend.analysisValidate).toHaveBeenCalledTimes(1);
});

it("后端完整原文校验返回遗漏指标时保留结构化诊断，不降成固定失败文案", async () => {
  const f = await setup(), request = f.request("backend-missing", "合成机构甲经营情况如何？");
  catalogBindingView(request, [metric("M1", "合成指标甲")]);
  f.backend.analysisValidate.mockRejectedValueOnce(new BackendApiError(422, "计划遗漏指标", "ANALYSIS_EXPLICIT_METRIC_MISSING",
    {missing_metrics: [{code: "M2", name: "合成指标乙"}]}));
  const result = await runTool(createSemanticResolveTool(), input(plan(), [{action: "set", field: "organizations", value: "合成机构甲"}]), request);
  expect(result.details.analysis_recovery?.diagnostics, JSON.stringify(result.details)).toContainEqual(expect.objectContaining({code: "EXPLICIT_METRIC_MISSING",
    missing_metrics: [{code: "M2", name: "合成指标乙"}]}));
});

it("部分证据成功可以继续交付，但任务、计划及回放均不能冒充全部完成", async () => {
  const f = await setup(), request = f.request("partial", "合成机构甲2025年末合成指标甲是多少？");
  catalogBindingView(request, [metric("M1", "合成指标甲")]);
  f.backend.analysisExecute.mockResolvedValue({...await f.backend.analysisExecute(), complete: false});
  f.backend.analysisExecute.mockClear();
  const ready = await runTool(createSemanticResolveTool(), input(plan(), [{action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "time", value: "2025年末"}]), request);
  const result = await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state.task_ref, target_ref: ready.details.state.targets[0]!.target_ref}, request);
  expect(result.details).toMatchObject({status: "succeeded", state: {completion: "partial"}});
  const saved = (await request.semanticTasks!.plan(ready.details.state.task_ref!))!;
  expect(saved.completion).toBe("partial");
  expect((await request.semanticTasks!.get(saved.steps[0]!.taskRef!))?.completion).toBe("partial");
  const replay = await runTool(createSemanticResolveTool(), input(plan(), [{action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "time", value: "2025年末"}], {kind: "current"}), request);
  expect(replay.details.state.completion, JSON.stringify(replay.details)).toBe("partial");
});

it("补普通数值不能冒充完成排名方法，也不覆盖原计划", async () => {
  const f = await setup(), request = f.request("missing-ranking", "合成指标乙最低的是谁？");
  catalogBindingView(request, [metric("M1", "合成指标甲"), metric("M2", "合成指标乙")]);
  const value = {...plan(), requirements: [{id: "q1", question: "合成指标乙最低的是谁？"}],
    steps: [{...step("rank", "k1"), method: "ranking" as const, position: "bottom" as const, top_n: 1}]};
  const before = structuredClone(value);
  await expect(completeExplicitMetricCoverage(request, value)).rejects.toMatchObject({code: "ANALYSIS_EXPLICIT_METRIC_MISSING"});
  expect(value).toEqual(before);
});

it("机构集合保留排除限定交后端校验，明确单行及本行不转成全省集合", () => {
  expect(organizationScopeInput("各家农商行但不含合成机构乙")).toMatchObject({sourceText: "各家农商行但不含合成机构乙"});
  expect(organizationScopeInput("我行")).toBeUndefined();
  expect(organizationScopeInput("合成农商银行")).toBeUndefined();
  const scope = {kind: "children_of" as const, parentName: "合成机构甲", sourceText: "合成机构甲下辖机构"};
  expect(organizationScopeInput(scope)).toEqual(scope);
});

it("模型捏造集合来源不能触发范围解析或实际执行", async () => {
  const f = await setup(), request = f.request("forged-scope", "合成机构甲近期合成指标甲是多少？");
  const resolve = vi.fn(); Object.assign(f.backend, {resolveOrganizationScope: resolve});
  catalogBindingView(request, [metric("M1", "合成指标甲")]);
  const result = await runTool(createSemanticResolveTool(), input(plan(), [{action: "set", field: "organizations", value: "各家农商行",
    organizationScope: {kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "各家农商行"}}]), request);
  expect(result.details.status).not.toBe("ready");
  expect(resolve).not.toHaveBeenCalled();
  expect(f.backend.analysisExecute).not.toHaveBeenCalled();
});

it("来源合法但后端拒绝集合权限时不退回账号汇总查询", async () => {
  const f = await setup(), request = f.request("denied-scope", "各家农商行近期合成指标甲是多少？");
  const resolve = vi.fn(async () => ({status: "invalid", metadata: {reason: "forbidden"}}));
  Object.assign(f.backend, {resolveOrganizationScope: resolve});
  catalogBindingView(request, [metric("M1", "合成指标甲")]);
  const result = await runTool(createSemanticResolveTool(), input(plan(), [{action: "set", field: "organizations", value: "各家农商行"}]), request);
  expect(result.details.status).not.toBe("ready");
  expect(resolve).toHaveBeenCalled();
  expect(f.backend.analysisExecute).not.toHaveBeenCalled();
});

it("明确指标的局部修复耗尽后仍执行独立正确步骤，并将遗漏指标保留为缺口", async () => {
  const f = await setup(), request = f.request("remaining", "合成机构甲2025年末合成指标甲和合成指标乙是多少？");
  catalogBindingView(request, [metric("M1", "合成指标甲")]);
  const value = {...plan(), requirements: [{id: "q1", question: "合成指标甲是多少？"}, {id: "q2", question: "合成指标乙是多少？"}],
    steps: [step("correct", "k1"), step("wrong", "k1", ["q2"])]};
  let result = await runTool(createSemanticResolveTool(), input(value, [{action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "time", value: "2025年末"}]), request);
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovery = result.details.analysis_recovery!;
    expect(recovery, JSON.stringify(result.details)).toBeDefined();
    result = await runTool(createAnalysisRepairTool(), {task_ref: recovery.task_ref, target_ref: recovery.target_ref,
      revision: recovery.revision, steps: [step("wrong", "k999", ["q2"])]}, request);
  }
  expect(result.details).toMatchObject({status: "ready", analysis_recovery_partial: {unresolved_requirement_ids: ["q2"]}});
  await runTool(createSemanticExecuteTool(), {task_ref: result.details.state.task_ref, target_ref: result.details.state.targets[0]!.target_ref}, request);
  expect(f.backend.analysisExecute).toHaveBeenCalledWith(expect.objectContaining({plan: expect.objectContaining({
    steps: [expect.objectContaining({id: "correct"})], requirements: expect.arrayContaining([
      expect.objectContaining({id: "q2", gap_reason: expect.any(String)}),
    ]),
  })}), expect.any(String), expect.anything());
});
