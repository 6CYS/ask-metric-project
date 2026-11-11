import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../src/backendClient.js";
import { createInquiryReportPreview, executeInquiryReport } from "../src/inquiry/reportTool.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";

// 隔离报告与计算回执边界，不作为运行时业务数据或真实问数验收。
const calculationRef = "calculation.calc.difference";
const body = "甲{{e1.v1}}，乙{{e1.v2}}，差额{{e2.v1}}。";
const answer = "甲12.5000元，乙8.0000元，差额4.5000元。";

function fixture(mode: "final" | "preview", extraRefs: string[] = []) {
  const source = {
    kind: "analysis_evidence",
    status: "succeeded",
    run_ref: "run",
    execution_turn_id: "op-1",
    metric_descriptors: [{ code: "M", name: "存款余额", unit: "元", value_basis: "current" }],
    evidence_items: ["A", "B"].map((org, index) => ({
      ref: `run.${org}`,
      type: "fact",
      metric_code: "M",
      metric_name: "存款余额",
      org_code: org,
      org_name: org,
      date: "2026-08-31",
      unit: "元",
      value: index ? "8.0000" : "12.5000",
      display: index ? "8.0000元" : "12.5000元",
    })),
  };
  const calculation = {
    kind: "metric_calculate",
    status: "succeeded",
    execution_turn_id: "op-1",
    calculation_ref: { task_id: "task", calculation_id: "calc" },
    run_refs: ["run"],
    inputs: {
      current: { task_id: "task", fact_id: "fact-A" },
      base: { task_id: "task", fact_id: "fact-B" },
    },
    limitations: [],
    evidence_items: [
      {
        ref: calculationRef,
        type: "calculation",
        name: "difference",
        value: "4.5000",
        unit: "元",
        display: "4.5000元",
        input_refs: ["run.A", "run.B"],
      },
    ],
  };
  const bodyEvidence = [
    { paragraph: 1, evidence_refs: ["run.A", "run.B", calculationRef, ...extraRefs] },
  ];
  const analysisReport = vi.fn<BackendClient["analysisReport"]>().mockResolvedValue(
    mode === "preview"
      ? {
          kind: "analysis_report_preview",
          status: "succeeded",
          preview_text: answer,
          body_evidence: bodyEvidence,
        }
      : {
          kind: "business_report",
          status: "succeeded",
          public_answer: answer,
          gaps: [],
          report: { summary: answer, sections: [], body_evidence: bodyEvidence },
        },
  );
  const request = testRequestContext(
    { analysisReport } as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      answerEvidence: () =>
        Promise.resolve([
          { ref: "e1", evidence: source },
          { ref: "e2", evidence: calculation },
        ]),
      answerStream: { callSeq: 1, mode: "text" },
    },
  );
  const deliver = async () => {
    if (mode === "preview") return createInquiryReportPreview()(body, request);
    const result = await executeInquiryReport({ body }, request);
    return "report" in result.details ? result.details.report : undefined;
  };
  return { request, analysisReport, deliver };
}

describe("正文计算引用与自动配图", () => {
  it.each(["final", "preview"] as const)(
    "%s保留基础比较图，计算结果仍由后端核验且不冒充图点",
    async (mode) => {
      const test = fixture(mode);
      expect(await test.deliver()).toMatchObject({
        charts: [
          {
            type: "bar",
            source_refs: ["run.A", "run.B"],
            placement: { after_paragraph: 1 },
            points: [
              { name: "A", value: "12.5000", display: "12.5000元" },
              { name: "B", value: "8.0000", display: "8.0000元" },
            ],
          },
        ],
      });
      expect(test.analysisReport).toHaveBeenCalledOnce();
      expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
        run_refs: ["run"],
        calculation_refs: [{ task_id: "task", calculation_id: "calc" }],
        summary: `甲{{run.A}}，乙{{run.B}}，差额{{${calculationRef}}}。`,
      });
    },
  );

  it.each(["final", "preview"] as const)(
    "%s只排除已知计算引用，异常未知映射不得被一并忽略",
    async (mode) => {
      expect(await fixture(mode, ["foreign.fact"]).deliver()).toMatchObject({ charts: [] });
    },
  );

  it("正文未知计算引用仍在来源边界拒绝，不请求后端", async () => {
    const test = fixture("final");
    const result = await executeInquiryReport(
      { body: body.replace("e2.v1", "e9.v1") },
      test.request,
    );
    expect(result.details).toMatchObject({
      status: "ARGUMENT_ERROR",
      error_code: "ANALYSIS_REPORT_REFERENCE",
    });
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it("显式选择计算结果作图保持拒绝，不通过自动引用过滤改写用户选点", async () => {
    const test = fixture("final");
    const result = await executeInquiryReport(
      { body, chart: { type: "bar", evidence_refs: ["e1.v1", "e2.v1"] } },
      test.request,
    );
    expect(result.details).toMatchObject({ status: "succeeded", report: { charts: [] } });
  });
});
