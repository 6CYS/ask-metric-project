<script setup lang="ts">
import { Maximize2 } from "@lucide/vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseModal from "@/components/ui/BaseModal.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from "echarts/charts"
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
} from "echarts/components"
import { init, use, type ECharts, type EChartsCoreOption } from "echarts/core"
import { LabelLayout } from "echarts/features"
import { CanvasRenderer } from "echarts/renderers"
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue"

import { formatResultCellValue } from "@/lib/resultColumns"
import type { ResultView, VisualizationDecision } from "@/lib/resultVisualization"
import {
  businessChartOption,
  businessReportDimensions,
  defaultReportChartView,
  reportChartViews,
  type ReportChartView,
} from "@/lib/businessReportChart"
import type { BusinessPieChart, BusinessReportChart, BusinessSeriesChart } from "@/types/api"

use([
  LineChart,
  BarChart,
  PieChart,
  RadarChart,
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
  LabelLayout,
  CanvasRenderer,
])

const props = defineProps<{
  decision?: VisualizationDecision
  view?: Exclude<ResultView, "table">
  pie?: BusinessPieChart
  series?: BusinessSeriesChart
  report?: BusinessReportChart
}>()
const chartElement = ref<HTMLElement | null>(null)
const expandedHost = ref<HTMLElement | null>(null)
const expandButton = ref<ComponentPublicInstance | null>(null)
const expanded = ref(false)
const selectedView = ref<ReportChartView | null>(null)
const chartWidth = ref(860)
const renderError = ref(false)
let disposed = false
let lastRenderedKey = ""
let lastIdentity = ""
let chart: ECharts | null = null
let resizeObserver: ResizeObserver | null = null

const reportChart = computed(() => props.report ?? props.pie ?? props.series)
const viewChoices = computed(() => (reportChart.value ? reportChartViews(reportChart.value) : []))
const viewOptions = computed(() =>
  viewChoices.value.map((choice) => ({
    value: choice.value,
    label: choice.label,
    description:
      choice.status === "recommended"
        ? "推荐"
        : choice.status === "available"
          ? undefined
          : choice.reason,
    disabled: choice.disabled,
  })),
)
const activeReportView = computed(() =>
  reportChart.value ? (selectedView.value ?? defaultReportChartView(reportChart.value)) : null,
)
const activeViewLabel = computed(
  () =>
    viewChoices.value.find((choice) => choice.value === activeReportView.value)?.label ?? "图表",
)
const activeViewNote = computed(() => {
  const choice = viewChoices.value.find((item) => item.value === activeReportView.value)
  return choice?.status === "caution" ? choice.reason : undefined
})
watch(reportChart, () => {
  if (!viewChoices.value.some((choice) => choice.value === selectedView.value && !choice.disabled))
    selectedView.value = null
})
const reportDimensions = computed(() =>
  reportChart.value ? businessReportDimensions(reportChart.value) : undefined,
)
const chartHeight = computed(() =>
  expanded.value
    ? 560
    : (reportDimensions.value?.height ??
      (props.view === "horizontal_bar"
        ? Math.max(288, (props.decision?.points.length ?? 0) * 38 + 72)
        : 288)),
)
const chartDateLabel = computed(() => {
  const report = reportChart.value
  if (!report) return ""
  if (report.type === "pie") return displayDate(report.date)
  const first = report.dates[0]
  if (!first) return ""
  const last = report.dates[report.dates.length - 1] ?? first
  return first === last ? displayDate(first) : `${displayDate(first)}—${displayDate(last)}`
})
const chartHeading = computed(() =>
  reportChart.value?.title
    .replace(/^[一二三四五六七八九十百]+、\s*/, "")
    .replace(/（文中机构）$/, ""),
)
const chartTitle = computed(() => {
  const report = reportChart.value
  if (report) return `${chartHeading.value} · ${chartDateLabel.value}`
  const category = props.decision?.categoryLabel ?? "分类"
  const value = props.decision?.valueLabel ?? "指标值"
  const unit = props.decision?.unit ? `（${props.decision.unit}）` : ""
  return `${category} · ${value}${unit}`
})

const chartOption = computed<EChartsCoreOption | null>(() => {
  const report = reportChart.value
  if (report && activeReportView.value)
    return businessChartOption(report, activeReportView.value, {
      width: chartWidth.value,
      height: chartHeight.value,
    })
  if (!props.decision || !props.view) return null
  const {
    points,
    categoryLabel = "分类",
    valueField = "metric_value",
    valueLabel = "指标值",
    unit = "",
  } = props.decision
  if (!points.length) return null
  const tooltip = {
    trigger: "axis" as const,
    axisPointer: { type: props.view === "line" ? "line" : "shadow" },
    formatter: (items: unknown) => {
      const item = (Array.isArray(items) ? items[0] : items) as
        { dataIndex?: number; axisValueLabel?: string; value?: unknown } | undefined
      const point = typeof item?.dataIndex === "number" ? points[item.dataIndex] : undefined
      const value = point?.value ?? item?.value
      const formatted =
        formatResultCellValue(value, valueField, point?.row ?? {}) ??
        new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value))
      return `<div style="min-width:120px"><div style="margin-bottom:6px;color:#71717a">${escapeHtml(categoryLabel)}：${escapeHtml(point?.label ?? item?.axisValueLabel ?? "-")}</div><div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#64748b;margin-right:7px"></span>${escapeHtml(valueLabel)}：<strong>${escapeHtml(formatted)}${unit ? ` ${escapeHtml(unit)}` : ""}</strong></div></div>`
    },
  }
  const series = {
    name: valueLabel,
    type: props.view === "line" ? "line" : "bar",
    data: points.map((point) => point.value),
    ...(props.view === "line"
      ? { smooth: false, symbolSize: 7, areaStyle: { opacity: 0.08 } }
      : {
          barMaxWidth: 34,
          itemStyle: {
            borderRadius: props.view === "horizontal_bar" ? [0, 4, 4, 0] : [4, 4, 0, 0],
          },
          label:
            props.view === "horizontal_bar"
              ? {
                  show: true,
                  position: "right",
                  color: "#52525b",
                  formatter: (item: { value?: unknown }) => formatAxisValue(item.value, unit),
                }
              : { show: false },
        }),
  }

  if (props.view === "horizontal_bar") {
    return {
      animationDuration: 350,
      color: ["#64748b"],
      tooltip,
      grid: { left: 20, right: 96, top: 20, bottom: 20, containLabel: true },
      xAxis: { type: "value", name: unit, splitLine: { lineStyle: { color: "#e4e4e7" } } },
      yAxis: {
        type: "category",
        inverse: true,
        data: points.map((point) => point.label),
        axisLabel: { color: "#52525b", width: 150, overflow: "truncate" },
      },
      series: [series],
    }
  }

  return {
    animationDuration: 350,
    color: ["#64748b"],
    tooltip,
    grid: { left: 24, right: 32, top: 24, bottom: 24, containLabel: true },
    xAxis: {
      type: "category",
      boundaryGap: props.view !== "line",
      data: points.map((point) => point.label),
      axisLabel: {
        color: "#71717a",
        interval: 0,
        hideOverlap: true,
        width: 110,
        overflow: "truncate",
      },
    },
    yAxis: {
      type: "value",
      name: unit,
      splitLine: { lineStyle: { color: "#e4e4e7" } },
    },
    series: [series],
  }
})

function displayDate(value: string) {
  return value.replace(
    /^(\d{4})-(\d{2})-(\d{2})$/,
    (_match, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`,
  )
}

function formatAxisValue(value: unknown, unit: string) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return "-"
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(numeric)}${unit ? ` ${unit}` : ""}`
}

function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character] ?? character,
  )
}

// 段落位置变化不触发重绘；流式追加沿用同一图实例与用户交互。
const renderKey = computed(() =>
  JSON.stringify({
    report: reportChart.value
      ? Object.fromEntries(Object.entries(reportChart.value).filter(([key]) => key !== "placement"))
      : undefined,
    decision: props.decision,
    view: activeReportView.value ?? props.view,
    width: chartWidth.value,
    height: chartHeight.value,
  }),
)
const chartIdentity = computed(() =>
  reportChart.value
    ? JSON.stringify([
        reportChart.value.type,
        reportChart.value.source_refs,
        activeReportView.value,
      ])
    : JSON.stringify([props.view, props.decision]),
)

function retainedInteraction() {
  if (!chart || lastIdentity !== chartIdentity.value) return {}
  const previous = chart.getOption()
  const legends = Array.isArray(previous.legend) ? previous.legend : []
  const zooms = Array.isArray(previous.dataZoom) ? previous.dataZoom : []
  const selected = legends.flatMap((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("selected" in item) ||
      !item.selected ||
      typeof item.selected !== "object"
    )
      return []
    return [item.selected]
  })
  const zoom = zooms.flatMap((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("start" in item) ||
      !("end" in item) ||
      typeof item.start !== "number" ||
      typeof item.end !== "number"
    )
      return []
    return [{ start: item.start, end: item.end }]
  })
  return { selected, zoom }
}

async function renderChart() {
  await nextTick()
  if (disposed || !chartElement.value || !chartOption.value) return
  const width = Math.round(chartElement.value.clientWidth)
  if (width <= 0) return
  if (width !== chartWidth.value) {
    chartWidth.value = width
    return
  }
  if (chart && lastRenderedKey === renderKey.value) {
    chart.resize()
    return
  }
  const interaction = retainedInteraction()
  chart ??= init(chartElement.value)
  chart.setOption(chartOption.value, { notMerge: true })
  interaction.selected?.forEach((selected) => chart?.setOption({ legend: { selected } }))
  interaction.zoom?.forEach((zoom, index) =>
    chart?.dispatchAction({ type: "dataZoom", dataZoomIndex: index, ...zoom }),
  )
  chart.resize()
  lastRenderedKey = renderKey.value
  lastIdentity = chartIdentity.value
  renderError.value = false
}

function scheduleRender() {
  renderChart().catch(() => {
    if (!disposed) renderError.value = true
  })
}

async function restoreExpandFocus(event: Event) {
  event.preventDefault()
  // 放大时按钮被移除，需等原位按钮重新挂载后恢复焦点。
  await nextTick()
  if (disposed || expanded.value) return
  const element: unknown = expandButton.value?.$el
  if (element instanceof HTMLElement) element.focus({ preventScroll: true })
}

function retryRender() {
  chart?.dispose()
  chart = null
  lastRenderedKey = ""
  scheduleRender()
}

onMounted(() => {
  scheduleRender()
  if (chartElement.value) {
    resizeObserver = new ResizeObserver(scheduleRender)
    resizeObserver.observe(chartElement.value)
  }
})
watch(renderKey, scheduleRender)
watch([expanded, expandedHost], scheduleRender, { flush: "post" })
onBeforeUnmount(() => {
  disposed = true
  resizeObserver?.disconnect()
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div
    v-if="chartOption"
    class="w-full min-w-0 rounded-md border border-[#e2e8f0] bg-white p-3"
    :style="{ maxWidth: `${reportDimensions?.maxWidth ?? 860}px` }"
  >
    <div :style="expanded ? { minHeight: `${reportDimensions?.height ?? 320}px` } : undefined">
      <Teleport :to="expandedHost ?? 'body'" :disabled="!expanded || !expandedHost">
        <div class="min-w-0 w-full">
          <div class="flex min-h-9 flex-wrap items-center gap-2 pb-2">
            <div v-if="!expanded" class="min-w-0 flex-1">
              <BaseTooltip :content="chartTitle">
                <p tabindex="0" class="text-sm leading-5 font-medium break-words text-slate-700">
                  {{ chartHeading ?? chartTitle }}
                </p>
              </BaseTooltip>
              <p v-if="chartDateLabel" class="mt-0.5 text-xs leading-5 text-muted-foreground">
                {{ chartDateLabel }}
              </p>
            </div>
            <div v-if="reportChart" class="ml-auto flex shrink-0 items-center gap-2">
              <BaseSelect
                :model-value="activeReportView"
                :options="viewOptions"
                class="h-8 w-28 text-xs"
                content-width="20rem"
                aria-label="图表类型"
                @update:model-value="selectedView = $event"
              />
              <BaseTooltip v-if="!expanded" content="放大图表">
                <BaseButton
                  ref="expandButton"
                  variant="outline"
                  size="sm"
                  aria-label="放大图表"
                  @click="expanded = true"
                  ><Maximize2 />放大</BaseButton
                >
              </BaseTooltip>
            </div>
          </div>
          <p v-if="activeViewNote" class="pb-2 text-xs leading-5 text-muted-foreground">
            {{ activeViewNote }}
          </p>
          <div class="relative">
            <div
              ref="chartElement"
              class="w-full max-w-full"
              :style="{ height: `${chartHeight}px` }"
              role="img"
              :aria-label="reportChart ? `${chartTitle}，${activeViewLabel}` : '问数结果图表'"
            />
            <div
              v-if="renderError"
              class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 text-sm text-muted-foreground"
              role="alert"
            >
              <p>图表暂时无法显示。</p>
              <BaseButton variant="outline" size="sm" @click="retryRender">重试</BaseButton>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
    <BaseModal
      v-model:open="expanded"
      :title="chartTitle"
      description="可切换图形或查看完整数据，按 Esc 关闭。"
      size="xl"
      @close-auto-focus="restoreExpandFocus"
    >
      <div ref="expandedHost" class="min-h-80 w-full" />
    </BaseModal>
  </div>
  <p v-else class="py-10 text-center text-sm text-muted-foreground">当前结果无法生成图表。</p>
</template>
