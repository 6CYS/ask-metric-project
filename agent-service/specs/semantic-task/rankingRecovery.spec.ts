import {afterEach, expect, it, vi} from "vitest";
import {fixture} from "./fixtures.js";
import {runTool} from "../../src/tools/testUtils.js";
import {createSemanticResolveTool, createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {catalogBindingView} from "../../src/analysis/bindings.js";
import type {AnalysisPlan} from "../../src/analysis/contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
async function setup() {
  const f = await fixture(); cleanup.push(f.close);
  const original = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "date"
    ? args[1][0] === "近期" ? {status: "invalid", metadata: {reason: "unsupported_expression"}}
      : {status: "resolved", value: {start: "2026-08-01", end: "2026-08-31"}, metadata: {resolution_source: "model",
        source_calendar: {ranges: [{start: "2026-08-01", end: "2026-08-31"}], unresolved: []}}}
    : original(...args));
  const execute = vi.fn(async () => ({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
    run_ref: "synthetic-ranking", scope_id: "synthetic", org_codes: ["O1", "O2"], tasks: [], rows: [], evidence_items: [], metric_descriptors: []}));
  Object.assign(f.backend, {analysisValidate: vi.fn(async () => ({valid: true})), analysisExecute: execute});
  return {...f, execute};
}
const plan = (): AnalysisPlan => ({objective: "比较合成指标的最低机构", scope_notice: "隔离合成数据",
  requirements: [{id: "worst", question: "最低的是哪家？"}], steps: [{id: "rank", method: "ranking",
    metric_refs: ["k1"], position: "bottom", top_n: 1, answers: ["worst"], rationale: "按完整集合逐期排序"}]});
const basic = (expression: string, selection: string | null = "latest_in_range") => ({protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, query: {
  organizations: {kind: "named", names: ["合成机构甲", "合成机构乙"]}, metrics: ["合成指标甲"],
  time: {expression, calendar: {start: "2026-08-01", end: "2026-08-31"}}, selection,
  operation: {kind: "ranking", position: "bottom", top_n: 1}}}]});

it.each(["近期", "八月份整个月份"])("%s排名保留完整机构与方向条数，升级后使用正确日期策略", async expression => {
  const f = await setup(), request = f.request("ranking", `合成机构甲和合成机构乙${expression}合成指标甲哪个最低？`);
  const first = await runTool(createSemanticResolveTool(), basic(expression, expression === "近期" ? "latest_in_range" : "all_in_range"), request);
  expect(first.details, JSON.stringify(first.details)).toHaveProperty("query_recovery");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  catalogBindingView(request, {items: [{code: "M1", name: "合成指标甲", binding_ref: "signed"}]});
  const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    analysis: {kind: "business_analysis", plan: plan()}}]}, request);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state!.task_ref!, target_ref: ready.details.state!.targets[0]!.target_ref}, request);
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({org_codes: ["O1", "O2"],
    date_selection: expression === "近期" ? "latest_snapshot" : "all_in_range",
    ...(expression === "近期" ? {} : {start: "2026-08-01", end: "2026-08-31"}),
    plan: expect.objectContaining({steps: [expect.objectContaining({method: "ranking", position: "bottom", top_n: 1})]})}), expect.any(String), expect.anything());
});

it.each([{position: "top", top_n: 1}, {position: "bottom", top_n: 2}])("升级不能改变排名语义 %j", async replacement => {
  const f = await setup(), request = f.request("changed", "合成机构甲和合成机构乙近期合成指标甲哪个最低？");
  await runTool(createSemanticResolveTool(), basic("近期"), request);
  catalogBindingView(request, {items: [{code: "M1", name: "合成指标甲", binding_ref: "signed"}]});
  const changed = plan(); Object.assign(changed.steps[0]!, replacement);
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    analysis: {kind: "business_analysis", plan: changed}}]}, request);
  expect(JSON.stringify(result.details)).toContain("QUERY_RECOVERY_OPERATION_REQUIRED");
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(["count", "direction", "both"])("真实调用回放：分析计划遗漏%s时继承已冻结的排名条件", async omitted => {
  const f = await setup(), request = f.request("omitted-plan-ranking", "合成机构甲和合成机构乙近期合成指标甲哪个最低？");
  await runTool(createSemanticResolveTool(), basic("近期"), request);
  catalogBindingView(request, {items: [{code: "M1", name: "合成指标甲", binding_ref: "signed"}]});
  const incomplete = plan();
  if (omitted !== "direction") delete incomplete.steps[0]!.top_n;
  if (omitted !== "count") delete incomplete.steps[0]!.position;
  const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
    operations: [{action: "set", field: "organizations", value: "合成机构甲和合成机构乙"}, {action: "set", field: "time", value: "近期"}],
    analysis: {kind: "business_analysis", plan: incomplete}}]}, request);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state!.task_ref!, target_ref: ready.details.state!.targets[0]!.target_ref}, request);
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({org_codes: ["O1", "O2"], date_selection: "latest_snapshot",
    plan: expect.objectContaining({steps: [expect.objectContaining({method: "ranking", position: "bottom", top_n: 1})]})}), expect.any(String), expect.anything());
});

it("跨轮补充全部已有记录后进入逐期排名，不返回字段绑定或查询服务异常", async () => {
  const f = await setup();
  const first = await runTool(createSemanticResolveTool(), basic("八月份", null),
    f.request("first", "合成机构甲和合成机构乙八月份合成指标甲哪个最低？"));
  expect(first.details.status).toBe("needs_user");
  const reply = f.request("reply", "区间内全部已有记录");
  const resolved = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "query", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "selection", value: "all_in_range"}]}]}, reply);
  expect(resolved.details, JSON.stringify(resolved.details)).toMatchObject({status: "needs_interpretation", query_recovery: {original_goal: expect.any(String)}});
  catalogBindingView(reply, {items: [{code: "M1", name: "合成指标甲", binding_ref: "signed"}]});
  const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    analysis: {kind: "business_analysis", plan: plan()}}]}, reply);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
});

it("正式授权集合升级保留成员和指纹，不将集合原文重新匹配为默认机构", async () => {
  const f = await setup(), request = f.request("cohort", "61家机构近期合成指标甲哪个最低？");
  const scope = {kind: "authorized_cohort", cohort: "rural_commercial_banks"};
  Object.assign(f.backend, {resolveOrganizationScope: vi.fn(async () => ({status: "resolved", value: {
    codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"], scope, scope_fingerprint: "a".repeat(64)}}))});
  const input = basic("近期");
  const cohortInput = {...input, targets: [{...input.targets[0], query: {...input.targets[0]!.query,
    organizations: {kind: "authorized_cohort", cohort: "rural_commercial_banks", source_text: "61家机构"}}}]};
  const initial = await runTool(createSemanticResolveTool(), cohortInput, request);
  expect(initial.details, JSON.stringify(initial.details)).toHaveProperty("query_recovery");
  catalogBindingView(request, {items: [{code: "M1", name: "合成指标甲", binding_ref: "signed"}]});
  const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    analysis: {kind: "business_analysis", plan: plan()}}]}, request);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state!.task_ref!, target_ref: ready.details.state!.targets[0]!.target_ref}, request);
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({org_codes: [], organization_scope: scope,
    scope_fingerprint: "a".repeat(64), date_selection: "latest_snapshot"}), expect.any(String), expect.anything());
});

it.each(["各家农商行哪个近期净利润收入最差", "各家农商行近期净利润最低的是哪家？"])("%s：模型遗漏条数仍须恢复、执行并保留完整集合", async question => {
  const f = await setup(), request = f.request("implicit-single", question);
  const scope = {kind: "authorized_cohort", cohort: "rural_commercial_banks"};
  Object.assign(f.backend, {resolveOrganizationScope: vi.fn(async () => ({status: "resolved", value: {
    codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"], scope, scope_fingerprint: "a".repeat(64)}}))});
  const input = basic("近期");
  const initial = await runTool(createSemanticResolveTool(), {...input, targets: [{...input.targets[0], query: {...input.targets[0]!.query,
    organizations: {kind: "authorized_cohort", cohort: "rural_commercial_banks", source_text: "各家农商行"},
    metrics: ["净利润"], operation: {kind: "ranking", position: "bottom", top_n: null}}}]}, request);
  expect(initial.details, JSON.stringify(initial.details)).toHaveProperty("query_recovery");
  expect(initial.details.issues).not.toContainEqual(expect.objectContaining({code: "RANKING_NOT_DETERMINED"}));
  expect(initial.details.state.targets[0]!.conditions).toContainEqual(expect.objectContaining({field: "operation", display: "后1名"}));
  catalogBindingView(request, {items: [{code: "M1", name: "净利润金额当日数", binding_ref: "signed"}]});
  const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    analysis: {kind: "business_analysis", plan: plan()}}]}, request);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state!.task_ref!, target_ref: ready.details.state!.targets[0]!.target_ref}, request);
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({organization_scope: scope, date_selection: "latest_snapshot",
    plan: expect.objectContaining({steps: [expect.objectContaining({method: "ranking", position: "bottom", top_n: 1})]})}), expect.any(String), expect.anything());
});
