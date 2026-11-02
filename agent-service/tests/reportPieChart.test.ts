import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { buildReportChart } from "../src/analysis/reportCharts.js";
import { createInquiryChartTool } from "../src/inquiry/chartTool.js";
import { createInquiryReportTool } from "../src/inquiry/reportTool.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

// 隔离的组成关系与事实，只用于检验图表契约。
function fixture() {
  const metrics = [
    { id: "total", code: "T", label: "总量", value_basis: "当日数" },
    { id: "retail", code: "R", label: "个人", value_basis: "当日数" },
    { id: "corporate", code: "C", label: "对公", value_basis: "当日数" },
  ];
  const topic = {
    metrics,
    relationships: [{ parent: "total", children: ["retail", "corporate"], pie_chart: true }],
  };
  const evidence = {
    kind: "analysis_evidence" as const,
    status: "succeeded",
    run_ref: "run",
    execution_turn_id: "op-1",
    org_codes: ["A"],
    tasks: [],
    metric_descriptors: metrics.map((metric) => ({
      code: metric.code,
      name: metric.label,
      value_basis: metric.value_basis,
      analysis_hint: { topic: "deposits", metric_id: metric.id },
    })),
    evidence_items: metrics.map((metric, index) => ({
      ref: `run.f${index + 1}`,
      type: "fact",
      metric_code: metric.code,
      metric_name: metric.label,
      org_code: "A",
      org_name: "甲行",
      date: "2026-08-27",
      unit: "元",
      value: ["100.00", "75.00", "25.00"][index]!,
      display: ["100.00元", "75.00元", "25.00元"][index]!,
    })),
  };
  const sources = [{ ref: "e1", evidence }];
  const selection = { type: "pie" as const, evidence_refs: ["e1.v1", "e1.v2", "e1.v3"] };
  const messages: AgentMessage[] = [{ role: "user", content: "展示存款结构饼图", timestamp: 0 }];
  const businessTopic = vi.fn(() => Promise.resolve(topic));
  const analysisReport = vi
    .fn<BackendClient["analysisReport"]>()
    .mockResolvedValue({
      kind: "business_report",
      status: "succeeded",
      public_answer: "个人75.00元，对公25.00元。",
      gaps: [],
      report: {
        summary: "个人75.00元，对公25.00元。",
        sections: [],
        body_evidence: [{ paragraph: 1, evidence_refs: ["run.f2", "run.f3"] }],
      },
    });
  const request = testRequestContext(
    { businessTopic, analysisReport } as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      originalMessage: "展示存款结构饼图",
      answerEvidence: () => Promise.resolve(sources),
      turnMessages: () => Promise.resolve(messages),
    },
  );
  return { topic, sources, selection, messages, request, analysisReport, businessTopic };
}

describe("普通问数结构饼图", () => {
  it("复用已确认的组成关系，总量仅作分母，不作为扇区", () => {
    const { sources, selection, topic } = fixture();
    expect(buildReportChart(sources, selection, "", undefined, topic).charts).toEqual([
      {
        type: "pie",
        title: "总量结构",
        date: "2026-08-27",
        unit: "元",
        source_refs: ["run.f1", "run.f2", "run.f3"],
        points: [
          { name: "个人", value: "75.00", display: "75.00元", share: "75.00%" },
          { name: "对公", value: "25.00", display: "25.00元", share: "25.00%" },
        ],
      },
    ]);
  });

  it.each([
    "date",
    "unit",
    "org",
    "missing",
    "duplicate",
    "unknown",
    "comparison",
    "percentage",
    "unconfirmed",
    "wrong_total",
    "unrelated",
  ])("%s 不可被归一化成完整结构饼图", (reason) => {
    const { sources, selection, topic } = fixture();
    const atom = sources[0]!.evidence.evidence_items[2]!;
    if (reason === "date") atom.date = "2026-07-31";
    if (reason === "unit") atom.unit = "万元";
    if (reason === "org") atom.org_code = "B";
    if (reason === "missing") selection.evidence_refs.pop();
    if (reason === "duplicate") selection.evidence_refs[2] = "e1.v2";
    if (reason === "unknown") selection.evidence_refs[2] = "e9.v1";
    if (reason === "comparison") sources[0]!.evidence.metric_descriptors[2]!.value_basis = "较上月";
    if (reason === "percentage")
      sources[0]!.evidence.evidence_items.forEach((item) => {
        item.unit = "%";
      });
    if (reason === "unconfirmed") topic.relationships[0]!.pie_chart = false;
    if (reason === "wrong_total") sources[0]!.evidence.evidence_items[0]!.value = "110";
    if (reason === "unrelated") topic.relationships[0]!.children[1] = "other";
    const result = buildReportChart(sources, selection, "", undefined, topic);
    expect(result.charts).toEqual([]);
    expect(result.notice).toEqual(expect.any(String));
  });

  it.each([false, true])("图表准备后可由正式正文继承，历史=%s时分母也纳入报告来源", async (historical) => {
    const test = fixture();
    if (historical) test.sources[0]!.evidence.execution_turn_id = "old-op";
    const result: unknown = await runTool(createInquiryChartTool(), test.selection, test.request);
    expect(result).toMatchObject({
      details: {
        status: "succeeded",
        selection: { type: "pie" },
        source_refs: ["run.f1", "run.f2", "run.f3"],
      },
    });
    const prepared = result as {
      content: Extract<AgentMessage, { role: "toolResult" }>["content"];
      details: unknown;
    };
    test.messages.push({
      role: "toolResult",
      toolName: "analysis_chart",
      toolCallId: "pie",
      content: prepared.content,
      details: prepared.details,
      isError: false,
      timestamp: 1,
    });
    const answer: unknown = await runTool(
      createInquiryReportTool(),
      { body: "个人{{e1.v2}}，对公{{e1.v3}}。" },
      test.request,
    );
    expect(answer).toMatchObject({
      details: {
        report: { charts: [{ type: "pie", points: [{ share: "75.00%" }, { share: "25.00%" }] }] },
      },
    });
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      run_refs: ["run"],
      context_run_refs: historical ? ["run"] : [],
      focus_refs: historical ? ["run.f2", "run.f3", "run.f1"] : [],
    });
    test.messages.push({ role: "user", content: "下一轮", timestamp: 2 });
    const next: unknown = await runTool(
      createInquiryReportTool(),
      { body: "个人{{e1.v2}}，对公{{e1.v3}}。" },
      test.request,
    );
    expect(next).toMatchObject({ details: { report: { charts: [] } } });
  });

  it("直接提交饼图在来源撤权时阻断，不绕过后端使用本地数值", async () => {
    const test = fixture();
    const body = "个人{{e1.v2}}，对公{{e1.v3}}。";
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body, chart: test.selection },
      test.request,
    );
    expect(result).toMatchObject({ details: { report: { charts: [{ type: "pie" }] } } });
    const forbidden = new BackendApiError(403, "来源权限已失效");
    test.analysisReport.mockRejectedValueOnce(forbidden);
    await expect(
      runTool(createInquiryReportTool(), { body, chart: test.selection }, test.request),
    ).rejects.toBe(forbidden);
  });

  it.each([
    new TypeError("fetch failed"),
    new DOMException("timeout", "AbortError"),
    new BackendApiError(404, "没有组成关系"),
  ])("组成关系读取失败时保留已核验正文：%s", async (error) => {
    const test = fixture();
    test.businessTopic.mockRejectedValueOnce(error);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      {
        body: "个人{{e1.v2}}，对公{{e1.v3}}。",
        chart: test.selection,
      },
      test.request,
    );
    expect(result).toMatchObject({
      details: {
        report: {
          charts: [],
          summary:
            "个人75.00元，对公25.00元。\n\n暂时无法读取组成关系，已保留查询结果，本次未生成饼图。",
        },
      },
    });
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });
});
