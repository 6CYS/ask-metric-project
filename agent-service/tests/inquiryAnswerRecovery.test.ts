import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { createInquiryAnswerTool, inquiryAfterTool } from "../src/inquiry/runtime.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

function failedAnswer(code: string): AgentMessage {
  return {
    role: "toolResult",
    toolName: "analysis_answer",
    toolCallId: "attempt-1",
    content: [],
    timestamp: 0,
    isError: true,
    details: { kind: "analysis_answer", status: "ARGUMENT_ERROR", error_code: code },
  };
}

// 隔离报告服务，只验证同一正文预算中的恢复决策，不作为真实业务验收。
function setup(previous: string, current: string) {
  const analysisReport = vi
    .fn()
    .mockRejectedValueOnce(new BackendApiError(422, "正文仍需修正", current))
    .mockResolvedValue({
      kind: "business_report",
      status: "succeeded",
      public_answer: "已核验事实。",
      report: { summary: "已核验事实。", sections: [], body_evidence: [] },
    });
  const messages = [failedAnswer(previous)];
  const request = testRequestContext(
    { analysisReport } as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      turnMessages: () => Promise.resolve(messages),
      answerEvidence: () =>
        Promise.resolve([
          {
            ref: "e1",
            evidence: {
              kind: "analysis_evidence",
              status: "succeeded",
              execution_turn_id: "op-1",
              ...{ run_ref: "run-1", evidence_items: [] },
            },
          },
        ]),
    },
  );
  return { analysisReport, messages, request };
}

describe("正文修正不能抹去未解决的证据错误", () => {
  it.each([
    "ANALYSIS_REPORT_REFERENCE",
    "ANALYSIS_REPORT_SCOPE",
    "ANALYSIS_REPORT_COVERAGE",
    "ANALYSIS_FORBIDDEN",
  ])("先前%s未解决时，末次数值错误不进入事实恢复", async (previous) => {
    const test = setup(previous, "ANALYSIS_REPORT_NUMBER");
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      { body: "待核验的回答。" },
      test.request,
    );
    expect(test.analysisReport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ details: { status: "ARGUMENT_ERROR" } });
    expect(result).not.toHaveProperty("details.kind", "business_report");
  });

  it("格式错误保留一次模型修正，末次失败明确结束且不另作事实恢复", async () => {
    const test = setup("ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_FORMAT");
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      { body: "待核验的回答。" },
      test.request,
    );
    expect(test.analysisReport).toHaveBeenCalledOnce();
    const details = {
      kind: "analysis_answer",
      status: "ARGUMENT_ERROR",
      retryable: true,
      error_code: "ANALYSIS_REPORT_FORMAT",
    };
    expect(result).toMatchObject({ details });
    const event = {
      toolName: "analysis_answer",
      toolCallId: "attempt-2",
      args: { body: "待核验的回答。" },
      content: [],
      details,
      isError: false,
    };
    expect(inquiryAfterTool(event, test.request, [])).toEqual({ isError: true });
    expect(inquiryAfterTool(event, test.request, test.messages)).toMatchObject({
      terminate: true,
      details: {
        kind: "runtime_delivery",
        outcome: "incomplete",
        error_code: "ANALYSIS_REPORT_FORMAT",
        public_answer: "本次回答整理未完成，请稍后重试。",
      },
    });
  });

  it("只有正文数值问题时继续复用原有最后一次事实恢复", async () => {
    const test = setup("ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_NUMBER");
    const result: unknown = await runTool(
      createInquiryAnswerTool(),
      { body: "待核验的回答。" },
      test.request,
    );
    expect(test.analysisReport).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ terminate: true, details: { kind: "business_report" } });
    expect(test.analysisReport.mock.calls[1]?.[0]).toMatchObject({
      run_refs: ["run-1"],
      fallback: true,
    });
  });
});
