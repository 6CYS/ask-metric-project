import { afterEach, describe, expect, it, vi } from "vitest"
import { createSSRApp, type Component, type ComponentPublicInstance } from "vue"
import { renderToString } from "vue/server-renderer"
import BackendNextChatPanel from "../src/components/chat/BackendNextChatPanel.vue"
import {
  cancelAgentOperation,
  cancelAgentRequest,
  getAgentSession,
  observeAgentSession,
  type AgentStreamEvent,
} from "../src/lib/agentApi"

// 只隔离HTTP响应，真实SSE解析与取消边界均通过公开观察入口执行。
afterEach(() => vi.unstubAllGlobals())

function block(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

const lateDelta = { type: "answer_delta", call_seq: 1, mode: "text", text: "不应晚到" } as const
const terminal = { type: "run_terminal", run_status: "completed", answer_status: "ok" } as const

describe("显式停止接口", () => {
  it.each([
    { status: 202, expected: "queued" },
    { status: 204, expected: "confirmed" },
  ])("接纳 $status 空响应，不要求代理补充 Content-Length", async ({ status, expected }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response(null, { status })))
    vi.stubGlobal("fetch", fetcher)

    await expect(cancelAgentRequest("session/a", "request-a")).resolves.toBe(expected)
    await expect(cancelAgentOperation("session/a", "operation-a")).resolves.toBe(expected)
    expect(
      fetcher.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: init?.body })),
    ).toEqual([
      {
        url: "/agent-api/sessions/session%2Fa/cancel",
        method: "POST",
        body: '{"request_id":"request-a"}',
      },
      {
        url: "/agent-api/sessions/session%2Fa/cancel",
        method: "POST",
        body: '{"operation_id":"operation-a"}',
      },
    ])
  })

  it("停止被服务端拒绝时仍保留错误和状态码", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ detail: "无权访问该会话" }, { status: 403 })),
    )
    await expect(cancelAgentRequest("session", "request")).rejects.toMatchObject({
      status: 403,
      message: "无权访问该会话",
    })
  })

  it("未知成功状态不能被误认成已停止", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)))
    await expect(cancelAgentOperation("session", "operation")).rejects.toMatchObject({
      status: 200,
    })
  })

  it("详情接口仍要求 JSON，不把缺少正文当成有效详情", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)))
    await expect(getAgentSession("session")).rejects.toBeInstanceOf(SyntaxError)
  })
})

type ChatState = {
  conversations: Array<{
    id: string
    serverId: string
    title: string
    preview: string
    loaded: boolean
    persisted: boolean
    running: boolean
    activeOperationId: string
    questionStates: []
    messages: Array<{
      id: string
      role: string
      content: string
      status: string
      nativeAnswer: boolean
      toolCalls?: Array<{ tool: string; status: string; summary?: { note?: string; conditions?: Array<{ label: string; value: string }> } }>
      activities?: Array<{ id: string; label: string; status: string; startedAt: number; summary?: { note?: string; conditions?: Array<{ label: string; value: string }> } }>
      retryable?: boolean
    }>
  }>
  message: string
  activeConversationId: string
  prepareQuestionRetry(message: ChatState["conversations"][number]["messages"][number]): Promise<void>
  activeConversationIsStopping: boolean
  abortControllers: Map<string, AbortController>
  markConversationSending(id: string, sending: boolean): void
  stopActiveConversation(): Promise<void>
  failMessage(conversationId: string, messageId: string, error: unknown): void
  handleStreamEvent(id: string, assistantId: string, event: AgentStreamEvent): void
}

async function chat() {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  )
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  let state: ChatState | undefined
  const component = BackendNextChatPanel as Component
  const app = createSSRApp(component)
  app.mixin({
    created(this: ComponentPublicInstance) {
      if (
        this.$.type === component ||
        this.$.type.__file === (component as { __file?: string }).__file
      ) {
        state = Reflect.get(this.$, "setupState") as ChatState
      }
    },
  })
  // 使用真实组件处理器；只隔离 HTTP，SSR 不启动真实模型、目录预取或浏览器定时轮询。
  await renderToString(app)
  if (!state) throw new Error("未捕获聊天组件状态")
  state.conversations = ["one", "two"].map((id) => ({
    id,
    serverId: id,
    title: "隔离会话",
    preview: "",
    loaded: true,
    persisted: true,
    running: true,
    activeOperationId: `operation-${id}`,
    questionStates: [],
    messages: [
      { id: "answer", role: "assistant", content: "", status: "pending", nativeAnswer: true },
    ],
  }))
  state.activeConversationId = "one"
  state.markConversationSending("one", true)
  const controller = new AbortController()
  state.abortControllers.set("one", controller)
  return { state, controller }
}

describe("聊天停止的异步确认", () => {
  it("202 保留观察与待完成状态，重复点击不重发，终态才清除停止提示", async () => {
    const { state, controller } = await chat()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal("fetch", fetcher)
    await Promise.all([state.stopActiveConversation(), state.stopActiveConversation()])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(controller.signal.aborted).toBe(false)
    expect(state.activeConversationIsStopping).toBe(true)
    expect(state.conversations[0]).toMatchObject({
      running: true,
      messages: [{ status: "pending", content: "" }],
    })
    state.handleStreamEvent("one", "answer", {
      type: "run_terminal",
      run_status: "aborted",
      answer_status: "idle",
    })
    expect(state.activeConversationIsStopping).toBe(false)
    expect(state.conversations[0]).toMatchObject({ running: false, messages: [{ status: "done" }] })
  })

  it("204 保留原行为，停止当前观察且不留下等待提示", async () => {
    const { state, controller } = await chat()
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    )
    await state.stopActiveConversation()
    expect(controller.signal.aborted).toBe(true)
    expect(state.activeConversationIsStopping).toBe(false)
  })

  it("停止中切换会话不把提示带到其他会话，流出错后清除原提示", async () => {
    const { state } = await chat()
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 })),
    )
    await state.stopActiveConversation()
    state.activeConversationId = "two"
    expect(state.activeConversationIsStopping).toBe(false)
    expect(() =>
      state.handleStreamEvent("one", "answer", { type: "error", message: "观察连接中断" }),
    ).toThrow("观察连接中断")
    state.activeConversationId = "one"
    expect(state.activeConversationIsStopping).toBe(false)
  })

  it("终态早于停止请求回执时，迟到的 202 不重新进入停止中", async () => {
    const { state, controller } = await chat()
    let respond: (value: Response) => void = () => {
      throw new Error("停止请求尚未发出")
    }
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve
          }),
      ),
    )
    const stopping = state.stopActiveConversation()
    expect(state.activeConversationIsStopping).toBe(true)
    state.handleStreamEvent("one", "answer", terminal)
    respond(new Response(null, { status: 202 }))
    await stopping
    expect(state.activeConversationIsStopping).toBe(false)
    expect(controller.signal.aborted).toBe(false)
    expect(state.conversations[0]?.running).toBe(false)
  })

  it("上一轮迟到的停止确认不能清除下一轮正在等待的停止状态", async () => {
    const { state } = await chat()
    let confirm: (value: Response) => void = () => {
      throw new Error("未发送停止请求")
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            confirm = resolve
          }),
      )
      .mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal("fetch", fetcher)
    const previous = state.stopActiveConversation()
    state.handleStreamEvent("one", "answer", terminal)
    state.conversations[0]!.running = true
    state.conversations[0]!.activeOperationId = "next-operation"
    const current = new AbortController()
    state.abortControllers.set("one", current)
    await state.stopActiveConversation()
    confirm(new Response(null, { status: 204 }))
    await previous
    expect(current.signal.aborted).toBe(false)
    expect(state.activeConversationIsStopping).toBe(true)
  })
})

describe("SSE观察取消", () => {
  it("同一网络块的首个事件触发停止后，不继续交付已缓冲正文", async () => {
    const controller = new AbortController()
    const events: AgentStreamEvent[] = []
    const response = new Response(block({ type: "progress" }) + block(lateDelta) + block(terminal))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    vi.stubGlobal("fetch", fetcher)
    await expect(
      observeAgentSession("session", {
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event)
          controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(events.map((event) => event.type)).toEqual(["progress"])
  })

  it("等待读取期间取消后，随后到达的数据不进入消息状态", async () => {
    const controller = new AbortController()
    const events: AgentStreamEvent[] = []
    let incoming: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start: (stream) => {
        incoming = stream
      },
    })
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
    const result = observeAgentSession("session", {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    })
    await Promise.resolve()
    controller.abort()
    incoming?.enqueue(new TextEncoder().encode(block(lateDelta) + block(terminal)))
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(events).toEqual([])
  })

  it("终态之后同块中的晚到预览不能再覆盖正式结果", async () => {
    const events: AgentStreamEvent[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(block(terminal) + block(lateDelta))),
    )
    await observeAgentSession("session", { onEvent: (event) => events.push(event) })
    expect(events).toEqual([terminal])
  })

  it("刷新恢复只GET观察原会话，不重新提交问题", async () => {
    const events: AgentStreamEvent[] = []
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(block(terminal)))
    vi.stubGlobal("fetch", fetcher)
    await observeAgentSession("original-session", { onEvent: (event) => events.push(event) })
    expect(events).toEqual([terminal])
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe("/agent-api/sessions/original-session/stream")
    expect(init?.method).toBe("GET")
    expect(init?.body).toBeUndefined()
  })
})


describe("模型故障的消息收尾", () => {
  it.each([
    { run_status: "failed", answer_status: "error" },
    { run_status: "aborted", answer_status: "idle" },
  ])("$run_status 不将未结束步骤伪装成已完成", async (terminal) => {
    const { state } = await chat()
    state.conversations[0]!.messages[0]!.toolCalls = [{ tool: "metric_query", status: "running" }]
    state.conversations[0]!.messages[0]!.activities = [{ id: "model", label: "模型服务连接恢复", status: "running", startedAt: Date.now() }]
    state.handleStreamEvent("one", "answer", { type: "run_terminal", ...terminal })
    expect(state.conversations[0]!.messages[0]).toMatchObject({
      toolCalls: [{ status: "interrupted" }], activities: [{ status: "interrupted" }],
    })
  })

  it("429 保留已正式交付正文，给出繁忙原因而不再报整轮执行失败", async () => {
    const { state } = await chat()
    state.conversations[0]!.messages[0]!.content = "已经核验并交付的第一部分。"
    state.handleStreamEvent("one", "answer", {
      type: "run_terminal", run_status: "failed", answer_status: "error", error_code: "MODEL_RATE_LIMITED",
    })
    expect(state.conversations[0]!.messages[0]!.content).toContain("已经核验并交付的第一部分。")
    expect(state.conversations[0]!.messages[0]!.content).toContain("请求较多")
    expect(state.conversations[0]!.running).toBe(false)
  })

  it("重新提问只回填末轮问题，不自动发起模型请求", async () => {
    const { state } = await chat()
    state.markConversationSending("one", false)
    state.conversations[0]!.running = false
    state.conversations[0]!.messages.unshift({ id: "question", role: "user", content: "原问题", status: "done", nativeAnswer: true })
    const answer = state.conversations[0]!.messages[1]!
    answer.status = "error"
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetcher)
    await state.prepareQuestionRetry(answer)
    expect(state.message).toBe("原问题")
    expect(fetcher).not.toHaveBeenCalled()
    expect(state.conversations[0]!.messages).toHaveLength(2)
    state.message = "尚未发送的草稿"
    await state.prepareQuestionRetry(answer)
    expect(state.message).toBe("尚未发送的草稿")
    state.message = ""
    state.conversations[0]!.running = true
    await state.prepareQuestionRetry(answer)
    expect(state.message).toBe("")
    state.conversations[0]!.running = false
    answer.retryable = false
    await state.prepareQuestionRetry(answer)
    expect(state.message).toBe("")
    answer.retryable = true
    state.conversations[0]!.messages.push({ id: "later-question", role: "user", content: "后续问题", status: "done", nativeAnswer: true })
    await state.prepareQuestionRetry(answer)
    expect(state.message).toBe("")
  })
})


describe("停止后的进展文案", () => {
  it.each(["terminal-aborted", "terminal-failed", "local-aborted", "local-failed"])("%s 清除未结束动作的动态提示，保留条件和已完成记录", async (path) => {
    const { state } = await chat()
    const conditions = [{ label: "机构", value: "已选机构" }]
    const answer = state.conversations[0]!.messages[0]!
    answer.activities = [
      { id: "model-retry", label: "重试模型服务", status: "running", startedAt: Date.now(), summary: { note: "正在进行第 1 次重试，可停止等待。", conditions } },
      { id: "confirmed", label: "确认条件", status: "done", startedAt: Date.now(), summary: { note: "已确认查询条件" } },
    ]
    answer.toolCalls = [{ tool: "metric_query", status: "running", summary: { note: "正在查询", conditions } }]
    if (path.startsWith("terminal")) state.handleStreamEvent("one", "answer", {
      type: "run_terminal", run_status: path.endsWith("aborted") ? "aborted" : "failed", answer_status: path.endsWith("aborted") ? "idle" : "error",
    })
    else state.failMessage("one", "answer", path.endsWith("aborted") ? new DOMException("停止", "AbortError") : new Error("连接中断"))
    const result = state.conversations[0]!.messages[0]!
    expect(result.activities?.[0]).toMatchObject({ status: "interrupted", summary: { conditions } })
    expect(result.activities?.[0]?.summary?.note).toBeUndefined()
    expect(result.toolCalls?.[0]).toMatchObject({ status: "interrupted", summary: { conditions } })
    expect(result.toolCalls?.[0]?.summary?.note).toBeUndefined()
    expect(result.activities?.[1]?.summary?.note).toBe("已确认查询条件")
  })
})
