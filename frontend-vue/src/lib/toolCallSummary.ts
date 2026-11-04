/** 执行过程中每个步骤的用户可读摘要：已确定的查询条件与一句结果说明。 */
export type ToolCallSummary = {
  conditions?: { label: string; value: string; wrap?: boolean }[]
  note?: string
  /** 部分历史回执未同步传输失败标记，按已知回执状态恢复展示。 */
  failed?: boolean
}

const toolLabels: Record<string, string> = {
  metric_search: "检索指标目录",
  metric_query: "查询指标数据",
  metric_availability: "查看数据可用范围",
  analysis_read: "读取已有查询结果",
  analysis_answer: "生成回答",
  analysis_partial_present: "说明已取得的部分结果",
  analysis_chart: "准备图表展示",
  business_knowledge_search: "检索业务知识",
  respond_without_business_action: "说明或澄清问题",
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
  analysis_plan_repair: "补齐分析查询步骤",
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
  analysis_calculate: "计算已有结果",
}

const issueFieldLabels: Record<string, string> = { metrics: "指标", organizations: "机构", time: "日期" }

const metricResultKinds = new Set(["metric_ask", "metric_query_structured", "metric_read"])

const calculationFailureNotes = new Map([
  ["ANALYSIS_CALCULATION_SOURCE", "指标口径或数据来源不符合计算要求"],
  ["ANALYSIS_CALCULATION_FACT_REQUIRED", "缺少可用于计算的原始数据"],
  ["ANALYSIS_CALCULATION_METRIC_MISMATCH", "所选指标或口径不同，不能直接比较"],
  ["ANALYSIS_CALCULATION_UNIT_UNCONFIRMED", "指标单位或百分比口径尚未确认"],
  ["ANALYSIS_CALCULATION_SCOPE_MISMATCH", "机构和日期同时变化，需先对齐比较范围"],
])

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
  org_names?: unknown
  metric_descriptors?: unknown
  metric_names?: unknown
  actual_dates?: unknown
  analysis_date?: unknown
  requested_date?: unknown
  table_rows?: unknown
  rows?: unknown
  result_reused?: unknown
  reused?: unknown
  complete?: unknown
  partial_analysis?: unknown
  entries?: unknown
  results?: unknown
  inputs?: unknown
  error_code?: unknown
  retryable?: unknown
  repeated_failure?: unknown
  gaps?: unknown
  topic_execution?: unknown
}

function asDetails(value: unknown): Details {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

/** 解析条件后宿主会就地执行查询，此时同一步骤的回执已是查询结果。 */
export function toolCallLabel(tool: string, details?: unknown) {
  const value = asDetails(details)
  if (tool === "topic_query") {
    const execution = value.topic_execution as { topic_name?: unknown } | undefined
    return typeof execution?.topic_name === "string"
      ? `${value.kind === 'inquiry_query_reuse' ? '复用分析方案结果' : '执行分析方案'}：${execution.topic_name}`
      : value.kind === "inquiry_query_reuse" ? "复用分析方案结果" : "按分析方案批量取数"
  }
  if (tool === "metric_query" && (value.result_reused === true || value.reused === true || value.kind === "inquiry_query_reuse")) return "读取已有查询结果"
  if (value.kind === "analysis_evidence" && tool !== "metric_query" && tool !== "analysis_read") return "规划并执行分析步骤"
  if (value.kind === "business_overview") return "规划并查询经营指标"
  if (tool === "resolve_business_turn" && typeof value.kind === "string" && metricResultKinds.has(value.kind)) return "解析条件并执行查询"
  return toolLabels[tool] ?? "执行查询步骤"
}

function conditionsOf(details: Details) {
  if (!Array.isArray(details.display_conditions)) return undefined
  const conditions = (details.display_conditions as { label?: unknown; value?: unknown }[]).filter(
    (item): item is { label: string; value: string } => Boolean(item) && typeof item === "object"
      && typeof item.label === "string" && typeof item.value === "string" && Boolean(item.label && item.value))
  return conditions.length ? conditions : undefined
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))] : []
}

/** 只使用本次回执的实际条件；目录候选和计划目标不代表已经查询的对象。 */
function queryConditions(details: Details) {
  const descriptors = Array.isArray(details.metric_descriptors) ? details.metric_descriptors : []
  const metrics = stringsOf(descriptors.map(item => (item as { name?: unknown } | null)?.name))
  const names = metrics.length ? metrics : stringsOf(details.metric_names)
  const orgs = stringsOf(details.org_names)
  const dates = stringsOf(details.actual_dates)
  const conditions: NonNullable<ToolCallSummary["conditions"]> = []
  function add(label: string, values: string[]) {
    if (values.length) conditions.push({ label, value: values.join("、") })
  }
  add("指标", names)
  add("机构", orgs.length ? orgs : stringsOf([details.org_name]))
  add("数据日期", dates.length ? dates : stringsOf([details.analysis_date]))
  if (!dates.length && !details.analysis_date) add("请求日期", stringsOf([details.requested_date]))
  return conditions.length ? conditions : conditionsOf(details)
}

function calculationConditions(details: Details) {
  if (!details.inputs || typeof details.inputs !== "object" || Array.isArray(details.inputs)) return conditionsOf(details)
  const inputs = details.inputs as { current?: unknown; base?: unknown }
  const conditions = ([["current", "比较对象"], ["base", "参照对象"]] as const).flatMap(([key, label]) => {
    const input = inputs[key]
    if (!input || typeof input !== "object" || Array.isArray(input)) return []
    const fact = input as { metric_name?: unknown; org_name?: unknown; date?: unknown }
    const value = stringsOf([fact.metric_name, fact.org_name, fact.date]).join(" · ")
    return value ? [{ label, value }] : []
  })
  return conditions.length ? conditions : conditionsOf(details)
}

function calculationNote(details: Details) {
  if (details.status === "succeeded") return "计算完成"
  // 错误码对应明确的业务拒绝，不将任意后端异常消息直接展示给用户。
  const reason = (typeof details.error_code === "string" ? calculationFailureNotes.get(details.error_code) : undefined)
    ?? (details.retryable === true ? "计算服务暂不可用" : "计算未完成")
  return details.repeated_failure === true ? `相同条件已失败，未重复计算；${reason}` : reason
}

function resultNote(details: Details) {
  const status = typeof details.status === "string" ? details.status.toLowerCase() : ""
  if (status === "succeeded") {
    const rows = typeof details.row_count === "number" ? details.row_count : undefined
    if (rows === undefined) return "查询完成"
    if (rows === 0) return "未查到符合条件的数据"
    return `取得 ${rows} 行数据${details.truncated === true ? "（结果较多，已截断）" : ""}`
  }
  if (status === "clarification_required") return "条件不完整，需要补充"
  return "查询未成功"
}

function analysisResultNote(details: Details) {
  if (details.kind === "business_report") {
    if (details.status !== "succeeded") return "回答尚未生成"
    return details.partial_analysis === true ? "已生成部分结果说明" : "回答与数据明细已生成"
  }
  if (details.status !== "succeeded") return "查询未完成"
  const rows = details.kind === "analysis_evidence" ? details.rows : details.table_rows
  const count = typeof details.row_count === "number" && Number.isInteger(details.row_count) && details.row_count >= 0
    ? details.row_count : Array.isArray(rows) ? rows.length : undefined
  const reused = details.result_reused === true
  if (count === 0 && details.complete === false && (details.topic_execution as { completed?: unknown } | undefined)?.completed !== true) return "本次未取得可用数据，部分查询尚未完成"
  let note = reused ? "已读取已有查询结果" : "查询完成"
  if (count === 0) note = "未查到符合条件的数据"
  else if (count !== undefined) note = reused ? `已读取 ${count} 条已有数据` : `已取得 ${count} 条数据`
  if ((details.topic_execution as { completed?: unknown } | undefined)?.completed === true)
    return details.complete === false ? `${note}，批量处理已结束，部分指标未取得可用结果` : `${note}，批量处理已完成`
  return details.complete === false ? `${note}，部分查询尚未完成` : note
}

function batchResultNote(details: Details) {
  if (details.status === "partial") return "部分查询已完成，其余查询未完成"
  if (details.status !== "succeeded") return "查询未完成"
  if (Array.isArray(details.results) && details.results.some(result => asDetails(result).complete === false)) return "已取得查询结果，部分查询尚未完成"
  return details.reused === true ? "已读取已有查询结果" : "本次查询已完成"
}

function businessContextNote(details: Details) {
  const status = typeof details.status === "string" ? details.status : ""
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
  const kind = typeof value.kind === "string" ? value.kind : ""
  let conditions: ToolCallSummary["conditions"] = conditionsOf(value)
  let note: string | undefined
  if (metricResultKinds.has(kind)) note = resultNote(value)
  else if (["business_overview", "business_report", "analysis_evidence"].includes(kind)) {
    conditions = queryConditions(value)
    note = analysisResultNote(value)
    if (kind === "business_report" && value.status === "succeeded" && value.partial_analysis === true) {
      // 报告 gaps 已经由服务端转换为可见业务说明，与正式正文使用相同来源。
      const gaps = stringsOf(value.gaps)
      if (gaps.length) conditions = [...(conditions ?? []), { label: "未完成项", value: gaps.join("\n"), wrap: true }]
    }
  }
  else if (kind === "semantic_results") note = batchResultNote(value)
  else if (kind === "inquiry_query_reuse") note = value.status === "succeeded" ? "已读取已有查询结果" : "结果读取未完成"
  else if (kind === "analysis_catalog") note = value.status === "succeeded" ? "已完成目录检索" : "目录检索未完成"
  else if (kind === "business_skill_read") note = value.status === "ok" ? "已读取业务分析方法" : "分析方法读取未完成"
  else if (kind === "session_history_read") note = value.status === "ok" ? "已读取会话历史" : "会话历史读取未完成"
  else if (kind === "business_knowledge_search") note = value.status === "ok"
    ? (Array.isArray(value.entries) ? (value.entries.length ? `找到 ${value.entries.length} 条相关知识` : "未找到相关知识") : "已完成知识检索")
    : "业务知识暂不可用"
  else if (kind === "inquiry_chart") note = value.status === "succeeded" ? "已准备图表展示" : "图表准备未完成"
  else if (kind === "analysis_answer") note = "回答尚未生成"
  else if (kind === "conversation_reply") note = value.status === "answered" ? "已生成说明或澄清问题" : "说明或澄清未完成"
  else if (kind === "business_context") note = businessContextNote(value)
  else if (kind === "data_availability") {
    conditions = queryConditions(value)
    note = value.status === "succeeded" ? "已查看数据覆盖范围" : "数据覆盖查询未完成"
  }
  else if (kind === "metric_calculate") {
    conditions = calculationConditions(value)
    note = calculationNote(value)
  }
  else if (kind === "catalog_overview") note = "已读取目录概览"
  else if (kind === "answer_present" && value.status === "delivered") note = "回答已生成"
  else if (kind === "runtime_delivery" && value.status === "delivered") note = "已整理正式回执"
  if (isError && !note) note = "执行失败"
  const failed = Boolean(note) && typeof value.status === "string" && ["error", "failed", "ARGUMENT_ERROR"].includes(value.status)
  return conditions || note ? { ...(conditions ? { conditions } : {}), ...(note ? { note } : {}),
    ...(failed ? { failed: true } : {}) } : undefined
}
