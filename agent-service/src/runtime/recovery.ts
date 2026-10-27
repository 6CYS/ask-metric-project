import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {repeatedToolFailure} from "../toolRecovery.js";
import {isSemanticFeedback} from "../semantic-task/feedback.js";
import {ANALYSIS_REPAIR, analysisRecoveryPhase} from "../semantic-task/analysisRecovery.js";

/** 全局上限只由宿主掌握；模型、重开会话与改写参数不能重置预算。模型网络重试仍归 Pi 的 retry policy。 */
export const RUNTIME_LIMITS = {toolCalls: 24, actionRepairs: 2, outputRepairs: 1, recoveryReminders: 2, repeatedContextReads: 2} as const;
export type RecoveryKind = "none" | "repair_arguments" | "discover_catalog" | "retry_read" | "reconcile_execution" | "await_user"
  | "stop_permission" | "stop_capability" | "stop_no_progress" | "deliver_evidence";
export interface RecoveryDecision {kind: RecoveryKind; canRetry: boolean; preserveEvidence: true; changeScope: false}

const reportProseErrors = new Set(["ANALYSIS_REPORT_NUMBER", "ANALYSIS_REPORT_CAUSE", "ANALYSIS_REPORT_DIRECTION",
  "ANALYSIS_REPORT_SUMMARY", "ANALYSIS_REPORT_PROSE_COVERAGE", "ANALYSIS_REPORT_PROSE"]);
export function isReportProseErrorCode(code: string | undefined): boolean {
  return reportProseErrors.has(code ?? "");
}

/** 部分交付本身也是最后一次尝试；旧版异常回执没有 details 时同样不得重试。 */
export function analysisPartialReceipt(messages: readonly AgentMessage[]): Extract<AgentMessage, {role: "toolResult"}> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") break;
    if (message?.role === "toolResult" && message.toolName === "analysis_partial_present") return message;
  }
  return undefined;
}

/** 正文修正沿用当前轮报告回执；中间被阻止的调用不能重新开放取数。 */
export function reportProseRepairTool(messages: readonly AgentMessage[]): "analysis_report_present" | "business_report_present" | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") break;
    if (message?.role !== "toolResult" || message.toolName !== "analysis_report_present" && message.toolName !== "business_report_present") continue;
    const details = message.details as {status?: string; error_code?: string; retryable?: boolean} | undefined;
    return details?.status === "ARGUMENT_ERROR" && details.retryable && isReportProseErrorCode(details.error_code)
      ? message.toolName : undefined;
  }
  return undefined;
}

/** 失败按正式语义分流；未知执行结果必须核对原执行，权限/能力限制不能靠改条件绕过。 */
export function recoveryDecision(messages: readonly AgentMessage[]): RecoveryDecision {
  const result = (kind: RecoveryKind, canRetry = false): RecoveryDecision => ({kind, canRetry, preserveEvidence: true, changeScope: false});
  const receipts = messages.filter(message => message.role === "toolResult");
  const last = [...receipts].reverse().find(message => ["resolve_business_turn", ANALYSIS_REPAIR].includes(message.toolName) || message.toolName === "execute_business_frame"
    || message.toolName === "read_business_result" || message.toolName === "business_capability_explain");
  if (last && isSemanticFeedback(last.details)) {
    const feedback = last.details;
    if (feedback.status === "denied" || feedback.issues?.some(issue => issue.category === "permission")) return result("stop_permission");
    if (["unknown", "executing"].includes(feedback.status)) return result("reconcile_execution");
    if (feedback.status === "unsupported") return result("stop_capability");
    if (feedback.status === "needs_user") return result("await_user");
    const repair = analysisRecoveryPhase(messages);
    if (repair) return result(repair.tool === "analysis_catalog" ? "discover_catalog" : "repair_arguments", true);
    if (feedback.query_recovery) {
      const discovered = receipts.slice(receipts.indexOf(last) + 1).some(message => message.toolName === "analysis_catalog"
        && !message.isError && (message.details as {status?: string})?.status === "succeeded");
      return result(discovered ? "repair_arguments" : "discover_catalog", true);
    }
  }
  if (repeatedToolFailure(messages)) return result("stop_no_progress");
  const latest = receipts.at(-1), details = latest?.details as {status?: string; retryable?: boolean; error_code?: string} | undefined;
  if (["FORBIDDEN", "UNAUTHORIZED", "ORG_SCOPE_FORBIDDEN"].includes(details?.error_code ?? "")) return result("stop_permission");
  if (["ARGUMENT_ERROR", "invalid_input", "needs_interpretation", "reference_mismatch"].includes(details?.status ?? "")) return result("repair_arguments", true);
  if (details?.retryable && details.status === "error" && ["catalog", "analysis_catalog", "read", "business_context_read"].includes(latest?.toolName ?? "")) return result("retry_read", true);
  if (last && isSemanticFeedback(last.details) && ["invalid_input", "needs_interpretation", "conflict"].includes(last.details.status)) return result("repair_arguments", true);
  return result("none");
}
