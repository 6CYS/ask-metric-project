<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { stripInternalDisplayHints } from "@/lib/replyPresentation"
import { Bug, ChartColumn, Check, Copy, Download, LoaderCircle, Search, Table2 } from "@lucide/vue"
import { computed, defineAsyncComponent, onBeforeUnmount, ref, useId, watch } from "vue"

import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import ListPagination from "@/components/ListPagination.vue"
import ChatMarkdown from "@/components/chat/ChatMarkdown.vue"
import type { BusinessReportChart, ChatResponse } from "@/types/api"
import { exportBackendNextTaskResult } from "@/lib/api"
import { clarificationTranscript } from "@/lib/conversationMessages"
import { copyText } from "@/lib/clipboard"
import { flattenAssistantBlocks } from "@/lib/assistantText"
import { blocksToMarkdown } from "@/lib/assistantMarkdown"
import { layoutReportCharts, reportChartKey } from "@/lib/reportChartLayout"
import { paginateResultRows, RESULT_PAGE_SIZE_OPTIONS, resultTotalPages } from "@/lib/resultPagination"
import {
  formatResultTableValue,
  getResultCellValue,
  getResultColumnAlignClass,
  getResultColumnClass,
  getResultColumnLabel,
  getSharedResultValue,
  getVisibleResultColumns,
  shouldTruncateResultColumn,
} from "@/lib/resultColumns"
import { resolveResultVisualization, type ResultView, type VisualizationDecision } from "@/lib/resultVisualization"

// ECharts 体积较大，仅在展示决策允许图表时加载对应代码块。
const ChatResultChart = defineAsyncComponent(() => import("@/components/chat/ChatResultChart.vue"))

const props = withDefaults(defineProps<{
  response?: ChatResponse
  pending?: boolean
  provisionalText?: string
  provisionalCharts?: BusinessReportChart[]
  fallbackText?: string
  question?: string
  clarificationResolved?: boolean
  showDebugButton?: boolean
  streamAnswer?: boolean
  showDataDetails?: boolean
}>(), { pending: false, fallbackText: "", question: "", clarificationResolved: false, showDebugButton: false, streamAnswer: false, showDataDetails: true })
// 预览和终态共用正文实例；附件只在正式交付后进入此处，不构造缺失的业务结果。
const response = computed<Partial<ChatResponse>>(() => props.pending ? {} : props.response ?? {})
const emptyVisualization: VisualizationDecision = { defaultView: "table", allowedViews: ["table"], points: [], reason: "" }
const emit = defineEmits<{ debug: []; answerStreamComplete: [] }>()
const visualization = computed(() => !props.pending && props.response
  ? resolveResultVisualization(props.response, props.question) : emptyVisualization)
const selectedResultView = ref<ResultView | null>(null)
const hasReportChart = computed(() => Boolean(response.value.analysis_report?.charts?.length))
const resultMode = computed<ResultView>(() => {
  if (hasReportChart.value) return "table"
  return selectedResultView.value && visualization.value.allowedViews.includes(selectedResultView.value)
    ? selectedResultView.value : visualization.value.defaultView
})
const resultPage = ref(1)
const resultPageSize = ref<number>(RESULT_PAGE_SIZE_OPTIONS[0])
const resultPageSizeOptions = RESULT_PAGE_SIZE_OPTIONS.map(value => ({ value, label: `${value} 条` }))
const isDownloading = ref(false)
const downloadError = ref("")
// 有图表或自然报告时先展示结论，完整明细仍可按需展开。
const isDataDetailsOpen = ref(Boolean(response.value.result?.table?.rows.length)
  && response.value.analysis_report?.body_mode !== "narrative" && resultMode.value === "table")
// Agent 先交付回执再异步读取结果；首批行到达时展开，后续更新不覆盖用户的折叠选择。
watch(() => [Boolean(response.value.result?.table?.rows.length), response.value.analysis_report?.body_mode] as const, ([hasRows, mode], [hadRows, oldMode]) => {
  if (mode === "narrative" && oldMode !== mode) isDataDetailsOpen.value = false
  else if (hasRows && !hadRows) isDataDetailsOpen.value = mode !== "narrative" && resultMode.value === "table"
})
const dataDetailsId = useId()
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
  const rows = response.value.result?.table?.rows ?? []
  if (!rows.length || !response.value.result?.table?.columns.includes("status")) return []
  const sample = rows[0] ?? {}
  const values = "left_org" in sample || "right_org" in sample
    ? ["ok", "ratio_unavailable"]
    : "current_value" in sample || "base_value" in sample
      ? ["ok", "current_missing", "base_missing", "base_zero"]
      : [...new Set(rows.map((row) => String(row.status)).filter((value) => value in statusLabels))]
  return values.map((value) => ({ value, label: statusLabels[value] }))
})
const showAnswer = computed(() => props.clarificationResolved || !response.value.clarification?.fields?.length)
const rawDisplayAnswer = computed(() => {
  if (response.value.clarification) return clarificationTranscript(response.value.clarification, response.value.answer ?? "")
  if (response.value.answer !== "已生成查询计划，等待执行。") return response.value.answer ?? props.fallbackText
  const count = response.value.result?.table?.rows.length
  return typeof count !== "number" ? response.value.answer ?? "" : count ? `查询完成，找到 ${count} 条记录。` : "查询完成，暂无匹配数据。"
})
// answerSource 保留 markdown 结构供块级渲染；displayAnswer 是纯文本副本，供复制等场景使用
const answerSource = computed(() => props.response ? stripInternalDisplayHints(rawDisplayAnswer.value) : rawDisplayAnswer.value)
// 服务端给出的结构化回答块；非空时渲染与复制都优先使用它
const responseBlocks = computed(() => response.value.answer_blocks?.length ? response.value.answer_blocks : null)
const displayAnswer = computed(() => responseBlocks.value ? flattenAssistantBlocks(responseBlocks.value) : answerSource.value)
const renderedAnswer = ref("")
const answerStreamComplete = ref(true)
let answerFrame = 0

function stopAnswerStream() {
  if (answerFrame) window.cancelAnimationFrame(answerFrame)
  answerFrame = 0
}

function renderAnswer(answer: string) {
  stopAnswerStream()
  if (!props.streamAnswer || response.value.clarification || answer.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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

// 流式结束后优先使用服务端结构化块；统一转成 markdown 交给同一渲染管线
const answerMarkdown = computed(() => answerStreamComplete.value && responseBlocks.value
  ? blocksToMarkdown(responseBlocks.value)
  : renderedAnswer.value.trim())
const resultRowCount = computed(() => response.value.result?.table?.rows.length ?? 0)
const hasResultRows = computed(() => resultRowCount.value > 0)
const hasDataToolbar = computed(() => props.showDataDetails && answerStreamComplete.value
  && Boolean(response.value.result?.table) && hasResultRows.value)
// 版本化报告按语义区块展示；旧消息与普通查数仍沿用原来的正文路径。
const analysisReport = computed(() => answerStreamComplete.value ? response.value.analysis_report : undefined)
const reportContent = computed(() => props.pending && props.provisionalText
  ? layoutReportCharts({ summary: props.provisionalText, sections: [], charts: props.provisionalCharts })
  : analysisReport.value ? layoutReportCharts(analysisReport.value) : undefined)
// 流式前缀和无分节终态共用同一图文列表，位置修正时只移动图表，不重新挂载。
const summaryParts = computed(() => {
  const content = reportContent.value
  if (!content) return []
  return content.sections.length ? content.summary : [
    ...content.summary,
    ...content.trailingCharts.map(chart => ({ kind: "chart" as const, key: reportChartKey(chart), chart })),
  ]
})
const trailingReportCharts = computed(() => reportContent.value?.sections.length ? reportContent.value.trailingCharts : [])
const narrativeReport = computed(() => analysisReport.value?.body_mode === "narrative")
const bodyMarkdown = computed(() => props.pending ? props.provisionalText ?? ""
  : analysisReport.value?.summary ?? (props.response ? answerMarkdown.value : props.fallbackText))
const showBody = computed(() => showAnswer.value && (!props.pending || Boolean(props.provisionalText)))
const bodyClass = computed(() => analysisReport.value
  ? ["report-flow", narrativeReport.value ? "leading-7" : "rounded-lg border border-border/70 bg-muted/20 p-4"]
  : props.pending ? "report-flow leading-7"
    : props.response ? "group/answer relative space-y-1.5 break-words leading-7 pr-9" : "leading-6")
// 自然报告的复制与明细入口共享一行，避免空正文容器撑开间距、悬浮按钮压到入口上。
const copyInDataToolbar = computed(() => narrativeReport.value && showAnswer.value
  && props.showDataDetails && answerStreamComplete.value && hasResultRows.value && Boolean(response.value.result?.table))
const defaultReportLayout = ["summary", "data", "analysis"] as const
type ReportBlock = typeof defaultReportLayout[number]
function reportBlockStyle(block: ReportBlock) {
  if (!analysisReport.value) return block === "analysis" ? { order: "-1" } : undefined
  const layout = analysisReport.value.layout?.length ? analysisReport.value.layout : defaultReportLayout
  const position = layout.indexOf(block)
  return { order: String(position < 0 ? defaultReportLayout.indexOf(block) : position) }
}
function reportLabel(key: "summary" | "data" | "analysis", fallback: string) {
  return analysisReport.value?.labels?.[key] ?? fallback
}
const resultRows = computed(() => response.value.result?.table?.rows ?? [])
const visibleResultColumns = computed(() => getVisibleResultColumns(
  response.value.result?.table?.columns ?? [],
  resultRows.value,
))
// 单指标结果把指标名称提到表头说明，表格只保留有区分度的列
const sharedMetricName = computed(() => visibleResultColumns.value.includes("metric_name")
  ? getSharedResultValue(resultRows.value, "metric_name")
  : null)
const resultColumns = computed(() => sharedMetricName.value
  ? visibleResultColumns.value.filter((column) => column !== "metric_name")
  : visibleResultColumns.value)
const resultPageCount = computed(() => resultTotalPages(resultRowCount.value, resultPageSize.value))
const paginatedResultRows = computed(() => paginateResultRows(resultRows.value, resultPage.value, resultPageSize.value))
const chartViews = computed(() => hasReportChart.value ? [] : visualization.value.allowedViews.filter((view): view is Exclude<ResultView, "table"> => view !== "table"))
const hasChartView = computed(() => chartViews.value.length > 0)
const activeChartView = computed<Exclude<ResultView, "table"> | null>(() => resultMode.value === "table" ? null : resultMode.value)
const chartWasLimited = computed(() => !hasChartView.value && visualization.value.reason.includes("超过"))

watch(
  [() => response.value.message_id, () => props.question],
  () => {
    selectedResultView.value = null
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

function selectResultView(view: ResultView) {
  selectedResultView.value = view
  isDataDetailsOpen.value = view === "table"
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
  const taskId = response.value.download?.task_id
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
    <!-- 正文始终位于同一父节点；预览、普通回答和自然报告只切换来源及现有样式。 -->
    <section v-show="showBody" :style="reportBlockStyle(analysisReport ? 'summary' : 'analysis')" :class="bodyClass" :aria-label="analysisReport ? '经营分析结论' : undefined" :aria-live="!pending && response.answer && !analysisReport ? 'polite' : undefined" :data-provisional-answer="pending && provisionalText ? '' : undefined">
      <h3 v-if="analysisReport && !narrativeReport" data-report-block="h3" class="font-semibold">{{ reportLabel('summary', '主要结论') }}</h3>
      <p v-if="analysisReport" data-report-block="p" class="break-words text-xs leading-6 text-muted-foreground">{{ analysisReport.scope }}</p>
      <BaseDisclosure v-if="!analysisReport && response.analysis_plan?.length" class="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-sm" trigger-class="font-medium">
        <template #trigger>分析思路</template>
        <ul class="mt-2 list-disc space-y-1 pl-5"><li v-for="question in [...new Set(response.analysis_plan)]" :key="question">{{ question }}</li></ul>
      </BaseDisclosure>
      <template v-if="reportContent">
        <template v-for="part in summaryParts" :key="part.key">
          <ChatMarkdown v-if="part.kind === 'markdown'" :tokens="part.tokens" :data-report-block="part.block" />
          <ChatResultChart v-else :report="part.chart" data-report-block="chart" />
        </template>
      </template>
      <ChatMarkdown v-else :source="bodyMarkdown" :class="!pending && !props.response && 'leading-6'" />
      <span v-if="pending && provisionalText || !answerStreamComplete" class="inline-block h-4 w-0.5 animate-pulse rounded-full bg-[#52789C] align-middle" aria-hidden="true" />
      <BaseTooltip v-if="!pending && props.response && !analysisReport && answerStreamComplete && answerMarkdown" :content="isAnswerCopied ? '已复制' : '复制回答'"><button type="button" class="absolute -top-1 right-0 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-all hover:bg-muted hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" :aria-label="isAnswerCopied ? '回答已复制' : '复制回答'" @click="copyAnswer"><Check v-if="isAnswerCopied" class="size-3.5 text-emerald-600" /><Copy v-else class="size-3.5" /></button></BaseTooltip>
    </section>
    <div v-if="answerStreamComplete && response.metric_definition" class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
      <span>指标依据：{{ response.metric_definition.metric_name }}</span>
      <span v-if="response.metric_definition.unit">· {{ response.metric_definition.unit }}</span>
    </div>

    <div v-if="showDataDetails && answerStreamComplete && response.result?.table" :style="reportBlockStyle('data')" class="flex min-w-0 flex-col gap-2">
      <h3 v-if="analysisReport && !narrativeReport && hasResultRows" class="font-semibold">{{ reportLabel('data', '关键数据') }}</h3>
      <div v-if="hasChartView" class="flex flex-wrap justify-end gap-1" role="group" aria-label="结果展示方式">
        <BaseButton size="sm" :variant="resultMode === 'table' ? 'secondary' : 'ghost'" class="h-7" @click="selectResultView('table')"><Table2 />表格</BaseButton>
        <BaseButton v-for="view in chartViews" :key="view" size="sm" :variant="resultMode === view ? 'secondary' : 'ghost'" class="h-7" @click="selectResultView(view)"><ChartColumn />{{ resultViewLabel(view) }}</BaseButton>
      </div>
      <ChatResultChart v-if="activeChartView" :decision="visualization" :view="activeChartView" />
      <div v-if="hasResultRows" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" role="group" aria-label="数据明细操作">
        <button type="button" class="inline-flex items-center gap-1 rounded-sm text-muted-foreground/75 underline-offset-4 transition-colors hover:text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" :aria-expanded="isDataDetailsOpen" :aria-controls="dataDetailsId" @click="isDataDetailsOpen = !isDataDetailsOpen">
          <Table2 class="size-3.5" />{{ isDataDetailsOpen ? "收起数据明细" : `查看 ${resultRowCount} 条数据明细` }}
        </button>
        <slot name="actions" />
        <BaseTooltip v-if="copyInDataToolbar && answerMarkdown" :content="isAnswerCopied ? '已复制' : '复制回答'"><button type="button" class="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-all hover:bg-muted hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" :aria-label="isAnswerCopied ? '回答已复制' : '复制回答'" @click="copyAnswer"><Check v-if="isAnswerCopied" class="size-3.5 text-emerald-600" /><Copy v-else class="size-3.5" /></button></BaseTooltip>
      </div>
      <div v-else class="flex items-start gap-2 border-y border-[#DCE3EF] py-2.5 text-xs text-[#66759B]" role="status">
        <Search class="mt-0.5 size-3.5 shrink-0" />
        <span><strong class="font-medium text-[#52638F]">当前条件下暂未查询到数据。</strong>{{ response.time_variants?.length ? "可以切换下方备选口径重新查询。" : "可以确认统计日期或机构名称，也可以扩大时间范围重新查询。" }}</span>
      </div>
      <div v-if="isDataDetailsOpen" :id="dataDetailsId" class="w-full min-w-0 max-w-full overflow-hidden border-y border-border/70">
        <div v-if="sharedMetricName" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-2 py-1.5">
          <BaseTooltip v-if="sharedMetricName" :content="sharedMetricName"><span tabindex="0" class="min-w-0 truncate px-1 text-xs text-muted-foreground">指标：{{ sharedMetricName }}</span></BaseTooltip>
        </div>
        <div class="min-w-0 max-w-full">
          <div class="max-h-[30rem] w-full min-w-0 max-w-full overflow-auto overscroll-x-contain">
            <table class="w-full min-w-max text-sm"><thead><tr class="border-b bg-muted/50"><th v-for="column in resultColumns" :key="column" class="sticky top-0 z-10 h-9 bg-muted/95 px-3 font-medium whitespace-nowrap backdrop-blur-sm" :class="[getResultColumnClass(column), getResultColumnAlignClass(column)]">{{ getResultColumnLabel(column) }}</th></tr></thead><tbody><tr v-for="(row, rowIndex) in paginatedResultRows" :key="(resultPage - 1) * resultPageSize + rowIndex" class="border-b last:border-b-0 hover:bg-muted/40"><td v-for="column in resultColumns" :key="column" class="px-3 py-2.5 align-top whitespace-nowrap" :class="[getResultColumnClass(column), getResultColumnAlignClass(column)]"><BaseBadge v-if="column === 'status' && getResultCellValue(row, column)" variant="outline" class="max-w-full"><BaseTooltip :content="String(formatCell(getResultCellValue(row, column), column, row))"><span tabindex="0" class="block truncate">{{ formatCell(getResultCellValue(row, column), column, row) }}</span></BaseTooltip></BaseBadge><!-- 显示值可能附带口径说明；允许完整换行，避免固定列宽下溢出到相邻列。 --><BaseTooltip v-else :content="shouldTruncateResultColumn(column) ? String(formatCell(getResultCellValue(row, column), column, row)) : undefined"><span tabindex="0" class="block" :class="shouldTruncateResultColumn(column) ? 'truncate' : 'whitespace-normal break-words [overflow-wrap:anywhere]'">{{ formatCell(getResultCellValue(row, column), column, row) }}</span></BaseTooltip></td></tr></tbody></table>
          </div>
          <div v-if="resultRowCount > RESULT_PAGE_SIZE_OPTIONS[0]" class="border-t border-border/70">
            <div class="flex justify-end px-3 pt-2">
              <label class="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">每页
                <BaseSelect v-model="resultPageSize" :options="resultPageSizeOptions" class="h-8 w-auto min-w-20 px-2 text-foreground" aria-label="每页显示条数" />
              </label>
            </div>
            <ListPagination :page="resultPage" :page-size="resultPageSize" :total-items="resultRowCount" :total-pages="resultPageCount" @change="resultPage = $event" />
          </div>
          <p v-if="chartWasLimited" class="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">数据量超出图表核实范围，本次仅展示分页表格。</p>
        </div>
      </div>
      <BaseDisclosure v-if="statusDefinitions.length" class="border-t border-border/70 pt-2 text-xs text-muted-foreground" trigger-class="select-none hover:text-foreground">
        <template #trigger>查看状态说明</template>
        <ul class="mt-1.5 space-y-1"><li v-for="item in statusDefinitions" :key="item.value"><code class="rounded bg-muted px-1 py-0.5 text-foreground">{{ item.value }}</code>：{{ item.label }}</li></ul>
      </BaseDisclosure>
    </div>

    <div v-else-if="answerStreamComplete && response.download" class="border-y border-border/70 py-3">
      <p class="font-medium">查询结果共 {{ response.download.row_count }} 条</p>
      <p class="mt-1 text-sm text-muted-foreground">数据量较大，完整明细请下载 Excel 查看。</p>
      <BaseButton class="mt-2" variant="ghost" size="sm" :disabled="isDownloading" @click="downloadResult"><LoaderCircle v-if="isDownloading" class="animate-spin" /><Download v-else />{{ isDownloading ? "正在生成..." : "下载 Excel" }}</BaseButton>
      <p v-if="downloadError" class="mt-2 text-sm text-destructive">{{ downloadError }}</p>
    </div>


    <div v-if="showAnswer && analysisReport && (!copyInDataToolbar || analysisReport.sections.length || trailingReportCharts.length)" :style="reportBlockStyle('analysis')" class="report-flow group/answer relative break-words leading-7" :class="!copyInDataToolbar && 'pr-9'" aria-live="polite">
      <template v-if="analysisReport">
        <section v-for="(section, index) in analysisReport.sections" :key="index" class="report-flow" data-report-block="section" :aria-label="section.title">
          <h3 class="font-semibold" data-report-block="h3">{{ section.title }}</h3>
          <template v-for="part in reportContent?.sections[index] ?? []" :key="part.key">
            <ChatMarkdown v-if="part.kind === 'markdown'" :tokens="part.tokens" :data-report-block="part.block" />
            <ChatResultChart v-else :report="part.chart" data-report-block="chart" />
          </template>
        </section>
        <ChatResultChart v-for="chart in trailingReportCharts" :key="reportChartKey(chart)"
          :report="chart" data-report-block="chart" />
        <!-- 必要限制由正文说明；来源、分析依据与完成状态保留在回执中，不额外渲染卡片。 -->
      </template>
      <BaseTooltip v-if="answerStreamComplete && answerMarkdown && !copyInDataToolbar" :content="isAnswerCopied ? '已复制' : '复制回答'"><button type="button" class="absolute -top-1 right-0 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-all hover:bg-muted hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" :aria-label="isAnswerCopied ? '回答已复制' : '复制回答'" @click="copyAnswer"><Check v-if="isAnswerCopied" class="size-3.5 text-emerald-600" /><Copy v-else class="size-3.5" /></button></BaseTooltip>
    </div>
    <p v-if="answerCopyError" class="text-xs text-[#78663E]">{{ answerCopyError }}</p>
    <div v-if="!pending && answerStreamComplete && !hasDataToolbar && $slots.actions" class="order-last flex flex-wrap items-center gap-3 text-xs">
      <slot name="actions" />
    </div>

    <div v-if="showDebugButton && response.debug"><BaseButton variant="outline" size="sm" @click="emit('debug')"><Bug />详细调试信息</BaseButton></div>
  </div>
</template>

<style scoped>
/* 报告块的外距只由此处负责；相邻块按较大外距合并，避免图表和正文重复留白。 */
.report-flow {
  display: flow-root;
}

.report-flow > [data-report-block] {
  margin-block: 0 12px;
}

.report-flow > [data-report-block="h1"],
.report-flow > [data-report-block="h2"] {
  margin-block: 24px 10px;
}

.report-flow > [data-report-block="h3"] {
  margin-block: 18px 8px;
}

.report-flow > [data-report-block="h4"],
.report-flow > [data-report-block="h5"],
.report-flow > [data-report-block="h6"] {
  margin-block: 16px 7px;
}

.report-flow > [data-report-block="table"] {
  margin-block: 14px 20px;
}

.report-flow > [data-report-block="ul"],
.report-flow > [data-report-block="ol"] {
  margin-block: 6px 14px;
}

.report-flow > [data-report-block="blockquote"] {
  margin-block: 16px;
}

.report-flow > [data-report-block="section"] {
  margin-block-start: 18px;
}

.report-flow > [data-report-block]:first-child {
  margin-block-start: 0;
}

.report-flow > [data-report-block]:not(:has(~ [data-report-block])) {
  margin-block-end: 0;
}

.report-flow > .chat-markdown :deep(> :first-child) {
  margin-block-start: 0;
}

.report-flow > .chat-markdown :deep(> :last-child) {
  margin-block-end: 0;
}
</style>
