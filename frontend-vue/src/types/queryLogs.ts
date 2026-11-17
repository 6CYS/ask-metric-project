export type LogStatus = "success" | "failed" | "cancelled" | "waiting_user" | "running" | "unknown"
export interface LogStep {
  id: string
  name: string
  status: LogStatus
  duration_ms: number | null
  note: string
}
export interface LogRound {
  id: string
  number: number
  question: string
  answers: string[]
  started_at: number | null
  ended_at: number | null
  duration_ms: number | null
  status: LogStatus
  retry_count: number
  operation_id: string | null
  request_id: string | null
  model: string | null
  error_code: string | null
  task_ids: string[]
  steps: LogStep[]
  query_started: boolean
  access_restricted: boolean
  context: { organizations: string[]; dates: string[]; metrics: string[] }
}
export interface LogSession {
  session_id: string
  title: string
  created_at: number
  last_active_at: number
  rounds: LogRound[]
  legacy: boolean
}
export interface LogSessionItem extends Omit<LogSession, "rounds"> {
  round_count: number
  failed_count: number
  status: LogStatus
  last_question: string
  matched_text: string | null
}
export interface LogSessionList {
  items: LogSessionItem[]
  total: number
  page: number
  page_size: number
  stats: {
    sessions: number
    rounds: number
    failed_rounds: number
    average_duration_ms: number | null
  }
}
export interface LogFilters {
  search: string
  range: "today" | "7d" | "all"
  errors_only: boolean
  page: number
  page_size: number
}
