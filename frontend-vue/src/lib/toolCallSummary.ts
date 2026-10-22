/** 执行过程中每个步骤的用户可读摘要：已确定的查询条件与一句结果说明。 */
export type ToolCallSummary = {
  conditions?: { label: string; value: string }[]
  note?: string
}

const toolLabels: Record<string, string> = {
  business_skill_read: "确认查询方法",
  business_topic_read: "读取业务主题与指标关系",
  business_report_present: "生成经营分析报告",
  analysis_catalog: "发现指标与分析方法",
  analysis_report_present: "生成分析报告",
  runtime_finalize_turn: "整理查询结果",
  business_capability_explain: "说明当前能力",
  answer_evidence_check: "核验回答依据",
  answer_present: "交付回答",
  resolve_business_turn: "解析查询条件",
  business_context_read: "读取查询历史",
  execute_business_frame: "执行指标查询",
  read_business_result: "读取历史结果",
  data_availability: "查看数据可用范围",
  catalog_overview: "查看目录概览",
  catalog: "目录查询",
  read: "读取任务、结果与历史",
  metric_catalog_search: "检索指标目录",
  metric_catalog_overview: "查看可查询指标",
  org_catalog_search: "检索机构目录",
  metric_ask: "解析问题并查询指标",
  metric_query_structured: "按指标、机构和日期查询",
  metric_read: "回读查询结果",
  session_history_read: "回读会话历史",
  metric_calculate: "调用可靠计算工具",
}

const issueFieldLabels: Record<string, string> = { metrics: "指标", organizations: "机构", time: "日期" }

const metricResultKinds = new Set(["metric_ask", "metric_query_structured", "metric_read"])

type Details = {
  kind?: unknown
  status?: unknown
  execution_mode?: unknown
  row_count?: unknown
  truncated?: unknown
  issues?: unknown
  delivery?: unknown
  display_conditions?: unknown
  org_name?: unknown
  analysis_date?: unknown
  requested_date?: unknown
  table_rows?: unknown
  plan?: { objective?: unknown }
}

function asDetails(value: unknown): Details {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Details : {}
}

/** 解析条件后宿主会就地执行查询，此时同一步骤的回执已是查询结果。 */
export function toolCallLabel(tool: string, details?: unknown) {
  if (asDetails(details).kind === "analysis_evidence") return "规划并执行分析步骤"
  if (asDetails(details).kind === "business_overview") return "规划并查询经营指标"
  if (tool === "resolve_business_turn" && metricResultKinds.has(String(asDetails(details).kind))) return "解析条件并执行查询"
  return toolLabels[tool] ?? "执行查询步骤"
}

function conditionsOf(details: Details) {
  if (!Array.isArray(details.display_conditions)) return undefined
  const conditions = (details.display_conditions as { label?: unknown; value?: unknown }[]).filter(
    (item): item is { label: string; value: string } => Boolean(item) && typeof item === "object"
      && typeof item.label === "string" && typeof item.value === "string" && Boolean(item.label && item.value))
  return conditions.length ? conditions : undefined
}

function resultNote(details: Details) {
  const status = String(details.status ?? "").toLowerCase()
  if (status === "succeeded") {
    const rows = typeof details.row_count === "number" ? details.row_count : undefined
    if (rows === undefined) return "查询完成"
    if (rows === 0) return "未查到符合条件的数据"
    return `取得 ${rows} 行数据${details.truncated === true ? "（结果较多，已截断）" : ""}`
  }
  if (status === "clarification_required") return "条件不完整，需要补充"
  return "查询未成功"
}

function businessContextNote(details: Details) {
  const status = String(details.status ?? "")
  if (status === "READY") return details.execution_mode === "execute" ? "条件已确定，开始查询" : "条件已保存，暂不查询"
  if (status === "REUSE_RESULT") return "已有相同条件的查询结果，直接复用"
  if (status === "NEEDS_CLARIFICATION") {
    const fields = Array.isArray(details.issues)
      ? [...new Set(details.issues.map(issue => issueFieldLabels[String((issue as { field?: unknown })?.field)]).filter(Boolean))]
      : []
    return fields.length ? `需要确认${fields.join("、")}` : "需要补充或确认条件"
  }
  if (status === "ARGUMENT_ERROR") return "条件表述需调整，正在重新解析"
  if (status === "TEMPORARY_ERROR") return "目录服务暂时不可用"
  if (status === "failed") return "查询未成功"
  return "未能完成"
}

/**
 * 由工具回执生成步骤摘要；只读取回执里面向用户的状态、行数和已确定条件，
 * 不展示编码、SQL 或模型参数。无法识别的回执只返回失败提示或空摘要。
 */
export function toolCallSummary(details: unknown, isError = false): ToolCallSummary | undefined {
  const value = asDetails(details)
  const kind = String(value.kind ?? "")
  let conditions = conditionsOf(value)
  let note: string | undefined
  if (metricResultKinds.has(kind)) note = resultNote(value)
  else if (["business_overview", "business_report", "analysis_evidence"].includes(kind)) {
    const date = value.analysis_date ?? value.requested_date
    conditions = [
      ...(typeof value.org_name === "string" ? [{ label: "机构", value: value.org_name }] : []),
      ...(typeof date === "string" ? [{ label: "日期", value: date }] : []),
      ...(typeof value.plan?.objective === "string" ? [{ label: "分析目标", value: value.plan.objective }] : []),
    ]
    note = value.status === "succeeded" ? kind === "business_report" ? "报告和数据表已生成"
      : value.analysis_date === null ? "目标日期没有记录，正在整理数据覆盖说明"
        : `已取得 ${Array.isArray(value.table_rows) ? value.table_rows.length : 0} 项指标证据，继续分析`
      : "分析步骤需调整，正在核验"
  }
  else if (kind === "business_context") note = businessContextNote(value)
  else if (kind === "data_availability") note = value.status === "succeeded" ? "已查看数据覆盖范围" : "数据覆盖查询未完成"
  else if (kind === "metric_calculate") note = value.status === "succeeded" ? "计算完成" : "计算未成功"
  else if (kind === "catalog_overview") note = "已读取目录概览"
  else if (kind === "answer_present" && value.status === "delivered") note = "回答已生成"
  else if (kind === "runtime_delivery" && value.status === "delivered") note = "已整理正式回执"
  if (isError && !note) note = "执行失败"
  return conditions || note ? { ...(conditions ? { conditions } : {}), ...(note ? { note } : {}) } : undefined
}
