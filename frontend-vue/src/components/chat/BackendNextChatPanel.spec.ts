import { beforeEach, describe, expect, it, vi } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import BackendNextChatPanel from "./BackendNextChatPanel.vue"
import type { AgentSessionDetail, AgentStreamEvent } from "@/lib/agentApi"

vi.mock("@/components/chat/CatalogQuestionComposer.vue", () => ({ default: { render: () => null } }))

const notice = "本轮模型响应未完成；已取得的步骤结果仍可查看，请重试未完成部分。"
const detail: AgentSessionDetail = {
  session_id: "offline-test", created_at: "", running: false, operation_id: null,
  messages: [
    { role: "user", text: "查询测试指标", timestamp: 1 },
    { role: "assistant", business_protocol: "frame_v1", text: notice, error: notice, timestamp: 2 },
  ],
}
type Message = { id: string; role: string; content: string; status?: string; failureNotice?: string; nativeAnswer?: boolean }
type PanelState = {
  conversations: Array<{ id: string; serverId: string; messages: Message[]; running: boolean }>
  conversationFromDetail(detail: AgentSessionDetail): { messages: Message[] }
  handleStreamEvent(conversationId: string, assistantId: string, event: AgentStreamEvent): void
  failMessage(conversationId: string, assistantId: string, error: unknown): void
}
let state: PanelState

beforeEach(async () => {
  const app = createSSRApp(BackendNextChatPanel)
  app.mixin({ created() {
    if (this.$options.__name === "BackendNextChatPanel") {
      state = (this.$ as unknown as { setupState: PanelState }).setupState
    }
  } })
  await renderToString(app)
  state.conversations = [{ id: "c", serverId: "offline-test", messages: [{ id: "a", role: "assistant", content: "", status: "pending", nativeAnswer: true }], running: true }]
})

describe("断网失败消息的实际页面处理链", () => {
  it("刷新读取历史只产生一个失败提示", () => {
    const messages = state.conversationFromDetail(detail).messages
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ content: notice, status: "error" })
  })

  it("失败快照、重复终态及重连快照不会叠加提示", () => {
    const terminal: AgentStreamEvent = { type: "run_terminal", run_status: "failed", answer_status: "failed", error_code: "assistant_error" }
    const snapshot: AgentStreamEvent = { type: "snapshot", ...detail }
    state.handleStreamEvent("c", "a", snapshot)
    state.handleStreamEvent("c", "a", terminal)
    state.handleStreamEvent("c", "a", terminal)
    state.failMessage("c", "a", new Error("Failed to fetch"))
    expect(state.conversations[0]?.messages[1]).toMatchObject({ content: notice, status: "error" })
    state.handleStreamEvent("c", "a", snapshot)
    state.handleStreamEvent("c", "a", terminal)
    expect(state.conversations[0]?.messages[1]?.content).toBe(notice)
    // 重新观察已结束的 operation 时，服务端会发 idle，不能覆盖快照中的失败状态。
    state.handleStreamEvent("c", "a", { type: "run_terminal", run_status: "idle", answer_status: "idle" })
    expect(state.conversations[0]?.messages[1]).toMatchObject({ content: notice, status: "error" })
  })

  it("没有快照时，请求中断的重复处理也只提示一次", () => {
    state.failMessage("c", "a", new Error("Failed to fetch"))
    state.failMessage("c", "a", new Error("Failed to fetch"))
    expect(state.conversations[0]?.messages[0]?.content).toBe("暂时无法连接问数服务。请检查网络连接，稍后重新查询。")
  })

  it("没有失败快照时，重复终态仍保留部分正文且只追加一次说明", () => {
    state.conversations[0]!.messages[0]!.content = "已经取得的步骤说明"
    const terminal: AgentStreamEvent = { type: "run_terminal", run_status: "failed", answer_status: "failed", error_code: "MODEL_STREAM_FAILED" }
    state.handleStreamEvent("c", "a", terminal)
    state.handleStreamEvent("c", "a", terminal)
    expect(state.conversations[0]?.messages[0]?.content).toBe("已经取得的步骤说明\n模型响应流中断，本次查询未完成。请稍后重新查询。")
  })

  it("连续两轮都失败时，各自显示一次，不跨问题去重", () => {
    const repeated = { ...detail, messages: [...detail.messages, ...detail.messages] }
    const messages = state.conversationFromDetail(repeated).messages
    expect(messages).toHaveLength(4)
    expect(messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual([notice, notice])
  })

  it("正常回答保持原文", () => {
    const normal: AgentSessionDetail = { ...detail, messages: [detail.messages[0]!, { role: "assistant", business_protocol: "frame_v1", text: "测试正文\n测试正文", timestamp: 2 }] }
    expect(state.conversationFromDetail(normal).messages[1]).toMatchObject({ content: "测试正文\n测试正文", status: "done" })
  })
})
