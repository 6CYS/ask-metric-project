const resultColumnLabels: Record<string, string> = {
  metric_code: "指标编码",
  metric_name: "指标名称",
  unit: "单位",
  org_name: "机构名称",
  metric_value: "指标值",
  stat_date: "统计日期",
  rank: "排名",
  period: "期间",
  current_date: "本期日期",
  current_value: "本期值",
  base_date: "基期日期",
  base_value: "基期值",
  difference: "差值",
  change_rate: "变化率",
  status: "状态",
  method: "计算方式",
}

/**
 * 查询结果表只展示稳定的业务字段，不把数据源新增的物理字段直接暴露给用户。
 * 顺序也是 UI 契约：指标名称始终在最前，技术编码、单位和原始增量字段不进入表格。
 */
const visibleResultColumnOrder = [
  "metric_name",
  "org_name",
  "stat_date",
  "metric_value",
  "rank",
  "current_date",
  "current_value",
  "base_date",
  "base_value",
  "difference",
  "change_rate",
  "status",
] as const

const visibleResultColumns = new Set<string>(visibleResultColumnOrder)

export function normalizeResultColumn(column: string) {
  return column.trim().replace(/`/g, "").toLowerCase()
}

export function getResultCellValue(row: Record<string, unknown>, column: string) {
  if (Object.prototype.hasOwnProperty.call(row, column)) return row[column]
  const normalized = normalizeResultColumn(column)
  const sourceKey = Object.keys(row).find((key) => normalizeResultColumn(key) === normalized)
  return sourceKey === undefined ? undefined : row[sourceKey]
}

/** 从响应列和实际行中取交集，最终严格按业务顺序输出。 */
export function getVisibleResultColumns(
  columns: string[],
  rows: Record<string, unknown>[] = [],
) {
  const available = new Set([
    ...columns.map(normalizeResultColumn),
    ...rows.flatMap((row) => Object.keys(row).map(normalizeResultColumn)),
  ])
  return visibleResultColumnOrder.filter((column) => available.has(column))
}

/** 保留后端稳定字段名，仅将查询结果中的表头转换为用户可读中文。 */
export function getResultColumnLabel(column: string) {
  const normalized = normalizeResultColumn(column)
  return resultColumnLabels[normalized] ?? column
}

const monetaryValueColumns = new Set([
  "metric_value",
  "current_value",
  "base_value",
  "difference",
  "left_value",
  "right_value",
])

export function isResultValueColumn(column: string) {
  return monetaryValueColumns.has(normalizeResultColumn(column))
}

/** 表格保持原单位与有效精度，仅去掉普通十进制小数末尾的零，不转 Number。 */
export function formatResultTableValue(value: unknown, column: string, _row: Record<string, unknown>) {
  const normalized = normalizeResultColumn(column)
  if (!isResultValueColumn(normalized) && normalized !== "rank") return null
  if (typeof value !== "string" && typeof value !== "number") return null
  const text = String(value)
  if (!/^[+-]?\d+\.\d+$/.test(text)) return text
  return text.replace(/0+$/, "").replace(/\.$/, "")
}

export function getResultColumnClass(column: string) {
  const normalized = normalizeResultColumn(column)
  if (normalized === "metric_name") return "w-64 min-w-64 max-w-64"
  if (normalized === "org_name") return "w-56 min-w-56 max-w-56"
  if (["left_org", "right_org", "higher_org"].includes(normalized)) {
    return "w-44 min-w-44 max-w-44"
  }
  if (["stat_date", "current_date", "base_date"].includes(normalized)) {
    return "w-32 min-w-32 max-w-32"
  }
  if (normalized === "status") return "w-52 min-w-52 max-w-52"
  if (visibleResultColumns.has(normalized)) return "w-36 min-w-36 max-w-36"
  return "w-40 min-w-40 max-w-40"
}

export function shouldTruncateResultColumn(column: string) {
  return ["metric_name", "org_name", "left_org", "right_org", "higher_org", "status"]
    .includes(normalizeResultColumn(column))
}

const amountFormatter = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const integerFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
})

/** 单位与数值以新后端响应为准；前端只做千分位和显示精度处理。 */
export function formatResultCellValue(
  value: unknown,
  column: string,
  row: Record<string, unknown>,
) {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric)) return null
  const normalizedColumn = column.trim().replace(/`/g, "").toLowerCase()
  const isStoredRankingMetric = normalizedColumn === "metric_value" && String(row.metric_name ?? "").includes("排名")
  if (normalizedColumn === "rank" || isStoredRankingMetric || (monetaryValueColumns.has(normalizedColumn) && String(row.unit) === "户")) {
    return integerFormatter.format(numeric)
  }
  if (monetaryValueColumns.has(normalizedColumn) && ["元", "万元"].includes(String(row.unit))) {
    return amountFormatter.format(numeric)
  }
  return null
}
