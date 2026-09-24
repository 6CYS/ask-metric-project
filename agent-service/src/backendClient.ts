/**
 * FastAPI 后端客户端：agent 的业务取数只经由这里的受治理接口，
 * 每次调用透传当前用户的 Bearer，由后端完成目录校验、权限裁剪与模板化 SQL。
 * 本客户端不缓存任何业务数据。
 *
 * 幂等与取消：调用方提供稳定键（Idempotency-Key / X-Request-ID），
 * 不使用随机键；AbortSignal.any 合并调用方取消与 HTTP 超时。
 */

export interface BackendUser {
  id: string;
  username: string;
  display_name: string;
  org_code: string;
  org_name: string;
  role_code: string;
}

export interface AvailabilityRequest {
  dimension: "metrics" | "dates";
  org_codes: string[];
  metric_codes?: string[];
  start?: string;
  end?: string;
  match?: "any" | "all";
  page?: number;
  page_size?: number;
}

export interface AvailabilityResult {
  status: "succeeded";
  request: AvailabilityRequest;
  mode: string;
  metric_count: number;
  org_count: number;
  org_names: string[];
  metric_names?: string[];
  items?: Array<{metric_code: string; metric_name: string}>;
  groups: Array<{date_count: number; earliest: string | null; latest: string | null; dates: string[]; has_more: boolean}>;
  page: number;
  page_size: number;
  has_more?: boolean;
  notice: string;
}

/** 目录检索命中类型：exact/contains/lexical 为确定性命中，semantic 仅为语义近似推荐 */
export type CatalogMatchType = "exact" | "contains" | "lexical" | "semantic";

export interface MetricSearchHit {
  metric_code: string;
  metric_name: string;
  unit?: string | null;
  synonyms?: string[];
  score: number;
  match_type: CatalogMatchType;
}

export interface MetricSearchResponse {
  /** 确定性命中总数（切片前），与 items.length 之差即未返回的命中 */
  total: number;
  items: MetricSearchHit[];
  /** embedding 语义近似推荐，不计入 total，不得据此锁定编码 */
  semantic_suggestions: MetricSearchHit[];
}

export interface OrgSearchHit {
  org_code: string;
  org_name: string;
  aliases?: string[];
  score: number;
  match_type: CatalogMatchType;
}

export interface OrgSearchResponse {
  total: number;
  items: OrgSearchHit[];
}

export interface TaskClarification {
  id?: string;
  prompt?: string;
  missing?: string[];
  fields?: unknown[];
  understood?: {
    metrics?: string[];
    orgs?: string[];
    time?: string;
    operations?: string[];
  };
  [key: string]: unknown;
}

export interface TaskCommandResult {
  task_id: string;
  conversation_id: string;
  version: number;
  status: "RUNNING" | "WAITING_USER" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED";
  current_stage?: string;
  clarification?: TaskClarification | null;
  missing?: string[];
  query_shape?: string | null;
  resolved_question?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  idempotent_replay?: boolean;
  /** 轻量结果引用；完整事实经 result 接口分页读取 */
  result?: {
    result_id?: string;
    task_id?: string;
    source_run_id?: number | null;
    status?: string;
    row_count?: number;
    truncated?: boolean;
  } | null;
}

/** 回答正文片段：bold 标记加粗渲染 */
export interface AnswerSegment {
  text: string;
  bold: boolean;
}

/** 回答正文的结构化块：后端确定性渲染产出，缺省（null/缺字段）时前端回退纯文本解析 */
export type AnswerBlock =
  | { type: "paragraph"; segments: AnswerSegment[] }
  | { type: "list"; ordered: boolean; items: AnswerSegment[][] }
  | { type: "table"; header: AnswerSegment[][]; rows: AnswerSegment[][][]; aligns: ("left" | "center" | "right")[] };

export interface CalculationFact {
  fact_id: string; task_id: string; field: string; value: string; unit: string;
  metric_code: string; metric_name: string; org_code: string; org_name: string; date: string;
}
export interface CalculationSpec {
  expressions: Array<{name: string; label: string; expression: string; display?: "decimal" | "percent"; decimal_places?: number}>;
  bindings: Record<string, {fact_id: string}>;
  constants?: Record<string, {value: string; source_text: string}>;
  scope_policy?: "same_org_date" | "cross_date" | "cross_org" | "explicit";
}
export interface CalculationResult {
  status: string; calculation_id: string; task_id: string; scope_id: string;
  results: Array<{name: string; label: string; expression: string; value: string; display_value: string; unit: string; variables: string[]}>;
  inputs: Record<string, CalculationFact>;
  public_answer: string;
}
export interface QueryExecutionResult {
  facts?: CalculationFact[];
  task_id: string;
  status: "succeeded" | "failed" | "unsupported";
  query_shape?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated?: boolean;
  error_code?: string | null;
  error_message?: string | null;
  message?: string | null;
  /** 结构化回答正文；null/缺省表示无 */
  answer_blocks?: AnswerBlock[] | null;
  /** 受控计算结果（如机构对比明细），由后端确定性产出 */
  comparisons?: Record<string, unknown>[];
  /** 已执行查询的正式条件；空结果同样有证据，不能靠样例行还原上下文。 */
  evidence?: Record<string, unknown>;
}

/** 统一结果读取的分页视图（GET /query-tasks/{id}/result） */
export interface TaskResultPage {
  facts?: CalculationFact[];
  calculation_scope_id?: string | null;
  task_id: string;
  result_id: string;
  status: string;
  query_shape?: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  comparisons: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  offset: number;
  limit: number;
  next_offset: number | null;
  has_more: boolean;
  message?: string | null;
  /** 结构化回答正文；null/缺省表示无 */
  answer_blocks?: AnswerBlock[] | null;
  evidence?: Record<string, unknown>;
}

/** 结构化基础查询（basic-queries）契约：不调用模型，按正式编码与明确日期取数 */
export interface BasicQuerySpec {
  conversation_id?: string;
  calculation_context?: {scope_id: string; user_question: string};
  source_question?: string;
  metric_codes: string[];
  schema_version?: 2;
  org_codes?: string[];
  organization_scope?: import("./business-context/types.js").OrganizationScope;
  scope_fingerprint?: string;
  time: { start: string; end: string; dates?: string[] };
  selection: "exact" | "latest_in_range" | "all_in_range";
  operation?: import("./business-context/types.js").QueryOperation;
}

export interface BasicQueryResponse {
  query: BasicQuerySpec;
  result: QueryExecutionResult & {
    error_code?: string | null;
    evidence?: {
      catalog?: {
        metrics?: Array<{ code?: string; name?: string; unit?: string }>;
        organizations?: Array<{ code?: string; name?: string }>;
      };
      coverage_notice?: string | null;
      missing_metric_notice?: string | null;
    };
  };
}

export class BackendApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 后端结构化错误码（ApplicationError.code）；未知错误为空 */
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}

interface CallOptions {
  /** 调用方取消信号（原生 Context.abortSignal），与 HTTP 超时合并 */
  signal?: AbortSignal | undefined;
  /** 稳定请求标识：后端幂等记录按它回读，重试必须复用同一值 */
  requestId?: string | undefined;
  idempotencyKey?: string | undefined;
}

export class BackendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly traceId?: string,
  ) {}

  /** 保留各阶段幂等键，另用 Trace-ID 关联同一用户问答。 */
  withTraceId(traceId: string): BackendClient {
    return new BackendClient(this.baseUrl, this.token, this.timeoutMs, traceId);
  }

  private async request<T>(path: string, init: RequestInit = {}, options: CallOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // 合并调用方取消与本地超时；区分取消与超时由调用方按 signal 来源判断
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      };
      if (options.requestId) headers["X-Request-ID"] = options.requestId;
      if (this.traceId) headers["X-Trace-ID"] = this.traceId;
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, signal, headers });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        let code: string | undefined;
        let details: unknown;
        try {
          const body = (await response.json()) as {
            code?: unknown;
            message?: unknown;
            detail?: unknown;
            details?: unknown;
          };
          if (typeof body.code === "string") code = body.code;
          if (typeof body.message === "string") message = body.message;
          else if (typeof body.detail === "string") message = body.detail;
          details = body.details;
        } catch {
          // 保留默认状态描述
        }
        throw new BackendApiError(response.status, message, code, details);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  getMe(options?: CallOptions): Promise<BackendUser> {
    return this.request<BackendUser>("/api/v1/auth/me", {}, options);
  }

  resolveBusinessField(entity: string, rawValues: string[], options?: CallOptions, referenceYear?: number): Promise<import("./business-context/types.js").FieldResolution> {
    return this.request("/api/v1/business-context/resolve-field", {
      method: "POST", body: JSON.stringify({entity, raw_values: rawValues, ...(referenceYear !== undefined ? {reference_year: referenceYear} : {})}),
    }, options);
  }

  resolveOrganizationScope(scope: import("./business-context/types.js").OrganizationScopeInput, options?: CallOptions): Promise<import("./business-context/types.js").FieldResolution> {
    return this.request("/api/v1/business-context/resolve-scope", {
      method: "POST", body: JSON.stringify({kind: scope.kind, source_text: scope.sourceText,
        ...(scope.kind === "authorized_cohort" ? {cohort: scope.cohort} : {parent_name: scope.parentName})}),
    }, options);
  }

  matchMetricQuestion(question: string, options?: CallOptions): Promise<import("./business-context/metricMentions.js").MetricMentions> {
    return this.request("/api/v1/business-context/metric-mentions", {
      method: "POST", body: JSON.stringify({question}),
    }, options);
  }

  /** 指标目录检索：后端混合召回（exact/contains/lexical + embedding 语义推荐），total 为切片前命中数 */
  searchMetrics(keyword: string, limit: number, options?: CallOptions): Promise<MetricSearchResponse> {
    const query = new URLSearchParams({ keyword, limit: String(limit) });
    return this.request<MetricSearchResponse>(`/api/v1/catalog/metrics/search?${query}`, {}, options);
  }

  /** 机构目录检索：后端确定性档位（exact/前缀/包含），不做模糊匹配 */
  searchOrganizations(keyword: string, limit: number, options?: CallOptions): Promise<OrgSearchResponse> {
    const query = new URLSearchParams({ keyword, limit: String(limit) });
    return this.request<OrgSearchResponse>(`/api/v1/catalog/organizations/search?${query}`, {}, options);
  }

  getTask(taskId: string, options?: CallOptions): Promise<TaskCommandResult> {
    return this.request<TaskCommandResult>(
      `/api/v1/query-tasks/${encodeURIComponent(taskId)}`,
      {},
      options,
    );
  }

  /** 统一结果读取：不可变快照的分页事实 */
  getTaskResult(taskId: string, offset = 0, limit = 100, options?: CallOptions, originalQuestion?: string): Promise<TaskResultPage> {
    if (originalQuestion !== undefined) {
      return this.request<TaskResultPage>(
        `/api/v1/query-tasks/${encodeURIComponent(taskId)}/result`,
        { method: "POST", body: JSON.stringify({ original_question: originalQuestion, offset, limit }) },
        options,
      );
    }
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.request<TaskResultPage>(
      `/api/v1/query-tasks/${encodeURIComponent(taskId)}/result?${query}`,
      {},
      options,
    );
  }

  metricCatalogOverview(options?: CallOptions): Promise<{total: number; groups: Array<{unit: string; count: number; examples: Array<{code: string; name: string}>}>}> {
    return this.request("/api/v1/catalog/metrics/overview", {}, options);
  }

  dataAvailability(spec: AvailabilityRequest, options?: CallOptions): Promise<AvailabilityResult> {
    return this.request("/api/v1/data-availability", {method: "POST", body: JSON.stringify(spec)}, options);
  }

  createAgentQueryContext(sessionId: string, options?: CallOptions): Promise<{conversation_id: string}> {
    return this.request("/api/v1/agent-query-contexts", {method: "POST", body: JSON.stringify({session_id: sessionId})}, options);
  }

  calculate(spec: CalculationSpec & {conversation_id: string; scope_id: string}, key: string, options?: CallOptions): Promise<CalculationResult> {
    return this.request("/api/v1/calculations", {method: "POST", body: JSON.stringify(spec)}, {...options, idempotencyKey: key});
  }

  basicQueries(spec: BasicQuerySpec, idempotencyKey: string, options?: CallOptions): Promise<BasicQueryResponse> {
    return this.request<BasicQueryResponse>(
      "/api/v1/basic-queries",
      { method: "POST", body: JSON.stringify(spec) },
      { ...options, idempotencyKey },
    );
  }
}
