import { createDataAvailabilityTool } from "./dataAvailability.js";
import { createCatalogOverviewTool } from "./catalogOverview.js";
import { clarificationAnswer, type ClarificationSelection } from "./clarification.js";
/**
 * Agent 业务工具：通过 BackendClient 调用 FastAPI 受治理接口。
 * 模型只选择工具与参数；指标/机构校验、权限裁剪、SQL 模板执行全部在后端完成。
 */
import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { BackendApiError, BackendClient } from "./backendClient.js";
import type { CalculationContext, QueryExecutionResult, TaskCommandResult } from "./backendClient.js";
import { createCalculationTool } from "./calculationTool.js";

export interface PendingClarification {
  taskId: string; version: number; clarificationId: string;
  scope: CalculationContext;
}

export interface QueryToolContext {
  conversationId: string;
  scope: CalculationContext;
  facts: Set<string>;
  pending: PendingClarification | undefined;
  userMessage: string;
  selection?: ClarificationSelection | undefined;
  ensureReady(): Promise<void>;
  assertActive(): void;
  finishAvailability?(): void;
  setPending(value: PendingClarification | undefined): void;
}

function calculationFacts(result: QueryExecutionResult, context?: QueryToolContext) {
  const facts = (result.facts ?? []).slice(0, 100);
  for (const fact of facts) context?.facts.add(fact.fact_id);
  return { facts, fact_count: result.facts?.length ?? 0, facts_truncated: (result.facts?.length ?? 0) > facts.length };
}

/** 给模型的明细行数上限：只提供少量样例行供核对口径，全量明细由前端结果表展示，避免模型在正文罗列 */
const MAX_ROWS_FOR_MODEL = 3;

const metricAskParameters = Type.Object({
  question: Type.String({
    minLength: 1,
    description: "完整的自然语言问数问题，需包含指标、机构和时间等条件，例如“2026年8月全省农商行存款余额”",
  }),
});

const catalogSearchParameters = Type.Object({
  keyword: Type.String({ minLength: 1, description: "检索关键词，按编码、名称、别名匹配" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "最多返回条数" })),
});

export interface MetricAskDetails {
  kind: "metric_ask";
  task_id?: string;
  status: string;
  message?: string | null | undefined;
  error_code?: string | null | undefined;
  columns?: string[];
  rows?: Record<string, unknown>[];
  row_count?: number;
  truncated?: boolean | undefined;
  clarification_prompt?: string | undefined;
  /** 后端澄清结构原样透传，供前端渲染结构化澄清表单 */
  clarification?: unknown;
}

/** 结构化基础查询明细：与 metric_ask 同一展示契约，kind 标记取数通道 */
export interface StructuredQueryDetails {
  kind: "metric_query_structured";
  task_id?: string;
  status: string;
  message?: string | null | undefined;
  error_code?: string | null | undefined;
  columns?: string[];
  rows?: Record<string, unknown>[];
  row_count?: number;
  truncated?: boolean | undefined;
}

export type QueryResultDetails = MetricAskDetails | StructuredQueryDetails;

function errorResult(message: string): AgentToolResult<MetricAskDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }],
    details: { kind: "metric_ask", status: "error" },
  };
}

function backendErrorResult(error: unknown): AgentToolResult<MetricAskDetails> | undefined {
  if (!(error instanceof BackendApiError)) return undefined;
  if (error.status === 401 || error.status === 403) {
    // 账号单会话机制下旧令牌会失效；给模型明确的用户引导，不暴露原始状态码
    const result = errorResult("当前请求未通过身份或权限校验，请重新登录或核对查询权限。");
    result.details.error_code = error.status === 401 ? "AUTH_REQUIRED" : "PERMISSION_DENIED";
    return result;
  }
  return errorResult(`后端请求失败（${error.status}）：${error.message}`);
}

/**
 * 一次性完成“提交问题 → 语义解析 → 执行查询”的受治理问数链路。
 * 解析结果缺少条件时返回澄清信息，由 agent 引导用户补充，不代填条件。
 */
export function createMetricAskTool(client: BackendClient, context?: QueryToolContext): AgentTool<typeof metricAskParameters, MetricAskDetails> {
  const tool: AgentTool<typeof metricAskParameters, MetricAskDetails> = {
    name: "metric_ask",
    label: "指标问数",
    description:
      "执行一次受治理的经营指标问数：提交自然语言问题，经后端目录校验、权限裁剪后按登记 SQL 模板查询。" +
      "需要具体的指标、机构和时间条件；条件不足时返回澄清提示，请把澄清内容转告用户补充，不要自行编造数值或机构。",
    parameters: metricAskParameters,
    execute: async (_toolCallId, params: Static<typeof metricAskParameters>) => {
      try {
        await context?.ensureReady();
        let analyzed: TaskCommandResult;
        if (context?.pending) {
          const pending = context.pending;
          analyzed = await client.clarifyTask(pending.taskId, pending.version, pending.clarificationId, clarificationAnswer(context.userMessage, context.selection));
        } else {
          const submitted = await client.submitQuestion(params.question, context?.conversationId ?? null, randomUUID(), context?.scope);
          analyzed = await client.analyzeTask(submitted.task_id, submitted.version);
        }

        if (analyzed.clarification || analyzed.status === "WAITING_USER") {
          const clarification = analyzed.clarification ?? {};
          if (context && typeof clarification.id === "string") context.setPending({
            taskId: analyzed.task_id, version: analyzed.version, clarificationId: clarification.id, scope: context.scope,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "clarification_required",
                  prompt: clarification.prompt ?? "该问题缺少必要条件，请用户补充后重试。",
                  missing: clarification.missing ?? analyzed.missing ?? [],
                  understood: clarification.understood ?? null,
                }),
              },
            ],
            details: {
              kind: "metric_ask",
              task_id: analyzed.task_id,
              status: "clarification_required",
              clarification_prompt: clarification.prompt,
              clarification: analyzed.clarification ?? null,
            },
          };
        }
        if (analyzed.status === "FAILED" || analyzed.error_code) {
          context?.setPending(undefined);
          return errorResult(analyzed.error_message ?? "语义解析失败");
        }

        context?.setPending(undefined);
        context?.assertActive();
        const executed = await client.executeTask(analyzed.task_id, analyzed.version, randomUUID());
        const sampleRows = executed.rows.slice(0, MAX_ROWS_FOR_MODEL);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: executed.status,
                ...calculationFacts(executed, context),
                query_shape: executed.query_shape,
                columns: executed.columns,
                // 仅样例行供模型核对口径；明细数值的完整展示由用户界面的结果表承担
                sample_rows: sampleRows,
                row_count: executed.row_count,
                truncated: executed.truncated || executed.rows.length > MAX_ROWS_FOR_MODEL,
                message: executed.message ?? null,
                error_message: executed.error_message ?? null,
                display_hint:
                  "明细数据已在用户界面以结果表展示，回答正文不要逐条罗列数值，简洁概括即可。",
              }),
            },
          ],
          details: {
            kind: "metric_ask",
            task_id: executed.task_id,
            status: executed.status,
            message: executed.message,
            error_code: executed.error_code,
            columns: executed.columns,
            rows: executed.rows,
            row_count: executed.row_count,
            truncated: executed.truncated,
          },
        };
      } catch (error) {
        const handled = backendErrorResult(error);
        if (handled) return handled;
        throw error;
      }
    },
  };
  // 工具每轮重建：澄清补充仅提交一次；独立取数仍允许不同问题分别执行。
  const results = new Map<string, ReturnType<typeof tool.execute>>();
  let clarificationResult: ReturnType<typeof tool.execute> | undefined;
  return { ...tool, execute: (...args) => {
    if (clarificationResult) return clarificationResult;
    const key = args[1].question;
    const cached = results.get(key);
    if (cached) return cached;
    const wasPending = Boolean(context?.pending);
    const result = tool.execute(...args).then((value) => {
      if (value.details.status === "clarification_required") clarificationResult = result;
      return value;
    });
    results.set(key, result);
    if (wasPending) clarificationResult = result;
    return result;
  } };

}

export interface CatalogSearchDetails {
  kind: "metric_catalog_search" | "org_catalog_search";
  keyword: string;
  total: number;
}

function matchesKeyword(fields: Array<string | null | undefined>, keyword: string): boolean {
  const needle = keyword.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

export function createMetricCatalogSearchTool(
  client: BackendClient,
): AgentTool<typeof catalogSearchParameters, CatalogSearchDetails> {
  return {
    name: "metric_catalog_search",
    label: "指标目录检索",
    description: "在正式指标目录中按关键词检索指标编码、名称、别名与单位，用于确认指标是否存在及准确名称。",
    parameters: catalogSearchParameters,
    execute: async (_toolCallId, params: Static<typeof catalogSearchParameters>) => {
      const { items } = await client.listMetrics();
      const matched = items
        .filter((item) => item.enabled !== false)
        .filter((item) =>
          matchesKeyword([item.metric_code, item.metric_name, ...(item.synonyms ?? [])], params.keyword),
        )
        .slice(0, params.limit ?? 10)
        .map((item) => ({
          metric_code: item.metric_code,
          metric_name: item.metric_name,
          unit: item.unit ?? null,
          synonyms: item.synonyms ?? [],
        }));
      return {
        content: [{ type: "text", text: JSON.stringify({ total: matched.length, items: matched }) }],
        details: { kind: "metric_catalog_search", keyword: params.keyword, total: matched.length },
      };
    },
  };
}

export function createOrgCatalogSearchTool(
  client: BackendClient,
): AgentTool<typeof catalogSearchParameters, CatalogSearchDetails> {
  return {
    name: "org_catalog_search",
    label: "机构目录检索",
    description: "在正式机构目录中按关键词检索机构编码、名称与别名，用于确认机构是否存在及准确名称。",
    parameters: catalogSearchParameters,
    execute: async (_toolCallId, params: Static<typeof catalogSearchParameters>) => {
      const { items } = await client.listOrganizations();
      const matched = items
        .filter((item) => item.enabled !== false)
        .filter((item) =>
          matchesKeyword([item.org_code, item.org_name, ...(item.aliases ?? [])], params.keyword),
        )
        .slice(0, params.limit ?? 10)
        .map((item) => ({
          org_code: item.org_code,
          org_name: item.org_name,
          aliases: item.aliases ?? [],
        }));
      return {
        content: [{ type: "text", text: JSON.stringify({ total: matched.length, items: matched }) }],
        details: { kind: "org_catalog_search", keyword: params.keyword, total: matched.length },
      };
    },
  };
}

const structuredQueryParameters = Type.Object({
  metric_codes: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 100,
    description: "正式指标编码数组，必须来自 metric_catalog_search 或会话中已确认的编码，不得编造",
  }),
  org_codes: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 1000,
    description: "正式机构编码数组，必须来自 org_catalog_search、会话中已确认的编码或已展开的全目录集合，不得编造",
  }),
  start: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "起始日期 YYYY-MM-DD（含）" }),
  end: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "结束日期 YYYY-MM-DD（含）" }),
  selection: StringEnum(["exact", "latest_in_range", "all_in_range"], {
    description:
      "exact：起止必须同日的指定日原值；latest_in_range：范围内最后一个可用日期的原值（月末时点查询用此值）；all_in_range：范围内全部已有数据点",
  }),
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 结构化基础查询快速通道：agent 自行完成实体锁定与日期换算后，
 * 以正式编码和明确日期调用后端 basic-queries（不调用后端语义模型）。
 * 编码不是授权凭据，后端仍按当前用户权限与启用目录校验。
 */
export function createStructuredQueryTool(
  client: BackendClient,
  context?: QueryToolContext,
): AgentTool<typeof structuredQueryParameters, StructuredQueryDetails> {
  return {
    name: "metric_query_structured",
    label: "指标结构化查询",
    description:
      "以正式指标编码、机构编码和明确日期直接取数（不经过语义解析）。仅当指标、机构、日期都能确定为正式编码和绝对日期时使用；" +
      "条件不明确、叫法拿不准或需要澄清的问题改用 metric_ask。日期规则：明确的某月末/某日用 start=end 并 selection=exact；" +
      "某月末时点取值用该月1日至月末日、selection=latest_in_range；整月或区间取值用对应区间、selection=latest_in_range；逐月趋势用 all_in_range。",
    parameters: structuredQueryParameters,
    execute: async (_toolCallId, params: Static<typeof structuredQueryParameters>) => {
      if (!DATE_ONLY.test(params.start) || !DATE_ONLY.test(params.end) || params.start > params.end) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "日期必须是 YYYY-MM-DD 且 start 不晚于 end" }) }],
          details: { kind: "metric_query_structured" as const, status: "error" },
        };
      }
      if (params.selection === "exact" && params.start !== params.end) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "selection=exact 时 start 与 end 必须是同一天" }) }],
          details: { kind: "metric_query_structured" as const, status: "error" },
        };
      }
      try {
        if (context?.pending) return { ...errorResult("当前任务等待补充，请先调用 metric_ask 提交用户补充内容。"), details: { kind: "metric_query_structured", status: "error" } };
        await context?.ensureReady();
        const { result } = await client.basicQueries(
          {
            metric_codes: [...new Set(params.metric_codes)],
            org_codes: [...new Set(params.org_codes)],
            time: { start: params.start, end: params.end },
            selection: params.selection as "exact" | "latest_in_range" | "all_in_range",
          },
          randomUUID(),
          context?.conversationId,
          context?.scope,
        );
        const sampleRows = result.rows.slice(0, MAX_ROWS_FOR_MODEL);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: result.status,
                ...calculationFacts(result, context),
                columns: result.columns,
                // 仅样例行供模型核对口径；明细数值的完整展示由用户界面的结果表承担
                sample_rows: sampleRows,
                row_count: result.row_count,
                truncated: Boolean(result.truncated),
                error_code: result.error_code ?? null,
                message: result.message ?? null,
                display_hint:
                  "明细数据已在用户界面以结果表展示，回答正文不要逐条罗列数值，简洁概括即可。",
              }),
            },
          ],
          details: {
            kind: "metric_query_structured",
            task_id: result.task_id,
            status: result.status,
            message: result.message,
            error_code: result.error_code,
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        const handled = backendErrorResult(error);
        if (handled) {
          return { ...handled, details: { ...handled.details, kind: "metric_query_structured" as const, status: "error" } };
        }
        throw error;
      }
    },
  };
}

export function createAskMetricTools(client: BackendClient, context?: QueryToolContext): AgentTool<any, any>[] {
  return [
    createCatalogOverviewTool(client),
    createDataAvailabilityTool(client, context?.finishAvailability),
    createStructuredQueryTool(client, context),
    createMetricAskTool(client, context),
    createMetricCatalogSearchTool(client),
    createOrgCatalogSearchTool(client),
    ...(context ? [createCalculationTool(client, context)] : []),
  ];
}
