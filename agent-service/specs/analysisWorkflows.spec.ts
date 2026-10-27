import {afterEach, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {Compile} from "typebox/compile";
import {BackendApiError} from "../src/backendClient.js";
import {bindWorkflowScopeOperations, compactWorkflowEvidence, materializeWorkflowProposal, workflowDebugTrace, workflowPublicParameters, workflowRoute} from "../src/analysis/workflows.js";
import {analysisEvidenceAliases} from "../src/analysis/verifiedFindings.js";
import {projectSemanticFeedback} from "../src/semantic-task/modelView.js";
import type {AnalysisPlan} from "../src/analysis/contracts.js";
import {semanticParameters, prepareSemanticArguments} from "../src/semantic-task/protocol.js";
import {createSemanticResolveTool, createSemanticExecuteTool} from "../src/semantic-task/tools.js";
import {runTool} from "../src/tools/testUtils.js";
import {fixture} from "./semantic-task/fixtures.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
const plan: AnalysisPlan = {workflow_id: "profitability_ranking_v1", objective: "净利润排名及解释",
  scope_notice: "合成隔离范围", requirements: [{id: "rank", question: "净利润排名"}, {id: "why", question: "收入变化"}],
  steps: [{id: "rank", method: "ranking", metric_refs: ["signed-M1"], answers: ["rank"], position: "bottom", top_n: 1, rationale: "比较"},
    {id: "supplement", method: "observe", metric_refs: ["signed-M2"], answers: ["why"], depends_on: ["rank"],
      organization_from_step: "rank", rationale: "只补查排名入选机构"}]};
const route = {status: "matched" as const, workflow_id: "profitability_ranking_v1" as const, plan,
  metrics: [{code: "M1", name: "合成指标甲", binding_ref: "signed-M1"}, {code: "M2", name: "合成指标乙", binding_ref: "signed-M2"}]};
const input = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
  operations: [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2025年末"}],
  analysis: {kind: "registered_workflow", workflow_id: "profitability_ranking_v1"}}]};
async function setup() {
  const f = await fixture(); closes.push(f.close);
  const backend = Object.assign(f.backend, {analysisWorkflowRoute: vi.fn(async () => structuredClone(route)),
    analysisValidate: vi.fn(async () => ({valid: true})),
    analysisExecute: vi.fn(async (_payload: Record<string, unknown>) => ({kind: "analysis_evidence", status: "succeeded", run_ref: "isolated-run", scope_id: "isolated",
      rows: [], tasks: [], org_codes: ["O1"], evidence_items: [], metric_descriptors: [], complete: false,
      workflow_brief: {outcome: "no_data", focus_refs: [], selected_org_codes: []}}))});
  return {...f, backend};
}

it("召回只执行一次，注册路线由服务端计划展开，机构日期仍走原语义校验", async () => {
  const f = await setup(), request = f.request("workflow", "合成机构甲2025年末哪个机构净利润最低？为什么？");
  expect(await workflowRoute(request)).toMatchObject({status: "matched"});
  const expanded = await materializeWorkflowProposal(input, request);
  expect(prepareSemanticArguments(expanded).targets[0]?.analysis).toEqual({kind: "business_analysis", plan});
  expect(f.backend.analysisWorkflowRoute).toHaveBeenCalledTimes(1);
  const result = await runTool(createSemanticResolveTool(), input, request);
  expect(result.details.status, JSON.stringify(result.details)).toBe("ready");
  const executed = await runTool(createSemanticExecuteTool(), {task_ref: result.details.state.task_ref,
    target_ref: result.details.state.targets[0]!.target_ref}, request);
  expect(executed.details.status, JSON.stringify(executed.details)).toBe("succeeded");
  const payload = f.backend.analysisExecute.mock.calls[0]![0];
  expect(payload.plan).toEqual(plan);
  expect(payload.org_codes).toEqual(["O1"]);
});

it("未匹配的普通提案保留通用处理，不能伪造注册计划或追加模型步骤", async () => {
  const f = await setup(), request = f.request("fallback", "贷款情况如何");
  expect(await workflowRoute(request)).toMatchObject({status: "fallback"});
  const ordinary = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"}, analysis: {kind: "business_analysis", plan}}]};
  expect(await materializeWorkflowProposal(ordinary, request)).toEqual(ordinary);
  expect(await materializeWorkflowProposal(input, request)).toEqual(input);
  const matched = f.request("tamper", "哪家机构利润最低");
  const tampered = structuredClone(input) as any;
  tampered.targets[0].analysis.plan = {steps: ["untrusted"]};
  expect(await materializeWorkflowProposal(tampered, matched)).toEqual(tampered);
  const rewritten = await materializeWorkflowProposal(ordinary, matched) as typeof ordinary;
  expect(rewritten.targets[0]?.analysis).toEqual({kind: "business_analysis", plan});
});

it("注册路线按服务端原文集合绑定机构，模型漏填或误填默认机构不能缩小比较范围", async () => {
  const f = await setup();
  f.backend.analysisWorkflowRoute.mockResolvedValueOnce({...route,
    admission: {organization_expression: "各家农商行"}} as typeof route);
  const question = f.request("scope", "各家农商行近期哪个机构净利润最低？为什么？");
  const expanded = await materializeWorkflowProposal(input, question) as typeof input;
  expect(expanded.targets[0]?.operations.filter(op => op.field === "organizations"))
    .toEqual([{action: "set", field: "organizations", value: "各家农商行"}]);
});

it("召回不可用会交给通用框架，权限拒绝保持拒绝", async () => {
  const f = await setup();
  f.backend.analysisWorkflowRoute.mockRejectedValueOnce(new BackendApiError(503, "unavailable", "UNAVAILABLE"));
  expect(await workflowRoute(f.request("unavailable", "哪家净利润最低"))).toMatchObject({status: "fallback"});
  f.backend.analysisWorkflowRoute.mockRejectedValueOnce(new BackendApiError(403, "forbidden", "FORBIDDEN"));
  await expect(workflowRoute(f.request("denied", "哪家净利润最低"))).rejects.toMatchObject({status: 403});
});

it("仅采用后端按正式目录家数核验的数字集合，不把任意数量自动当全体", async () => {
  const f = await setup();
  f.backend.analysisWorkflowRoute.mockResolvedValueOnce({...route,
    admission: {organization_expression: "61家机构", expected_org_count: 61, numbered_cohort: true}} as typeof route);
  const request = f.request("counted", "61家机构哪个近期净利润最差");
  const expanded = prepareSemanticArguments(await materializeWorkflowProposal(input, request));
  const operations = await bindWorkflowScopeOperations(expanded.targets[0]!.operations, request);
  expect(operations.find(op => op.field === "organizations")).toEqual({
    action: "set", field: "organizations", value: "61家机构",
    organizationScope: {kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "61家机构"},
  });
  f.backend.analysisWorkflowRoute.mockResolvedValueOnce({...route,
    admission: {organization_expression: "20家机构", expected_org_count: 20}} as typeof route);
  const unverified = await materializeWorkflowProposal(input, f.request("unverified-count", "20家机构哪个净利润最差")) as any;
  expect(unverified.targets[0].operations[0]).toEqual(input.targets[0]!.operations[0]);
});

it("仅在匹配时暴露注册入口，不修改原始通用协议", () => {
  const original = JSON.stringify(semanticParameters);
  expect(JSON.stringify(workflowPublicParameters(semanticParameters, route))).toContain("registered_workflow");
  expect(JSON.stringify(workflowPublicParameters(semanticParameters, {status: "fallback"}))).not.toContain("registered_workflow");
  expect(JSON.stringify(semanticParameters)).toBe(original);
});

it("模型只读取选中机构的精简包，完整参与集和证据不变", () => {
  const evidence = {workflow_brief: {focus_refs: ["rank", "f1"], selected_org_codes: ["A"]},
    rows: [{org_code: "A"}, {org_code: "B"}], org_codes: ["A", "B"],
    evidence_items: [{ref: "f1", type: "fact", org_code: "A", display: "1亿元"},
      {ref: "f2", type: "fact", org_code: "B", display: "2亿元"},
      {ref: "rank", type: "observation", judgment_kind: "ranking", input_refs: ["f1", "f2"]}]};
  const before = JSON.stringify(evidence);
  const view = compactWorkflowEvidence(evidence, analysisEvidenceAliases("e1", evidence.evidence_items));
  expect((view.evidence_items as any[]).map(item => item.ref)).toEqual(["e1.v1", "e1.j1"]);
  expect(JSON.stringify(view)).not.toContain("2亿元");
  expect(JSON.stringify(evidence)).toBe(before);
});

it("调试路线绑定注册计划及实际步骤，无数据与失败分开，未命中不伪造路线", () => {
  expect(workflowDebugTrace({status: "fallback"}, undefined, "ready")).toBeUndefined();
  const planned = workflowDebugTrace(route, undefined, "needs_user")!;
  expect(planned.phase).toBe("awaiting_input");
  expect(planned.steps[0]).toMatchObject({id: "rank", status: "not_started", metrics: [{code: "M1", name: "合成指标甲"}]});
  expect(JSON.stringify(planned)).not.toContain("signed-M1");
  const result = {kind: "analysis_evidence", plan, run_ref: "run-debug", date_selection: "exact",
    requested_start: "2026-08-31", requested_end: "2026-08-31", actual_dates: [],
    workflow_brief: {outcome: "no_data", coverage: {requested_org_count: 20, valid_org_count: 0}},
    workflow_execution: {steps: [{id: "rank", status: "no_data", fact_count: 0}, {id: "supplement", status: "skipped_no_data"}]}};
  const before = JSON.stringify(result);
  const trace = workflowDebugTrace(route, {kind: "semantic_results", results: [result, {kind: "business_report"}]}, "succeeded")!;
  expect(trace).toMatchObject({phase: "executed", outcome: "no_data", run_ref: "run-debug",
    date_policy: {mode: "exact", requested_end: "2026-08-31"}});
  expect(trace.steps.map(step => step.status)).toEqual(["no_data", "skipped_no_data"]);
  expect(JSON.stringify(result)).toBe(before);
  const schema = JSON.parse(readFileSync(new URL("../../docs/pi-semantic-task/feedback.schema.json", import.meta.url), "utf8"));
  const validator = Compile(schema.properties.workflow_trace);
  expect(validator.Check(trace), JSON.stringify([...validator.Errors(trace)])).toBe(true);
});

it("调试记录不重复送入模型上下文，原始持久化回执仍保留", () => {
  const trace = workflowDebugTrace(route, undefined, "invalid_input");
  const receipt = {protocol_version: 2, state: {}, workflow_trace: trace};
  const view = projectSemanticFeedback(receipt);
  expect(view).not.toHaveProperty("workflow_trace");
  expect(receipt.workflow_trace?.phase).toBe("blocked");
});

it("真实语义回执投影采用经重算核对的路线正文，不重新带回完整计划和参与集", () => {
  const full: Record<string, any> = {kind: "analysis_evidence", status: "succeeded", answer_policy: "general_analysis_evidence_v1",
    plan, org_codes: ["A", "B"], org_names: ["机构甲", "机构乙"], observations: [{internal: "full"}],
    workflow_brief: {focus_refs: ["f1", "rank"], selected_org_codes: ["A"],
      ranking: [{ref: "rank", org_code: "A", fact_refs: ["f1"], comparison_fact_refs: ["f1", "f2"]}]},
    rows: [{org_code: "A"}, {org_code: "B"}],
    evidence_items: [{ref: "f1", type: "fact", org_code: "A", display: "1亿元"},
      {ref: "f2", type: "fact", org_code: "B", display: "2亿元"},
      {ref: "rank", type: "observation", judgment_kind: "ranking", input_refs: ["f1", "f2"]}], gaps: []};
  const body = JSON.parse(JSON.stringify({...full, rows: undefined,
    ...compactWorkflowEvidence(full, analysisEvidenceAliases("e1", full.evidence_items)), evidence_ref: "e1"}));
  full.payloads = [body];
  const receipt = {protocol_version: 2, state: {evidence: full}}, before = JSON.stringify(receipt);
  const view = (projectSemanticFeedback(receipt) as typeof receipt).state.evidence;
  expect(view).not.toHaveProperty("plan");
  expect(view).not.toHaveProperty("org_codes");
  expect(JSON.stringify(view)).not.toContain("2亿元");
  expect(view.workflow_brief.ranking[0]).toEqual({ref: "e1.j1", org_code: "A"});
  expect(JSON.stringify(receipt)).toBe(before);
  full.payloads[0].evidence_items[0].display = "伪造值";
  expect((projectSemanticFeedback(receipt) as typeof receipt).state.evidence).toHaveProperty("plan", plan);
});
