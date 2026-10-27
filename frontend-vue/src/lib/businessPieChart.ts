import type { EChartsCoreOption } from "echarts/core"
import type { BusinessPieChart } from "@/types/api"

const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim())
const decimal = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** 这里只守住展示边界，组成关系和金额核对仍由服务端负责。 */
export function isBusinessPieChart(value: unknown): value is BusinessPieChart {
  if (!value || typeof value !== "object") return false
  const chart = value as Partial<BusinessPieChart>
  if (chart.type !== "pie" || !nonempty(chart.title) || !nonempty(chart.unit)
    || typeof chart.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(chart.date)
    || !Array.isArray(chart.source_refs) || !chart.source_refs.length || !chart.source_refs.every(nonempty)
    || !Array.isArray(chart.points) || chart.points.length < 2 || chart.points.length > 20) return false
  const names = new Set<string>()
  let total = 0
  for (const point of chart.points) {
    if (!point || !nonempty(point.name) || names.has(point.name) || !nonempty(point.display)
      || typeof point.value !== "string" || !decimal.test(point.value)
      || !Number.isFinite(Number(point.value)) || Number(point.value) < 0
      || typeof point.share !== "string" || !/^\d+(?:\.\d+)?%$/.test(point.share)
      || Number(point.share.slice(0, -1)) > 100) return false
    names.add(point.name)
    total += Number(point.value)
  }
  return Number.isFinite(total) && total > 0
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character)
}

export function businessPieOption(chart: BusinessPieChart): EChartsCoreOption | null {
  if (!isBusinessPieChart(chart)) return null
  return {
    animationDuration: 350,
    color: ["#3b82b6", "#86b7d8", "#87a7c0", "#b7d2e5"],
    legend: { bottom: 0, type: "scroll", textStyle: { color: "#52638f" } },
    tooltip: {
      trigger: "item",
      formatter: (item: unknown) => {
        const index = (item as { dataIndex?: number } | undefined)?.dataIndex
        const point = typeof index === "number" ? chart.points[index] : undefined
        return point ? `${escapeHtml(point.name)}<br>余额：<strong>${escapeHtml(point.display)}</strong><br>占比：${escapeHtml(point.share)}` : ""
      },
    },
    series: [{
      type: "pie", radius: "62%", center: ["50%", "45%"],
      data: chart.points.map(point => ({ name: point.name, value: Number(point.value) })),
      label: {
        color: "#52638f", fontSize: 12,
        formatter: (item: { dataIndex: number }) => {
          const point = chart.points[item.dataIndex]
          return point ? `${point.name}\n${point.share}` : ""
        },
      },
      labelLayout: { hideOverlap: true },
      itemStyle: { borderColor: "#fff", borderWidth: 2 },
      emphasis: { scale: false },
    }],
  }
}
