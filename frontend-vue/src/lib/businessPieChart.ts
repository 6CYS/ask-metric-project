import type { EChartsCoreOption } from "echarts/core"
import type { BusinessPieChart } from "@/types/api"
import {
  businessChartColors,
  businessChartTextColor,
  businessChartTextStyle,
  organizationColor,
} from "./businessChartStyle"

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim())
const decimal = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** 这里只守住展示边界，组成关系和金额核对仍由服务端负责。 */
export function isBusinessPieChart(value: unknown): value is BusinessPieChart {
  if (!value || typeof value !== "object") return false
  const chart = value as Partial<BusinessPieChart>
  if (
    chart.type !== "pie" ||
    !nonempty(chart.title) ||
    !nonempty(chart.unit) ||
    typeof chart.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(chart.date) ||
    !Array.isArray(chart.source_refs) ||
    !chart.source_refs.length ||
    !chart.source_refs.every(nonempty) ||
    !Array.isArray(chart.points) ||
    chart.points.length < 2 ||
    chart.points.length > 20
  )
    return false
  const names = new Set<string>()
  let total = 0
  for (const point of chart.points) {
    if (
      !point ||
      !nonempty(point.name) ||
      names.has(point.name) ||
      !nonempty(point.display) ||
      typeof point.value !== "string" ||
      !decimal.test(point.value) ||
      !Number.isFinite(Number(point.value)) ||
      Number(point.value) < 0 ||
      typeof point.share !== "string" ||
      !/^\d+(?:\.\d+)?%$/.test(point.share) ||
      Number(point.share.slice(0, -1)) > 100
    )
      return false
    names.add(point.name)
    total += Number(point.value)
  }
  return Number.isFinite(total) && total > 0
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  )
}

export function businessPieOption(
  chart: BusinessPieChart,
  view: "pie" | "donut" = "donut",
): EChartsCoreOption | null {
  if (!isBusinessPieChart(chart)) return null
  return pieOption(chart.points, view, (item) => chart.points[item.dataIndex]?.share ?? "", "占比")
}

type PiePoint = { name: string; value: string; display: string }
type PieItem = { dataIndex: number; percent?: number }

/** 所选机构的图内占比由 ECharts 计算，不写回正式组成或来源字段。 */
export function selectedValuesPieOption(
  points: readonly PiePoint[],
  view: "pie" | "donut",
): EChartsCoreOption {
  return pieOption(
    points,
    view,
    (item) =>
      typeof item.percent === "number" && Number.isFinite(item.percent) ? `${item.percent}%` : "",
    "占所选机构合计",
  )
}

function pieOption(
  points: readonly PiePoint[],
  view: "pie" | "donut",
  share: (item: PieItem) => string,
  scope: "占比" | "占所选机构合计",
): EChartsCoreOption {
  return {
    animationDuration: 350,
    backgroundColor: "#FFFFFF",
    color: [...businessChartColors],
    textStyle: businessChartTextStyle,
    legend: {
      bottom: 0,
      type: "scroll",
      itemGap: 20,
      textStyle: { color: businessChartTextColor, fontSize: 12 },
    },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (item: unknown) => {
        const param = item as PieItem | undefined
        const point = typeof param?.dataIndex === "number" ? points[param.dataIndex] : undefined
        return point && param
          ? `${escapeHtml(point.name)}<br><strong>${escapeHtml(point.display)}</strong><br>${scope}：${escapeHtml(share(param))}${scope === "占所选机构合计" ? "<br>不代表全行业占比" : ""}`
          : ""
      },
    },
    series: [
      {
        type: "pie",
        radius: view === "donut" ? ["36%", "58%"] : "58%",
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        minShowLabelAngle: points.length > 8 ? 10 : 0,
        data: points.map((point) => ({
          name: point.name,
          value: Number(point.value),
          ...(scope === "占所选机构合计"
            ? { itemStyle: { color: organizationColor(point.name) } }
            : {}),
        })),
        label: {
          fontSize: 12,
          lineHeight: 18,
          color: businessChartTextColor,
          distanceToLabelLine: 6,
          formatter: (item: PieItem) => {
            const point = points[item.dataIndex]
            return point ? `${point.name}\n${share(item)}` : ""
          },
        },
        labelLine: { length: 14, length2: 12 },
        labelLayout: { hideOverlap: true },
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        emphasis: { scale: false },
      },
    ],
  }
}
