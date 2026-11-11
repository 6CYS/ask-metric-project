import { describe, expect, it, vi } from "vitest";
import { type BackendClient } from "../src/backendClient.js";
import { createInquiryReportTool } from "../src/inquiry/reportTool.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

// 隔离后端边界，仅检查已鉴权回执如何交给报告服务。
function fixture(withValue = false) {
  const analysisReport = vi.fn().mockResolvedValue({
    kind: "business_report",
    status: "succeeded",
    public_answer: "所查日期没有可用数据。",
    report: { summary: "所查日期没有可用数据。", sections: [], body_evidence: [] },
    gaps: [],
  });
  const backend = { analysisReport } as unknown as BackendClient;
  const sources = [
    {
      ref: "e1",
      evidence: {
        kind: "analysis_evidence",
        status: "succeeded",
        run_ref: "historical-gap",
        scope_id: "old-operation",
        execution_turn_id: "old-operation",
        result_reused: true,
        org_codes: ["O2"],
        org_names: ["另一机构"],
        rows: [],
        analysis_date: null,
        requested_start: "2026-07-31",
        requested_end: "2026-07-31",
        date_selection: "exact",
        metric_descriptors: [{ binding_ref: "corporate", code: "corporate", name: "对公存款" }],
        evidence_items: [
          { ref: "old.g1", type: "gap", display: "对公存款在所查日期没有可用数据。" },
          ...(withValue ? [{ ref: "old.f1", type: "fact", value: "100", display: "100元" }] : []),
        ],
      },
    },
  ];
  const request = testRequestContext(backend, new MemoryCommandBridge(), {
    answerEvidence: () => Promise.resolve(sources),
  });
  return { analysisReport, request };
}

describe("历史缺数报告", () => {
  it.each(["所查日期没有可用数据。", "所查日期没有可用数据。{{e1.v1|cite}}"])(
    "纯缺数来源允许交付并保留原运行和缺数引用：%s",
    async (body) => {
      const test = fixture();
      const result: unknown = await runTool(
        createInquiryReportTool(),
        { body, charts: [] },
        test.request,
      );
      expect(result).toHaveProperty("terminate", true);
      expect(test.analysisReport).toHaveBeenCalledWith(
        expect.objectContaining({
          run_refs: ["historical-gap"],
          context_run_refs: ["historical-gap"],
          focus_refs: ["old.g1"],
        }),
        expect.anything(),
      );
    },
  );

  it("混合历史值仍需显式引用，不能由缺数原子带入旧金额", async () => {
    const test = fixture(true);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "余额为100元。" },
      test.request,
    );
    expect(result).toHaveProperty("details.error_code", "ANALYSIS_REPORT_REFERENCE");
    expect(test.analysisReport).not.toHaveBeenCalled();
  });
});
