/** 服务端持久化的路线诊断；实时流、重连快照和历史共用同一读取入口。 */
export interface WorkflowTrace {
  schema_version: 1
  workflow_id: string
  name: string
  version?: string
  basis?: string
  phase: string
  outcome?: string
  run_ref?: string
  retrieval?: {
    strategy?: string
    matched_document?: { id?: string; text?: string }
    embedding_model?: string
    reranker_model?: string
    rerank_score?: number
    other_class_score?: number
    min_score?: number
    min_margin?: number
  }
  date_policy?: {mode?: string; requested_start?: string | null; requested_end?: string | null; actual_dates?: string[]}
  coverage?: {requested_org_count?: number; valid_org_count?: number}
  interpretation?: string[]
  steps: Array<{
    id: string; method: string; rationale?: string; status: string
    depends_on?: string[]; organization_from_step?: string | null
    position?: string; top_n?: number
    metrics?: Array<{code?: string; name: string}>
    fact_count?: number; task_count?: number; org_count?: number
    actual_dates?: string[]; gaps?: string[]; error_code?: string
  }>
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const strings = (value: unknown) => value === undefined || Array.isArray(value) && value.every(v => typeof v === "string")
const count = (value: unknown) => value === undefined || typeof value === "number" && Number.isInteger(value) && value >= 0

function isTrace(value: unknown): value is WorkflowTrace {
  if (!record(value) || value.schema_version !== 1 || typeof value.workflow_id !== "string"
    || typeof value.name !== "string" || typeof value.phase !== "string" || !Array.isArray(value.steps)
    || !strings(value.interpretation)) return false
  if (value.retrieval !== undefined) {
    if (!record(value.retrieval)) return false
    const source = value.retrieval
    if (["rerank_score", "other_class_score", "min_score", "min_margin"]
      .some(key => source[key] !== undefined && (typeof source[key] !== "number" || !Number.isFinite(source[key])))) return false
    if (source.matched_document !== undefined && (!record(source.matched_document)
      || typeof source.matched_document.text !== "string")) return false
  }
  if (value.date_policy !== undefined && (!record(value.date_policy) || !strings(value.date_policy.actual_dates))) return false
  if (value.coverage !== undefined && (!record(value.coverage)
    || !count(value.coverage.requested_org_count) || !count(value.coverage.valid_org_count))) return false
  return value.steps.every(step => record(step) && typeof step.id === "string" && typeof step.method === "string"
    && typeof step.status === "string" && strings(step.depends_on) && strings(step.actual_dates) && strings(step.gaps)
    && [step.fact_count, step.task_count, step.org_count, step.top_n].every(count)
    && (step.metrics === undefined || Array.isArray(step.metrics)
      && step.metrics.every(metric => record(metric) && typeof metric.name === "string")))
}

export function workflowTracesFromDetails(details: unknown): WorkflowTrace[] {
  if (!record(details)) return []
  // 投影回执保留 semantic_task；原生回执则直接位于根节点。只读取版本化诊断字段。
  const trace = details.workflow_trace ?? (record(details.semantic_task) ? details.semantic_task.workflow_trace : undefined)
  return isTrace(trace) ? [trace] : []
}
