/** 问数运行日志。字段与后端 QueryRunRead 保持一致。 */
export type QueryRunItem = {
  id: number | string
  task_id?: string
  conversation_id?: string
  user_message: string
  resolved_question?: string | null
  clarification_answers?: Array<Record<string, unknown>>
  intent: string
  query_shape?: string
  raw_org_text?: string | null
  matched_text?: string | null
  matched_org_name?: string | null
  org_match_type?: string | null
  status: string
  task_status?: string
  current_stage?: string
  failed_node?: string | null
  error_type?: string | null
  error_message?: string | null
  error_code?: string | null
  retry_count: number
  created_at?: string
  trace?: Array<Record<string, unknown>>
  timings_ms?: Record<string, number>
  debug?: Record<string, unknown>
}

/** 当前运行时实际采用的大模型配置，API Key 只返回是否已配置。 */
export type ModelRole = "chat" | "embedding" | "reranker"

export type ModelAuthenticationConfig = {
  type: "none" | "bearer" | "header"
  header: string
  prefix: string
}

export type ModelEndpointConfig = {
  enabled: boolean
  base_url: string
  path: string
  model: string
  send_model: boolean
  api_key_env: string
  authentication: ModelAuthenticationConfig
  timeout_seconds: number
  extra_body: Record<string, unknown>
}

export type ChatModelConfig = ModelEndpointConfig & {
  temperature: number | null
  max_tokens: number | null
  response_format: "text" | "json_object"
  send_response_format: boolean
  enable_thinking: boolean
  send_enable_thinking: boolean
  user_message_suffix: string
  chat_template_kwargs: {
    enable_thinking: boolean
    [key: string]: unknown
  }
}

export type ModelRuntimeConfig = {
  schema_version: 2
  provider: string
  models: {
    chat: ChatModelConfig
    embedding: ModelEndpointConfig & {
      dimensions: number | null
      encoding_format: "float" | "base64" | null
      user: string | null
    }
    reranker: ModelEndpointConfig & {
      top_n: number
      return_documents: boolean
      send_top_n: boolean
      send_return_documents: boolean
      documents_field: "documents" | "texts"
    }
  }
}

export type PromptTemplateConfig = {
  version: string
  display_name: string
  description: string
  editable_fields: Array<"system" | "user_template" | "query_prefix" | "query_template">
  enable_thinking: boolean
  system?: string | null
  user_template?: string | null
  query_prefix?: string | null
  query_template?: string | null
}

export type SmartConfigResponse = {
  config: ModelRuntimeConfig
  prompts: { schema_version: number; prompts: Record<string, PromptTemplateConfig> }
  api_key_configured: Record<ModelRole, boolean>
  write_enabled: boolean
  write_token_required: boolean
}

export type ConfigVersion = {
  id: string
  resource_type: "prompt" | "sql"
  resource_key: string
  version_number: number
  action: "publish" | "rollback"
  created_at: string
  created_by: string
  source_version_id?: string | null
}

export type SqlTemplateConfig = {
  dialect: string
  template: string
  sql: string
  parameters: string[]
  editable: boolean
  enabled: boolean
}

/** 指标语义资产；说明、口径和同义词均参与前端模糊搜索。 */
export type MetricItem = {
  metric_code: string
  metric_name: string
  metric_explanation: string
  description: string
  unit?: string | null
  synonyms: string[]
  enabled: boolean
}

export type MetricPayload = Omit<MetricItem, "unit"> & { unit?: string }

/** 机构目录记录，aliases 由后端和提交前逻辑共同去重。 */
export type OrgItem = {
  org_code: string
  org_name: string
  aliases: string[]
  enabled: boolean
  created_at?: string | null
  updated_at?: string | null
}

export type OrgPayload = Pick<OrgItem, "org_code" | "org_name" | "aliases" | "enabled">

/** id 缺失表示后端根据 metric_values 表生成的只读默认数据集。 */
export type DatasetItem = {
  id?: number
  name: string
  datasource_type: string
  schema_name: string
  table_name: string
  dialect: string
  enabled: boolean
}

export type DatasetPayload = Omit<DatasetItem, "id">

export type ClarificationOption =
  | string
  | {
      code?: string
      name?: string
      kind?: "metric" | "organization" | "result"
      unit?: string | null
      display_label?: string
      patch?: SemanticPatch
      metric_code?: string
      metric_name?: string
      synonym?: string | null
      org_code?: string
      org_name?: string
      score?: number
    }

export type ClarificationField = {
  field: string
  target_field?: "metrics" | "orgs" | "time" | string
  type: "metric" | "organization" | "result" | "date_range" | "unsupported"
  label: string
  reason: string
  message: string
  selection_mode: "catalog" | "single" | "multiple" | "date_range" | "unsupported"
  min_selections?: number
  max_selections?: number | null
  options: ClarificationOption[]
  preserved_options?: ClarificationOption[]
  search_required?: boolean
  suggested_start?: string
  suggested_end?: string
}

/** 单次问数的完整响应，既用于最终 SSE 事件，也会原样写入历史消息快照。 */
export type ChatResponse = {
  message_id: string
  conversation_id?: string | null
  intent: string
  answer: string
  result: null | {
    type: string
    table?: {
      columns: string[]
      rows: Record<string, unknown>[]
    }
  }
  metric_definition: null | {
    metric_code: string
    metric_name: string
    description: string
    unit?: string
  }
  clarification: null | {
    type: string
    options: ClarificationOption[]
    fields?: ClarificationField[]
    understood?: ClarificationUnderstood
    reply_examples?: string[]
  }
    debug: null | Record<string, unknown>
    download?: {
      task_id: string
      row_count: number
      format: "xlsx"
    }
  }

export type SemanticPatch = {
  set: Record<string, unknown>
  add_ops: Record<string, unknown>[]
  remove_ops: Record<string, unknown>[]
}

export type BackendNextClarification = {
  id: string
  type: string
  prompt: string
  options: ClarificationOption[]
  fields?: ClarificationField[]
  understood?: ClarificationUnderstood
  reply_examples?: string[]
  missing?: string[]
  task_version?: number
}

export type ClarificationUnderstood = {
  metrics?: string[]
  orgs?: string[]
  time?: string
  operations?: string[]
}

export type BackendNextTaskResult = {
  result?: BackendNextExecutionResult | null
  task_id: string
  conversation_id: string
  version: number
  status: "RUNNING" | "WAITING_USER" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED"
  current_stage: string
  message_id?: string | null
  idempotent_replay?: boolean
  clarification?: BackendNextClarification | null
  continuation_token?: string | null
  slot_frame?: Record<string, unknown> | null
  logical_dsl?: Record<string, unknown> | null
  missing?: string[]
  query_shape?: string | null
  resolved_question?: string | null
  error_code?: string | null
  error_message?: string | null
  timings_ms?: Record<string, number>
  debug?: Record<string, unknown>
}

export type BackendNextExecutionResult = {
  run_id?: number | null
  task_id: string
  status: "succeeded" | "failed" | "unsupported"
  query_shape: string
  columns: string[]
  rows: Record<string, unknown>[]
  comparisons: Record<string, unknown>[]
  row_count: number
  truncated?: boolean
  latency_ms?: number | null
  error_code?: string | null
  error_message?: string | null
  message?: string | null
  task_version?: number | null
  task_status?: string | null
  idempotent_replay?: boolean
  timings_ms?: Record<string, number>
  debug?: Record<string, unknown>
}

export type BackendNextConversationMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  created_at?: string | null
  task_id?: string | null
  payload?: Record<string, unknown> | null
}

export type BackendNextConversationTask = {
  id: string
  status: BackendNextTaskResult["status"]
  current_stage: string
  version: number
  original_question: string
  query_shape?: string | null
  error_code?: string | null
  error_message?: string | null
  logical_dsl?: Record<string, unknown> | null
  timings_ms?: Record<string, number>
  debug?: Record<string, unknown>
}

export type BackendNextConversationSnapshot = {
  id: string
  title: string
  preview: string
  messages: BackendNextConversationMessage[]
  tasks: BackendNextConversationTask[]
}

export type AuthUser = {
  id: string
  username: string
  display_name: string
  org_code: string
  org_name: string
  role_code: "USER" | "SYSTEM_ADMIN"
  can_query_all_organizations?: boolean
}

export type LoginResponse = {
  access_token: string
  token_type: "bearer"
  expires_in: number
  user: AuthUser
}

export type Sm2PublicKeyResponse = {
  public_key: string
}

export type BackendNextConversationListItem = {
  id: string
  title: string
  preview: string
  created_at?: string | null
  updated_at?: string | null
  message_count?: number | null
}

export type BackendNextConversationCleanupResult = {
  keep_latest: number
  deleted_count: number
  remaining_count: number
  protected_active_count: number
}

export type AccuracyCase = {
  id: number
  question: string
  category: string
  expected_status?: string | null
  expected_shape?: string | null
  expected_metric_codes: string[]
  expected_metric_names: string[]
  expected_orgs: string[]
  expected_org_names: string[]
  expected_missing: string[]
  expected_row_count?: number | null
  expected_value?: number | null
  value_tolerance: number
}

export type AccuracySuite = {
  id: string
  name: string
  description: string
  cases: AccuracyCase[]
  created_at: string
  updated_at: string
}

export type AccuracyAssertion = {
  name: string
  expected: unknown
  actual: unknown
  passed: boolean
}

export type AccuracyResult = {
  id: number
  question: string
  status: string
  shape?: string
  metric_codes?: string[]
  orgs?: string[]
  row_count?: number
  error?: string
  assertions: AccuracyAssertion[]
  verdict: "passed" | "failed" | "needs_review"
  semantic_passed: boolean
  result_passed: boolean
}

export type AccuracyRun = {
  id: string
  suite_id: string
  suite_name: string
  status: "queued" | "running" | "completed" | "failed"
  total: number
  completed: number
  passed: number
  failed: number
  needs_review: number
  started_at: string
  finished_at?: string | null
  results: AccuracyResult[]
  error?: string | null
}

export type AccuracyImportRow = {
  row_number: number
  status: "valid" | "duplicate" | "error"
  question: string
  message: string
  case?: AccuracyCase | null
}

export type AccuracyImportPreview = {
  filename: string
  mode: "append" | "replace"
  total_rows: number
  valid_count: number
  duplicate_count: number
  error_count: number
  can_import: boolean
  rows: AccuracyImportRow[]
  cases: AccuracyCase[]
}

export type AccuracyImportResult = {
  suite: AccuracySuite
  imported_count: number
  skipped_count: number
}
export interface QueryReadiness {
  status: "initializing" | "ready" | "failed"
  message: string
  completed: number
  total: number
}
