import {candidateOptions, displayedCandidates, preferredOption} from "./candidateOptions.js";
import {semanticDisplay} from "./display.js";
import type {SemanticIssue, SemanticTask} from "./store.js";
import type {AnswerReceipt, PendingQuestion} from "./questions.js";

export interface SemanticFeedback {
  protocol_version: 2; status: string;
  /** 真实工具最终化时持久化；展示与恢复共用严格版本解析器。 */
  direct_answer?: import("./directDelivery.js").DirectAnswerSnapshot;
  query_recovery?: import("./queryRecovery.js").QueryRecoveryFeedback;
  analysis_recovery?: import("./analysisRecovery.js").AnalysisRecoveryFeedback;
  analysis_discovery?: {objective: string; requirements: import("../analysis/contracts.js").AnalysisPlan["requirements"]};
  analysis_recovery_partial?: {unresolved_requirement_ids: string[]};
  state: {task_ref?: string; task_status: string; completion: string; raw_message_retained: boolean; proposals_retained: boolean;
    evidence?: Record<string, unknown>;
    targets: Array<{kind?: "query" | "availability" | "calculation"; label?: string; aliases?: string[]; target_ref: string; status: string; conditions: Array<{field: string; display: string; origin: string}>; pending: string[]}>};
  issues: SemanticIssue[]; continuation: {actor: string; action: string};
  pending_questions: PendingQuestion[];
  answer_receipts: AnswerReceipt[];
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
        const published = (task.questionSnapshots ?? []).filter(question => question.status === "open" && question.scope.field === field);
        if (published.length) return published.map(question => `${question.prompt}\n${question.options.map(option =>
          `${option.no}. ${option.label}${option.description ? `（${option.description}）` : ""}`).join("\n")}`).join("\n");
        // 没有新问题记录的旧候选沿用同一发布格式（提示语 + 收敛后的编号清单），编号只覆盖本轮展示项。
        const options = candidateOptions(displayedCandidates(task.target.fields[field]?.candidates), field);
        const preferred = preferredOption(options);
        const list = options.map(option => `${option.no}. ${option.label}`).join("\n");
        if (preferred) return `您是指「${preferred.label}」吗？回复“是”直接确认；或选择：\n` + list;
        return expression + (options.length ? "\n" + list : "");
      })}] : [], ...(task ? {task_ref: task.ref} : {})};
  const continuation = status === "ready" ? {actor: "host", action: "execute_permitted_step"}
    : status === "unknown" || status === "executing" ? {actor: "host", action: "reconcile_execution"}
    : status === "needs_user" ? {actor: "user", action: "ask_user"}
    : status === "conflict" ? {actor: "pi", action: "read_context"}
    : status === "needs_interpretation" || status === "invalid_input" ? {actor: "pi", action: "revise_proposal"}
    : status === "succeeded" || status === "reused" ? {actor: "pi", action: "answer"} : {actor: "none", action: "stop"};
  return {protocol_version: 2, status, state, issues, continuation,
    pending_questions: structuredClone(task?.questionSnapshots ?? []).filter(question => question.status === "open"),
    answer_receipts: structuredClone(task?.answerReceipts ?? [])};
}
export function semanticPublicAnswer(details: unknown): string | undefined {
  if (!isSemanticFeedback(details) || !["needs_user", "prepared", "unsupported", "denied", "failed", "unknown"].includes(details.status)) return;
  const notices = (details.answer_receipts ?? []).map(receipt => receipt.notice).filter(Boolean);
  const visibleIssues = details.issues.filter(issue => issue.remediation === "user" || issue.category === "permission" || issue.category === "capability");
  const problems = [...new Set([...notices, ...visibleIssues.map(issue => issue.message)])];
  if (details.status === "failed" && details.issues.some(issue => issue.category !== "capability" && issue.category !== "permission")) {
    if (details.issues.some(issue => issue.code === "CONFIGURATION_ERROR" && issue.category === "infrastructure"))
      return "系统目录或查询范围配置不完整，本次查询未能执行。请管理员核对机构层级和目录同步；重复提交同一问题无法修复此配置。";
    return semanticFailureAnswer(details);
  }
  if (!problems.length && details.status === "failed") {
    const evidence = details.state.evidence;
    const receipts = evidence?.kind === "semantic_results" && Array.isArray(evidence.results) ? evidence.results : evidence ? [evidence] : [];
    for (const value of receipts) if (value && typeof value === "object") {
      const receipt = value as {status?: string; public_answer?: unknown};
      if (receipt.status !== "succeeded" && typeof receipt.public_answer === "string") problems.push(receipt.public_answer);
    }
    if (!problems.length) problems.push(semanticFailureAnswer(details));
  }
  if (details.status === "prepared") return [...notices, "查询条件已整理并保存，尚未执行查询。"].join("\n");
  if (details.status === "unknown") return "查询结果尚未确认，已保留条件和原执行关联，请稍后核对结果。";
  const candidates = details.state.targets.flatMap(target => target.pending).filter(text => text.includes("\n1. "));
  // 已保存条件不出现在回答正文：结构化条件已随回执投影到页面/任务状态，
  // 追问时再拼接“已保存条件”只会重复冗长信息。
  return [...problems, ...candidates].join("\n");
}

/** 失败不能只剩一句空状态；仅投影正式条件与受控原因，不向页面透出内部异常或猜测数据。 */
function semanticFailureAnswer(details: SemanticFeedback): string {
  if (details.issues.some(issue => issue.category === "permission")) return "当前身份无权继续此查询，请核对登录状态或数据访问权限后再查询。";
  const conditions = [...new Set(details.state.targets.flatMap(target => target.conditions
    .filter(condition => ["organizations", "time"].includes(condition.field)).map(condition => {
      const members = condition.field === "organizations" ? [...new Set(condition.display.split("、").filter(Boolean))] : [];
      return members.length > 5 ? `${members.length}家机构` : condition.display;
    })))];
  const known = conditions.length ? `已识别查询范围：${conditions.join("；")}。` : "原问题及已识别的条件已保留。";
  const evidence = details.state.evidence;
  const receipts = evidence?.kind === "semantic_results" && Array.isArray(evidence.results)
    ? evidence.results : evidence ? [evidence] : [];
  const delivered = receipts.flatMap(value => {
    const item = value as {status?: string; public_answer?: unknown} | null;
    return item?.status === "succeeded" && typeof item.public_answer === "string" && item.public_answer.trim()
      ? [item.public_answer.trim()] : [];
  });
  const cause = details.issues.some(issue => issue.category === "infrastructure")
    ? "查询服务暂时异常，尚未取得可用于回答的新结果。"
    : details.issues.some(issue => issue.category === "calendar")
      ? "时间条件的解析遇到问题，尚未取得该时间范围的指标结果。"
      : details.issues.some(issue => issue.field === "metrics" || issue.category === "catalog")
        ? "指标名称与正式目录的对应关系尚未确定，不能据此判断指标数值或变化。"
        : details.issues.some(issue => issue.code.startsWith("ANALYSIS_REPAIR_"))
          ? "分析查询计划未能自动修复，本次尚未取得该部分的新结果。"
          : "查询条件的内部校验尚未通过，尚未取得可用于回答的新结果。";
  const candidates = details.state.targets.flatMap(target => target.pending).filter(text => text.includes("\n1. "));
  const continuation = details.issues.some(issue => issue.code.startsWith("ANALYSIS_REPAIR_"))
    ? "原问题和查询范围已保留，可重试继续查询，无需补充相同条件。"
    : "可以继续说明希望查看的范围或重试当前问题，已确认的条件无需重复输入。";
  return [...new Set([...delivered, known, cause, ...candidates, continuation])].join("\n\n");
}
