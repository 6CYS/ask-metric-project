import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {analysisRecoveryPhase, ANALYSIS_REPAIR} from "../src/semantic-task/analysisRecovery.js";
import {semanticFeedback} from "../src/semantic-task/feedback.js";

const proposal = () => ({protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"}, operations: [],
  analysis: {kind: "business_analysis", organizations: null, plan: {
    objective: "解释本行存款为什么减少", scope_notice: "按认证账户机构和实际覆盖日期",
    requirements: [{id: "q1", question: "本行存款当前水平及较上期/年初的变化方向与幅度"},
      {id: "q2", question: "存款减少主要来自哪些分类（对公/个人、活期/定期等）"}],
    steps: [{id: "s1", method: "observe", metric_refs: [] as string[], answers: ["q1"], rationale: "确认减少及幅度"},
      {id: "s2", method: "structure", metric_refs: [] as string[], answers: ["q2"], rationale: "观察存款分类变化"}],
  }}}]});
const discovery = () => {
  const raw = proposal();
  return {objective: raw.targets[0]!.analysis.plan.objective, requirements: raw.targets[0]!.analysis.plan.requirements};
};
function receipt(toolName: string, details: unknown, isError = false): AgentMessage {
  return {role: "toolResult", toolCallId: toolName, toolName, details, content: [], isError, timestamp: 0};
}
const pending = (status = "invalid_input") => receipt("resolve_business_turn", {
  ...semanticFeedback(undefined, status), analysis_discovery: discovery(),
});
const catalog = (status = "succeeded", candidate_map: unknown[] = [], isError = false) =>
  receipt("analysis_catalog", {kind: "analysis_catalog", status, candidate_map}, isError);

describe("目录发现复用原生回执和既有预算", () => {
  it("空计划先查目录，fallback使用原子问题且没有伪造恢复引用", () => {
    expect(analysisRecoveryPhase([pending()])).toEqual({tool: "analysis_catalog",
      discovery: {keywords: discovery().requirements.map(item => item.question), page_size: 30}});
  });

  it("正式非semantic候选到达后交回resolve规划，不擅自绑定或执行", () => {
    const phase = analysisRecoveryPhase([pending(), catalog("succeeded", [{code: "M1", name: "存款余额", binding_ref: "k1"}])]);
    expect(phase?.tool).toBe("resolve_business_turn");
    expect(phase).not.toHaveProperty("recovery");
  });

  it.each([
    ["空结果", "succeeded", [], false],
    ["仅推荐", "succeeded", [{code: "M1", binding_ref: "k1", match_type: "semantic"}], false],
    ["未签发引用", "succeeded", [{code: "M1"}], false],
    ["空白引用", "succeeded", [{code: "M1", binding_ref: " "}], false],
    ["服务错误", "error", [{code: "M1", binding_ref: "k1"}], false],
    ["工具异常", "succeeded", [{code: "M1", binding_ref: "k1"}], true],
  ] as const)("%s不冒充完成，最多两次目录尝试", (_label, status, candidates, isError) => {
    const read = catalog(status, [...candidates], isError);
    expect(analysisRecoveryPhase([pending(), read])?.tool).toBe("analysis_catalog");
    expect(analysisRecoveryPhase([pending(), read, read])?.tool).toBe("resolve_business_turn");
  });

  it("目录预算耗尽立即交回resolve处理缺口", () => {
    expect(analysisRecoveryPhase([pending(), catalog("budget_exhausted")])?.tool).toBe("resolve_business_turn");
  });

  it("后续语义终态或新提案覆盖旧发现阶段，不借用旧目录成功", () => {
    const found = catalog("succeeded", [{code: "M1", binding_ref: "k1"}]);
    expect(analysisRecoveryPhase([found, pending()])?.tool).toBe("analysis_catalog");
    expect(analysisRecoveryPhase([pending(), receipt("resolve_business_turn", semanticFeedback(undefined, "failed"))])).toBeUndefined();
    expect(analysisRecoveryPhase([pending("needs_interpretation")])).toBeUndefined();
  });

  it("已有保存计划的局部修复仍保留recovery契约", () => {
    const recovery = {task_ref: "plan", target_ref: "target", revision: 1, attempt: 0, max_attempts: 2,
      diagnostics: [], requirements: discovery().requirements, retained_step_ids: [], next_action: "repair_steps"};
    const phase = analysisRecoveryPhase([receipt("resolve_business_turn", {
      ...semanticFeedback(undefined, "needs_interpretation"), analysis_recovery: recovery,
    })]);
    expect(phase).toMatchObject({tool: ANALYSIS_REPAIR, recovery});
  });
});
