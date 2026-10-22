import {afterEach, expect, it, vi} from "vitest";
import {createAnalysisRepairTool, createSemanticResolveTool, createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {analysisRecoveryPhase, pendingAnalysisRecovery} from "../../src/semantic-task/analysisRecovery.js";
import {catalogBindingView} from "../../src/analysis/bindings.js";
import {analysisPlanDiagnostics, type AnalysisPlan} from "../../src/analysis/contracts.js";
import {semanticPublicAnswer} from "../../src/semantic-task/feedback.js";
import {runTool} from "../../src/tools/testUtils.js";
import {fixture} from "./fixtures.js";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {readFileSync} from "node:fs";
import {Compile} from "typebox/compile";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeSemanticTaskStore} from "../../src/semantic-task/store.js";
import {NativeFrameStore, NativeBusinessResultStore} from "../../src/business-context/store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
const step = (id: string, ref: string, question: string): AnalysisPlan["steps"][number] => ({id, method: "observe",
  metric_refs: [ref], answers: [question], rationale: "读取正式指标回答原子问题"});
const plan = (): AnalysisPlan => ({objective: "判断合成机构的经营表现", scope_notice: "隔离合成数据",
  requirements: ["loan", "deposit", "profit", "quality"].map(id => ({id, question: `合成${id}情况如何`})),
  steps: [step("loan_read", "k1", "loan"), step("profit_read", "k1", "profit"), step("quality_read", "k1", "quality")]});
const input = (value = plan()) => ({protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
  operations: [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2025年末"}],
  analysis: {kind: "business_analysis", plan: value}}]});
async function setup(value = plan()) {
  const f = await fixture(); cleanup.push(f.close);
  const request = f.request("analysis-repair", "合成机构甲2025年末经营情况如何");
  catalogBindingView(request, [{code: "M1", name: "合成指标甲", binding_ref: "signed-1"}, {code: "M2", name: "合成指标乙", binding_ref: "signed-2"}]);
  const backend = Object.assign(f.backend, {analysisValidate: vi.fn(async () => ({valid: true})),
    analysisExecute: vi.fn(async () => ({kind: "analysis_evidence", status: "succeeded", run_ref: "synthetic-run", scope_id: request.operationId,
      org_codes: ["O1"], tasks: [], rows: [], gaps: [], evidence_items: [], metric_descriptors: []}))});
  const first = await runTool(createSemanticResolveTool(), input(value), request);
  const recovery = first.details.analysis_recovery!;
  const patch = (steps = [step("deposit_read", "k2", "deposit")]) => ({task_ref: recovery.task_ref,
    target_ref: recovery.target_ref, revision: recovery.revision, steps});
  return {f, request, backend, first, patch};
}
it("实际四目标三步骤漏项形成结构化恢复，局部补齐后保留原范围和三项正确步骤", async () => {
  const {request, first, patch, backend} = await setup();
  expect(first.details).toMatchObject({status: "needs_interpretation", analysis_recovery: {attempt: 0,
    diagnostics: [{code: "REQUIREMENT_UNCOVERED", requirement_ids: ["deposit"], step_ids: [], next_action: "discover_metrics"}],
    retained_step_ids: ["loan_read", "profit_read", "quality_read"]}});
  expect(backend.analysisExecute).not.toHaveBeenCalled();
  const validator = Compile(JSON.parse(readFileSync(new URL("../../../docs/pi-semantic-task/feedback.schema.json", import.meta.url), "utf8")));
  expect(validator.Check(first.details), JSON.stringify([...validator.Errors(first.details)])).toBe(true);
  const result = await runTool(createAnalysisRepairTool(), patch(), request);
  expect(result.details.status, JSON.stringify(result.details)).toBe("ready");
  const saved = (await request.semanticTasks!.plan(result.details.state.task_ref!))!;
  const task = (await request.semanticTasks!.get(saved.steps[0]!.taskRef!))!;
  expect(task.target.fields.organizations?.resolvedValue).toMatchObject({codes: ["O1"]});
  expect(task.target.fields.time?.resolvedValue).toMatchObject({start: "2025-12-31", end: "2025-12-31"});
  const merged = task.target.fields.plan?.resolvedValue as AnalysisPlan;
  expect(merged.requirements).toEqual(plan().requirements);
  expect(merged.steps.map(item => item.id)).toEqual(["loan_read", "profit_read", "quality_read", "deposit_read"]);
  expect(merged.steps.slice(0, 3).map(item => item.metric_refs)).toEqual([["signed-1"], ["signed-1"], ["signed-1"]]);
  const executed = await runTool(createSemanticExecuteTool(), {task_ref: result.details.state.task_ref, target_ref: result.details.state.targets[0]!.target_ref}, request);
  expect(executed.details.status).toBe("succeeded"); expect(backend.analysisExecute).toHaveBeenCalledTimes(1);
});
it("错误目标或过期版本不执行且同样消耗有限修复预算", async () => {
  const {request, patch, backend} = await setup();
  const first = await runTool(createAnalysisRepairTool(), {...patch(), revision: -1 + patch().revision}, request);
  expect(first.details).toMatchObject({analysis_recovery: {attempt: 1}, issues: [{code: "ANALYSIS_REPAIR_REFERENCE_INVALID"}]});
  const second = await runTool(createAnalysisRepairTool(), {...patch(), task_ref: "foreign-plan"}, request);
  expect(second.details).toMatchObject({status: "ready", analysis_recovery_partial: {unresolved_requirement_ids: ["deposit"]}});
  expect(backend.analysisValidate).toHaveBeenCalledTimes(1);
});
it("原生Session重开后仍保留修复计数和原计划引用", async () => {
  const {request, patch, f, first} = await setup();
  await runTool(createAnalysisRepairTool(), patch([]), request);
  await f.sessions.close();
  const sessions = new NativeSessionStore(f.dir), session = await sessions.open("user-1", f.session.metadata);
  cleanup.unshift(async () => sessions.close());
  const reopened = {...request, frames: new NativeFrameStore(session), businessResults: new NativeBusinessResultStore(session), semanticTasks: new NativeSemanticTaskStore(session)};
  catalogBindingView(reopened, [{code: "M1", name: "合成指标甲", binding_ref: "signed-1"}, {code: "M2", name: "合成指标乙", binding_ref: "signed-2"}]);
  expect((await pendingAnalysisRecovery(reopened))?.analysis_recovery).toMatchObject({attempt: 1, task_ref: first.details.state.task_ref});
  const last = await runTool(createAnalysisRepairTool(), patch([]), reopened);
  expect(last.details.status).toBe("ready");
  expect(last.details.analysis_recovery_partial).toBeDefined();
  expect((await reopened.semanticTasks!.turn(reopened.operationId))?.analysisRecovery?.attempts).toBe(2);
});
it("原样重交与试图修改机构日期均不覆盖原计划，只返回待完成的恢复任务", async () => {
  const {request, first, backend} = await setup();
  const retry = input(); retry.targets[0]!.operations[0]!.value = "合成机构乙";
  const next = await runTool(createSemanticResolveTool(), retry, request);
  expect(next.details.analysis_recovery).toEqual(first.details.analysis_recovery);
  expect(backend.analysisValidate).not.toHaveBeenCalled();
  expect(await pendingAnalysisRecovery(request)).toHaveProperty("analysis_recovery");
});
it("不能通过补丁覆盖正确步骤、删除问题或把缺失要求关联到无效引用", async () => {
  const {request, patch, backend} = await setup();
  const first = await runTool(createAnalysisRepairTool(), patch([step("loan_read", "k2", "deposit")]), request);
  expect(first.details).toMatchObject({status: "needs_interpretation", analysis_recovery: {attempt: 1}});
  const last = await runTool(createAnalysisRepairTool(), patch([step("deposit_read", "k999", "deposit")]), request);
  expect(last.details.status).toBe("ready"); expect(last.details.analysis_recovery).toBeUndefined();
  expect(last.details.analysis_recovery_partial).toEqual({unresolved_requirement_ids: ["deposit"]});
  expect(backend.analysisValidate).toHaveBeenCalledTimes(1); expect(backend.analysisExecute).not.toHaveBeenCalled();
  expect((await request.semanticTasks!.turn(request.operationId))?.analysisRecovery).toMatchObject({attempts: 2, active: false});
});
it("没有任何可验证的独立步骤时明确系统修复失败，不捏造数据也不要求用户重新澄清", async () => {
  const value = plan(); value.steps = [];
  const {request, patch, backend} = await setup(value);
  await runTool(createAnalysisRepairTool(), patch([]), request);
  const last = await runTool(createAnalysisRepairTool(), patch([]), request);
  expect(last.details.status).toBe("failed");
  expect(backend.analysisExecute).not.toHaveBeenCalled();
  expect(semanticPublicAnswer(last.details)).toContain("分析查询计划未能自动修复");
  expect(semanticPublicAnswer(last.details)).not.toContain("继续说明希望查看的范围");
});
it("局部交付剔除错误步骤及所有依赖后继，只执行可独立验证的分支", async () => {
  const value = plan();
  value.steps[0]!.metric_refs = ["k999"];
  value.steps[1]!.depends_on = ["loan_read"];
  value.steps[2]!.depends_on = ["profit_read"];
  value.steps.push(step("deposit_read", "k2", "deposit"));
  const {request, patch, backend} = await setup(value);
  await runTool(createAnalysisRepairTool(), patch([]), request);
  const last = await runTool(createAnalysisRepairTool(), patch([]), request);
  expect(last.details).toMatchObject({status: "ready", analysis_recovery_partial: {unresolved_requirement_ids: ["loan", "profit", "quality"]}});
  const saved = (await request.semanticTasks!.plan(last.details.state.task_ref!))!;
  const task = (await request.semanticTasks!.get(saved.steps[0]!.taskRef!))!;
  expect((task.target.fields.plan?.resolvedValue as AnalysisPlan).steps.map(item => item.id)).toEqual(["deposit_read"]);
  expect(backend.analysisExecute).not.toHaveBeenCalled();
});
it("一次错误补丁之后可修复，不因相同初始根因而提前停止", async () => {
  const {request, patch} = await setup();
  expect((await runTool(createAnalysisRepairTool(), patch([]), request)).details.analysis_recovery?.attempt).toBe(1);
  expect((await runTool(createAnalysisRepairTool(), patch(), request)).details.status).toBe("ready");
});
it("错误引用和循环依赖产生各自结构化诊断，恢复入口不依赖中文报错解析", async () => {
  expect(analysisPlanDiagnostics({...plan(), steps: [{...plan().steps[0]!, depends_on: ["loan_read"]}]}))
    .toContainEqual(expect.objectContaining({code: "STEP_INVALID", step_ids: ["loan_read"]}));
  const value = plan(); value.steps[0]!.metric_refs = ["k999"];
  const {first} = await setup(value);
  expect(first.details.analysis_recovery?.diagnostics).toContainEqual(expect.objectContaining({code: "BINDING_INVALID", step_ids: ["loan_read"]}));
});
it("恢复阶段按正式回执切换目录到补丁，读取失败不冒充目录无记录", async () => {
  const {first} = await setup();
  const result = {role: "toolResult", toolCallId: "resolve", toolName: "resolve_business_turn", details: first.details,
    content: [], isError: false, timestamp: Date.now()} as AgentMessage;
  const catalog = (status: string) => ({role: "toolResult", toolCallId: "catalog", toolName: "analysis_catalog", details: {status, keywords: ["deposit"]},
    content: [], isError: false, timestamp: Date.now()}) as AgentMessage;
  expect(analysisRecoveryPhase([result])?.tool).toBe("analysis_catalog");
  expect(analysisRecoveryPhase([result, catalog("error")])?.tool).toBe("analysis_catalog");
  expect(analysisRecoveryPhase([result, catalog("succeeded")])?.tool).toBe("analysis_plan_repair");
});
