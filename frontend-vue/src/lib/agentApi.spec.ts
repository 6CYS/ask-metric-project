import {afterEach, expect, it, vi} from "vitest"
import {observeAgentSession, promptAgentSession} from "./agentApi"

vi.mock("@/lib/authSession", () => ({getAccessToken: () => "synthetic", clearAccessToken: vi.fn(), setAuthFailureReason: vi.fn()}))
afterEach(() => vi.unstubAllGlobals())

it("提问声明支持累计回答，解析新事件并忽略未知事件；GET 重连只读取快照", async () => {
  const blocks = [
    ["accepted", {}], ["future_event", {text: "应忽略"}],
    ["answer_delta", {call_seq: 1, mode: "reply", text: "你好"}],
    ["answer_reset", {call_seq: 1, reason: "tool_call"}],
    ["snapshot", {messages: [], running: false, operation_id: null}],
    ["run_terminal", {run_status: "completed", answer_status: "ok"}],
  ]
  const fetcher = vi.fn(async () => new Response(blocks.map(([type, data]) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {headers: {"Content-Type": "text/event-stream"}}))
  vi.stubGlobal("fetch", fetcher)
  const received = vi.fn()
  await promptAgentSession("synthetic", {request_id: "qa", message: "你好"}, {onEvent: received})
  expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({"X-Agent-Answer-Streaming": "v1"})
  expect(received.mock.calls.map(([event]) => event.type)).toEqual(["accepted", "answer_delta", "answer_reset", "snapshot", "run_terminal"])
  received.mockClear()
  await observeAgentSession("synthetic", {onEvent: received})
  expect((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("X-Agent-Answer-Streaming")
});
