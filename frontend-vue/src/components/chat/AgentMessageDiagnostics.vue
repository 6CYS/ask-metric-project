<script setup lang="ts">
import { Bug, Clock3, ChevronRight, CircleAlert, LoaderCircle } from "@lucide/vue"
import { computed, onUnmounted, ref, watch } from "vue"
import BackendNextDebugPanel from "@/components/chat/BackendNextDebugPanel.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { getBackendNextTask } from "@/lib/api"
import type { BackendNextTaskResult } from "@/types/api"

const props = defineProps<{
  question: string
  taskIds: string[]
  pending: boolean
  hasAnswer?: boolean
  startedAt?: string
  elapsedMs?: number
  tools: { id?: string; tool: string; status: string; elapsedMs?: number }[]
}>()
const expanded = ref(false)
const toolLabels: Record<string, string> = {
  resolve_business_turn: "解析查询条件",
  business_context_read: "读取查询历史",
  execute_business_frame: "执行指标查询",
  read_business_result: "读取历史结果",
  data_availability: "查看数据可用范围",
  catalog_overview: "查看目录概览",
  catalog: "目录查询",
  read: "读取任务、结果与历史",
  metric_catalog_search: "检索指标目录",
  org_catalog_search: "检索机构目录",
  metric_ask: "解析问题并查询指标",
  metric_query_structured: "按指标、机构和日期查询",
  metric_calculate: "调用可靠计算工具",
}
// 状态栏复用真实工具状态；没有运行中的工具时显示模型处理阶段。
const currentStage = computed(() => {
  if (!props.pending) return "执行过程"
  const running = props.tools.find(call => call.status === "running")
  if (!running) return props.hasAnswer ? "正在生成回答" : "正在处理"
  const stages: Record<string, string> = {
    resolve_business_turn: "正在解析查询条件",
    business_context_read: "正在读取查询历史",
    execute_business_frame: "正在执行指标查询",
    read_business_result: "正在读取历史结果",
    data_availability: "正在检查数据覆盖",
    catalog_overview: "正在查看目录概览",
    catalog: "正在查询目录",
    read: "正在读取记录",
    metric_catalog_search: "正在检索指标",
    org_catalog_search: "正在检索机构",
    metric_ask: "正在解析并查询",
    metric_query_structured: "正在查询数据",
    metric_calculate: "正在使用可靠计算工具",
  }
  return stages[running.tool] ?? "正在执行查询步骤"
})
const statusLabels: Record<string, string> = {
  running: "执行中", done: "已完成", error: "执行失败", interrupted: "已中断", unknown: "未记录执行结果",
}
function readableDuration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) return "不足 1 秒"
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
const mode = ref<"timing" | "debug" | null>(null)
const selectedId = ref("")
const task = ref<BackendNextTaskResult>()
const loading = ref(false)
const error = ref("")
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
let requestVersion = 0
const elapsed = computed(() => {
  if (!props.pending) return props.elapsedMs
  const start = Date.parse(props.startedAt ?? "")
  return Number.isFinite(start) ? Math.max(0, now.value - start) : undefined
})
watch(() => props.pending, (pending) => {
  clearInterval(timer)
  now.value = Date.now()
  if (pending) timer = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onUnmounted(() => { clearInterval(timer); requestVersion += 1 })
watch(() => props.taskIds, (ids) => {
  if (!ids.includes(selectedId.value)) selectedId.value = ids[0] ?? ""
}, { immediate: true })

// 仅在用户展开诊断时读取任务；切换任务或关闭时使旧请求失效。
watch([mode, selectedId, () => props.pending], async () => {
  const version = ++requestVersion
  task.value = undefined
  error.value = ""
  loading.value = false
  if (!mode.value || !selectedId.value) return
  loading.value = true
  try {
    const result = await getBackendNextTask(selectedId.value)
    if (version !== requestVersion) return
    task.value = result
  } catch (reason) {
    if (version === requestVersion) error.value = reason instanceof Error ? reason.message : "读取任务详情失败"
  } finally {
    if (version === requestVersion) loading.value = false
  }
})

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


const timings = computed(() => timingItems(task.value?.timings_ms))
function toggle(next: "timing" | "debug") { mode.value = mode.value === next ? null : next }
</script>

<template>
  <div class="mb-3 text-xs text-muted-foreground">
    <button type="button" class="inline-flex items-center gap-1.5 rounded-sm py-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" aria-label="执行过程" :aria-expanded="expanded" @click="expanded = !expanded">
      <ChevronRight class="size-3.5 shrink-0 transition-transform" :class="expanded && 'rotate-90'" />
      <span aria-live="polite">{{ currentStage }}</span>
      <span v-if="elapsed !== undefined">· {{ pending ? '' : '用时 ' }} {{ readableDuration(elapsed) }}</span>
      <span v-else-if="tools.length">· {{ tools.length }} 次工具调用</span>

    </button>
    <div v-if="expanded" class="pt-2">
      <ol v-if="tools.length" class="ml-1.5 list-none border-l border-border/60 pl-4">
        <li v-for="(call, index) in tools" :key="call.id ?? index" class="relative flex min-h-7 flex-wrap items-center gap-x-2 gap-y-0.5 py-1">
          <span class="absolute -left-4 top-1/2 flex size-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center bg-background" aria-hidden="true">
            <LoaderCircle v-if="call.status === 'running'" class="size-3 animate-spin" />
            <CircleAlert v-else-if="call.status === 'error'" class="size-3" />
            <span v-else class="size-1 rounded-full bg-muted-foreground/45" />
          </span>
          <span>{{ toolLabels[call.tool] ?? '执行查询步骤' }}</span>
          <span :class="call.status === 'done' ? 'sr-only' : ''">{{ statusLabels[call.status] ?? '状态未知' }}</span>
          <span v-if="call.elapsedMs !== undefined" class="text-muted-foreground/60 tabular-nums">· {{ call.elapsedMs >= 1000 ? (call.elapsedMs / 1000).toFixed(2) + ' 秒' : call.elapsedMs + ' 毫秒' }}</span>
        </li>
      </ol>
      <p v-else>{{ pending ? '正在处理问题，等待工具调用。' : '本轮没有工具调用记录。' }}</p>
      <p v-if="pending && tools.length && !tools.some(call => call.status === 'running')" class="mt-2">正在处理工具结果，等待后续回复。</p>
    </div>
  </div>
  <div class="absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100">
    <button type="button" class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" title="执行耗时查询" aria-label="执行耗时查询" :aria-expanded="mode === 'timing'" @click="toggle('timing')"><Clock3 class="size-3.5" /></button>
    <BaseButton variant="ghost" size="icon" class="size-7 text-muted-foreground" title="调试" aria-label="调试" :aria-expanded="mode === 'debug'" @click="toggle('debug')"><Bug class="size-3.5" /></BaseButton>
  </div>
  <div v-if="mode === 'timing'" class="mt-3 border-t border-border/70 pt-3 text-xs text-muted-foreground">
    <div class="mb-1.5 flex items-center justify-between gap-3">
      <span class="text-xs font-medium text-muted-foreground">阶段耗时</span>
      <button type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="mode = null">收起</button>
    </div>
    <label v-if="taskIds.length > 1" class="flex items-center gap-2">后端任务
      <select v-model="selectedId" class="min-w-0 max-w-full rounded border bg-background p-1">
        <option v-for="(id, index) in taskIds" :key="id" :value="id">任务 {{ index + 1 }} · {{ id }}</option>
      </select>
    </label>
    <template v-if="mode === 'timing'">
      <div class="grid gap-x-6 sm:grid-cols-2">
        <div v-for="timing in timings" :key="timing.key" class="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 py-1.5 text-xs last:border-b-0" :class="timing.key === 'total_ms' && 'font-medium text-foreground sm:col-span-2'" :title="timing.description">
          <span class="truncate text-muted-foreground" :class="timing.key === 'total_ms' && 'text-foreground'">{{ timing.label }}</span>
          <span class="shrink-0 font-mono tabular-nums" :class="timingValueClass(timing)">{{ timing.formatted }}</span>
        </div>
        <div v-if="elapsed !== undefined" class="flex min-w-0 items-center justify-between gap-3 py-1.5 text-xs sm:col-span-2" title="包含 pi 编排、工具请求与网络等待，与后端累计处理耗时分别统计。">
          <span>{{ pending ? '本轮已等待' : '本轮总耗时' }}</span><span class="shrink-0 font-mono tabular-nums text-[#466987]">{{ formatDuration(elapsed) }}</span>
        </div>
      </div>
      <p v-if="task && !loading && !timings.length">该任务暂无阶段耗时记录。</p>
      <p v-if="!pending && elapsed === undefined && !timings.length && !loading">该历史消息未记录整轮耗时。</p>
    </template>
    <p v-if="loading" role="status">正在读取后端任务详情…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!taskIds.length">{{ pending ? '正在等待工具返回后端任务编号，暂时没有后端调试详情。' : '本轮未返回后端任务编号，无法读取后端调试详情。' }}</p>
  </div>
  <BackendNextDebugPanel v-if="mode === 'debug'" :question="question" :task-id="task?.task_id" :task-version="task?.version" :status="task?.status" :stage="task?.current_stage" :timings="task?.timings_ms" :debug="task ? { ...task.debug, logical_dsl: task.logical_dsl ?? task.debug?.logical_dsl } : undefined" @close="mode = null">
    <template #status>
      <label v-if="taskIds.length > 1" class="flex items-center gap-2 text-xs">后端任务
        <select v-model="selectedId" class="min-w-0 max-w-full rounded border bg-background p-1">
          <option v-for="(id, index) in taskIds" :key="id" :value="id">任务 {{ index + 1 }} · {{ id }}</option>
        </select>
      </label>
      <p v-if="loading" role="status" class="text-sm text-muted-foreground">正在读取后端任务详情…</p>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="!taskIds.length" class="text-sm text-muted-foreground">{{ pending ? '正在等待工具返回后端任务编号，暂时没有后端调试详情。' : '本轮未返回后端任务编号，无法读取后端调试详情。' }}</p>
    </template>
  </BackendNextDebugPanel>
</template>
