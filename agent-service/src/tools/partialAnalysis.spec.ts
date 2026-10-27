import {expect, it, vi} from "vitest";
import type {BackendClient} from "../backendClient.js";
import {BackendApiError} from "../backendClient.js";
import {createPartialAnalysisTool} from "./partialAnalysis.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "./testUtils.js";
import type {OverviewEvidence} from "./businessReport.js";
import {authorizeHistory} from "../routes.js";
import type {ProjectedMessage} from "../sessionProjection.js";
import {createAnalysisReportTool} from "../analysis/tools.js";

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
  expect(result.details.public_answer).not.toMatch(/后续补查未完成|部分解释尚缺少充分依据/);
  expect(result.details.report.summary).toContain("2026-08-27");
  expect(result.details.report.summary).toContain("2026-08-26");
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
  expect(result.details.public_answer).toBe(`${result.details.report.presentation.scope}\n\n${result.details.report.summary}`);
  expect(result.details.report.summary).not.toContain("截至2026-08-27");
  expect(result.details.public_answer.match(/2026-08-27/gu)).toHaveLength(1);
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

it("独立来源暂时不可重新核验时仍交付其它来源，不能混入失败来源的行和引用", async () => {
  const analysisReport = vi.fn(async (payload: Record<string, unknown>) => {
    if ((payload.run_refs as string[])[0] === "unavailable") throw new BackendApiError(503, "暂时不可用", "SERVICE_UNAVAILABLE");
    return {kind: "business_report", status: "succeeded", public_answer: "合成已核验利润", rows: [{value: "15亿元"}],
      columns: ["value"], org_codes: ["O1"], tasks: [{task_id: "verified"}], gaps: [],
      report: {summary: "合成已核验利润15亿元", sections: [], presentation: {scope: "隔离范围"}}};
  });
  const request = testRequestContext({analysisReport} as unknown as BackendClient, new MemoryCommandBridge(),
    {answerEvidence: async () => ["unavailable", "available"].map((run_ref, index) => ({ref: `e${index + 1}`,
      evidence: {kind: "analysis_evidence", status: "succeeded", run_ref}}))});
  const result = await runTool(createPartialAnalysisTool(), {reason: "model_failure"}, request);
  expect(result.details).toMatchObject({status: "succeeded", row_count: 1, org_codes: ["O1"],
    report: {evidence_refs: ["e2"]}, tasks: [{task_id: "verified"}]});
  expect(result.details.public_answer).toContain("15亿元");
  expect(result.details.gaps.join("；")).toContain("一部分分析来源暂时无法重新核验");
  expect(analysisReport.mock.calls.every(([payload]) => payload.retain_valid === true)).toBe(true);
});

it.each([403, 422, 500])("独立来源返回权限、范围冲突或未知异常时不能当暂时故障忽略：%s", async status => {
  const denied = new BackendApiError(status, "不允许展示", status === 403 ? "FORBIDDEN" : "ANALYSIS_REPORT_SCOPE");
  const analysisReport = vi.fn(async (payload: Record<string, unknown>) => {
    if ((payload.run_refs as string[])[0] === "denied") throw denied;
    return {kind: "business_report", status: "succeeded", public_answer: "隔离事实15亿元", rows: [], columns: [],
      org_codes: ["O1"], tasks: [], gaps: []};
  });
  const request = testRequestContext({analysisReport} as unknown as BackendClient, new MemoryCommandBridge(),
    {answerEvidence: async () => ["available", "denied"].map((run_ref, index) => ({ref: `e${index + 1}`,
      evidence: {kind: "analysis_evidence", status: "succeeded", run_ref}}))});
  const result = runTool(createPartialAnalysisTool(), {reason: "model_failure"}, request);
  if (status === 403) await expect(result).rejects.toBe(denied);
  else {
    const receipt = await result;
    expect(receipt.details.status).toBe("failed");
    expect(receipt.details.public_answer).not.toContain("15亿元");
  }
});

it("追问报告失败后沿用已绑定指标和正文逐段复核，不重新展开旧经营主题", async () => {
  const analysisReport = vi.fn(async (payload: Record<string, unknown>) => {
    if (!payload.fallback) throw new BackendApiError(422, "文案需修正", "ANALYSIS_REPORT_NUMBER");
    return {kind: "business_report", status: "succeeded", public_answer: "合成利润事实", rows: []};
  });
  const evidence = {kind: "analysis_evidence", status: "succeeded", run_ref: "old-analysis", execution_turn_id: "previous",
    evidence_items: [{ref: "old.profit", type: "fact", display: "合成利润"}], metric_descriptors: [],
    plan: {requirements: [], steps: []}};
  const request = testRequestContext({analysisReport} as unknown as BackendClient, new MemoryCommandBridge(),
    {answerEvidence: async () => [{ref: "e1", evidence}]});
  await runTool(createAnalysisReportTool(), {evidence_refs: ["e1"], body: "利润{{e1.v1}}。"}, request);
  const result = await runTool(createPartialAnalysisTool(), {reason: "tool_budget"}, request);
  expect(result.terminate).toBe(true);
  expect(result.details).toMatchObject({partial_analysis: true, public_answer: "合成利润事实"});
  expect(analysisReport).toHaveBeenLastCalledWith(expect.objectContaining({run_refs: ["old-analysis"], context_run_refs: ["old-analysis"],
    focus_refs: ["old.profit"], fallback: true, summary: "利润{{old.profit}}。"}), expect.anything());
  // 同一轮重复读取同一历史运行，不应失去已经确定的追问范围。
  request.answerEvidence = async () => [{ref: "e1", evidence}, {ref: "e2", evidence}];
  expect((await runTool(createPartialAnalysisTool(), {reason: "model_failure"}, request)).details.public_answer).toBe("合成利润事实");
  expect(analysisReport.mock.calls.at(-1)?.[0]).toMatchObject({focus_refs: ["old.profit"], fallback: true});
});
