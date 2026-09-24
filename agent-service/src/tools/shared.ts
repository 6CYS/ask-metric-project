/**
 * 业务工具共享逻辑：结果裁剪常量、失败原因映射、日期校验与统一错误结果。
 * 各工具只负责自己的参数与调用链，公共规则集中在这里避免分散复制。
 */
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { BackendApiError, type AnswerBlock } from "../backendClient.js";
import type { AskMetricRequestContext } from "../requestContext.js";

/** 联合参数已选定动作时只反馈该分支错误；仍用原生校验器，不放宽 schema。 */
export function withFocusedArgumentErrors(
  tool: AgentHarnessTool<AskMetricRequestContext>,
): AgentHarnessTool<AskMetricRequestContext> {
  type Branch = TSchema & {properties?: Record<string, unknown>; description?: string};
  const branches = (tool.parameters as TSchema & {anyOf?: Branch[]}).anyOf;
  if (!branches) return tool;
  return {...tool, prepareArguments: (args: unknown) => {
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) return prepared;
    const values = prepared as Record<string, unknown>;
    const matching = branches.filter(branch => {
      const constants = Object.entries(branch.properties ?? {}).filter(([, schema]) =>
        schema && typeof schema === "object" && "const" in schema,
      ) as [string, {const: unknown}][];
      return constants.length > 0 && constants.every(([key, schema]) => values[key] === schema.const);
    });
    if (matching.length !== 1) return prepared;
    const branch = matching[0]!;
    try {
      return validateToolArguments({...tool, parameters: branch}, {
        type: "toolCall", id: "argument-validation", name: tool.name, arguments: values,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}${branch.description ? `\n当前参数分支：${branch.description}` : ""}`);
    }
  }};
}

/** 变量/常数名约束：与后端 calculation.Name 同一规则，后端仍是唯一权威 */
export const NAME_PATTERN = "^[a-zA-Z][a-zA-Z0-9_]{0,31}$";

/**
 * 语义等价于 Type.Record，但补上 additionalProperties:false。
 * Type.Record 只生成 patternProperties，JSON Schema 语义下不匹配 pattern 的键会被放行；
 * 这里把"键必须匹配 pattern"变成硬约束，非法键在宿主校验阶段即被拒绝并回给模型纠正。
 */
export function strictRecord<T extends TSchema>(
  value: T,
  limits: { minProperties?: number; maxProperties?: number } = {},
) {
  return Type.Unsafe<Record<string, Static<T>>>({
    type: "object",
    patternProperties: { [NAME_PATTERN]: value },
    additionalProperties: false,
    ...limits,
  });
}

/** 给模型的明细行数上限：只提供少量样例行供核对口径，全量明细由前端结果表展示，避免模型在正文罗列 */
export const MAX_ROWS_FOR_MODEL = 3;

/** 非 succeeded 时按 error_code 映射的固定原因文案，与后端治理语义保持一致 */
const FAILURE_REASON_BY_CODE: Record<string, string> = {
  ORG_SCOPE_FORBIDDEN: "无权查询该机构，请确认机构范围。",
  QUERY_UNSUPPORTED: "查询条件不受支持或机构编码不在目录中，机构编码必须先经 catalog 检索机构确认。",
};

/**
 * 非 succeeded 结果必须给模型可读原因：优先后端 error_message，
 * 为空（后端治理拦截时常见）时按 error_code 映射模板，让模型能自我纠正而不是瞎猜。
 */
export function failureReason(errorCode: string | null | undefined, errorMessage: string | null | undefined): string {
  if (errorMessage) return errorMessage;
  return FAILURE_REASON_BY_CODE[errorCode ?? ""] ?? "查询执行失败。";
}

/** 指标/机构目录检索共用的参数结构 */
export const catalogSearchParameters = Type.Object({
  keyword: Type.String({ minLength: 1, description: "检索关键词，按编码、名称、别名匹配" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "最多返回条数" })),
});

/** 结构化基础查询明细：与 metric_ask 同一展示契约，kind 标记取数通道 */
export interface StructuredQueryDetails {
  retryable?: boolean;
  kind: "metric_query_structured";
  task_id?: string;
  version?: number | undefined;
  result_id?: string | undefined;
  public_answer?: string | undefined;
  status: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  row_count?: number;
  truncated?: boolean | undefined;
}

export interface CatalogSearchDetails {
  kind: "metric_catalog_search" | "org_catalog_search";
  keyword: string;
  total: number;
}

export interface ErrorDetails {
  kind: string;
  status: string;
  public_answer?: string;
  retryable?: boolean;
  message?: string | undefined;
  error_code?: string | undefined;
}

export function errorResult<TDetails extends ErrorDetails>(message: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }],
    details: {...details, public_answer: message},
  };
}

/** 从统一错误信封的 details.fields 提取字段级校验摘要，供模型定位并修正参数 */
function validationFieldsSummary(details: unknown): string {
  const fields = (details as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields) || !fields.length) return "";
  const parts = fields
    .filter((field): field is { path?: unknown; rule?: unknown } => typeof field === "object" && field !== null)
    .map(field => `${String(field.path ?? "?")}（${String(field.rule ?? "invalid")}）`);
  return parts.length ? ` 未通过校验的字段：${parts.join("、")}。` : "";
}

export function backendErrorResult<TDetails extends ErrorDetails>(
  error: unknown,
  details: TDetails,
): AgentToolResult<TDetails> | undefined {
  if (!(error instanceof BackendApiError)) return undefined;
  if (error.status === 401) return errorResult("登录状态已失效，请刷新页面重新登录。", details);
  if (error.status === 403) return errorResult("无权访问所选数据，请确认机构权限。", details);
  if (error.status === 422) {
    // 参数/口径类错误可纠正：透传后端具体原因，模型据此修正一次；纠错次数由宿主限额兜底。
    const message = error.code === "REQUEST_INVALID"
      ? `请求参数未通过校验。${validationFieldsSummary(error.details)}`
      : error.code ? error.message : "请求参数未通过校验，请核对后修正一次。";
    return errorResult(message, { ...details, retryable: true });
  }
  // 5xx/超时/网络中断：提交结果未知，如实表达，不暗示存在等待中的后台任务。
  return errorResult("本次请求未得到确认响应，请勿重复提交。", details);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 真实日历校验：正则只挡格式，2026-02-30 这类不存在的日期必须额外拒绝 */
export function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
  );
}

/** 旧查询回执的只读投影类型，不注册或恢复旧执行器。 */
export interface MetricAskDetails {
  kind: "metric_ask";
  task_id?: string | undefined;
  version?: number | undefined;
  result_id?: string | undefined;
  source_task_id?: string;
  status: string;
  columns?: string[] | undefined;
  row_count?: number | undefined;
  truncated?: boolean | undefined;
  clarification?: unknown;
  public_answer?: string;
  public_answer_blocks?: AnswerBlock[];
  error_code?: string;
  retryable?: boolean;
  recovery_kind?: string;
  next_action?: string;
}
