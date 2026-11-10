<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import {applyProvisionalAnswer, clearProvisionalAnswer} from "@/lib/provisionalAnswer"
import { createChatScrollFollow, createProvisionalAnswerScheduler, reconcileAnswerSnapshot } from "@/lib/answerStreamPresentation"
import { availabilityReply, type AvailabilityDetails } from "@/lib/dataAvailability"
import { governedReply, catalogOverviewReply, type CatalogOverviewDetails } from "@/lib/replyPresentation"
import { businessReportPresentation } from "@/lib/businessReportPresentation"
import { applyChatToolResult } from "@/lib/chatToolResults"
import { AlertTriangle, Bot, Check, Copy, Ellipsis, LoaderCircle, MessageCircleQuestion, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Trash2 } from "@lucide/vue"
import { computed, nextTick, onActivated, onMounted, onBeforeUnmount, ref, watch } from "vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"

import CatalogQuestionComposer from "@/components/chat/CatalogQuestionComposer.vue"
import AgentMessageDiagnostics from "@/components/chat/AgentMessageDiagnostics.vue"
import ChatResultContent from "@/components/chat/ChatResultContent.vue"
import QuerySqlButton from "@/components/chat/QuerySqlButton.vue"
import type { QuerySqlReference } from "@/types/querySql"
import CalculationResult from "@/components/chat/CalculationResult.vue"
import StructuredClarificationForm from "@/components/chat/StructuredClarificationForm.vue"
import TimeVariantChoices from "@/components/chat/TimeVariantChoices.vue"
import { semanticQuestionFeedback } from "@/lib/clarificationChoices"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import BaseCheckbox from "@/components/ui/BaseCheckbox.vue"
import ConversationRenameField from "@/components/chat/ConversationRenameField.vue"
import ConversationDeleteDialog from "@/components/chat/ConversationDeleteDialog.vue"
import { useConversationManagement } from "@/composables/useConversationManagement"
import {
  AgentApiError,
  AgentSessionNotFoundError,
  cancelAgentOperation,
  cancelAgentRequest,
  createAgentSession,
  renameAgentSession,
  getAgentSession,
  isAgentAbortError,
  listAgentSessions,
  promptAgentSession,
  observeAgentSession,
  type AgentSnapshot,
  type AgentPromptInput,
  type AgentSessionDetail,
  type AgentStreamEvent,
  type AnswerReceipt,
  type MetricAskDetails,
  type CalculationDetails,
  type PendingQuestion,
  type QuestionState,
} from "@/lib/agentApi"
import { getBackendTaskResult } from "@/lib/api"
import type { BackendNextClarification, ChatResponse, TimeVariant } from "@/types/api"
import { useAuth } from "@/composables/useAuth"
import { useQueryReadiness } from "@/composables/useQueryReadiness"
import { copyText } from "@/lib/clipboard"
import { archiveClarificationResponse, archiveTimeVariantsResponse } from "@/lib/conversationMessages"
import { composeQuestion, selectedClarificationAnswer, type ComposerEntity } from "@/lib/composerEntities"
import { friendlyQueryError, withFailureNotice } from "@/lib/queryErrors"
import { toolCallLabel, toolCallSummary, type ToolCallSummary } from "@/lib/toolCallSummary"

/**
 * 指标问数面板：问答数据链路走 agent-service（pi harness）的 SSE 事件流，
 * 模型经受治理接口取数；页面骨架、样式与交互约定保持与既有问数页一致。
 * 会话由 agent-service 持久化（重启可恢复），历史消息含工具明细，可还原结果表与历史澄清记录。
 */
type ToolCallDisplay = {
  id: string
  tool: string
  status: "running" | "done" | "error" | "interrupted" | "unknown"
  elapsedMs?: number
  /** 实时流中的开始时刻，用于在工具结束时计算步骤耗时。 */
  startedAt?: number
  /** 步骤结果摘要：已确定条件与一句结果说明。 */
  summary?: ToolCallSummary
  /** 回执已换成查询结果时的步骤名称，见 toolCallLabel。 */
  label?: string
}

/** 理解问题阶段的非工具步骤；只来自实时流，历史记录不保存。 */
type ActivityDisplay = {
  id: string
  label: string
  status: "running" | "done"
  startedAt: number
  elapsedMs?: number
  summary?: ToolCallSummary
}

type DisplayMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  /** 仅实时展示，不参与正式回答、复制、导出或存档。 */
  provisionalContent?: string
  provisionalCallSeq?: number
  /** 本轮已展示的失败说明，快照和收尾事件不得重复追加。 */
  failureNotice?: string
  response?: ChatResponse
  status?: "pending" | "done" | "error"
  toolCalls?: ToolCallDisplay[]
  activities?: ActivityDisplay[]
  taskIds?: string[]
  querySqlReferences?: QuerySqlReference[]
  elapsedMs?: number
  /** run_terminal 携带的 agent-service 侧耗时：鉴权、各次模型调用与工具处理（重连流无此数据） */
  runTimings?: { auth_ms?: number; total_ms?: number; model_ms?: number[]; tool_ms?: number[];
    first_visible_ms?: number | null; model_first_token_ms?: number[] }
  clarification?: BackendNextClarification
  createdAt?: string
  kind?: string
  /** 本轮最近一次 metric_ask 的工具明细，done/error 收尾时用于构造结构化响应。 */
  metricAskDetails?: MetricAskDetails
  queryResults?: MetricAskDetails[]
  calculations?: CalculationDetails[]
  metricAskClarification?: BackendNextClarification
  answerStreaming?: boolean
  answerDelivered?: boolean
  nativeAnswer?: boolean
  availabilityError?: string
  availability?: AvailabilityDetails[]
  catalogOverviews?: CatalogOverviewDetails[]
  metricAskClarificationPrompt?: string
  /** 待补充澄清的业务目标：回答卡片时随请求回传，由后端精确命中原任务 */
  clarificationTarget?: { task_id: string; version: number; clarification_id: string }
  /** 发布时的题目快照；仅作历史回放与状态恢复，澄清统一为文字追问，不再渲染选择卡片。 */
  pendingQuestions?: PendingQuestion[]
  /** 仅来自正式工具回执，不在点击时本地伪造受理明示。 */
  answerReceipts?: AnswerReceipt[]
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
  /** 旧格式只读会话：不可提问，仅供查看 */
  legacy?: boolean
  /** 当前活动原生 operation，用于显式停止 */
  activeOperationId?: string | null
  /** 服务端投影的当前状态；缺失时不能从历史题目推断为 open。 */
  questionStates: QuestionState[]
}

const toolLabels: Record<string, string> = {
  business_skill_read: "确认查询方法",
  business_capability_explain: "说明当前能力",
  answer_evidence_check: "核验回答依据",
  answer_present: "交付回答",
  data_availability: "查看数据覆盖",
  metric_ask: "指标问数",
  resolve_business_turn: "解析查询条件",
  business_context_read: "读取查询历史",
  execute_business_frame: "执行指标查询",
  read_business_result: "读取历史结果",
  metric_query_structured: "指标结构化查询",
  metric_calculate: "可靠计算工具",
  catalog: "目录查询",
  read: "读取任务、结果与历史",
  metric_catalog_search: "指标目录检索",
  metric_catalog_overview: "可查询指标总览",
  metric_read: "结果回读",
  session_history_read: "会话历史回读",
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
watch(activeConversationId, () => {
  autoOpenClarificationId.value = undefined
  // 切换前完成已接收的正文，取消旧会话排队的滚动。
  answerFrames.flush()
  scrollFollow.reset()
}, { flush: "sync" })
const sendingConversationIds = ref(new Set<string>())
const abortControllers = new Map<string, AbortController>()
const pendingPrompts = new Map<string, {requestId: string; cancelFailure?: Error}>()
const isHistoryLoading = ref(true)
const isConversationLoading = ref(false)
const isHistoryLoadingMore = ref(false)
const historyError = ref("")
const messagesScroll = ref<HTMLElement | null>(null)
const scrollFollow = createChatScrollFollow(() => messagesScroll.value)
const answerFrames = createProvisionalAnswerScheduler((conversationId, assistantId, event) => {
  if (updateAssistantMessage(conversationId, assistantId, item => applyProvisionalAnswer(item, event))) {
    scrollToBottom(false, conversationId)
  }
})
let presentationDisposed = false
const copiedMessageId = ref("")
const HISTORY_PAGE_SIZE = 12
const historyVisibleCount = ref(HISTORY_PAGE_SIZE)
const hasActivatedOnce = ref(false)
const isHistoryCollapsed = ref(false)
const panelRoot = ref<HTMLElement | null>(null)
const headerTitle = ref<HTMLButtonElement | null>(null)
const conversationMenuId = ref("")
const loadedUserId = ref<string | null>(null)
/** 兼容既有本机标题与尚未创建服务端会话的草稿；正式改名由服务端保存。 */
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
/** 只有会话中最新、已完成的答案消息可以切换口径。 */
function isActiveTimeVariant(chatMessage: DisplayMessage): boolean {
  const conversation = activeConversation.value
  const messages = conversation?.messages ?? []
  return Boolean(chatMessage.response?.time_variants?.length) && messages[messages.length - 1]?.id === chatMessage.id
    && chatMessage.status === "done" && !conversation?.running && !activeConversationIsSending.value && queryReady.value
}

/** 点选备选口径：携带显式 time_override 走既有提问链路重查，原消息口径 chips 归档为只读。 */
function chooseTimeVariant(chatMessage: DisplayMessage, variant: TimeVariant) {
  const conversation = activeConversation.value
  if (!conversation || !isActiveTimeVariant(chatMessage) || conversation.legacy) return
  const label = `切换口径：${variant.label}`
  const input: AgentPromptInput = {
    request_id: createId(),
    message: label,
    time_override: { start: variant.start, end: variant.end },
  }
  updateAssistantMessage(conversation.id, chatMessage.id, (item) => ({
    ...item,
    response: archiveTimeVariantsResponse(item.response),
  }))
  void runQuestion(conversation.id, label, "time_override", input)
}

const activeClarificationMessage = computed(() => {
  const messages = activeConversation.value?.messages ?? []
  const latest = messages[messages.length - 1]
  return latest?.role === "assistant" && latest.status === "done" && latest.clarification ? latest : undefined
})
const composerPlaceholder = computed(() => {
  const clarification = activeClarificationMessage.value?.clarification
  if (!clarification) return "请输入本次查询的日期、机构和指标"
  if (clarification.fields?.length && clarification.fields.every((field) => field.type === "date_range")) {
    return "补充查询日期，例如：2026年7月末"
  }
  return "直接回复序号或名称进行选择，或补充查询条件"
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
const management = useConversationManagement({
  conversations,
  history: sortedConversations,
  visible: visibleConversations,
  sending: sendingConversationIds,
  actorId: computed(() => auth.user.value?.id ?? null),
  onRenamed: (conversation, title) => {
    const key = conversation.serverId ?? conversation.id
    const next = { ...titleOverrides.value }
    if (conversation.serverId) delete next[key]
    else next[key] = title
    titleOverrides.value = next
    persistTitleOverrides()
    updateConversation(conversation.id, item => ({ ...item, title }))
  },
  onRemoved: async (ids) => {
    const removed = conversations.value.filter(item => ids.has(item.id))
    conversations.value = conversations.value.filter(item => !ids.has(item.id))
    const next = { ...titleOverrides.value }
    for (const item of removed) { delete next[item.id]; if (item.serverId) delete next[item.serverId] }
    titleOverrides.value = next
    persistTitleOverrides()
    if (ids.has(activeConversationId.value)) {
      const first = conversations.value[0]
      if (first) await selectConversation(first.id)
      else handleNewConversation()
    } else persistActiveConversation()
  },
})
const {
  managing: isManagingConversations, selectedIds: selectedConversationIds, selected: selectedConversations,
  eligible: deletableConversations, visibleEligible: visibleDeletableConversations,
  allVisibleSelected, someVisibleSelected, allSelected, renameTargetId, renameSource,
  renameBusy: isRenaming, renameError, notice: managementNotice, deleteOpen, deleteTargets,
  deleting: isDeletingConversation, deleteFinished, processed: deletedProgress, failures: deleteFailures,
} = management
watch(renameTargetId, async (value, previous) => {
  if (value || !previous) return
  await nextTick()
  if (renameSource.value === "header") headerTitle.value?.focus()
  else [...(panelRoot.value?.querySelectorAll<HTMLButtonElement>("[data-conversation-open]") ?? [])]
    .find(button => button.dataset.conversationOpen === previous)?.focus()
})
watch(deleteOpen, async (open, previous) => {
  if (open || !previous) return
  await nextTick()
  panelRoot.value?.querySelector<HTMLButtonElement>("[data-conversation-manage]")?.focus()
})
let managementNoticeTimer: ReturnType<typeof setTimeout> | undefined
watch(managementNotice, (value) => {
  if (managementNoticeTimer) clearTimeout(managementNoticeTimer)
  if (value) managementNoticeTimer = setTimeout(() => { managementNotice.value = "" }, 3000)
})

watch(() => props.initialMessage, (value) => {
  if (!message.value.trim()) message.value = value.trim()
})

watch(() => auth.user.value?.id ?? null, (userId) => {
  void synchronizeAuthenticatedUser(userId)
})

onMounted(() => void synchronizeAuthenticatedUser(auth.user.value?.id ?? null))
onBeforeUnmount(() => {
  if (managementNoticeTimer) clearTimeout(managementNoticeTimer)
  management.reset()
  presentationDisposed = true
  answerFrames.dispose()
  scrollFollow.dispose()
  for (const controller of abortControllers.values()) controller.abort()
})

onActivated(() => void activateAuthenticatedUser())

function activateAuthenticatedUser() {
  if (isDeletingConversation.value) return Promise.resolve()
  const userId = auth.user.value?.id ?? null
  let pending = Promise.resolve()
  if (loadedUserId.value !== userId) pending = synchronizeAuthenticatedUser(userId)
  else if (hasActivatedOnce.value && userId) {
    pending = loadHistory(userId)
  }
  hasActivatedOnce.value = true
  return pending
}

function resetChatSessionState() {
  management.reset()
  conversationMenuId.value = ""
  answerFrames.clear()
  scrollFollow.reset()
  historyLoadVersion += 1
  conversations.value = []
  activeConversationId.value = ""
  sendingConversationIds.value = new Set()
  for (const controller of abortControllers.values()) controller.abort()
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
  openEmptyDraft()
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
    title: "正在处理，请稍候",
    detail: runningTool ? `正在查询：${toolLabel(runningTool.tool)}` : "正在等待模型回答",
    titleClass: "",
  }
}

function createConversation(id = createId()): DisplayConversation {
  return { id, serverId: null, title: "新的问数会话", preview: "尚未开始", messages: [], loaded: true, persisted: false, running: false, createdAt: null, lastActiveAt: null, questionStates: [] }
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
  const firstQuestion = messages.find((item) => item.role === "user" && item.kind !== "clarification_answer" && item.kind !== "time_override")?.content.trim()
  return firstQuestion ? firstQuestion.slice(0, 24) : "问数会话"
}

/** 由 metric_ask 工具明细构造既有 ChatResponse 形状，复用 ChatResultContent 渲染。 */
function responseFromMetricAsk(details: MetricAskDetails, answer: string): ChatResponse {
  // 行数据只来自后端不可变快照；工具明细未带 rows 时表格由 hydrateResultTables 回填
  const hasRows = Array.isArray(details.rows)
  const rows = details.rows ?? []
  const columns = details.columns?.length ? details.columns : rows.length ? Object.keys(rows[0]!) : []
  const rowCount = details.row_count ?? rows.length
  // 服务端结构化回答块优先：仅在非空数组时透传，其余交给前端 markdown 解析回退
  const answerBlocks = Array.isArray(details.public_answer_blocks) && details.public_answer_blocks.length
    ? details.public_answer_blocks
    : null
  // 备选时间口径随工具明细透传到结构化响应，历史快照经同一入口还原
  const timeVariants = details.time_variants?.length ? details.time_variants : undefined
  const analysisReport = businessReportPresentation(details)
  return {
    message_id: details.task_id ?? createId(),
    intent: "metric_query",
    answer: answer.trim() || governedReply(details) || (rowCount ? `查询完成，找到 ${rowCount} 条记录。` : "查询完成，暂无匹配数据。"),
    ...(answerBlocks && (!answer.trim() || answer.trim() === details.public_answer) ? { answer_blocks: answerBlocks } : {}),
    ...(timeVariants ? { time_variants: timeVariants } : {}),
    result: hasRows && rowCount <= 100 && columns.length ? { type: "metric_query", table: { columns, rows } } : null,
    metric_definition: null,
    clarification: null,
    debug: { task_id: details.task_id, row_count: rowCount },
    ...(details.report ? { analysis_plan: details.report.plans.flatMap(plan => plan?.questions ?? []) } : {}),
    ...(analysisReport ? { analysis_report: analysisReport } : {}),
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
  if (chatMessage.answerDelivered || chatMessage.nativeAnswer) {
    const details = chatMessage.metricAskDetails
    return details?.status === "succeeded"
      ? { ...chatMessage, response: responseFromMetricAsk(details, chatMessage.content) }
      : chatMessage
  }
  const calculationCalls = chatMessage.toolCalls?.filter(call => ["metric_calculate", "analysis_calculate"].includes(call.tool)) ?? []
  const lastCalculation = calculationCalls[calculationCalls.length - 1]
  if (lastCalculation?.status === "error") {
    return { ...chatMessage, content: chatMessage.content || "本次计算未成功，暂不能提供可靠的计算结果，请重新查询所需指标后再计算。" }
  }

  const clarification = chatMessage.metricAskClarification
  if (clarification) {
    const response = clarificationResponse(clarification, chatMessage.metricAskClarificationPrompt ?? clarification.prompt)
    return { ...chatMessage, clarification, response, content: response.answer }
  }
  const details = chatMessage.metricAskDetails
  if (details && details.status === "succeeded") {
    const response = responseFromMetricAsk(details, chatMessage.content)
    if (chatMessage.response?.debug?.task_id === details.task_id && chatMessage.response?.result) response.result = chatMessage.response.result
    return { ...chatMessage, response }

  }
  const fixed = governedReply(details)
  if (fixed !== undefined) return { ...chatMessage, content: fixed }
  if (chatMessage.availabilityError && !details) return { ...chatMessage, content: chatMessage.availabilityError }
  if (chatMessage.availability?.length && !details && !chatMessage.calculations?.length) {
    return { ...chatMessage, content: chatMessage.content || chatMessage.availability.map(availabilityReply).join("\n") }
  }
  if (chatMessage.catalogOverviews?.length && !chatMessage.metricAskDetails && !chatMessage.calculations?.length) {
    return { ...chatMessage, content: chatMessage.content || chatMessage.catalogOverviews.map(catalogOverviewReply).join("\n\n") }
  }
  return chatMessage
}

function historyTimestamp(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined
}

/** 展开批次证据时保留批次字段及完整 semantic_task，不能用空壳协议标记覆盖正式反馈。 */
function expandSemanticResultDetails(details: unknown): unknown[] | undefined {
  if (!details || typeof details !== "object") return undefined
  const bundle = details as Record<string, unknown>
  if (bundle.kind !== "semantic_results" || !Array.isArray(bundle.results)) return undefined
  const { results, ...published } = bundle
  return results.map(result => {
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {}
    return {
      ...published,
      ...value,
      semantic_task: published.semantic_task ?? value.semantic_task ?? { protocol_version: 2 },
    }
  })
}

function mergeQuestionSnapshots(current: PendingQuestion[] | undefined, incoming: PendingQuestion[]) {
  const merged = [...(current ?? [])]
  for (const question of incoming) {
    const index = merged.findIndex(item => item.question_id === question.question_id && item.version === question.version)
    if (index >= 0) merged[index] = question
    else merged.push(question)
  }
  return merged
}

function mergeAnswerReceipts(current: AnswerReceipt[] | undefined, incoming: AnswerReceipt[]) {
  const merged = [...(current ?? [])]
  for (const receipt of incoming) {
    const key = JSON.stringify([receipt.question_id, receipt.version, receipt.outcome, receipt.code, receipt.notice,
      receipt.selected_options?.map(option => option.option_id)])
    const duplicate = merged.some(item => JSON.stringify([item.question_id, item.version, item.outcome, item.code, item.notice,
      item.selected_options?.map(option => option.option_id)]) === key)
    if (!duplicate) merged.push(receipt)
  }
  return merged
}

function withQuestionFeedback(chatMessage: DisplayMessage, details: unknown): DisplayMessage {
  const feedback = semanticQuestionFeedback(details)
  if (!feedback.pendingQuestions.length && !feedback.answerReceipts.length) return chatMessage
  return {
    ...chatMessage,
    ...(feedback.pendingQuestions.length ? { pendingQuestions: mergeQuestionSnapshots(chatMessage.pendingQuestions, feedback.pendingQuestions) } : {}),
    ...(feedback.answerReceipts.length ? { answerReceipts: mergeAnswerReceipts(chatMessage.answerReceipts, feedback.answerReceipts) } : {}),
  }
}

function statesAfterQuestionFeedback(current: QuestionState[], feedback: ReturnType<typeof semanticQuestionFeedback>) {
  let states = [...current]
  const upsert = (next: QuestionState) => {
    const index = states.findIndex(item => item.question_id === next.question_id && item.version === next.version)
    if (index >= 0) states[index] = next
    else states.push(next)
  }
  for (const question of feedback.pendingQuestions) {
    states = states.map(item => item.question_id === question.question_id && item.version < question.version
      ? { ...item, status: "superseded" as const } : item)
    upsert({ question_id: question.question_id, version: question.version, status: question.status })
  }
  for (const receipt of feedback.answerReceipts) {
    const status: QuestionState["status"] | undefined = receipt.outcome === "applied" || receipt.outcome === "already_applied" ? "answered"
      : receipt.outcome === "declined" ? "rejected"
        : receipt.code === "QUESTION_SUPERSEDED" ? "superseded" : undefined
    if (status) upsert({ question_id: receipt.question_id, version: receipt.version, status })
  }
  return states
}

function applyRealtimeQuestionFeedback(conversationId: string, assistantId: string, details: unknown) {
  const feedback = semanticQuestionFeedback(details)
  if (!feedback.pendingQuestions.length && !feedback.answerReceipts.length) return
  updateAssistantMessage(conversationId, assistantId, item => withQuestionFeedback(item, details))
  updateConversation(conversationId, item => ({
    ...item,
    questionStates: statesAfterQuestionFeedback(item.questionStates ?? [], feedback),
  }))
}

/** 还原历史消息：连续的助手片段合并为一个气泡，其后的工具明细还原结果表与只读澄清记录。 */
function conversationFromDetail(detail: AgentSessionDetail): Pick<DisplayConversation, "messages"> {
  const messages: DisplayMessage[] = []
  const expanded = detail.messages.flatMap(item => {
    const details = item.role === "tool" && "details" in item ? expandSemanticResultDetails(item.details) : undefined
    return details ? details.map(expandedDetails => ({...item, details: expandedDetails})) : [item]
  })
  for (const item of expanded) {
    if (item.role === "user") {
      const text = "text" in item ? item.text ?? "" : ""
      if (!text.trim()) continue
      messages.push({ id: createId(), role: "user", content: text, createdAt: historyTimestamp(item.timestamp) })
      continue
    }
    if (item.role === "assistant") {
      const failure = "error" in item ? item.error : undefined
      const body = "text" in item ? item.text ?? "" : ""
      const projected = withFailureNotice({ content: body }, failure ?? "")
      const text = projected.content
      const tools = "tools" in item ? item.tools ?? [] : []
      const savedCalls = "tool_calls" in item ? item.tool_calls : undefined
      const calls: ToolCallDisplay[] = (savedCalls ?? tools.map(tool => ({ tool }))).map(call => ({
        id: ("id" in call && typeof call.id === "string" ? call.id : createId()), tool: call.tool, status: "unknown",
      }))
      const last = messages[messages.length - 1]
      if (last?.role === "assistant") {
        // 跨轮次合并助手片段：两侧都有内容时补段落分隔，避免首尾粘连
        if (text.trim()) {
          last.content = text
          last.failureNotice = projected.failureNotice
        }
        if ("business_protocol" in item && item.business_protocol === "frame_v1") last.nativeAnswer = true
        last.toolCalls = [...(last.toolCalls ?? []), ...calls]
        if (failure) {
          last.status = "error"
          last.response = undefined
        } else if (text.trim()) {
          // 历史最终成功正文覆盖失败attempt；诊断仍保留在原工具/模型事件中。
          last.status = "done"
        }
        if (!last.createdAt) last.createdAt = historyTimestamp(item.timestamp)
      } else {
        messages.push({
          id: createId(),
          role: "assistant",
          nativeAnswer: "business_protocol" in item && item.business_protocol === "frame_v1",
          content: text,
          failureNotice: projected.failureNotice,
          toolCalls: calls,
          status: failure ? "error" : "done",
          createdAt: historyTimestamp(item.timestamp),
        })
      }
      continue
    }
    if (item.role === "tool" && "details" in item) {
      const assistant = messages[messages.length - 1]
      if (assistant?.role === "assistant") {
        const calls = assistant.toolCalls ?? []
        const index = calls.findIndex(call => item.tool_call_id ? call.id === item.tool_call_id : call.tool === item.tool && call.status === "unknown")
        const summary = toolCallSummary(item.details, item.is_error)
        const call: ToolCallDisplay = {
          id: item.tool_call_id || calls[index]?.id || createId(), tool: item.tool,
          status: item.is_error || summary?.failed ? "error" : "done", elapsedMs: item.elapsed_ms,
          summary, label: toolCallLabel(item.tool, item.details),
        }
        if (index >= 0) calls[index] = call
        else calls.push(call)
        assistant.toolCalls = calls
        // 历史只保存当时发布的题目/回执快照；当前 open 状态由 detail.question_states 单独恢复。
        Object.assign(assistant, withQuestionFeedback(assistant, item.details))
      }
      if (assistant?.role !== "assistant") continue
      Object.assign(assistant, applyChatToolResult(assistant, item.details))
      // 历史澄清保持只读；当前待回答状态由会话快照恢复。
      if (assistant.metricAskClarification) {
        const clarification = assistant.metricAskClarification
        assistant.response = archiveClarificationResponse(clarificationResponse(
          clarification, assistant.metricAskClarificationPrompt ?? clarification.prompt,
        ))
        assistant.content = assistant.response?.answer ?? assistant.content
      }
    }
  }
  const last = messages[messages.length - 1]
  if (last?.metricAskClarification && !detail.running && !detail.legacy) {
    last.clarification = last.metricAskClarification
    last.response = clarificationResponse(last.clarification, last.clarification.prompt)
  }
  // 结果表在最终助手文本合并完成后再构造，保证回答与表格一致。
  return {
    messages: messages.map((item) => {
      if (item.role !== "assistant") return item
      if (!item.metricAskDetails) return item.response ? item : finalizeAssistantMessage(item)
      const details = item.metricAskDetails
      const { metricAskDetails, ...rest } = item
      void metricAskDetails
      return details.status === "succeeded"
        ? { ...rest, response: responseFromMetricAsk(details, item.content) }
        : { ...rest, content: (item.answerDelivered || item.nativeAnswer) ? item.content : governedReply(details) ?? item.content }
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
        preview: item.preview ?? item.title ?? "尚未开始",
        messages: [],
        loaded: false,
        persisted: true,
        running: item.running,
        legacy: item.legacy === true,
        createdAt: item.created_at,
        lastActiveAt: item.last_active_at,
        questionStates: [],
      }))
      .sort((left, right) => new Date(right.lastActiveAt ?? 0).getTime() - new Date(left.lastActiveAt ?? 0).getTime())
    // 列表没有正文；保留本地当前会话，避免再次激活把已加载消息或未发送草稿覆盖为空。
    conversations.value = currentActive
      ? [currentActive, ...loadedHistory.filter(item => item.id !== currentActive.id)]
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
  const expectedUserId = auth.user.value?.id ?? null
  const requestVersion = historyLoadVersion
  const selectionIsCurrent = () => requestVersion === historyLoadVersion
    && auth.user.value?.id === expectedUserId && activeConversationId.value === conversationId
  autoOpenClarificationId.value = undefined
  activeConversationId.value = conversationId
  persistActiveConversation()
  const conversation = conversations.value.find((item) => item.id === conversationId)
  if (!conversation || conversation.loaded || !conversation.serverId) {
    if (conversation?.running && conversation.serverId) void reconnectConversation(conversationId)
    scrollToBottom()
    return
  }
  isConversationLoading.value = true
  historyError.value = ""
  try {
    const detail = await getAgentSession(conversation.serverId)
    if (!selectionIsCurrent()) return
    const loaded: DisplayConversation = {
      ...conversation,
      loaded: true,
      running: detail.running,
      activeOperationId: detail.operation_id ?? null,
      legacy: detail.legacy === true ? true : conversation.legacy,
      messages: conversationFromDetail(detail).messages,
      questionStates: detail.question_states ?? [],
    }
    // 双击会同时触发打开历史；较早发出的详情响应不能覆盖随后已保存的新名称。
    const latest = conversations.value.find(item => item.id === conversationId)
    loaded.title = latest && latest.title !== conversation.title ? latest.title
      : titleOverrides.value[loaded.serverId ?? ""] ?? detail.title ?? conversationTitle(loaded.serverId, loaded.messages)
    const lastAssistant = [...loaded.messages].reverse().find((item) => item.role === "assistant")
    loaded.preview = detail.preview ?? lastAssistant?.content ?? loaded.preview
    conversations.value = conversations.value.map((item) => item.id === conversationId ? loaded : item)
    scrollToBottom()
    // 历史会话的结果表同样只从后端快照回填
    void hydrateResultTables(conversationId)
    if (detail.running) void reconnectConversation(conversationId)
  } catch (error) {
    if (!selectionIsCurrent()) return
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
    if (selectionIsCurrent()) isConversationLoading.value = false
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

/** 历史会话滚动到底部附近时自动加载下一批，替代手动点击“显示更多”。 */
function onHistoryScroll(event: Event) {
  const container = event.currentTarget as HTMLElement
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 48) showMoreConversations()
}

function openRenameConversation(conversation: DisplayConversation, source: "list" | "header" = "list") {
  conversationMenuId.value = ""
  management.openRename(conversation, source)
}

function openDeleteConversations(targets: DisplayConversation[]) {
  conversationMenuId.value = ""
  management.openDelete(targets)
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
  const index = conversations.value.findIndex(conversation => conversation.id === conversationId)
  const previous = conversations.value[index]
  if (!previous) return false
  const updated = updater(previous)
  if (updated === previous) return false
  conversations.value = conversations.value.map((conversation, itemIndex) => itemIndex === index ? updated : conversation)
  return true
}

function questionForMessage(chatMessage: DisplayMessage) {
  const messages = activeConversation.value?.messages ?? []
  const index = messages.findIndex((item) => item.id === chatMessage.id)
  return [...messages.slice(0, index)].reverse().find((item) => item.role === "user")?.content ?? ""
}

function updateAssistantMessage(conversationId: string, messageId: string, updater: (message: DisplayMessage) => DisplayMessage) {
  return updateConversation(conversationId, (conversation) => {
    const index = conversation.messages.findIndex(item => item.id === messageId)
    const previous = conversation.messages[index]
    if (!previous) return conversation
    const updated = updater(previous)
    if (updated === previous) return conversation
    const messages = conversation.messages.slice()
    messages[index] = updated
    return { ...conversation, messages }
  })
}

function markConversationSending(conversationId: string, sending: boolean) {
  const next = new Set(sendingConversationIds.value)
  if (sending) next.add(conversationId)
  else next.delete(conversationId)
  sendingConversationIds.value = next
}

function openEmptyDraft() {
  const conversation = createConversation()
  conversations.value = [
    conversation,
    ...conversations.value.filter((item) => item.persisted || item.messages.length > 0),
  ]
  activeConversationId.value = conversation.id
  isConversationLoading.value = false
  message.value = ""
  historyError.value = ""
  scrollToBottom()
}

function handleNewConversation() {
  openEmptyDraft()
  // 初始化草稿保留恢复指针；只有用户主动新建才立即撤销，防止迟到列表恢复旧焦点。
  persistActiveConversation()
}

function handleSubmit(text: string, entities: ComposerEntity[] = []) {
  if (isDeletingConversation.value) return
  if (!queryReady.value) return
  // 正文用于展示；目录编码与澄清标识独立传递，由服务端绑定当前任务。
  const label = composeQuestion(text, entities)
  if (!activeConversation.value) handleNewConversation()
  const conversation = activeConversation.value
  if (!conversation || !label || activeConversationIsSending.value || conversation.running) return
  if (conversation.legacy) return
  const activeCard = activeClarificationMessage.value
  const selectedAnswer = activeCard?.clarification && activeCard.clarificationTarget
    ? selectedClarificationAnswer(text, entities, activeCard.clarification) : undefined
  const clarificationMessage = selectedAnswer ? activeCard : undefined
  const kind = clarificationMessage ? "clarification_answer" : "question"
  const input: AgentPromptInput = {
    // request_id 每次确认发送生成；网络重试沿用同一值，不产生第二条用户消息
    request_id: createId(),
    message: label,
  }
  if (clarificationMessage) {
    // 先取卡片目标与结构化选择，再归档（归档生成新对象，不影响已取到的引用）
    if (clarificationMessage.clarificationTarget) {
      input.clarification_target = clarificationMessage.clarificationTarget
    }
    if (selectedAnswer) input.selected_answers = selectedAnswer
    // 澄清一经回答即归档为只读记录，仅最新待补充消息可交互。
    updateAssistantMessage(conversation.id, clarificationMessage.id, (item) => ({
      ...item,
      clarification: undefined,
      response: archiveClarificationResponse(item.response),
    }))
  }
  message.value = ""
  void runQuestion(conversation.id, label, kind, input)
}

async function runQuestion(conversationId: string, question: string, kind: string, input: AgentPromptInput) {
  if (!queryReady.value) return
  const assistantId = createId()
  const startedAt = performance.now()
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    title: conversation.messages.length || conversation.title !== "新的问数会话" ? conversation.title : question.slice(0, 24),
    preview: question || conversation.preview,
    messages: [
      ...conversation.messages,
      { id: createId(), role: "user" as const, content: question, kind, createdAt: new Date().toISOString() },
      { id: assistantId, role: "assistant", content: "", nativeAnswer: true, createdAt: new Date().toISOString(), status: "pending", toolCalls: [] },
    ],
    createdAt: conversation.createdAt ?? new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }))
  markConversationSending(conversationId, true)
  const controller = new AbortController()
  abortControllers.set(conversationId, controller)
  pendingPrompts.set(conversationId, {requestId: input.request_id})
  scrollToBottom()
  try {
    const serverId = await ensureServerSession(conversationId)
    if (controller.signal.aborted) throw new DOMException("已停止生成", "AbortError")
    await streamPrompt(conversationId, serverId, input, assistantId, controller)
  } catch (error) {
    const cancelFailure = pendingPrompts.get(conversationId)?.cancelFailure
    // 404 不自动新建会话并重发：输入保留在消息里，由用户决定下一步
    if (cancelFailure) failMessage(conversationId, assistantId, cancelFailure)
    else if (error instanceof AgentApiError && error.message.includes("QUESTION_SUPERSEDED")) {
      await selectConversation(conversationId)
    } else if (error instanceof AgentApiError && (error.status === 0 || error.status === 409)) {
      await reconnectConversation(conversationId, assistantId, controller)
    } else failMessage(conversationId, assistantId, error)
  } finally {
    // 兜底：流正常结束但没有 run_terminal（服务端 drive 挂起/响应被截断）时，
    // 消息会永久停在 pending。此处按中断收尾，保证用户总能得到明确结果并可重试。
    const stuck = conversations.value
      .find((item) => item.id === conversationId)
      ?.messages.find((item) => item.id === assistantId)
    if (stuck?.status === "pending") {
      failMessage(conversationId, assistantId, new AgentApiError("智能助手长时间没有响应，本次提问未完成。", 0))
    }
    updateAssistantMessage(conversationId, assistantId, (item) => ({ ...item, elapsedMs: performance.now() - startedAt }))
    abortControllers.delete(conversationId)
    pendingPrompts.delete(conversationId)
    markConversationSending(conversationId, false)
    persistActiveConversation()
    scrollToBottom(false, conversationId)
  }
}

/** 草稿会话在首次发送时创建服务端会话，并沿用首个问题作为默认标题。 */
async function ensureServerSession(conversationId: string) {
  const conversation = conversations.value.find((item) => item.id === conversationId)
  let serverId = conversation?.serverId
  if (!serverId) {
    const created = await createAgentSession()
    serverId = created.session_id
    updateConversation(conversationId, (item) => ({ ...item, serverId: created.session_id, persisted: true, createdAt: created.created_at }))
  }
  // 草稿和旧版本浏览器覆盖标题，在取得正式会话身份后迁移到同一原生名称。
  const customTitle = titleOverrides.value[conversationId] ?? titleOverrides.value[serverId]
  if (customTitle) {
    await renameAgentSession(serverId, customTitle)
    const next = { ...titleOverrides.value }
    delete next[conversationId]
    delete next[serverId]
    titleOverrides.value = next
    persistTitleOverrides()
  }
  persistActiveConversation()
  return serverId
}

async function streamPrompt(conversationId: string, serverId: string, input: AgentPromptInput, assistantId: string, controller: AbortController) {
  await promptAgentSession(serverId, input, {
    signal: controller.signal,
    onEvent: (event) => handleStreamEvent(conversationId, assistantId, event),
  })
}

function handleStreamEvent(conversationId: string, assistantId: string, event: AgentStreamEvent) {
  if (presentationDisposed) return
  if (event.type === "answer_delta") {
    answerFrames.enqueue(conversationId, assistantId, event)
    return
  }
  // 撤回、快照与正式交付必须越过帧队列，不能被迟到的预览覆盖。
  if (event.type !== "activity" && event.type !== "progress") answerFrames.flush(conversationId, assistantId)
  if (event.type === "tool_end") {
    const expanded = expandSemanticResultDetails(event.details)
    if (expanded) {
      for (const details of expanded) handleStreamEvent(conversationId, assistantId, {...event, details})
      return
    }
    applyRealtimeQuestionFeedback(conversationId, assistantId, event.details)
  }
  if (event.type === "answer_reset") {
    updateAssistantMessage(conversationId, assistantId, item => applyProvisionalAnswer(item, event))
    scrollToBottom(false, conversationId)
    return
  }
  if (event.type === "error") {
    throw new AgentApiError(event.message?.trim() || "智能助手处理失败，请稍后重试。", 0)
  }
  if (event.type === "snapshot") {
    applyAgentSnapshot(conversationId, event, assistantId)
    return
  }
  if (event.type === "accepted") {
    if (event.snapshot) applyAgentSnapshot(conversationId, event.snapshot, assistantId)
    // operation 用于停止；accepted 与重连共用完整快照。
    if (event.operation_id) {
      updateConversation(conversationId, (item) => ({ ...item, activeOperationId: event.operation_id ?? null }))
    }
    return
  }
  if (event.type === "progress") {
    // 心跳只表示服务端仍在执行，不改状态；用于刷新已等待时长。
    if (typeof event.elapsed_ms === "number") {
      updateAssistantMessage(conversationId, assistantId, (item) => ({ ...item, elapsedMs: event.elapsed_ms }))
    }
    return
  }
  if (event.type === "activity") {
    updateAssistantMessage(conversationId, assistantId, (item) => {
      const activities = [...(item.activities ?? [])]
      const index = activities.findIndex(activity => activity.id === event.activity_id)
      const previous = index >= 0 ? activities[index] : undefined
      const startedAt = previous?.startedAt ?? Date.now()
      const note = event.note?.trim()
      const next: ActivityDisplay = {
        id: event.activity_id, label: event.label, status: event.status, startedAt,
        ...(event.status === "done" ? { elapsedMs: Date.now() - startedAt } : {}),
        ...(note || event.conditions?.length ? { summary: { ...(note ? { note } : {}), ...(event.conditions?.length ? { conditions: event.conditions } : {}) } } : {}),
      }
      if (index >= 0) activities[index] = next
      else activities.push(next)
      return { ...item, activities }
    })
    return
  }
  if (event.type === "run_terminal") {
    const failed = event.run_status !== "aborted" && !["ok", "idle"].includes(event.answer_status)
    updateAssistantMessage(conversationId, assistantId, (item) => {
      let finalized = finalizeAssistantMessage({ ...clearProvisionalAnswer(item), status: failed || item.failureNotice ? "error" : "done" })
      // 快照中的失败说明已是本轮正式展示内容，终态事件只补充缺失的提示。
      if (failed) {
        finalized = withFailureNotice(finalized, friendlyQueryError(event.error_message ?? null, event.error_code ?? null))
      }
      return {
        ...finalized,
        runTimings: event.timings_ms ?? item.runTimings,
        toolCalls: item.toolCalls?.map((call) => call.status === "running" ? { ...call, status: "done" } : call),
        activities: item.activities?.map((activity) => activity.status === "running" ? { ...activity, status: "done" as const } : activity),
      }
    })
    const finished = conversations.value
      .find((item) => item.id === conversationId)
      ?.messages.find((item) => item.id === assistantId)
    if (finished?.clarification && activeConversationId.value === conversationId) {
      autoOpenClarificationId.value = finished.clarification.id
    }
    updateConversation(conversationId, (item) => ({ ...item, preview: finished?.content ?? item.preview, running: false, activeOperationId: null }))
    void hydrateResultTables(conversationId)
    scrollToBottom(false, conversationId)
    return
  }
  updateAssistantMessage(conversationId, assistantId, (item) => {
    if (event.type === "text_delta") {
      // 工具轮次前的纯空白增量不累积，避免气泡开头出现大片空行
      if (!item.content.trim() && !event.delta.trim()) return item
      return { ...item, answerStreaming: true, content: item.content + event.delta }
    }
    if (event.type === "message_done") return { ...clearProvisionalAnswer(item), answerStreaming: false, content: event.text || item.content }
    if (event.type === "tool_start") {
      return { ...item, answerStreaming: false, toolCalls: [...(item.toolCalls ?? []), { id: event.tool_call_id || createId(), tool: event.tool, status: "running" as const, startedAt: Date.now() }] }
    }
    // tool_end：结束对应进度，记录 metric_ask 明细供收尾时构造结果表或澄清卡片。
    const toolCalls = [...(item.toolCalls ?? [])]
    const targetIndex = toolCalls.findIndex(call => event.tool_call_id ? call.id === event.tool_call_id : call.tool === event.tool && call.status === "running")
    const summary = toolCallSummary(event.details, event.isError)
    const ended = {
      status: event.isError || summary?.failed ? "error" as const : "done" as const,
      summary, label: toolCallLabel(event.tool, event.details),
    }
    if (targetIndex >= 0) {
      const started = toolCalls[targetIndex]!
      toolCalls[targetIndex] = { ...started, ...ended, ...(started.startedAt ? { elapsedMs: Date.now() - started.startedAt } : {}) }
    } else {
      toolCalls.push({ id: event.tool_call_id || createId(), tool: event.tool, ...ended })
    }
    const updated = applyChatToolResult({ ...item, toolCalls }, event.details)
    return updated.metricAskDetails !== item.metricAskDetails
      ? finalizeAssistantMessage(updated) : updated
  })
  if (event.type === "tool_end") void hydrateResultTables(conversationId)
  scrollToBottom(false, conversationId)
}

function applyAgentSnapshot(conversationId: string, snapshot: AgentSnapshot, assistantId?: string) {
  updateConversation(conversationId, item => {
    const detail: AgentSessionDetail = { session_id: item.serverId ?? item.id, created_at: item.createdAt ?? "", ...snapshot }
    const restored = conversationFromDetail(detail).messages
    // 持久历史未变化时保留组件身份，避免重连重建图表、折叠项和阅读位置。
    for (const [index, message] of restored.entries()) {
      const previous = item.messages[index]
      if (previous?.role === message.role && previous.content === message.content) message.id = previous.id
    }
    const last = restored[restored.length - 1]
    if (snapshot.running && last?.role !== "assistant") {
      // accepted 快照整体替换消息列表，重建待答气泡时必须保留本地协议标记：
      // 丢失 nativeAnswer 会让工具回执的确定性答案提前填进气泡，与模型最终正文形成“两次回答”。
      const localPending = assistantId ? item.messages.find(message => message.id === assistantId) : undefined
      restored.push({
        id: assistantId ?? createId(), role: "assistant", content: "", status: "pending", toolCalls: [],
        nativeAnswer: localPending?.nativeAnswer ?? true,
        ...(localPending?.createdAt ? { createdAt: localPending.createdAt } : {}),
      })
    }
    const assistant = restored[restored.length - 1]
    if (assistant?.role === "assistant" && assistantId) {
      assistant.id = assistantId
      // 快照不含理解阶段步骤，替换消息时保留本轮已收到的播报。
      const localAnswer = item.messages.find(message => message.id === assistantId)
      if (localAnswer?.activities?.length) assistant.activities = localAnswer.activities
      restored[restored.length - 1] = reconcileAnswerSnapshot(assistant, localAnswer, {
        running: snapshot.running,
        operationId: snapshot.operation_id,
        previousOperationId: item.activeOperationId,
        stream: snapshot.answer_stream,
      })
    }
    for (const message of restored) {
      const taskId = message.response?.debug?.task_id
      const cached = item.messages.find(old => taskId && old.response?.debug?.task_id === taskId && old.response?.result)
      if (message.response && cached?.response?.result) message.response.result = cached.response.result
      // 已点选归档的口径 chips 只保留在本地；快照整体重建后按 task_id 恢复归档状态，避免旧卡片复活可点。
      const local = item.messages.find(old => taskId && old.response?.debug?.task_id === taskId)
      if (message.response?.time_variants?.length && local?.status === "done" && local.response && !local.response.time_variants?.length) {
        message.response = archiveTimeVariantsResponse(message.response)
      }
    }
    return {
      ...item,
      loaded: true,
      running: snapshot.running,
      activeOperationId: snapshot.operation_id,
      messages: restored,
      questionStates: snapshot.question_states ?? [],
    }
  })
  void hydrateResultTables(conversationId)
}

async function reconnectConversation(conversationId: string, assistantId?: string, existingController?: AbortController) {
  const conversation = conversations.value.find(item => item.id === conversationId)
  if (!conversation?.serverId || (!existingController && abortControllers.has(conversationId))) return
  const controller = existingController ?? new AbortController()
  abortControllers.set(conversationId, controller)
  markConversationSending(conversationId, true)
  try {
    // 仅重新观察原 operation，不重发用户输入；重连失败有限结束并保留运行状态。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await observeAgentSession(conversation.serverId, {
          signal: controller.signal,
          onEvent: event => {
            const current = conversations.value.find(item => item.id === conversationId)
            const last = current?.messages[current.messages.length - 1]
            // 新一轮尚未落盘助手消息时，不得复用上一轮气泡的身份。
            const id = assistantId ?? (last?.role === "assistant" ? last.id : createId())
            handleStreamEvent(conversationId, id, event)
          },
        })
        return
      } catch (error) {
        if (isAgentAbortError(error) || !(error instanceof AgentApiError) || error.status !== 0) throw error
        if (attempt === 2) throw error
        await new Promise(resolve => window.setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
  } catch (error) {
    if (!isAgentAbortError(error)) historyError.value = "连接暂时中断，后台任务可能仍在执行。重新打开此会话可继续查看。"
  } finally {
    if (!existingController) {
      abortControllers.delete(conversationId)
      markConversationSending(conversationId, false)
    }
  }
}

function failMessage(conversationId: string, messageId: string, error: unknown) {
  answerFrames.flush(conversationId, messageId)
  const aborted = isAgentAbortError(error)
  const content = aborted
    ? "已停止生成。"
    : friendlyQueryError(error instanceof Error ? error.message : null)
  updateAssistantMessage(conversationId, messageId, (item) => {
    let finalized = finalizeAssistantMessage({ ...clearProvisionalAnswer(item), status: aborted ? "done" : "error" })
    if (!aborted) finalized = withFailureNotice(finalized, content)
    const answer = finalized.content || content
    return {
      ...finalized,
      content: answer,
      // 已有结果表时仍显示末轮模型失败提示，不能被结构化 response 遮住。
      response: finalized.response ? { ...finalized.response, answer } : undefined,
      status: aborted ? "done" : "error",
      toolCalls: finalized.toolCalls?.map((call) => call.status === "running" ? { ...call, status: "interrupted" } : call),
    }
  })
  updateConversation(conversationId, (conversation) => ({ ...conversation, preview: content, running: false }))
}

/** 结果表数据只从后端不可变快照读取：工具明细只带引用，行数据按 task_id 拉取后回填。 */
const resultLoads = new Map<string, ReturnType<typeof getBackendTaskResult>>()

async function hydrateResultTables(conversationId: string) {
  const conversation = conversations.value.find((item) => item.id === conversationId)
  if (!conversation) return
  for (const chatMessage of conversation.messages) {
    const response = chatMessage.response
    const taskId = typeof response?.debug?.task_id === "string" ? response.debug.task_id : null
    const rowCount = typeof response?.debug?.row_count === "number" ? response.debug.row_count : 0
    if (!taskId || !response || response.result || rowCount <= 0 || rowCount > 100) continue
    try {
      let pending = resultLoads.get(taskId)
      if (!pending) {
        pending = getBackendTaskResult(taskId, 0, 100)
        resultLoads.set(taskId, pending)
        void pending.finally(() => resultLoads.delete(taskId)).catch(() => {})
      }
      const page = await pending
      updateAssistantMessage(conversationId, chatMessage.id, (item) => {
        if (!item.response || item.response.result) return item
        return {
          ...item,
          response: {
            ...item.response,
            result: { type: "metric_query", table: { columns: page.columns, rows: page.rows } },
          },
        }
      })
    } catch {
      // 结果拉取失败不阻断正文；用户可通过导出或重新提问获取明细
    }
  }
  // 复合任务逐项回填正式快照，不能只恢复最后一个目标的表格。
  for (const chatMessage of conversation.messages) for (const result of chatMessage.queryResults ?? []) {
    if (!result.task_id || result.rows || !result.row_count || result.row_count > 100) continue
    try {
      const page = await getBackendTaskResult(result.task_id, 0, 100)
      updateAssistantMessage(conversationId, chatMessage.id, item => ({...item, queryResults: item.queryResults?.map(previous =>
        previous.task_id === result.task_id ? {...previous, rows: page.rows, columns: page.columns} : previous)}))
    } catch { /* 保留可核验正文及独立目标身份，读取失败不伪造空表。 */ }
  }
}

/** 显式停止：先取消原生 operation（服务端停止执行），再断开本地观察。 */
async function stopActiveConversation() {
  const conversation = activeConversation.value
  if (!conversation || !activeConversationIsSending.value) return
  const operationId = conversation.activeOperationId
  const pending = pendingPrompts.get(conversation.id)
  if (conversation.serverId && (pending || operationId)) {
    try {
      if (pending) await cancelAgentRequest(conversation.serverId, pending.requestId)
      else await cancelAgentOperation(conversation.serverId, operationId!)
    } catch {
      // 停止观察不代表后台已取消；保留未确认状态，不能交付“已停止”的成功说明。
      const notice = "停止请求尚未确认，后台任务可能仍在执行，请重新打开会话核对状态。"
      if (pending) pending.cancelFailure = new Error(notice)
      else historyError.value = notice
    }
  }
  abortControllers.get(conversation.id)?.abort()
}

function scrollToBottom(force = true, conversationId = activeConversationId.value) {
  if (!presentationDisposed && conversationId === activeConversationId.value) scrollFollow.request(force)
}

function pendingAnswer(chatMessage: DisplayMessage): string | undefined {
  if (chatMessage.provisionalContent) return chatMessage.provisionalContent
  if (!chatMessage.content || (chatMessage.availability?.length && !chatMessage.metricAskDetails)) return undefined
  return chatMessage.nativeAnswer ? chatMessage.content
    : chatMessage.metricAskClarificationPrompt ?? chatMessage.metricAskClarification?.prompt
      ?? governedReply(chatMessage.metricAskDetails) ?? chatMessage.content
}
</script>

<template>
  <section ref="panelRoot" class="grid min-h-0 flex-1 overflow-hidden border-x border-b bg-background" :class="isHistoryCollapsed ? 'grid-cols-[44px_minmax(0,1fr)] grid-rows-1' : 'grid-rows-[minmax(0,18rem)_minmax(0,1fr)] sm:grid-cols-[260px_minmax(0,1fr)] sm:grid-rows-1 lg:grid-cols-[300px_minmax(0,1fr)]'">
    <aside v-if="!isHistoryCollapsed" class="flex min-h-0 flex-col border-b bg-muted/30 sm:border-r sm:border-b-0">
      <div class="flex h-[var(--workspace-header-height)] shrink-0 items-center gap-2 border-b px-3">
        <BaseButton variant="outline" class="min-w-0 flex-1 justify-start border-border/70 bg-background/70 text-foreground shadow-none hover:bg-muted/70" :disabled="isDeletingConversation" @click="handleNewConversation"><Plus />新建对话</BaseButton>
        <BaseButton data-conversation-manage variant="ghost" :disabled="isHistoryLoading || isDeletingConversation || isRenaming" :aria-pressed="isManagingConversations" @click="management.setManaging(!isManagingConversations)">{{ isManagingConversations ? '完成' : '管理' }}</BaseButton>
        <BaseTooltip content="收起历史对话"><BaseButton variant="ghost" size="icon" class="shrink-0 text-muted-foreground" aria-label="收起历史对话" @click="isHistoryCollapsed = true"><PanelLeftClose /></BaseButton></BaseTooltip>
      </div>
      <template v-if="isManagingConversations">
        <div class="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 text-xs">
          <label class="flex items-center gap-2"><BaseCheckbox :model-value="allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false" :disabled="!visibleDeletableConversations.length || isDeletingConversation" aria-label="全选已加载会话" @update:model-value="management.selectVisible" />全选已加载</label>
          <span class="text-muted-foreground">{{ visibleConversations.length }} / {{ sortedConversations.length }}</span>
        </div>
        <div v-if="allVisibleSelected && deletableConversations.length > visibleDeletableConversations.length" class="shrink-0 space-y-1 border-b bg-muted/40 px-3 py-2 text-xs">
          <p class="text-muted-foreground">{{ allSelected ? `已选择全部 ${selectedConversations.length} 个可删除会话` : `已选择已加载中的 ${selectedConversations.length} 个会话` }}</p>
          <BaseButton variant="link" size="sm" :disabled="isDeletingConversation" @click="management.selectAll">{{ allSelected ? '清除全部选择' : `选择全部 ${deletableConversations.length} 个可删除会话` }}</BaseButton>
        </div>
      </template>
      <div class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2.5 py-2 [scrollbar-gutter:stable]" @scroll="onHistoryScroll">
        <LoadingSkeleton v-if="isHistoryLoading" :rows="3" row-class="h-14" />
        <div v-else class="flex flex-col gap-1.5">
          <div v-for="conversation in visibleConversations" :key="conversation.id" class="group/history flex min-h-[82px] w-full min-w-0 shrink-0 items-start gap-1.5 rounded-xl border border-border/70 bg-background px-2.5 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-muted-foreground/35 hover:bg-background" :class="(isManagingConversations ? selectedConversationIds.has(conversation.id) : conversation.id === activeConversation?.id) && 'border-primary/35 bg-primary/[0.025] ring-1 ring-primary/10'">
            <BaseCheckbox v-if="isManagingConversations" class="mt-1" :model-value="selectedConversationIds.has(conversation.id) && management.canDelete(conversation)" :disabled="!management.canDelete(conversation) || isDeletingConversation" :aria-label="`选择会话：${conversation.title}`" @update:model-value="management.toggleSelected(conversation, $event)" />
            <ConversationRenameField v-if="renameTargetId === conversation.id && renameSource === 'list'" :title="conversation.title" :busy="isRenaming" :error="renameError" @save="management.saveRename" @cancel="management.cancelRename" />
            <BaseTooltip v-else :content="`${conversation.title} · ${formatConversationDate(conversation.createdAt)}`"><button type="button" class="min-w-0 flex-1 px-1 text-left text-sm" :data-conversation-open="conversation.id" :disabled="isDeletingConversation || (isManagingConversations && !management.canDelete(conversation))" @click="isManagingConversations ? management.toggleSelected(conversation, !selectedConversationIds.has(conversation.id)) : selectConversation(conversation.id)" @keydown.f2.prevent="openRenameConversation(conversation)">
              <span class="flex items-center gap-1.5"><span class="line-clamp-1 min-w-0 flex-1 font-medium" @dblclick.stop="!isManagingConversations && openRenameConversation(conversation)">{{ conversation.title }}</span><span v-if="conversation.legacy" class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">旧会话</span><LoaderCircle v-if="sendingConversationIds.has(conversation.id) || conversation.running" class="size-3.5 animate-spin" /></span>
              <span class="mt-0.5 block h-4 truncate text-xs text-muted-foreground">{{ conversation.preview || conversation.title }}</span>
              <span class="mt-1.5 block text-[11px] text-muted-foreground/80">{{ formatConversationDate(conversation.createdAt) }}</span>
            </button></BaseTooltip>
            <PopoverRoot v-if="!conversation.legacy && !isManagingConversations && renameTargetId !== conversation.id" :open="conversationMenuId === conversation.id" @update:open="conversationMenuId = $event ? conversation.id : ''">
              <PopoverTrigger as-child><BaseTooltip content="会话操作">
                <BaseButton variant="ghost" size="icon" class="size-7 shrink-0 text-muted-foreground" :disabled="isDeletingConversation || isRenaming" :aria-label="`会话操作：${conversation.title}`"><Ellipsis /></BaseButton>
              </BaseTooltip></PopoverTrigger>
              <PopoverPortal>
                <PopoverContent side="right" :side-offset="6" align="start" class="z-50 w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg" @close-auto-focus="(event) => { if (renameTargetId || deleteOpen) event.preventDefault() }">
                  <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm hover:bg-muted" @click="openRenameConversation(conversation)"><Pencil class="size-3.5" />修改名称</button>
                  <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50" :disabled="!management.canDelete(conversation)" @click="openDeleteConversations([conversation])"><Trash2 class="size-3.5" />删除会话</button>
                  <p v-if="!management.canDelete(conversation)" class="border-t px-2.5 py-2 text-xs text-muted-foreground">正在分析，停止后可删除</p>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
          </div>
          <p v-if="isHistoryLoadingMore" class="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" />正在加载更多会话…</p>
        </div>
      </div>
      <div v-if="isManagingConversations" class="shrink-0 space-y-2 border-t bg-background p-3">
        <p class="text-xs text-muted-foreground" role="status" aria-live="polite">已选择 {{ selectedConversations.length }} 个会话 · 排除分析中和只读会话</p>
        <div class="flex gap-2"><BaseButton variant="outline" :disabled="isDeletingConversation" @click="management.setManaging(false)">取消</BaseButton><BaseButton variant="destructive" class="min-w-0 flex-1" :disabled="!selectedConversations.length || isDeletingConversation" @click="openDeleteConversations(selectedConversations)"><Trash2 />删除已选（{{ selectedConversations.length }}）</BaseButton></div>
      </div>
    </aside>
    <aside v-else class="flex min-h-0 flex-col border-r bg-muted/30">
      <div class="flex h-[var(--workspace-header-height)] shrink-0 items-center justify-center border-b">
      <BaseTooltip content="展开历史对话"><BaseButton variant="ghost" size="icon" class="text-muted-foreground" aria-label="展开历史对话" @click="isHistoryCollapsed = false"><PanelLeftOpen /></BaseButton></BaseTooltip>
      </div>
    </aside>

    <div class="flex min-h-0 min-w-0 flex-col">
      <header class="flex min-h-[var(--workspace-header-height)] shrink-0 items-center gap-2 border-b px-4 py-2">
        <ConversationRenameField v-if="activeConversation && renameTargetId === activeConversation.id && renameSource === 'header'" :title="activeConversation.title" :busy="isRenaming" :error="renameError" @save="management.saveRename" @cancel="management.cancelRename" />
        <template v-else><h1 class="min-w-0 text-base font-semibold"><BaseTooltip :content="`${activeConversation?.title ?? '指标问数'} · 双击修改名称`"><button ref="headerTitle" type="button" class="max-w-full truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" :disabled="!activeConversation || activeConversation.legacy || isDeletingConversation || isRenaming" aria-label="当前会话名称" @dblclick="activeConversation && openRenameConversation(activeConversation, 'header')" @keydown.f2.prevent="activeConversation && openRenameConversation(activeConversation, 'header')">{{ activeConversation?.title ?? "指标问数" }}</button></BaseTooltip></h1></template>
      </header>

      <div ref="messagesScroll" class="min-h-0 flex-1 overflow-y-auto bg-muted/20 px-4 py-5" @scroll="scrollFollow.onScroll">
        <BaseAlert v-if="historyError" class="mx-auto mb-4 max-w-4xl" title="任务操作失败" variant="destructive">{{ historyError }}</BaseAlert>
        <LoadingSkeleton v-if="isConversationLoading" class="mx-auto max-w-4xl" :rows="4" row-class="h-20" />
        <div v-else-if="activeConversation?.messages.length" class="flex w-full flex-col gap-5">
          <div v-for="chatMessage in activeConversation.messages" :key="chatMessage.id" class="flex w-full gap-3" :class="chatMessage.role === 'user' ? 'justify-end' : 'justify-start'">
            <div class="min-w-0" :class="chatMessage.role === 'user' ? 'group/user max-w-[min(760px,78%)]' : 'flex w-full max-w-none flex-1 flex-col gap-2'">
              <template v-if="chatMessage.role === 'user'">
                <div class="rounded-2xl rounded-br-md border border-border/70 bg-muted/65 px-4 py-3 text-sm text-foreground shadow-none"><p class="whitespace-pre-wrap break-words leading-6">{{ chatMessage.content }}</p></div>
                <div class="flex justify-end opacity-0 transition-opacity group-hover/user:opacity-100 group-focus-within/user:opacity-100">
                  <BaseTooltip :content="copiedMessageId === chatMessage.id ? '已复制' : '复制'"><BaseButton variant="ghost" size="icon" class="size-7 text-muted-foreground" :aria-label="copiedMessageId === chatMessage.id ? '已复制' : '复制问题'" @click="copyUserQuestion(chatMessage)">
                    <Check v-if="copiedMessageId === chatMessage.id" class="size-3.5 text-emerald-600" />
                    <Copy v-else class="size-3.5" />
                  </BaseButton></BaseTooltip>
                </div>
              </template>
              <template v-else>
                <div class="group/assistant relative min-w-0 px-1 text-sm">
                <div class="mb-2 flex min-h-9 items-center gap-2 pr-20" role="status" aria-live="polite">
                  <span class="flex size-9 items-center justify-center rounded-xl bg-muted/40 text-foreground" aria-label="智能问数助手"><Bot class="size-4.5" /></span>
                  <time v-if="formatMessageTime(chatMessage.createdAt)" :datetime="chatMessage.createdAt" class="text-xs text-muted-foreground">{{ formatMessageTime(chatMessage.createdAt) }}</time>
                  <template v-if="executionStatus(chatMessage).kind !== 'running' && executionStatus(chatMessage).kind !== 'success'">
                    <span v-if="formatMessageTime(chatMessage.createdAt)" class="text-muted-foreground/30">·</span>
                    <AlertTriangle v-if="executionStatus(chatMessage).kind === 'failed'" class="size-3.5 text-muted-foreground" />
                    <MessageCircleQuestion v-else-if="executionStatus(chatMessage).kind === 'waiting'" class="size-3.5 text-muted-foreground" />
                    <span class="text-xs" :class="executionStatus(chatMessage).titleClass">{{ executionStatus(chatMessage).title }}</span>
                  </template>
                </div>
                <AgentMessageDiagnostics :question="questionForMessage(chatMessage)" :task-ids="chatMessage.taskIds ?? []" :pending="chatMessage.status === 'pending'" :has-answer="Boolean(chatMessage.provisionalContent || chatMessage.answerStreaming)" :started-at="chatMessage.createdAt" :elapsed-ms="chatMessage.elapsedMs" :tools="chatMessage.toolCalls ?? []" :activities="chatMessage.activities ?? []" :run-timings="chatMessage.runTimings" />
                <div v-if="chatMessage.status === 'pending' && chatMessage.response?.result" class="mt-2">
                  <p class="mb-2 text-xs text-muted-foreground">已取得步骤结果，正在继续处理本轮问题…</p>
                  <ChatResultContent :response="{ ...chatMessage.response, answer: '', answer_blocks: undefined }" :question="questionForMessage(chatMessage)" />
                </div>
                <CalculationResult v-for="(calculation, index) in chatMessage.calculations" :key="calculation.calculation_id ?? index" :calculation="calculation" />
                <ChatResultContent :response="chatMessage.response" :pending="chatMessage.status === 'pending'" :provisional-text="pendingAnswer(chatMessage)" :fallback-text="chatMessage.content" :show-data-details="!(chatMessage.queryResults && chatMessage.queryResults.length > 1) && !chatMessage.calculations?.some(item => item.status === 'succeeded')" :clarification-resolved="!chatMessage.clarification" :question="questionForMessage(chatMessage)">
                  <template v-if="chatMessage.status !== 'pending' && chatMessage.querySqlReferences?.length" #actions>
                    <QuerySqlButton :references="chatMessage.querySqlReferences" />
                  </template>
                </ChatResultContent>
                <template v-if="chatMessage.status !== 'pending' && chatMessage.queryResults && chatMessage.queryResults.length > 1">
                  <ChatResultContent v-for="result in chatMessage.queryResults" :key="result.task_id" :response="{ ...responseFromMetricAsk(result, ''), answer: '', answer_blocks: undefined }" :question="questionForMessage(chatMessage)" />
                </template>
                <div v-if="chatMessage.answerReceipts?.length" class="mt-3 space-y-1" aria-live="polite">
                  <p v-for="(receipt, index) in chatMessage.answerReceipts" :key="`${receipt.question_id}:${receipt.version}:${index}`" class="text-sm text-muted-foreground">{{ receipt.notice }}</p>
                </div>
                <TimeVariantChoices v-if="isActiveTimeVariant(chatMessage) && chatMessage.response?.time_variants" :variants="chatMessage.response.time_variants" :active="true" @choose="(variant) => chooseTimeVariant(chatMessage, variant)" />
                <p v-if="chatMessage.availability?.length && chatMessage.availabilityError" class="text-sm text-muted-foreground">{{ chatMessage.availabilityError }}</p>
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
        <p v-else-if="activeConversation?.legacy" class="mb-3 text-sm text-muted-foreground">旧格式会话仅支持查看，请新建对话继续提问。</p>
        <p v-else-if="activeConversation?.running && !activeConversationIsSending" class="mb-3 text-sm text-muted-foreground">该会话正在其他窗口运行，请稍候或新建对话。</p>
        <CatalogQuestionComposer :key="auth.user.value?.id" v-model="message" :context-key="`${activeConversationId}:${activeClarificationMessage?.clarification?.id ?? activeConversation?.messages.length ?? 0}`" :clarification="activeClarificationMessage?.clarification" :auto-open-clarification-id="autoOpenClarificationId" :is-submitting="activeConversationIsSending" :disabled="isDeletingConversation || !queryReady || Boolean(activeConversation?.legacy) || Boolean(activeConversation?.running && !activeConversationIsSending)" :placeholder="composerPlaceholder" @submit="handleSubmit" @stop="stopActiveConversation" />
      </div>
    </div>
  </section>
  <div v-if="managementNotice && !deleteOpen" role="status" aria-live="polite" class="fixed bottom-5 left-1/2 z-40 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg">{{ managementNotice }}</div>
  <ConversationDeleteDialog :open="deleteOpen" :targets="deleteTargets" :busy="isDeletingConversation" :finished="deleteFinished" :processed="deletedProgress" :failures="deleteFailures" @close="management.closeDelete" @confirm="management.confirmDelete()" @retry="management.confirmDelete(true)" />
</template>
