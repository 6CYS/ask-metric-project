/**
 * 业务工具共享逻辑：结果裁剪常量、失败原因映射、日期校验与统一错误结果。
 * 各工具只负责自己的参数与调用链，公共规则集中在这里避免分散复制。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { BackendApiError } from "../backendClient.js";

/** 给模型的明细行数上限：只提供少量样例行供核对口径，全量明细由前端结果表展示，避免模型在正文罗列 */
export const MAX_ROWS_FOR_MODEL = 3;

/** 非 succeeded 时按 error_code 映射的固定原因文案，与后端治理语义保持一致 */
const FAILURE_REASON_BY_CODE: Record<string, string> = {
  ORG_SCOPE_FORBIDDEN: "无权查询该机构，请确认机构范围。",
  QUERY_UNSUPPORTED: "查询条件不受支持或机构编码不在目录中，机构编码必须先经 org_catalog_search 确认。",
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
}

export function errorResult<TDetails extends ErrorDetails>(message: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }],
    details,
  };
}

export function backendErrorResult<TDetails extends ErrorDetails>(
  error: unknown,
  details: TDetails,
): AgentToolResult<TDetails> | undefined {
  if (!(error instanceof BackendApiError)) return undefined;
  if (error.status === 401 || error.status === 403) {
    // 账号单会话机制下旧令牌会失效；给模型明确的用户引导，不暴露原始状态码
    return errorResult("当前登录状态已失效，请提示用户刷新页面重新登录后再提问。", details);
  }
  return errorResult(`后端请求失败（${error.status}）：${error.message}`, details);
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
