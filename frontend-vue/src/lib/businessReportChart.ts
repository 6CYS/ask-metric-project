import type { EChartsCoreOption } from "echarts/core"
import type { BusinessGroupedChart, BusinessReportChart, BusinessSeriesChart } from "@/types/api"
import { businessPieOption, isBusinessPieChart, selectedValuesPieOption } from "./businessPieChart"
import {
  businessChartColors,
  businessChartGridColor,
  businessChartTextColor,
  businessChartTextStyle,
  organizationColor,
} from "./businessChartStyle"

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim())
const date = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
const numeric = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
  Number.isFinite(Number(value))

export function isBusinessSeriesChart(value: unknown): value is BusinessSeriesChart {
  if (!value || typeof value !== "object") return false
  const chart = value as Partial<BusinessSeriesChart>
  if (
    !["bar", "line"].includes(chart.type ?? "") ||
    !nonempty(chart.title) ||
    !nonempty(chart.unit) ||
    !Array.isArray(chart.dates) ||
    !chart.dates.length ||
    !chart.dates.every(date) ||
    new Set(chart.dates).size !== chart.dates.length ||
    !Array.isArray(chart.points) ||
    chart.points.length < 2 ||
    chart.points.length > 24 ||
    !Array.isArray(chart.source_refs) ||
    chart.source_refs.length !== chart.points.length ||
    !chart.source_refs.every(nonempty) ||
    new Set(chart.source_refs).size !== chart.source_refs.length
  )
    return false
  if (chart.type === "bar" && chart.dates.length !== 1) return false
  if (
    chart.type === "line" &&
    (chart.dates.length !== chart.points.length ||
      chart.points.some((point, index) => point?.name !== chart.dates![index]) ||
      chart.dates.some((day, index) => index > 0 && day <= chart.dates![index - 1]!))
  )
    return false
  return (
    chart.points.every(
      (point) => point && nonempty(point.name) && nonempty(point.display) && numeric(point.value),
    ) && new Set(chart.points.map((point) => point.name)).size === chart.points.length
  )
}

/** 来源与完整矩形一一对应；缺组合只能保留缺口，不能在前端补零。 */
export function isBusinessGroupedChart(value: unknown): value is BusinessGroupedChart {
  if (!value || typeof value !== "object") return false
  const chart = value as Partial<BusinessGroupedChart>
  if (
    chart.type !== "grouped_bar" ||
    !nonempty(chart.title) ||
    !nonempty(chart.unit) ||
    !Array.isArray(chart.dates) ||
    chart.dates.length !== 1 ||
    !chart.dates.every(date) ||
    !Array.isArray(chart.categories) ||
    chart.categories.length < 2 ||
    !chart.categories.every(nonempty) ||
    new Set(chart.categories).size !== chart.categories.length ||
    !Array.isArray(chart.series) ||
    chart.series.length < 2 ||
    chart.series.length * chart.categories.length > 24 ||
    !Array.isArray(chart.source_refs) ||
    chart.source_refs.length !== chart.series.length * chart.categories.length ||
    !chart.source_refs.every(nonempty) ||
    new Set(chart.source_refs).size !== chart.source_refs.length
  )
    return false
  const categoryCount = chart.categories.length
  return (
    chart.series.every(
      (series) =>
        series &&
        nonempty(series.name) &&
        Array.isArray(series.points) &&
        series.points.length === categoryCount &&
        series.points.every((point) => point && numeric(point.value) && nonempty(point.display)),
    ) && new Set(chart.series.map((series) => series.name)).size === chart.series.length
  )
}

export function isBusinessReportChart(value: unknown): value is BusinessReportChart {
  return isBusinessPieChart(value) || isBusinessSeriesChart(value) || isBusinessGroupedChart(value)
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
  )

function wrapLabel(value: string, size: number): string {
  const characters = [...value]
  const lines: string[] = []
  for (let index = 0; index < characters.length; index += size)
    lines.push(characters.slice(index, index + size).join(""))
  return lines.join("\n")
}

export function businessReportDimensions(chart: BusinessReportChart): {
  height: number
  maxWidth: number
} {
  if (chart.type === "pie") return { height: 340, maxWidth: 720 }
  if (chart.type === "line") return { height: 288, maxWidth: 860 }
  if (chart.type === "bar" && chart.points.length >= 2 && chart.points.length <= 3)
    return { height: 280, maxWidth: 860 }
  return { height: 340, maxWidth: 860 }
}

function valueScale(unit: string, values: string[]) {
  const powers = new Map([
    ["元", 1],
    ["万元", 10000],
    ["亿元", 100000000],
  ])
  const power = powers.get(unit)
  const maximum = power ? Math.max(...values.map((value) => Math.abs(Number(value)) * power)) : 0
  const displayUnit = power
    ? maximum >= 100000000
      ? "亿元"
      : maximum >= 10000
        ? "万元"
        : "元"
    : unit
  return { unit: displayUnit, factor: power ? power / (powers.get(displayUnit) ?? 1) : 1 }
}

function valueAxis(unit: string) {
  return {
    type: "value" as const,
    name: unit,
    nameTextStyle: { fontSize: 12, color: businessChartTextColor },
    nameGap: 16,
    axisLabel: { fontSize: 12, color: businessChartTextColor, margin: 12 },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: businessChartGridColor } },
    boundaryGap: ["16%", "16%"],
  }
}

function pointLabels(points: Array<{ display: string }>) {
  return {
    show: true,
    position: "outside" as const,
    distance: 10,
    fontSize: 11,
    lineHeight: 18,
    color: businessChartTextColor,
    formatter: (item: { dataIndex: number }) => points[item.dataIndex]?.display ?? "",
  }
}

export function businessSeriesOption(chart: BusinessSeriesChart): EChartsCoreOption | null {
  return businessChartOption(chart, defaultReportChartView(chart))
}

export function businessGroupedOption(chart: BusinessGroupedChart): EChartsCoreOption | null {
  return businessChartOption(chart, defaultReportChartView(chart))
}

export type ReportChartView =
  "bar" | "horizontal_bar" | "line" | "area" | "pie" | "donut" | "radar" | "scatter"
export type ReportChartViewStatus = "recommended" | "available" | "caution" | "disabled"

const viewLabels: Record<ReportChartView, string> = {
  bar: "柱状图",
  horizontal_bar: "条形图",
  line: "折线图",
  area: "面积图",
  pie: "饼图",
  donut: "环形图",
  radar: "雷达图",
  scatter: "散点图",
}

function selectedValuesPieDisabledReason(chart: BusinessReportChart): string | undefined {
  if (chart.type !== "bar") return "饼图需要单指标机构数值或已核验的完整组成"
  if (chart.category_kind !== "organization") return "来源缺少机构分类依据，无法计算所选机构占比"
  const unit = chart.unit.trim()
  if (["%", "％", "百分比", "百分点", "个百分点"].includes(unit))
    return "比例和百分点不能相加计算机构占比"
  if (!/^(?:千|万|百万|千万|亿)?(?:元|户|人|个|家|笔|张|件|次|台|份)$/.test(unit))
    return "仅金额或数量指标适合计算所选机构合计占比"
  if (chart.points.some((point) => Number(point.value) < 0)) return "含负值的指标不适合饼图"
  const total = chart.points.reduce((sum, point) => sum + Number(point.value), 0)
  if (!Number.isFinite(total) || total <= 0) return "机构数值合计必须大于零且在可展示范围内"
  return undefined
}

export function reportChartViews(chart: BusinessReportChart): Array<{
  value: ReportChartView
  label: string
  status: ReportChartViewStatus
  disabled?: boolean
  reason: string
}> {
  const valid = isBusinessReportChart(chart)
  const grouped = chart.type === "grouped_bar"
  const recommended = defaultReportChartView(chart)
  return (Object.keys(viewLabels) as ReportChartView[]).map((value) => {
    let status: ReportChartViewStatus = value === recommended ? "recommended" : "available"
    let reason =
      value === recommended
        ? chart.type === "line"
          ? "按真实日期顺序展示变化"
          : chart.type === "pie"
            ? "展示已核验的完整组成"
            : "适合比较不同类别的数值"
        : "可切换为此图形展示"
    let disabledReason: string | undefined
    if (!valid) disabledReason = "图表数据不完整，无法切换展示"
    else if ((value === "line" || value === "area") && chart.type !== "line") {
      status = "caution"
      reason = "分类连线不代表时间趋势"
    } else if ((value === "pie" || value === "donut") && chart.type !== "pie") {
      disabledReason = selectedValuesPieDisabledReason(chart)
      if (!disabledReason && chart.type === "bar") {
        status = "caution"
        reason = "占所选机构合计，不代表全行业占比"
        if (chart.points.length > 8) reason += "；类别较多，建议使用柱状图"
      }
    } else if (value === "radar") {
      if (!grouped || chart.categories.length < 3 || chart.categories.length > 8)
        disabledReason = "雷达图需要 3 至 8 个同单位指标的完整机构对比"
      else if (
        chart.series.some((series) => series.points.some((point) => Number(point.value) < 0))
      )
        disabledReason = "雷达图不适用于含负值的指标"
    } else if (value === "scatter" && (!grouped || chart.categories.length !== 2))
      disabledReason = "散点图需要各机构恰好两个指标的完整配对"
    return {
      value,
      label: viewLabels[value],
      status,
      reason,
      ...(disabledReason
        ? { status: "disabled" as const, disabled: true, reason: disabledReason }
        : {}),
    }
  })
}

const categorySlotMaxWidth = 120

function categoryLabelWidth(name: string): number {
  return [...name].reduce(
    (total, character) => total + ((character.codePointAt(0) ?? 0) > 255 ? 12 : 7.2),
    0,
  )
}

export function defaultReportChartView(chart: BusinessReportChart): ReportChartView {
  if (chart.type === "pie") return "donut"
  if (chart.type === "line") return "line"
  if (chart.type === "grouped_bar")
    return chart.series.some((series) => series.points.some((point) => Number(point.value) < 0))
      ? "horizontal_bar"
      : "bar"
  // 机构标签沿用类目布局的宽度估算；横向展示避免长名称挤占数值比较空间。
  return chart.points.some((point) => Number(point.value) < 0) ||
    (chart.category_kind === "organization" &&
      chart.points.some((point) => categoryLabelWidth(point.name) > categorySlotMaxWidth))
    ? "horizontal_bar"
    : "bar"
}

type ChartSize = { width?: number; height?: number }
type ChartPoint = { value: string; display: string }
type ChartMatrix = { categories: string[]; series: Array<{ name: string; points: ChartPoint[] }> }

function chartMatrix(chart: BusinessReportChart): ChartMatrix {
  return chart.type === "grouped_bar"
    ? { categories: chart.categories, series: chart.series }
    : {
        categories: chart.points.map((point) => point.name),
        series: [{ name: chart.title, points: chart.points }],
      }
}

function tooltipIndex(item: unknown, key: "dataIndex" | "seriesIndex"): number | undefined {
  if (!item || typeof item !== "object" || !(key in item)) return undefined
  const index = (item as Record<string, unknown>)[key]
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined
}

function matrixTooltip(matrix: ChartMatrix, item: unknown): string {
  const index = tooltipIndex(item, "dataIndex")
  const series = index === undefined ? undefined : matrix.series[index]
  return series
    ? [
        escapeHtml(series.name),
        ...series.points.map(
          (point, pointIndex) =>
            `${escapeHtml(matrix.categories[pointIndex] ?? "")}：<strong>${escapeHtml(point.display)}</strong>`,
        ),
      ].join("<br/>")
    : ""
}

function chartLegend(names: string[]) {
  return {
    type: "scroll" as const,
    top: 0,
    left: 12,
    right: 12,
    itemGap: 20,
    textStyle: { color: businessChartTextColor, fontSize: 12 },
    data: names,
    tooltip: {
      show: true,
      confine: true,
      formatter: (item: { name: string }) => escapeHtml(item.name),
    },
  }
}

function measuredCategoryLayout(matrix: ChartMatrix, horizontal: boolean, size: ChartSize) {
  const width = Number.isFinite(size.width) && (size.width ?? 0) > 0 ? size.width! : 860
  const height = Number.isFinite(size.height) && (size.height ?? 0) > 0 ? size.height! : 340
  const labelWidth = Math.max(...matrix.categories.map(categoryLabelWidth))
  const slotWidth = Math.max(
    48,
    Math.min(categorySlotMaxWidth, labelWidth + 12),
    matrix.series.length * 42,
  )
  const plotWidth = Math.max(96, width - 104)
  const capacity = horizontal
    ? Math.max(2, Math.floor((height - 112) / Math.max(38, matrix.series.length * 22 + 16)))
    : Math.max(2, Math.min(16, Math.floor(plotWidth / slotWidth)))
  const visibleCount = Math.min(matrix.categories.length, capacity)
  return {
    visibleCount,
    wrapAt: horizontal
      ? Math.max(6, Math.min(18, Math.floor((width * 0.28) / 12)))
      : Math.max(4, Math.floor(plotWidth / visibleCount / 12) - 1),
    needsWindow: visibleCount < matrix.categories.length,
  }
}

function cartesianOption(
  chart: BusinessReportChart,
  view: ReportChartView,
  size: ChartSize,
): EChartsCoreOption {
  const matrix = chartMatrix(chart)
  const horizontal = view === "horizontal_bar"
  const line = view === "line" || view === "area"
  const grouped = matrix.series.length > 1
  const { unit, factor } = valueScale(
    chart.unit,
    matrix.series.flatMap((series) => series.points.map((point) => point.value)),
  )
  const layout = measuredCategoryLayout(matrix, horizontal, size)
  const categories = {
    type: "category",
    data: [...matrix.categories],
    ...(horizontal ? { inverse: true } : { boundaryGap: !line }),
    axisTick: { show: false },
    axisLine: { lineStyle: { color: businessChartGridColor } },
    axisLabel: {
      interval: 0,
      fontSize: 12,
      lineHeight: 18,
      color: businessChartTextColor,
      margin: 12,
      hideOverlap: true,
      formatter: (value: string) => wrapLabel(value, layout.wrapAt),
    },
  }
  const axisWindow = horizontal ? { yAxisIndex: 0 } : { xAxisIndex: 0 }
  const windowRange = {
    ...axisWindow,
    startValue: 0,
    endValue: layout.visibleCount - 1,
    filterMode: "none",
  }
  return {
    animationDuration: 300,
    backgroundColor: "#FFFFFF",
    color: [...businessChartColors],
    textStyle: businessChartTextStyle,
    ...(grouped ? { legend: chartLegend(matrix.series.map((series) => series.name)) } : {}),
    grid: {
      left: 12,
      right: horizontal ? 88 : 32,
      top: grouped ? 56 : 32,
      bottom: layout.needsWindow && !horizontal ? 64 : 16,
      containLabel: true,
    },
    xAxis: horizontal ? valueAxis(unit) : categories,
    yAxis: horizontal ? categories : valueAxis(unit),
    ...(layout.needsWindow
      ? {
          dataZoom: [
            { type: "inside", ...windowRange },
            {
              type: "slider",
              ...windowRange,
              showDataShadow: false,
              brushSelect: false,
              ...(horizontal
                ? { right: 8, width: 16, top: grouped ? 56 : 32, bottom: 16 }
                : { bottom: 8, height: 16 }),
            },
          ],
        }
      : {}),
    tooltip: {
      trigger: "axis",
      confine: true,
      axisPointer: { type: line ? "line" : "shadow" },
      formatter: (items: unknown) => {
        const params: unknown[] = Array.isArray(items) ? items : [items]
        const lines: string[] = []
        let category: string | undefined
        for (const item of params) {
          const dataIndex = tooltipIndex(item, "dataIndex")
          const seriesIndex = tooltipIndex(item, "seriesIndex") ?? (grouped ? undefined : 0)
          const series = seriesIndex === undefined ? undefined : matrix.series[seriesIndex]
          const point = dataIndex === undefined ? undefined : series?.points[dataIndex]
          if (!series || !point || dataIndex === undefined) continue
          category ??= matrix.categories[dataIndex]
          lines.push(
            `${grouped ? `${escapeHtml(series.name)}：` : ""}<strong>${escapeHtml(point.display)}</strong>`,
          )
        }
        return lines.length ? `${escapeHtml(category ?? "")}<br/>${lines.join("<br/>")}` : ""
      },
    },
    series: matrix.series.map((series) => ({
      name: series.name,
      type: line ? "line" : "bar",
      data: series.points.map((point) => Number(point.value) * factor),
      ...(grouped
        ? { itemStyle: { color: organizationColor(series.name) } }
        : chart.type === "bar" && chart.category_kind === "organization"
          ? {
              itemStyle: {
                color: (item: { dataIndex: number }) =>
                  organizationColor(matrix.categories[item.dataIndex] ?? ""),
              },
            }
          : {}),
      label: {
        ...pointLabels(series.points),
        ...(line ? { position: "top" } : {}),
      },
      labelLayout: { hideOverlap: true },
      ...(line
        ? {
            smooth: false,
            symbolSize: 6,
            ...(view === "area" ? { areaStyle: { opacity: 0.18 } } : {}),
          }
        : { barMaxWidth: grouped ? 28 : 42, barGap: "100%", barCategoryGap: "38%" }),
    })),
  }
}

function radarOption(chart: BusinessGroupedChart): EChartsCoreOption {
  const matrix = chartMatrix(chart)
  const { unit, factor } = valueScale(
    chart.unit,
    chart.series.flatMap((series) => series.points.map((point) => point.value)),
  )
  const maximum = Math.max(
    1,
    ...chart.series.flatMap((series) => series.points.map((point) => Number(point.value) * factor)),
  )
  return {
    animationDuration: 300,
    backgroundColor: "#FFFFFF",
    color: [...businessChartColors],
    textStyle: businessChartTextStyle,
    legend: chartLegend(chart.series.map((series) => series.name)),
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (item: unknown) => matrixTooltip(matrix, item),
    },
    radar: {
      center: ["50%", "54%"],
      radius: "60%",
      indicator: chart.categories.map((name) => ({
        name: `${wrapLabel(name, 10)}（${unit}）`,
        min: 0,
        max: maximum,
      })),
      axisName: { fontSize: 12, color: businessChartTextColor },
      axisNameGap: 12,
      axisLine: { lineStyle: { color: businessChartGridColor } },
      splitLine: { lineStyle: { color: businessChartGridColor } },
      splitArea: { show: false },
    },
    series: [
      {
        type: "radar",
        areaStyle: { opacity: 0.08 },
        symbolSize: 5,
        data: chart.series.map((series) => ({
          name: series.name,
          value: series.points.map((point) => Number(point.value) * factor),
          itemStyle: { color: organizationColor(series.name) },
          lineStyle: { color: organizationColor(series.name) },
          areaStyle: { color: organizationColor(series.name) },
        })),
      },
    ],
  }
}

function scatterOption(chart: BusinessGroupedChart): EChartsCoreOption {
  const matrix = chartMatrix(chart)
  const { unit, factor } = valueScale(
    chart.unit,
    chart.series.flatMap((series) => series.points.map((point) => point.value)),
  )
  return {
    animationDuration: 300,
    backgroundColor: "#FFFFFF",
    color: [...businessChartColors],
    textStyle: businessChartTextStyle,
    legend: chartLegend(chart.series.map((series) => series.name)),
    grid: { left: 24, right: 40, top: 72, bottom: 56, containLabel: true },
    xAxis: {
      ...valueAxis(unit),
      name: `${chart.categories[0]}（${unit}）`,
      nameLocation: "middle",
      nameGap: 32,
    },
    yAxis: { ...valueAxis(unit), name: `${chart.categories[1]}（${unit}）` },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (item: unknown) =>
        matrixTooltip(matrix, { dataIndex: tooltipIndex(item, "seriesIndex") }),
    },
    series: chart.series.map((series) => ({
      name: series.name,
      type: "scatter",
      symbolSize: 12,
      data: [series.points.map((point) => Number(point.value) * factor)],
      itemStyle: { color: organizationColor(series.name) },
      label: {
        show: true,
        position: "top",
        distance: 10,
        color: businessChartTextColor,
        formatter: () => series.name,
      },
      labelLayout: { hideOverlap: true },
    })),
  }
}

/** 展示切换只改变图形，来源、组成关系和服务端精确展示值保持不变。 */
export function businessChartOption(
  chart: BusinessReportChart,
  view: ReportChartView,
  size: ChartSize = {},
): EChartsCoreOption | null {
  if (!reportChartViews(chart).some((item) => item.value === view && !item.disabled)) return null
  if (chart.type === "pie" && (view === "pie" || view === "donut"))
    return businessPieOption(chart, view)
  if (chart.type === "bar" && (view === "pie" || view === "donut"))
    return selectedValuesPieOption(chart.points, view)
  if (chart.type === "grouped_bar" && view === "radar") return radarOption(chart)
  if (chart.type === "grouped_bar" && view === "scatter") return scatterOption(chart)
  return cartesianOption(chart, view, size)
}
