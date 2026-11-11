import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BackendClient } from "../src/backendClient.js";
import { buildInquiryChart } from "../src/inquiry/chartTool.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";

// 隔离的正式字段夹具，检查已有事实的展示组合，不调用模型或指标服务。
function source(codes = ["P", "R"], orgs = ["A", "B"], prefix = "run") {
  return {
    ref: prefix,
    evidence: {
      kind: "analysis_evidence",
      status: "succeeded",
      metric_descriptors: codes.map((code) => ({
        code,
        name: code,
        value_basis: code.endsWith("Y") ? "较同期" : "当日数",
      })),
      evidence_items: codes.flatMap((code) =>
        orgs.map((org) => ({
          ref: `${prefix}.${code}.${org}`,
          type: "fact",
          metric_code: code,
          metric_name: code,
          org_code: org,
          org_name: `${org}行`,
          date: "2026-08-27",
          unit: "元",
          value: "10.00",
          display: "10.00元",
        })),
      ),
    },
  };
}

const layout = {
  title: "经营对比",
  sections: [
    { id: "profit", title: "盈利表现", metric_codes: ["RY", "PY", "R", "P"], table: true },
  ],
};
const user: AgentMessage = { role: "user", content: "对比经营情况", timestamp: 1 };
const receipt: Extract<AgentMessage, { role: "toolResult" }> = {
  role: "toolResult",
  toolName: "topic_query",
  toolCallId: "topic",
  timestamp: 2,
  content: [],
  isError: false,
  details: {
    topic_execution: {
      completed: true,
      report_plan: {
        id: "finance",
        version: "v1",
        text: "说明",
        org_codes: ["A", "B"],
        report_layout: layout,
      },
    },
  },
};
function request(messages: AgentMessage[] = [user, receipt]) {
  return testRequestContext({} as BackendClient, new MemoryCommandBridge(), {
    originalMessage: "对比经营情况",
    turnMessages: () => Promise.resolve(messages),
  });
}

function singleInstitutionRequest(sections = layout.sections) {
  return request([
    user,
    {
      ...receipt,
      details: {
        topic_execution: {
          completed: true,
          report_plan: {
            id: "finance",
            version: "v1",
            text: "说明",
            org_codes: ["A"],
            report_layout: { ...layout, sections },
          },
        },
      },
    },
  ]);
}

describe("单机构报告按业务章节自动配图", () => {
  it("同章节可比指标按配置顺序成图，本期与同比分别展示，不混入其他业务", async () => {
    const input = source(["P", "R", "PY", "RY", "S", "T", "OTHER"], ["A"]);
    input.evidence.evidence_items.find((atom) => atom.metric_code === "PY")!.value = "-5.25";
    input.evidence.evidence_items.find((atom) => atom.metric_code === "PY")!.display = "-5.25元";
    const result = await buildInquiryChart(
      [input],
      undefined,
      singleInstitutionRequest([
        ...layout.sections,
        { id: "scale", title: "规模业务", metric_codes: ["T", "S"], table: true },
      ]),
    );
    expect(result.charts).toMatchObject([
      {
        type: "bar",
        category_kind: "metric",
        title: "盈利表现 · 同比变化",
        dates: ["2026-08-27"],
        unit: "元",
        source_refs: ["run.RY.A", "run.PY.A"],
        points: [
          { name: "RY", value: "10.00" },
          { name: "PY", value: "-5.25" },
        ],
      },
      { type: "bar", title: "盈利表现", source_refs: ["run.R.A", "run.P.A"] },
      { type: "bar", title: "规模业务", source_refs: ["run.T.A", "run.S.A"] },
    ]);
    expect(result.charts).toHaveLength(3);
  });

  it.each(["date", "unit", "basis", "section", "single"])(
    "%s不同或只有一个点时不强行拼图",
    async (mode) => {
      const input = source(mode === "basis" ? ["P", "RY"] : ["P", "R"], ["A"]);
      const second = input.evidence.evidence_items[1]!;
      if (mode === "date") second.date = "2026-07-31";
      if (mode === "unit") {
        second.unit = "%";
        second.display = "10.00%";
        input.evidence.metric_descriptors = input.evidence.metric_descriptors.map((metric) => ({
          ...metric,
          value_encoding: "percent",
        }));
      }
      if (mode === "single") input.evidence.evidence_items.pop();
      const req = singleInstitutionRequest(
        mode === "section"
          ? [
              { id: "profit", title: "盈利表现", metric_codes: ["P"], table: true },
              { id: "scale", title: "规模业务", metric_codes: ["R"], table: true },
            ]
          : layout.sections,
      );
      expect((await buildInquiryChart([input], undefined, req)).charts).toEqual([]);
    },
  );

  it("单机构章节图保留已有同指标真实历史趋势", async () => {
    const current = source(["P", "R"], ["A"]);
    const previous = source(["P"], ["A"], "previous");
    previous.evidence.evidence_items[0]!.date = "2026-07-31";
    const result = await buildInquiryChart(
      [current, previous],
      undefined,
      singleInstitutionRequest(),
    );
    expect(result.charts).toMatchObject([
      { type: "bar", source_refs: ["run.R.A", "run.P.A"] },
      {
        type: "line",
        dates: ["2026-07-31", "2026-08-27"],
        source_refs: ["previous.P.A", "run.P.A"],
      },
    ]);
    expect(result.charts).toHaveLength(2);
  });

  it("仅组合本轮正文中主机构的事实，普通问数和双机构缺数不改成单机构章节图", async () => {
    const primary = source(["P"], ["A"]);
    const reference = {
      ...source(["R"], ["A"], "reference"),
      evidence: { ...source(["R"], ["A"], "reference").evidence, inquiry_scope_role: "reference" },
    };
    expect(
      (await buildInquiryChart([primary, reference], undefined, singleInstitutionRequest())).charts,
    ).toEqual([]);
    const input = source(["P", "R"], ["A"]);
    expect(
      (await buildInquiryChart([input], undefined, singleInstitutionRequest(), ["run.P.A"])).charts,
    ).toEqual([]);
    expect((await buildInquiryChart([input], undefined, request([user]))).charts).toEqual([]);
    expect((await buildInquiryChart([input], undefined, request())).charts).toEqual([]);
  });
});

describe("已执行报告主题自动分组图", () => {
  it("按配置顺序分组同比和当期，完整分组替换原单指标柱图", async () => {
    const input = source(["P", "R", "PY", "RY"]);
    const result = await buildInquiryChart([input], undefined, request());
    expect(result.charts.map((chart) => chart.type)).toEqual(["grouped_bar", "grouped_bar"]);
    expect(result.charts).toMatchObject([
      {
        title: "盈利表现 · 同比变化",
        dates: ["2026-08-27"],
        unit: "元",
        categories: ["RY", "PY"],
        series: [{ name: "A行" }, { name: "B行" }],
      },
      { title: "盈利表现", categories: ["R", "P"] },
    ]);
  });

  it.each(["date", "unit", "missing"])("%s不完整时保留可用单图，不拼接分组", async (mode) => {
    const input = source();
    if (mode === "date")
      input.evidence.evidence_items
        .filter((atom) => atom.metric_code === "R")
        .forEach((atom) => {
          atom.date = "2026-07-31";
        });
    if (mode === "unit")
      input.evidence.evidence_items
        .filter((atom) => atom.metric_code === "R")
        .forEach((atom) => {
          atom.unit = "万元";
          atom.display = "10.00万元";
        });
    if (mode === "missing") input.evidence.evidence_items.pop();
    const result = await buildInquiryChart([input], undefined, request());
    expect(result.charts.some((chart) => chart.type === "grouped_bar")).toBe(false);
    expect(result.charts.some((chart) => chart.type === "bar")).toBe(true);
  });

  it("分组只采用选定机构与正文事实，不纳入独立参考行，保留未覆盖柱图和趋势", async () => {
    const primary = source(["P", "R", "S"], ["A", "B", "C"]);
    const reference = {
      ...source(["P", "R"], ["A", "B"], "reference"),
      evidence: {
        ...source(["P", "R"], ["A", "B"], "reference").evidence,
        inquiry_scope_role: "reference",
      },
    };
    const previous = source(["P"], ["A"], "previous");
    previous.evidence.evidence_items[0]!.date = "2026-07-31";
    const inputs = [primary, reference, previous];
    const refs = inputs.flatMap((input) => input.evidence.evidence_items.map((atom) => atom.ref));
    const result = await buildInquiryChart(inputs, undefined, request(), refs);
    const grouped = result.charts.find((chart) => chart.type === "grouped_bar");
    expect(grouped?.source_refs).toEqual(["run.R.A", "run.P.A", "run.R.B", "run.P.B"]);
    expect(result.charts.some((chart) => chart.type === "line")).toBe(true);
    expect(
      result.charts.some((chart) => chart.type === "bar" && chart.source_refs.includes("run.S.A")),
    ).toBe(true);
    expect(
      (
        await buildInquiryChart([primary], undefined, request(), ["run.P.A", "run.P.B"])
      ).charts.some((chart) => chart.type === "grouped_bar"),
    ).toBe(false);
  });

  it("普通问数、上轮布局和显式选图保持原路径", async () => {
    const input = source();
    for (const messages of [[user], [user, receipt, user]]) {
      expect(
        (await buildInquiryChart([input], undefined, request(messages))).charts.map(
          (chart) => chart.type,
        ),
      ).toEqual(["bar", "bar"]);
    }
    const refs = input.evidence.evidence_items.map((atom) => atom.ref);
    expect(
      (
        await buildInquiryChart([input], { type: "bar", evidence_refs: refs }, request())
      ).charts.map((chart) => chart.type),
    ).toEqual(["bar", "bar"]);
  });
});
