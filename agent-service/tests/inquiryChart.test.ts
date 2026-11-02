import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {describe, expect, it, vi} from "vitest";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {createInquiryChartTool} from "../src/inquiry/chartTool.js";
import {createInquiryReportTool} from "../src/inquiry/reportTool.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

function fixture() {
  const evidence = {kind: "analysis_evidence", status: "succeeded", run_ref: "run", scope_id: "op-1", execution_turn_id: "op-1",
    org_codes: ["A", "B", "C"], tasks: [], metric_descriptors: [{code: "P", name: "净利润较同期", unit: "元", value_basis: "yoy"}],
    evidence_items: ["甲行", "乙行", "丙行"].map((org, index) => ({
      ref: `run.f${index + 1}`, type: "fact", metric_code: "P", metric_name: "净利润较同期",
      org_code: ["A", "B", "C"][index]!, org_name: org, date: "2026-08-27", unit: "元",
      value: ["-5.00", "-3.25", "-1.00"][index]!, display: ["-5.00元", "-3.25元", "-1.00元"][index]!,
    }))};
  const messages: AgentMessage[] = [{role: "user", content: "各机构利润变化如何", timestamp: 0}];
  const analysisReport = vi.fn(async (_request: Parameters<BackendClient["analysisReport"]>[0]) => ({kind: "business_report", status: "succeeded", public_answer: "已核验正文", gaps: [],
    report: {summary: "已核验正文", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["run.f1", "run.f2", "run.f3"]}]}}));
  const analysisExecute = vi.fn(), queryMetric = vi.fn();
  const backend = {analysisReport, analysisExecute, queryMetric} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {originalMessage: "各机构利润变化如何",
    answerEvidence: async () => [{ref: "e1", evidence}], turnMessages: async () => messages});
  return {evidence, messages, request, analysisReport, analysisExecute, queryMetric};
}

async function prepareChart(test: ReturnType<typeof fixture>, refs = ["e1.v3", "e1.v1", "e1.v2"]) {
  const result = await runTool(createInquiryChartTool(), {type: "bar", evidence_refs: refs}, test.request);
  test.messages.push({role: "toolResult", toolName: "analysis_chart", toolCallId: `chart-${test.messages.length}`,
    content: result.content, details: result.details, isError: false, timestamp: 1});
  return result;
}

describe("普通调查图表选择", () => {
  it("只签发真实点的选择，保持顺序，不查询或把数值提前交付", async () => {
    const test = fixture(), result = await prepareChart(test);
    expect(result).toMatchObject({details: {kind: "inquiry_chart", status: "succeeded", run_refs: ["run"],
      selection: {type: "bar", evidence_refs: ["run.f3", "run.f1", "run.f2"]},
      source_refs: ["run.f3", "run.f1", "run.f2"]}});
    expect(result.terminate).not.toBe(true);
    expect(JSON.stringify(result.content)).not.toMatch(/-5|-3\.25|-1|元/);
    expect(result.details).not.toHaveProperty("points");
    expect(test.analysisReport).not.toHaveBeenCalled();
    expect(test.analysisExecute).not.toHaveBeenCalled();
    expect(test.queryMetric).not.toHaveBeenCalled();
  });

  it.each(["foreign.f1", "e99.v1"])("不接受当前来源之外的引用%s", async unknown => {
    const test = fixture();
    const result = await prepareChart(test, ["e1.v1", unknown]);
    expect(result).toMatchObject({details: {kind: "inquiry_chart", status: "ARGUMENT_ERROR", error_code: "ANALYSIS_CHART_REFERENCE"}});
    expect(result.details).not.toHaveProperty("selection");
  });

  it.each(["unit", "date"] as const)("不签发%s不一致的柱图", async field => {
    const test = fixture();
    test.evidence.evidence_items[1]![field] = field === "unit" ? "万元" : "2026-08-26";
    const result = await prepareChart(test);
    expect(result).toMatchObject({details: {kind: "inquiry_chart", status: "ARGUMENT_ERROR", error_code: "ANALYSIS_CHART_SELECTION"}});
    expect(result.details).not.toHaveProperty("selection");
  });

  it("失败来源不能签发图表", async () => {
    const test = fixture();
    test.evidence.status = "failed";
    const result = await prepareChart(test);
    expect(result.details.status).toBe("ARGUMENT_ERROR");
    expect(result.details).not.toHaveProperty("selection");
  });
});

describe("自然正文继承当前图表选择", () => {
  it("同时要求表格和柱图时，已准备的图表在正文交付时继续保留", async () => {
    const test = fixture();
    test.request.originalMessage = "请用表格和柱状图对比两家银行的存款余额";
    const prepared = await prepareChart(test, ["e1.v1", "e1.v2"]);
    expect(prepared.details.status).toBe("succeeded");
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}。"}, test.request);
    expect(result).toMatchObject({terminate: true, details: {report: {charts: [{type: "bar", source_refs: ["run.f1", "run.f2"]}]}}});
    expect(test.analysisExecute).not.toHaveBeenCalled();
  });
  it("成功图表在正文后端校验后按原始精度重新生成", async () => {
    const test = fixture();
    await prepareChart(test);
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}、丙行{{e1.v3}}。"}, test.request);
    expect(result).toMatchObject({terminate: true, details: {report: {charts: [{source_refs: ["run.f3", "run.f1", "run.f2"],
      points: [{name: "丙行", value: "-1.00"}, {name: "甲行", value: "-5.00"}, {name: "乙行", value: "-3.25"}]}]}}});
    expect(test.analysisReport).toHaveBeenCalledOnce();
    expect(test.analysisExecute).not.toHaveBeenCalled();
  });

  it("只采用当前轮最近成功选择，允许图点是正文依据的子集", async () => {
    const test = fixture();
    await prepareChart(test);
    await prepareChart(test, ["e1.v2", "e1.v1"]);
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}、丙行{{e1.v3}}。"}, test.request);
    expect(result.details.report.charts[0].source_refs).toEqual(["run.f2", "run.f1"]);
  });

  it("显式纠正选择优先于此前准备的图", async () => {
    const test = fixture();
    await prepareChart(test);
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}、丙行{{e1.v3}}。",
      chart: {type: "bar", evidence_refs: ["e1.v2", "e1.v3"]}}, test.request);
    expect(result.details.report.charts[0].source_refs).toEqual(["run.f2", "run.f3"]);
  });

  it("不继承上一轮图表，未选图时仍根据当前已核验正文自动配图", async () => {
    const test = fixture();
    await prepareChart(test);
    test.messages.push({role: "user", content: "重新查看利润变化", timestamp: 2});
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}、丙行{{e1.v3}}。"}, test.request);
    expect(result.details.report.charts[0].source_refs).toEqual(["run.f1", "run.f2", "run.f3"]);
  });

  it("正文只引用一家机构时仍可展示同指标同口径的多机构图", async () => {
    const test = fixture();
    await prepareChart(test);
    test.analysisReport.mockResolvedValueOnce({kind: "business_report", status: "succeeded", public_answer: "甲行已核验正文", gaps: [],
      report: {summary: "甲行已核验正文", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["run.f1"]}]}});
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}。"}, test.request);
    expect(result.details.report.charts[0].source_refs).toEqual(["run.f3", "run.f1", "run.f2"]);
  });

  it.each(["metric_code", "date", "unit"] as const)("正文的%s不同于原选图时不交付旧图，并准确说明", async field => {
    const test = fixture();
    await prepareChart(test);
    const extra = {...test.evidence.evidence_items[0]!, ref: "run.f4"};
    extra[field] = field === "metric_code" ? "LOAN" : field === "date" ? "2026-08-26" : "万元";
    test.evidence.evidence_items.push(extra);
    test.analysisReport.mockResolvedValueOnce({kind: "business_report", status: "succeeded", public_answer: "甲行已核验正文", gaps: [],
      report: {summary: "甲行已核验正文", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["run.f4"]}]}});
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v4}}。"}, test.request);
    expect(result.details.report.charts).toEqual([]);
    expect(result.details.public_answer).toContain("图表");
    expect(result.details.gaps).toHaveLength(1);
  });

  it("显式纠正选图也须与最终正文的指标和比较基期一致", async () => {
    const test = fixture();
    const other = {...test.evidence.evidence_items[0]!, ref: "run.f4", comparison: "mom"};
    test.evidence.evidence_items.push(other);
    test.analysisReport.mockResolvedValueOnce({kind: "business_report", status: "succeeded", public_answer: "甲行已核验正文", gaps: [],
      report: {summary: "甲行已核验正文", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["run.f4"]}]}});
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v4}}。",
      chart: {type: "bar", evidence_refs: ["e1.v1", "e1.v2"]}}, test.request);
    expect(result.details.report.charts).toEqual([]);
    expect(result.details.public_answer).toContain("图表");
  });

  it("此前图表的来源已不可用时不展示旧图，当前正文仍可交付", async () => {
    const test = fixture();
    await prepareChart(test);
    const other = {...test.evidence, run_ref: "other", evidence_items: test.evidence.evidence_items.map(atom => ({
      ...atom, ref: atom.ref.replace("run.", "other.")}))};
    test.request.answerEvidence = async () => [{ref: "e2", evidence: other}];
    test.analysisReport.mockResolvedValueOnce({kind: "business_report", status: "succeeded", public_answer: "甲行已核验正文", gaps: [],
      report: {summary: "甲行已核验正文", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["other.f1"]}]}});
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e2.v1}}。"}, test.request);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({run_refs: ["other"]});
    expect(result.details.report.charts).toEqual([]);
    expect(result.details.public_answer).toContain("图表");
  });

  it("图表独有来源也纳入最终报告的后端鉴权，不要求逐点重复正文", async () => {
    const test = fixture();
    const other = {...test.evidence, run_ref: "other", evidence_items: test.evidence.evidence_items.map(atom => ({
      ...atom, ref: atom.ref.replace("run.", "other.")}))};
    test.request.answerEvidence = async () => [{ref: "e1", evidence: test.evidence}, {ref: "e2", evidence: other}];
    await prepareChart(test, ["e2.v3", "e2.v1", "e2.v2"]);
    test.analysisReport.mockResolvedValueOnce({kind: "business_report", status: "succeeded", public_answer: "甲行已核验正文", gaps: [],
      report: {summary: "甲行已核验正文", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["run.f1"]}]}});
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}。"}, test.request);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({run_refs: ["run", "other"]});
    expect(result.details.report.charts[0].source_refs).toEqual(["other.f3", "other.f1", "other.f2"]);
  });

  it("正文全无数值依据时不展示此前准备的图", async () => {
    const test = fixture();
    await prepareChart(test);
    test.analysisReport.mockResolvedValueOnce({kind: "business_report", status: "succeeded", public_answer: "暂无所需数据", gaps: [],
      report: {summary: "暂无所需数据", sections: [], body_evidence: []}});
    const result = await runTool(createInquiryReportTool(), {body: "暂无所需数据。"}, test.request);
    expect(result.details.report.charts).toEqual([]);
    expect(result.details.public_answer).toContain("图表");
  });

  it("图表准备后来源被撤权仍由最终后端校验阻断", async () => {
    const test = fixture();
    await prepareChart(test);
    const forbidden = new BackendApiError(403, "无权读取来源", "ANALYSIS_FORBIDDEN");
    test.analysisReport.mockRejectedValueOnce(forbidden);
    await expect(runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}。"}, test.request)).rejects.toBe(forbidden);
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });
});
