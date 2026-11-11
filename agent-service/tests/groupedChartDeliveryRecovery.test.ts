import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../src/backendClient.js";
import { executeInquiryReport } from "../src/inquiry/reportTool.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";

const recoveryNotice = "分组图无法直接比较，已按可比数据分别展示。";

function fixture() {
  const evidence = {
    kind: "analysis_evidence",
    status: "succeeded",
    run_ref: "run",
    execution_turn_id: "op-1",
    metric_descriptors: ["M1", "M2", "M3"].map((code) => ({
      code,
      name: code,
      unit: "元",
      value_basis: "current",
    })),
    evidence_items: ["M1", "M2", "M3"].flatMap((metric) =>
      ["A", "B", "C"].map((org) => ({
        ref: `${metric}.${org}`,
        type: "fact",
        metric_code: metric,
        metric_name: metric,
        org_code: org,
        org_name: org,
        date: "2026-08-31",
        unit: "元",
        value: "1.2500",
        display: "1.2500元",
      })),
    ),
  };
  const report = {
    summary: "规模分析。\n\n盈利分析。\n\n其他分析。",
    sections: [],
    body_evidence: [
      { paragraph: 1, evidence_refs: ["M1.A", "M1.B", "M1.C"] },
      { paragraph: 2, evidence_refs: ["M2.A", "M2.B", "M2.C"] },
      { paragraph: 3, evidence_refs: ["M3.A", "M3.B", "M3.C"] },
    ],
  };
  const analysisReport = vi.fn<BackendClient["analysisReport"]>(() =>
    Promise.resolve({
      kind: "business_report",
      status: "succeeded",
      public_answer: report.summary,
      gaps: [],
      report,
    }),
  );
  const queryMetric = vi.fn(),
    analysisExecute = vi.fn();
  const messages: AgentMessage[] = [{ role: "user", content: "比较经营数据", timestamp: 0 }];
  const request = testRequestContext(
    { analysisReport, queryMetric, analysisExecute } as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      answerEvidence: () => Promise.resolve([{ ref: "e1", evidence }]),
      turnMessages: () => Promise.resolve(messages),
    },
  );
  const input = {
    body: "规模{{M1.A}}。\n\n盈利{{M2.A}}。\n\n其他{{M3.A}}。",
    charts: [{ type: "grouped_bar" as const, evidence_refs: ["M1.A", "M1.B", "M2.A", "M2.B"] }],
  };
  return {
    evidence,
    report,
    request,
    input,
    messages,
    analysisReport,
    queryMetric,
    analysisExecute,
  };
}

describe("分组图交付局部恢复", () => {
  it.each(["date", "period"])(
    "合法已鉴权指标的%s不同只恢复选中引用，不扩大机构或指标",
    async (mode) => {
      const test = fixture();
      if (mode === "date")
        test.evidence.evidence_items
          .filter((atom) => atom.metric_code === "M1")
          .forEach((atom) => {
            atom.date = "2026-07-31";
          });
      else test.evidence.metric_descriptors[1]!.value_basis = "yoy";
      const result = await executeInquiryReport(test.input, test.request);
      expect(result).toHaveProperty("details.status", "succeeded");
      expect(result).toHaveProperty("details.report.charts.length", 2);
      expect(result).toMatchObject({
        details: {
          report: {
            charts: [
              {
                type: "bar",
                source_refs: ["M1.A", "M1.B"],
                dates: [mode === "date" ? "2026-07-31" : "2026-08-31"],
                points: [
                  { name: "A", value: "1.2500" },
                  { name: "B", value: "1.2500" },
                ],
                placement: { after_paragraph: 1 },
              },
              {
                type: "bar",
                source_refs: ["M2.A", "M2.B"],
                dates: ["2026-08-31"],
                points: [
                  { name: "A", value: "1.2500" },
                  { name: "B", value: "1.2500" },
                ],
                placement: { after_paragraph: 2 },
              },
            ],
          },
        },
      });
      expect(result).toHaveProperty(
        "details.public_answer",
        `${test.report.summary}\n\n${recoveryNotice}`,
      );
      expect(test.analysisReport).toHaveBeenCalledOnce();
      expect(test.queryMetric).not.toHaveBeenCalled();
      expect(test.analysisExecute).not.toHaveBeenCalled();
    },
  );

  it("缺一格只展示已有完整指标比较，不补零或借用第三机构", async () => {
    const test = fixture();
    test.input.charts[0]!.evidence_refs.pop();
    const result = await executeInquiryReport(test.input, test.request);
    expect(result).toHaveProperty("details.report.charts.length", 1);
    expect(result).toMatchObject({
      details: {
        report: {
          charts: [
            {
              type: "bar",
              source_refs: ["M1.A", "M1.B"],
              points: [
                { name: "A", value: "1.2500" },
                { name: "B", value: "1.2500" },
              ],
            },
          ],
        },
      },
    });
  });

  it.each(["foreign", "narrative", "source"])("%s不成立时不恢复分组图", async (mode) => {
    const test = fixture();
    test.evidence.metric_descriptors[1]!.value_basis = "yoy";
    if (mode === "foreign") test.input.charts[0]!.evidence_refs.push("foreign.ref");
    if (mode === "narrative") test.report.body_evidence = test.report.body_evidence.slice(0, 1);
    if (mode === "source") {
      const refs = test.input.charts[0]!.evidence_refs;
      test.messages.push({
        role: "toolResult",
        toolName: "analysis_chart",
        toolCallId: "chart",
        timestamp: 1,
        content: [{ type: "text", text: "图表已准备" }],
        isError: false,
        details: {
          kind: "inquiry_chart",
          status: "succeeded",
          selection: { type: "grouped_bar", evidence_refs: refs },
          source_refs: refs,
          run_refs: ["missing-run"],
        },
      });
    }
    const result = await executeInquiryReport(
      mode === "source" ? { body: test.input.body } : test.input,
      test.request,
    );
    expect(result).toHaveProperty("details.report.charts", []);
    expect(result).toHaveProperty(
      "details.public_answer",
      `${test.report.summary}\n\n所选图表与本次回答的数据范围或指标口径不一致，暂未展示。`,
    );
    expect(test.queryMetric).not.toHaveBeenCalled();
    expect(test.analysisExecute).not.toHaveBeenCalled();
  });

  it("合法分组无需降级，显式空数组仍取消全部图表", async () => {
    const test = fixture();
    const grouped = await executeInquiryReport(test.input, test.request);
    expect(grouped).toHaveProperty("details.report.charts.0.type", "grouped_bar");
    expect(grouped).toHaveProperty("details.public_answer", test.report.summary);
    const empty = await executeInquiryReport({ ...test.input, charts: [] }, test.request);
    expect(empty).toHaveProperty("details.report.charts", []);
    expect(empty).toHaveProperty("details.public_answer", test.report.summary);
  });
});
