import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createProvisionalAnswerScheduler,
  createChatScrollFollow,
  reconcileAnswerSnapshot,
} from "../src/lib/answerStreamPresentation"
import {
  applyProvisionalAnswer,
  clearProvisionalAnswer,
  type ProvisionalAnswer,
} from "../src/lib/provisionalAnswer"
import type { AgentStreamEvent } from "../src/lib/agentApi"
import type { BusinessReportChart } from "../src/types/api"

// 仅隔离浏览器帧时钟，正文状态与滚动决策使用实际实现。
let callbacks: Map<number, FrameRequestCallback>
let nextFrame: number
beforeEach(() => {
  callbacks = new Map()
  nextFrame = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => callbacks.delete(frame))
})
afterEach(() => vi.unstubAllGlobals())

function advanceFrame() {
  const current = [...callbacks.values()]
  callbacks.clear()
  for (const callback of current) callback(16)
}

function delta(text: string, callSeq = 1): Extract<AgentStreamEvent, { type: "answer_delta" }> {
  return { type: "answer_delta", call_seq: callSeq, mode: "text", text }
}

const previewChart: BusinessReportChart = {
  type: "bar",
  title: "已核验图",
  dates: ["2026-08-27"],
  unit: "元",
  source_refs: ["a", "b"],
  placement: { after_paragraph: 1 },
  points: [
    { name: "甲", value: "12.00", display: "12.00元" },
    { name: "乙", value: "8.00", display: "8.00元" },
  ],
}

function answerHarness() {
  let message: ProvisionalAnswer & { status: string; content: string } = {
    status: "pending",
    content: "",
  }
  const displayed: string[] = []
  const scheduler = createProvisionalAnswerScheduler((_conversationId, _messageId, event) => {
    message = applyProvisionalAnswer(message, event)
    displayed.push(message.provisionalContent ?? "")
  })
  return {
    scheduler,
    displayed,
    message: () => message,
    reset: (callSeq: number) => {
      scheduler.flush("conversation", "answer")
      message = applyProvisionalAnswer(message, {
        type: "answer_reset",
        call_seq: callSeq,
        reason: "retry",
      })
    },
    finish: () => {
      scheduler.flush("conversation", "answer")
      message = { ...clearProvisionalAnswer(message), status: "done", content: "正式正文" }
    },
  }
}

describe("累计正文按浏览器帧展示", () => {
  it("同次调用的重复正文保留消息身份，新调用与撤回后的正文仍可更新", () => {
    const message = { status: "pending", provisionalContent: "已收到正文", provisionalCallSeq: 1 }
    expect(applyProvisionalAnswer(message, delta("已收到正文"))).toBe(message)
    const nextCall = applyProvisionalAnswer(message, delta("已收到正文", 2))
    expect(nextCall).not.toBe(message)
    expect(nextCall.provisionalCallSeq).toBe(2)
    const reset = applyProvisionalAnswer(nextCall, {
      type: "answer_reset",
      call_seq: 2,
      reason: "retry",
    })
    expect(applyProvisionalAnswer(reset, delta("已收到正文", 2)).provisionalContent).toBe(
      "已收到正文",
    )
  })

  it("同帧累计正文只展示最新全文，不拼接重复内容", () => {
    const { scheduler, displayed, message } = answerHarness()
    scheduler.enqueue("conversation", "answer", delta("第一"))
    scheduler.enqueue("conversation", "answer", delta("第一段完整正文"))
    expect(displayed).toEqual([])
    advanceFrame()
    expect(displayed).toEqual(["第一段完整正文"])
    expect(message().provisionalContent).toBe("第一段完整正文")
  })

  it("同帧迟到的旧调用不能覆盖新调用", () => {
    const { scheduler, message } = answerHarness()
    scheduler.enqueue("conversation", "answer", delta("新调用", 2))
    scheduler.enqueue("conversation", "answer", delta("旧调用", 1))
    advanceFrame()
    expect(message().provisionalContent).toBe("新调用")
  })

  it("撤回与终态先处理尚未刷新的正文，后续帧不能复活旧预览", () => {
    const harness = answerHarness()
    harness.scheduler.enqueue("conversation", "answer", delta("待撤回"))
    harness.reset(1)
    advanceFrame()
    expect(harness.message().provisionalContent).toBe("")
    harness.scheduler.enqueue("conversation", "answer", delta("最终预览", 2))
    harness.finish()
    advanceFrame()
    expect(harness.message()).toEqual({ status: "done", content: "正式正文" })
  })

  it("刷新一个会话不提前刷新另一个会话，切换时可完成全部待显示正文", () => {
    const displayed: string[] = []
    const scheduler = createProvisionalAnswerScheduler((conversationId, _messageId, event) => {
      displayed.push(`${conversationId}:${event.text}`)
    })
    scheduler.enqueue("first", "answer", delta("甲"))
    scheduler.enqueue("second", "answer", delta("乙"))
    scheduler.flush("first", "answer")
    expect(displayed).toEqual(["first:甲"])
    scheduler.flush()
    advanceFrame()
    expect(displayed).toEqual(["first:甲", "second:乙"])
  })

  it("清理与卸载取消待刷新的旧正文", () => {
    const { scheduler, displayed } = answerHarness()
    scheduler.enqueue("conversation", "answer", delta("旧账号"))
    scheduler.clear()
    advanceFrame()
    expect(displayed).toEqual([])
    scheduler.enqueue("conversation", "answer", delta("新账号"))
    scheduler.dispose()
    scheduler.enqueue("conversation", "answer", delta("卸载后"))
    advanceFrame()
    expect(displayed).toEqual([])
  })
})

describe("累计正文与已核验图表原子更新", () => {
  it("同帧后续旧协议文本保留同次调用已到达图集，空图集明确清除", () => {
    const test = answerHarness()
    test.scheduler.enqueue("conversation", "answer", { ...delta("第一段"), charts: [previewChart] })
    test.scheduler.enqueue("conversation", "answer", delta("第一段\n\n第二段"))
    advanceFrame()
    expect(test.message()).toMatchObject({
      provisionalContent: "第一段\n\n第二段",
      provisionalCharts: [previewChart],
    })
    test.scheduler.enqueue("conversation", "answer", { ...delta("第一段\n\n第二段"), charts: [] })
    advanceFrame()
    expect(test.message().provisionalCharts).toEqual([])
  })

  it("正文相同仍接收新增图，追加正文复用未变图对象，非法图不影响正文", () => {
    let message = applyProvisionalAnswer({ status: "pending" }, delta("第一段"))
    message = applyProvisionalAnswer(message, { ...delta("第一段"), charts: [previewChart] })
    expect(message.provisionalCharts).toEqual([previewChart])
    const original = message.provisionalCharts?.[0]
    message = applyProvisionalAnswer(message, {
      ...delta("第一段\n\n第二段"),
      charts: structuredClone([previewChart]),
    })
    expect(message.provisionalCharts?.[0]).toBe(original)
    const invalid = { ...previewChart, points: [] }
    message = applyProvisionalAnswer(message, {
      ...delta("合法正文"),
      charts: [invalid, previewChart],
    })
    expect(message).toMatchObject({
      provisionalContent: "合法正文",
      provisionalCharts: [previewChart],
    })
  })

  it("新调用、撤回及正式终态清除图集，迟到旧调用不得复活", () => {
    const test = answerHarness()
    test.scheduler.enqueue("conversation", "answer", { ...delta("旧正文"), charts: [previewChart] })
    test.scheduler.enqueue("conversation", "answer", delta("新调用", 2))
    advanceFrame()
    expect(test.message().provisionalCharts).toBeUndefined()
    test.scheduler.enqueue("conversation", "answer", {
      ...delta("新图", 2),
      charts: [previewChart],
    })
    test.reset(2)
    advanceFrame()
    expect(test.message().provisionalCharts).toBeUndefined()
    test.scheduler.enqueue("conversation", "answer", {
      ...delta("待终态", 3),
      charts: [previewChart],
    })
    test.finish()
    advanceFrame()
    expect(test.message()).toEqual({ status: "done", content: "正式正文" })
    expect(
      applyProvisionalAnswer(test.message(), { ...delta("迟到", 2), charts: [previewChart] }),
    ).toEqual(test.message())
  })

  it("不同会话的同帧文本和图集独立，不让缺图事件继承另一会话图", () => {
    const seen = new Map<string, ProvisionalAnswer>()
    const scheduler = createProvisionalAnswerScheduler((conversation, _message, event) => {
      seen.set(
        conversation,
        applyProvisionalAnswer({ status: "pending", ...seen.get(conversation) }, event),
      )
    })
    scheduler.enqueue("first", "answer", { ...delta("甲"), charts: [previewChart] })
    scheduler.enqueue("second", "answer", delta("乙"))
    advanceFrame()
    expect(seen.get("first")?.provisionalCharts).toEqual([previewChart])
    expect(seen.get("second")?.provisionalCharts).toBeUndefined()
  })
})

describe("回答自动滚动", () => {
  it("同帧多次请求只滚动一次，并读取更新后的高度", () => {
    let top = 400
    let writes = 0
    const container = {
      clientHeight: 200,
      scrollHeight: 600,
      get scrollTop() {
        return top
      },
      set scrollTop(value: number) {
        writes++
        top = value
      },
    }
    const follow = createChatScrollFollow(() => container)
    follow.request()
    follow.request()
    container.scrollHeight = 800
    advanceFrame()
    expect(top).toBe(800)
    expect(writes).toBe(1)
  })

  it("用户上翻后取消待滚动，回到底部才继续跟随", () => {
    const container = { scrollTop: 400, clientHeight: 200, scrollHeight: 600 }
    const follow = createChatScrollFollow(() => container)
    follow.onScroll()
    follow.request()
    container.scrollTop = 390
    follow.onScroll()
    container.scrollHeight = 900
    advanceFrame()
    expect(container.scrollTop).toBe(390)
    follow.request()
    advanceFrame()
    expect(container.scrollTop).toBe(390)
    container.scrollTop = 700
    follow.onScroll()
    follow.request()
    container.scrollHeight = 1000
    advanceFrame()
    expect(container.scrollTop).toBe(1000)
  })

  it("新问题可主动滚底，切换会话取消旧帧且不影响新会话滚动", () => {
    let container = { scrollTop: 10, clientHeight: 200, scrollHeight: 600 }
    const follow = createChatScrollFollow(() => container)
    follow.onScroll()
    follow.request(true)
    advanceFrame()
    expect(container.scrollTop).toBe(600)
    follow.request()
    follow.reset()
    container = { scrollTop: 0, clientHeight: 200, scrollHeight: 900 }
    advanceFrame()
    expect(container.scrollTop).toBe(0)
    follow.request()
    follow.dispose()
    follow.request(true)
    advanceFrame()
    expect(container.scrollTop).toBe(0)
  })

  it("撤回预览导致页面缩短时，仍在底部的用户继续跟随新正文", () => {
    const container = { scrollTop: 400, clientHeight: 200, scrollHeight: 600 }
    const follow = createChatScrollFollow(() => container)
    follow.onScroll()
    // 浏览器会把 scrollTop 限制到缩短后的底部，这不是用户主动上翻。
    container.scrollHeight = 300
    container.scrollTop = 100
    follow.onScroll()
    container.scrollHeight = 800
    follow.request()
    advanceFrame()
    expect(container.scrollTop).toBe(800)
  })
})

describe("重连快照与临时正文", () => {
  const previous = {
    id: "answer",
    role: "assistant" as const,
    status: "pending" as const,
    nativeAnswer: true,
    content: "",
    provisionalContent: "已核验第一段",
    provisionalCallSeq: 3,
    provisionalCharts: [previewChart],
  }
  const restored = {
    id: "snapshot-answer",
    role: "assistant" as const,
    status: "done" as const,
    content: "",
  }
  const context = {
    running: true,
    operationId: "operation",
    previousOperationId: "operation",
    stream: { call_seq: 3, mode: "text" as const },
  }

  it("同次执行和同次正文生成的快照保留已显示段落，并继续接收增量", () => {
    const answer = reconcileAnswerSnapshot(restored, previous, context)
    expect(answer.status).toBe("pending")
    expect(answer.provisionalContent).toBe("已核验第一段")
    expect(answer.provisionalCallSeq).toBe(3)
    expect(answer.provisionalCharts).toEqual([previewChart])
    expect(answer.nativeAnswer).toBe(true)
    expect(
      applyProvisionalAnswer(answer, delta("已核验第一段\n\n第二段", 3)).provisionalContent,
    ).toContain("第二段")
  })

  it("没有本地预览的刷新仍建立pending正文，等待观察流恢复", () => {
    expect(reconcileAnswerSnapshot(restored, undefined, context)).toMatchObject({
      status: "pending",
    })
  })

  it("任务或模型尝试变化，以及撤回后的快照不继承旧预览", () => {
    for (const changed of [
      { ...context, operationId: "new-operation" },
      { ...context, stream: { call_seq: 4, mode: "text" as const } },
      { ...context, stream: { call_seq: 3, mode: "none" as const } },
      { ...context, stream: null },
      { ...context, stream: undefined },
    ]) {
      const answer = reconcileAnswerSnapshot(restored, previous, changed)
      expect(answer.provisionalContent).toBeUndefined()
      expect(answer.provisionalCharts).toBeUndefined()
      expect(answer.status).toBe("pending")
    }
  })

  it("终态与已交付正式正文替换预览，保留正式报告附件", () => {
    const final = {
      ...restored,
      content: "正式正文",
      answerDelivered: true,
      response: { chart: "formal-chart" },
    }
    expect(reconcileAnswerSnapshot(final, previous, { ...context, running: false })).toEqual(final)
    expect(reconcileAnswerSnapshot(final, previous, context)).toEqual(final)
    const failed = reconcileAnswerSnapshot(
      { ...restored, status: "error" as const, provisionalCharts: [previewChart] },
      previous,
      { ...context, running: false },
    )
    expect(failed.provisionalCharts).toBeUndefined()
  })

  it("已完成或停止的本地气泡不会把旧预览带入运行快照", () => {
    const stopped = { ...previous, status: "done" as const }
    expect(reconcileAnswerSnapshot(restored, stopped, context).provisionalContent).toBeUndefined()
  })
})
