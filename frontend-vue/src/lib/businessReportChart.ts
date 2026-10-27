import type { EChartsCoreOption } from "echarts/core"
import type { BusinessReportChart, BusinessSeriesChart } from "@/types/api"
import { isBusinessPieChart } from "./businessPieChart"

const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim())
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)

export function isBusinessSeriesChart(value: unknown): value is BusinessSeriesChart {
  if (!value || typeof value !== "object") return false
  const chart = value as Partial<BusinessSeriesChart>
  if (!["bar", "line"].includes(chart.type ?? "") || !nonempty(chart.title) || !nonempty(chart.unit)
    || !Array.isArray(chart.dates) || !chart.dates.length || !chart.dates.every(date)
    || new Set(chart.dates).size !== chart.dates.length
    || !Array.isArray(chart.points) || chart.points.length < 2 || chart.points.length > 24
    || !Array.isArray(chart.source_refs) || chart.source_refs.length !== chart.points.length
    || !chart.source_refs.every(nonempty) || new Set(chart.source_refs).size !== chart.source_refs.length) return false
  if (chart.type === "bar" && chart.dates.length !== 1) return false
  if (chart.type === "line" && (chart.dates.length !== chart.points.length
    || chart.points.some((point, index) => point?.name !== chart.dates![index])
    || chart.dates.some((day, index) => index > 0 && day <= chart.dates![index - 1]!))) return false
  return chart.points.every(point => point && nonempty(point.name) && nonempty(point.display)
    && typeof point.value === "string" && /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(point.value)
    && Number.isFinite(Number(point.value))) && new Set(chart.points.map(point => point.name)).size === chart.points.length
}

export function isBusinessReportChart(value: unknown): value is BusinessReportChart {
  return isBusinessPieChart(value) || isBusinessSeriesChart(value)
}

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!)

/** 轴坐标可以等比例缩放；提示内容始终使用服务端保存的精确展示值。 */
export function businessSeriesOption(chart: BusinessSeriesChart): EChartsCoreOption | null {
  if (!isBusinessSeriesChart(chart)) return null
  const power = ({ 元: 1, 万元: 10000, 亿元: 100000000 } as Record<string, number>)[chart.unit]
  const maximum = power ? Math.max(...chart.points.map(point => Math.abs(Number(point.value)) * power)) : 0
  const unit = power ? maximum >= 100000000 ? "亿元" : maximum >= 10000 ? "万元" : "元" : chart.unit
  const factor = power ? power / ({ 元: 1, 万元: 10000, 亿元: 100000000 } as Record<string, number>)[unit]! : 1
  return {
    animationDuration: 350, color: ["#64748b"],
    tooltip: { trigger: "axis", axisPointer: { type: chart.type === "line" ? "line" : "shadow" },
      formatter: (items: unknown) => {
        const item = (Array.isArray(items) ? items[0] : items) as { dataIndex?: number } | undefined
        const point = typeof item?.dataIndex === "number" ? chart.points[item.dataIndex] : undefined
        return point ? `${escapeHtml(point.name)}<br/><strong>${escapeHtml(point.display)}</strong>` : ""
      } },
    grid: { left: 24, right: 32, top: 32, bottom: 28, containLabel: true },
    xAxis: chart.type === "bar"
      ? { type: "value", name: unit, splitLine: { lineStyle: { color: "#e4e4e7" } } }
      : { type: "category", data: chart.points.map(point => point.name), boundaryGap: false,
      axisLabel: { interval: 0, hideOverlap: true, width: 150, overflow: "truncate" } },
    yAxis: chart.type === "bar"
      ? { type: "category", inverse: true, data: chart.points.map(point => point.name),
        axisLabel: { interval: 0, width: 210, overflow: "truncate" } }
      : { type: "value", name: unit, splitLine: { lineStyle: { color: "#e4e4e7" } } },
    series: [{ type: chart.type, data: chart.points.map(point => Number(point.value) * factor),
      ...(chart.type === "line" ? { smooth: false, symbolSize: 7 } : { barMaxWidth: 34 }) }],
  }
}
