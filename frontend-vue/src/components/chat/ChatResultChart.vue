<script setup lang="ts">
import { BarChart, LineChart } from "echarts/charts"
import { GridComponent, TooltipComponent } from "echarts/components"
import { init, use, type ECharts, type EChartsCoreOption } from "echarts/core"
import { CanvasRenderer } from "echarts/renderers"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

import { formatResultCellValue } from "@/lib/resultColumns"
import type { ResultView, VisualizationDecision } from "@/lib/resultVisualization"

use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{
  decision: VisualizationDecision
  view: Exclude<ResultView, "table">
}>()
const chartElement = ref<HTMLElement | null>(null)
let chart: ECharts | null = null
let resizeObserver: ResizeObserver | null = null

const chartHeight = computed(() => props.view === "horizontal_bar"
  ? Math.max(288, props.decision.points.length * 38 + 72)
  : 288)
const chartTitle = computed(() => {
  const category = props.decision.categoryLabel ?? "分类"
  const value = props.decision.valueLabel ?? "指标值"
  const unit = props.decision.unit ? `（${props.decision.unit}）` : ""
  return `${category} · ${value}${unit}`
})

const chartOption = computed<EChartsCoreOption | null>(() => {
  const { points, categoryLabel = "分类", valueField = "metric_value", valueLabel = "指标值", unit = "" } = props.decision
  if (!points.length) return null
  const tooltip = {
    trigger: "axis" as const,
    axisPointer: { type: props.view === "line" ? "line" : "shadow" },
    formatter: (items: unknown) => {
      const item = (Array.isArray(items) ? items[0] : items) as { dataIndex?: number; axisValueLabel?: string; value?: unknown } | undefined
      const point = typeof item?.dataIndex === "number" ? points[item.dataIndex] : undefined
      const value = point?.value ?? item?.value
      const formatted = formatResultCellValue(value, valueField, point?.row ?? {})
        ?? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value))
      return `<div style="min-width:120px"><div style="margin-bottom:6px;color:#71717a">${escapeHtml(categoryLabel)}：${escapeHtml(point?.label ?? item?.axisValueLabel ?? "-")}</div><div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#64748b;margin-right:7px"></span>${escapeHtml(valueLabel)}：<strong>${escapeHtml(formatted)}${unit ? ` ${escapeHtml(unit)}` : ""}</strong></div></div>`
    },
  }
  const series = {
    name: valueLabel,
    type: props.view === "line" ? "line" : "bar",
    data: points.map((point) => point.value),
    ...(props.view === "line"
      ? { smooth: true, symbolSize: 7, areaStyle: { opacity: 0.08 } }
      : {
          barMaxWidth: 34,
          itemStyle: { borderRadius: props.view === "horizontal_bar" ? [0, 4, 4, 0] : [4, 4, 0, 0] },
          label: props.view === "horizontal_bar"
            ? { show: true, position: "right", color: "#52525b", formatter: (item: { value?: unknown }) => formatAxisValue(item.value, unit) }
            : { show: false },
        }),
  }

  if (props.view === "horizontal_bar") {
    return {
      animationDuration: 350,
      color: ["#64748b"],
      tooltip,
      grid: { left: 20, right: 96, top: 20, bottom: 20, containLabel: true },
      xAxis: { type: "value", splitLine: { lineStyle: { color: "#e4e4e7" } } },
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
      boundaryGap: true,
      data: points.map((point) => point.label),
      axisLabel: { color: "#71717a", interval: 0, hideOverlap: true, width: 110, overflow: "truncate" },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#e4e4e7" } },
    },
    series: [series],
  }
})

function formatAxisValue(value: unknown, unit: string) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return "-"
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(numeric)}${unit ? ` ${unit}` : ""}`
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character)
}

async function renderChart() {
  await nextTick()
  if (!chartElement.value || !chartOption.value) return
  chart ??= init(chartElement.value)
  chart.setOption(chartOption.value, true)
  chart.resize()
}

onMounted(() => {
  void renderChart()
  if (chartElement.value) {
    resizeObserver = new ResizeObserver(() => chart?.resize())
    resizeObserver.observe(chartElement.value)
  }
})
watch(chartOption, () => { void renderChart() }, { deep: true })
onBeforeUnmount(() => { resizeObserver?.disconnect(); chart?.dispose() })
</script>

<template>
  <div v-if="chartOption" class="min-w-0 max-w-full overflow-hidden">
    <p class="truncate px-3 pt-2 text-xs text-muted-foreground" :title="chartTitle">{{ chartTitle }}</p>
    <div
      ref="chartElement"
      class="w-full max-w-full"
      :style="{ height: `${chartHeight}px` }"
      role="img"
      aria-label="问数结果图表"
    />
  </div>
  <p v-else class="py-10 text-center text-sm text-muted-foreground">当前结果无法生成图表。</p>
</template>
