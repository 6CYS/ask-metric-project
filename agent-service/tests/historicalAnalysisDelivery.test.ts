import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {BusinessEvidence} from "../src/answerEvidence.js";
import {currentTurnEvidence} from "../src/answerEvidence.js";
import {reduceRuntime, runtimeToolAdmission} from "../src/runtime/control.js";
import {semanticFeedback} from "../src/semantic-task/feedback.js";
import {hasTurnAction} from "../src/tools/turnContract.js";

const operationId = "op-current";
function analysis(kind: string, metadata: Record<string, unknown> = {}): BusinessEvidence {
  return {kind, status: "succeeded", answer_policy: kind === "business_overview"
    ? "overview_evidence_v2" : "general_analysis_evidence_v1", ...metadata};
}
function read(evidence: BusinessEvidence, id = "read"): AgentMessage {
  const feedback = semanticFeedback(undefined, "reused");
  feedback.state.evidence = {...evidence};
  return {role: "toolResult", toolName: "read_business_result", toolCallId: id, details: feedback,
    content: [], isError: false, timestamp: 0};
}
const historical = () => analysis("analysis_evidence", {execution_turn_id: "op-previous", result_reused: true});
const runtime = (messages: AgentMessage[]) => reduceRuntime("具体是哪几个客户把钱转走了，给我看看。", messages, operationId);
describe("历史分析读取不产生本轮报告义务", () => {
  it.each(["analysis_evidence", "business_overview"])("读取旧%s只提供背景，不进入报告阶段", kind => {
    const messages = [read(analysis(kind, {execution_turn_id: "op-previous", result_reused: true}))];
    expect(runtime(messages)).toMatchObject({phase: "prepare", next: "prepare", execution_complete: false});
  });

  it("旧会话没有执行轮次时沿用复用标记，同轮恢复以执行轮次为准", () => {
    expect(runtime([read(analysis("analysis_evidence", {result_reused: true}))]).next).toBe("prepare");
    expect(runtime([read(analysis("analysis_evidence", {execution_turn_id: operationId, result_reused: true}))]).next)
      .toBe("present_report");
    expect(runtime([read(analysis("analysis_evidence", {execution_turn_id: "op-previous"}))]).next).toBe("prepare");
  });

  it.each(["analysis_evidence", "business_overview"])("新的%s仍须交付，旧背景不能覆盖新证据", kind => {
    const messages = [read(historical()), read(analysis(kind, {execution_turn_id: operationId}), "new")];
    expect(runtime(messages)).toMatchObject({phase: "verify", next: "present_report"});
  });

  it("没有新分析时仍保留历史报告入口和数值回答约束", () => {
    const messages = [read(historical())];
    expect(currentTurnEvidence(messages)).toHaveLength(1);
    expect(hasTurnAction(messages)).toBe(true);
    expect(runtimeToolAdmission(messages, "analysis_report_present")).toBeUndefined();
    expect(runtimeToolAdmission(messages, "business_capability_explain")).toBeUndefined();
    expect(runtimeToolAdmission([], "analysis_report_present")).toMatchObject({terminate: false});
  });

  it("失败和目录回执不能触发报告，旧版无来源的成功新回执保持兼容", () => {
    expect(runtime([read({...historical(), status: "failed"})]).next).not.toBe("present_report");
    expect(runtime([read({kind: "metric_catalog_overview", status: "succeeded"})]).next).not.toBe("present_report");
    expect(runtime([read(analysis("analysis_evidence"))]).next).toBe("present_report");
  });
});
