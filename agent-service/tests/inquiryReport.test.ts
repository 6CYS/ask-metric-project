import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { createInquiryAnswerTool, inquiryAnswerAttempts } from "../src/inquiry/runtime.js";
import {
  createInquiryReportTool,
  executeInquiryReport,
  createInquiryReportPreview,
  compileInquiryReportDraft,
} from "../src/inquiry/reportTool.js";
import {
  MAX_INVESTIGATION_CALLS,
  MAX_QUERY_METRICS,
  PLAN_METRIC_LIMIT,
} from "../src/inquiry/limits.js";
import type { InquiryTargetSnapshot } from "../src/inquiry/target.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

// 隔离工具边界回归；后端桩不用于本地业务运行或真实模型验收。
function source(run = "run-1", operation = "op-1") {
  return {
    kind: "analysis_evidence",
    status: "succeeded",
    run_ref: run,
    scope_id: operation,
    execution_turn_id: operation,
    result_reused: operation !== "op-1",
    analysis_date: "2026-08-27",
    org_codes: ["A", "B", "C"],
    rows: [],
    date_selection: "latest_snapshot",
    requested_start: null as string | null,
    requested_end: null as string | null,
    plan: {
      requirements: [{ id: "q1", question: "哪些机构的利润下降" }],
      steps: [{ id: "s1", answers: ["q1"], method: "observe", metric_refs: ["m1"] }],
    },
    metric_descriptors: [
      { binding_ref: "m1", code: "P", name: "净利润较同期", unit: "元", value_basis: "yoy" },
    ],
    evidence_items: [
      {
        ref: `${run}.f1`,
        type: "fact",
        metric_code: "P",
        metric_name: "净利润较同期",
        org_code: "A",
        org_name: "甲行",
        date: "2026-08-27",
        unit: "元",
        value: "-5.00",
        display: "-5.00元",
      },
      {
        ref: `${run}.f2`,
        type: "fact",
        metric_code: "P",
        metric_name: "净利润较同期",
        org_code: "B",
        org_name: "乙行",
        date: "2026-08-27",
        unit: "元",
        value: "-3.25",
        display: "-3.25元",
      },
      {
        ref: `${run}.f3`,
        type: "fact",
        metric_code: "P",
        metric_name: "净利润较同期",
        org_code: "C",
        org_name: "丙行",
        date: "2026-08-27",
        unit: "元",
        value: "-1.00",
        display: "-1.00元",
      },
    ],
  };
}

const answer = "甲行净利润较同期减少5.00元。具体原因还需进一步核实。";
function harness(sources = [{ ref: "e1", evidence: source() }]) {
  const reportResponse = {
    kind: "business_report",
    status: "succeeded",
    delivery: "business_evidence_v1",
    answer_policy: "verified_report_v1",
    public_answer: answer,
    gaps: [],
    report: {
      summary: answer,
      sections: [],
      body_evidence: [{ paragraph: 1, evidence_refs: ["run-1.f1"] }],
    },
  };
  const analysisReport = vi
    .fn<(payload: Record<string, unknown>) => Promise<Record<string, unknown>>>()
    .mockResolvedValue(reportResponse);
  const analysisExecute = vi.fn(),
    queryMetric = vi.fn();
  const backend = { analysisReport, analysisExecute, queryMetric } as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {
    originalMessage: "哪些机构的利润下降",
    answerEvidence: () => Promise.resolve(sources),
  });
  return { request, analysisReport, analysisExecute, queryMetric };
}

const failedAnswer: AgentMessage = {
  role: "toolResult",
  toolName: "analysis_answer",
  toolCallId: "attempt",
  timestamp: 0,
  isError: false,
  content: [],
  details: {
    kind: "analysis_answer",
    status: "ARGUMENT_ERROR",
    error_code: "ANALYSIS_REPORT_NUMBER",
  },
};

describe("已执行查询方案的结构报告", () => {
  it("流式与正式交付编译相同章节和带单位的事实引用，且普通body不借上轮布局", async () => {
    const test = harness();
    const user: AgentMessage = { role: "user", content: "比较甲乙", timestamp: 1 };
    const receipt: AgentMessage = {
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
            text: "方案说明",
            org_codes: ["A", "B"],
            report_layout: {
              title: "经营对比",
              sections: [
                { id: "profit", title: "盈利分析", metric_codes: ["P"], table: true },
                { id: "advice", title: "经营建议", metric_codes: [], table: false },
              ],
            },
          },
        },
      },
    };
    test.request.turnMessages = () => Promise.resolve([user, receipt]);
    const input = {
      report: {
        plan_id: "finance",
        overview: "利润需要关注。",
        sections: [
          { section_id: "profit", text: "甲行变化{{e1.v1}}。" },
          { section_id: "advice", text: "建议核实变动原因。" },
        ],
      },
      charts: [],
    };
    const draft = await compileInquiryReportDraft(input, test.request, false);
    expect(draft).toContain("| 净利润较同期 | 2026-08-27 | {{run-1.f1}} | {{run-1.f2}} |");
    const final = await compileInquiryReportDraft(input, test.request, true);
    await executeInquiryReport(input, test.request);
    expect(test.analysisReport.mock.calls[0]?.[0].summary).toBe(
      final?.replace("{{e1.v1}}", "{{run-1.f1}}"),
    );
    expect(test.analysisReport.mock.calls[0]?.[0].summary).not.toContain("丙行");
    test.request.turnMessages = () => Promise.resolve([user, receipt, user]);
    await executeInquiryReport({ body: "甲行{{e1.v1}}。", charts: [] }, test.request);
    expect(test.analysisReport.mock.calls[1]?.[0].summary).toBe("甲行{{run-1.f1}}。");
  });
});

describe("正文与参考查询的范围分离", () => {
  it("本轮独立补查仅在正文引用时作为背景进入报告", async () => {
    const primary = source("primary");
    const reference = { ...source("reference"), inquiry_scope_role: "reference" as const };
    const test = harness([
      { ref: "e1", evidence: primary },
      { ref: "e2", evidence: reference },
    ]);
    await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      run_refs: ["primary"],
      context_run_refs: [],
    });
    await executeInquiryReport({ body: "甲行{{e1.v1}}，参考机构{{e2.v2}}。" }, test.request);
    expect(test.analysisReport.mock.calls[1]?.[0]).toMatchObject({
      run_refs: ["primary", "reference"],
      context_run_refs: ["reference"],
    });
  });

  it("正文恢复复用本轮已选事实，不将选定机构展开成完整查询集合", async () => {
    const test = harness();
    await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request, undefined, true);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      fallback: true,
      focus_refs: ["run-1.f1"],
    });
  });

  it("参考机构的日期覆盖不作为主查询的可用日期依据", async () => {
    const primary = { ...source("primary"), org_codes: ["A"] };
    const reference = {
      ...source("reference"),
      org_codes: ["B"],
      inquiry_scope_role: "reference" as const,
    };
    const test = harness([
      { ref: "e1", evidence: primary },
      { ref: "e2", evidence: reference },
    ]);
    test.request.turnMessages = () =>
      Promise.resolve([
        {
          role: "toolResult",
          toolName: "metric_availability",
          toolCallId: "reference-dates",
          timestamp: 0,
          isError: false,
          content: [],
          details: {
            kind: "data_availability",
            status: "succeeded",
            request: { dimension: "dates", metric_codes: ["P"], org_codes: ["B"] },
          },
        },
      ]);
    await executeInquiryReport({ body: "甲行{{e1.v1}}，乙行{{e2.v2}}。" }, test.request);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      context_run_refs: ["reference"],
    });
    expect(test.analysisReport.mock.calls[0]?.[0]).not.toHaveProperty("availability_requests");
  });
});

describe("报告收尾复用主目标实际执行覆盖", () => {
  const target: InquiryTargetSnapshot = {
    version: 1,
    ref: "target:op-1",
    operationId: "op-1",
    sourceQuestion: "甲乙两行利润对比",
    topic: "利润对比",
    organizations: { codes: ["A", "B"], names: ["甲行", "乙行"] },
    time: { date_selection: "exact", start: "2026-08-27", end: "2026-08-27" },
  };
  function queryReceipt(codes: string[], day = "2026-08-27", operation = "op-1") {
    const evidence = {
      ...source(`run-${codes.join("-")}-${day}`, operation),
      org_codes: codes,
      inquiry_scope: { codes, names: codes },
      inquiry_date: { date_selection: "exact", start: day, end: day },
      date_selection: "exact",
      requested_start: day,
      requested_end: day,
    };
    const message: AgentMessage = {
      role: "toolResult",
      toolName: "metric_query",
      toolCallId: evidence.run_ref,
      timestamp: 0,
      isError: false,
      content: [],
      details: { ...evidence, inquiry_target_snapshot: target },
    };
    return { evidence, message };
  }
  function withQueries(queries: ReturnType<typeof queryReceipt>[]) {
    const test = harness(
      queries.map(({ evidence }, index) => ({ ref: `e${index + 1}`, evidence })),
    );
    test.request.inquiryTargetContext = { version: 1 };
    test.request.answerEvidence = () =>
      Promise.resolve(queries.map(({ evidence }, index) => ({ ref: `e${index + 1}`, evidence })));
    test.request.turnMessages = () => Promise.resolve(queries.map(({ message }) => message));
    return test;
  }

  it.each([
    { label: "只查甲行", queries: [queryReceipt(["A"])], missing: ["B"] },
    { label: "查错期间", queries: [queryReceipt(["A", "B"], "2026-07-31")], missing: ["A", "B"] },
    {
      label: "乙行仅有历史来源",
      queries: [queryReceipt(["A"]), queryReceipt(["B"], "2026-08-27", "old-op")],
      missing: ["B"],
    },
  ])("$label时不能预览或完整交付双机构目标", async ({ queries, missing }) => {
    const test = withQueries(queries);
    test.analysisReport.mockResolvedValueOnce({
      kind: "analysis_report_preview",
      status: "succeeded",
      preview_text: answer,
    });
    expect(await createInquiryReportPreview()("甲行{{e1.v1}}。", test.request)).toBeUndefined();
    expect(test.analysisReport).not.toHaveBeenCalled();

    const result = await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request);
    expect(result).not.toHaveProperty("terminate", true);
    expect(result.details).toMatchObject({
      kind: "analysis_answer",
      status: "ARGUMENT_ERROR",
      error_code: "INQUIRY_TARGET_INCOMPLETE",
      validation_stage: "prerequisite",
      target_coverage: {
        target_ref: target.ref,
        complete: false,
        missing_org_codes: missing,
        requested_time: target.time,
      },
    });
    expect(result.content[0]?.text).toContain("missing_org_codes");
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it("分批覆盖主目标后继续查局部历史期间，不撤回已完成覆盖", async () => {
    const test = withQueries([
      queryReceipt(["A"]),
      queryReceipt(["B"]),
      queryReceipt(["A"], "2026-07-31"),
    ]);
    const result = await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request);
    expect(result).toMatchObject({
      terminate: true,
      details: { kind: "business_report", status: "succeeded" },
    });
    expect(test.analysisReport.mock.calls[0]?.[0]).toHaveProperty("run_refs", [
      "run-A-2026-08-27",
      "run-B-2026-08-27",
      "run-A-2026-07-31",
    ]);
  });

  it("正常零行查询证明目标已执行，可交付缺数说明", async () => {
    const query = queryReceipt(["A", "B"]);
    query.evidence.evidence_items = [];
    query.message.details = { ...query.evidence, row_count: 0, inquiry_target_snapshot: target };
    const test = withQueries([query]);
    test.analysisReport.mockResolvedValue({
      kind: "business_report",
      status: "succeeded",
      public_answer: "目标日期没有数据。",
      report: { summary: "目标日期没有数据。", sections: [] },
    });
    expect(await executeInquiryReport({ body: "目标日期没有数据。" }, test.request)).toMatchObject({
      terminate: true,
      details: { public_answer: "目标日期没有数据。" },
    });
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });

  it("明确多日目标分日查询完成后允许预览和正式回答，缺口只指出未查日期", async () => {
    const multiDayTarget: InquiryTargetSnapshot = {
      ...target,
      time: {
        date_selection: "exact",
        start: "2026-06-30",
        end: "2026-07-31",
        dates: ["2026-06-30", "2026-07-31"],
      },
    };
    const queries = [queryReceipt(["A", "B"], "2026-06-30"), queryReceipt(["A"], "2026-07-31")];
    const attachTarget = (query: ReturnType<typeof queryReceipt>) => {
      query.message.details = { ...query.evidence, inquiry_target_snapshot: multiDayTarget };
      return query;
    };
    queries.forEach(attachTarget);
    const test = withQueries(queries);
    const incomplete = await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request);
    expect(incomplete.details).toMatchObject({
      validation_stage: "prerequisite",
      target_coverage: {
        missing_queries: [
          {
            org_code: "B",
            time: {
              date_selection: "exact",
              start: "2026-07-31",
              end: "2026-07-31",
              dates: ["2026-07-31"],
            },
          },
        ],
      },
    });
    queries.push(attachTarget(queryReceipt(["B"], "2026-07-31")));
    test.analysisReport.mockResolvedValueOnce({
      kind: "analysis_report_preview",
      status: "succeeded",
      preview_text: answer,
    });
    expect(await createInquiryReportPreview()("甲行{{e1.v1}}。", test.request)).toBe(answer);
    expect(await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request)).toMatchObject({
      terminate: true,
      details: { status: "succeeded", target_coverage: { complete: true } },
    });
    expect(test.analysisReport).toHaveBeenCalledTimes(2);
    expect(test.analysisReport.mock.calls[1]?.[0]).toMatchObject({
      run_refs: ["run-A-B-2026-06-30", "run-A-2026-07-31", "run-B-2026-07-31"],
    });
  });

  it("查询失败不能当成零行完成", async () => {
    const failed = queryReceipt(["B"]);
    failed.message.details = {
      ...failed.evidence,
      status: "failed",
      inquiry_target_snapshot: target,
    };
    const test = withQueries([queryReceipt(["A"]), failed]);
    const result = await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request);
    expect(result.details).toMatchObject({
      error_code: "INQUIRY_TARGET_INCOMPLETE",
      target_coverage: { missing_org_codes: ["B"] },
    });
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it("预算恢复仅交付已查部分并保留目标缺口，不伪装完整回答", async () => {
    const test = withQueries([queryReceipt(["A"])]);
    const result = await executeInquiryReport(
      { body: "甲行{{e1.v1}}。" },
      test.request,
      undefined,
      true,
    );
    expect(result).toMatchObject({
      terminate: true,
      details: { kind: "business_report", partial_analysis: true },
    });
    expect(result.details).toHaveProperty(
      "target_coverage",
      expect.objectContaining({ missing_org_codes: ["B"] }),
    );
    expect(result.content[0]?.text).toContain("乙行");
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      fallback: true,
      run_refs: ["run-A-2026-08-27"],
    });
  });

  it("没有本轮显式目标的旧协议和纯历史追问不新增目标义务", async () => {
    const test = harness([{ ref: "e1", evidence: source("history", "old-op") }]);
    test.request.inquiryTargetContext = {
      version: 1,
      baseline: { ...target, operationId: "old-op", ref: "target:old-op" },
    };
    expect(await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request)).toMatchObject({
      terminate: true,
    });
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({ context_run_refs: ["history"] });
  });
});

describe("问数正文预览复用报告来源转换", () => {
  const previewResponse = {
    kind: "analysis_report_preview",
    status: "succeeded",
    preview_text: "甲行净利润较同期减少5.00元。",
  };

  it.each(["未声明目标", "已可信受理"])("%s的预览不读取无用历史，正式报告仍读取", async (mode) => {
    const test = harness();
    if (mode === "已可信受理") {
      test.request.inquiryTargetContext = { version: 1 };
      test.request.inquiryAdmission = { targets: [], answerReceipts: [] };
    }
    const turnMessages = vi
      .fn<() => Promise<AgentMessage[]>>()
      .mockRejectedValue(new Error("无关历史读取暂不可用"));
    test.request.turnMessages = turnMessages;
    test.analysisReport.mockResolvedValueOnce(previewResponse);

    expect(await createInquiryReportPreview()("甲行{{e1.v1}}。", test.request)).toBe(
      previewResponse.preview_text,
    );
    expect(turnMessages).not.toHaveBeenCalled();

    turnMessages.mockResolvedValue([]);
    expect(await executeInquiryReport({ body: "甲行{{e1.v1}}。" }, test.request)).toMatchObject({
      terminate: true,
      details: { status: "succeeded", public_answer: answer },
    });
    expect(turnMessages).toHaveBeenCalledOnce();
  });

  it("带来源映射的普通预览不因自动选图额外读取历史", async () => {
    const test = harness();
    const turnMessages = vi
      .fn<() => Promise<AgentMessage[]>>()
      .mockRejectedValue(new Error("无关历史读取暂不可用"));
    test.request.turnMessages = turnMessages;
    test.analysisReport.mockResolvedValueOnce({
      ...previewResponse,
      body_evidence: [{ paragraph: 1, evidence_refs: ["run-1.f1"] }],
    });
    expect(await createInquiryReportPreview()("甲行{{e1.v1}}。", test.request)).toEqual({
      text: previewResponse.preview_text,
      charts: [],
    });
    expect(turnMessages).not.toHaveBeenCalled();
  });

  it("分组图失败后的单图恢复仍复用已解析方案，不再次读取历史", async () => {
    const evidence = source();
    const profits = evidence.evidence_items.slice(0, 2);
    evidence.metric_descriptors.push({
      binding_ref: "m2", code: "Q", name: "费用较同期", unit: "万元", value_basis: "yoy",
    });
    evidence.evidence_items = [...profits, ...profits.map((atom, index) => ({
      ...atom,
      ref: `run-1.q${index + 1}`,
      metric_code: "Q",
      metric_name: "费用较同期",
      unit: "万元",
      display: `${atom.value}万元`,
    }))];
    const test = harness([{ ref: "e1", evidence }]);
    const turnMessages = vi.fn<() => Promise<AgentMessage[]>>().mockResolvedValue([]);
    test.request.turnMessages = turnMessages;
    test.analysisReport.mockResolvedValueOnce({
      kind: "business_report",
      status: "succeeded",
      public_answer: "已核验正文。",
      report: {
        summary: "已核验正文。",
        sections: [],
        body_evidence: [{ paragraph: 1, evidence_refs: ["run-1.f1", "run-1.q1"] }],
      },
    });
    const result = await executeInquiryReport({
      body: "甲行利润{{e1.v1}}，费用{{e1.v3}}。",
      charts: [{
        type: "grouped_bar", evidence_refs: evidence.evidence_items.map(atom => atom.ref),
      }],
    }, test.request);
    expect(result).toMatchObject({
      details: { report: { charts: [{ type: "bar" }, { type: "bar" }] } },
    });
    expect(turnMessages).toHaveBeenCalledOnce();
  });

  it("历史标题前缀等待真实引用，补齐后继续预览，未知引用仍拒绝", async () => {
    const test = harness([{ ref: "e1", evidence: source("history", "old-op") }]);
    const preview = createInquiryReportPreview();
    const title = "**关键数据**";
    expect(await preview(title, test.request)).toBeNull();
    expect(test.analysisReport).not.toHaveBeenCalled();

    const text = title + "\n\n甲行净利润较同期减少5.00元。";
    test.analysisReport.mockResolvedValue({ ...previewResponse, preview_text: text });
    expect(await preview(title + "\n\n甲行{{e1.v1}}。", test.request)).toBe(text);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      summary: "**关键数据**\n\n甲行{{history.f1}}。",
      context_run_refs: ["history"],
      focus_refs: ["history.f1"],
      preview: true,
    });

    expect(await preview(title + "\n\n甲行{{e99.v1}}。", test.request)).toBeUndefined();
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });

  it("仅返回后端核验文本，转换短引用和坐标，不携带日期查询或正式交付状态", async () => {
    const test = harness();
    const messages: AgentMessage[] = [
      failedAnswer,
      {
        role: "toolResult",
        toolName: "metric_availability",
        toolCallId: "availability",
        timestamp: 1,
        isError: false,
        content: [],
        details: {
          kind: "data_availability",
          status: "succeeded",
          request: { dimension: "dates", metric_codes: ["P"], org_codes: ["A"] },
        },
      },
    ];
    test.request.turnMessages = () => Promise.resolve(messages);
    test.analysisReport.mockResolvedValue(previewResponse);
    const controller = new AbortController();

    const preview = await createInquiryReportPreview()(
      "甲行净利润较同期减少{{e1.v1|org=A|metric=P|date=2026-08-27}}。",
      test.request,
      controller.signal,
    );

    expect(preview).toBe("甲行净利润较同期减少5.00元。");
    expect(test.analysisReport).toHaveBeenCalledWith(
      {
        preview: true,
        run_refs: ["run-1"],
        context_run_refs: [],
        focus_refs: [],
        summary: "甲行净利润较同期减少{{run-1.f1}}。",
        fact_bindings: [{ ref: "run-1.f1", org_code: "A", metric_code: "P", date: "2026-08-27" }],
        sections: [],
      },
      { signal: controller.signal },
    );
    expect(inquiryAnswerAttempts(messages)).toBe(1);
    expect(test.request.commands).toMatchObject({ record: undefined, conversationId: null });
    expect(test.analysisExecute).not.toHaveBeenCalled();
    expect(test.queryMetric).not.toHaveBeenCalled();
    expect(createInquiryReportTool().parameters.properties).not.toHaveProperty("preview");
  });

  it("历史追问复用计算身份及父事实，不重新计算或扩展历史目标", async () => {
    const test = harness([{ ref: "e1", evidence: source("history", "old-op") }]);
    test.request.answerEvidence = () =>
      Promise.resolve([
        { ref: "e1", evidence: source("history", "old-op") },
        {
          ref: "e2",
          evidence: {
            kind: "metric_calculate",
            status: "succeeded",
            execution_turn_id: "op-1",
            calculation_ref: { task_id: "task", calculation_id: "calc" },
            run_refs: ["history"],
            inputs: {
              current: { task_id: "task", fact_id: "fact-1" },
              base: { task_id: "task", fact_id: "fact-2" },
            },
            limitations: [],
            evidence_items: [
              {
                ref: "calculation.calc.difference",
                type: "calculation",
                name: "difference",
                value: "-1.75",
                unit: "元",
                display: "-1.75元",
                input_refs: ["history.f1", "history.f2"],
              },
            ],
          },
        },
      ]);
    test.analysisReport.mockResolvedValue({ ...previewResponse, preview_text: "差额-1.75元。" });

    expect(await createInquiryReportPreview()("差额{{e2.v1}}。", test.request)).toBe(
      "差额-1.75元。",
    );
    expect(test.analysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: true,
        run_refs: ["history"],
        context_run_refs: ["history"],
        focus_refs: ["calculation.calc.difference"],
        calculation_refs: [{ task_id: "task", calculation_id: "calc" }],
        summary: "差额{{calculation.calc.difference}}。",
      }),
      expect.anything(),
    );
  });

  it.each(["{{e99.v1}}", "{{e1.v1", " "])("未通过现有本地引用校验不发预览：%s", async (body) => {
    const test = harness();
    expect(await createInquiryReportPreview()(body, test.request)).toBeUndefined();
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it.each([new BackendApiError(422, "数值未验证", "ANALYSIS_REPORT_NUMBER")])(
    "校验失败只放弃预览，不产生正式失败回执",
    async (error) => {
      const test = harness();
      const messages = [failedAnswer];
      test.request.turnMessages = () => Promise.resolve(messages);
      test.analysisReport.mockRejectedValue(error);
      expect(await createInquiryReportPreview()("{{e1.v1}}", test.request)).toBeUndefined();
      expect(inquiryAnswerAttempts(messages)).toBe(1);
      expect(test.analysisReport).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { kind: "business_report", status: "succeeded", public_answer: "正式回答" },
    { ...previewResponse, preview_text: " " },
    { ...previewResponse, status: "failed" },
  ])("只接受成功且非空的预览契约", async (response) => {
    const test = harness();
    test.analysisReport.mockResolvedValue(response);
    await expect(createInquiryReportPreview()("{{e1.v1}}", test.request)).rejects.toThrow(
      "Invalid report preview response",
    );
  });

  it.each([
    new Error("服务暂不可用"),
    new BackendApiError(503, "服务暂不可用"),
    new DOMException("超时", "AbortError"),
  ])("临时错误保留分类交由观察器有界处理", async (error) => {
    const test = harness();
    test.analysisReport.mockRejectedValue(error);
    await expect(createInquiryReportPreview()("{{e1.v1}}", test.request)).rejects.toBe(error);
  });

  it.each([401, 403])("权限失败%s保持阻断", async (status) => {
    const test = harness();
    const error = new BackendApiError(status, "无权读取", "ANALYSIS_FORBIDDEN");
    test.analysisReport.mockRejectedValue(error);
    await expect(createInquiryReportPreview()("{{e1.v1}}", test.request)).rejects.toBe(error);
  });

  it("取消后不再发送预览请求，进行中取消也不返回已取得的文本", async () => {
    const test = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createInquiryReportPreview()("{{e1.v1}}", test.request, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(test.analysisReport).not.toHaveBeenCalled();

    const running = new AbortController();
    test.analysisReport.mockImplementation(() => {
      running.abort();
      return Promise.resolve(previewResponse);
    });
    await expect(
      createInquiryReportPreview()("{{e1.v1}}", test.request, running.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("普通调查的事实回答出口", () => {
  it("引用坐标只做协议转换，不根据原子自动填充声明", async () => {
    const test = harness();
    await runTool(
      createInquiryReportTool(),
      {
        body: "甲行{{e1.v1|org=A|metric=P|date=2026-08-27}}，乙行-3.25元{{e1.v2|org=B|metric=P|date=2026-08-27|cite}}。",
      },
      test.request,
    );
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      summary: "甲行{{run-1.f1}}，乙行-3.25元{{run-1.f2|cite}}。",
      fact_bindings: [
        { ref: "run-1.f1", org_code: "A", metric_code: "P", date: "2026-08-27" },
        { ref: "run-1.f2", org_code: "B", metric_code: "P", date: "2026-08-27" },
      ],
    });
    await runTool(createInquiryReportTool(), { body: "{{e1.v1}}" }, test.request);
    expect(test.analysisReport.mock.calls[1]?.[0]).toHaveProperty("fact_bindings", []);
  });

  it.each(["e1.v1|org=A", "e1.v1|org=A|org=B|metric=P|date=2026-08-27", "e1.v1|invalid=x"])(
    "错误的引用协议可局部修正，不被当作服务异常：%s",
    async (reference) => {
      const test = harness();
      const result: unknown = await runTool(
        createInquiryReportTool(),
        { body: `{{${reference}}}` },
        test.request,
      );
      expect(test.analysisReport).not.toHaveBeenCalled();
      expect(result).toHaveProperty(
        "details",
        expect.objectContaining({
          status: "ARGUMENT_ERROR",
          error_code: "ANALYSIS_REPORT_FORMAT",
        }),
      );
    },
  );

  it.each(["{{e1.v1|org=A|metric=P|date=2026-08-27}", "{{e1.v1", "e1.v1}}", "{{}}"])(
    "未闭合或空引用不会泄露到公开正文：%s",
    async (body) => {
      const test = harness();
      const result: unknown = await runTool(createInquiryReportTool(), { body }, test.request);
      expect(test.analysisReport).not.toHaveBeenCalled();
      expect(result).toHaveProperty(
        "details",
        expect.objectContaining({
          status: "ARGUMENT_ERROR",
          error_code: "ANALYSIS_REPORT_FORMAT",
        }),
      );
    },
  );

  it("只转交本轮所选来源范围内的成功日期请求，由后端重新查询而不相信回执日期", async () => {
    const test = harness();
    const spec = {
      dimension: "dates",
      metric_codes: ["P"],
      org_codes: ["A"],
      start: "2026-01-01",
      end: "2026-10-26",
    };
    const receipt = (request: typeof spec, isError = false): AgentMessage => ({
      role: "toolResult",
      toolName: "metric_availability",
      toolCallId: "coverage",
      timestamp: 0,
      isError,
      content: [],
      details: {
        kind: "data_availability",
        status: "succeeded",
        request,
        groups: [{ dates: ["2099-01-01"] }],
      },
    });
    test.request.turnMessages = () =>
      Promise.resolve([
        receipt({ ...spec, start: "2025-01-01" }),
        { role: "user", content: "当前问题", timestamp: 1 },
        receipt(spec),
        receipt(spec),
        receipt({ ...spec, metric_codes: ["UNRELATED"] }),
        receipt({ ...spec, org_codes: ["OUTSIDE"] }),
        receipt({ ...spec, start: "2026-02-01" }, true),
      ]);
    await runTool(createInquiryReportTool(), { body: "甲行{{e1.v1}}。" }, test.request);
    expect(test.analysisReport).toHaveBeenCalledWith(
      expect.objectContaining({ availability_requests: [spec] }),
      expect.anything(),
    );
    expect(test.analysisReport.mock.calls[0]![0]).not.toHaveProperty("allowed_dates");
  });

  it("时间切换仅透传本轮已核验查询的备选，历史备选不复活", async () => {
    const variants = [{ label: "按完整年度", start: "2024-01-01", end: "2025-12-31" }];
    const current = { ...source(), time_variants: variants };
    const historical = {
      ...source("old", "old-op"),
      time_variants: [{ label: "旧备选", start: "2020-01-01", end: "2020-12-31" }],
    };
    const test = harness([
      { ref: "e1", evidence: current },
      { ref: "e2", evidence: historical },
    ]);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toMatchObject({ details: { time_variants: variants } });
    test.request.timeOverride = { start: "2024-01-01", end: "2025-12-31" };
    const switched: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(switched).not.toHaveProperty("details.time_variants");
  });

  it("默认使用成功来源，将自然正文引用交后端校验并保持正式正文", async () => {
    const test = harness();
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行净利润较同期减少{{e1.v1}}。\n\n具体原因还需进一步核实。" },
      test.request,
    );
    expect(result).toMatchObject({
      terminate: true,
      content: [{ text: answer }],
      details: {
        kind: "business_report",
        public_answer: answer,
        report: { summary: answer },
      },
    });
    expect(test.analysisReport).toHaveBeenCalledWith(
      {
        run_refs: ["run-1"],
        context_run_refs: [],
        focus_refs: [],
        summary: "甲行净利润较同期减少{{run-1.f1}}。\n\n具体原因还需进一步核实。",
        fact_bindings: [],
        sections: [],
      },
      expect.anything(),
    );
    expect(test.analysisExecute).not.toHaveBeenCalled();
    expect(test.queryMetric).not.toHaveBeenCalled();
  });

  it("允许同一指标和机构不限定日期查覆盖，不把实际可用日期作为模型提交的事实", async () => {
    const test = harness();
    const spec = { dimension: "dates", metric_codes: ["P"], org_codes: ["A"] };
    test.request.turnMessages = () =>
      Promise.resolve([
        {
          role: "toolResult",
          toolName: "metric_availability",
          toolCallId: "coverage",
          timestamp: 0,
          isError: false,
          content: [],
          details: { kind: "data_availability", status: "succeeded", request: spec },
        },
      ]);
    await runTool(createInquiryReportTool(), { body: "甲行{{e1.v1}}。" }, test.request);
    expect(test.analysisReport).toHaveBeenCalledWith(
      expect.objectContaining({ availability_requests: [spec] }),
      expect.anything(),
    );
  });

  it("Markdown表格转义不改变引用坐标", async () => {
    const test = harness();
    await runTool(
      createInquiryReportTool(),
      { body: "| 数值 |\n|---|\n| {{e1.v1\\|org=A\\|metric=P\\|date=2026-08-27}} |" },
      test.request,
    );
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      fact_bindings: [{ ref: "run-1.f1", org_code: "A", metric_code: "P", date: "2026-08-27" }],
    });
  });

  it.each(["e99.v1", "outside.f1"])("未知正文引用 %s 在调用后端前拒绝", async (ref) => {
    const test = harness();
    test.request.turnMessages = () => Promise.resolve([failedAnswer]);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: `甲行{{${ref}}}。` },
      test.request,
    );
    expect(result).toMatchObject({
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        error_code: "ANALYSIS_REPORT_REFERENCE",
      },
    });
    expect(result).not.toHaveProperty("terminate", true);
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it("追问收尾保留全部本轮来源，历史仅带入正文实际引用的来源", async () => {
    const test = harness([
      { ref: "e1", evidence: source() },
      { ref: "e2", evidence: source("run-2", "old-op") },
      { ref: "e3", evidence: source("run-3", "old-op") },
    ]);
    test.analysisReport.mockImplementation((payload) => {
      expect(payload.run_refs).toEqual(["run-1", "run-2"]);
      expect(payload.context_run_refs).toEqual(["run-2"]);
      return Promise.resolve({
        kind: "business_report",
        status: "succeeded",
        delivery: "business_evidence_v1",
        answer_policy: "verified_report_v1",
        public_answer: answer,
        gaps: [],
        report: {
          summary: answer,
          sections: [],
          body_evidence: [{ paragraph: 1, evidence_refs: ["run-3.f1"] }],
        },
      });
    });
    const tool = createInquiryReportTool();
    const previous = {
      body: "甲行{{e2.v1}}，乙行{{e1.v2}}。\n\n甲行净利润较同期减少5.00元。",
      evidence_refs: ["e1", "e2"],
    };
    const result: unknown = await runTool(
      tool,
      tool.prepareArguments?.(previous) ?? previous,
      test.request,
    );
    expect(result).toHaveProperty(
      "details",
      expect.objectContaining({ kind: "business_report", status: "succeeded" }),
    );
    expect(result).toHaveProperty("terminate", true);
  });

  it("已引用历史判断的跨运行父事实一起鉴权，无关历史不进入报告", async () => {
    const test = harness();
    test.request.answerEvidence = () =>
      Promise.resolve([
        { ref: "e1", evidence: source("current") },
        { ref: "e2", evidence: source("parent", "old-op") },
        {
          ref: "e3",
          evidence: {
            ...source("judgment", "old-op"),
            evidence_items: [
              {
                ref: "judgment.j1",
                type: "observation",
                judgment_kind: "comparison",
                input_refs: ["parent.f1"],
              },
            ],
          },
        },
        { ref: "e4", evidence: source("unused", "old-op") },
      ]);
    const result = await executeInquiryReport({ body: "甲行下降{{e3.j1|cite}}。" }, test.request);
    expect(result).toHaveProperty("terminate", true);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      run_refs: ["current", "parent", "judgment"],
      context_run_refs: ["parent", "judgment"],
    });
  });

  it("同一运行历史重读不会把本轮查询标成历史，且只向后端鉴权一次", async () => {
    const test = harness([
      { ref: "e1", evidence: source("current") },
      { ref: "e2", evidence: source("current", "old-op") },
    ]);
    await executeInquiryReport({ body: "甲行{{e2.v1}}。" }, test.request);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      run_refs: ["current"],
      context_run_refs: [],
    });
  });

  it("历史来源始终按正文引用选取，仍保留本轮实际查询的目标", async () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({
      ref: `e${index + 1}`,
      evidence: source(`run-${index + 1}`, index === 6 ? "op-1" : "old-op"),
    }));
    const test = harness(sources);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}，乙行{{e7.v2}}。" },
      test.request,
    );
    expect(result).toHaveProperty("terminate", true);
    expect(test.analysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        run_refs: ["run-1", "run-7"],
        context_run_refs: ["run-1"],
        focus_refs: [],
      }),
      expect.anything(),
    );
  });

  it.each([13, MAX_INVESTIGATION_CALLS * Math.ceil(MAX_QUERY_METRICS / PLAN_METRIC_LIMIT)])(
    "%i个本轮来源在预览、正式交付及恢复中均保留完整目标",
    async (count) => {
      const sources = Array.from({ length: count }, (_, index) => ({
        ref: `e${index + 1}`,
        evidence: source(`run-${index + 1}`),
      }));
      const test = harness(sources);
      const input = { body: "甲行{{e1.v1}}。" };
      test.analysisReport.mockResolvedValueOnce({
        kind: "analysis_report_preview",
        status: "succeeded",
        preview_text: "甲行-5.00元。",
      });
      await createInquiryReportPreview()(input.body, test.request);
      const normal = await executeInquiryReport(input, test.request);
      const recovered = await executeInquiryReport(input, test.request, undefined, true);
      expect(normal).toHaveProperty("terminate", true);
      expect(recovered).toHaveProperty("details.partial_analysis", true);
      expect(test.analysisReport).toHaveBeenCalledTimes(3);
      for (const [payload] of test.analysisReport.mock.calls) {
        expect(payload.run_refs).toEqual(sources.map((item) => item.evidence.run_ref));
        expect(payload.context_run_refs).toEqual([]);
      }
    },
  );

  it("历史来源超过上限时，先前准备的图表来源也须纳入后端鉴权", async () => {
    const test = harness(
      Array.from({ length: 7 }, (_, index) => ({
        ref: `e${index + 1}`,
        evidence: source(`run-${index + 1}`, index === 6 ? "op-1" : "old-op"),
      })),
    );
    test.request.turnMessages = () =>
      Promise.resolve([
        {
          role: "toolResult",
          toolName: "analysis_chart",
          toolCallId: "chart",
          timestamp: 0,
          isError: false,
          content: [],
          details: {
            kind: "inquiry_chart",
            status: "succeeded",
            selection: { type: "bar", evidence_refs: ["run-5.f1", "run-6.f2"] },
            source_refs: ["run-5.f1", "run-6.f2"],
            run_refs: ["run-5", "run-6"],
          },
        },
      ]);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}，乙行{{e7.v2}}。" },
      test.request,
    );
    expect(result).toHaveProperty("terminate", true);
    expect(test.analysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        run_refs: ["run-1", "run-5", "run-6", "run-7"],
        context_run_refs: ["run-1", "run-5", "run-6"],
      }),
      expect.anything(),
    );
    expect(result).toHaveProperty("details.report.charts[0].source_refs", ["run-5.f1", "run-6.f2"]);
  });

  it("失效预备图不占用历史来源名额，六个当前查询目标仍完整交付", async () => {
    const test = harness(
      Array.from({ length: 7 }, (_, index) => ({
        ref: `e${index + 1}`,
        evidence: source(`run-${index + 1}`, index < 6 ? "op-1" : "old-op"),
      })),
    );
    test.request.turnMessages = () =>
      Promise.resolve([
        {
          role: "toolResult",
          toolName: "analysis_chart",
          toolCallId: "chart",
          timestamp: 0,
          isError: false,
          content: [],
          details: {
            kind: "inquiry_chart",
            status: "succeeded",
            selection: { type: "bar", evidence_refs: ["run-7.f1", "unavailable.f2"] },
            source_refs: ["run-7.f1", "unavailable.f2"],
            run_refs: ["run-7", "unavailable"],
          },
        },
      ]);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toMatchObject({
      terminate: true,
      details: { kind: "business_report", status: "succeeded" },
    });
    expect(test.analysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        run_refs: ["run-1", "run-2", "run-3", "run-4", "run-5", "run-6"],
        context_run_refs: [],
        focus_refs: [],
      }),
      expect.anything(),
    );
    expect(result).toHaveProperty("details.report.charts", []);
    expect(result).toHaveProperty("details.public_answer", expect.stringContaining(answer));
    expect(result).toHaveProperty("details.public_answer", expect.stringContaining("图表"));
  });

  it("失败来源不能用于正式回答", async () => {
    const test = harness([{ ref: "e1", evidence: { ...source(), status: "failed" } }]);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toHaveProperty("details.error_code", "ANALYSIS_REPORT_EVIDENCE");
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it.each(["ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_SCOPE"])(
    "%s 原样返回，只校验一次，不触发事实列表回退或补查",
    async (code) => {
      const test = harness();
      const message = "正文第2段引用了口径未确认的比例，暂不用于分析。";
      test.analysisReport.mockRejectedValue(new BackendApiError(422, message, code));
      const result: unknown = await runTool(
        createInquiryReportTool(),
        { body: "甲行{{e1.v1}}。" },
        test.request,
      );
      expect(result).toMatchObject({
        content: [{ text: message }],
        details: {
          kind: "analysis_answer",
          status: "ARGUMENT_ERROR",
          error_code: code,
          retryable: true,
        },
      });
      expect(result).not.toHaveProperty("terminate", true);
      expect(test.analysisReport).toHaveBeenCalledOnce();
      expect(test.analysisReport.mock.calls[0]![0]).not.toHaveProperty("fallback");
      expect(test.analysisExecute).not.toHaveBeenCalled();
      expect(test.queryMetric).not.toHaveBeenCalled();
    },
  );

  it("事实恢复前置说明不改变两段事实各自的来源对应关系", async () => {
    const test = harness();
    test.analysisReport.mockResolvedValueOnce({
      kind: "business_report",
      status: "succeeded",
      public_answer: "甲行减少5元。\n\n乙行减少3.25元。",
      report: {
        summary: "甲行减少5元。\n\n乙行减少3.25元。",
        sections: [],
        body_evidence: [
          { paragraph: 1, evidence_refs: ["run-1.f1"] },
          { paragraph: 2, evidence_refs: ["run-1.f2"] },
        ],
      },
    });
    const result = await executeInquiryReport(
      { body: "甲行{{e1.v1}}，乙行{{e1.v2}}。" },
      test.request,
      undefined,
      true,
    );
    expect(result).toHaveProperty("details.report.body_evidence", [
      { paragraph: 2, evidence_refs: ["run-1.f1"] },
      { paragraph: 3, evidence_refs: ["run-1.f2"] },
    ]);
    expect(result).toHaveProperty(
      "details.report.summary",
      expect.stringContaining("甲行减少5元。\n\n乙行减少3.25元。"),
    );
  });

  it("参数失败后首次正文数字错误交回模型局部修正，不清空分析内容", async () => {
    const test = harness();
    test.request.turnMessages = () => Promise.resolve([{ ...failedAnswer, details: undefined }]);
    test.analysisReport.mockRejectedValueOnce(
      new BackendApiError(422, "正文第2段比例缺少计算依据", "ANALYSIS_REPORT_NUMBER"),
    );
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toMatchObject({
      details: { status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_NUMBER" },
    });
    expect(result).not.toHaveProperty("terminate", true);
    expect(test.analysisReport).toHaveBeenCalledOnce();
    expect(test.analysisReport.mock.calls[0]![0]).not.toHaveProperty("fallback");
  });

  it("报告工具只返回本次校验结果，不根据历史回执自行重试", async () => {
    const test = harness();
    test.request.turnMessages = () => Promise.resolve([failedAnswer]);
    test.analysisReport.mockRejectedValue(
      new BackendApiError(422, "正文数字无依据", "ANALYSIS_REPORT_NUMBER"),
    );
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toMatchObject({
      details: { status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_NUMBER" },
    });
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("%s 保持鉴权阻断，不交付已有来源", async (status) => {
    const test = harness();
    const error = new BackendApiError(status, "无权读取来源", "ANALYSIS_FORBIDDEN");
    test.analysisReport.mockRejectedValue(error);
    await expect(
      runTool(createInquiryReportTool(), { body: "甲行{{e1.v1}}。" }, test.request),
    ).rejects.toBe(error);
    expect(test.analysisReport).toHaveBeenCalledOnce();
    expect(test.analysisExecute).not.toHaveBeenCalled();
  });

  it("未知交付异常保留可追踪诊断，不把异常内容发给模型或重复重试", async () => {
    const test = harness();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    test.analysisReport.mockRejectedValue(new TypeError("secret SQL\npassword=private"));
    try {
      const result: unknown = await runTool(
        createInquiryReportTool(),
        { body: "甲行{{e1.v1}}。" },
        test.request,
      );
      expect(result).toMatchObject({
        details: {
          status: "error",
          retryable: false,
          error_code: "INQUIRY_REPORT_FAILED",
        },
      });
      expect(log).toHaveBeenCalledOnce();
      const diagnostic: unknown = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(diagnostic).toMatchObject({
        event: "inquiry_report_failed",
        request_id: test.request.requestId,
        operation_id: test.request.operationId,
        error_type: "TypeError",
      });
      expect(JSON.stringify([result, diagnostic])).not.toMatch(/secret SQL|password=private/);
      expect(test.analysisReport).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("空结果正文修正仍失败时，由后端重验原始零行后交付缺数说明", async () => {
    const test = harness([
      { ref: "e1", evidence: { ...source(), evidence_items: [], analysis_date: "" } },
    ]);
    test.request.turnMessages = () =>
      Promise.resolve([
        {
          role: "toolResult",
          toolName: "analysis_answer",
          toolCallId: "attempt",
          timestamp: 0,
          isError: false,
          content: [],
          details: { kind: "analysis_answer", status: "ARGUMENT_ERROR" },
        },
      ]);
    test.analysisReport.mockRejectedValueOnce(
      new BackendApiError(422, "正文数值未通过校验", "ANALYSIS_REPORT_NUMBER"),
    );
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      { body: "未通过校验的草稿。" },
      test.request,
    );
    expect(result).toHaveProperty("terminate", true);
    expect(test.analysisReport).toHaveBeenCalledTimes(2);
    expect(test.analysisReport.mock.calls[1]![0]).toMatchObject({
      summary: "",
      sections: [],
      fallback: true,
      run_refs: ["run-1"],
    });
    expect(test.analysisExecute).not.toHaveBeenCalled();
    expect(test.queryMetric).not.toHaveBeenCalled();
  });

  it.each(["current", "mixed", "reuse"])(
    "%s有数据的正文修正仍失败时交付后端事实兜底，保留原来源和追问范围",
    async (mode) => {
      const sources = [
        { ref: "e1", evidence: source("run-1", mode === "reuse" ? "old-op" : "op-1") },
        ...(mode === "mixed" ? [{ ref: "e2", evidence: source("run-2", "old-op") }] : []),
      ];
      const test = harness(sources);
      test.request.turnMessages = () =>
        Promise.resolve([
          failedAnswer,
          {
            role: "toolResult",
            toolName: "analysis_chart",
            toolCallId: "chart",
            timestamp: 1,
            isError: false,
            content: [],
            details: {
              kind: "inquiry_chart",
              status: "succeeded",
              selection: { type: "bar", evidence_refs: ["run-1.f1", "run-1.f2"] },
              source_refs: ["run-1.f1", "run-1.f2"],
              run_refs: ["run-1"],
            },
          },
        ]);
      test.analysisReport.mockRejectedValueOnce(
        new BackendApiError(422, "草稿数字无依据", "ANALYSIS_REPORT_NUMBER"),
      );
      const result: unknown = await runTool(
        createInquiryAnswerTool(),
        { body: "甲行{{e1.v1}}，乙行{{e1.v2}}。未核验阈值999元。" },
        test.request,
      );
      expect(result).toMatchObject({
        terminate: true,
        details: {
          kind: "business_report",
          status: "succeeded",
          partial_analysis: true,
          fallback_reason: "corrections_exhausted",
        },
      });
      expect(test.analysisReport).toHaveBeenCalledTimes(2);
      expect(test.analysisReport.mock.calls[1]![0]).toEqual({
        run_refs: ["run-1"],
        context_run_refs: mode === "reuse" ? ["run-1"] : [],
        focus_refs: ["run-1.f1", "run-1.f2"],
        summary: "",
        sections: [],
        fact_bindings: [],
        fallback: true,
      });
      expect(result).toHaveProperty("details.public_answer", expect.stringContaining(answer));
      expect(result).toHaveProperty(
        "details.public_answer",
        expect.stringContaining("未能完成分析回答"),
      );
      expect(result).toHaveProperty(
        "details.report.summary",
        expect.stringContaining("未能完成分析回答"),
      );
      expect(result).toHaveProperty("details.report.charts[0].source_refs", [
        "run-1.f1",
        "run-1.f2",
      ]);
      expect(test.analysisExecute).not.toHaveBeenCalled();
      expect(test.queryMetric).not.toHaveBeenCalled();
    },
  );

  it.each(["body", "chart", "prepared"])(
    "%s明确选择的事实进入恢复范围，本轮与历史不扩大选择",
    async (selection) => {
      const test = harness([
        { ref: "e1", evidence: source("current") },
        { ref: "e2", evidence: source("history", "old-op") },
        { ref: "e3", evidence: source("unselected-history", "old-op") },
        { ref: "e4", evidence: source("current-other") },
      ]);
      const chart = { type: "bar" as const, evidence_refs: ["current.f1", "history.f2"] };
      test.request.turnMessages = () =>
        Promise.resolve([
          failedAnswer,
          ...(selection === "prepared"
            ? [
                {
                  role: "toolResult" as const,
                  toolName: "analysis_chart",
                  toolCallId: "chart",
                  timestamp: 1,
                  isError: false,
                  content: [],
                  details: {
                    kind: "inquiry_chart",
                    status: "succeeded",
                    selection: chart,
                    source_refs: chart.evidence_refs,
                    run_refs: ["current", "history"],
                  },
                },
              ]
            : []),
        ]);
      test.analysisReport
        .mockRejectedValueOnce(new BackendApiError(422, "草稿数字无依据", "ANALYSIS_REPORT_NUMBER"))
        .mockResolvedValueOnce({
          kind: "business_report",
          status: "succeeded",
          delivery: "business_evidence_v1",
          answer_policy: "verified_report_v1",
          public_answer: answer,
          gaps: [],
          report: {
            summary: answer,
            sections: [],
            body_evidence: [{ paragraph: 1, evidence_refs: chart.evidence_refs }],
          },
        });
      const result: unknown = await runTool(
        createInquiryAnswerTool(),
        {
          body: `甲行{{e1.v1}}。${selection === "body" ? "乙行{{e2.v2}}。" : ""}阈值999元。`,
          ...(selection === "chart" ? { chart } : {}),
        },
        test.request,
      );
      expect(test.analysisReport.mock.calls[0]?.[0]).toHaveProperty("focus_refs", []);
      expect(test.analysisReport.mock.calls[1]?.[0]).toMatchObject({
        fallback: true,
        run_refs: ["current", "history", "current-other"],
        context_run_refs: ["history"],
        focus_refs: ["history.f2", "current.f1"],
      });
      expect(result).toMatchObject({ terminate: true, details: { kind: "business_report" } });
      if (selection !== "body")
        expect(result).toHaveProperty("details.report.charts[0].source_refs", chart.evidence_refs);
      expect(test.analysisReport).toHaveBeenCalledTimes(2);
      expect(test.analysisExecute).not.toHaveBeenCalled();
      expect(test.queryMetric).not.toHaveBeenCalled();
    },
  );

  it("兜底不因已读取历史就把未选择的旧事实加入关注范围", async () => {
    const test = harness([
      { ref: "e1", evidence: source("current") },
      { ref: "e2", evidence: source("history", "old-op") },
    ]);
    await executeInquiryReport({ body: "本轮事实{{e1.v1}}。" }, test.request, undefined, true);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      fallback: true,
      run_refs: ["current"],
      context_run_refs: [],
      focus_refs: ["current.f1"],
    });
  });

  it("混合来源兜底保留所选运算引用及历史父事实，不选择同次其他运算", async () => {
    const sources = [
      { ref: "e1", evidence: source("current") },
      { ref: "e2", evidence: source("history", "old-op") },
    ];
    const test = harness(sources);
    test.request.answerEvidence = () =>
      Promise.resolve([
        ...sources,
        {
          ref: "e3",
          evidence: {
            kind: "metric_calculate",
            status: "succeeded",
            execution_turn_id: "op-1",
            ...{
              calculation_ref: { task_id: "task", calculation_id: "calc" },
              run_refs: ["current", "history"],
              inputs: {
                current: { task_id: "current-task", fact_id: "current-fact" },
                base: { task_id: "history-task", fact_id: "history-fact" },
              },
              limitations: [],
              evidence_items: [
                {
                  ref: "calculation.calc.difference",
                  type: "calculation",
                  name: "difference",
                  value: "-1.75",
                  unit: "元",
                  display: "-1.75元",
                  input_refs: ["current.f1", "history.f2"],
                },
                {
                  ref: "calculation.calc.change_rate",
                  type: "calculation",
                  name: "change_rate",
                  value: "-0.5",
                  unit: "%",
                  display: "-50.00%",
                  input_refs: ["current.f1", "history.f2"],
                },
              ],
            },
          },
        },
      ]);
    await executeInquiryReport({ body: "差额{{e3.v1}}。" }, test.request, undefined, true);
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
      fallback: true,
      run_refs: ["current", "history"],
      context_run_refs: ["history"],
      focus_refs: ["calculation.calc.difference"],
      calculation_refs: [{ task_id: "task", calculation_id: "calc" }],
    });
  });

  it.each(["judgment", "calculation", "judgment-with-calculation", "missing-input", "cycle"])(
    "历史%s沿原始依据链选择事实，缺失或循环依据不能静默忽略",
    async (kind) => {
      const current = source("current"),
        history = source("history", "old-op");
      const test = harness();
      test.request.answerEvidence = () =>
        Promise.resolve([
          { ref: "e1", evidence: current },
          {
            ref: "e2",
            evidence: {
              ...history,
              evidence_items: [
                ...history.evidence_items.map((atom, index) => ({
                  ...atom,
                  fact_id: `fact-${index + 1}`,
                })),
                kind === "judgment" || kind === "cycle"
                  ? {
                      ref: "history.j1",
                      type: "observation",
                      judgment_kind: "ranking",
                      input_refs: [kind === "cycle" ? "history.j1" : "history.f2"],
                    }
                  : {
                      ref: "history.c1",
                      type: "calculation",
                      input_fact_refs: [kind === "missing-input" ? "missing-fact" : "fact-2"],
                    },
                ...(kind === "judgment-with-calculation"
                  ? [
                      {
                        ref: "history.j1",
                        type: "observation",
                        judgment_kind: "direction",
                        input_refs: ["history.c1"],
                      },
                    ]
                  : []),
              ],
            },
          },
        ]);
      const result = await executeInquiryReport(
        {
          body: `已选依据{{${kind === "judgment" || kind === "judgment-with-calculation" || kind === "cycle" ? "e2.j1" : "e2.v4"}}}。`,
        },
        test.request,
        undefined,
        true,
      );
      if (kind === "missing-input" || kind === "cycle") {
        expect(result).toHaveProperty("details.error_code", "ANALYSIS_REPORT_REFERENCE");
        expect(test.analysisReport).not.toHaveBeenCalled();
      } else {
        expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
          fallback: true,
          run_refs: ["current", "history"],
          context_run_refs: ["history"],
          focus_refs: [kind === "judgment" ? "history.j1" : "history.f2"],
        });
      }
    },
  );

  it.each(["judgment", "judgment-with-fact", "fact"])(
    "历史排名有81条父事实时，%s保留等价来源引用而不截断或扩大选择",
    async (selection) => {
      const history = source("history", "old-op");
      const facts = Array.from({ length: 81 }, (_, index) => ({
        ...history.evidence_items[0]!,
        ref: `history.f${index + 1}`,
        org_code: `O${index + 1}`,
        org_name: `测试机构${index + 1}`,
      }));
      const test = harness();
      test.request.answerEvidence = () =>
        Promise.resolve([
          { ref: "e1", evidence: source("current") },
          {
            ref: "e2",
            evidence: {
              ...history,
              org_codes: facts.map((atom) => atom.org_code),
              evidence_items: [
                ...facts,
                {
                  ref: "history.j1",
                  type: "observation",
                  judgment_kind: "ranking",
                  input_refs: facts.map((atom) => atom.ref),
                },
              ],
            },
          },
        ]);
      await executeInquiryReport(
        {
          body:
            selection === "fact"
              ? "所选事实{{e2.v1}}。"
              : `已核验排名{{e2.j1}}。${selection === "judgment-with-fact" ? "对应事实{{e2.v1}}。" : ""}`,
        },
        test.request,
        undefined,
        true,
      );
      expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
        fallback: true,
        run_refs: ["current", "history"],
        context_run_refs: ["history"],
        focus_refs: [selection === "fact" ? "history.f1" : "history.j1"],
      });
    },
  );

  it.each(["body", "chart"])("事实兜底分别处理%s的未知引用，不能将其作为事实展示", async (selection) => {
    const test = harness();
    const result = await executeInquiryReport(
      {
        body: selection === "body" ? "{{unknown.f1}}" : "{{e1.v1}}",
        ...(selection === "chart"
          ? { chart: { type: "bar" as const, evidence_refs: ["e1.v1", "unknown.f1"] } }
          : {}),
      },
      test.request,
      undefined,
      true,
    );
    if (selection === "body") {
      expect(result).toHaveProperty("details.error_code", "ANALYSIS_REPORT_REFERENCE");
      expect(test.analysisReport).not.toHaveBeenCalled();
    } else {
      expect(result).toHaveProperty("details.status", "succeeded");
      expect(result).toHaveProperty("details.report.charts", []);
      expect(result).toHaveProperty("details.partial_analysis", true);
      expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({ focus_refs: ["run-1.f1"] });
    }
  });

  it("事实兜底未核验图表依据时不从失败草稿补回配图", async () => {
    const test = harness();
    test.request.turnMessages = () => Promise.resolve([failedAnswer]);
    test.analysisReport.mockRejectedValueOnce(
      new BackendApiError(422, "草稿数字无依据", "ANALYSIS_REPORT_NUMBER"),
    );
    test.analysisReport.mockResolvedValueOnce({
      kind: "business_report",
      status: "succeeded",
      delivery: "business_evidence_v1",
      answer_policy: "verified_report_v1",
      public_answer: answer,
      gaps: [],
      report: { summary: answer, sections: [], body_evidence: [] },
    });
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      {
        body: "甲行{{e1.v1}}、乙行{{e1.v2}}，阈值999元。",
        chart: { type: "bar", evidence_refs: ["e1.v1", "e1.v2"] },
      },
      test.request,
    );
    expect(result).toHaveProperty("terminate", true);
    expect(result).toHaveProperty("details.report.charts", []);
    expect(result).not.toHaveProperty("details.public_answer", expect.stringContaining("999"));
  });

  it.each([401, 403])("事实兜底重新核验返回%s时保持权限阻断", async (status) => {
    const test = harness();
    test.request.turnMessages = () => Promise.resolve([failedAnswer]);
    const forbidden = new BackendApiError(status, "来源当前不可访问", "ANALYSIS_FORBIDDEN");
    test.analysisReport
      .mockRejectedValueOnce(new BackendApiError(422, "草稿数字无依据", "ANALYSIS_REPORT_NUMBER"))
      .mockRejectedValueOnce(forbidden);
    await expect(
      runTool(createInquiryAnswerTool(), { body: "甲行{{e1.v1}}，阈值999元。" }, test.request),
    ).rejects.toBe(forbidden);
    expect(test.analysisReport).toHaveBeenCalledTimes(2);
  });

  it.each(["ANALYSIS_REPORT_SCOPE", "ANALYSIS_REPORT_REFERENCE"])(
    "有数据来源的%s仍不得通过事实兜底绕过",
    async (code) => {
      const test = harness();
      test.request.turnMessages = () =>
        Promise.resolve([
          {
            role: "toolResult",
            toolName: "analysis_answer",
            toolCallId: "attempt",
            timestamp: 0,
            isError: false,
            content: [],
            details: { kind: "analysis_answer", status: "ARGUMENT_ERROR" },
          },
        ]);
      test.analysisReport.mockRejectedValue(new BackendApiError(422, "依据无效", code));
      const result: unknown = await runTool(
        createInquiryAnswerTool(),
        { body: "未通过校验的草稿。" },
        test.request,
      );
      expect(result).not.toHaveProperty("terminate", true);
      expect(test.analysisReport).toHaveBeenCalledOnce();
    },
  );

  it("恢复决策共用普通回复的持久预算，切换回答工具不会重置次数", async () => {
    const test = harness();
    test.request.turnMessages = () =>
      Promise.resolve([
        {
          ...failedAnswer,
          toolName: "respond_without_business_action",
          details: { kind: "conversation_reply", status: "ARGUMENT_ERROR" },
        },
      ]);
    test.analysisReport.mockRejectedValueOnce(
      new BackendApiError(422, "正文数字无依据", "ANALYSIS_REPORT_NUMBER"),
    );
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toMatchObject({ terminate: true, details: { kind: "business_report" } });
    expect(test.analysisReport).toHaveBeenCalledTimes(2);
  });

  it("旧回合的回答失败不触发新回合事实恢复", async () => {
    const test = harness();
    test.request.turnMessages = () =>
      Promise.resolve([failedAnswer, { role: "user", content: "新问题", timestamp: 1 }]);
    test.analysisReport.mockRejectedValueOnce(
      new BackendApiError(422, "正文数字无依据", "ANALYSIS_REPORT_NUMBER"),
    );
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toMatchObject({ details: { status: "ARGUMENT_ERROR" } });
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });

  it("报告校验期间取消，不继续发起事实恢复", async () => {
    const test = harness(),
      controller = new AbortController();
    const error = new BackendApiError(422, "正文数字无依据", "ANALYSIS_REPORT_NUMBER");
    test.request.turnMessages = () => Promise.resolve([failedAnswer]);
    test.analysisReport.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(error);
    });
    await expect(
      runTool(
        createInquiryAnswerTool(),
        { body: "甲行{{e1.v1}}。" },
        test.request,
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toBe(error);
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });

  it("当前读取的历史来源以context及真实关注原子再次鉴权", async () => {
    const test = harness([{ ref: "e1", evidence: source("run-1", "old-op") }]);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}。" },
      test.request,
    );
    expect(result).toHaveProperty("terminate", true);
    expect(test.analysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        run_refs: ["run-1"],
        context_run_refs: ["run-1"],
        focus_refs: ["run-1.f1"],
      }),
      expect.anything(),
    );
  });

  it.each(["已有结果可以参考。", "**关键数据**"])("只读历史正文%s缺少关注引用时仍拒绝正式交付", async (body) => {
    const test = harness([{ ref: "e1", evidence: source("run-1", "old-op") }]);
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body },
      test.request,
    );
    expect(result).toHaveProperty("details.error_code", "ANALYSIS_REPORT_REFERENCE");
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it.each(["inline", "prepared"])(
    "历史复用的%s图表依据进入报告选取，正文无需逐个复述机构",
    async (mode) => {
      const test = harness([{ ref: "e1", evidence: source("run-1", "old-op") }]);
      const selection = { type: "bar" as const, evidence_refs: ["run-1.f1", "run-1.f2"] };
      if (mode === "prepared") {
        test.request.turnMessages = () => Promise.resolve([{
          role: "toolResult",
          toolName: "analysis_chart",
          toolCallId: "chart",
          timestamp: 1,
          isError: false,
          content: [],
          details: {
            kind: "inquiry_chart",
            status: "succeeded",
            selection,
            source_refs: selection.evidence_refs,
            run_refs: ["run-1"],
          },
        }]);
      }

      const result = await executeInquiryReport({
        body: "甲行{{e1.v1}}。",
        ...(mode === "inline" ? { chart: selection } : {}),
      }, test.request);

      expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({
        context_run_refs: ["run-1"],
        focus_refs: selection.evidence_refs,
        summary: "甲行{{run-1.f1}}。",
      });
      expect(result).toHaveProperty("details.report.charts[0].source_refs", selection.evidence_refs);
      expect(result).toHaveProperty("details.report.body_evidence", [
        { paragraph: 1, evidence_refs: ["run-1.f1"] },
      ]);
    },
  );

  it("图表使用真实引用及原始值，保持选择顺序且不另行查询", async () => {
    const test = harness();
    const result: unknown = await runTool(
      createInquiryReportTool(),
      {
        body: "甲行{{e1.v1}}、乙行{{e1.v2}}、丙行{{e1.v3}}。",
        chart: { type: "bar", evidence_refs: ["e1.v3", "e1.v1", "e1.v2"] },
      },
      test.request,
    );
    expect(result).toMatchObject({
      details: {
        report: {
          charts: [
            {
              type: "bar",
              unit: "元",
              source_refs: ["run-1.f3", "run-1.f1", "run-1.f2"],
              points: [
                { name: "丙行", value: "-1.00" },
                { name: "甲行", value: "-5.00" },
                { name: "乙行", value: "-3.25" },
              ],
            },
          ],
        },
      },
    });
    expect(test.analysisReport).toHaveBeenCalledOnce();
    expect(test.analysisExecute).not.toHaveBeenCalled();
    expect(test.queryMetric).not.toHaveBeenCalled();
  });

  it("拒绝图表的外部原子时保留已核验正文并说明缺口", async () => {
    const test = harness();
    const result: unknown = await runTool(
      createInquiryReportTool(),
      { body: "甲行{{e1.v1}}。", chart: { type: "bar", evidence_refs: ["e1.v1", "foreign.f1"] } },
      test.request,
    );
    expect(result).toHaveProperty("details.status", "succeeded");
    expect(result).toHaveProperty("details.report.charts", []);
    expect(result).toHaveProperty("details.partial_analysis", true);
    expect(result).toHaveProperty("details.public_answer", expect.stringContaining(answer));
    expect(test.analysisReport.mock.calls[0]?.[0]).toMatchObject({ run_refs: ["run-1"] });
  });
});

describe("增量正文预览", () => {
  function setup() {
    const test = harness();
    test.request.answerStream = { callSeq: 1, mode: "text" };
    test.analysisReport.mockImplementation((payload) =>
      Promise.resolve({
        kind: "analysis_report_preview",
        status: "succeeded",
        preview_text: String(payload.summary).replaceAll("{{run-1.f1}}", "-5.00元"),
      }),
    );
    return { ...test, preview: createInquiryReportPreview() };
  }

  it("同来源只核验新增完整段落，累计显示与完整正文一致", async () => {
    const test = setup();
    const first = "甲行{{e1.v1}}。";
    await test.preview(first, test.request);
    expect(await test.preview(first + "\n\n继续说明。", test.request)).toBe(
      "甲行-5.00元。\n\n继续说明。",
    );
    expect(test.analysisReport.mock.calls.map(([payload]) => payload.summary)).toEqual([
      "甲行{{run-1.f1}}。",
      "继续说明。",
    ]);
  });

  it("单换行追加列表重新核验累计正文，不重复拼接已显示内容", async () => {
    const test = setup();
    const first = "- 甲行{{e1.v1}}。";
    expect(await test.preview(first, test.request)).toBe("- 甲行-5.00元。");
    expect(await test.preview(first + "\n- 具体原因还需核实。", test.request)).toBe(
      "- 甲行-5.00元。\n- 具体原因还需核实。",
    );
    expect(test.analysisReport.mock.calls.map(([payload]) => payload.summary)).toEqual([
      "- 甲行{{run-1.f1}}。",
      "- 甲行{{run-1.f1}}。\n- 具体原因还需核实。",
    ]);
  });

  it("增量段保留缩进，不能把代码块或列表变成普通文字", async () => {
    const test = setup();
    await test.preview("甲行{{e1.v1}}。", test.request);
    await test.preview("甲行{{e1.v1}}。\n\n    说明", test.request);
    expect(test.analysisReport.mock.calls[1]?.[0].summary).toBe("    说明");
  });

  it("指标绑定失效不当作正文错误吞掉", async () => {
    const test = setup();
    await test.preview("甲行{{e1.v1}}。", test.request);
    const error = new BackendApiError(422, "绑定失效", "ANALYSIS_BINDING_INVALID");
    test.analysisReport.mockRejectedValue(error);
    await expect(test.preview("甲行{{e1.v1}}。\n\n说明。", test.request)).rejects.toBe(error);
  });

  it("新增来源或前文改写时重新核验全文", async () => {
    const test = setup();
    await test.preview("甲行{{e1.v1}}。", test.request);
    test.request.answerEvidence = () =>
      Promise.resolve([
        { ref: "e1", evidence: source() },
        { ref: "e2", evidence: source("run-2") },
      ]);
    await test.preview("甲行{{e1.v1}}。\n\n继续说明。", test.request);
    expect(test.analysisReport.mock.calls[1]?.[0].summary).toBe("甲行{{run-1.f1}}。\n\n继续说明。");
    await test.preview("改写{{e1.v1}}。\n\n继续说明。", test.request);
    expect(test.analysisReport.mock.calls[2]?.[0].summary).toBe("改写{{run-1.f1}}。\n\n继续说明。");
  });

  it("新调用不复用上次已核验前缀", async () => {
    const test = setup();
    await test.preview("甲行{{e1.v1}}。", test.request);
    test.request.answerStream = { callSeq: 2, mode: "text" };
    await test.preview("甲行{{e1.v1}}。\n\n继续说明。", test.request);
    expect(test.analysisReport.mock.calls[1]?.[0].summary).toBe("甲行{{run-1.f1}}。\n\n继续说明。");
  });

  it("历史焦点沿用全文引用，追加无引用的解释段仍能核验", async () => {
    const test = setup();
    test.request.answerEvidence = () =>
      Promise.resolve([{ ref: "e1", evidence: source("run-1", "old-op") }]);
    await test.preview("甲行{{e1.v1}}。", test.request);
    await test.preview("甲行{{e1.v1}}。\n\n具体原因还需核实。", test.request);
    expect(test.analysisReport.mock.calls[1]?.[0]).toMatchObject({
      summary: "具体原因还需核实。",
      focus_refs: ["run-1.f1"],
      context_run_refs: ["run-1"],
    });
  });

  it("已核验前文也不能绕过后续请求的权限检查", async () => {
    const test = setup();
    await test.preview("甲行{{e1.v1}}。", test.request);
    const error = new BackendApiError(403, "权限已变更", "FORBIDDEN");
    test.analysisReport.mockRejectedValueOnce(error);
    await expect(test.preview("甲行{{e1.v1}}。\n\n说明。", test.request)).rejects.toBe(error);
  });
});
