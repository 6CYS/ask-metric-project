<script setup lang="ts">
import { stripInternalDisplayHints } from "@/lib/replyPresentation"
import { Bug, ChartColumn, Check, Copy, Download, LoaderCircle, Search, Table2 } from "@lucide/vue"
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue"

import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import ListPagination from "@/components/ListPagination.vue"
import ChatAnswerSegments from "@/components/chat/ChatAnswerSegments.vue"
import type { ChatResponse } from "@/types/api"
import { exportBackendNextTaskResult } from "@/lib/api"
import { clarificationTranscript } from "@/lib/conversationMessages"
import { copyText } from "@/lib/clipboard"
import { flattenAssistantBlocks, parseAssistantBlocks, type AssistantBlock, type AssistantTableAlign } from "@/lib/assistantText"
import { paginateResultRows, RESULT_PAGE_SIZE_OPTIONS, resultTotalPages } from "@/lib/resultPagination"
import {
  formatResultTableValue,
  getResultCellValue,
  getResultColumnClass,
  getResultColumnLabel,
  getVisibleResultColumns,
  shouldTruncateResultColumn,
} from "@/lib/resultColumns"
import { resolveResultVisualization, type ResultView } from "@/lib/resultVisualization"

// ECharts 体积较大，仅在展示决策允许图表时加载对应代码块。
const ChatResultChart = defineAsyncComponent(() => import("@/components/chat/ChatResultChart.vue"))

const props = withDefaults(defineProps<{ response: ChatResponse; question?: string; clarificationResolved?: boolean; showDebugButton?: boolean; streamAnswer?: boolean; showDataDetails?: boolean }>(), { question: "", clarificationResolved: false, showDebugButton: false, streamAnswer: false, showDataDetails: true })
const emit = defineEmits<{ debug: []; answerStreamComplete: [] }>()
const visualization = computed(() => resolveResultVisualization(props.response, props.question))
const resultMode = ref<ResultView>("table")
const resultPage = ref(1)
const resultPageSize = ref<number>(RESULT_PAGE_SIZE_OPTIONS[0])
const isDownloading = ref(false)
const downloadError = ref("")
const isDataDetailsOpen = ref(Boolean(props.response.result?.table?.rows.length))
// Agent 先交付回执再异步读取结果；首批行到达时展开，后续更新不覆盖用户的折叠选择。
watch(() => Boolean(props.response.result?.table?.rows.length), (hasRows, hadRows) => {
  if (hasRows && !hadRows) isDataDetailsOpen.value = true
})
const isAnswerCopied = ref(false)
const answerCopyError = ref("")
const statusLabels: Record<string, string> = {
  ok: "计算正常",
  ratio_unavailable: "分母为零，比例不可用",
  current_missing: "当前期数据缺失",
  base_missing: "基期数据缺失",
  base_zero: "基期为零，变化率不可用",
}
const statusDefinitions = computed(() => {
  const rows = props.response.result?.table?.rows ?? []
  if (!rows.length || !props.response.result?.table?.columns.includes("status")) return []
  const sample = rows[0] ?? {}
  const values = "left_org" in sample || "right_org" in sample
    ? ["ok", "ratio_unavailable"]
    : "current_value" in sample || "base_value" in sample
      ? ["ok", "current_missing", "base_missing", "base_zero"]
      : [...new Set(rows.map((row) => String(row.status)).filter((value) => value in statusLabels))]
  return values.map((value) => ({ value, label: statusLabels[value] }))
})
const showAnswer = computed(() => props.clarificationResolved || !props.response.clarification?.fields?.length)
const rawDisplayAnswer = computed(() => {
  if (props.response.clarification) return clarificationTranscript(props.response.clarification, props.response.answer)
  if (props.response.answer !== "已生成查询计划，等待执行。") return props.response.answer
  const count = props.response.result?.table?.rows.length
  return typeof count !== "number" ? props.response.answer : count ? `查询完成，找到 ${count} 条记录。` : "查询完成，暂无匹配数据。"
})
// answerSource 保留 markdown 结构供块级渲染；displayAnswer 是纯文本副本，供复制等场景使用
const answerSource = computed(() => stripInternalDisplayHints(rawDisplayAnswer.value))
// 服务端给出的结构化回答块；非空时渲染与复制都优先使用它
const responseBlocks = computed(() => props.response.answer_blocks?.length ? props.response.answer_blocks : null)
const displayAnswer = computed(() => flattenAssistantBlocks(responseBlocks.value ?? parseAssistantBlocks(answerSource.value)))
const renderedAnswer = ref("")
const answerStreamComplete = ref(true)
let answerFrame = 0

function stopAnswerStream() {
  if (answerFrame) window.cancelAnimationFrame(answerFrame)
  answerFrame = 0
}

function renderAnswer(answer: string) {
  stopAnswerStream()
  if (!props.streamAnswer || props.response.clarification || answer.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    renderedAnswer.value = answer
    answerStreamComplete.value = true
    return
  }
  renderedAnswer.value = ""
  answerStreamComplete.value = false
  const startedAt = performance.now()
  const duration = Math.min(2400, Math.max(500, answer.length * 20))
  const renderFrame = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const length = Math.max(1, Math.ceil(answer.length * progress))
    renderedAnswer.value = answer.slice(0, length)
    if (progress < 1) {
      answerFrame = window.requestAnimationFrame(renderFrame)
      return
    }
    answerFrame = 0
    answerStreamComplete.value = true
    emit("answerStreamComplete")
  }
  answerFrame = window.requestAnimationFrame(renderFrame)
}

watch(answerSource, renderAnswer, { immediate: true })
onBeforeUnmount(stopAnswerStream)

/** 沿用原有阅读习惯：单段无加粗的纯文本按句末标点拆成多段，两路块来源统一套用 */
function splitSingleParagraph(blocks: AssistantBlock[]): AssistantBlock[] {
  if (blocks.length !== 1) return blocks
  const only = blocks[0]!
  if (only.type !== "paragraph" || only.segments.some((segment) => segment.bold)) return blocks
  const text = only.segments.map((segment) => segment.text).join("").trim()
  if (!text) return []
  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? []
  if (sentences.length <= 1) return [{ type: "paragraph", segments: [{ text, bold: false }] }]
  return sentences.map((item) => ({ type: "paragraph" as const, segments: [{ text: item, bold: false }] }))
}

const answerBlocks = computed<AssistantBlock[]>(() => {
  // 流式结束后优先使用服务端结构化块；流式进行中及无块时按 markdown 解析回退
  const blocks = answerStreamComplete.value && responseBlocks.value
    ? responseBlocks.value
    : parseAssistantBlocks(renderedAnswer.value.trim())
  return splitSingleParagraph(blocks)
})

function answerAlignClass(align: AssistantTableAlign | undefined) {
  return align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left"
}
const resultRowCount = computed(() => props.response.result?.table?.rows.length ?? 0)
const hasResultRows = computed(() => resultRowCount.value > 0)
const resultRows = computed(() => props.response.result?.table?.rows ?? [])
const resultColumns = computed(() => getVisibleResultColumns(
  props.response.result?.table?.columns ?? [],
  resultRows.value,
))
const resultPageCount = computed(() => resultTotalPages(resultRowCount.value, resultPageSize.value))
const paginatedResultRows = computed(() => paginateResultRows(resultRows.value, resultPage.value, resultPageSize.value))
const chartViews = computed(() => visualization.value.allowedViews.filter((view): view is Exclude<ResultView, "table"> => view !== "table"))
const hasChartView = computed(() => chartViews.value.length > 0)
const activeChartView = computed<Exclude<ResultView, "table"> | null>(() => resultMode.value === "table" ? null : resultMode.value)
const chartWasLimited = computed(() => !hasChartView.value && visualization.value.reason.includes("超过"))

watch(
  [() => props.response.message_id, () => props.question],
  () => {
    resultMode.value = "table"
    resultPage.value = 1
  },
)
watch(resultPageSize, () => { resultPage.value = 1 })
watch(resultPageCount, (total) => {
  if (resultPage.value > total) resultPage.value = total
})

function resultViewLabel(view: ResultView) {
  if (view === "line") return "折线图"
  if (view === "horizontal_bar") return "横向柱状图"
  if (view === "vertical_bar") return "柱状图"
  return "表格"
}

function formatCell(value: unknown, column: string, row: Record<string, unknown>) {
  if (value === null || value === undefined || value === "") return "-"
  if (column === "status" && typeof value === "string" && statusLabels[value]) {
    return statusLabels[value]
  }
  return formatResultTableValue(value, column, row)
    ?? (typeof value === "object" ? JSON.stringify(value) : String(value))
}

async function downloadResult() {
  const taskId = props.response.download?.task_id
  if (!taskId || isDownloading.value) return
  isDownloading.value = true
  downloadError.value = ""
  try {
    await exportBackendNextTaskResult(taskId)
  } catch (error) {
    downloadError.value = error instanceof Error ? error.message : "查询结果下载失败。"
  } finally {
    isDownloading.value = false
  }
}

async function copyAnswer() {
  if (!displayAnswer.value || isAnswerCopied.value) return
  answerCopyError.value = ""
  try {
    await copyText(displayAnswer.value)
    isAnswerCopied.value = true
    window.setTimeout(() => { isAnswerCopied.value = false }, 1600)
  } catch {
    answerCopyError.value = "回答复制失败，请手动选择文字复制。"
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <div v-if="showAnswer" class="group/answer relative space-y-1.5 break-words pr-9 leading-7" aria-live="polite">
      <template v-for="(block, index) in answerBlocks" :key="index">
        <p v-if="block.type === 'paragraph'"><ChatAnswerSegments :segments="block.segments" /></p>
        <ul v-else-if="block.type === 'list' && !block.ordered" class="list-disc space-y-1 ps-6"><li v-for="(item, itemIndex) in block.items" :key="itemIndex"><ChatAnswerSegments :segments="item" /></li></ul>
        <ol v-else-if="block.type === 'list'" class="list-decimal space-y-1 ps-6"><li v-for="(item, itemIndex) in block.items" :key="itemIndex"><ChatAnswerSegments :segments="item" /></li></ol>
        <div v-else class="max-w-full overflow-x-auto rounded-md border border-border/70">
          <table class="w-full min-w-max text-sm">
            <thead v-if="block.header.length"><tr class="border-b bg-muted/50"><th v-for="(cell, cellIndex) in block.header" :key="cellIndex" class="h-9 px-3 text-left font-medium whitespace-nowrap" :class="answerAlignClass(block.aligns[cellIndex])"><ChatAnswerSegments :segments="cell" /></th></tr></thead>
            <tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex" class="border-b last:border-b-0 hover:bg-muted/40"><td v-for="(cell, cellIndex) in row" :key="cellIndex" class="px-3 py-2 whitespace-nowrap" :class="answerAlignClass(block.aligns[cellIndex])"><ChatAnswerSegments :segments="cell" /></td></tr></tbody>
          </table>
        </div>
      </template>
      <span v-if="!answerStreamComplete" class="inline-block h-4 w-0.5 animate-pulse rounded-full bg-[#52789C] align-middle" aria-hidden="true" />
      <button v-if="answerStreamComplete && answerBlocks.length" type="button" class="absolute -top-1 right-0 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-all hover:bg-muted hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" :title="isAnswerCopied ? '已复制' : '复制回答'" :aria-label="isAnswerCopied ? '回答已复制' : '复制回答'" @click="copyAnswer"><Check v-if="isAnswerCopied" class="size-3.5 text-emerald-600" /><Copy v-else class="size-3.5" /></button>
    </div>
    <p v-if="answerCopyError" class="text-xs text-[#78663E]">{{ answerCopyError }}</p>

    <div v-if="answerStreamComplete && response.metric_definition" class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
      <span>指标依据：{{ response.metric_definition.metric_name }}</span>
      <span v-if="response.metric_definition.unit">· {{ response.metric_definition.unit }}</span>
    </div>

    <div v-if="showDataDetails && answerStreamComplete && response.result?.table" class="flex min-w-0 flex-col gap-2">
      <div v-if="hasResultRows" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
        <button type="button" class="inline-flex items-center gap-1 text-muted-foreground/75 underline-offset-4 transition-colors hover:text-muted-foreground hover:underline" @click="isDataDetailsOpen = !isDataDetailsOpen">
          <Table2 class="size-3.5" />{{ isDataDetailsOpen ? "收起数据明细" : `查看 ${resultRowCount} 条数据明细` }}
        </button>
      </div>
      <div v-else class="flex items-start gap-2 border-y border-[#DCE3EF] py-2.5 text-xs text-[#66759B]" role="status">
        <Search class="mt-0.5 size-3.5 shrink-0" />
        <span><strong class="font-medium text-[#52638F]">当前条件下暂未查询到数据。</strong> 可以确认统计日期或机构名称，也可以扩大时间范围重新查询。</span>
      </div>
      <div v-if="isDataDetailsOpen" class="w-full min-w-0 max-w-full overflow-hidden border-y border-border/70">
        <div v-if="hasChartView" class="flex flex-wrap justify-end gap-1 border-b border-border/70 px-2 py-1.5">
          <BaseButton size="sm" :variant="resultMode === 'table' ? 'secondary' : 'ghost'" class="h-7" @click="resultMode = 'table'"><Table2 />表格</BaseButton>
          <BaseButton v-for="view in chartViews" :key="view" size="sm" :variant="resultMode === view ? 'secondary' : 'ghost'" class="h-7" @click="resultMode = view"><ChartColumn />{{ resultViewLabel(view) }}</BaseButton>
        </div>
        <ChatResultChart v-if="activeChartView" :decision="visualization" :view="activeChartView" />
        <div v-else class="min-w-0 max-w-full">
          <div class="max-h-[30rem] w-full min-w-0 max-w-full overflow-auto overscroll-x-contain">
            <table class="w-full min-w-max text-sm"><thead><tr class="border-b bg-muted/50"><th v-for="column in resultColumns" :key="column" class="sticky top-0 z-10 h-9 bg-muted/95 px-3 text-left font-medium whitespace-nowrap backdrop-blur-sm" :class="getResultColumnClass(column)">{{ getResultColumnLabel(column) }}</th></tr></thead><tbody><tr v-for="(row, rowIndex) in paginatedResultRows" :key="(resultPage - 1) * resultPageSize + rowIndex" class="border-b last:border-b-0 hover:bg-muted/40"><td v-for="column in resultColumns" :key="column" class="px-3 py-2.5 whitespace-nowrap" :class="getResultColumnClass(column)"><BaseBadge v-if="column === 'status' && getResultCellValue(row, column)" variant="outline" class="max-w-full"><span class="block truncate" :title="String(formatCell(getResultCellValue(row, column), column, row))">{{ formatCell(getResultCellValue(row, column), column, row) }}</span></BaseBadge><span v-else class="block" :class="shouldTruncateResultColumn(column) && 'truncate'" :title="shouldTruncateResultColumn(column) ? String(formatCell(getResultCellValue(row, column), column, row)) : undefined">{{ formatCell(getResultCellValue(row, column), column, row) }}</span></td></tr></tbody></table>
          </div>
          <div v-if="resultRowCount > RESULT_PAGE_SIZE_OPTIONS[0]" class="border-t border-border/70">
            <div class="flex justify-end px-3 pt-2">
              <label class="flex items-center gap-2 text-xs text-muted-foreground">每页
                <select v-model.number="resultPageSize" class="h-8 rounded-md border border-input bg-background px-2 text-foreground" aria-label="每页显示条数">
                  <option v-for="size in RESULT_PAGE_SIZE_OPTIONS" :key="size" :value="size">{{ size }} 条</option>
                </select>
              </label>
            </div>
            <ListPagination :page="resultPage" :page-size="resultPageSize" :total-items="resultRowCount" :total-pages="resultPageCount" @change="resultPage = $event" />
          </div>
          <p v-if="chartWasLimited" class="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">数据量超出图表核实范围，本次仅展示分页表格。</p>
        </div>
      </div>
      <details v-if="statusDefinitions.length" class="border-t border-border/70 pt-2 text-xs text-muted-foreground">
        <summary class="cursor-pointer select-none hover:text-foreground">查看状态说明</summary>
        <ul class="mt-1.5 space-y-1"><li v-for="item in statusDefinitions" :key="item.value"><code class="rounded bg-muted px-1 py-0.5 text-foreground">{{ item.value }}</code>：{{ item.label }}</li></ul>
      </details>
    </div>

    <div v-else-if="answerStreamComplete && response.download" class="border-y border-border/70 py-3">
      <p class="font-medium">查询结果共 {{ response.download.row_count }} 条</p>
      <p class="mt-1 text-sm text-muted-foreground">数据量较大，完整明细请下载 Excel 查看。</p>
      <BaseButton class="mt-2" variant="ghost" size="sm" :disabled="isDownloading" @click="downloadResult"><LoaderCircle v-if="isDownloading" class="animate-spin" /><Download v-else />{{ isDownloading ? "正在生成..." : "下载 Excel" }}</BaseButton>
      <p v-if="downloadError" class="mt-2 text-sm text-destructive">{{ downloadError }}</p>
    </div>


    <div v-if="showDebugButton && response.debug"><BaseButton variant="outline" size="sm" @click="emit('debug')"><Bug />详细调试信息</BaseButton></div>
  </div>
</template>
