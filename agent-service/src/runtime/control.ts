import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {SemanticPlan} from "../semantic-task/store.js";
import {businessEvidences, isCurrentAnalysisEvidence} from "../answerEvidence.js";
import {isSemanticFeedback} from "../semantic-task/feedback.js";
import {receiptDelivery, readRuntimeDelivery, RUNTIME_FINALIZE} from "./delivery.js";
import {analysisPartialReceipt, recoveryDecision, reportProseRepairTool, RUNTIME_LIMITS, type RecoveryDecision} from "./recovery.js";
import {TOOL_LIMIT_ANSWER} from "../replyGuard.js";

export type RuntimePhase = "understand" | "prepare" | "plan" | "execute" | "verify" | "deliver" | "recover" | "waiting" | "stopped";
export type ReceiptRole = "preparation" | "execution" | "delivery" | "failure";
export function isPreparationTool(tool: string): boolean {
  return ["catalog", "analysis_catalog", "metric_catalog_overview", "metric_catalog_search", "org_catalog_search", "business_context_read",
    "business_skill_read", "business_topic_read", "business_action_required"].includes(tool);
}
export function receiptRole(message: Extract<AgentMessage, {role: "toolResult"}>): ReceiptRole {
  if (message.isError) return "failure";
  if (receiptDelivery(message) !== undefined) return "delivery";
  const d = message.details as {status?: string; kind?: string} | undefined;
  if (["ARGUMENT_ERROR", "invalid_input", "needs_interpretation", "failed", "error", "reference_mismatch"].includes(d?.status ?? "")) return "failure";
  if (isPreparationTool(message.toolName)) return "preparation";
  if (isSemanticFeedback(d) || businessEvidences(d).some(item => !["metric_catalog_overview"].includes(item.kind))) return "execution";
  return "preparation";
}

/** 只存执行控制和现有计划引用，不复制业务条件或建立第二份任务计划。 */
export interface RuntimeControl {
  version: 1; revision: number; goal: string; phase: RuntimePhase;
  plan?: {ref: string; revision: number};
  required: number; completed: number; unresolved: string[];
  execution_complete: boolean; delivery_complete: boolean;
  next: "interpret" | "prepare" | "execute_plan" | "present_report" | "deliver" | RecoveryDecision["kind"];
  recovery: RecoveryDecision;
  budget: {tools_used: number; tools_left: number; action_repairs: number; output_repairs: number; analysis_repairs: number};
  observed_calls: string[];
  revisions: Array<{ref: string; revision: number; reason: "initial_plan" | "revised_plan"; after_receipt: number}>;
}

export function reduceRuntime(goal: string, messages: readonly AgentMessage[], operationId: string, plan?: SemanticPlan, previous?: RuntimeControl): RuntimeControl {
  const receipts = messages.filter((message): message is Extract<AgentMessage, {role: "toolResult"}> => message.role === "toolResult");
  const required = plan?.steps.filter(step => step.required) ?? [];
  const unresolved = required.filter(step => step.status !== "succeeded" || step.evidence?.truncated).map(step => step.targetRef);
  const completed = required.length - unresolved.length;
  const formal = [...receipts].reverse().find(message => receiptRole(message) === "delivery");
  const recovery = recoveryDecision(messages);
  const evidence = receipts.flatMap(message => message.isError ? [] : businessEvidences(message.details));
  const analysis = evidence.some(item => isCurrentAnalysisEvidence(item, operationId));
  const incomplete = readRuntimeDelivery(formal?.details)?.outcome === "incomplete";
  let phase: RuntimePhase = !receipts.length ? "understand" : plan ? "plan" : "prepare";
  let next: RuntimeControl["next"] = !receipts.length ? "interpret" : plan ? "execute_plan" : "prepare";
  if (plan?.steps.some(step => ["ready", "executing", "waiting_dependency"].includes(step.status))) phase = "execute";
  if (analysis || required.length > 0 && !unresolved.length) {phase = "verify"; next = analysis ? "present_report" : "deliver";}
  if (recovery.kind !== "none") {
    phase = recovery.kind === "await_user" || recovery.kind === "reconcile_execution" ? "waiting"
      : recovery.kind.startsWith("stop_") ? "stopped" : "recover";
    next = recovery.kind;
  }
  if (formal && (incomplete || recovery.kind === "none")) {phase = incomplete ? "stopped" : "deliver"; next = "none";}
  const lastAssistant = [...messages].reverse().find(message => message.role === "assistant");
  if (lastAssistant?.role === "assistant" && ["error", "aborted"].includes(lastAssistant.stopReason)) {phase = "stopped"; next = "none";}
  const revisions = [...previous?.revisions ?? []];
  if (plan && (previous?.plan?.ref !== plan.ref || previous.plan.revision !== plan.revision))
    revisions.push({ref: plan.ref, revision: plan.revision, reason: previous?.plan ? "revised_plan" : "initial_plan", after_receipt: receipts.length});
  return {version: 1, revision: previous?.revision ?? 0, goal, phase, ...(plan ? {plan: {ref: plan.ref, revision: plan.revision}} : {}),
    required: required.length, completed, unresolved,
    execution_complete: required.length > 0 && !unresolved.length && plan?.completion !== "partial", delivery_complete: !!formal,
    next, recovery, budget: {tools_used: receipts.length, tools_left: Math.max(0, RUNTIME_LIMITS.toolCalls - receipts.length),
      action_repairs: receipts.filter(message => message.toolName === "business_action_required").length,
       analysis_repairs: receipts.filter(message => message.toolName === "analysis_plan_repair").length,
      output_repairs: receipts.filter(message => (message.details as {status?: string})?.status === "MODEL_OUTPUT_LIMIT").length},
    observed_calls: [...new Set(receipts.map(receipt => receipt.toolCallId))], revisions: revisions.slice(-16)};
}

/** 阶段准入统一放在执行前；同批后续调用、网关忽略 tool_choice 和恢复续跑都遵守同一规则。 */
export function runtimeToolAdmission(messages: readonly AgentMessage[], tool: string): {reason: string; terminate: boolean} | undefined {
  const receipts = messages.filter((message): message is Extract<AgentMessage, {role: "toolResult"}> => message.role === "toolResult");
  if (analysisPartialReceipt(messages))
    return {reason: "本轮已尝试交付现有分析结果，不再重复收尾或继续查询。", terminate: true};
  const partial = tool === "analysis_partial_present";
  const failedAnalysis = partial && receipts.some(message => isSemanticFeedback(message.details) && message.details.status === "failed");
  if (receipts.some(message => receiptDelivery(message) !== undefined) && !failedAnalysis)
    return {reason: "本轮已有正式交付，不再追加工具动作；后续问题请作为新一轮处理。", terminate: true};
  const requiredKind = tool === "business_report_present" ? "business_overview" : tool === "analysis_report_present" ? "analysis_evidence" : undefined;
  if (requiredKind && !receipts.some(message => !message.isError && businessEvidences(message.details).some(item => item.kind === requiredKind && item.status === "succeeded")))
    return {reason: "请先取得本轮成功的分析取数证据，再交付对应报告；目录或历史数据不能替代本轮取数。", terminate: false};
  const recovery = recoveryDecision(messages);
  if (["stop_permission", "stop_capability", "reconcile_execution", "await_user"].includes(recovery.kind) && !failedAnalysis)
    return {reason: recovery.kind === "reconcile_execution" ? "原执行结果尚未确认，不能重新发起查询或改写范围；请核对原执行。"
      : "当前状态需要用户输入或已触及权限、能力边界，不能自动改条件继续执行。", terminate: true};
  const reportRepair = reportProseRepairTool(messages);
  if (reportRepair && tool !== reportRepair && !partial && tool !== RUNTIME_FINALIZE)
    return {reason: `本轮仅重写已取得证据的报告，请用完整正文重新提交${reportRepair}，不重新取数或读取历史。`, terminate: false};
  if (receipts.length >= RUNTIME_LIMITS.toolCalls && !partial && tool !== RUNTIME_FINALIZE)
    return {reason: TOOL_LIMIT_ANSWER, terminate: true};
  return undefined;
}
