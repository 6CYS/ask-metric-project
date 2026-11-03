import type { QuerySqlReference } from "@/types/querySql"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function reference(value: unknown): QuerySqlReference[] {
  const item = record(value)
  if (!item || typeof item.task_id !== "string" || !item.task_id.trim()) return []
  return [
    {
      task_id: item.task_id,
      ...(typeof item.result_id === "string" && item.result_id
        ? { result_id: item.result_id }
        : {}),
      ...(typeof item.run_id === "number" && Number.isSafeInteger(item.run_id) && item.run_id > 0
        ? { run_id: item.run_id }
        : {}),
    },
  ]
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = record(item)
        return parsed ? [parsed] : []
      })
    : []
}

function strings(values: unknown[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : [])),
    ),
  ]
}

function belongsToReference(
  item: Record<string, unknown>,
  source: QuerySqlReference,
  implicitTask: boolean,
): boolean {
  if (item.task_id !== undefined && item.task_id !== source.task_id) return false
  if (item.run_id !== undefined && source.run_id !== undefined && item.run_id !== source.run_id)
    return false
  if (
    item.result_id !== undefined &&
    source.result_id !== undefined &&
    item.result_id !== source.result_id
  )
    return false
  if (typeof item.fact_id === "string" && item.fact_id.startsWith("fact:")) {
    // 身份格式来自后端 CalculationFact；完整任务前缀避免相似 ID 串配。
    const prefix = `fact:${source.task_id}:`
    if (!item.fact_id.startsWith(prefix)) return false
    const parts = item.fact_id.slice(prefix.length).split(":")
    const row = Number(parts[0])
    return (
      parts.length === 2 &&
      Number.isSafeInteger(row) &&
      row >= 0 &&
      String(row) === parts[0] &&
      ["metric_value", "current_value", "base_value"].includes(parts[1] ?? "")
    )
  }
  return item.task_id === source.task_id || implicitTask
}

/** 描述只来自可按任务配对的事实；分析计划和整批条件不能分摊给每条 SQL。 */
function describeReferences(
  receipt: Record<string, unknown>,
  sources: QuerySqlReference[],
  direct = false,
): QuerySqlReference[] {
  const facts = Array.isArray(receipt.facts)
    ? records(receipt.facts)
    : Object.values(record(receipt.facts) ?? {}).flatMap((byDate) =>
        records(Object.values(record(byDate) ?? {})),
      )
  const atoms = records(receipt.evidence_items).filter((item) => item.type === "fact")
  const inputs = records(Object.values(record(receipt.inputs) ?? {}))
  const candidates = [...facts, ...atoms, ...inputs, ...records(receipt.rows)]
  return sources.map((source) => {
    const multipleRuns = sources.some(
      (other) => other.task_id === source.task_id && other.run_id !== source.run_id,
    )
    const selected = candidates.filter(
      (item) =>
        (!multipleRuns || item.run_id === source.run_id) &&
        belongsToReference(item, source, direct),
    )
    const queryEvidence = direct ? record(receipt.query_evidence) : undefined
    const catalog = record(queryEvidence?.catalog)
    const dsl = record(queryEvidence?.logical_dsl)
    const metricCodes = Array.isArray(dsl?.metrics) ? dsl.metrics : []
    const orgCodes = Array.isArray(dsl?.orgs) ? dsl.orgs : []
    const metrics = records(catalog?.metrics).filter((item) => metricCodes.includes(item.code))
    const orgs = records(catalog?.organizations).filter((item) => orgCodes.includes(item.code))
    const queryDates = record(queryEvidence?.query_dates)
    const actualDates: unknown[] =
      queryDates?.complete === true && Array.isArray(queryDates.actual_dates)
        ? queryDates.actual_dates
        : []
    const label = strings([
      ...metrics.map((item) => item.name),
      ...selected.map((item) => item.metric_name),
    ]).join("、")
    const names = strings([
      ...orgs.map((item) => item.name),
      ...selected.map((item) => item.org_name),
    ]).join("、")
    const dates = strings([...actualDates, ...selected.map((item) => item.date ?? item.stat_date)])
      .sort()
      .join("、")
    const description = [names, dates].filter(Boolean).join(" · ")
    return { ...source, ...(label ? { label } : {}), ...(description ? { description } : {}) }
  })
}

/** 只读正式回执中的取数身份；计算、目录和覆盖探测本身不是业务 SQL 记录。 */
function referencesFromReceipt(value: unknown): QuerySqlReference[] {
  const receipt = record(value)
  if (!receipt || receipt.answer_selected === false) return []
  if (receipt.protocol_version === 2) return referencesFromReceipt(record(receipt.state)?.evidence)
  if (receipt.kind === "semantic_results") {
    return Array.isArray(receipt.results) ? receipt.results.flatMap(referencesFromReceipt) : []
  }
  if (
    ["analysis_evidence", "business_overview", "business_report"].includes(String(receipt.kind))
  ) {
    return describeReferences(
      receipt,
      Array.isArray(receipt.tasks) ? receipt.tasks.flatMap(reference) : [],
    )
  }
  if (receipt.kind === "metric_calculate") {
    return describeReferences(
      receipt,
      Array.isArray(receipt.sources) ? receipt.sources.flatMap(reference) : [],
    )
  }
  if (!["metric_ask", "metric_query_structured", "metric_read"].includes(String(receipt.kind)))
    return []
  if (receipt.status === "clarification_required") return []
  // 只回查任务状态的 read 没有读取结果，不宣称它提供了本轮取数来源。
  if (
    receipt.kind === "metric_read" &&
    !receipt.result_id &&
    !["error", "failed"].includes(String(receipt.status).toLowerCase())
  )
    return []
  return describeReferences(receipt, reference(receipt), true)
}

export function appendQuerySqlReferences(
  previous: QuerySqlReference[],
  value: unknown,
): QuerySqlReference[] {
  let merged = previous
  for (const incoming of referencesFromReceipt(value)) {
    const exactIndex = merged.findIndex(
      (item) => item.task_id === incoming.task_id && item.run_id === incoming.run_id,
    )
    const genericIndex =
      incoming.run_id === undefined
        ? -1
        : merged.findIndex(
            (item) =>
              item.task_id === incoming.task_id &&
              item.run_id === undefined &&
              (item.result_id === undefined || item.result_id === incoming.result_id),
          )
    const sameResult =
      incoming.run_id === undefined && incoming.result_id
        ? merged.flatMap((item, index) =>
            item.task_id === incoming.task_id && item.result_id === incoming.result_id
              ? [index]
              : [],
          )
        : []
    const index =
      exactIndex >= 0
        ? exactIndex
        : genericIndex >= 0
          ? genericIndex
          : sameResult.length === 1
            ? (sameResult[0] ?? -1)
            : -1
    if (index >= 0) {
      const existing = merged[index]
      if (!existing) continue
      const sameSource =
        existing.run_id === incoming.run_id ||
        incoming.run_id === undefined ||
        (incoming.result_id !== undefined && incoming.result_id === existing.result_id)
      // 泛引用无法证明某次显式执行的来源，升级时不沿用旧结果及描述。
      const next = { ...(sameSource ? existing : {}), ...incoming }
      if (
        next.run_id === existing.run_id &&
        next.result_id === existing.result_id &&
        next.label === existing.label &&
        next.description === existing.description
      )
        continue
      merged = merged.map((item, position) => (position === index ? next : item))
    } else if (
      incoming.run_id !== undefined ||
      !merged.some((item) => item.task_id === incoming.task_id)
    ) {
      merged = [...merged, incoming]
    }
  }
  return merged
}
