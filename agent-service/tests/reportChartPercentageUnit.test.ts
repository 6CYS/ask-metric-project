import { describe, expect, it } from "vitest";
import { buildReportChart } from "../src/analysis/reportCharts.js";

function source(role?: string, atomRole?: string, encoding = "ratio") {
  return {
    ref: "e1",
    evidence: {
      kind: "analysis_evidence",
      status: "succeeded",
      metric_descriptors: [
        {
          code: "M1",
          name: "测试比率",
          unit: "%",
          value_encoding: encoding,
          value_basis: role ? "较同期" : "当日数",
          ...(role ? { analysis_hint: { comparison: "yoy", comparison_role: role } } : {}),
        },
      ],
      evidence_items: ["A", "B"].map((org, index) => ({
        ref: `M1.${org}`,
        type: atomRole ? "calculation" : "fact",
        metric_code: "M1",
        metric_name: "测试比率",
        org_code: org,
        org_name: org,
        date: "2026-08-27",
        unit: "%",
        value: index === 0 ? "0.0035979381" : "0.0001895304",
        display:
          role === "difference" ? (index === 0 ? "0.36个百分点" : "0.02个百分点") : "原始显示",
        ...(atomRole ? { comparison: "yoy", comparison_role: atomRole } : {}),
      })),
    },
  };
}

describe("百分比图轴单位取正式比较角色", () => {
  it.each([
    { role: undefined, unit: "%" },
    { role: "difference", unit: "个百分点" },
    { role: "rate", unit: "%" },
  ])("$role使用$unit并保留已归一的精确数值", ({ role, unit }) => {
    const result = buildReportChart([source(role)], {
      type: "bar",
      evidence_refs: ["M1.A", "M1.B"],
    });
    expect(result.charts).toMatchObject([
      {
        type: "bar",
        unit,
        source_refs: ["M1.A", "M1.B"],
        points: [
          { name: "A", value: "0.35979381" },
          { name: "B", value: "0.01895304" },
        ],
      },
    ]);
  });

  it("计算原子的rate角色优先于原指标的差额角色", () => {
    expect(
      buildReportChart([source("difference", "rate")], {
        type: "bar",
        evidence_refs: ["M1.A", "M1.B"],
      }).charts,
    ).toMatchObject([{ unit: "%" }]);
  });

  it("计算原子的difference角色使百分比差额使用百分点", () => {
    expect(
      buildReportChart([source(undefined, "difference")], {
        type: "bar",
        evidence_refs: ["M1.A", "M1.B"],
      }).charts,
    ).toMatchObject([{ unit: "个百分点" }]);
  });

  it("正式口径缺少差额角色时不根据名称、期间或显示文案推断百分点", () => {
    const input = source();
    input.evidence.metric_descriptors[0]!.value_basis = "较同期";
    input.evidence.metric_descriptors[0]!.name = "比率同比差额";
    input.evidence.evidence_items.forEach((atom) => {
      atom.display = "0.36个百分点";
    });
    expect(
      buildReportChart([input], { type: "bar", evidence_refs: ["M1.A", "M1.B"] }).charts,
    ).toMatchObject([{ unit: "%" }]);
  });

  it("percent编码的差额不再乘100，未知编码仍拒绝绘图", () => {
    expect(
      buildReportChart([source("difference", undefined, "percent")], {
        type: "bar",
        evidence_refs: ["M1.A", "M1.B"],
      }).charts,
    ).toMatchObject([
      { unit: "个百分点", points: [{ value: "0.0035979381" }, { value: "0.0001895304" }] },
    ]);
    expect(
      buildReportChart([source("difference", undefined, "")], {
        type: "bar",
        evidence_refs: ["M1.A", "M1.B"],
      }).charts,
    ).toEqual([]);
  });
});
