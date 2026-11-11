import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  buildReportChart,
  reportChartHasNarrativeEvidence,
  type ReportChartSelection,
} from "../src/analysis/reportCharts.js";
import type { BackendClient } from "../src/backendClient.js";
import { createInquiryChartTool, inquiryCharts } from "../src/inquiry/chartTool.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

// 仅验证分组柱图契约的隔离样本，不作为业务数据。
function source(metricCount = 2, orgCount = 2) {
  const metrics = Array.from({ length: metricCount }, (_, index) => `M${index + 1}`);
  const orgs = Array.from({ length: orgCount }, (_, index) => String.fromCharCode(65 + index));
  return {
    ref: "e1",
    evidence: {
      kind: "analysis_evidence",
      status: "succeeded",
      run_ref: "run",
      execution_turn_id: "op-1",
      metric_descriptors: metrics.map((code) => ({
        code,
        name: code,
        unit: "元",
        value_basis: "当日数",
        value_encoding: "",
      })),
      evidence_items: metrics.flatMap((metric, mi) =>
        orgs.map((org, oi) => {
          const value = ["-2.5000", "0", "5.12500", "9.00"][mi * orgCount + oi] ?? "10.00";
          return {
            ref: `${metric}.${org}`,
            type: "fact",
            metric_code: metric,
            metric_name: metric,
            org_code: org,
            org_name: org,
            date: "2026-08-31",
            unit: "元",
            value,
            display: `${value}元`,
          };
        }),
      ),
    },
  };
}

function selection(refs = ["M2.B", "M1.A", "M2.A", "M1.B"]): ReportChartSelection {
  return { type: "grouped_bar", evidence_refs: refs };
}

describe("显式分组柱图", () => {
  it("按首次出现的指标与机构组织完整矩形，引用顺序与每个真实数值一致", () => {
    const result = buildReportChart([source()], selection());
    expect(result.charts).toMatchObject([
      {
        type: "grouped_bar",
        dates: ["2026-08-31"],
        unit: "元",
        categories: ["M2", "M1"],
        source_refs: ["M2.B", "M1.B", "M2.A", "M1.A"],
        series: [
          {
            name: "B",
            points: [
              { value: "9.00", display: "9.00元" },
              { value: "0", display: "0元" },
            ],
          },
          {
            name: "A",
            points: [
              { value: "5.12500", display: "5.12500元" },
              { value: "-2.5000", display: "-2.5000元" },
            ],
          },
        ],
      },
    ]);
    expect(result.notice).toBeUndefined();
  });

  it.each([
    "missing_cell",
    "single_metric",
    "single_org",
    "date",
    "unit",
    "period",
    "value_conflict",
    "metric_label",
    "org_label",
    "unknown",
  ])("%s不能通过分组补零、混口径或改名掩盖", (mode) => {
    const input = source();
    const refs = selection().evidence_refs;
    if (mode === "missing_cell") refs.pop();
    if (mode === "single_metric") refs.splice(0, refs.length, "M1.A", "M1.B");
    if (mode === "single_org") refs.splice(0, refs.length, "M1.A", "M2.A");
    if (mode === "date") input.evidence.evidence_items[0]!.date = "2026-07-31";
    if (mode === "unit") input.evidence.evidence_items[0]!.unit = "万元";
    if (mode === "period") input.evidence.metric_descriptors[0]!.value_basis = "较同期";
    if (mode === "value_conflict") {
      input.evidence.evidence_items.push({
        ...input.evidence.evidence_items[0]!,
        ref: "conflict",
        value: "99.00",
      });
      refs.push("conflict");
    }
    if (mode === "metric_label") input.evidence.evidence_items[0]!.metric_name = "错误指标";
    if (mode === "org_label") input.evidence.evidence_items[0]!.org_name = "错误机构";
    if (mode === "unknown") refs[0] = "unknown";
    const result = buildReportChart([input], selection(refs));
    expect(result.charts).toEqual([]);
    expect(typeof result.notice).toBe("string");
  });

  it("缺失比例编码不能进入分组柱图", () => {
    const input = source();
    input.evidence.evidence_items.forEach((atom) => {
      atom.unit = "%";
    });
    input.evidence.metric_descriptors.forEach((metric) => {
      metric.unit = "%";
      metric.value_encoding = "";
    });
    expect(buildReportChart([input], selection()).charts).toEqual([]);
  });

  it("不同指标已知ratio与percent存储编码逐项归一后可以比较", () => {
    const input = source();
    input.evidence.metric_descriptors.forEach((metric, index) => {
      metric.unit = "%";
      metric.value_encoding = index === 0 ? "ratio" : "percent";
    });
    input.evidence.evidence_items.forEach((atom) => {
      atom.unit = "%";
      atom.value = atom.metric_code === "M1" ? "0.0123400" : "1.23400";
      atom.display = "1.23400%";
    });
    expect(buildReportChart([input], selection()).charts).toMatchObject([
      {
        type: "grouped_bar",
        unit: "%",
        series: [
          {
            points: [
              { value: "1.23400", display: "1.23400%" },
              { value: "1.23400", display: "1.23400%" },
            ],
          },
          {
            points: [
              { value: "1.23400", display: "1.23400%" },
              { value: "1.23400", display: "1.23400%" },
            ],
          },
        ],
      },
    ]);
  });

  it("已确认同一比例编码时精确转换百分数，提示值保持原始显示", () => {
    const input = source();
    input.evidence.metric_descriptors.forEach((metric) => {
      metric.unit = "%";
      metric.value_encoding = "ratio";
    });
    input.evidence.evidence_items.forEach((atom) => {
      atom.unit = "%";
      atom.value = "0.0123400";
      atom.display = "1.23400%";
    });
    expect(buildReportChart([input], selection()).charts).toMatchObject([
      {
        type: "grouped_bar",
        unit: "%",
        series: [
          {
            points: [
              { value: "1.23400", display: "1.23400%" },
              { value: "1.23400", display: "1.23400%" },
            ],
          },
          {
            points: [
              { value: "1.23400", display: "1.23400%" },
              { value: "1.23400", display: "1.23400%" },
            ],
          },
        ],
      },
    ]);
  });

  it.each([
    [6, 4, 1],
    [5, 5, 0],
  ])("%s指标×%s机构遵守总点数预算", (metrics, orgs, count) => {
    const input = source(metrics, orgs);
    const result = buildReportChart(
      [input],
      selection(input.evidence.evidence_items.map((atom) => atom.ref)),
    );
    expect(result.charts).toHaveLength(count);
    if (count) expect(result.charts[0]?.source_refs).toHaveLength(24);
  });

  it("正文须涉及每个指标口径，但不要求重复列出每家机构数值", () => {
    const input = source();
    expect(reportChartHasNarrativeEvidence([input], selection(), ["M1.A"])).toBe(false);
    expect(reportChartHasNarrativeEvidence([input], selection(), ["M1.A", "M2.A"])).toBe(true);
    input.evidence.evidence_items.push({
      ...input.evidence.evidence_items[2]!,
      ref: "prior",
      date: "2026-07-31",
    });
    expect(reportChartHasNarrativeEvidence([input], selection(), ["M1.A", "prior"])).toBe(false);
  });

  it("自动候选及原bar选图仍保持逐指标小图", () => {
    const input = source();
    const refs = selection().evidence_refs;
    expect(
      buildReportChart([input], undefined, "", refs).charts.map((chart) => chart.type),
    ).toEqual(["bar", "bar"]);
    expect(
      buildReportChart([input], { type: "bar", evidence_refs: refs }).charts.map(
        (chart) => chart.type,
      ),
    ).toEqual(["bar", "bar"]);
  });

  it("选图回执签发完整矩形引用，本轮累计保留grouped与独立bar不同选择", async () => {
    const input = source();
    const messages: AgentMessage[] = [{ role: "user", content: "对比经营指标", timestamp: 0 }];
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {
      answerEvidence: () => Promise.resolve([input]),
      turnMessages: () => Promise.resolve(messages),
    });
    for (const choice of [selection(), { type: "bar" as const, evidence_refs: ["M1.A", "M1.B"] }]) {
      const result = (await runTool(createInquiryChartTool(), choice, request)) as Pick<
        Extract<AgentMessage, { role: "toolResult" }>,
        "content"
      > & { details: unknown };
      messages.push({
        role: "toolResult",
        toolName: "analysis_chart",
        toolCallId: `c${messages.length}`,
        timestamp: messages.length,
        content: result.content,
        details: result.details,
        isError: false,
      });
    }
    expect(
      inquiryCharts(messages).map((item) => ({ selection: item.selection, runs: item.run_refs })),
    ).toEqual([
      {
        selection: { type: "grouped_bar", evidence_refs: ["M2.B", "M1.B", "M2.A", "M1.A"] },
        runs: ["run"],
      },
      { selection: { type: "bar", evidence_refs: ["M1.A", "M1.B"] }, runs: ["run"] },
    ]);
  });
});
