/**
 * 唯一投影：原生 lane 记录/快照/事件 → 浏览器协议（V3）消息与事件。
 * 历史（GET）、实时（SSE）与重连共用这里的映射，不按工具名取最近一条，
 * 一律按 entry_id/seq、operation_id、tool_call_id 稳定关联。
 */
import type { Entry, LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { MetricAskDetails } from "./tools/metricAsk.js";

/** 历史消息条目（与前端 AgentSessionMessage 对齐） */
export type ProjectedMessage =
  | { role: "user"; text: string; timestamp: number | null; entry_id: string }
  | { role: "assistant"; text: string; tools: string[]; timestamp: number | null; entry_id: string }
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
    };
    const timestamp = message.timestamp ?? entry.timestamp ?? null;
    if (message.role === "user") {
      messages.push({ role: "user", text: visibleText(message.content), timestamp, entry_id: entry.id });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        text: visibleText(message.content),
        tools: toolCallNames(message.content),
        timestamp,
        entry_id: entry.id,
      });
    } else if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool: message.toolName ?? "",
        tool_call_id: message.toolCallId ?? "",
        details: message.details ?? null,
        is_error: Boolean(message.isError),
        timestamp,
        entry_id: entry.id,
      });
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
    // 只投影文本增量；思考帧与工具参数帧不下发
    if (event.frame?.type === "text_delta" && typeof event.frame.delta === "string") {
      return { type: "text_delta", delta: event.frame.delta };
    }
    return null;
  }
  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") return null;
    const text = visibleText(message.content);
    return text.trim() ? { type: "message_done", text } : null;
  }
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
    if (details?.kind === "metric_ask" && details.task_id && details.status === "succeeded") {
      return { task_id: details.task_id, ...(details.result_id ? { result_id: details.result_id } : {}) };
    }
  }
  return null;
}
