import { afterEach, describe, expect, it, vi } from "vitest"
import { observeAgentSession, type AgentStreamEvent } from "../src/lib/agentApi"

// 只隔离HTTP响应，真实SSE解析与取消边界均通过公开观察入口执行。
afterEach(() => vi.unstubAllGlobals())

function block(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

const lateDelta = { type: "answer_delta", call_seq: 1, mode: "text", text: "不应晚到" } as const
const terminal = { type: "run_terminal", run_status: "completed", answer_status: "ok" } as const

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
