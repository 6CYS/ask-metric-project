export interface QuerySqlReference {
  task_id: string
  run_id?: number
  result_id?: string
  label?: string
  description?: string
}

export interface QuerySqlDetail {
  task_id: string
  run_id: number
  result_id: string | null
  status: string
  sql_text: string | null
  sql_params: Record<string, unknown> | null
  sql_availability: "available" | "not_recorded"
  row_count: number | null
  latency_ms: number | null
  conditions: {
    orgs: Array<{ code: string; name: string | null }>
    metrics: Array<{ code: string; name: string | null; unit: string | null }>
    time: Record<string, unknown>
  }
  result: {
    columns: string[]
    rows: Record<string, unknown>[]
    row_count: number
    truncated: boolean
    offset: number
    limit: number
    next_offset: number | null
    has_more: boolean
  } | null
  result_unavailable_reason: "not_saved" | "different_run" | null
  notice: string | null
}
