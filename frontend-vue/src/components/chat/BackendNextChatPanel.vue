<script setup lang="ts">
import { AlertTriangle, Bot, Check, Copy, Ellipsis, LoaderCircle, MessageCircleQuestion, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Trash2 } from "@lucide/vue"
import { computed, nextTick, onActivated, onMounted, ref, watch } from "vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"

import CatalogQuestionComposer from "@/components/chat/CatalogQuestionComposer.vue"
import ChatResultContent from "@/components/chat/ChatResultContent.vue"
import StructuredClarificationForm from "@/components/chat/StructuredClarificationForm.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import {
  AgentApiError,
  AgentSessionNotFoundError,
  createAgentSession,
  deleteAgentSession,
  getAgentSession,
  isAgentAbortError,
  listAgentSessions,
  promptAgentSession,
  type AgentSessionDetail,
  type AgentStreamEvent,
  type MetricAskDetails,
} from "@/lib/agentApi"
import type { BackendNextClarification, ChatResponse } from "@/types/api"
import { useAuth } from "@/composables/useAuth"
import { useQueryReadiness } from "@/composables/useQueryReadiness"
import { copyText } from "@/lib/clipboard"
import { archiveClarificationResponse } from "@/lib/conversationMessages"
import { composeQuestion, type ComposerEntity } from "@/lib/composerEntities"
import { friendlyQueryError } from "@/lib/queryErrors"

/**
 * 指标问数面板：问答数据链路走 agent-service（pi harness）的 SSE 事件流，
 * 模型经受治理接口取数；页面骨架、样式与交互约定保持与既有问数页一致。
 * 会话由 agent-service 持久化（重启可恢复），历史消息含工具明细，可还原结果表与澄清卡片。
 */
type ToolCallDisplay = {
  id: string
  tool: string
  status: "running" | "done" | "error"
}

type DisplayMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  response?: ChatResponse
  status?: "pending" | "done" | "error"
  toolCalls?: ToolCallDisplay[]
  clarification?: BackendNextClarification
  createdAt?: string
  kind?: string
  /** 本轮最近一次 metric_ask 的工具明细，done/error 收尾时用于构造结构化响应。 */
  metricAskDetails?: MetricAskDetails
  metricAskClarification?: BackendNextClarification
  metricAskClarificationPrompt?: string
}

type DisplayConversation = {
  /** 前端稳定标识；草稿会话在首次发送后才获得服务端会话 ID。 */
  id: string
  serverId: string | null
  title: string
  preview: string
  messages: DisplayMessage[]
  loaded: boolean
  persisted: boolean
  running: boolean
  createdAt?: string | null
  lastActiveAt?: string | null
}

const toolLabels: Record<string, string> = {
  metric_ask: "指标问数",
  metric_catalog_search: "指标目录检索",
  org_catalog_search: "机构目录检索",
}

const props = withDefaults(defineProps<{ initialMessage?: string }>(), { initialMessage: "" })
const auth = useAuth()
const { state: queryReadiness, ready: queryReady } = useQueryReadiness()
const activeConversationStorageKey = computed(() => `ask-metric.agent.active-conversation:${auth.user.value?.id ?? "anonymous"}`)
const titleStorageKey = computed(() => `ask-metric.agent.session-titles:${auth.user.value?.id ?? "anonymous"}`)
const exampleQuestions = computed(() => {
  const currentUser = auth.user.value
  if (!currentUser || currentUser.role_code === "SYSTEM_ADMIN") {
    return [
      "紫金农商行2026年3月末个人活期存款余额当日数是多少？",
      "查询2026年4月末各家农商行信贷客户数量当日数前3名。",
      "2026年4月末各家农商行个人活期存款余额当日数分别是多少？",
    ]
  }
  const organization = currentUser.org_name
  return [
    `${organization}2026年3月末个人活期存款余额当日数是多少？`,
    `查询${organization}2026年4月末信贷客户数量当日数是多少？`,
    `${organization}2026年4月末个人活期存款余额当日数是多少？`,
  ]
})
const message = ref(props.initialMessage.trim())
const conversations = ref<DisplayConversation[]>([])
const activeConversationId = ref("")
const autoOpenClarificationId = ref<string>()
watch(activeConversationId, () => { autoOpenClarificationId.value = undefined }, { flush: "sync" })
const sendingConversationIds = ref(new Set<string>())
const abortControllers = new Map<string, AbortController>()
const isHistoryLoading = ref(true)
const isConversationLoading = ref(false)
const isHistoryLoadingMore = ref(false)
const historyError = ref("")
const messagesScroll = ref<HTMLElement | null>(null)
const copiedMessageId = ref("")
const HISTORY_PAGE_SIZE = 12
const historyVisibleCount = ref(HISTORY_PAGE_SIZE)
const renameTargetId = ref("")
const renameDraft = ref("")
const isRenaming = ref(false)
const hasActivatedOnce = ref(false)
const deletingConversation = ref<DisplayConversation | null>(null)
const isDeletingConversation = ref(false)
const isHistoryCollapsed = ref(false)
const loadedUserId = ref<string | null>(null)
/** agent 会话无改名接口，标题覆盖记录保存在本地（不含任何凭据）。 */
const titleOverrides = ref<Record<string, string>>({})
let historyLoadVersion = 0

function formatMessageTime(value?: string) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date).replace(/年|月/g, "/").replace("日", "")
}

const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value) ?? conversations.value[0])
const activeConversationIsSending = computed(() => Boolean(activeConversation.value && sendingConversationIds.value.has(activeConversation.value.id)))
const activeClarificationMessage = computed(() => {
  const latestFirst = [...(activeConversation.value?.messages ?? [])].reverse()
  return latestFirst.find((item) => item.role === "assistant" && item.status === "done" && Boolean(item.clarification))
})
const composerPlaceholder = computed(() => {
  const clarification = activeClarificationMessage.value?.clarification
  if (!clarification) return "请输入本次查询的日期、机构和指标"
  if (clarification.fields?.length && clarification.fields.every((field) => field.type === "date_range")) {
    return "补充查询日期，例如：2026年7月末"
  }
  return "选择候选项或直接补充查询条件"
})
const sortedConversations = computed(() => conversations.value
  .filter((item) => item.persisted || item.messages.length > 0)
  .sort((left, right) => {
    if (left.persisted !== right.persisted) return left.persisted ? 1 : -1
    const leftTime = new Date(left.lastActiveAt ?? left.createdAt ?? 0).getTime()
    const rightTime = new Date(right.lastActiveAt ?? right.createdAt ?? 0).getTime()
    return rightTime - leftTime
  }))
// 会话接口一次返回全量列表，沿用“显示更多”交互做前端分页。
const visibleConversations = computed(() => sortedConversations.value.slice(0, historyVisibleCount.value))
const hasMoreConversations = computed(() => sortedConversations.value.length > historyVisibleCount.value)

watch(() => props.initialMessage, (value) => {
  if (!message.value.trim()) message.value = value.trim()
})

watch(() => auth.user.value?.id ?? null, (userId) => {
  void synchronizeAuthenticatedUser(userId)
})

onMounted(() => void synchronizeAuthenticatedUser(auth.user.value?.id ?? null))

onActivated(() => {
  const userId = auth.user.value?.id ?? null
  if (loadedUserId.value !== userId) void synchronizeAuthenticatedUser(userId)
  else if (hasActivatedOnce.value && userId) {
    handleNewConversation()
    void loadHistory(userId)
  }
  hasActivatedOnce.value = true
})

function resetChatSessionState() {
  historyLoadVersion += 1
  conversations.value = []
  activeConversationId.value = ""
  sendingConversationIds.value = new Set()
  abortControllers.clear()
  isHistoryLoading.value = false
  isConversationLoading.value = false
  isHistoryLoadingMore.value = false
  historyError.value = ""
  historyVisibleCount.value = HISTORY_PAGE_SIZE
  titleOverrides.value = loadTitleOverrides()
  message.value = props.initialMessage.trim()
}

async function synchronizeAuthenticatedUser(userId: string | null) {
  if (loadedUserId.value === userId) return
  loadedUserId.value = userId
  resetChatSessionState()
  if (!userId) return
  handleNewConversation()
  await loadHistory(userId)
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function toolLabel(tool: string) {
  return toolLabels[tool] ?? tool
}

function executionStatus(chatMessage: DisplayMessage) {
  if (chatMessage.status === "error") {
    return {
      kind: "failed",
      title: "问数执行失败",
      titleClass: "text-muted-foreground",
    }
  }
  if (chatMessage.clarification && chatMessage.status === "done") {
    return {
      kind: "waiting",
      title: "待补充条件",
      titleClass: "text-muted-foreground",
    }
  }
  if (chatMessage.status === "done") {
    return { kind: "success", title: "", titleClass: "" }
  }
  const runningTool = chatMessage.toolCalls?.find((call) => call.status === "running")
  return {
    kind: "running",
    title: runningTool ? `正在查询：${toolLabel(runningTool.tool)}` : "正在思考，请稍候",
    titleClass: "",
  }
}

function createConversation(id = createId()): DisplayConversation {
  return { id, serverId: null, title: "新的问数会话", preview: "尚未开始", messages: [], loaded: true, persisted: false, running: false, createdAt: null, lastActiveAt: null }
}

function formatConversationDate(value?: string | null) {
  if (!value) return "刚刚"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function persistActiveConversation() {
  const serverId = activeConversation.value?.serverId
  if (serverId) localStorage.setItem(activeConversationStorageKey.value, serverId)
  else localStorage.removeItem(activeConversationStorageKey.value)
}

function loadTitleOverrides() {
  try {
    const raw = localStorage.getItem(titleStorageKey.value)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

function persistTitleOverrides() {
  localStorage.setItem(titleStorageKey.value, JSON.stringify(titleOverrides.value))
}

function conversationTitle(serverId: string | null, messages: DisplayMessage[]) {
  const override = serverId ? titleOverrides.value[serverId] : undefined
  if (override) return override
  const firstQuestion = messages.find((item) => item.role === "user" && item.kind !== "clarification_answer")?.content.trim()
  return firstQuestion ? firstQuestion.slice(0, 24) : "问数会话"
}

/** 由 metric_ask 工具明细构造既有 ChatResponse 形状，复用 ChatResultContent 渲染。 */
function responseFromMetricAsk(details: MetricAskDetails, answer: string): ChatResponse {
  const rows = details.rows ?? []
  const columns = details.columns?.length ? details.columns : rows.length ? Object.keys(rows[0]!) : []
  const rowCount = details.row_count ?? rows.length
  return {
    message_id: details.task_id ?? createId(),
    intent: "metric_query",
    answer: answer.trim() || (rowCount ? `查询完成，找到 ${rowCount} 条记录。` : "查询完成，暂无匹配数据。"),
    result: rowCount <= 100 && columns.length ? { type: "metric_query", table: { columns, rows } } : null,
    metric_definition: null,
    clarification: null,
    debug: { task_id: details.task_id },
    download: rowCount > 100 && details.task_id
      ? { task_id: details.task_id, row_count: rowCount, format: "xlsx" }
      : undefined,
  }
}

function clarificationResponse(clarification: BackendNextClarification, prompt: string): ChatResponse {
  return {
    message_id: createId(),
    intent: "clarification",
    answer: prompt || clarification.prompt,
    result: null,
    metric_definition: null,
    clarification: {
      type: clarification.type,
      options: clarification.options ?? [],
      fields: clarification.fields,
      understood: clarification.understood,
      reply_examples: clarification.reply_examples,
    },
    debug: { clarification },
  }
}

/** done/error 收尾：按本轮收集到的工具明细生成最终结构化响应。 */
function finalizeAssistantMessage(chatMessage: DisplayMessage): DisplayMessage {
  const clarification = chatMessage.metricAskClarification
  if (clarification) {
    const response = clarificationResponse(clarification, chatMessage.metricAskClarificationPrompt ?? clarification.prompt)
    return { ...chatMessage, clarification, response, content: response.answer }
  }
  const details = chatMessage.metricAskDetails
  if (details && details.status === "succeeded") {
    return { ...chatMessage, response: responseFromMetricAsk(details, chatMessage.content) }
  }
  if (details && details.status === "unsupported" && !chatMessage.content.trim()) {
    return { ...chatMessage, content: "当前能力暂不支持该查询，请调整问题后重试。" }
  }
  return chatMessage
}

function asMetricAskDetails(value: unknown): MetricAskDetails | undefined {
  return value && typeof value === "object" && (value as { kind?: unknown }).kind === "metric_ask"
    ? value as MetricAskDetails
    : undefined
}

function historyTimestamp(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined
}

/** 还原历史消息：连续的助手片段合并为一个气泡，其后的工具明细还原结果表与只读澄清卡片。 */
function conversationFromDetail(detail: AgentSessionDetail): Pick<DisplayConversation, "messages"> {
  const messages: DisplayMessage[] = []
  for (const item of detail.messages) {
    if (item.role === "user") {
      const text = "text" in item ? item.text ?? "" : ""
      if (!text.trim()) continue
      messages.push({ id: createId(), role: "user", content: text, createdAt: historyTimestamp(item.timestamp) })
      continue
    }
    if (item.role === "assistant") {
      const text = "text" in item ? item.text ?? "" : ""
      const tools = "tools" in item ? item.tools ?? [] : []
      const last = messages[messages.length - 1]
      if (last?.role === "assistant") {
        // 跨轮次合并助手片段：两侧都有内容时补段落分隔，避免首尾粘连
        last.content = last.content.trim() && text.trim() ? `${last.content}\n\n${text}` : last.content + text
        last.toolCalls = [...(last.toolCalls ?? []), ...tools.map((tool) => ({ id: createId(), tool, status: "done" as const }))]
        if (!last.createdAt) last.createdAt = historyTimestamp(item.timestamp)
      } else {
        messages.push({
          id: createId(),
          role: "assistant",
          content: text,
          toolCalls: tools.map((tool) => ({ id: createId(), tool, status: "done" as const })),
          status: "done",
          createdAt: historyTimestamp(item.timestamp),
        })
      }
      continue
    }
    if (item.role === "tool" && "details" in item) {
      const details = asMetricAskDetails(item.details)
      const last = messages[messages.length - 1]
      if (!details || last?.role !== "assistant") continue
      // 历史中的澄清一律只读展示；结果表与导出入口按原始明细还原。
      if (details.status === "clarification_required" && details.clarification) {
        last.response = archiveClarificationResponse(clarificationResponse(details.clarification, details.clarification_prompt ?? details.clarification.prompt))
        last.content = last.response?.answer ?? last.content
      } else if (details.status === "succeeded") {
        last.metricAskDetails = details
      }
    }
  }
  // 结果表在最终助手文本合并完成后再构造，保证回答与表格一致。
  return {
    messages: messages.map((item) => {
      if (item.role !== "assistant" || !item.metricAskDetails) return item
      const details = item.metricAskDetails
      const { metricAskDetails, ...rest } = item
      void metricAskDetails
      return { ...rest, response: responseFromMetricAsk(details, item.content) }
    }),
  }
}

async function loadHistory(expectedUserId = auth.user.value?.id ?? null) {
  const requestVersion = ++historyLoadVersion
  isHistoryLoading.value = true
  historyError.value = ""
  try {
    const listed = await listAgentSessions()
    if (requestVersion !== historyLoadVersion || auth.user.value?.id !== expectedUserId) return
    const currentActive = activeConversation.value
    const loadedHistory: DisplayConversation[] = listed.items
      .map((item) => ({
        id: item.session_id,
        serverId: item.session_id,
        title: titleOverrides.value[item.session_id] ?? item.title ?? "问数会话",
        preview: "",
        messages: [],
        loaded: false,
        persisted: true,
        running: item.running,
        createdAt: item.created_at,
        lastActiveAt: item.last_active_at,
      }))
      .sort((left, right) => new Date(right.lastActiveAt ?? 0).getTime() - new Date(left.lastActiveAt ?? 0).getTime())
    const activeIsInHistory = loadedHistory.some((item) => item.id === currentActive?.id)
    conversations.value = currentActive && !activeIsInHistory
      ? [currentActive, ...loadedHistory]
      : loadedHistory
    // 刷新后优先恢复上次打开的会话。
    const savedServerId = localStorage.getItem(activeConversationStorageKey.value)
    const saved = savedServerId ? loadedHistory.find((item) => item.serverId === savedServerId) : undefined
    if (saved && !currentActive?.messages.length) {
      await selectConversation(saved.id)
    } else if (currentActive) {
      activeConversationId.value = currentActive.id
      persistActiveConversation()
    }
  } catch (error) {
    if (requestVersion !== historyLoadVersion || auth.user.value?.id !== expectedUserId) return
    historyError.value = error instanceof Error ? error.message : "历史会话加载失败。"
  } finally {
    if (requestVersion === historyLoadVersion && auth.user.value?.id === expectedUserId) {
      isHistoryLoading.value = false
    }
  }
}

async function selectConversation(conversationId: string) {
  autoOpenClarificationId.value = undefined
  activeConversationId.value = conversationId
  persistActiveConversation()
  const conversation = conversations.value.find((item) => item.id === conversationId)
  if (!conversation || conversation.loaded || !conversation.serverId) {
    await scrollToBottom()
    return
  }
  isConversationLoading.value = true
  historyError.value = ""
  try {
    const detail = await getAgentSession(conversation.serverId)
    const loaded: DisplayConversation = {
      ...conversation,
      loaded: true,
      running: detail.running,
      messages: conversationFromDetail(detail).messages,
    }
    loaded.title = titleOverrides.value[loaded.serverId ?? ""] ?? detail.title ?? conversationTitle(loaded.serverId, loaded.messages)
    const lastAssistant = [...loaded.messages].reverse().find((item) => item.role === "assistant")
    loaded.preview = lastAssistant?.content ?? loaded.preview
    conversations.value = conversations.value.map((item) => item.id === conversationId ? loaded : item)
    await scrollToBottom()
  } catch (error) {
    if (error instanceof AgentSessionNotFoundError) {
      // 服务端会话已被删除（或存储被清理），直接从列表移除。
      conversations.value = conversations.value.filter((item) => item.id !== conversationId)
      historyError.value = "该会话在服务端已不存在，已从列表移除。"
      const nextConversation = visibleConversations.value[0]
      if (nextConversation) await selectConversation(nextConversation.id)
      else handleNewConversation()
    } else {
      historyError.value = error instanceof Error ? error.message : "会话内容加载失败。"
    }
  } finally {
    isConversationLoading.value = false
  }
}

function showMoreConversations() {
  if (isHistoryLoadingMore.value || !hasMoreConversations.value) return
  isHistoryLoadingMore.value = true
  window.setTimeout(() => {
    historyVisibleCount.value += HISTORY_PAGE_SIZE
    isHistoryLoadingMore.value = false
  }, 150)
}

function openRenameConversation(conversation: DisplayConversation) {
  renameTargetId.value = conversation.id
  renameDraft.value = conversation.title
}

async function submitConversationRename() {
  const title = renameDraft.value.trim()
  const conversation = conversations.value.find((item) => item.id === renameTargetId.value)
  if (!conversation || !title || isRenaming.value) return
  isRenaming.value = true
  try {
    const key = conversation.serverId ?? conversation.id
    titleOverrides.value = { ...titleOverrides.value, [key]: title }
    persistTitleOverrides()
    updateConversation(conversation.id, (item) => ({ ...item, title }))
    renameTargetId.value = ""
  } finally {
    isRenaming.value = false
  }
}

async function copyUserQuestion(chatMessage: DisplayMessage) {
  try {
    await copyText(chatMessage.content)
    copiedMessageId.value = chatMessage.id
    window.setTimeout(() => {
      if (copiedMessageId.value === chatMessage.id) copiedMessageId.value = ""
    }, 1600)
  } catch {
    historyError.value = "复制失败：浏览器同时禁用了剪贴板权限和兼容复制。建议改用 HTTPS 访问，或手动选择文字复制。"
  }
}

function updateConversation(conversationId: string, updater: (conversation: DisplayConversation) => DisplayConversation) {
  conversations.value = conversations.value.map((conversation) => conversation.id === conversationId ? updater(conversation) : conversation)
}

function questionForMessage(chatMessage: DisplayMessage) {
  const messages = activeConversation.value?.messages ?? []
  const index = messages.findIndex((item) => item.id === chatMessage.id)
  return [...messages.slice(0, index)].reverse().find((item) => item.role === "user")?.content ?? ""
}

function updateAssistantMessage(conversationId: string, messageId: string, updater: (message: DisplayMessage) => DisplayMessage) {
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    messages: conversation.messages.map((item) => item.id === messageId ? updater(item) : item),
  }))
}

function markConversationSending(conversationId: string, sending: boolean) {
  const next = new Set(sendingConversationIds.value)
  if (sending) next.add(conversationId)
  else next.delete(conversationId)
  sendingConversationIds.value = next
}

function handleNewConversation() {
  const conversation = createConversation()
  conversations.value = [
    conversation,
    ...conversations.value.filter((item) => item.persisted || item.messages.length > 0),
  ]
  activeConversationId.value = conversation.id
  message.value = ""
  historyError.value = ""
  void scrollToBottom()
}

async function handleDeleteConversation(conversationId: string) {
  const target = conversations.value.find((item) => item.id === conversationId)
  if (!target || sendingConversationIds.value.has(conversationId)) return false
  try {
    if (target.serverId) {
      try {
        await deleteAgentSession(target.serverId)
      } catch (error) {
        // 服务端已不存在视为删除成功，本地照常移除。
        if (!(error instanceof AgentSessionNotFoundError)) throw error
      }
    }
    conversations.value = conversations.value.filter((item) => item.id !== conversationId)
    if (activeConversationId.value === conversationId) {
      const nextConversation = conversations.value[0]
      if (nextConversation) await selectConversation(nextConversation.id)
      else handleNewConversation()
    } else {
      persistActiveConversation()
    }
    return true
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "删除会话失败。"
    return false
  }
}

async function confirmDeleteConversation() {
  const target = deletingConversation.value
  if (!target || isDeletingConversation.value) return
  isDeletingConversation.value = true
  try {
    if (await handleDeleteConversation(target.id)) deletingConversation.value = null
  } finally {
    isDeletingConversation.value = false
  }
}

function handleSubmit(text: string, entities: ComposerEntity[] = []) {
  if (!queryReady.value) return
  // 结构化澄清的选择与正文组合为一段补充文字，作为下一条用户消息发给 agent。
  const label = composeQuestion(text, entities)
  if (!activeConversation.value) handleNewConversation()
  const conversation = activeConversation.value
  if (!conversation || !label || activeConversationIsSending.value || conversation.running) return
  const clarificationMessage = activeClarificationMessage.value
  const kind = clarificationMessage ? "clarification_answer" : "question"
  if (clarificationMessage) {
    // 澄清一经回答即归档为只读记录，仅最新待补充消息可交互。
    updateAssistantMessage(conversation.id, clarificationMessage.id, (item) => ({
      ...item,
      clarification: undefined,
      response: archiveClarificationResponse(item.response),
    }))
  }
  message.value = ""
  void runQuestion(conversation.id, label, kind)
}

async function runQuestion(conversationId: string, question: string, kind: string) {
  if (!queryReady.value) return
  const assistantId = createId()
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    title: conversation.messages.length || conversation.title !== "新的问数会话" ? conversation.title : question.slice(0, 24),
    preview: question,
    messages: [
      ...conversation.messages,
      { id: createId(), role: "user", content: question, kind, createdAt: new Date().toISOString() },
      { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString(), status: "pending", toolCalls: [] },
    ],
    createdAt: conversation.createdAt ?? new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }))
  markConversationSending(conversationId, true)
  const controller = new AbortController()
  abortControllers.set(conversationId, controller)
  await scrollToBottom()
  try {
    const serverId = await ensureServerSession(conversationId)
    await streamPrompt(conversationId, serverId, question, assistantId, controller)
  } catch (error) {
    if (error instanceof AgentSessionNotFoundError) {
      // 服务端会话被清理后容错：重建会话并重放本次提问一次。
      updateConversation(conversationId, (item) => ({ ...item, serverId: null, persisted: false }))
      try {
        const serverId = await ensureServerSession(conversationId)
        await streamPrompt(conversationId, serverId, question, assistantId, controller)
      } catch (retryError) {
        failMessage(conversationId, assistantId, retryError)
      }
    } else {
      failMessage(conversationId, assistantId, error)
    }
  } finally {
    abortControllers.delete(conversationId)
    markConversationSending(conversationId, false)
    persistActiveConversation()
    await scrollToBottom()
  }
}

/** 草稿会话在首次发送时创建服务端会话，并沿用首个问题作为默认标题。 */
async function ensureServerSession(conversationId: string) {
  const conversation = conversations.value.find((item) => item.id === conversationId)
  if (conversation?.serverId) return conversation.serverId
  const created = await createAgentSession()
  updateConversation(conversationId, (item) => ({
    ...item,
    serverId: created.session_id,
    persisted: true,
    createdAt: created.created_at,
  }))
  return created.session_id
}

async function streamPrompt(conversationId: string, serverId: string, question: string, assistantId: string, controller: AbortController) {
  await promptAgentSession(serverId, question, {
    signal: controller.signal,
    onEvent: (event) => handleStreamEvent(conversationId, assistantId, event),
  })
}

function handleStreamEvent(conversationId: string, assistantId: string, event: AgentStreamEvent) {
  if (event.type === "error") {
    throw new AgentApiError(event.message?.trim() || "智能助手处理失败，请稍后重试。", 0)
  }
  if (event.type === "done") {
    updateAssistantMessage(conversationId, assistantId, (item) => ({
      ...finalizeAssistantMessage({ ...item, status: "done" }),
      toolCalls: item.toolCalls?.map((call) => call.status === "running" ? { ...call, status: "done" } : call),
    }))
    const finished = conversations.value
      .find((item) => item.id === conversationId)
      ?.messages.find((item) => item.id === assistantId)
    if (finished?.clarification && activeConversationId.value === conversationId) {
      autoOpenClarificationId.value = finished.clarification.id
    }
    updateConversation(conversationId, (item) => ({ ...item, preview: finished?.content ?? item.preview, running: false }))
    void scrollToBottom()
    return
  }
  updateAssistantMessage(conversationId, assistantId, (item) => {
    if (event.type === "text_delta") {
      // 工具轮次前的纯空白增量不累积，避免气泡开头出现大片空行
      if (!item.content && !event.delta.trim()) return item
      return { ...item, content: item.content + event.delta }
    }
    if (event.type === "message_done") return { ...item, content: event.text || item.content }
    if (event.type === "tool_start") {
      return { ...item, toolCalls: [...(item.toolCalls ?? []), { id: createId(), tool: event.tool, status: "running" as const }] }
    }
    // tool_end：结束对应进度，记录 metric_ask 明细供收尾时构造结果表或澄清卡片。
    const toolCalls = [...(item.toolCalls ?? [])]
    const targetIndex = [...toolCalls.keys()].reverse().find((index) => toolCalls[index]!.tool === event.tool && toolCalls[index]!.status === "running")
    if (targetIndex !== undefined) {
      toolCalls[targetIndex] = { ...toolCalls[targetIndex]!, status: event.isError ? "error" : "done" }
    } else {
      toolCalls.push({ id: createId(), tool: event.tool, status: event.isError ? "error" : "done" })
    }
    const details = asMetricAskDetails(event.details)
    if (!details) return { ...item, toolCalls }
    if (details.status === "clarification_required" && details.clarification) {
      return { ...item, toolCalls, metricAskClarification: details.clarification, metricAskClarificationPrompt: details.clarification_prompt }
    }
    return { ...item, toolCalls, metricAskDetails: details }
  })
  void scrollToBottom()
}

function failMessage(conversationId: string, messageId: string, error: unknown) {
  const aborted = isAgentAbortError(error)
  const content = aborted
    ? "已停止生成。"
    : friendlyQueryError(error instanceof Error ? error.message : null)
  updateAssistantMessage(conversationId, messageId, (item) => {
    const finalized = finalizeAssistantMessage({ ...item, status: aborted ? "done" : "error" })
    return {
      ...finalized,
      content: aborted ? (finalized.content || content) : (finalized.content ? `${finalized.content}\n${content}` : content),
      status: aborted ? "done" : "error",
      toolCalls: finalized.toolCalls?.map((call) => call.status === "running" ? { ...call, status: aborted ? "done" : "error" } : call),
    }
  })
  updateConversation(conversationId, (conversation) => ({ ...conversation, preview: content, running: false }))
}

async function scrollToBottom() {
  await nextTick()
  if (messagesScroll.value) messagesScroll.value.scrollTop = messagesScroll.value.scrollHeight
}
</script>

<template>
  <section class="grid min-h-0 flex-1 overflow-hidden border bg-background" :class="isHistoryCollapsed ? 'grid-cols-[44px_minmax(0,1fr)] grid-rows-1' : 'grid-rows-[minmax(0,15rem)_minmax(0,1fr)] sm:grid-cols-[240px_minmax(0,1fr)] sm:grid-rows-1 lg:grid-cols-[300px_minmax(0,1fr)]'">
    <aside v-if="!isHistoryCollapsed" class="flex min-h-0 flex-col border-b bg-muted/30 sm:border-r sm:border-b-0">
      <div class="border-b px-3 py-2.5">
        <BaseButton variant="outline" class="w-full justify-start border-border/70 bg-background/70 text-foreground shadow-none hover:bg-muted/70" @click="handleNewConversation"><Plus />新建对话</BaseButton>
      </div>
      <div class="flex items-center gap-2 border-b px-3 py-2.5">
        <p class="min-w-0 flex-1 text-sm font-semibold">历史对话</p>
        <BaseButton variant="ghost" size="icon" class="text-muted-foreground" title="收起历史对话" aria-label="收起历史对话" @click="isHistoryCollapsed = true"><PanelLeftClose /></BaseButton>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        <LoadingSkeleton v-if="isHistoryLoading" :rows="3" row-class="h-14" />
        <div v-else class="flex flex-col gap-1.5">
          <div v-for="conversation in visibleConversations" :key="conversation.id" class="group/history flex items-start gap-1.5 rounded-xl border border-border/70 bg-background px-2.5 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-muted-foreground/35 hover:bg-background" :class="conversation.id === activeConversation?.id && 'border-primary/35 bg-primary/[0.025] ring-1 ring-primary/10'">
            <button type="button" class="min-w-0 flex-1 px-1 text-left text-sm" @click="selectConversation(conversation.id)">
              <span class="flex items-center gap-1.5"><span class="line-clamp-1 min-w-0 flex-1 font-medium">{{ conversation.title }}</span><LoaderCircle v-if="sendingConversationIds.has(conversation.id) || conversation.running" class="size-3.5 animate-spin" /></span>
              <span v-if="conversation.preview" class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{{ conversation.preview }}</span>
              <span class="mt-1.5 block text-[11px] text-muted-foreground/80" :title="`会话创建时间：${formatConversationDate(conversation.createdAt)}`">{{ formatConversationDate(conversation.createdAt) }}</span>
            </button>
            <PopoverRoot>
              <PopoverTrigger as-child>
                <BaseButton variant="ghost" size="icon" class="size-7 shrink-0 text-muted-foreground" title="会话操作"><Ellipsis /></BaseButton>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent side="right" :side-offset="6" align="start" class="z-50 w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
                  <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm hover:bg-muted" @click="openRenameConversation(conversation)"><Pencil class="size-3.5" />修改名称</button>
                  <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50" :disabled="sendingConversationIds.has(conversation.id)" @click="deletingConversation = conversation"><Trash2 class="size-3.5" />删除会话</button>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
          </div>
          <BaseButton v-if="hasMoreConversations" variant="outline" size="sm" class="mt-2 w-full text-muted-foreground" :disabled="isHistoryLoadingMore" @click="showMoreConversations">
            <LoaderCircle v-if="isHistoryLoadingMore" class="size-3.5 animate-spin" />
            {{ isHistoryLoadingMore ? "正在加载下一批..." : "显示更多会话" }}
          </BaseButton>
        </div>
      </div>
    </aside>
    <aside v-else class="flex min-h-0 flex-col items-center border-r bg-muted/30 py-2">
      <BaseButton variant="ghost" size="icon" class="text-muted-foreground" title="展开历史对话" aria-label="展开历史对话" @click="isHistoryCollapsed = false"><PanelLeftOpen /></BaseButton>
    </aside>

    <div class="flex min-h-0 min-w-0 flex-col">
      <header class="flex min-h-14 items-center border-b px-4 py-3">
        <h1 class="min-w-0 truncate text-base font-semibold">{{ activeConversation?.title ?? "指标问数" }}</h1>
      </header>

      <div ref="messagesScroll" class="min-h-0 flex-1 overflow-y-auto bg-muted/20 px-4 py-5">
        <BaseAlert v-if="historyError" class="mx-auto mb-4 max-w-4xl" title="任务操作失败" variant="destructive">{{ historyError }}</BaseAlert>
        <LoadingSkeleton v-if="isConversationLoading" class="mx-auto max-w-4xl" :rows="4" row-class="h-20" />
        <div v-else-if="activeConversation?.messages.length" class="flex w-full flex-col gap-5">
          <div v-for="chatMessage in activeConversation.messages" :key="chatMessage.id" class="flex w-full gap-3" :class="chatMessage.role === 'user' ? 'justify-end' : 'justify-start'">
            <div class="min-w-0" :class="chatMessage.role === 'user' ? 'group/user max-w-[min(760px,78%)]' : 'flex w-full max-w-none flex-1 flex-col gap-2'">
              <template v-if="chatMessage.role === 'user'">
                <div class="rounded-2xl rounded-br-md border border-border/70 bg-muted/65 px-4 py-3 text-sm text-foreground shadow-none"><p class="whitespace-pre-wrap break-words leading-6">{{ chatMessage.content }}</p></div>
                <div class="flex justify-end opacity-0 transition-opacity group-hover/user:opacity-100 group-focus-within/user:opacity-100">
                  <BaseButton variant="ghost" size="icon" class="size-7 text-muted-foreground" :title="copiedMessageId === chatMessage.id ? '已复制' : '复制'" :aria-label="copiedMessageId === chatMessage.id ? '已复制' : '复制问题'" @click="copyUserQuestion(chatMessage)">
                    <Check v-if="copiedMessageId === chatMessage.id" class="size-3.5 text-emerald-600" />
                    <Copy v-else class="size-3.5" />
                  </BaseButton>
                </div>
              </template>
              <template v-else>
                <div class="group/assistant min-w-0 px-1 text-sm">
                <div class="mb-2 flex min-h-9 items-center gap-2" role="status" aria-live="polite">
                  <span class="flex size-9 items-center justify-center rounded-xl bg-muted/40 text-foreground" aria-label="智能问数助手"><Bot class="size-4.5" /></span>
                  <time v-if="formatMessageTime(chatMessage.createdAt)" :datetime="chatMessage.createdAt" class="text-xs text-muted-foreground">{{ formatMessageTime(chatMessage.createdAt) }}</time>
                  <template v-if="executionStatus(chatMessage).kind !== 'running' && executionStatus(chatMessage).kind !== 'success'">
                    <span v-if="formatMessageTime(chatMessage.createdAt)" class="text-muted-foreground/30">·</span>
                    <AlertTriangle v-if="executionStatus(chatMessage).kind === 'failed'" class="size-3.5 text-muted-foreground" />
                    <MessageCircleQuestion v-else-if="executionStatus(chatMessage).kind === 'waiting'" class="size-3.5 text-muted-foreground" />
                    <span class="text-xs" :class="executionStatus(chatMessage).titleClass">{{ executionStatus(chatMessage).title }}</span>
                  </template>
                </div>
                <div v-if="executionStatus(chatMessage).kind === 'running'" class="mb-2 flex items-center gap-2 text-xs text-muted-foreground/60" role="status" aria-live="polite">
                  <span>{{ executionStatus(chatMessage).title }}</span>
                  <span class="flex items-center gap-1" aria-hidden="true">
                    <span class="execution-dot size-1.5 rounded-full bg-[#7C9CDB]" />
                    <span class="execution-dot size-1.5 rounded-full bg-[#7C9CDB] [animation-delay:160ms]" />
                    <span class="execution-dot size-1.5 rounded-full bg-[#7C9CDB] [animation-delay:320ms]" />
                  </span>
                </div>
                <p v-if="chatMessage.status === 'pending' && chatMessage.content" class="whitespace-pre-wrap break-words leading-7">{{ chatMessage.content }}<span class="inline-block h-4 w-0.5 animate-pulse rounded-full bg-[#52789C] align-middle" aria-hidden="true" /></p>
                <ChatResultContent v-else-if="chatMessage.status !== 'pending' && chatMessage.response" :response="chatMessage.response" :clarification-resolved="!chatMessage.clarification" :question="questionForMessage(chatMessage)" />
                <p v-else-if="chatMessage.status !== 'pending'" class="whitespace-pre-wrap break-words leading-6">{{ chatMessage.content }}</p>
                <div v-if="chatMessage.clarification?.fields?.length" class="mt-1">
                  <StructuredClarificationForm :clarification="chatMessage.clarification" />
                </div>
                </div>
              </template>
            </div>
          </div>
        </div>
        <div v-else class="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-5 px-3 text-center">
          <Bot class="size-10 text-foreground" />
          <div><h2 class="text-xl font-semibold">开始指标问数</h2><p class="mt-2 text-sm text-muted-foreground">输入经营指标问题，系统将按指标口径、时间和机构范围查询数据库。</p></div>
          <div class="grid w-full gap-3 sm:grid-cols-3">
            <button v-for="example in exampleQuestions" :key="example" type="button" class="min-h-24 rounded-xl border border-border bg-background px-4 py-3 text-left text-sm leading-6 text-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-primary/[0.03]" @click="message = example">{{ example }}</button>
          </div>
        </div>
      </div>
      <div class="border-t bg-background p-4">
        <div v-if="!queryReady" role="status" aria-live="polite" class="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle v-if="queryReadiness.status === 'initializing'" class="size-4 shrink-0 animate-spin" />
          <AlertTriangle v-else class="size-4 shrink-0" />
          <span>{{ queryReadiness.message }}<span v-if="queryReadiness.total > 0">（{{ queryReadiness.completed }}/{{ queryReadiness.total }}）</span></span></div>
        <p v-else-if="activeConversation?.running && !activeConversationIsSending" class="mb-3 text-sm text-muted-foreground">该会话正在其他窗口运行，请稍候或新建对话。</p>
        <CatalogQuestionComposer :key="auth.user.value?.id" v-model="message" :context-key="`${activeConversationId}:${activeClarificationMessage?.clarification?.id ?? activeConversation?.messages.length ?? 0}`" :clarification="activeClarificationMessage?.clarification" :auto-open-clarification-id="autoOpenClarificationId" :is-submitting="activeConversationIsSending" :disabled="!queryReady || Boolean(activeConversation?.running && !activeConversationIsSending)" :placeholder="composerPlaceholder" @submit="handleSubmit" />
      </div>
    </div>
  </section>
  <ConfirmDialog :open="Boolean(deletingConversation)" title="删除历史会话" :busy="isDeletingConversation" @update:open="!$event && (deletingConversation = null)" @confirm="confirmDeleteConversation">
    即将永久删除会话 <strong class="font-medium text-foreground">「{{ deletingConversation?.title }}」</strong> 及其消息记录。此操作无法撤销。
  </ConfirmDialog>
  <BaseModal :open="Boolean(renameTargetId)" title="修改会话名称" description="新名称会同时显示在历史会话列表和当前会话标题中。" :busy="isRenaming" size="sm" @update:open="(open) => { if (!open) renameTargetId = '' }">
    <form class="space-y-2" @submit.prevent="submitConversationRename">
      <label for="conversation-title" class="text-sm font-medium">会话名称</label>
      <input id="conversation-title" v-model="renameDraft" maxlength="255" autofocus class="min-h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/30" placeholder="输入会话名称" @keydown.enter.prevent="submitConversationRename">
      <p class="text-xs text-muted-foreground">最多 255 个字符。</p>
    </form>
    <template #footer>
      <BaseButton variant="outline" :disabled="isRenaming" @click="renameTargetId = ''">取消</BaseButton>
      <BaseButton :disabled="!renameDraft.trim() || isRenaming" @click="submitConversationRename"><LoaderCircle v-if="isRenaming" class="animate-spin" />保存</BaseButton>
    </template>
  </BaseModal>
</template>
