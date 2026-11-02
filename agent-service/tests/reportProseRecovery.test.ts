import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {describe, expect, it} from "vitest";
import {runtimeToolAdmission} from "../src/runtime/control.js";
import {analysisPartialReceipt, reportProseRepairTool} from "../src/runtime/recovery.js";


function receipt(toolName: string, details: Record<string, unknown>): AgentMessage {
  return {role: "toolResult", toolName, details, content: [], toolCallId: toolName, isError: false, timestamp: 0};
}
const evidence = receipt("general_analysis", {kind: "analysis_evidence", status: "succeeded", execution_turn_id: "op-1"});
const reportError = (code = "ANALYSIS_REPORT_PROSE_COVERAGE", tool = "analysis_report_present") =>
  receipt(tool, {kind: "analysis_report", status: "ARGUMENT_ERROR", retryable: true, error_code: code});

describe("报告正文重写只允许使用已取得的证据", () => {
  it("旧版partial权限异常没有details时也算已尝试，不能再注入partial或重新查询", () => {
    const failed: AgentMessage = {role: "toolResult", toolName: "analysis_partial_present", toolCallId: "analysis-recovery",
      content: [{type: "text", text: "账号已在其他位置重新登录，请重新认证"}], isError: true, timestamp: 1};
    const messages = [evidence, reportError(), failed];
    expect(analysisPartialReceipt(messages)).toBe(failed);
    for (const tool of ["analysis_partial_present", "analysis_report_present", "resolve_business_turn"])
      expect(runtimeToolAdmission(messages, tool)).toMatchObject({terminate: true});
    expect(analysisPartialReceipt([...messages, {role: "user", content: "重试", timestamp: 2}])).toBeUndefined();
  });

  it.each(["ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_DIRECTION", "ANALYSIS_REPORT_CAUSE", "ANALYSIS_REPORT_SUMMARY", "ANALYSIS_REPORT_PROSE_COVERAGE"])(
    "%s固定为通用报告重提，不开放新的取数或查历史", code => {
      const messages = [evidence, reportError(code)];
      expect(reportProseRepairTool(messages)).toBe("analysis_report_present");
      expect(runtimeToolAdmission(messages, "analysis_report_present")).toBeUndefined();
      for (const tool of ["resolve_business_turn", "analysis_catalog", "read_business_result", "business_report_present"])
        expect(runtimeToolAdmission(messages, tool)).toMatchObject({terminate: false});
      expect(runtimeToolAdmission(messages, "analysis_partial_present")).toBeUndefined();
    });

  it("概览报告遵守同一个重写阶段边界", () => {
    const messages = [receipt("business_overview", {kind: "business_overview", status: "succeeded"}),
      reportError("ANALYSIS_REPORT_PROSE", "business_report_present")];
    expect(reportProseRepairTool(messages)).toBe("business_report_present");
    expect(runtimeToolAdmission(messages, "business_report_present")).toBeUndefined();
    expect(runtimeToolAdmission(messages, "resolve_business_turn")).toMatchObject({terminate: false});
  });

  it.each(["ANALYSIS_REPORT_REFERENCE", "ANALYSIS_REPORT_SCOPE", "ANALYSIS_REPORT_COVERAGE", "ANALYSIS_FORBIDDEN"])(
    "%s不能被当作正文重写", code => expect(reportProseRepairTool([evidence, reportError(code)])).toBeUndefined());

  it("成功报告或新一轮提问会结束正文重写阶段", () => {
    expect(reportProseRepairTool([evidence, reportError(),
      receipt("analysis_report_present", {kind: "business_report", status: "succeeded"})])).toBeUndefined();
    expect(reportProseRepairTool([evidence, reportError(), {role: "user", content: "查贷款", timestamp: 1}])).toBeUndefined();
  });

  it("被阻止的旁支调用不能重新开放取数，也不能绕过新权限错误", () => {
    const messages = [evidence, reportError(), receipt("analysis_catalog", {status: "blocked"})];
    expect(reportProseRepairTool(messages)).toBe("analysis_report_present");
    expect(runtimeToolAdmission(messages, "resolve_business_turn")).toMatchObject({terminate: false});
    messages.push(receipt("authorization", {status: "error", error_code: "FORBIDDEN"}));
    expect(runtimeToolAdmission(messages, "analysis_report_present")).toMatchObject({terminate: true});
  });

});
