import {businessEvidences, combinedEvidenceAnswer, evidenceAnswer, presentedAnswer} from "../answerEvidence.js";
import {isSemanticFeedback, semanticPublicAnswer} from "../semantic-task/feedback.js";
import {readDirectAnswerSnapshot} from "../semantic-task/directDelivery.js";

export const RUNTIME_FINALIZE = "runtime_finalize_turn";
export const RUNTIME_INCOMPLETE = "原问题及已确认条件已保留，本轮尚未取得可完整回答的新结果。可以重试当前问题，或继续说明希望查看的内容。";
type Receipt = {role?: string; toolName?: string; isError?: boolean; details?: unknown};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function isCatalogExplanationQuestion(question: string): boolean {
  return /(?:目录|口径|定义|搜索|(?:有哪些|有什么).*(?:指标|机构)|(?:指标|机构).*有哪些|有吗[？?。\s]*$)/u.test(question);
}

/** 原生 text 也可能是内部规划，不能依赖 thinking 开关或几个敏感词决定是否交付。 */
export function publicTextProblem(text: string): string | undefined {
  if (/<\/?(?:think|analysis|tool_call|system|developer)\b|<\|(?:im_start|DSML)/iu.test(text)) return "包含内部通道标记";
  const protocol = /(?:resolve_business_turn|admitted_context|business_skill_read|analysis_report_present|top_n\s*=|operation\s*=|target[12]\s*[:：]|"(?:targets|toolCall|arguments)"\s*:)/u;
  if (protocol.test(text) && /(?:让我|我(?:需要|应该|可以|先)|构造|调用|根据协议|选择全部|拆分|待确认问题)/u.test(text)) return "包含工具编排过程或内部参数";
  if (/(?:让我|我(?:应该|需要)(?:先)?)(?:构造|调用|规划|提交|回答待确认|重新考虑)/u.test(text)) return "包含尚未执行的内部规划";
  return undefined;
}

export interface RuntimeDelivery {
  kind: "runtime_delivery"; version: 1; operation_id: string;
  status: "delivered"; outcome: "result" | "explanation" | "incomplete";
  source_call_ids: string[]; public_answer: string;
  history_sources: {tasks: Array<{task_id: string; result_id?: string}>; organizationScopes: string[][]};
}
export function readRuntimeDelivery(details: unknown): RuntimeDelivery | undefined {
  const d = record(details);
  return d.kind === "runtime_delivery" && d.version === 1 && d.status === "delivered"
    && typeof d.operation_id === "string" && !!d.operation_id && ["result", "explanation", "incomplete"].includes(String(d.outcome))
    && Array.isArray(d.source_call_ids) && d.source_call_ids.every(id => typeof id === "string")
    && Array.isArray(record(d.history_sources).tasks) && Array.isArray(record(d.history_sources).organizationScopes)
    && typeof d.public_answer === "string" && !!d.public_answer.trim() && !publicTextProblem(d.public_answer)
    ? d as unknown as RuntimeDelivery : undefined;
}

/** 实时、宿主终态和历史回放共用的正式正文入口；目录发现和中间分析证据不属于终态。 */
export function receiptDelivery(message: Receipt): string | undefined {
  if (message.isError) return;
  const d = record(message.details);
  const runtime = readRuntimeDelivery(d);
  const direct = readDirectAnswerSnapshot(d);
  const semantic = isSemanticFeedback(d) && Array.isArray(d.issues) && Array.isArray(d.state.targets)
    && Array.isArray(d.pending_questions) && Array.isArray(d.answer_receipts) ? semanticPublicAnswer(d) : undefined;
  let answer = runtime?.public_answer ?? direct?.public_answer ?? semantic ?? presentedAnswer(d)?.public_answer;
  if (answer === undefined && d.kind === "conversation_reply" && d.status === "answered" && typeof d.answer === "string") answer = d.answer;
  if (answer === undefined && d.kind === "business_context" && d.status === "NEEDS_CLARIFICATION" && d.delivery === "frame_clarification_v1"
    && typeof d.public_answer === "string") answer = d.public_answer;
  if (answer === undefined) {
    const evidence = businessEvidences(d).find(item => item.kind === "business_topic_explanation" && item.status === "unsupported"
      || ["business_overview", "business_report"].includes(item.kind) && item.status === "succeeded"
        && ["verified_overview_v1", "verified_report_v1"].includes(item.answer_policy ?? ""));
    if (evidence) answer = evidenceAnswer(evidence);
  }
  return answer !== undefined && !!answer.trim() && !publicTextProblem(answer) ? answer : undefined;
}

export function lastReceiptDelivery(messages: readonly Receipt[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "toolResult") continue;
    const answer = receiptDelivery(message);
    if (answer !== undefined) return answer;
  }
}

/** 普通查询只复用正式事实；分析中间证据必须经过报告校验或现有部分交付工具。 */
export function factualReceiptAnswer(messages: readonly Receipt[]): string | undefined {
  const receipts = messages.filter(message => message.role === "toolResult" && !message.isError);
  const evidence = receipts.flatMap(message => businessEvidences(message.details));
  if (evidence.some(item => ["analysis_evidence", "business_overview"].includes(item.kind)
    && !["verified_overview_v1", "verified_report_v1"].includes(item.answer_policy ?? ""))) return;
  const semantic = [...receipts].reverse().find(message => isSemanticFeedback(message.details));
  if (semantic && isSemanticFeedback(semantic.details) && !["succeeded", "reused"].includes(semantic.details.status)) return;
  const facts = evidence.filter(item => !["catalog", "metric_catalog_overview"].includes(item.kind) && !item.retryable);
  const answer = facts.length ? combinedEvidenceAnswer(facts) : undefined;
  return answer && !publicTextProblem(answer) ? answer : undefined;
}
