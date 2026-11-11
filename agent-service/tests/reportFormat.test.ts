import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compileReportBody, selectedReportPlan } from "../src/inquiry/reportFormat.js";

const layout = {
  title: "经营对比报告",
  sections: [
    { id: "profit", title: "盈利表现", metric_codes: ["P", "R"], table: true },
    { id: "advice", title: "经营建议", metric_codes: [], table: false },
  ],
};
const plan = {
  id: "finance",
  version: "v1",
  text: "按配置输出",
  report_layout: layout,
  org_codes: ["A", "B"],
};
const sources = [
  {
    ref: "e1",
    evidence: {
      kind: "analysis_evidence",
      status: "succeeded",
      org_codes: ["A", "B", "C"],
      org_names: ["甲行", "乙行", "参考行"],
      metric_descriptors: [
        { code: "P", name: "净利润", unit: "元" },
        { code: "R", name: "比率", unit: "%", value_encoding: "unknown" },
      ],
      evidence_items: [
        {
          ref: "p-a",
          type: "fact",
          metric_code: "P",
          org_code: "A",
          date: "2026-07-31",
          value: "100",
          display: "100元",
          unit: "元",
        },
        {
          ref: "p-b",
          type: "fact",
          metric_code: "P",
          org_code: "B",
          date: "2026-06-30",
          value: "200",
          display: "200元",
          unit: "元",
        },
        {
          ref: "p-c",
          type: "fact",
          metric_code: "P",
          org_code: "C",
          date: "2026-07-31",
          value: "900",
          display: "900元",
          unit: "元",
        },
        {
          ref: "r-a",
          type: "fact",
          metric_code: "R",
          org_code: "A",
          date: "2026-07-31",
          value: "1.5",
          display: "1.5%",
          unit: "%",
        },
      ],
    },
  },
];
const report = {
  plan_id: "finance",
  overview: "总体观察。",
  sections: [
    { section_id: "profit", text: "利润情况需要结合口径判断。" },
    { section_id: "advice", text: "先核实变化来源。" },
  ],
};

describe("查询方案报告格式", () => {
  it("无布局时旧正文保持原样；结构化报告不能借未执行方案生效", () => {
    expect(compileReportBody({ body: "原文\n\n表格保持" }, undefined, sources)).toBe(
      "原文\n\n表格保持",
    );
    expect(() => compileReportBody({ report }, undefined, sources)).toThrow();
  });
  it("按配置生成章节和事实表，日期分行且不扩入参考机构", () => {
    const body = compileReportBody({ report }, plan, sources);
    expect(body).toContain("# 经营对比报告\n\n## 经营摘要");
    expect(body).toContain("| 指标 | 统计日期 | 甲行 | 乙行 |");
    expect(body).toContain("| 净利润 | 2026-07-31 | {{p-a}} | 未取得 |");
    expect(body).toContain("| 净利润 | 2026-06-30 | 未取得 | {{p-b}} |");
    expect(body).toContain("口径待确认");
    expect(body).not.toContain("{{r-a}}");
    expect(body).not.toContain("参考行");
    expect(body).not.toContain("{{p-c}}");
    expect(body.indexOf("## 盈利表现")).toBeLessThan(body.indexOf("## 经营建议"));
  });
  it("旧正文完整保留并补事实表，不猜测标题或丢弃段落", () => {
    const original = "# 原报告\n\n用户原段落。\n\n## 自有栏目\n\n继续说明。";
    const body = compileReportBody({ body: original }, plan, sources);
    expect(body).toContain(original);
    expect(body).toContain("{{p-a}}");
  });
  it("当前用户回合才接受实际执行的布局快照", () => {
    const user = { role: "user", content: "报告", timestamp: 1 } as AgentMessage;
    const receipt = {
      role: "toolResult",
      toolName: "topic_query",
      toolCallId: "t",
      timestamp: 2,
      content: [],
      isError: false,
      details: { topic_execution: { completed: true, report_plan: plan } },
    } as AgentMessage;
    expect(selectedReportPlan([user, receipt])).toEqual(plan);
    expect(selectedReportPlan([user, receipt, user])).toBeUndefined();
  });
  it("同节未稳定前不插表；后续节出现后输出前节完整表，最终正文一致", () => {
    const first = compileReportBody(
      { report: { ...report, sections: [report.sections[0]!] } },
      plan,
      sources,
      false,
    );
    expect(first).not.toContain("{{p-a}}");
    const next = compileReportBody({ report }, plan, sources, false);
    const final = compileReportBody({ report }, plan, sources, true);
    expect(next).toContain("{{p-a}}");
    expect(final.startsWith(next)).toBe(true);
  });
  it("表格展示预算只省略完整行，保留模型最后的建议且不将省略说成缺数", () => {
    const manyFacts = Array.from({ length: 240 }, (_, index) => ({
      ref: `fact-${index}`,
      type: "fact",
      metric_code: "P",
      org_code: "A",
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      value: "100",
      unit: "元",
    }));
    const longSource = [{ evidence: { ...sources[0]!.evidence, evidence_items: manyFacts } }];
    const longPlan = {
      ...plan,
      report_layout: {
        ...layout,
        sections: [
          { id: "profit", title: "盈利表现", metric_codes: ["P"], table: true },
          layout.sections[1]!,
        ],
      },
    };
    const body = compileReportBody({ report }, longPlan, longSource);
    expect(body).toContain("其余见数据明细");
    expect(body).not.toContain("本次尚未取得");
    expect(body.endsWith("先核实变化来源。")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(32000);
  });
});
