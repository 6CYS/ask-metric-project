/**
 * 唯一投影：原生 lane 记录/快照/事件 → 浏览器协议（V3）消息与事件。
 * 历史（GET）、实时（SSE）与重连共用这里的映射，不按工具名取最近一条，
 * 一律按 entry_id/seq、operation_id、tool_call_id 稳定关联。
 */
import type { Entry, LaneSnapshot } from "@earendil-works/pi-agent-core";
import { businessEvidence, combinedEvidenceAnswer, evidenceAnswer, presentedAnswer, type BusinessEvidence } from "./answerEvidence.js";
import { EVIDENCE_BLOCKED_ANSWER, TOOL_LIMIT_ANSWER, mayDeliverWithoutEvidence } from "./replyGuard.js";
import type { MetricAskDetails } from "./tools/metricAsk.js";

/** 历史消息条目（与前端 AgentSessionMessage 对齐） */
export type ProjectedMessage =
  | { role: "user"; text: string; timestamp: number | null; entry_id: string }
  | { role: "assistant"; text: string; tools: string[]; tool_calls?: { id: string; tool: string }[]; timestamp: number | null; entry_id: string }
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
  | { type: "tool_end"; tool: string; tool_call_id: string; details: unknown; isError: boolean }
  | { type: "message_done"; text: string };

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

/**
 * 原生条目 → 页面消息。压缩与摘要条目不直接展示；
 * 旧自建 JSON 会话不进入本投影（旧历史只读能力由旧文件承担）。
 */
export function projectEntries(entries: Entry[]): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  let evidence: BusinessEvidence[] = [];
  let question = "";
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
    };
    const timestamp = message.timestamp ?? entry.timestamp ?? null;
    if (message.role === "user") {
      evidence = [];
      question = visibleText(message.content);
      messages.push({ role: "user", text: visibleText(message.content), timestamp, entry_id: entry.id });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        text: toolCallNames(message.content).length ? "" : visibleText(message.content) === EVIDENCE_BLOCKED_ANSWER
          ? EVIDENCE_BLOCKED_ANSWER : visibleText(message.content) === TOOL_LIMIT_ANSWER
          ? [combinedEvidenceAnswer(evidence), TOOL_LIMIT_ANSWER].filter(Boolean).join("\n\n") : evidence.length
          ? combinedEvidenceAnswer(evidence) + (message.errorMessage ? "\n\n本轮处理未完成，以上仅为已取得的结果。" : "")
          : safeUnverifiedText(visibleText(message.content), question),
        tools: toolCallNames(message.content),
        tool_calls: Array.isArray(message.content) ? (message.content as MessageContentBlock[])
          .filter(block => block.type === "toolCall" && block.id && block.name)
          .map(block => ({id: block.id!, tool: block.name!})) : [],
        timestamp,
        entry_id: entry.id,
      });
    } else if (message.role === "toolResult") {
      // 校验/拦截只记入执行过程，不伪造成业务证据覆盖宿主最终说明。
      const current = businessEvidence(message.details);
      if (current) evidence.push(current);
      messages.push({
        role: "tool",
        tool: message.toolName ?? "",
        tool_call_id: message.toolCallId ?? "",
        details: message.details ?? null,
        is_error: Boolean(message.isError),
        timestamp,
        entry_id: entry.id,
      });
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
      } else if (current && !current.retryable && !["succeeded", "catalog", "reference_mismatch"].includes(current.status.toLowerCase())) {
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
    // 原生帧在 after_response 之前产生，事实正文必须等持久化后统一投影。
    return null;
  }
  if (event.type === "message_end") return null;

  if (event.type === "tool_start") {
    return { type: "tool_start", tool: event.toolName ?? "", tool_call_id: event.toolCallId ?? "" };
  }
  if (event.type === "tool_end") {
    return {
      type: "tool_end",
      tool: event.toolName ?? "",
      tool_call_id: event.toolCallId ?? "",
      details: event.result?.details ?? null,
      isError: Boolean(event.isError),
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
    if ((details?.kind === "metric_ask" || (details as { kind?: string })?.kind === "metric_read") && details?.task_id && details.status === "succeeded") {
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
    const evidence = businessEvidence(message.details);
    if (evidence?.task_id && evidence.kind !== "metric_calculate") tasks.set(evidence.task_id, evidence);
  }
  return [...tasks.values()].map(item => ({ task_id: item.task_id, status: item.status,
    result_id: item.result_id ?? null, error_code: item.error_code ?? null }));
}
