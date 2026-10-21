import {expect, it, vi} from "vitest";
import type {BackendClient} from "../backendClient.js";
import {BackendApiError} from "../backendClient.js";
import {createPartialAnalysisTool} from "./partialAnalysis.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "./testUtils.js";
import type {OverviewEvidence} from "./businessReport.js";
import {authorizeHistory} from "../routes.js";
import type {ProjectedMessage} from "../sessionProjection.js";

const source = (topic: "loan" | "deposit", org = "O1"): OverviewEvidence => ({kind: "business_overview", status: "succeeded",
  topic, analysis_date: "2026-08-27", requested_date: "2026-10-15", org_codes: [org], org_name: `隔离${org}`, basis: "合成口径",
  tasks: [{task_id: `${org}-${topic}`, status: "succeeded"}], gaps: [], table_columns: [],
  table_rows: [{metric_id: "total", 指标: topic === "loan" ? "各项贷款" : "各项存款", 当前值: "120亿元"}],
  plan: {metric_ids: ["total"]}, followup_candidates: [{parent: "total", metric_ids: ["consumer"], comparisons: [], reason: "尚待核查组成"}],
  evidence_items: [{ref: "total.current", display: "120亿元", label: "余额"}]});

it("部分交付保留不同主题各自的日期口径、表格与补查缺口，不作合并计算", async () => {
  const getTask = vi.fn(async (_id: string) => ({}));
  const backend = {resolveBusinessField: vi.fn(async (_entity, codes) => ({status: "resolved", value: {codes}})), getTask} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [
    {ref: "e1", evidence: source("loan")}, {ref: "e2", evidence: {...source("deposit"), analysis_date: "2026-08-26"}},
  ]});
  const result = await runTool(createPartialAnalysisTool(), {reason: "corrections_exhausted"}, request);
  expect(result.terminate).toBe(true);
  expect(result.details).toMatchObject({status: "succeeded", partial_analysis: true, row_count: 2});
  expect(result.details.public_answer).toContain("120亿元");
  expect(result.details.public_answer).toContain("后续补查未完成");
  expect(result.details.gaps.join("；")).toContain("尚未完成补查");
  expect(result.details.report.presentation).toMatchObject({version: 1, body_mode: "narrative"});
  expect(result.details.rows.map((row: {stat_date: string}) => row.stat_date)).toEqual(["2026-08-27", "2026-08-26"]);
  expect(getTask.mock.calls.map(call => call[0])).toEqual(["O1-loan", "O1-deposit"]);
  expect(result.details.org_codes).toEqual(["O1"]);
  const historyBackend = {getTask: vi.fn(async (id: string) => ({task_id: id, status: "SUCCEEDED"})),
    resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: ["O1"]}}))} as unknown as BackendClient;
  const message = {role: "tool", tool: "analysis_partial_present", details: result.details,
    timestamp: 1, entry_id: "partial"} as ProjectedMessage;
  await expect(authorizeHistory([message], historyBackend)).resolves.toBeUndefined();
  historyBackend.resolveBusinessField = vi.fn(async () => {throw new BackendApiError(403, "失权", "DENIED");});
  await expect(authorizeHistory([message], historyBackend)).rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
});

it.each(["corrections_exhausted", "model_failure", "tool_budget", "action_incomplete"])("%s后仍交付预先核验的判断与可见事实", async reason => {
  const data = source("deposit");
  data.evidence_items.push({ref: "finding.test", label: "已核验判断", type: "observation",
    judgment_kind: "comparison_direction", display: "同口径正式比较显示增减分化。", input_refs: ["total.current"]});
  const backend = {resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O1"]}}),
    getTask: async () => ({})} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence: data}]});
  const result = await runTool(createPartialAnalysisTool(), {reason}, request);
  expect(result.details).toMatchObject({status: "succeeded", partial_analysis: true, fallback_reason: reason});
  expect(result.details.report.summary).toContain("同口径正式比较显示增减分化");
  expect(result.details.report.summary).toContain("120亿元");
  expect(result.details.public_answer).toBe(result.details.report.summary);
  expect(result.details.source_reports[0].report.body_evidence[0].evidence_refs).toContain("total.current");
});

it.each(["organization", "task", "general"])("重新授权失败不得交付任何数值：%s", async stage => {
  const denied = new BackendApiError(403, "无权限", "FORBIDDEN");
  const backend = {resolveBusinessField: async () => {if (stage === "organization") throw denied; return {status: "resolved", value: {codes: ["O1"]}};},
    getTask: async () => {throw denied;}, analysisReport: async () => {throw denied;}} as unknown as BackendClient;
  const evidence = stage === "general" ? {kind: "analysis_evidence", status: "succeeded", run_ref: "signed-sample"} : source("loan");
  const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence}]});
  await expect(runTool(createPartialAnalysisTool(), {reason: "tool_budget"}, request)).rejects.toBe(denied);
});

it("没有当前回合证据不能交付历史或模型猜测数值", async () => {
  const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {answerEvidence: async () => []});
  const result = await runTool(createPartialAnalysisTool(), {reason: "action_incomplete"}, request);
  expect(result.details.status).toBe("failed");
  expect(result.details.rows).toBeUndefined();
});
