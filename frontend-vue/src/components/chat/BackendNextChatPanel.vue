<script setup lang="ts">
import { AlertTriangle, Bot, Bug, Check, Clock3, Copy, Download, Ellipsis, ListChecks, LoaderCircle, MessageCircleQuestion, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Trash2, XCircle } from "@lucide/vue"
import { computed, nextTick, onActivated, onMounted, ref, watch } from "vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"

import CatalogQuestionComposer from "@/components/chat/CatalogQuestionComposer.vue"
import ChatResultContent from "@/components/chat/ChatResultContent.vue"
import StructuredClarificationForm from "@/components/chat/StructuredClarificationForm.vue"
import BackendNextDebugPanel from "@/components/chat/BackendNextDebugPanel.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import {
  analyzeBackendNextTask,
  cancelBackendNextClarification,
  cleanupBackendNextConversations,
  createBackendNextQuestion,
  executeBackendNextTask,
  exportBackendNextConversation,
  getBackendNextConversation,
  getBackendNextTask,
  listBackendNextConversations,
  renameBackendNextConversation,
  deleteBackendNextConversation,
  submitBackendNextClarification,
} from "@/lib/api"
import type {
  BackendNextClarification,
  BackendNextConversationMessage,
  BackendNextConversationSnapshot,
  BackendNextExecutionResult,
  BackendNextTaskResult,
  ChatResponse,
  SemanticPatch,
} from "@/types/api"
import { useAuth } from "@/composables/useAuth"
import { useQueryReadiness } from "@/composables/useQueryReadiness"
import { copyText } from "@/lib/clipboard"
import { activeClarificationMessageIds, archiveClarificationResponse, clarificationTranscript, conversationMessageTime, visibleConversationMessages } from "@/lib/conversationMessages"
import { composeClarification, composeQuestion, type ComposerEntity } from "@/lib/composerEntities"
import { friendlyQueryError } from "@/lib/queryErrors"
import { isRetiredContextTask, needsSemanticResume } from "@/lib/taskAdvance"

type TaskStatus = BackendNextTaskResult["status"]

type DisplayMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  response?: ChatResponse
  status?: "pending" | "done" | "error"
  taskId?: string
  taskVersion?: number
  taskStatus?: TaskStatus
  currentStage?: string
  errorCode?: string | null
  clarification?: BackendNextClarification
  streamAnswer?: boolean
  logicalDsl?: Record<string, unknown> | null
  timingsMs?: Record<string, number>
  debug?: Record<string, unknown>
  createdAt?: string
  kind?: string
}

type DisplayConversation = {
  id: string
  title: string
  preview: string
  messages: DisplayMessage[]
  loaded: boolean
  persisted: boolean
  createdAt?: string | null
}

const props = withDefaults(defineProps<{ initialMessage?: string }>(), { initialMessage: "" })
const auth = useAuth()
const { state: queryReadiness, ready: queryReady } = useQueryReadiness()
const activeConversationStorageKey = computed(() => `ask-metric.backend-next.active-conversation:${auth.user.value?.id ?? "anonymous"}`)
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
const isHistoryLoading = ref(true)
const isConversationLoading = ref(false)
const isHistoryLoadingMore = ref(false)
const historyError = ref("")
const messagesScroll = ref<HTMLElement | null>(null)
const debugTarget = ref<{ message: DisplayMessage; question: string } | null>(null)
const copiedMessageId = ref("")
const openTimingMessageId = ref("")
const HISTORY_PAGE_SIZE = 12
const historyOffset = ref(0)
const historyHasMore = ref(false)
const renameTargetId = ref("")
const renameDraft = ref("")
const isRenaming = ref(false)
const hasActivatedOnce = ref(false)
const deletingConversation = ref<DisplayConversation | null>(null)
const isDeletingConversation = ref(false)
const isCleanupDialogOpen = ref(false)
const cleanupKeepLatest = ref(50)
const isCleaningConversations = ref(false)
const cleanupNotice = ref("")

function formatMessageTime(value?: string) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date).replace(/年|月/g, "/").replace("日", "")
}
const exportingConversationId = ref("")
const isHistoryCollapsed = ref(false)
const selectedConversationIds = ref(new Set<string>())
const isBulkDeleteDialogOpen = ref(false)
const isBulkDeleting = ref(false)
const isConversationSelectionMode = ref(false)
const loadedUserId = ref<string | null>(null)
let historyLoadVersion = 0

const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value) ?? conversations.value[0])
const activeConversationIsSending = computed(() => Boolean(activeConversation.value && sendingConversationIds.value.has(activeConversation.value.id)))
const activeClarificationMessage = computed(() => {
  const latestFirst = [...(activeConversation.value?.messages ?? [])].reverse()
  const currentTaskId = latestFirst.find((item) => item.taskId)?.taskId
  return latestFirst.find((item) => item.taskId === currentTaskId && item.role === "assistant"
    && item.taskStatus === "WAITING_USER" && Boolean(item.clarification))
})
const composerPlaceholder = computed(() => {
  const clarification = activeClarificationMessage.value?.clarification
  if (!clarification) return "请输入本次查询的日期、机构和指标"
  if (clarification.fields?.length && clarification.fields.every((field) => field.type === "date_range")) {
    return "补充查询日期，例如：2026年7月末"
  }
  return "选择候选项或直接补充查询条件"
})
const conversationRoundCount = computed(() => activeConversation.value
  ? activeConversation.value.messages.filter((item) => item.role === "user" && item.kind !== "clarification_answer").length
  : 0)
const visibleConversations = computed(() => conversations.value
  .filter((item) => item.persisted || item.messages.length > 0)
  .sort((left, right) => {
  if (left.persisted !== right.persisted) return left.persisted ? 1 : -1
  const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0
  const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0
  return rightTime - leftTime
  }))
const hasMoreConversations = computed(() => historyHasMore.value)
const selectableConversations = computed(() => visibleConversations.value.filter((item) => !sendingConversationIds.value.has(item.id)))
const selectedConversations = computed(() => selectableConversations.value.filter((item) => selectedConversationIds.value.has(item.id)))
const allSelectableConversationsSelected = computed(() => Boolean(selectableConversations.value.length)
  && selectableConversations.value.every((item) => selectedConversationIds.value.has(item.id)))
const cleanupKeepLatestIsValid = computed(() => Number.isInteger(cleanupKeepLatest.value)
  && cleanupKeepLatest.value >= 10
  && cleanupKeepLatest.value <= 100)

const timingDefinitions = [
  ["task_creation_ms", "查询任务创建"],
  ["intent_model_ms", "大模型意图识别"],
  ["catalog_match_ms", "目录精确匹配"],
  ["embedding_ms", "Embedding"],
  ["rerank_ms", "Rerank"],
  ["chat_model_ms", "大模型语义分析"],
  ["semantic_normalization_ms", "语义规范化"],
  ["query_planning_ms", "查询规划"],
  ["sql_execution_ms", "SQL 执行"],
  ["result_formatting_ms", "结果整理"],
  ["total_ms", "总耗时"],
] as const

void timingDefinitions

const timingTimelineDefinitions = [
  ["task_creation_ms", "查询任务创建", "bg-[#FFFFFF] border-[#D9E1EC]", "bg-[#91A4B7]", "包含会话检查、任务与消息写入等数据库操作。"],
  ["intent_model_ms", "大模型 API · 意图识别", "bg-[#F4F8FC] border-[#CFDCE8]", "bg-[#8EA8C0]", "使用关闭深度思考的快速模型调用识别问题意图。"],
  ["catalog_match_ms", "目录精确匹配", "bg-[#F8FAFC] border-[#D9E1EC]", "bg-[#8FA6BC]"],
  ["embedding_ms", "大模型 API · Embedding", "bg-[#F8F7FC] border-[#D8D2E6]", "bg-[#9A94B6]"],
  ["rerank_ms", "大模型 API · Rerank", "bg-[#FCF9F4] border-[#E3D8C6]", "bg-[#B19B78]"],
  ["chat_model_ms", "大模型 API · 语义分析", "bg-[#F4F8FC] border-[#CFDCE8]", "bg-[#8EA8C0]"],
  ["semantic_normalization_ms", "SlotFrame 规范化", "bg-[#F8FAFC] border-[#D9E1EC]", "bg-[#86A5AD]"],
  ["analysis_overhead_ms", "分析阶段 · 其他后端处理", "bg-[#FFF9F0] border-[#E7D5B8]", "bg-[#B99A68]", "分析总耗时扣除语义引擎耗时后的差值，主要包括读取任务、指标和机构目录，以及任务状态更新。"],
  ["query_planning_ms", "DSL 与 SQL 规划", "bg-[#FFFFFF] border-[#D9E1EC]", "bg-[#829EAA]"],
  ["sql_execution_ms", "SQL 执行", "bg-[#F2F8F4] border-[#BFD8C8]", "bg-[#5F8F72]"],
  ["result_formatting_ms", "结果整理", "bg-[#F2F8F4] border-[#BFD8C8]", "bg-[#5F8F72]"],
  ["answer_rendering_ms", "后端 · 事实回答生成", "bg-[#F2F8F4] border-[#BFD8C8]", "bg-[#5F8F72]", "机构、指标、日期、数值和单位均从查询事实中确定性填充，不经过大模型改写。"],
  ["answer_generation_ms", "大模型 API · 回答生成", "bg-[#F4F8FC] border-[#CFDCE8]", "bg-[#8EA8C0]"],
  ["execution_overhead_ms", "执行阶段 · 其他后端处理", "bg-[#FFF9F0] border-[#E7D5B8]", "bg-[#B99A68]", "执行总耗时扣除规划、SQL、结果整理和回答生成后的差值，主要包括权限检查及任务状态读写。"],
  ["total_ms", "后端累计处理耗时", "bg-[#EEF4FB] border-[#BFD2E5]", "bg-[#87A9C8]", "任务创建、分析请求和执行请求的墙钟耗时之和；包含模型、数据库、权限检查和状态处理。"],
] as const

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
  else if (hasActivatedOnce.value && userId) handleNewConversation()
  hasActivatedOnce.value = true
})

function resetChatSessionState() {
  historyLoadVersion += 1
  conversations.value = []
  activeConversationId.value = ""
  sendingConversationIds.value = new Set()
  isHistoryLoading.value = false
  isConversationLoading.value = false
  isHistoryLoadingMore.value = false
  historyError.value = ""
  historyOffset.value = 0
  historyHasMore.value = false
  debugTarget.value = null
  selectedConversationIds.value = new Set()
  isConversationSelectionMode.value = false
  isBulkDeleteDialogOpen.value = false
  deletingConversation.value = null
  cleanupNotice.value = ""
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

function formatDuration(milliseconds: number) {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)} s` : `${milliseconds} ms`
}

function timingItems(timings?: Record<string, number>) {
  if (!timings) return []
  return timingTimelineDefinitions.flatMap(([key, label, panelClass, dotClass, description]) => {
    let value = timings[key]
    if (key === "analysis_overhead_ms" && typeof timings.analyze_total_ms === "number") {
      const semanticTime = (timings.semantic_total_ms ?? ["catalog_match_ms", "embedding_ms", "rerank_ms", "chat_model_ms", "semantic_normalization_ms"]
        .reduce((total, item) => total + (timings[item] ?? 0), 0)
      ) + (timings.intent_model_ms ?? 0)
      value = Math.max(0, timings.analyze_total_ms - semanticTime)
    }
    if (key === "execution_overhead_ms" && typeof timings.execution_total_ms === "number") {
      const measuredTime = ["query_planning_ms", "sql_execution_ms", "result_formatting_ms", "answer_rendering_ms", "answer_generation_ms"]
        .reduce((total, item) => total + (timings[item] ?? 0), 0)
      value = Math.max(0, timings.execution_total_ms - measuredTime)
    }
    return typeof value === "number" && (value > 0 || key === "total_ms")
      ? [{ key, label, description, value, formatted: formatDuration(value), panelClass, dotClass }]
      : []
  })
}

function timingValueClass(timing: ReturnType<typeof timingItems>[number]) {
  return timing.key === "total_ms" ? "text-[#466987]" : "text-[#52606D]"
}

function runningStageText(stage?: string) {
  const labels: Record<string, string> = {
    INTENT_ROUTING: "正在识别问题意图",
    SLOT_EXTRACTION: "正在解析指标、机构和时间",
    ENTITY_RESOLUTION: "正在匹配指标和机构",
    VALIDATION: "正在校验查询条件",
    LOGICAL_DSL: "查询条件已确认，正在准备执行",
    PLANNING: "正在生成安全查询计划",
    EXECUTION: "正在查询数据，请稍候",
    RESULT_FORMATTING: "数据已返回，正在整理回答",
  }
  return labels[stage ?? ""] ?? "正在处理您的问题，请稍候"
}

function executionStatus(message: DisplayMessage) {
  if (message.taskStatus === "SUCCEEDED" && ["NON_METRIC_QUERY_UNSUPPORTED", "INTENT_NOT_AVAILABLE"].includes(message.errorCode ?? "")) {
    return {
      kind: "success",
      title: "已完成意图识别",
      description: "该问题已在意图路由阶段完成处理，没有进入问数查询与澄清流程。",
      cardClass: "border-[#D5E0EB] shadow-[0_2px_10px_rgba(47,93,138,0.05)]",
      avatarClass: "border-[#D5E0EB] bg-[#F7F9FC] text-[#52789C] shadow-[0_2px_8px_rgba(47,93,138,0.06)]",
      panelClass: "border-[#D7E3EF] bg-[#F6F9FC]",
      iconClass: "bg-[#EAF1F7] text-[#52789C]",
      titleClass: "text-[#2F5D8A]",
      descriptionClass: "text-[#607386]",
    }
  }
  if (message.taskStatus === "WAITING_USER" && message.clarification) {
    return {
      kind: "waiting",
      title: "待补充条件",
      description: "请在下方输入框补充查询条件。",
      cardClass: "border-[#E2D5B5] shadow-[0_2px_10px_rgba(81,67,38,0.05)]",
      avatarClass: "border-[#E2D5B5] bg-[#FBF8F0] text-muted-foreground shadow-[0_2px_8px_rgba(81,67,38,0.06)]",
      panelClass: "border-[#E2D5B5] bg-[#FBF8F0]",
      iconClass: "bg-[#F3EBD8] text-muted-foreground",
      titleClass: "text-muted-foreground",
      descriptionClass: "text-[#6F6653]",
    }
  }
  if (message.taskStatus === "CANCELLED" || message.taskStatus === "EXPIRED") {
    return {
      kind: "failed",
      title: message.taskStatus === "CANCELLED" ? "问数任务已取消" : "问数任务已过期",
      description: message.taskStatus === "CANCELLED" ? "当前任务已停止，不会继续执行。" : "当前任务已失效，请重新发起查询。",
      cardClass: "border-l-2 border-[#D6B77A] pl-4",
      avatarClass: "border-[#E2D5B5] bg-[#FBF8F0] text-muted-foreground shadow-[0_2px_8px_rgba(81,67,38,0.05)]",
      panelClass: "border-[#E2D5B5] bg-[#FBF8F0]",
      iconClass: "bg-[#F3EBD8] text-muted-foreground",
      titleClass: "text-muted-foreground",
      descriptionClass: "text-[#6F6653]",
    }
  }
  if (message.taskStatus === "FAILED" || message.status === "error") {
    return {
      kind: "failed",
      title: "问数执行失败",
      description: "本次查询未能完成，请查看错误信息后重试。",
      cardClass: "border-l-2 border-[#D6B77A] pl-4",
      avatarClass: "border-[#E2D5B5] bg-[#FBF8F0] text-muted-foreground shadow-[0_2px_8px_rgba(81,67,38,0.05)]",
      panelClass: "border-[#E2D5B5] bg-[#FBF8F0]",
      iconClass: "bg-[#F3EBD8] text-muted-foreground",
      titleClass: "text-muted-foreground",
      descriptionClass: "text-[#6F6653]",
    }
  }
  if (message.response?.clarification && message.status === "done") {
    return {
      kind: "success",
      title: "澄清信息已确认",
      description: "系统已根据本次选择继续处理查询。",
      cardClass: "border-[#D5E0EB] shadow-[0_2px_10px_rgba(47,93,138,0.05)]",
      avatarClass: "border-[#D5E0EB] bg-[#F7F9FC] text-[#52789C] shadow-[0_2px_8px_rgba(47,93,138,0.06)]",
      panelClass: "border-[#D7E3EF] bg-[#F6F9FC]",
      iconClass: "bg-[#EAF1F7] text-[#52789C]",
      titleClass: "text-[#2F5D8A]",
      descriptionClass: "text-[#607386]",
    }
  }
  if (message.taskStatus === "SUCCEEDED" || (message.status === "done" && Boolean(message.response))) {
    return {
      kind: "success",
      title: "问数执行完成",
      description: "查询结果已生成，您可以继续查看回答和数据结果。",
      cardClass: "border-border/70",
      avatarClass: "border-border bg-muted/50 text-muted-foreground",
      panelClass: "border-border bg-muted/20",
      iconClass: "bg-muted text-muted-foreground",
      titleClass: "text-muted-foreground",
      descriptionClass: "text-muted-foreground",
    }
  }
  return {
    kind: "running",
    title: runningStageText(message.currentStage),
    description: "系统正在执行当前查询，完成后会自动展示结果。",
    cardClass: "",
    avatarClass: "border-[#D5E0EB] bg-[#F7F9FC] text-[#52789C] shadow-[0_2px_8px_rgba(47,93,138,0.06)]",
    panelClass: "border-[#D7E3EF] bg-[#F6F9FC]",
    iconClass: "bg-[#EAF1F7] text-[#52789C]",
    titleClass: "text-[#2F5D8A]",
    descriptionClass: "text-[#607386]",
  }
}

function finishAnswerStream(messageId: string) {
  const conversationId = activeConversation.value?.id
  if (!conversationId) return
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    messages: conversation.messages.map((item) => item.id === messageId ? { ...item, streamAnswer: false } : item),
  }))
  persistActiveConversation()
}

function openDebug(message: DisplayMessage) {
  const question = questionForMessage(message)
  debugTarget.value = {
    message: {
      ...message,
      debug: {
        ...(message.debug ?? {}),
        logical_dsl: message.logicalDsl ?? message.debug?.logical_dsl ?? null,
      },
    },
    question,
  }
}

function questionForMessage(message: DisplayMessage) {
  const messages = activeConversation.value?.messages ?? []
  const index = messages.findIndex((item) => item.id === message.id)
  return [...messages.slice(0, index)].reverse().find((item) => item.role === "user")?.content ?? ""
}

function createConversation(id = createId()): DisplayConversation {
  return { id, title: "新的问数会话", preview: "尚未开始", messages: [], loaded: true, persisted: false, createdAt: null }
}

function formatConversationDate(value?: string | null) {
  if (!value) return "刚刚"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function persistActiveConversation() {
  if (activeConversationId.value) localStorage.setItem(activeConversationStorageKey.value, activeConversationId.value)
  else localStorage.removeItem(activeConversationStorageKey.value)
}

function responseFromClarification(task: BackendNextTaskResult): ChatResponse {
  const clarification = task.clarification!
  const missing = clarification.missing ?? task.missing ?? []
  const options = (clarification.options ?? []).map((option) => {
    if (typeof option === "string") return option
    const code = option.code ?? option.metric_code ?? option.org_code
    const name = option.name ?? option.metric_name ?? option.org_name
    return option.kind === "organization"
      ? { ...option, org_code: code, org_name: name, kind: "organization" as const }
      : { ...option, metric_code: code, metric_name: name, kind: "metric" as const }
  })
  return {
    message_id: task.message_id ?? createId(),
    conversation_id: task.conversation_id,
    intent: task.query_shape ?? "clarification",
    answer: clarification.prompt,
    result: null,
    metric_definition: null,
    clarification: {
      type: missing.includes("metrics") ? "metric" : missing.includes("orgs") ? "organization" : clarification.type,
      options,
      fields: clarification.fields,
      understood: clarification.understood,
      reply_examples: clarification.reply_examples,
    },
    debug: { slot_frame: task.slot_frame, logical_dsl: task.logical_dsl, missing },
  }
}
function responseFromExecution(result: BackendNextExecutionResult): ChatResponse {
  // comparisons 是供答案生成使用的派生计算结果（左右值、差值、比值等），
  // 数据明细必须始终展示 SQL 返回的逐条业务记录。
  const tableRows = result.rows
  const columns = tableRows.length ? Object.keys(tableRows[0]!) : result.columns
  const unsupported = result.status === "unsupported"
  const failed = result.status === "failed"
  const answer = unsupported
    ? `当前能力暂不支持：${result.error_message ?? result.query_shape}`
    : failed && !result.analysis
      ? friendlyQueryError(result.error_message, result.error_code)
      : result.message
        ? result.message
      : tableRows.length
        ? `查询完成，找到 ${tableRows.length} 条记录。`
        : "查询完成，暂无匹配数据。"
  // Top-N 排名需要展示 SQL 明细；完整地区排名行数较多时只保留自然语言总结，避免重复铺满页面。
  const shouldShowStructuredResult = result.row_count <= 100
  return {
    message_id: String(result.run_id ?? createId()),
    intent: result.query_shape,
    analysis: result.analysis,
    answer,
    result: result.status === "succeeded" && shouldShowStructuredResult ? {
      type: result.comparisons?.length ? "entity_compare" : result.query_shape,
      table: { columns, rows: tableRows },
    } : null,
    metric_definition: null,
    clarification: null,
    debug: { run_id: result.run_id, latency_ms: result.latency_ms, idempotent_replay: result.idempotent_replay },
    download: result.status === "succeeded" && result.row_count > 100
      ? { task_id: result.task_id, row_count: result.row_count, format: "xlsx" }
      : undefined,
  }
}

function responseFromPersistedMessage(
  message: BackendNextConversationMessage,
  activeClarification = false,
): ChatResponse | undefined {
  const payload = message.payload
  if (!payload) return undefined
  if (payload.kind === "query_result" && payload.result && typeof payload.result === "object") {
    return responseFromExecution(payload.result as BackendNextExecutionResult)
  }
  if (payload.kind === "clarification" && payload.clarification && typeof payload.clarification === "object") {
    const clarification = payload.clarification as unknown as BackendNextClarification
    return {
      message_id: message.id,
      intent: "clarification",
      answer: activeClarification ? clarification.prompt : clarificationTranscript(clarification, message.content),
      result: null,
      metric_definition: null,
      // A completed historical clarification is plain transcript text. Keeping
      // the interactive payload would suppress its answer and render a blank card.
      clarification: activeClarification ? {
        type: clarification.type,
        options: clarification.options ?? [],
        fields: clarification.fields,
        understood: clarification.understood,
        reply_examples: clarification.reply_examples,
      } : null,
      debug: { clarification },
    }
  }
  return undefined
}

function clarificationFromPersistedMessage(message: BackendNextConversationMessage) {
  const value = message.payload?.clarification
  return value && typeof value === "object" ? value as unknown as BackendNextClarification : undefined
}

function conversationFromSnapshot(snapshot: BackendNextConversationSnapshot): DisplayConversation {
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]))
  const orderedMessages = visibleConversationMessages(snapshot.messages, snapshot.tasks)
  const activeClarifications = activeClarificationMessageIds(snapshot.messages, snapshot.tasks)
  return {
    id: snapshot.id,
    title: snapshot.title,
    preview: snapshot.preview,
    loaded: true,
    persisted: true,
    createdAt: null,
    messages: orderedMessages.map((item) => {
      const task = item.task_id ? tasks.get(item.task_id) : undefined
      return {
        id: item.id,
        role: item.role,
        content: item.content,
        kind: typeof item.payload?.kind === "string" ? item.payload.kind : undefined,
        createdAt: conversationMessageTime(item),
        response: item.role === "assistant" ? responseFromPersistedMessage(item, activeClarifications.has(item.id)) : undefined,
        status: item.role === "assistant" ? "done" : undefined,
        taskId: task?.id,
        taskVersion: task?.version,
        taskStatus: task?.status,
        currentStage: task?.current_stage,
        errorCode: task?.error_code,
        clarification: activeClarifications.has(item.id) ? clarificationFromPersistedMessage(item) : undefined,
        logicalDsl: task?.logical_dsl,
        timingsMs: task?.timings_ms,
        debug: task?.debug,
      }
    }),
  }
}

async function loadHistory(expectedUserId = auth.user.value?.id ?? null) {
  const requestVersion = ++historyLoadVersion
  isHistoryLoading.value = true
  historyError.value = ""
  try {
    const listed = await listBackendNextConversations(HISTORY_PAGE_SIZE, 0)
    if (requestVersion !== historyLoadVersion || auth.user.value?.id !== expectedUserId) return
    const currentActive = activeConversation.value
    const loadedHistory = listed.items.map((item) => ({
      id: item.id,
      title: item.title,
      preview: item.preview,
      messages: [],
      loaded: false,
      persisted: true,
      createdAt: item.created_at,
    }))
    const activeIsInHistory = loadedHistory.some((item) => item.id === currentActive?.id)
    conversations.value = currentActive && !activeIsInHistory
      ? [currentActive, ...loadedHistory]
      : loadedHistory
    historyOffset.value = listed.items.length
    historyHasMore.value = listed.has_more
    if (currentActive) activeConversationId.value = currentActive.id
    persistActiveConversation()
  } catch (error) {
    if (requestVersion !== historyLoadVersion || auth.user.value?.id !== expectedUserId) return
    historyError.value = error instanceof Error ? error.message : "新后端会话恢复失败。"
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
  if (!conversation || conversation.loaded) {
    await scrollToBottom()
    return
  }
  isConversationLoading.value = true
  historyError.value = ""
  try {
    const snapshot = await getBackendNextConversation(conversationId)
    const loaded = { ...conversationFromSnapshot(snapshot), createdAt: conversation.createdAt }
    conversations.value = conversations.value.map((item) => item.id === conversationId ? loaded : item)
    await refreshRunningTasks()
    await scrollToBottom()
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "会话内容加载失败。"
  } finally {
    isConversationLoading.value = false
  }
}

async function showMoreConversations() {
  if (isHistoryLoadingMore.value || !historyHasMore.value) return
  isHistoryLoadingMore.value = true
  historyError.value = ""
  try {
    const listed = await listBackendNextConversations(HISTORY_PAGE_SIZE, historyOffset.value)
    const existingIds = new Set(conversations.value.map((item) => item.id))
    const nextItems: DisplayConversation[] = listed.items
      .filter((item) => !existingIds.has(item.id))
      .map((item) => ({ ...item, messages: [], loaded: false, persisted: true, createdAt: item.created_at }))
    conversations.value = [...conversations.value, ...nextItems]
    historyOffset.value += listed.items.length
    historyHasMore.value = listed.has_more
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "更多会话加载失败。"
  } finally {
    isHistoryLoadingMore.value = false
  }
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
    if (conversation.persisted) await renameBackendNextConversation(conversation.id, title)
    updateConversation(conversation.id, (item) => ({ ...item, title }))
    renameTargetId.value = ""
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "会话名称修改失败。"
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

async function refreshRunningTasks() {
  const runningTaskIds = [...new Set(conversations.value.flatMap((conversation) => conversation.messages)
    .filter((item) => item.taskId && item.taskStatus === "RUNNING")
    .map((item) => item.taskId!))]
  await Promise.all(runningTaskIds.map(async (taskId) => {
    const task = await getBackendNextTask(taskId)
    // 读取历史不应重新发起旧追问的解析或查询；后端也会拒绝其执行命令。
    if (isRetiredContextTask(task)) return
    updateTaskMessages(task)
    if ((task.current_stage === "LOGICAL_DSL" && task.logical_dsl) || needsSemanticResume(task)) {
      const conversation = conversations.value.find((candidate) => candidate.messages.some((message) => message.taskId === task.task_id))
      if (!conversation) return
      let assistant = [...conversation.messages].reverse().find((item) => item.role === "assistant" && item.taskId === task.task_id)
      if (!assistant) {
        assistant = { id: createId(), role: "assistant", content: "正在恢复并执行查询...", status: "pending", taskId: task.task_id }
        updateConversation(conversation.id, (current) => ({ ...current, messages: [...current.messages, assistant!] }))
      }
      await handleTaskAdvance(conversation.id, assistant.id, task)
    }
  }))
}

function updateConversation(conversationId: string, updater: (conversation: DisplayConversation) => DisplayConversation) {
  conversations.value = conversations.value.map((conversation) => conversation.id === conversationId ? updater(conversation) : conversation)
}

function updateTaskMessages(task: BackendNextTaskResult) {
  conversations.value = conversations.value.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((item) => item.taskId === task.task_id ? {
      ...item,
      taskVersion: task.version,
      taskStatus: task.status,
      currentStage: task.current_stage,
      errorCode: task.error_code,
      timingsMs: { ...item.timingsMs, ...task.timings_ms },
      debug: task.debug,
      logicalDsl: task.logical_dsl,
      clarification: item.clarification?.id === task.clarification?.id ? task.clarification ?? undefined : undefined,
      response: item.clarification?.id && item.clarification.id === task.clarification?.id ? item.response : archiveClarificationResponse(item.response),
      status: task.status === "FAILED" ? "error" : item.status,
    } : item),
  }))
}

function taskFailureMessage(task: BackendNextTaskResult) {
  return friendlyQueryError(task.error_message, task.error_code)
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
  cleanupNotice.value = ""
  persistActiveConversation()
  void scrollToBottom()
}

function toggleConversationSelection(conversationId: string) {
  const next = new Set(selectedConversationIds.value)
  if (next.has(conversationId)) next.delete(conversationId)
  else next.add(conversationId)
  selectedConversationIds.value = next
}

function toggleConversationSelectionMode() {
  isConversationSelectionMode.value = !isConversationSelectionMode.value
  selectedConversationIds.value = new Set()
}

function toggleAllConversationSelections() {
  if (allSelectableConversationsSelected.value) {
    selectedConversationIds.value = new Set()
    return
  }
  selectedConversationIds.value = new Set(selectableConversations.value.map((item) => item.id))
}

async function confirmBulkDeleteConversations() {
  const targets = selectedConversations.value
  if (!targets.length || isBulkDeleting.value) return
  isBulkDeleting.value = true
  historyError.value = ""
  const deletedIds = new Set<string>()
  const failedTitles: string[] = []
  try {
    for (const target of targets) {
      try {
        if (target.persisted) await deleteBackendNextConversation(target.id)
        deletedIds.add(target.id)
      } catch {
        failedTitles.push(target.title)
      }
    }
    const deletedPersistedCount = conversations.value.filter((item) => deletedIds.has(item.id) && item.persisted).length
    historyOffset.value = Math.max(0, historyOffset.value - deletedPersistedCount)
    conversations.value = conversations.value.filter((item) => !deletedIds.has(item.id))
    selectedConversationIds.value = new Set(failedTitles.length
      ? targets.filter((item) => !deletedIds.has(item.id)).map((item) => item.id)
      : [])
    if (deletedIds.has(activeConversationId.value)) {
      const nextConversation = visibleConversations.value[0]
      if (nextConversation) await selectConversation(nextConversation.id)
      else handleNewConversation()
    } else {
      persistActiveConversation()
    }
    if (failedTitles.length) {
      historyError.value = `已删除 ${deletedIds.size} 个会话；${failedTitles.length} 个会话删除失败：${failedTitles.join("、")}`
    } else {
      isBulkDeleteDialogOpen.value = false
      isConversationSelectionMode.value = false
    }
  } finally {
    isBulkDeleting.value = false
  }
}

async function handleDeleteConversation(conversationId: string) {
  const target = conversations.value.find((item) => item.id === conversationId)
  if (!target || sendingConversationIds.value.has(conversationId)) return false
  try {
    if (target.persisted) {
      await deleteBackendNextConversation(conversationId)
      historyOffset.value = Math.max(0, historyOffset.value - 1)
    }
    conversations.value = conversations.value.filter((item) => item.id !== conversationId)
    const nextSelected = new Set(selectedConversationIds.value)
    nextSelected.delete(conversationId)
    selectedConversationIds.value = nextSelected
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

function openCleanupDialog() {
  cleanupNotice.value = ""
  cleanupKeepLatest.value = 50
  isCleanupDialogOpen.value = true
}

async function cleanupOldConversations() {
  if (!cleanupKeepLatestIsValid.value || isCleaningConversations.value) return
  isCleaningConversations.value = true
  historyError.value = ""
  cleanupNotice.value = ""
  try {
    const result = await cleanupBackendNextConversations(cleanupKeepLatest.value)
    isCleanupDialogOpen.value = false
    conversations.value = []
    activeConversationId.value = ""
    await loadHistory()
    const firstConversation = conversations.value[0]
    if (firstConversation) await selectConversation(firstConversation.id)
    else handleNewConversation()
    cleanupNotice.value = result.deleted_count
      ? `已删除 ${result.deleted_count} 个旧会话，当前保留 ${result.remaining_count} 个。${result.protected_active_count ? `另有 ${result.protected_active_count} 个活动会话受到保护。` : ""}`
      : `没有需要删除的旧会话，当前共有 ${result.remaining_count} 个会话。${result.protected_active_count ? `其中 ${result.protected_active_count} 个活动会话受到保护。` : ""}`
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "旧会话清理失败。"
  } finally {
    isCleaningConversations.value = false
  }
}

async function handleExportConversation(conversation: DisplayConversation) {
  if (!conversation.persisted || exportingConversationId.value) return
  exportingConversationId.value = conversation.id
  historyError.value = ""
  try {
    await exportBackendNextConversation(conversation.id)
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "会话导出失败。"
  } finally {
    exportingConversationId.value = ""
  }
}

function handleSubmit(text: string, entities: ComposerEntity[] = []) {
  if (!queryReady.value) return
  const label = composeQuestion(text, entities)
  if (!activeConversation.value) handleNewConversation()
  const conversation = activeConversation.value
  if (!conversation || !label || activeConversationIsSending.value) return
  const clarification = activeClarificationMessage.value
  if (clarification?.taskId && clarification.taskVersion !== undefined && clarification.clarification) {
    const answers = composeClarification(text, entities, clarification.clarification)
    message.value = ""
    void resumeClarificationWithAnswers(conversation.id, clarification, answers, label)
    return
  }
  void runQuestion(conversation.id, label)
}

async function runQuestion(conversationId: string, question: string) {
  // 创建任务 → 用返回的版本进行语义解析 → 根据状态进入澄清、执行或结果展示。
  // 分开调用可保留中间状态；不能在解析后无条件执行，否则会跳过待补充和历史结果分支。
  if (!queryReady.value) return
  const assistantId = createId()
  const questionRequestId = createId()
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    title: conversation.messages.length || conversation.title !== "新的问数会话" ? conversation.title : question.slice(0, 24),
    preview: question,
    messages: [
      ...conversation.messages,
      { id: createId(), role: "user", content: question, kind: "question", createdAt: new Date().toISOString() },
      { id: assistantId, role: "assistant", content: "正在创建并分析查询任务...", createdAt: new Date().toISOString(), status: "pending", taskStatus: "RUNNING", currentStage: "INTENT_ROUTING" },
    ],
    createdAt: conversation.createdAt ?? new Date().toISOString(),
  }))
  message.value = ""
  markConversationSending(conversationId, true)
  await scrollToBottom()
  try {
    const created = await createBackendNextQuestion({ conversation_id: conversationId, message: question, idempotency_key: questionRequestId })
    const current = conversations.value.find((item) => item.id === conversationId)
    if (current) {
      current.persisted = true
      if (current.title !== question.slice(0, 24)) await renameBackendNextConversation(conversationId, current.title)
    }
    persistActiveConversation()
    attachTask(conversationId, assistantId, created)
    const analyzed = await analyzeBackendNextTask(created.task_id, created.version)
    await handleTaskAdvance(conversationId, assistantId, analyzed)
    persistActiveConversation()
  } catch (error) {
    failMessage(conversationId, assistantId, error)
  } finally {
    markConversationSending(conversationId, false)
    await scrollToBottom()
  }
}

function attachTask(conversationId: string, messageId: string, task: BackendNextTaskResult) {
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    messages: conversation.messages.map((item) => item.id === messageId ? {
      ...item,
      taskId: task.task_id,
      taskVersion: task.version,
      taskStatus: task.status,
      currentStage: task.current_stage,
      timingsMs: { ...item.timingsMs, ...task.timings_ms },
      debug: task.debug,
    } : item),
  }))
}

async function handleTaskAdvance(conversationId: string, messageId: string, task: BackendNextTaskResult) {
  attachTask(conversationId, messageId, task)
  if (task.status === "WAITING_USER" && task.clarification) {
    if (activeConversationId.value === conversationId && sendingConversationIds.value.has(conversationId)) {
      autoOpenClarificationId.value = task.clarification.id
    }
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      preview: task.clarification!.prompt,
      messages: conversation.messages.map((item) => item.id === messageId ? {
        ...item,
        id: task.message_id ?? item.id,
        content: task.clarification!.prompt,
        response: responseFromClarification(task),
        clarification: task.clarification!,
        logicalDsl: task.logical_dsl,
        status: "done",
      } : item),
    }))
    return
  }
  if (task.status === "RUNNING" && task.logical_dsl && task.current_stage === "LOGICAL_DSL") {
    await executeTask(conversationId, messageId, task)
    return
  }
  if (needsSemanticResume(task)) {
    const analyzed = await analyzeBackendNextTask(task.task_id, task.version)
    await handleTaskAdvance(conversationId, messageId, analyzed)
    return
  }
  if (task.result && (task.status === "SUCCEEDED" || task.result.analysis)) {
    const response = responseFromExecution(task.result)
    updateConversation(conversationId, (conversation) => ({
      ...conversation, preview: response.answer,
      messages: conversation.messages.map((item) => item.id === messageId ? {
        ...item, content: response.answer, response, status: "done",
        clarification: undefined, logicalDsl: task.logical_dsl,
      } : item),
    }))
    return
  }
  if (task.status === "SUCCEEDED" && ["NON_METRIC_QUERY_UNSUPPORTED", "INTENT_NOT_AVAILABLE"].includes(task.error_code ?? "")) {
    const answer = task.error_message ?? "当前系统仅支持经营指标问数。"
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      preview: answer,
      messages: conversation.messages.map((item) => item.id === messageId ? {
        ...item,
        id: task.message_id ?? item.id,
        content: answer,
        status: "done",
        taskStatus: task.status,
        currentStage: task.current_stage,
        errorCode: task.error_code,
      } : item),
    }))
    return
  }
  throw new Error(task.status === "FAILED" ? taskFailureMessage(task) : task.error_message ?? "查询任务当前无法继续，请稍后重试。")
}

async function executeTask(conversationId: string, messageId: string, task: BackendNextTaskResult) {
  // 同一任务使用稳定执行键识别重试；版本号用于拒绝过期状态，两者职责不同。
  const executionRequestId = `execute:${task.task_id}`
  const result = await executeBackendNextTask(task.task_id, task.version, executionRequestId)
  const response = responseFromExecution(result)
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    preview: response.answer,
    messages: conversation.messages.map((item) => {
      const taskStatus = result.status === "succeeded" ? "SUCCEEDED" : "FAILED"
      const currentStage = result.status === "succeeded" ? "RESULT_FORMATTING" : "EXECUTION"
      if (item.id === messageId) return {
        ...item,
        id: response.message_id,
        content: response.answer,
        response,
        streamAnswer: result.status === "succeeded",
        status: result.status === "failed" ? "error" : "done",
        taskVersion: result.task_version ?? task.version,
        taskStatus,
        currentStage,
        clarification: undefined,
        logicalDsl: task.logical_dsl,
        timingsMs: { ...item.timingsMs, ...result.timings_ms },
        debug: { ...(task.debug ?? {}), logical_dsl: task.logical_dsl, ...(result.debug ?? {}) },
      } satisfies DisplayMessage
      if (item.taskId === task.task_id) return {
        ...item,
        taskVersion: result.task_version ?? task.version,
        taskStatus,
        currentStage,
        clarification: undefined,
        debug: { ...(item.debug ?? {}), ...(result.debug ?? {}) },
      } satisfies DisplayMessage
      return item
    }),
  }))
}

async function handleCancelClarification(messageId: string) {
  const conversation = activeConversation.value
  const target = conversation?.messages.find((item) => item.id === messageId)
  if (!conversation || !target?.taskId || target.taskVersion === undefined || !target.clarification || activeConversationIsSending.value) return
  markConversationSending(conversation.id, true)
  try {
    const cancelled = await cancelBackendNextClarification(target.taskId, {
      expected_version: target.taskVersion,
      clarification_id: target.clarification.id,
    })
    updateTaskMessages(cancelled)
    persistActiveConversation()
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "取消澄清任务失败。"
  } finally {
    markConversationSending(conversation.id, false)
  }
}

async function resumeClarificationWithAnswers(conversationId: string, target: DisplayMessage, answers: SemanticPatch | string, answerLabel: string) {
  if (!queryReady.value) return
  markConversationSending(conversationId, true)
  historyError.value = ""
  let executionMessageId: string | undefined
  try {
    const resumed = await submitBackendNextClarification(target.taskId!, {
      expected_version: target.taskVersion!,
      clarification_id: target.clarification!.id,
      answers,
    })
    updateTaskMessages(resumed)
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: [
        ...conversation.messages,
        { id: createId(), role: "user", content: answerLabel, kind: "clarification_answer", createdAt: new Date().toISOString(), taskId: target.taskId, taskStatus: resumed.status },
      ],
    }))
    if (resumed.status === "WAITING_USER" && resumed.clarification) {
      if (activeConversationId.value === conversationId) autoOpenClarificationId.value = resumed.clarification.id
      const assistantId = resumed.message_id ?? createId()
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        messages: [...conversation.messages, {
          id: assistantId,
          role: "assistant",
          content: resumed.clarification!.prompt,
          createdAt: new Date().toISOString(),
          response: responseFromClarification(resumed),
          status: "done",
          taskId: resumed.task_id,
          taskVersion: resumed.version,
          taskStatus: resumed.status,
          currentStage: resumed.current_stage,
          clarification: resumed.clarification!,
          logicalDsl: resumed.logical_dsl,
        }],
      }))
    } else {
      const assistantId = createId()
      executionMessageId = assistantId
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        messages: [
          ...conversation.messages,
          { id: assistantId, role: "assistant", content: "澄清已确认，正在执行查询...", createdAt: new Date().toISOString(), status: "pending", taskId: resumed.task_id, taskVersion: resumed.version, taskStatus: resumed.status, currentStage: resumed.current_stage, logicalDsl: resumed.logical_dsl },
        ],
      }))
      await handleTaskAdvance(conversationId, assistantId, resumed)
    }
    persistActiveConversation()
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "澄清提交失败。"
    if (executionMessageId) failMessage(conversationId, executionMessageId, error)
  } finally {
    markConversationSending(conversationId, false)
    await scrollToBottom()
  }
}

function failMessage(conversationId: string, messageId: string, error: unknown) {
  const content = friendlyQueryError(error instanceof Error ? error.message : null)
  updateConversation(conversationId, (conversation) => ({
    ...conversation,
    preview: content,
    messages: conversation.messages.map((item) => item.id === messageId ? { ...item, content, status: "error", taskStatus: "FAILED" } : item),
  }))
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
        <BaseButton variant="ghost" size="sm" class="text-muted-foreground" :title="isConversationSelectionMode ? '完成管理' : '管理历史对话'" :aria-label="isConversationSelectionMode ? '完成管理' : '管理历史对话'" @click="toggleConversationSelectionMode"><Check v-if="isConversationSelectionMode" /><ListChecks v-else />{{ isConversationSelectionMode ? "完成" : "管理" }}</BaseButton>
        <BaseButton variant="ghost" size="icon" class="text-muted-foreground" title="收起历史对话" aria-label="收起历史对话" @click="isHistoryCollapsed = true"><PanelLeftClose /></BaseButton>
      </div>
      <div v-if="isConversationSelectionMode" class="space-y-2 border-b bg-background/55 px-3 py-2.5">
        <label class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" class="size-4 rounded border-border accent-primary" :checked="allSelectableConversationsSelected" :disabled="!selectableConversations.length || isBulkDeleting" @change="toggleAllConversationSelections">
          <span>{{ selectedConversations.length ? `已选 ${selectedConversations.length} 项` : "选择全部对话" }}</span>
        </label>
        <div class="flex items-center justify-end gap-1">
          <BaseButton variant="ghost" size="sm" class="text-muted-foreground" @click="openCleanupDialog"><Trash2 />清理旧对话</BaseButton>
          <BaseButton variant="destructive" size="sm" :disabled="!selectedConversations.length || isBulkDeleting" @click="isBulkDeleteDialogOpen = true"><Trash2 />删除</BaseButton>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        <LoadingSkeleton v-if="isHistoryLoading" :rows="3" row-class="h-14" />
        <div v-else class="flex flex-col gap-1.5">
          <div v-for="conversation in visibleConversations" :key="conversation.id" class="group/history flex items-start gap-1.5 rounded-xl border border-border/70 bg-background px-2.5 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-muted-foreground/35 hover:bg-background" :class="conversation.id === activeConversation?.id && 'border-primary/35 bg-primary/[0.025] ring-1 ring-primary/10'">
            <input v-if="isConversationSelectionMode" type="checkbox" class="mt-1 size-4 shrink-0 rounded border-border accent-primary" :checked="selectedConversationIds.has(conversation.id)" :disabled="sendingConversationIds.has(conversation.id) || isBulkDeleting" :aria-label="`选择会话：${conversation.title}`" @click.stop @change="toggleConversationSelection(conversation.id)">
            <button type="button" class="min-w-0 flex-1 px-1 text-left text-sm" @click="selectConversation(conversation.id)">
              <span class="flex items-center gap-1.5"><span class="line-clamp-1 min-w-0 flex-1 font-medium">{{ conversation.title }}</span><LoaderCircle v-if="sendingConversationIds.has(conversation.id)" class="size-3.5 animate-spin" /></span>
              <span class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{{ conversation.preview }}</span>
              <span class="mt-1.5 block text-[11px] text-muted-foreground/80" :title="`会话创建时间：${formatConversationDate(conversation.createdAt)}`">{{ formatConversationDate(conversation.createdAt) }}</span>
            </button>
            <PopoverRoot>
              <PopoverTrigger as-child>
                <BaseButton variant="ghost" size="icon" class="size-7 shrink-0 text-muted-foreground" title="会话操作"><Ellipsis /></BaseButton>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent side="right" :side-offset="6" align="start" class="z-50 w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
                  <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm hover:bg-muted" @click="openRenameConversation(conversation)"><Pencil class="size-3.5" />修改名称</button>
                  <button v-if="conversation.persisted" type="button" class="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm hover:bg-muted disabled:opacity-50" :disabled="Boolean(exportingConversationId)" @click="handleExportConversation(conversation)"><LoaderCircle v-if="exportingConversationId === conversation.id" class="size-3.5 animate-spin" /><Download v-else class="size-3.5" />导出会话</button>
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
      <header class="flex min-h-14 items-center justify-between gap-3 border-b px-4 py-3">
        <div class="flex min-w-0 items-center gap-2">
          <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <h1 class="line-clamp-1 text-base font-semibold">{{ activeConversation?.title ?? "指标问数" }}</h1>
          </div>
          <p class="text-xs text-muted-foreground">自然语言指标查询</p>
          </div>
        </div>
        <BaseBadge variant="secondary">{{ conversationRoundCount ? `${conversationRoundCount} 轮` : "新会话" }}</BaseBadge>
      </header>

      <div ref="messagesScroll" class="min-h-0 flex-1 overflow-y-auto bg-muted/20 px-4 py-5">
        <BaseAlert v-if="cleanupNotice" class="mx-auto mb-4 max-w-4xl" title="会话清理完成">{{ cleanupNotice }}</BaseAlert>
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
                  <div class="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100">
                    <BaseButton v-if="chatMessage.taskStatus === 'WAITING_USER' && chatMessage.clarification" variant="ghost" size="icon" class="size-7 text-muted-foreground" :disabled="activeConversationIsSending" title="取消任务" aria-label="取消当前澄清任务" @click="handleCancelClarification(chatMessage.id)"><XCircle class="size-3.5" /></BaseButton>
                    <button
                      v-if="timingItems(chatMessage.timingsMs).length"
                      type="button"
                      class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                      title="执行耗时查询"
                      aria-label="执行耗时查询"
                      :aria-expanded="openTimingMessageId === chatMessage.id"
                      @click="openTimingMessageId = openTimingMessageId === chatMessage.id ? '' : chatMessage.id"
                    >
                      <Clock3 class="size-3.5" />
                    </button>
                    <BaseButton v-if="chatMessage.taskId" variant="ghost" size="icon" class="size-7 text-muted-foreground" title="调试" aria-label="调试" @click="openDebug(chatMessage)"><Bug class="size-3.5" /></BaseButton>
                  </div>
                </div>
                <div v-if="executionStatus(chatMessage).kind === 'running'" class="mb-2 flex items-center gap-2 text-xs text-muted-foreground/60" role="status" aria-live="polite">
                  <span>{{ executionStatus(chatMessage).title }}</span>
                  <span class="flex items-center gap-1" aria-hidden="true">
                    <span class="execution-dot size-1.5 rounded-full bg-[#7C9CDB]" />
                    <span class="execution-dot size-1.5 rounded-full bg-[#7C9CDB] [animation-delay:160ms]" />
                    <span class="execution-dot size-1.5 rounded-full bg-[#7C9CDB] [animation-delay:320ms]" />
                  </span>
                </div>
                <ChatResultContent v-if="chatMessage.status !== 'pending' && chatMessage.response" :response="chatMessage.response" :clarification-resolved="!chatMessage.clarification" :question="questionForMessage(chatMessage)" :stream-answer="chatMessage.streamAnswer" @answer-stream-complete="finishAnswerStream(chatMessage.id)" />
                <p v-else-if="chatMessage.status !== 'pending' && !chatMessage.response" class="whitespace-pre-wrap break-words leading-6">{{ chatMessage.content }}</p>
                <div v-if="chatMessage.taskStatus === 'WAITING_USER' && chatMessage.clarification?.fields?.length" class="mt-1">
                  <StructuredClarificationForm v-if="chatMessage.clarification.fields?.length" :clarification="chatMessage.clarification" />
                </div>
                <div v-if="openTimingMessageId === chatMessage.id" class="mt-3 border-t border-border/70 pt-3">
                  <div class="mb-1.5 flex items-center justify-between gap-3">
                    <span class="text-xs font-medium text-muted-foreground">阶段耗时</span>
                    <button type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="openTimingMessageId = ''">收起</button>
                  </div>
                  <div class="grid gap-x-6 sm:grid-cols-2">
                    <div
                      v-for="timing in timingItems(chatMessage.timingsMs)"
                      :key="timing.key"
                      class="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 py-1.5 text-xs last:border-b-0"
                      :class="timing.key === 'total_ms' && 'font-medium text-foreground sm:col-span-2'"
                      :title="timing.description"
                    >
                      <span class="truncate text-muted-foreground" :class="timing.key === 'total_ms' && 'text-foreground'">{{ timing.label }}</span>
                      <span class="shrink-0 font-mono tabular-nums" :class="timingValueClass(timing)">{{ timing.formatted }}</span>
                    </div>
                  </div>
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
          <span>{{ queryReadiness.message }}<span v-if="queryReadiness.total > 0">（{{ queryReadiness.completed }}/{{ queryReadiness.total }}）</span></span>
        </div>
        <CatalogQuestionComposer :key="auth.user.value?.id" v-model="message" :context-key="`${activeConversationId}:${activeClarificationMessage?.clarification?.id ?? activeConversation?.messages.length ?? 0}`" :clarification="activeClarificationMessage?.clarification" :auto-open-clarification-id="autoOpenClarificationId" :is-submitting="activeConversationIsSending" :disabled="!queryReady" :placeholder="composerPlaceholder" @submit="handleSubmit" />
      </div>
    </div>
  </section>
  <ConfirmDialog :open="Boolean(deletingConversation)" title="删除历史会话" :busy="isDeletingConversation" @update:open="!$event && (deletingConversation = null)" @confirm="confirmDeleteConversation">
    即将永久删除会话 <strong class="font-medium text-foreground">「{{ deletingConversation?.title }}」</strong> 及其消息和任务记录。此操作无法撤销，建议需要保留时先导出会话。
  </ConfirmDialog>
  <ConfirmDialog :open="isBulkDeleteDialogOpen" title="批量删除历史会话" :busy="isBulkDeleting" @update:open="isBulkDeleteDialogOpen = $event" @confirm="confirmBulkDeleteConversations">
    即将永久删除已选择的 <strong class="font-medium text-foreground">{{ selectedConversations.length }}</strong> 个会话及其消息和任务记录。正在运行的会话不会进入选择范围，此操作无法撤销。
  </ConfirmDialog>
  <BaseModal :open="isCleanupDialogOpen" title="清理旧会话" description="保留最近 N 个会话，批量删除当前账号更早的历史会话。" :busy="isCleaningConversations" size="sm" @update:open="isCleanupDialogOpen = $event">
    <div class="space-y-4 text-sm">
      <label class="form-field">保留最近会话数量<input v-model.number="cleanupKeepLatest" type="number" min="10" max="100" step="1" class="form-control" :disabled="isCleaningConversations"><span class="field-help">请输入 10–100 之间的整数，建议保留 50 个。</span></label>
      <BaseAlert title="删除后无法恢复" variant="destructive">系统将永久删除当前账号除最近 {{ cleanupKeepLatestIsValid ? cleanupKeepLatest : "N" }} 个之外的旧会话，以及这些会话中的消息和任务。正在运行或等待澄清的会话不会删除。</BaseAlert>
    </div>
    <template #footer><BaseButton variant="outline" :disabled="isCleaningConversations" @click="isCleanupDialogOpen = false">取消</BaseButton><BaseButton variant="destructive" :disabled="!cleanupKeepLatestIsValid || isCleaningConversations" @click="cleanupOldConversations"><LoaderCircle v-if="isCleaningConversations" class="animate-spin" /><Trash2 v-else />{{ isCleaningConversations ? "清理中..." : "确认清理" }}</BaseButton></template>
  </BaseModal>
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
  <BackendNextDebugPanel v-if="debugTarget" :question="debugTarget.question" :task-id="debugTarget.message.taskId" :task-version="debugTarget.message.taskVersion" :status="debugTarget.message.taskStatus" :stage="debugTarget.message.currentStage" :timings="debugTarget.message.timingsMs" :debug="debugTarget.message.debug" @close="debugTarget = null" />
</template>
