export interface DiagnosticTarget {
  model: string
  configuration_source: "file" | "database"
  configuration_version: string | null
  first_response_timeout_ms: number
  stream_idle_timeout_ms: number
  max_duration_ms: number
  cooldown_ms: number
}

export interface DiagnosticStarted {
  diagnostic_id: string
  started_at: string
  target: DiagnosticTarget
}

export interface DiagnosticModelResponse {
  http_status: number | null
  content: string
  error: string
  error_source: "http" | "client" | null
  truncated: boolean
}

export interface DiagnosticResult extends DiagnosticStarted {
  finished_at: string
  status: "succeeded" | "failed" | "cancelled"
  first_output_ms: number | null
  duration_ms: number
  error_code: string | null
  message: string
  model_response?: DiagnosticModelResponse
}

export type DiagnosticProgress =
  | ({ type: "started" } & DiagnosticStarted)
  | { type: "progress"; phase: "receiving"; first_output_ms: number }
