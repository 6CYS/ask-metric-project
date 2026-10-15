import {semanticDisplay} from "./display.js";
import type {SemanticIssue, SemanticTask} from "./store.js";

export interface SemanticFeedback {
  protocol_version: 2; status: string;
  /** 真实工具最终化时持久化；展示与恢复共用严格版本解析器。 */
  direct_answer?: import("./directDelivery.js").DirectAnswerSnapshot;
  state: {task_ref?: string; task_status: string; completion: string; raw_message_retained: boolean; proposals_retained: boolean;
    evidence?: Record<string, unknown>;
    targets: Array<{kind?: "query" | "availability" | "calculation"; label?: string; aliases?: string[]; target_ref: string; status: string; conditions: Array<{field: string; display: string; origin: string}>; pending: string[]}>};
  issues: SemanticIssue[]; continuation: {actor: string; action: string};
}
export function isSemanticFeedback(value: unknown): value is SemanticFeedback {
  return !!value && typeof value === "object" && (value as SemanticFeedback).protocol_version === 2 && !!(value as SemanticFeedback).state;
}
export function semanticFeedback(task: SemanticTask | undefined, status: string, issues = task?.issues ?? []): SemanticFeedback {
  const state: SemanticFeedback["state"] = {task_status: task?.status ?? "unbound", completion: task?.completion ?? "unverified",
    raw_message_retained: true, proposals_retained: !!task, targets: task ? [{target_ref: task.target.ref, status: task.target.status,
      conditions: Object.entries(task.target.fields).filter(([, field]) => field.resolutionStatus === "resolved").map(([field, value]) => ({field,
        display: semanticDisplay(value),
        origin: value.source === "inherited" ? "history" : value.metadata?.confirmed === true ? "user_confirmed"
          : value.metadata?.resolution_source === "model_inferred" ? "model_proposed" : value.source === "resolved" ? "rule_default" : "user_explicit"})),
      pending: Object.entries(task.target.pending).map(([field, expression]) => {
        const candidates = task.target.fields[field]?.candidates ?? [];
        // 首推候选（后端或模型建议通道标记）用确认式话术并置顶；完整编号清单仍保留。
        const preferred = candidates.filter(candidate => candidate.preferred === true);
        if (preferred.length === 1) {
          const ordered = [preferred[0]!, ...candidates.filter(candidate => candidate !== preferred[0])];
          return `您是指「${String(preferred[0]!.value)}」吗？回复“是”直接确认；或选择：\n`
            + ordered.map((candidate, index) => `${index + 1}. ${String(candidate.value)}`).join("\n");
        }
        return expression + (candidates.length ? "\n" + candidates.map((candidate, index) => `${index + 1}. ${String(candidate.value)}`).join("\n") : "");
      })}] : [], ...(task ? {task_ref: task.ref} : {})};
  const continuation = status === "ready" ? {actor: "host", action: "execute_permitted_step"}
    : status === "unknown" || status === "executing" ? {actor: "host", action: "reconcile_execution"}
    : status === "needs_user" ? {actor: "user", action: "ask_user"}
    : status === "conflict" ? {actor: "pi", action: "read_context"}
    : status === "needs_interpretation" || status === "invalid_input" ? {actor: "pi", action: "revise_proposal"}
    : status === "succeeded" || status === "reused" ? {actor: "pi", action: "answer"} : {actor: "none", action: "stop"};
  return {protocol_version: 2, status, state, issues, continuation};
}
export function semanticPublicAnswer(details: unknown): string | undefined {
  if (!isSemanticFeedback(details) || !["needs_user", "prepared", "unsupported", "denied", "failed", "unknown"].includes(details.status)) return;
  const problems = [...new Set(details.issues.map(issue => issue.message))];
  if (!problems.length && details.status === "failed") {
    const evidence = details.state.evidence;
    const receipts = evidence?.kind === "semantic_results" && Array.isArray(evidence.results) ? evidence.results : evidence ? [evidence] : [];
    for (const value of receipts) if (value && typeof value === "object") {
      const receipt = value as {status?: string; public_answer?: unknown};
      if (receipt.status !== "succeeded" && typeof receipt.public_answer === "string") problems.push(receipt.public_answer);
    }
    if (!problems.length) problems.push("本轮步骤执行未完成，已保留原始目标和已取得的结果。");
  }
  if (details.status === "prepared") return "查询条件已整理并保存，尚未执行查询。";
  if (details.status === "unknown") return "查询结果尚未确认，已保留条件和原执行关联，请稍后核对结果。";
  const candidates = details.state.targets.flatMap(target => target.pending).filter(text => text.includes("\n1. "));
  const text = [...problems, ...candidates].join("\n");
  const kept = details.state.targets.flatMap(target => target.conditions).map(condition => `${condition.field === "organizations" ? "机构" : condition.field === "metrics" ? "指标" : condition.field === "time" ? "日期" : "取数条件"}：${condition.display}`);
  return text + (kept.length ? "\n\n已保存条件：" + kept.join("；") : "");
}
