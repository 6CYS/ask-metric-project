import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import BackendNextChatPanel from "../../../src/components/chat/BackendNextChatPanel.vue"
import type { AgentSessionDetail, AgentStreamEvent, AnswerReceipt, PendingQuestion, QuestionState } from "@/lib/agentApi"
import * as agentApi from "@/lib/agentApi"

vi.mock("@/components/chat/CatalogQuestionComposer.vue", () => ({ default: { render: () => null } }))
const authState = vi.hoisted(() => ({user: undefined as unknown as {value: {id: string; role_code: string; org_name: string} | null}}))
vi.mock("@/composables/useAuth", async () => {
  const { ref } = await import("vue")
  authState.user = ref({id: "synthetic-user", role_code: "USER", org_name: "合成机构"})
  return {useAuth: () => ({user: authState.user})}
})
vi.mock("@/composables/useQueryReadiness", async () => {
  const { computed, ref } = await import("vue")
  return {useQueryReadiness: () => ({state: ref({status: "ready", message: "", completed: 0, total: 0}), ready: computed(() => true)})}
})

const notice = "本轮模型响应未完成；已取得的步骤结果仍可查看，请重试未完成部分。"
const detail: AgentSessionDetail = {
  session_id: "offline-test", created_at: "", running: false, operation_id: null,
  messages: [
    { role: "user", text: "查询测试指标", timestamp: 1 },
    { role: "assistant", business_protocol: "frame_v1", text: notice, error: notice, timestamp: 2 },
  ],
}
type TimeVariant = { label: string; start: string; end: string }
type Message = { id: string; role: string; content: string; status?: string; failureNotice?: string; nativeAnswer?: boolean; kind?: string
  response?: { time_variants?: TimeVariant[]; debug?: Record<string, unknown> | null }
  pendingQuestions?: PendingQuestion[]; answerReceipts?: AnswerReceipt[]; queryResults?: Array<Record<string, unknown>> }
type Conversation = { id: string; serverId: string | null; messages: Message[]; running: boolean
  loaded?: boolean; persisted?: boolean; legacy?: boolean; title?: string; preview?: string; questionStates?: QuestionState[] }
type PanelState = {
  activeConversationId: string
  activeConversationStorageKey: string
  message: string
  synchronizeAuthenticatedUser(userId: string | null): Promise<void>
  activateAuthenticatedUser(): Promise<void>
  handleNewConversation(): void
  loadHistory(expectedUserId: string): Promise<void>
  selectConversation(conversationId: string): Promise<void>
  conversations: Conversation[]
  conversationFromDetail(detail: AgentSessionDetail): { messages: Message[] }
  handleStreamEvent(conversationId: string, assistantId: string, event: AgentStreamEvent): void
  failMessage(conversationId: string, assistantId: string, error: unknown): void
  chooseTimeVariant(message: Message, variant: TimeVariant): void
  handleSubmit(text: string): void
}
let state: PanelState
let stored: Map<string, string>
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})

async function renderPanel() {
  let panel!: PanelState
  const app = createSSRApp(BackendNextChatPanel)
  app.mixin({ created() {
    if (this.$options.__name === "BackendNextChatPanel") {
      panel = (this.$ as unknown as { setupState: PanelState }).setupState
    }
  } })
  await renderToString(app)
  return panel
}

beforeEach(async () => {
  authState.user.value = {id: "synthetic-user", role_code: "USER", org_name: "合成机构"}
  stored = new Map()
  vi.stubGlobal("localStorage", {getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key)})
  state = await renderPanel()
  state.conversations = [{ id: "c", serverId: "offline-test", messages: [{ id: "a", role: "assistant", content: "", status: "pending", nativeAnswer: true }], running: true }]
})

describe("已登录会话初始化与刷新恢复", () => {
  const savedDetail = (id: string): AgentSessionDetail => ({...detail, session_id: id,
    messages: [{role: "user", text: "已有问题", timestamp: 1}, {role: "assistant", business_protocol: "frame_v1", text: `已保存结果:${id}`, timestamp: 2}]})
  const listed = (id: string) => ({items: [{session_id: id, created_at: "", last_active_at: "", running: false}]})
  it("实际初始化处理链及新组件刷新都恢复保存焦点与正文，零新建或提问", async () => {
    stored.set(state.activeConversationStorageKey, "saved-session")
    const list = vi.spyOn(agentApi, "listAgentSessions").mockResolvedValue(listed("saved-session"))
    const get = vi.spyOn(agentApi, "getAgentSession").mockResolvedValue(savedDetail("saved-session"))
    const create = vi.spyOn(agentApi, "createAgentSession"), prompt = vi.spyOn(agentApi, "promptAgentSession")
    await state.synchronizeAuthenticatedUser("synthetic-user")
    expect(state.activeConversationId).toBe("saved-session")
    expect(state.conversations.find(item => item.id === "saved-session")?.messages[1]?.content).toBe("已保存结果:saved-session")
    expect(stored.get(state.activeConversationStorageKey)).toBe("saved-session")
    const refreshed = await renderPanel()
    await refreshed.synchronizeAuthenticatedUser("synthetic-user")
    expect(refreshed.activeConversationId).toBe("saved-session")
    expect(refreshed.conversations.find(item => item.id === "saved-session")?.messages[1]?.content).toBe("已保存结果:saved-session")
    expect(list).toHaveBeenCalledTimes(2); expect(get).toHaveBeenCalledTimes(2)
    expect(create).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
  })
  it("同账号再次激活保留保存焦点并恢复原会话", async () => {
    stored.set(state.activeConversationStorageKey, "saved-session")
    vi.spyOn(agentApi, "listAgentSessions").mockResolvedValue(listed("saved-session"))
    const get = vi.spyOn(agentApi, "getAgentSession").mockResolvedValue(savedDetail("saved-session"))
    await state.activateAuthenticatedUser()
    await state.activateAuthenticatedUser()
    expect(state.activeConversationId).toBe("saved-session")
    expect(stored.get(state.activeConversationStorageKey)).toBe("saved-session")
    expect(state.conversations.find(item => item.id === "saved-session")?.messages[1]?.content).toBe("已保存结果:saved-session")
    expect(get).toHaveBeenCalledTimes(1)
  })
  it("同账号再次激活保留用户主动新建的草稿及未发送输入", async () => {
    stored.set(state.activeConversationStorageKey, "saved-session")
    vi.spyOn(agentApi, "listAgentSessions").mockResolvedValue(listed("saved-session"))
    vi.spyOn(agentApi, "getAgentSession").mockResolvedValue(savedDetail("saved-session"))
    const create = vi.spyOn(agentApi, "createAgentSession"), prompt = vi.spyOn(agentApi, "promptAgentSession")
    await state.activateAuthenticatedUser()
    state.handleNewConversation(); const draft = state.activeConversationId
    state.message = "用户尚未发送的补充条件"
    await state.activateAuthenticatedUser()
    expect(state.activeConversationId).toBe(draft)
    expect(state.message).toBe("用户尚未发送的补充条件")
    expect(state.conversations.find(item => item.id === draft)?.messages).toEqual([])
    expect(stored.has(state.activeConversationStorageKey)).toBe(false)
    expect(create).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
  })
  it("初始化历史列表迟到时，用户主动新建仍立即撤销旧保存焦点", async () => {
    stored.set(state.activeConversationStorageKey, "saved-session")
    let release!: (value: Awaited<ReturnType<typeof agentApi.listAgentSessions>>) => void
    vi.spyOn(agentApi, "listAgentSessions").mockImplementation(() => new Promise(resolve => {release = resolve}))
    const get = vi.spyOn(agentApi, "getAgentSession")
    const pending = state.synchronizeAuthenticatedUser("synthetic-user")
    state.handleNewConversation()
    const draft = state.activeConversationId
    expect(stored.has(state.activeConversationStorageKey)).toBe(false)
    release(listed("saved-session")); await pending
    expect(state.activeConversationId).toBe(draft)
    expect(get).not.toHaveBeenCalled()
  })
  it.each(["success", "missing"] as const)("初始化详情迟到%s时，用户主动新建保持空草稿且不恢复旧保存焦点", async outcome => {
    stored.set(state.activeConversationStorageKey, "saved-session")
    vi.spyOn(agentApi, "listAgentSessions").mockResolvedValue(listed("saved-session"))
    let release!: (value: AgentSessionDetail) => void, reject!: (error: Error) => void, started!: () => void
    const detailsStarted = new Promise<void>(resolve => {started = resolve})
    vi.spyOn(agentApi, "getAgentSession").mockImplementation(() => new Promise((resolve, fail) => {release = resolve; reject = fail; started()}))
    const pending = state.synchronizeAuthenticatedUser("synthetic-user")
    await detailsStarted
    state.handleNewConversation(); const draft = state.activeConversationId
    if (outcome === "success") release(savedDetail("saved-session"))
    else reject(new agentApi.AgentSessionNotFoundError())
    await pending
    expect(state.activeConversationId).toBe(draft)
    expect(state.conversations.find(item => item.id === draft)?.messages).toEqual([])
    expect(stored.has(state.activeConversationStorageKey)).toBe(false)
  })
  it.each(["list", "detail"] as const)("账号切换后旧%s响应不能覆盖新账号恢复结果或保存指针", async delay => {
    const oldKey = state.activeConversationStorageKey
    stored.set(oldKey, "old-session")
    stored.set("ask-metric.agent.active-conversation:other-user", "other-session")
    let releaseList!: (value: Awaited<ReturnType<typeof agentApi.listAgentSessions>>) => void
    let releaseDetail!: (value: AgentSessionDetail) => void, started!: () => void
    const delayedStarted = new Promise<void>(resolve => {started = resolve})
    vi.spyOn(agentApi, "listAgentSessions").mockImplementation(async () => {
      if (authState.user.value?.id !== "synthetic-user") return listed("other-session")
      if (delay === "detail") return listed("old-session")
      return new Promise(resolve => {releaseList = resolve; started()})
    })
    vi.spyOn(agentApi, "getAgentSession").mockImplementation(async id => {
      if (id !== "old-session") return savedDetail(id)
      return new Promise(resolve => {releaseDetail = resolve; started()})
    })
    const oldPending = state.synchronizeAuthenticatedUser("synthetic-user")
    await delayedStarted
    authState.user.value = {id: "other-user", role_code: "USER", org_name: "合成另一机构"}
    await state.synchronizeAuthenticatedUser("other-user")
    if (delay === "list") releaseList(listed("old-session"))
    else releaseDetail(savedDetail("old-session"))
    await oldPending
    expect(state.activeConversationId).toBe("other-session")
    expect(state.conversations.find(item => item.id === "other-session")?.messages[1]?.content).toBe("已保存结果:other-session")
    expect(state.conversations.some(item => item.id === "old-session")).toBe(false)
    expect(stored.get(oldKey)).toBe("old-session")
    expect(stored.get(state.activeConversationStorageKey)).toBe("other-session")
  })
})

describe("断网失败消息的实际页面处理链", () => {
  it("历史列表迟到不能把用户刚新建的空草稿切回旧会话", async()=>{
    const stored = new Map<string,string>([[state.activeConversationStorageKey,"old-session"]])
    vi.stubGlobal("localStorage",{getItem:(k:string)=>stored.get(k)??null,setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)})
    let release!: (value:Awaited<ReturnType<typeof agentApi.listAgentSessions>>)=>void
    vi.spyOn(agentApi,"listAgentSessions").mockImplementation(()=>new Promise(resolve=>{release=resolve}))
    const getSession=vi.spyOn(agentApi,"getAgentSession")
    const pending=state.loadHistory("synthetic-user")
    state.handleNewConversation()
    const draft=state.activeConversationId
    release({items:[{session_id:"old-session",created_at:"",last_active_at:"",running:false}]})
    await pending
    expect(state.activeConversationId).toBe(draft)
    expect(getSession).not.toHaveBeenCalled()
  })
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

  it("同一轮重试成功后刷新历史清除旧失败状态", () => {
    const recovered: AgentSessionDetail = { ...detail, messages: [...detail.messages,
      { role: "assistant", business_protocol: "frame_v1", text: "重试后查询完成", timestamp: 3 },
    ] }
    const messages = state.conversationFromDetail(recovered).messages
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ content: "重试后查询完成", status: "done" })
    expect(messages[1]?.failureNotice).toBeUndefined()
  })
})

describe("复合任务结果展示", () => {
  const results = [1, 2].map(index => ({kind: "metric_query_structured", status: "succeeded", task_id: `task-${index}`, result_id: `result-${index}`,
    row_count: 1, columns: ["metric_value"], rows: [{metric_value: String(index)}], public_answer: `目标${index}完成`}))
  it("实时批次与刷新快照都保留两个正式结果", () => {
    const bundle = {kind: "semantic_results", status: "succeeded", results}
    state.handleStreamEvent("c", "a", {type: "tool_end", tool: "resolve_business_turn", tool_call_id: "multi", details: bundle, isError: false})
    const live = state.conversations[0]!.messages[0] as Message & {taskIds?: string[]; queryResults?: unknown[]}
    expect(live.taskIds).toEqual(["task-1", "task-2"])
    expect(live.queryResults).toHaveLength(2)
    const restored = state.conversationFromDetail({...detail, messages: [detail.messages[0]!, {role: "assistant", business_protocol: "frame_v1", text: "两项目标完成", timestamp: 2},
      {role: "tool", tool: "resolve_business_turn", tool_call_id: "multi", details: bundle, is_error: false, timestamp: 3}]}).messages[1] as Message & {taskIds?: string[]; queryResults?: unknown[]}
    expect(restored.taskIds).toEqual(["task-1", "task-2"])
    expect(restored.queryResults).toHaveLength(2)
  })
})


it("新增复合结果展示后，单目标正式正文仍只渲染一次", async () => {
  const app = createSSRApp(BackendNextChatPanel)
  app.mixin({ created() {
    if (this.$options.__name !== "BackendNextChatPanel") return
    const panel = (this.$ as unknown as {setupState: PanelState}).setupState
    panel.conversations = [{id: "single", serverId: "offline-test", messages: [{id: "answer", role: "assistant", content: "", status: "pending"}], running: false}]
    panel.handleStreamEvent("single", "answer", {type: "tool_end", tool: "resolve_business_turn", tool_call_id: "single-result", isError: false,
      details: {kind: "metric_query_structured", status: "succeeded", task_id: "single-task", result_id: "single-result", row_count: 0, columns: [], rows: [], public_answer: "单目标唯一正文标记"}})
    panel.conversations[0]!.messages[0]!.status = "done"
  } })
  const html = await renderToString(app)
  expect(html.split("单目标唯一正文标记")).toHaveLength(2)
})

describe("备选时间口径", () => {
  const variants: TimeVariant[] = [{ label: "最近3个完整年度", start: "2023-01-01", end: "2025-12-31" }]
  const metricAskToolMessage = { role: "tool" as const, tool: "metric_ask", tool_call_id: "m-variant", is_error: false, timestamp: 3,
    details: { kind: "metric_ask", status: "succeeded", task_id: "t-variant", row_count: 1, columns: ["metric_value"], rows: [{ metric_value: "1" }], time_variants: variants } }

  it("历史工具明细与实时回执都把 time_variants 写入结构化响应", () => {
    const restored = state.conversationFromDetail({ ...detail, messages: [
      detail.messages[0]!,
      { role: "assistant", business_protocol: "frame_v1", text: "查询完成", timestamp: 2 },
      metricAskToolMessage,
    ] }).messages[1]
    expect(restored?.response?.time_variants).toEqual(variants)

    state.handleStreamEvent("c", "a", { type: "tool_end", tool: "metric_ask", tool_call_id: "m-variant", isError: false, details: metricAskToolMessage.details })
    expect(state.conversations[0]!.messages[0]!.response?.time_variants).toEqual(variants)
  })

  it("点选口径携带 time_override 重查，原消息 chips 归档为只读", async () => {
    state.conversations = [{ id: "c", serverId: "offline-test", running: false, messages: [
      { id: "m-time", role: "assistant", content: "查询完成", status: "done",
        response: { time_variants: variants, debug: { task_id: "t-variant", row_count: 0 } } },
    ] }]
    let captured: { message?: string; time_override?: { start: string; end: string } } | undefined
    vi.spyOn(agentApi, "promptAgentSession").mockImplementation(async (_sessionId, input, options) => {
      captured = input
      options.onEvent({ type: "run_terminal", run_status: "ok", answer_status: "ok" })
    })
    state.chooseTimeVariant(state.conversations[0]!.messages[0]!, variants[0]!)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(captured?.message).toBe("切换口径：最近3个完整年度")
    expect(captured?.time_override).toEqual({ start: "2023-01-01", end: "2025-12-31" })
    const messages = state.conversations[0]!.messages
    expect(messages[0]!.response?.time_variants).toBeUndefined()
    expect(messages[1]).toMatchObject({ role: "user", content: "切换口径：最近3个完整年度", kind: "time_override" })
    expect(messages[2]).toMatchObject({ role: "assistant", status: "done" })
  })

  it("快照整体重建后保留已归档口径的只读状态", () => {
    state.conversations = [{ id: "c", serverId: "offline-test", running: false, messages: [
      { id: "m-time", role: "assistant", content: "查询完成", status: "done",
        response: { debug: { task_id: "t-variant", row_count: 0 } } },
    ] }]
    state.handleStreamEvent("c", "m-time", { type: "snapshot", operation_id: null, running: false,
      messages: [detail.messages[0]!, { role: "assistant", business_protocol: "frame_v1", text: "查询完成", timestamp: 2 }, metricAskToolMessage] })
    const restored = state.conversations[0]!.messages[1]
    expect(restored?.response?.debug?.task_id).toBe("t-variant")
    expect(restored?.response?.time_variants).toBeUndefined()
  })
})

describe("PendingQuestion/Answer 消费链", () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  function question(id = "q-org", version = 1): PendingQuestion {
    return {
      question_id: id, version,
      scope: { task_ref: "task-1", target_ref: "target-1", field: "organizations", item_ref: "item-1" },
      prompt: "请选择机构", selection_mode: "multiple", status: "open", issued_operation_id: "op-issue", kind: "choice",
      options: [
        { option_id: "o1", no: 1, label: "机构一", description: "上级机构一" },
        { option_id: "o2", no: 2, label: "机构二", description: "上级机构二" },
      ],
    }
  }
  function receipt(id = "q-org", version = 1, outcome: AnswerReceipt["outcome"] = "applied", notice = "已按第 1 项「机构一」确认。", code?: string): AnswerReceipt {
    return { question_id: id, version, outcome, notice, ...(code ? { code } : {}) }
  }
  function feedback(questions: PendingQuestion[], receipts: AnswerReceipt[]) {
    return { protocol_version: 2, status: "needs_user", pending_questions: questions, answer_receipts: receipts }
  }
  function detailWithFeedback(details: unknown): AgentSessionDetail {
    return { ...detail, messages: [
      { role: "user", text: "查询机构指标", timestamp: 1 },
      { role: "assistant", business_protocol: "frame_v1", text: "请选择", timestamp: 2 },
      { role: "tool", tool: "resolve_business_turn", tool_call_id: "question-tool", details, is_error: false, timestamp: 3 },
    ] }
  }
  function usePublishedQuestion(published: PendingQuestion, states: QuestionState[] = [{ question_id: published.question_id, version: published.version, status: "open" }]) {
    state.activeConversationId = "c"
    state.conversations = [{ id: "c", serverId: "offline-test", running: false, loaded: true, persisted: true,
      title: "问数", preview: "请选择", questionStates: states,
      messages: [{ id: "published", role: "assistant", content: "请选择", status: "done", pendingQuestions: [published] }] }]
  }

  it.each(["direct", "semantic_task"] as const)("实时和历史都读取 %s 中的题目与正式回执", shape => {
    const published = question()
    const accepted = receipt()
    const semantic = feedback([published], [accepted])
    const details = shape === "direct" ? semantic
      : { kind: "metric_query_structured", status: "needs_user", task_id: "task-q", semantic_task: semantic }
    state.handleStreamEvent("c", "a", { type: "tool_end", tool: "resolve_business_turn", tool_call_id: "q", details, isError: false })
    expect(state.conversations[0]!.messages[0]).toMatchObject({ pendingQuestions: [published], answerReceipts: [accepted] })

    const restored = state.conversationFromDetail(detailWithFeedback(details)).messages[1]
    expect(restored).toMatchObject({ pendingQuestions: [published], answerReceipts: [accepted] })
  })

  it("semantic_results 展开保留批次字段和完整原始反馈", () => {
    const published = question()
    const semantic = { ...feedback([published], []), nested_marker: "完整反馈不得丢失" }
    const bundle = { kind: "semantic_results", status: "succeeded", batch_marker: "批次字段不得丢失", semantic_task: semantic,
      results: [{ kind: "metric_query_structured", status: "succeeded", task_id: "task-full", result_id: "result-full",
        row_count: 0, columns: [], rows: [] }] }
    state.handleStreamEvent("c", "a", { type: "tool_end", tool: "resolve_business_turn", tool_call_id: "full", details: bundle, isError: false })
    const live = state.conversations[0]!.messages[0]!
    expect(live.pendingQuestions).toEqual([published])
    expect(live.queryResults?.[0]).toMatchObject({ batch_marker: "批次字段不得丢失", semantic_task: { nested_marker: "完整反馈不得丢失" } })

    const restored = state.conversationFromDetail(detailWithFeedback(bundle)).messages[1]
    expect(restored?.pendingQuestions).toEqual([published])
    expect(restored?.queryResults?.[0]).toMatchObject({ batch_marker: "批次字段不得丢失", semantic_task: { nested_marker: "完整反馈不得丢失" } })
  })

  it("GET 详情恢复历史题目快照和会话级当前状态", async () => {
    const published = question()
    const current = { question_id: published.question_id, version: published.version, status: "answered" as const }
    vi.spyOn(agentApi, "getAgentSession").mockResolvedValue({ ...detailWithFeedback(feedback([published], [])),
      session_id: "offline-test", question_states: [current] })
    state.activeConversationId = "c"
    state.conversations = [{ id: "c", serverId: "offline-test", running: false, loaded: false, persisted: true,
      title: "问数", preview: "", messages: [], questionStates: [] }]
    await state.selectConversation("c")
    expect(state.conversations[0]?.questionStates).toEqual([current])
    expect(state.conversations[0]?.messages[1]?.pendingQuestions).toEqual([published])
    expect(state.conversations[0]?.messages[1]?.pendingQuestions?.[0]?.status).toBe("open")
  })

  it("accepted 和 snapshot 都刷新当前 question_states", () => {
    const published = question()
    const messages = detailWithFeedback(feedback([published], [])).messages
    state.conversations[0]!.loaded = true
    state.handleStreamEvent("c", "a", { type: "accepted", operation_id: "op-current", snapshot: {
      messages, running: false, operation_id: null,
      question_states: [{ question_id: published.question_id, version: published.version, status: "open" }],
    } })
    expect(state.conversations[0]?.questionStates).toEqual([{ question_id: published.question_id, version: published.version, status: "open" }])
    state.handleStreamEvent("c", "a", { type: "snapshot", messages, running: false, operation_id: null,
      question_states: [{ question_id: published.question_id, version: published.version, status: "answered" }] })
    expect(state.conversations[0]?.questionStates).toEqual([{ question_id: published.question_id, version: published.version, status: "answered" }])
  })

  it("澄清待答时输入框文字按普通 question 发送，不携带任何卡片提交字段", async () => {
    const published = question()
    usePublishedQuestion(published)
    let captured: Parameters<typeof agentApi.promptAgentSession>[1] | undefined
    vi.spyOn(agentApi, "promptAgentSession").mockImplementation(async (_sessionId, input, options) => {
      captured = input
      options.onEvent({ type: "run_terminal", run_status: "completed", answer_status: "ok" })
    })
    state.message = "第 2 项"
    state.handleSubmit("第 2 项")
    await flush()
    expect(captured).toMatchObject({ message: "第 2 项" })
    expect(captured).not.toHaveProperty("answers")
    expect(captured).not.toHaveProperty("clarification_selection")
    expect(captured).not.toHaveProperty("selected_answers")
    expect(captured).not.toHaveProperty("clarification_target")
    expect(captured).not.toHaveProperty("time_override")
    expect(state.conversations[0]?.messages.find(item => item.role === "user")).toMatchObject({ content: "第 2 项", kind: "question" })
    expect(state.message).toBe("")
  })

  it("QUESTION_SUPERSEDED 保留最新题，already_applied 显示原受理 notice", () => {
    const latest = question("q-org", 2)
    const other = question("q-other", 1)
    const superseded = receipt("q-org", 1, "not_applied", "问题已更新，请回答最新问题。", "QUESTION_SUPERSEDED")
    const repeated = receipt("q-other", 1, "already_applied", "该选择此前已应用，本次未重复执行。")
    state.handleStreamEvent("c", "a", { type: "tool_end", tool: "resolve_business_turn", tool_call_id: "receipts", isError: false,
      details: { semantic_task: feedback([latest, other], [superseded, repeated]) } })
    const current = state.conversations[0]!.messages[0]!
    expect(current.pendingQuestions).toEqual([latest, other])
    expect(current.answerReceipts?.map(item => item.notice)).toEqual([superseded.notice, repeated.notice])
    expect(state.conversations[0]?.questionStates).toEqual(expect.arrayContaining([
      { question_id: "q-org", version: 1, status: "superseded" },
      { question_id: "q-org", version: 2, status: "open" },
      { question_id: "q-other", version: 1, status: "answered" },
    ]))
  })
})
