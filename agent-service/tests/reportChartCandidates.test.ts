import { describe, expect, it } from "vitest";
import { buildReportChart } from "../src/analysis/reportCharts.js";

// 隔离的候选图契约样本，不用于运行时取数或业务验收。
function source() {
  return {
    ref: "e1",
    evidence: {
      kind: "analysis_evidence",
      status: "succeeded",
      metric_descriptors: ["M1", "M2", "M3", "M4", "M5"].map((code) => ({
        code,
        name: code,
        unit: "元",
        value_basis: "当日数",
      })),
      evidence_items: ["M1", "M2", "M3", "M4", "M5"].flatMap((metric) =>
        ["A", "B"].map((org, index) => ({
          ref: `${metric}.${org}`,
          type: "fact",
          metric_code: metric,
          metric_name: metric,
          org_code: org,
          org_name: org,
          date: "2026-08-31",
          unit: "元",
          value: `${index - 1}.2500`,
          display: `${index - 1}.2500元`,
        })),
      ),
    },
  };
}

describe("多图候选按真实比较维度生成", () => {
  it("自动返回全部可比指标组，保持正文顺序而不提前应用报告图数预算", () => {
    const input = source();
    const refs = ["M3.A", "M3.B", "M1.A", "M1.B", "M2.A", "M2.B", "M4.A", "M4.B", "M5.A", "M5.B"];
    const result = buildReportChart([input], undefined, "", refs);
    expect(result.charts.map((chart) => chart.source_refs)).toEqual([
      ["M3.A", "M3.B"],
      ["M1.A", "M1.B"],
      ["M2.A", "M2.B"],
      ["M4.A", "M4.B"],
      ["M5.A", "M5.B"],
    ]);
    const chart = result.charts[0];
    expect(chart?.type === "bar" ? chart.points : undefined).toEqual([
      { name: "A", value: "-1.2500", display: "-1.2500元" },
      { name: "B", value: "0.2500", display: "0.2500元" },
    ]);
  });

  it("同指标多机构多日期分别形成同日对比及各机构真实趋势", () => {
    const input = source();
    const base = input.evidence.evidence_items.slice(0, 2);
    input.evidence.evidence_items = ["2026-08-31", "2026-06-30", "2026-07-31"].flatMap((date) =>
      base.map((atom) => ({ ...atom, ref: `${atom.ref}.${date}`, date })),
    );
    const result = buildReportChart(
      [input],
      undefined,
      "",
      input.evidence.evidence_items.map((atom) => atom.ref),
    );
    expect(result.charts.flatMap((chart) => (chart.type === "bar" ? [chart.dates] : []))).toEqual([
      ["2026-08-31"],
      ["2026-06-30"],
      ["2026-07-31"],
    ]);
    expect(
      result.charts.filter((chart) => chart.type === "line").map((chart) => chart.source_refs),
    ).toEqual([
      ["M1.A.2026-06-30", "M1.A.2026-07-31", "M1.A.2026-08-31"],
      ["M1.B.2026-06-30", "M1.B.2026-07-31", "M1.B.2026-08-31"],
    ]);
    expect(
      result.charts.filter((chart) => chart.type === "line").map((chart) => chart.title),
    ).toEqual(["A · M1", "B · M1"]);
  });

  it("自动按日期与单位拆开可比组，孤立单点不借用其他组凑图", () => {
    const input = source();
    const base = input.evidence.evidence_items.slice(0, 2);
    input.evidence.evidence_items = [
      ...base,
      ...base.map((atom) => ({
        ...atom,
        ref: `${atom.ref}.prior`,
        date: "2026-07-31",
        unit: "万元",
      })),
      { ...base[0]!, ref: "isolated", date: "2026-06-30", unit: "亿元" },
    ];
    const result = buildReportChart(
      [input],
      undefined,
      "",
      input.evidence.evidence_items.map((atom) => atom.ref),
    );
    expect(result.charts.map((chart) => ({ refs: chart.source_refs, unit: chart.unit }))).toEqual([
      { refs: ["M1.A", "M1.B"], unit: "元" },
      { refs: ["M1.A.prior", "M1.B.prior"], unit: "万元" },
    ]);
  });

  it("显式多指标跨机构柱图拆为独立指标小图，并保留全部引用", () => {
    const result = buildReportChart([source()], {
      type: "bar",
      evidence_refs: ["M2.B", "M1.A", "M2.A", "M1.B"],
    });
    expect(result.charts.map((chart) => ({ type: chart.type, refs: chart.source_refs }))).toEqual([
      { type: "bar", refs: ["M2.B", "M2.A"] },
      { type: "bar", refs: ["M1.A", "M1.B"] },
    ]);
    expect(result.notice).toBeUndefined();
  });

  it.each(["unit", "date", "incomplete", "ratio"])("显式多图不能通过拆分掩盖%s问题", (mode) => {
    const input = source();
    const refs = ["M1.A", "M1.B", "M2.A", "M2.B"];
    if (mode === "unit") input.evidence.evidence_items[2]!.unit = "万元";
    if (mode === "date") input.evidence.evidence_items[2]!.date = "2026-07-31";
    if (mode === "incomplete") refs.pop();
    if (mode === "ratio")
      input.evidence.evidence_items.slice(2, 4).forEach((atom) => {
        atom.unit = "%";
      });
    expect(buildReportChart([input], { type: "bar", evidence_refs: refs }).charts).toEqual([]);
  });
});
