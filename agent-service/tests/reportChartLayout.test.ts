import { describe, expect, it } from "vitest";
import { layoutReportCharts } from "../src/analysis/reportChartLayout.js";
import type { BusinessReportChart } from "../src/analysis/reportCharts.js";

// 仅验证布局和引用对应关系，不作为真实业务数据。
function chart(index: number): BusinessReportChart {
  return {
    type: "bar",
    title: `指标${index}`,
    dates: ["2026-08-27"],
    unit: "元",
    source_refs: [`m${index}.a`, `m${index}.b`],
    points: [
      { name: "甲行", value: "10", display: "10元" },
      { name: "乙行", value: "20", display: "20元" },
    ],
  };
}

describe("图表与最终正文位置", () => {
  it("默认预算优先覆盖后续章节，不被第一章的多个指标占满", () => {
    const charts = [1, 2, 3, 4, 5, 6].map(chart);
    const report = {
      summary: "## 规模\n\n规模表。\n\n## 盈利\n\n利润表。\n\n## 风险\n\n风险表。",
      body_evidence: [
        {
          paragraph: 2,
          evidence_refs: ["m1.a", "m1.b", "m2.a", "m2.b", "m3.a", "m3.b", "m4.a", "m4.b"],
        },
        { paragraph: 4, evidence_refs: ["m5.a", "m5.b"] },
        { paragraph: 6, evidence_refs: ["m6.a", "m6.b"] },
      ],
    };
    const result = layoutReportCharts(charts, report, true);
    expect(result.map((item) => item.title)).toEqual(["指标1", "指标2", "指标5", "指标6"]);
    expect(result.map((item) => item.placement?.after_paragraph)).toEqual([2, 2, 4, 6]);
    expect(layoutReportCharts(charts, report, false)).toHaveLength(6);
  });

  it("依据最完整的段落定位，避免摘要首次提到一个数就提前插图", () => {
    const report = {
      summary: "摘要。\n\n## 规模\n\n完整表。",
      body_evidence: [
        { paragraph: 1, evidence_refs: ["m1.a"] },
        { paragraph: 3, evidence_refs: ["m1.a", "m1.b"] },
      ],
    };
    expect(layoutReportCharts([chart(1)], report)[0]?.placement).toEqual({ after_paragraph: 3 });
  });

  it("旧分节报告按实际证据定位，无可靠段号则保留图而不猜位置", () => {
    const report = {
      summary: "摘要。",
      body_evidence: [{ paragraph: 20, evidence_refs: ["m2.a", "m2.b"] }],
      sections: [{ title: "规模", text: "分析。\n\n规模表。", evidence_refs: ["m1.a", "m1.b"] }],
    };
    const result = layoutReportCharts([chart(1), chart(2)], report);
    expect(result[0]?.placement).toEqual({ section_index: 0, after_paragraph: 2 });
    expect(result[1]).not.toHaveProperty("placement");
  });

  it("重复选图只展示一次，保留第一次的真实点序", () => {
    const first = chart(1),
      duplicate = { ...first, source_refs: [...first.source_refs].reverse() };
    expect(layoutReportCharts([first, duplicate], {})).toEqual([first]);
  });
});
