import type { BackendNextClarification, BackendNextConversationMessage, BackendNextConversationTask, ChatResponse } from "@/types/api"
import { isRetiredContextTask } from "@/lib/taskAdvance"
import { clarificationDisplayField } from "@/lib/clarificationOptions"

/** Prefer the persisted message timestamp; keep compatibility with older snapshots. */
export function conversationMessageTime(message: BackendNextConversationMessage) {
  return [message.created_at, message.payload?.created_at].find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()) && !Number.isNaN(Date.parse(value)),
  )
}

export function clarificationTranscript(clarification: Partial<BackendNextClarification>, fallback = "") {
  const messages = [...new Set((clarification.fields ?? []).map((field) => clarificationDisplayField(field).message.trim()).filter(Boolean))]
  return messages.join("\n") || clarification.prompt || fallback || "请补充查询条件。"
}

export function archiveClarificationResponse(response?: ChatResponse): ChatResponse | undefined {
  if (!response?.clarification) return response
  return { ...response, answer: clarificationTranscript(response.clarification, response.answer), clarification: null }
}

/** 同一任务可以多次澄清，仅最后一条未结束的澄清允许交互。 */
export function activeClarificationMessageIds(messages: BackendNextConversationMessage[], tasks: BackendNextConversationTask[]) {
  // 会话可能保留多个旧草稿，输入框只能补充最新任务，不能回退到较早的待澄清任务。
  const current = tasks[tasks.length - 1]
  const retired = current ? isRetiredContextTask(current) : false
  const waiting = new Set(current?.status === "WAITING_USER" && current.query_shape !== "attribution_analysis" && !retired ? [current.id] : [])
  const latest = new Map<string, string>()
  for (const message of orderConversationMessages(messages, tasks)) {
    if (message.role === "assistant" && message.payload?.kind === "clarification" && message.task_id && waiting.has(message.task_id)
      && !["analysis", "multiturn_context", "result_reference"].includes((message.payload.clarification as { type?: string } | undefined)?.type ?? "")) {
      latest.set(message.task_id, message.id)
    }
  }
  return new Set(latest.values())
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

function numeric(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 历史消息按任务轮次和任务内事件排序，不能依赖数据库时间戳。
 * 旧数据中用户消息由应用写 UTC，而助手消息曾使用数据库本地时区，直接按时间会导致问答错位。
 */
export function orderConversationMessages(
  messages: BackendNextConversationMessage[],
  tasks: BackendNextConversationTask[],
) {
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]))
  const clarificationVersions = new Map<string, number>()
  for (const message of messages) {
    if (message.payload?.kind !== "clarification") continue
    const clarification = message.payload.clarification
    const clarificationPayload = clarification && typeof clarification === "object"
      ? clarification as Record<string, unknown>
      : {}
    const id = text(message.payload.clarification_id) || text(clarificationPayload.id)
    if (id) clarificationVersions.set(id, numeric(message.payload.task_version ?? clarificationPayload.task_version))
  }

  const eventOrder = (message: BackendNextConversationMessage) => {
    const payload = message.payload ?? {}
    const kind = text(payload.kind)
    if (kind === "question") return 0
    if (kind === "clarification") return 100 + numeric(payload.task_version) * 10
    if (kind === "clarification_answer") {
      return 101 + (clarificationVersions.get(text(payload.clarification_id)) ?? 0) * 10
    }
    if (kind === "resolved_question") return 900_000
    if (["query_result", "task_error", "unsupported_scope", "intent_boundary"].includes(kind)) return 1_000_000
    return message.role === "user" ? 10 : 999_000
  }

  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTask = left.message.task_id ? taskOrder.get(left.message.task_id) : undefined
      const rightTask = right.message.task_id ? taskOrder.get(right.message.task_id) : undefined
      const taskDifference = (leftTask ?? tasks.length) - (rightTask ?? tasks.length)
      if (taskDifference) return taskDifference
      return eventOrder(left.message) - eventOrder(right.message) || left.index - right.index
    })
    .map(({ message }) => message)
}

/** Internal state-machine messages are persisted for audit/debug, not chat display. */
export function visibleConversationMessages(
  messages: BackendNextConversationMessage[],
  tasks: BackendNextConversationTask[],
) {
  return orderConversationMessages(messages, tasks)
    .filter((message) => message.payload?.kind !== "resolved_question")
}
