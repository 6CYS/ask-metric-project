import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { createInquiryReportTool } from "../src/inquiry/reportTool.js";
import { createInquiryAnswerTool } from "../src/inquiry/runtime.js";
import { createPartialAnalysisTool } from "../src/tools/partialAnalysis.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

// 仅隔离后端接口；报告工具核验一次，恢复决定由 inquiry runtime 读取持久回执。
function setup() {
  const messages: AgentMessage[] = [];
  const final = {
    kind: "business_report",
    status: "succeeded",
    public_answer: "已核验机构变化；缺数机构未按零处理。",
    report: { summary: "已核验机构变化；缺数机构未按零处理。", sections: [] },
    rows: [],
    columns: [],
    org_codes: [],
    tasks: [],
    gaps: [],
    partial_analysis: true,
  };
  const analysisReport = vi
    .fn<(payload: Record<string, unknown>) => Promise<typeof final>>()
    .mockResolvedValue(final);
  const backend = { analysisReport } as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {
    executionFlow: "inquiry_v1",
    turnMessages: () => Promise.resolve(messages),
    answerEvidence: () =>
      Promise.resolve([
        {
          ref: "e1",
          evidence: {
            kind: "analysis_evidence",
            status: "succeeded",
            execution_turn_id: "op-1",
            ...{ run_ref: "run-1", plan: { steps: [] }, evidence_items: [] },
          },
        },
      ]),
  });
  const remember = (result: unknown) => {
    const receipt = result as {
      content: Extract<AgentMessage, { role: "toolResult" }>["content"];
      details: unknown;
    };
    messages.push({
      role: "toolResult",
      toolName: "analysis_answer",
      toolCallId: `report-${messages.length}`,
      content: receipt.content,
      details: receipt.details,
      timestamp: 0,
      isError: false,
    });
  };
  return { request, analysisReport, final, remember, messages };
}
const input = { body: "全省存款下滑。" };

describe("inquiry 报告修正保留真实来源和失败原因", () => {
  it("数字校验失败先返回修正，下一次失败由 runtime 重新核验原来源事实", async () => {
    const test = setup();
    const invalid = new BackendApiError(422, "正文数字未通过校验", "ANALYSIS_REPORT_NUMBER");
    test.analysisReport.mockRejectedValueOnce(invalid).mockRejectedValueOnce(invalid);
    const first: unknown = await runTool(createInquiryAnswerTool(), input, test.request);
    expect(first).toMatchObject({
      details: { status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_NUMBER", retryable: true },
    });
    expect(first).not.toHaveProperty("terminate", true);
    expect(test.analysisReport).toHaveBeenCalledOnce();
    test.remember(first);
    const result: unknown = await runTool(createInquiryAnswerTool(), input, test.request);
    expect(result).toMatchObject({
      terminate: true,
      details: {
        kind: "business_report",
        status: "succeeded",
        partial_analysis: true,
      },
    });
    expect(result).toHaveProperty(
      "details.public_answer",
      expect.stringContaining(test.final.public_answer),
    );
    expect(result).toHaveProperty("details.gaps", [
      expect.stringContaining("本轮未能完成分析回答"),
    ]);
    expect(test.analysisReport).toHaveBeenCalledTimes(3);
    expect(test.analysisReport.mock.calls[2]![0]).toEqual({
      ...test.analysisReport.mock.calls[1]![0],
      summary: "",
      sections: [],
      fallback: true,
    });
  });

  it.each([
    "ANALYSIS_REPORT_DIRECTION",
    "ANALYSIS_REPORT_CAUSE",
    "ANALYSIS_REPORT_SUMMARY",
    "ANALYSIS_REPORT_PROSE_COVERAGE",
  ])("%s 不在报告工具内自行重试或改变失败类型", async (code) => {
    const test = setup();
    test.analysisReport.mockRejectedValue(new BackendApiError(422, "测试正文拒绝", code));
    const first: unknown = await runTool(createInquiryAnswerTool(), input, test.request);
    test.remember(first);
    const second: unknown = await runTool(createInquiryAnswerTool(), input, test.request);
    expect(second).toMatchObject({ details: { status: "ARGUMENT_ERROR", error_code: code } });
    expect(test.analysisReport).toHaveBeenCalledTimes(2);
    expect(test.analysisReport.mock.calls.every(([payload]) => !payload.fallback)).toBe(true);
  });

  it("后端已核验的缺口当次交付，不要求重写也不掩盖部分可用状态", async () => {
    const test = setup();
    const result: unknown = await runTool(createInquiryAnswerTool(), input, test.request);
    expect(result).toMatchObject({
      terminate: true,
      details: test.final,
      content: [{ type: "text", text: test.final.public_answer }],
    });
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });

  it("正文修正通过后直接交付，不增加事实恢复调用", async () => {
    const test = setup();
    test.analysisReport.mockRejectedValueOnce(
      new BackendApiError(422, "正文数字拒绝", "ANALYSIS_REPORT_NUMBER"),
    );
    test.remember(await runTool(createInquiryAnswerTool(), input, test.request));
    const body = "目前没有账户流水，不能据此认定客户流失。";
    const result: unknown = await runTool(createInquiryAnswerTool(), { body }, test.request);
    expect(result).toMatchObject({ terminate: true, details: test.final });
    expect(test.analysisReport).toHaveBeenCalledTimes(2);
    expect(test.analysisReport.mock.calls[1]![0]).toMatchObject({ summary: body });
    expect(test.analysisReport.mock.calls.every(([payload]) => !payload.fallback)).toBe(true);
  });

  it("旧选择参数不能丢掉本轮先前已查询的来源", async () => {
    const test = setup();
    const sources = await test.request.answerEvidence!();
    test.request.answerEvidence = () =>
      Promise.resolve([
        ...sources,
        {
          ref: "e2",
          evidence: {
            kind: "analysis_evidence",
            status: "succeeded",
            execution_turn_id: "op-1",
            ...{ run_ref: "run-2", plan: { steps: [] }, evidence_items: [] },
          },
        },
      ]);
    const tool = createInquiryReportTool();
    const previous = { ...input, evidence_refs: ["e2"] };
    const prepared = tool.prepareArguments?.(previous) ?? previous;
    const result: unknown = await runTool(tool, prepared, test.request);
    expect(result).toMatchObject({ terminate: true, details: { status: "succeeded" } });
    expect(test.analysisReport.mock.calls[0]![0]).toMatchObject({ run_refs: ["run-1", "run-2"] });
    expect(prepared).not.toHaveProperty("evidence_refs");
  });

  it("合法正文引用多个事实时一次核验即交付", async () => {
    const test = setup();
    test.request.answerEvidence = () =>
      Promise.resolve([
        {
          ref: "e1",
          evidence: {
            kind: "analysis_evidence",
            status: "succeeded",
            execution_turn_id: "op-1",
            ...{
              run_ref: "run-1",
              plan: { steps: [] },
              evidence_items: Array.from({ length: 8 }, (_, index) => ({
                ref: `run-1.fact-${index}`,
                type: "fact",
                value: String(index),
              })),
            },
          },
        },
      ]);
    const body = Array.from({ length: 8 }, (_, index) => `已查指标为{{e1.v${index + 1}}}。`).join(
      "\n\n",
    );
    const result: unknown = await runTool(createInquiryReportTool(), { body }, test.request);
    expect(result).toMatchObject({ terminate: true, details: test.final });
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });

  it.each(["ANALYSIS_REPORT_REFERENCE", "ANALYSIS_REPORT_SCOPE", "ANALYSIS_REPORT_COVERAGE"])(
    "%s 不能通过 runtime 或部分交付绕过",
    async (code) => {
      const test = setup();
      test.analysisReport.mockRejectedValue(new BackendApiError(422, "正式来源拒绝", code));
      test.remember(await runTool(createInquiryAnswerTool(), input, test.request));
      const second: unknown = await runTool(createInquiryAnswerTool(), input, test.request);
      expect(second).toMatchObject({ details: { status: "ARGUMENT_ERROR", error_code: code } });
      test.remember(second);
      const partial: unknown = await runTool(
        createPartialAnalysisTool(),
        { reason: "corrections_exhausted" },
        test.request,
      );
      expect(partial).toMatchObject({ details: { status: "failed" } });
      expect(test.analysisReport).toHaveBeenCalledTimes(2);
      expect(test.analysisReport.mock.calls.every(([payload]) => !payload.fallback)).toBe(true);
    },
  );

  it("未知原子不能因正文同时含过程文案而变成可交付来源", async () => {
    const test = setup();
    const result: unknown = await runTool(
      createInquiryReportTool(),
      {
        body: "让我调用 analysis_answer，{{unknown.fact}}。",
      },
      test.request,
    );
    expect(result).toMatchObject({
      details: { status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_REFERENCE" },
    });
    test.remember(result);
    const partial: unknown = await runTool(
      createPartialAnalysisTool(),
      { reason: "corrections_exhausted" },
      test.request,
    );
    expect(partial).toMatchObject({ details: { status: "failed" } });
    expect(test.analysisReport).not.toHaveBeenCalled();
  });

  it.each([401, 403])("权限错误 %s 直接传播，不因过程文案或旧失败触发恢复", async (status) => {
    const test = setup();
    test.remember({
      content: [],
      details: { status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_NUMBER" },
    });
    const forbidden = new BackendApiError(status, "来源当前不可访问", "ANALYSIS_FORBIDDEN");
    test.analysisReport.mockRejectedValue(forbidden);
    await expect(
      runTool(createInquiryAnswerTool(), { body: "让我调用 analysis_answer。" }, test.request),
    ).rejects.toBe(forbidden);
    expect(test.analysisReport).toHaveBeenCalledOnce();
  });
});
