import { describe, expect, it } from "vitest";
import {
  buildReportChart,
  reportChartCompositionSelections,
} from "../src/analysis/reportCharts.js";

// 隔离的正式关系与事实夹具，只检查自动选图边界。
const metrics = [
  { id: "total", code: "T", label: "总量", value_basis: "当日数" },
  { id: "personal", code: "P", label: "个人", value_basis: "当日数" },
  { id: "company", code: "C", label: "对公", value_basis: "当日数" },
  { id: "current", code: "D", label: "活期", value_basis: "当日数" },
  { id: "fixed", code: "F", label: "定期", value_basis: "当日数" },
];
const topic = {
  metrics,
  relationships: [
    { parent: "total", children: ["personal", "company"], pie_chart: true },
    { parent: "personal", children: ["current", "fixed"], pie_chart: true },
  ],
};

function source(ref = "e1", org = "A", date = "2026-08-27", unit = "元", role = "value") {
  return {
    ref,
    evidence: {
      kind: "analysis_evidence",
      status: "succeeded",
      metric_descriptors: metrics.map((metric) => ({
        code: metric.code,
        name: metric.label,
        value_basis: metric.value_basis,
        analysis_hint: { topic: "deposits", metric_id: metric.id },
      })),
      evidence_items: metrics.map((metric, index) => ({
        ref: `${ref}.f${index + 1}`,
        type: "fact",
        metric_code: metric.code,
        metric_name: metric.label,
        org_code: org,
        org_name: `${org}行`,
        date,
        unit,
        name: role,
        value: ["100.00", "75.00", "25.00", "35.00", "40.00"][index]!,
        display: `${["100.00", "75.00", "25.00", "35.00", "40.00"][index]!}${unit}`,
      })),
    },
  };
}

describe("正文已有事实自动匹配正式组成关系", () => {
  it("只在正文引用中按正式主题选候选，短引用和原引用去重，不扩大父项到未引用分项", () => {
    const input = source();
    expect(reportChartCompositionSelections([input], ["e1.v1"])).toEqual([]);
    expect(reportChartCompositionSelections([input], [])).toEqual([]);
    expect(reportChartCompositionSelections([input], ["e1.v1", "e1.f1", "e1.v2", "e1.v3"])).toEqual(
      [
        {
          topic: "deposits",
          selection: { type: "pie", evidence_refs: ["e1.f1", "e1.f2", "e1.f3"] },
        },
      ],
    );
    expect(reportChartCompositionSelections([input])[0]?.selection.evidence_refs).toHaveLength(5);
    expect(
      reportChartCompositionSelections([input], ["e1.v1", "e1.v2", "e1.v3", "unknown"]),
    ).toEqual([]);
  });

  it("机构、日期、单位与期间分别成组，不拼成一个结构", () => {
    const inputs = [
      source(),
      source("e2", "B"),
      source("e3", "A", "2026-07-31"),
      source("e4", "A", "2026-08-27", "万元"),
      source("e5", "A", "2026-08-27", "元", "balance"),
    ];
    expect(
      reportChartCompositionSelections(inputs).map((item) => item.selection.evidence_refs),
    ).toEqual(inputs.map((input) => input.evidence.evidence_items.map((atom) => atom.ref)));
  });

  it("无正式metric_id、计算值或不可画数值不构成候选，不影响其他完整组", () => {
    const invalid = source("e2", "B");
    invalid.evidence.metric_descriptors[0]!.analysis_hint.metric_id = "";
    invalid.evidence.evidence_items[1]!.type = "calculation";
    invalid.evidence.evidence_items[2]!.value = "NaN";
    expect(
      reportChartCompositionSelections([source(), invalid]).map(
        (item) => item.selection.evidence_refs,
      ),
    ).toEqual([["e1.f1", "e1.f2", "e1.f3", "e1.f4", "e1.f5"]]);
  });

  it("一个主题的多个完整关系各成饼图，总量不画成扇区", () => {
    const result = buildReportChart([source()], undefined, "", undefined, topic);
    expect(result.charts).toMatchObject([
      {
        type: "pie",
        title: "A行 · 总量结构",
        source_refs: ["e1.f1", "e1.f2", "e1.f3"],
        points: [
          { name: "个人", value: "75.00", share: "75.00%" },
          { name: "对公", value: "25.00", share: "25.00%" },
        ],
      },
      {
        type: "pie",
        title: "A行 · 个人结构",
        source_refs: ["e1.f2", "e1.f4", "e1.f5"],
        points: [
          { name: "活期", value: "35.00" },
          { name: "定期", value: "40.00" },
        ],
      },
    ]);
    expect(buildReportChart([source()], undefined, "", ["e1.v1", "e1.v2"], topic).charts).toEqual(
      [],
    );
  });

  it("完整关系追加组成图，缺关系或十进制合计不匹配不阻止普通机构比较", () => {
    const inputs = [source(), source("e2", "B")];
    const baseline = buildReportChart(inputs).charts;
    const automatic = buildReportChart(inputs, undefined, "", undefined, topic).charts;
    expect(automatic.filter((chart) => chart.type !== "pie")).toEqual(baseline);
    expect(automatic.filter((chart) => chart.type === "pie")).toHaveLength(4);
    inputs.forEach((input) => {
      input.evidence.evidence_items[0]!.value = "101.00";
    });
    const invalidTotal = buildReportChart(inputs, undefined, "", undefined, topic).charts;
    expect(invalidTotal.filter((chart) => chart.type !== "pie")).toEqual(
      buildReportChart(inputs).charts,
    );
    expect(
      invalidTotal.filter((chart) => chart.type === "pie").map((chart) => chart.title),
    ).toEqual(["A行 · 个人结构", "B行 · 个人结构"]);
    expect(
      buildReportChart(inputs, undefined, "", undefined, { metrics, relationships: [] }).charts,
    ).toEqual(buildReportChart(inputs).charts);
  });

  it("正文中已知但不可画的比例不抹掉有效组，显式选图与未知引用仍拒绝", () => {
    const input = source(),
      other = source("e2", "B");
    input.evidence.evidence_items[4]!.unit = "%";
    const refs = ["e1.v1", "e2.v1", "e1.v5"];
    expect(buildReportChart([input, other], undefined, "", refs).charts).toMatchObject([
      { type: "bar", source_refs: ["e1.f1", "e2.f1"] },
    ]);
    expect(buildReportChart([input, other], { type: "bar", evidence_refs: refs }).charts).toEqual(
      [],
    );
    expect(buildReportChart([input, other], undefined, "", [...refs, "unknown"]).charts).toEqual(
      [],
    );
  });

  it("冲突只淘汰本指标组，其他正文比较继续输出", () => {
    const input = source(),
      other = source("e2", "B");
    input.evidence.evidence_items.push({
      ...input.evidence.evidence_items[1]!,
      ref: "e1.conflict",
      value: "76.00",
    });
    const refs = ["e1.v1", "e2.v1", "e1.v2", "e2.v2", "e1.v6"];
    expect(buildReportChart([input, other], undefined, "", refs).charts).toMatchObject([
      { type: "bar", source_refs: ["e1.f1", "e2.f1"] },
    ]);
    expect(buildReportChart([input, other], { type: "bar", evidence_refs: refs }).charts).toEqual(
      [],
    );
  });
});
