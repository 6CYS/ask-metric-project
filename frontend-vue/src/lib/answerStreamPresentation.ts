import type { AgentSnapshot, AgentStreamEvent } from "./agentApi"
import { clearProvisionalAnswer, type ProvisionalAnswer } from "./provisionalAnswer"

type AnswerDelta = Extract<AgentStreamEvent, { type: "answer_delta" }>

export function createProvisionalAnswerScheduler(
  apply: (conversationId: string, messageId: string, event: AnswerDelta) => void,
) {
  const pending = new Map<
    string,
    { conversationId: string; messageId: string; event: AnswerDelta }
  >()
  let frame: number | null = null
  let disposed = false

  function cancelFrame() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }

  function flush(conversationId?: string, messageId?: string) {
    for (const [key, update] of pending) {
      if (
        conversationId !== undefined &&
        (update.conversationId !== conversationId || update.messageId !== messageId)
      )
        continue
      pending.delete(key)
      apply(update.conversationId, update.messageId, update.event)
    }
    if (!pending.size) cancelFrame()
  }

  function clear() {
    cancelFrame()
    pending.clear()
  }

  return {
    enqueue(conversationId: string, messageId: string, event: AnswerDelta) {
      if (
        disposed ||
        !Number.isSafeInteger(event.call_seq) ||
        event.call_seq < 1 ||
        typeof event.text !== "string"
      )
        return
      const key = JSON.stringify([conversationId, messageId])
      const previous = pending.get(key)
      if (previous && event.call_seq < previous.event.call_seq) return
      // answer_delta 是累计全文；同帧只需要最新一次，不能拼接成重复正文。
      pending.set(key, { conversationId, messageId, event })
      if (frame === null)
        frame = requestAnimationFrame(() => {
          frame = null
          flush()
        })
    },
    flush,
    clear,
    dispose() {
      disposed = true
      clear()
    },
  }
}

type ScrollContainer = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">

export function createChatScrollFollow(getContainer: () => ScrollContainer | null) {
  let following = true
  let lastScrollTop = getContainer()?.scrollTop ?? 0
  let frame: number | null = null
  let disposed = false

  function cancelFrame() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }

  return {
    request(force = false) {
      if (disposed) return
      if (force) following = true
      if (!following || frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        if (!following) return
        const container = getContainer()
        if (container) {
          container.scrollTop = container.scrollHeight
          lastScrollTop = container.scrollTop
        }
      })
    },
    onScroll() {
      const container = getContainer()
      if (!container) return
      // 向上阅读立即停止跟随，即使只上翻少量像素；回到底部后恢复。
      // 撤回正文会缩短页面并自动压低 scrollTop，仍在底部时不能误判为上翻。
      const remaining = container.scrollHeight - container.clientHeight - container.scrollTop
      following = remaining <= 1 || (container.scrollTop >= lastScrollTop && remaining <= 48)
      lastScrollTop = container.scrollTop
      if (!following) cancelFrame()
    },
    reset() {
      cancelFrame()
      following = true
      lastScrollTop = getContainer()?.scrollTop ?? 0
    },
    dispose() {
      disposed = true
      cancelFrame()
    },
  }
}

interface SnapshotAnswer extends ProvisionalAnswer {
  id: string
  role: "assistant" | "user"
  status?: "pending" | "done" | "error"
  content: string
  answerDelivered?: boolean
  nativeAnswer?: boolean
}

interface AnswerSnapshotContext {
  running: boolean
  operationId?: string | null
  previousOperationId?: string | null
  stream?: AgentSnapshot["answer_stream"]
}

export function reconcileAnswerSnapshot<T extends SnapshotAnswer>(
  restored: T,
  previous: SnapshotAnswer | undefined,
  context: AnswerSnapshotContext,
): T & SnapshotAnswer {
  const answer = clearProvisionalAnswer(restored)
  if (!context.running || restored.role !== "assistant" || restored.answerDelivered) return answer
  const stream = context.stream
  // 快照不持久化预览；只保留服务端确认仍有效的同一次正文，重试与撤回不能复活旧段落。
  const keepPreview =
    previous?.status === "pending" &&
    !!context.operationId &&
    context.operationId === context.previousOperationId &&
    stream &&
    stream.mode !== "none" &&
    stream.call_seq === previous.provisionalCallSeq
  return {
    ...answer,
    status: "pending",
    nativeAnswer: restored.nativeAnswer ?? previous?.nativeAnswer ?? true,
    ...(keepPreview
      ? {
          provisionalContent: previous.provisionalContent,
          provisionalCallSeq: previous.provisionalCallSeq,
        }
      : {}),
  }
}
