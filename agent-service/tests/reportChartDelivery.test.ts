import {describe, expect, it, vi} from "vitest";
import type {BackendClient} from "../src/backendClient.js";
import {createInquiryReportTool} from "../src/inquiry/reportTool.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

// 仅验证报告交付边界的隔离事实，不用于真实业务实测。
function harness(repaired = false) {
  const evidence = {kind: "analysis_evidence", status: "succeeded", run_ref: "run-1", execution_turn_id: "op-1",
    metric_descriptors: ["M1", "M2"].map(code => ({code, name: code, unit: "元", value_basis: "current"})),
    evidence_items: ["M1", "M2"].flatMap((code, metric) => ["甲行", "乙行", "丙行"].map((name, org) => ({
      ref: `r.f${metric * 3 + org + 1}`, type: "fact", metric_code: code, metric_name: code,
      org_code: `O${org}`, org_name: name, date: "2026-08-27", unit: "元", value: String(org - 5), display: `${org - 5}元`,
    })))};
  const actualRefs = repaired ? ["r.f4", "r.f5", "r.f6"] : ["r.f1", "r.f2", "r.f3"];
  const analysisReport = vi.fn(async () => ({kind: "business_report", status: "succeeded", narrative_repaired: repaired,
    public_answer: "已核验正文", gaps: [], report: {summary: "已核验正文", sections: [],
      body_evidence: [{paragraph: 1, evidence_refs: actualRefs}]}}));
  const queryMetric = vi.fn(), analysisExecute = vi.fn();
  const backend = {analysisReport, queryMetric, analysisExecute} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {
    originalMessage: "各机构经营情况如何", answerEvidence: async () => [{ref: "e1", evidence}],
  });
  return {request, analysisReport, queryMetric, analysisExecute};
}

describe("分析正文与图表一起交付", () => {
  it("未选图时按已核验正文引用配一张图，沿用正文顺序且不重新取数", async () => {
    const test = harness();
    const result = await runTool(createInquiryReportTool(), {body: "丙行{{e1.v3}}、甲行{{e1.v1}}、乙行{{e1.v2}}。"}, test.request);
    expect(result).toMatchObject({terminate: true, details: {status: "succeeded", public_answer: "已核验正文",
      report: {charts: [{type: "bar", source_refs: ["r.f3", "r.f1", "r.f2"],
        points: [{name: "丙行"}, {name: "甲行"}, {name: "乙行"}]}]}}});
    expect(test.analysisReport).toHaveBeenCalledOnce();
    expect(test.queryMetric).not.toHaveBeenCalled();
    expect(test.analysisExecute).not.toHaveBeenCalled();
  });

  it("正文恢复后只使用最终正文证据，不用失败草稿选图", async () => {
    const test = harness(true);
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}、丙行{{e1.v3}}。"}, test.request);
    expect(result).toMatchObject({details: {report: {charts: [{source_refs: ["r.f4", "r.f5", "r.f6"]}]}}});
  });

  it("正文重建后不展示失去正文依据的显式选点", async () => {
    const test = harness(true);
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}、乙行{{e1.v2}}、丙行{{e1.v3}}。",
      chart: {type: "bar", evidence_refs: ["e1.v1", "e1.v2", "e1.v3"]}}, test.request);
    expect(result).toMatchObject({details: {report: {charts: []}, partial_analysis: true}});
    expect(result.details.public_answer).toContain("所选图表与本次回答的数据范围或指标口径不一致");
    expect(test.queryMetric).not.toHaveBeenCalled();
    expect(test.analysisExecute).not.toHaveBeenCalled();
  });

  it("正文只有一个值时不借用其他明细凑图", async () => {
    const test = harness();
    test.analysisReport.mockResolvedValueOnce({kind: "business_report", status: "succeeded", narrative_repaired: false,
      public_answer: "甲行-5元", gaps: [], report: {summary: "甲行-5元", sections: [],
        body_evidence: [{paragraph: 1, evidence_refs: ["r.f1"]}]}});
    const result = await runTool(createInquiryReportTool(), {body: "甲行{{e1.v1}}。"}, test.request);
    expect((result.details as {report: {charts?: unknown[]}}).report.charts ?? []).toEqual([]);
  });
});
