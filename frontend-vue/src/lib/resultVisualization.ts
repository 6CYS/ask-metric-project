import type { ChatResponse } from "@/types/api"
import { getResultColumnLabel } from "@/lib/resultColumns"

export type ResultView = "line" | "vertical_bar" | "horizontal_bar" | "table"

export type VisualizationPoint = {
  label: string
  value: number
  row: Record<string, unknown>
}

export type VisualizationDecision = {
  defaultView: ResultView
  allowedViews: ResultView[]
  categoryLabel?: string
  valueField?: string
  valueLabel?: string
  unit?: string
  points: VisualizationPoint[]
  reason: string
}

const TABLE_PREFERENCE_PATTERN = /(?:以|用|按)?(?:表格|列表)(?:形式)?(?:输出|展示|显示|呈现)?/
export const MAX_TREND_CHART_POINTS = 24
export const MAX_RANKING_CHART_POINTS = 20
export const MAX_COMPARISON_CHART_POINTS = 15

export function prefersTable(question: string) {
  return TABLE_PREFERENCE_PATTERN.test(question.trim())
}

export function resolveResultVisualization(
  response: ChatResponse,
  question = "",
): VisualizationDecision {
  const result = response.result
  const rows = result?.table?.rows ?? []
  const tableOnly = (reason: string): VisualizationDecision => ({
    defaultView: "table",
    allowedViews: ["table"],
    points: [],
    reason,
  })
  if (!result || !rows.length) return tableOnly("结果为空")

  const tablePreferred = prefersTable(question)
  const withPreference = (decision: VisualizationDecision): VisualizationDecision => ({
    ...decision,
    defaultView: tablePreferred ? "table" : decision.defaultView,
  })

  if (result.type === "metric_trend") {
    if (rows.length > MAX_TREND_CHART_POINTS) {
      return tableOnly(`趋势结果超过${MAX_TREND_CHART_POINTS}个数据点`)
    }
    const organizations = uniqueText(rows, "org_name")
    const metrics = uniqueText(rows, "metric_name")
    if (organizations.length > 1 || metrics.length > 1) {
      return tableOnly("趋势结果包含多个机构或指标，暂不生成单序列图表")
    }
    const points = rows
      .map((row) => ({
        label: String(row.stat_date ?? ""),
        value: toNumber(row.metric_value),
        row,
      }))
      .filter((point): point is VisualizationPoint => Boolean(point.label) && point.value !== null)
      .sort((left, right) => left.label.localeCompare(right.label))
    if (
      points.length >= 3
      && new Set(points.map((point) => point.label)).size === points.length
    ) {
      return withPreference(buildDecision({
        defaultView: "line",
        allowedViews: ["line", "vertical_bar", "table"],
        categoryField: "stat_date",
        valueField: "metric_value",
        points,
        reason: "至少三个有效时间点的趋势结果",
      }))
    }
    return tableOnly("趋势数据不足三个有效时间点")
  }

  if (result.type === "metric_ranking") {
    if (rows.length > MAX_RANKING_CHART_POINTS) {
      return tableOnly(`排名结果超过${MAX_RANKING_CHART_POINTS}行`)
    }
    const points = pointsFromRows(rows, "org_name", "metric_value")
    if (points.length >= 2) {
      return withPreference(buildDecision({
        defaultView: "horizontal_bar",
        allowedViews: ["horizontal_bar", "table"],
        categoryField: "org_name",
        valueField: "metric_value",
        points,
        reason: "Top-N 或 Bottom-N 排名结果",
      }))
    }
    return tableOnly("排名结果不足两个有效机构")
  }

  if (result.type === "entity_compare") {
    const points = comparisonPoints(rows)
    if (points.length >= 2 && points.length <= MAX_COMPARISON_CHART_POINTS) {
      return withPreference(buildDecision({
        defaultView: "horizontal_bar",
        allowedViews: ["horizontal_bar", "table"],
        categoryField: "org_name",
        valueField: "metric_value",
        points,
        reason: "少量机构比较结果",
      }))
    }
    return tableOnly("机构比较数据不适合绘图")
  }

  const organizations = uniqueText(rows, "org_name")
  const metrics = uniqueText(rows, "metric_name")
  const dates = uniqueText(rows, "stat_date")
  const units = uniqueText(rows, "unit")

  if (
    organizations.length >= 2
    && organizations.length <= MAX_COMPARISON_CHART_POINTS
    && metrics.length === 1
    && dates.length <= 1
  ) {
    const points = pointsFromRows(rows, "org_name", "metric_value")
    if (points.length >= 2) {
      return withPreference(buildDecision({
        defaultView: "horizontal_bar",
        allowedViews: ["horizontal_bar", "table"],
        categoryField: "org_name",
        valueField: "metric_value",
        points,
        reason: "同一指标的少量机构比较",
      }))
    }
  }

  if (
    organizations.length === 1
    && metrics.length >= 2
    && metrics.length <= 10
    && dates.length <= 1
    && units.length <= 1
  ) {
    const points = pointsFromRows(rows, "metric_name", "metric_value")
    if (points.length >= 2) {
      return withPreference(buildDecision({
        defaultView: "vertical_bar",
        allowedViews: ["vertical_bar", "table"],
        categoryField: "metric_name",
        valueField: "metric_value",
        points,
        reason: "同一机构同一日期的多个同单位指标",
      }))
    }
  }

  return tableOnly("结果结构不属于当前可视化范围")
}

function buildDecision(input: {
  defaultView: ResultView
  allowedViews: ResultView[]
  categoryField: string
  valueField: string
  points: VisualizationPoint[]
  reason: string
}): VisualizationDecision {
  const sample = input.points[0]?.row ?? {}
  return {
    defaultView: input.defaultView,
    allowedViews: input.allowedViews,
    categoryLabel: getResultColumnLabel(input.categoryField),
    valueField: input.valueField,
    valueLabel: getResultColumnLabel(input.valueField),
    unit: String(sample.unit ?? "").trim(),
    points: input.points,
    reason: input.reason,
  }
}

function comparisonPoints(rows: Record<string, unknown>[]): VisualizationPoint[] {
  // 新响应的表格只承载原始明细，每个机构一行；兼容旧会话中左右值结构。
  if (rows.some((row) => row.org_name != null && row.metric_value != null)) {
    return deduplicatePoints(pointsFromRows(rows, "org_name", "metric_value"))
  }
  const points: VisualizationPoint[] = []
  for (const row of rows) {
    const pairs = [
      [row.left_org, row.left_value],
      [row.right_org, row.right_value],
    ] as const
    for (const [label, rawValue] of pairs) {
      const value = toNumber(rawValue)
      if (label != null && String(label).trim() && value !== null) {
        points.push({ label: String(label), value, row })
      }
    }
  }
  return deduplicatePoints(points)
}

function pointsFromRows(
  rows: Record<string, unknown>[],
  categoryField: string,
  valueField: string,
): VisualizationPoint[] {
  return rows
    .map((row) => ({
      label: String(row[categoryField] ?? "").trim(),
      value: toNumber(row[valueField]),
      row,
    }))
    .filter((point): point is VisualizationPoint => Boolean(point.label) && point.value !== null)
}

function deduplicatePoints(points: VisualizationPoint[]) {
  const seen = new Set<string>()
  return points.filter((point) => {
    if (seen.has(point.label)) return false
    seen.add(point.label)
    return true
  })
}

function uniqueText(rows: Record<string, unknown>[], field: string) {
  return [...new Set(rows
    .map((row) => String(row[field] ?? "").trim())
    .filter(Boolean))]
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Number(value.replace(/,/g, ""))
  return Number.isFinite(parsed) ? parsed : null
}
