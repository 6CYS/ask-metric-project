/**
 * FastAPI 后端客户端：agent 的业务取数只经由这里的受治理接口，
 * 每次调用透传当前用户的 Bearer，由后端完成目录校验、权限裁剪与模板化 SQL。
 * 本客户端不缓存任何业务数据。
 */

export interface BackendUser {
  id: string;
  username: string;
  display_name: string;
  org_code: string;
  org_name: string;
  role_code: string;
}

export interface MetricCatalogItem {
  metric_code: string;
  metric_name: string;
  metric_explanation?: string | null;
  description?: string | null;
  unit?: string | null;
  synonyms?: string[];
  enabled?: boolean;
}

export interface OrgCatalogItem {
  org_code: string;
  org_name: string;
  aliases?: string[];
  enabled?: boolean;
}

export interface TaskClarification {
  prompt?: string;
  missing?: string[];
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
}

export interface QueryExecutionResult {
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
}

/** 结构化基础查询（basic-queries）契约：不调用模型，按正式编码与明确日期取数 */
export interface BasicQuerySpec {
  metric_codes: string[];
  org_codes: string[];
  time: { start: string; end: string };
  selection: "exact" | "latest_in_range" | "all_in_range";
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
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}

export class BackendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { detail?: unknown };
          if (typeof body.detail === "string") detail = body.detail;
        } catch {
          // 保留默认状态描述
        }
        throw new BackendApiError(response.status, detail);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  getMe(): Promise<BackendUser> {
    return this.request<BackendUser>("/api/v1/auth/me");
  }

  listMetrics(): Promise<{ items: MetricCatalogItem[] }> {
    return this.request<{ items: MetricCatalogItem[] }>("/api/v1/catalog/metrics");
  }

  listOrganizations(): Promise<{ items: OrgCatalogItem[] }> {
    return this.request<{ items: OrgCatalogItem[] }>("/api/v1/catalog/organizations");
  }

  submitQuestion(message: string, conversationId: string | null, idempotencyKey: string): Promise<TaskCommandResult> {
    return this.request<TaskCommandResult>("/api/v1/questions", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        conversation_id: conversationId,
        message,
        idempotency_key: idempotencyKey,
      }),
    });
  }

  analyzeTask(taskId: string, expectedVersion: number): Promise<TaskCommandResult> {
    return this.request<TaskCommandResult>(
      `/api/v1/query-tasks/${encodeURIComponent(taskId)}/analyze`,
      { method: "POST", body: JSON.stringify({ expected_version: expectedVersion }) },
    );
  }

  executeTask(taskId: string, expectedVersion: number, requestId: string): Promise<QueryExecutionResult> {
    return this.request<QueryExecutionResult>(
      `/api/v1/query-tasks/${encodeURIComponent(taskId)}/execute`,
      {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({ expected_version: expectedVersion }),
      },
    );
  }

  getTask(taskId: string): Promise<TaskCommandResult> {
    return this.request<TaskCommandResult>(
      `/api/v1/query-tasks/${encodeURIComponent(taskId)}`,
    );
  }

  basicQueries(spec: BasicQuerySpec, idempotencyKey: string): Promise<BasicQueryResponse> {
    return this.request<BasicQueryResponse>("/api/v1/basic-queries", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(spec),
    });
  }
}
