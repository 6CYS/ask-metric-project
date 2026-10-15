/**
 * 唯一投影：原生 lane 记录/快照/事件 → 浏览器协议（V3）消息与事件。
 * 历史（GET）、实时（SSE）与重连共用这里的映射，不按工具名取最近一条，
 * 一律按 entry_id/seq、operation_id、tool_call_id 稳定关联。
 */
import type { Entry, LaneSnapshot } from "@earendil-works/pi-agent-core";
import { businessEvidence, businessEvidences, combinedEvidenceAnswer, evidenceAnswer, presentedAnswer, type BusinessEvidence } from "./answerEvidence.js";
import { EVIDENCE_BLOCKED_ANSWER, TOOL_LIMIT_ANSWER, mayDeliverWithoutEvidence } from "./replyGuard.js";
import { MODEL_DEADLINE_EXCEEDED, MODEL_FIRST_RESPONSE_TIMEOUT, MODEL_STREAM_IDLE_EXCEEDED } from "./models.js";
import type { MetricAskDetails } from "./tools/shared.js";
import { CONVERSATION_REPLY } from "./tools/turnContract.js";
import {isSemanticFeedback, semanticPublicAnswer} from "./semantic-task/feedback.js";
import {readDirectAnswerSnapshot} from "./semantic-task/directDelivery.js";

/** 同一正式回执同时投影任务状态和结果表；不从模型正文重建业务结果。 */
function browserToolDetails(details: unknown): unknown {
  if (!isSemanticFeedback(details) || !details.state.evidence) return details;
  return {...details.state.evidence, semantic_task: details};
}

/** 历史消息条目（与前端 AgentSessionMessage 对齐） */
export type ProjectedMessage =
  | { role: "user"; text: string; timestamp: number | null; entry_id: string }
  | { role: "assistant"; text: string; error?: string; tools: string[]; business_protocol?: "frame_v1"; tool_calls?: { id: string; tool: string }[]; timestamp: number | null; entry_id: string }
  | {
      role: "tool";
      tool: string;
      tool_call_id: string;
      details: unknown;
      is_error: boolean;
      timestamp: number | null;
      entry_id: string;
    };

/** 浏览器 SSE 事件（协议 V3）；公共字段由路由层补齐 session/operation/request 关联 */
export type ProjectedEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; tool: string; tool_call_id: string }
  | { type: "tool_end"; tool: string; tool_call_id: string; details: unknown; isError: boolean;
      answer?: Extract<ProjectedMessage, {role: "assistant"}> }
  | { type: "message_done"; text: string; entry_id?: string };

/** 只投影正式工具回执中的版本化快照，稳定身份与原生 assistant 记录明确分开。 */
function directAnswer(details: unknown, timestamp: number | null): Extract<ProjectedMessage, {role: "assistant"}> | undefined {
  const snapshot = readDirectAnswerSnapshot(details);
  return snapshot ? {role: "assistant", text: snapshot.public_answer, tools: [], tool_calls: [],
    business_protocol: "frame_v1", timestamp, entry_id: `direct:${snapshot.answer_id}`} : undefined;
}

interface MessageContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
}

/** 从条目文本块提取可见正文；隐藏思考块不进入投影 */
function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as MessageContentBlock[])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      // 工具轮次前的纯空行文本不展示
      .replace(/^\n+/, "");
  }
  return "";
}

function toolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as MessageContentBlock[])
    .filter((block) => block?.type === "toolCall")
    .map((block) => block.name ?? "");
}

/** 本轮未完成时的固定说明；模型服务超时（含自动重试后仍失败）单独说明，不让用户误以为条件有误。 */
function incompleteAnswer(errorMessage: string): string {
  if (errorMessage === "BUSINESS_BATCH_ARGUMENTS_INVALID") {
    return "本轮业务参数批次未通过校验，原条件已保留，未执行新的查询。请重试本轮请求。";
  }
  if (errorMessage.startsWith(MODEL_STREAM_IDLE_EXCEEDED)) {
    return "模型输出长时间没有进展，本轮未完成。已确认的查询条件仍保留，无需重复输入。";
  }
  return errorMessage.startsWith(MODEL_FIRST_RESPONSE_TIMEOUT) || errorMessage.startsWith(MODEL_DEADLINE_EXCEEDED)
    ? "模型服务响应超时，请稍后重试。已确认的查询条件仍保留，无需重复输入。"
    : "本轮模型响应未完成；已取得的步骤结果仍可查看，请重试未完成部分。";
}

/**
 * 原生条目 → 页面消息。压缩与摘要条目不直接展示；
 * 旧自建 JSON 会话不进入本投影（旧历史只读能力由旧文件承担）。
 */
export function projectEntries(entries: Entry[]): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  let evidence: BusinessEvidence[] = [];
  let question = "";
  let contextClarification = false;
  let frameTurn = false;
  /** 由终止回执投影出的助手回答位置；同轮随后若有真实助手正文（旧会话或兜底路径）则以其替换。 */
  let conversationAnswerAt: number | undefined;
  let directTurnAnswerId: string | undefined;
  const directAnswerIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      toolName?: string;
      toolCallId?: string;
      details?: unknown;
      isError?: boolean;
      errorMessage?: string;
      stopReason?: string;
      businessProtocol?: string;
    };
    const timestamp = message.timestamp ?? entry.timestamp ?? null;
    if (message.role === "user") {
      evidence = [];
      contextClarification = false;
      conversationAnswerAt = undefined;
      directTurnAnswerId = undefined;
      frameTurn = ["frame_v1", "semantic_v2"].includes(message.businessProtocol ?? "");
      question = visibleText(message.content);
      messages.push({ role: "user", text: visibleText(message.content), timestamp, entry_id: entry.id });
    } else if (message.role === "assistant") {
      if (directTurnAnswerId && !toolCallNames(message.content).length) {
        // 正式交付已持久化；非相邻的重放和旧兜底正文也不能再生成第二份答案。
        if (!message.errorMessage && message.stopReason !== "aborted") continue;
        const saved = messages.findIndex(item => item.entry_id === directTurnAnswerId);
        if (saved >= 0) messages.splice(saved, 1);
        directAnswerIds.delete(directTurnAnswerId);
        directTurnAnswerId = undefined;
      }
      // 旧会话在普通回答后仍有一次模型往返，其正文已被宿主替换为同一回答；保留原记录，不重复展示。
      if (conversationAnswerAt === messages.length - 1 && !toolCallNames(message.content).length) messages.pop();
      conversationAnswerAt = undefined;
      messages.push({
        role: "assistant",
        text: message.stopReason === "aborted" ? "已停止生成。" : toolCallNames(message.content).length ? "" : frameTurn && message.errorMessage
          ? incompleteAnswer(message.errorMessage)
          : frameTurn ? visibleText(message.content) : visibleText(message.content) === EVIDENCE_BLOCKED_ANSWER
          ? EVIDENCE_BLOCKED_ANSWER : visibleText(message.content) === TOOL_LIMIT_ANSWER
          ? [combinedEvidenceAnswer(evidence), TOOL_LIMIT_ANSWER].filter(Boolean).join("\n\n") : evidence.length
          ? combinedEvidenceAnswer(evidence) + (message.errorMessage ? "\n\n本轮处理未完成，以上仅为已取得的结果。" : "")
          : contextClarification ? visibleText(message.content) : safeUnverifiedText(visibleText(message.content), question),
        ...(message.errorMessage && message.stopReason !== "aborted" ? {error: incompleteAnswer(message.errorMessage)} : {}),
        ...(frameTurn ? {business_protocol: "frame_v1" as const} : {}),
        tools: toolCallNames(message.content),
        tool_calls: Array.isArray(message.content) ? (message.content as MessageContentBlock[])
          .filter(block => block.type === "toolCall" && block.id && block.name)
          .map(block => ({id: block.id!, tool: block.name!})) : [],
        timestamp,
        entry_id: entry.id,
      });
    } else if (message.role === "toolResult") {
      // 新协议保存 Pi 正文；旧历史继续按其原交付契约回放。
      if (["resolve_business_turn", "business_context_read", "execute_business_frame", "read_business_result"].includes(message.toolName ?? "")) frameTurn = true;
      // 校验/拦截只记入执行过程，不伪造成业务证据覆盖宿主最终说明。
      if (message.toolName === "resolve_business_turn") contextClarification = (message.details as {status?: string})?.status === "NEEDS_CLARIFICATION";
      const current = businessEvidence(message.details);
      if (current) evidence.push(current);
      messages.push({
        role: "tool",
        tool: message.toolName ?? "",
        tool_call_id: message.toolCallId ?? "",
        details: browserToolDetails(message.details) ?? null,
        is_error: Boolean(message.isError),
        timestamp,
        entry_id: entry.id,
      });
      const reply = conversationReply(message) ?? frameClarificationReply(message) ?? semanticPublicAnswer(message.details);
      const savedAnswer = !message.isError ? directAnswer(message.details, timestamp) : undefined;
      if (savedAnswer) {
        directTurnAnswerId = savedAnswer.entry_id;
        conversationAnswerAt = undefined;
        if (!directAnswerIds.has(savedAnswer.entry_id)) {
          messages.push(savedAnswer); directAnswerIds.add(savedAnswer.entry_id);
        }
      } else if (reply !== undefined) {
        // 普通回答或保存状态生成的澄清回执即结束本轮；重连与快照也从同一正式回执投影正文。
        messages.push({role: "assistant", text: frameTurn ? reply : safeUnverifiedText(reply, question),
          ...(frameTurn ? {business_protocol: "frame_v1" as const} : {}), tools: [], tool_calls: [],
          timestamp, entry_id: `${entry.id}:answer`});
        conversationAnswerAt = messages.length - 1;
      }
      const delivered = presentedAnswer(message.details);
      if (delivered) {
        // 最终正文和表格使用同一引用选择；执行日志保留所有步骤，重连不复活排查结果。
        let start = messages.length - 1;
        while (start >= 0 && messages[start]?.role !== "user") start -= 1;
        let index = 0;
        for (const item of messages.slice(start + 1)) {
          if (item.role !== "tool" || !businessEvidence(item.details)) continue;
          index += 1;
          item.details = {...item.details as object, answer_selected: delivered.evidence_refs.includes(`e${index}`)};
        }
        messages.push({role: "assistant", text: delivered.public_answer, tools: [], timestamp, entry_id: `${entry.id}:answer`});
      } else if (!frameTurn && current && !current.retryable && !["succeeded", "catalog", "reference_mismatch"].includes(current.status.toLowerCase())) {
        messages.push({role: "assistant", text: evidenceAnswer(current), tools: [], timestamp, entry_id: `${entry.id}:answer`});
      }
      // 原生 before_tool 的终止拦截不会再产生 assistant；只交付宿主固定的预算理由，
      // 不把任意工具错误当作正文，也不让中间成功掩盖整轮未完成。
      if (message.isError && visibleText(message.content) === TOOL_LIMIT_ANSWER) {
        messages.push({role: "assistant", text: [combinedEvidenceAnswer(evidence), TOOL_LIMIT_ANSWER].filter(Boolean).join("\n\n"),
          tools: [], timestamp, entry_id: `${entry.id}:answer`});
      }
    }
  }
  return messages;
}

function conversationReply(message: {toolName?: string; isError?: boolean; details?: unknown}): string | undefined {
  if (message.toolName !== CONVERSATION_REPLY || message.isError) return undefined;
  const details = message.details as {kind?: unknown; status?: unknown; answer?: unknown} | undefined;
  return details?.kind === "conversation_reply" && details.status === "answered" && typeof details.answer === "string"
    ? details.answer : undefined;
}

function frameClarificationReply(message: {toolName?: string; isError?: boolean; details?: unknown}): string | undefined {
  if (message.toolName !== "resolve_business_turn" || message.isError) return undefined;
  const details = message.details as {kind?: unknown; status?: unknown; delivery?: unknown; public_answer?: unknown} | undefined;
  return details?.kind === "business_context" && details.status === "NEEDS_CLARIFICATION"
    && details.delivery === "frame_clarification_v1" && typeof details.public_answer === "string" ? details.public_answer : undefined;
}

/** 快照投影：重连与进入会话时使用的完整状态 */
export function projectSnapshot(snapshot: LaneSnapshot): {
  running: boolean;
  operation_id: string | null;
  messages: ProjectedMessage[];
} {
  return {
    running: snapshot.operation !== null,
    operation_id: snapshot.operation?.id ?? null,
    messages: projectEntries(snapshot.transcript),
  };
}

/** 原生 watch 事件 → 浏览器事件；无关事件返回 null */
export function projectWatchEvent(event: {
  type: string;
  message?: unknown;
  frame?: { type?: string; delta?: string };
  toolName?: string;
  toolCallId?: string;
  result?: { details?: unknown };
  isError?: boolean;
}): ProjectedEvent | null {
  if (event.type === "message_update") {
    // 原生帧不作为正式正文；开启一期时由 AnswerStreamProjector 单独投影可撤回的临时文本。
    return null;
  }
  if (event.type === "message_end") return null;

  if (event.type === "tool_start") {
    return { type: "tool_start", tool: event.toolName ?? "", tool_call_id: event.toolCallId ?? "" };
  }
  if (event.type === "tool_end") {
    const answer = !event.isError ? directAnswer(event.result?.details, null) : undefined;
    return {
      type: "tool_end",
      tool: event.toolName ?? "",
      tool_call_id: event.toolCallId ?? "",
      details: browserToolDetails(event.result?.details) ?? null,
      isError: Boolean(event.isError),
      ...(answer ? {answer} : {}),
    };
  }
  return null;
}

/** 从投影消息中提取最近一次 metric_ask 结果引用（表格/导出用），没有则为空 */
export function latestResultRef(messages: ProjectedMessage[]): { task_id: string; result_id?: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") continue;
    const details = message.details as MetricAskDetails | null | undefined;
    if (["metric_ask", "metric_query_structured", "metric_read"].includes(details?.kind ?? "") && details?.task_id && details.status === "succeeded") {
      return { task_id: details.task_id, ...(details.result_id ? { result_id: details.result_id } : {}) };
    }
  }
  return null;
}

function safeUnverifiedText(text: string, question: string): string {
  // 历史/重连与宿主使用同一规则，列表序号、用户给定日期不能被误判为无证据金额。
  return mayDeliverWithoutEvidence(text, question) ? text : EVIDENCE_BLOCKED_ANSWER;
}

/** 三种状态分别输出，不能把 Agent completed 当成查询成功。 */
export function projectBusinessTasks(messages: ProjectedMessage[]): Array<Record<string, unknown>> {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  const tasks = new Map<string, BusinessEvidence>();
  for (const message of messages.slice(start + 1)) {
    if (message.role !== "tool") continue;
    for (const evidence of businessEvidences(message.details)) {
      if (evidence.task_id && evidence.kind !== "metric_calculate") tasks.set(evidence.task_id, evidence);
    }
  }
  return [...tasks.values()].map(item => ({ task_id: item.task_id, status: item.status,
    result_id: item.result_id ?? null, error_code: item.error_code ?? null }));
}
