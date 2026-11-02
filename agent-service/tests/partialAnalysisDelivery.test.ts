import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {describe, expect, it} from "vitest";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {rememberReportSelection} from "../src/analysis/reportSelection.js";
import {createPartialAnalysisTool} from "../src/tools/partialAnalysis.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

function receipt(code?: string, status = "ARGUMENT_ERROR", toolName = "analysis_report_present"): AgentMessage {
  return {role: "toolResult", toolName, toolCallId: "report-1", content: [], timestamp: 0, isError: false,
    details: {kind: status === "succeeded" ? "business_report" : "analysis_report", status,
      ...(code ? {error_code: code} : {})}};
}

function setup(messages: AgentMessage[] = [], gapInBody = false) {
  const payloads: Record<string, unknown>[] = [];
  const backend = {analysisReport: async (payload: Record<string, unknown>) => {
    payloads.push(payload);
    const body = "上海支行余额为 100 元。" + (gapInBody ? "\n\n乙支行暂无该日数据。" : "");
    return {kind: "business_report", status: "succeeded", public_answer: body,
      report: {summary: body, sections: [], presentation: {scope: "上海支行"}},
      rows: [{org_name: "上海支行", metric_name: "存款余额", value: "100"}], columns: ["metric_name", "value"],
      org_codes: ["3100"], tasks: [], gaps: ["乙支行暂无该日数据。"]};
  }} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {
    answerEvidence: async () => [{ref: "e1", evidence: {kind: "analysis_evidence", status: "succeeded",
      execution_turn_id: "op-1", ...{run_ref: "run-1"}}}],
    turnMessages: async () => messages,
  });
  return {request, payloads};
}

describe("部分交付保留报告证据边界", () => {
  it.each([401, 403])("重新授权失败%s必须成为不含事实的终止回执，不能交给模型无限重试", async status => {
    const {request, payloads} = setup();
    request.backend.analysisReport = async () => {
      throw new BackendApiError(status, "账号已在其他位置重新登录，请重新认证", "UNAUTHORIZED");
    };
    const result = await runTool(createPartialAnalysisTool(), {reason: "corrections_exhausted"}, request);
    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({kind: "business_report", status: "failed", retryable: false,
      error_code: "UNAUTHORIZED"});
    expect(result.details.public_answer).toContain("重新认证");
    expect(result.details.public_answer).not.toContain("100 元");
    expect(payloads).toHaveLength(0);
  });

  it.each(["ANALYSIS_REPORT_REFERENCE", "ANALYSIS_REPORT_SCOPE", "ANALYSIS_REPORT_COVERAGE", "ANALYSIS_REPORT_EVIDENCE"])(
    "%s未解决时不能丢弃原请求并重新生成成功报告", async code => {
      const {request, payloads} = setup([receipt(code)]);
      const result = await runTool(createPartialAnalysisTool(), {reason: "corrections_exhausted"}, request);
      expect(result.details.status).toBe("failed");
      expect(result.details.public_answer).not.toContain("100");
      expect(result.terminate).toBe(true);
      expect(payloads).toHaveLength(0);
    });

  it.each(["ANALYSIS_REPORT_DIRECTION", "ANALYSIS_REPORT_PROSE_COVERAGE"])("后来的%s不能解除尚未解决的引用错误", async code => {
    const {request, payloads} = setup([receipt("ANALYSIS_REPORT_REFERENCE"), receipt(code)]);
    const result = await runTool(createPartialAnalysisTool(), {reason: "corrections_exhausted"}, request);
    expect(result.details.status).toBe("failed");
    expect(payloads).toHaveLength(0);
  });

  it("后续合法报告通过校验后不再保留旧错误阻挡", async () => {
    const {request, payloads} = setup([receipt("ANALYSIS_REPORT_REFERENCE"), receipt(undefined, "succeeded")]);
    const result = await runTool(createPartialAnalysisTool(), {reason: "action_incomplete"}, request);
    expect(result.details.status).toBe("succeeded");
    expect(payloads).toHaveLength(1);
  });

  it("上一轮失败不污染当前轮的部分交付", async () => {
    const {request, payloads} = setup([receipt("ANALYSIS_REPORT_REFERENCE"),
      {role: "user", content: "重新看存款情况", timestamp: 1}]);
    const result = await runTool(createPartialAnalysisTool(), {reason: "action_incomplete"}, request);
    expect(result.details.status).toBe("succeeded");
    expect(payloads).toHaveLength(1);
  });

  it.each(["ANALYSIS_REPORT_DIRECTION", "ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_CAUSE", "ANALYSIS_REPORT_PROSE", "ANALYSIS_REPORT_PROSE_COVERAGE", "ANALYSIS_REPORT_INPUT"])(
    "%s仍可用重新核验的事实有限收尾", async code => {
      const {request, payloads} = setup([receipt(code)]);
      const result = await runTool(createPartialAnalysisTool(), {reason: "corrections_exhausted"}, request);
      expect(result.details.status).toBe("succeeded");
      expect(result.details.partial_analysis).toBe(true);
      expect(payloads).toHaveLength(1);
    });

  it("无关工具的同名错误码不能改变报告证据状态", async () => {
    const {request, payloads} = setup([receipt("ANALYSIS_REPORT_REFERENCE", "ARGUMENT_ERROR", "analysis_catalog")]);
    const result = await runTool(createPartialAnalysisTool(), {reason: "action_incomplete"}, request);
    expect(result.details.status).toBe("succeeded");
    expect(payloads).toHaveLength(1);
  });

  it.each([false, true])("未完成原因在正式正文和页面正文中都可见一次（历史范围=%s）", async focused => {
    const {request} = setup();
    if (focused) rememberReportSelection(request, ["run-1"], {run_refs: ["run-1"], focus_refs: ["fact-1"]});
    const result = await runTool(createPartialAnalysisTool(), {reason: "model_failure"}, request);
    const notice = "后续模型响应失败，未能完成分析";
    expect(result.details.public_answer.split(notice)).toHaveLength(2);
    expect(result.details.report.summary.split(notice)).toHaveLength(2);
    expect(result.details.public_answer).toContain("100 元");
    expect(result.details.gaps.join("\n")).toContain(notice);
  });

  it.each([{focused: false, gapInBody: false}, {focused: true, gapInBody: false},
    {focused: false, gapInBody: true}, {focused: true, gapInBody: true}])(
    "具体数据缺口可见且只呈现一次：%j", async ({focused, gapInBody}) => {
      const {request} = setup([], gapInBody);
      if (focused) rememberReportSelection(request, ["run-1"], {run_refs: ["run-1"], focus_refs: ["fact-1"]});
      const result = await runTool(createPartialAnalysisTool(), {reason: "action_incomplete"}, request);
      expect(result.details.public_answer.split("乙支行暂无该日数据。")).toHaveLength(2);
      expect(result.details.report.summary.split("乙支行暂无该日数据。")).toHaveLength(2);
    });
});
