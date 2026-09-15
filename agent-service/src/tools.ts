/**
 * Agent 业务工具：通过 BackendClient 调用 FastAPI 受治理接口。
 * 模型只选择工具与参数；指标/机构校验、权限裁剪、SQL 模板执行全部在后端完成。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { BackendApiError, BackendClient } from "./backendClient.js";

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
  columns?: string[];
  rows?: Record<string, unknown>[];
  row_count?: number;
  truncated?: boolean | undefined;
  clarification_prompt?: string | undefined;
  /** 后端澄清结构原样透传，供前端渲染结构化澄清表单 */
  clarification?: unknown;}

function errorResult(message: string): AgentToolResult<MetricAskDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }],
    details: { kind: "metric_ask", status: "error" },
  };
}

/**
 * 一次性完成“提交问题 → 语义解析 → 执行查询”的受治理问数链路。
 * 解析结果缺少条件时返回澄清信息，由 agent 引导用户补充，不代填条件。
 */
export function createMetricAskTool(client: BackendClient): AgentTool<typeof metricAskParameters, MetricAskDetails> {
  return {
    name: "metric_ask",
    label: "指标问数",
    description:
      "执行一次受治理的经营指标问数：提交自然语言问题，经后端目录校验、权限裁剪后按登记 SQL 模板查询。" +
      "需要具体的指标、机构和时间条件；条件不足时返回澄清提示，请把澄清内容转告用户补充，不要自行编造数值或机构。",
    parameters: metricAskParameters,
    execute: async (_toolCallId, params: Static<typeof metricAskParameters>) => {
      try {
        const submitted = await client.submitQuestion(params.question, null, randomUUID());
        const analyzed = await client.analyzeTask(submitted.task_id, submitted.version);

        if (analyzed.clarification || analyzed.status === "WAITING_USER") {
          const clarification = analyzed.clarification ?? {};
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
          return errorResult(analyzed.error_message ?? "语义解析失败");
        }

        const executed = await client.executeTask(analyzed.task_id, analyzed.version, randomUUID());
        const sampleRows = executed.rows.slice(0, MAX_ROWS_FOR_MODEL);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: executed.status,
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
            columns: executed.columns,
            rows: executed.rows,
            row_count: executed.row_count,
            truncated: executed.truncated,
          },
        };
      } catch (error) {
        if (error instanceof BackendApiError) {
          if (error.status === 401 || error.status === 403) {
            // 账号单会话机制下旧令牌会失效；给模型明确的用户引导，不暴露原始状态码
            return errorResult("当前登录状态已失效，请提示用户刷新页面重新登录后再提问。");
          }
          return errorResult(`后端请求失败（${error.status}）：${error.message}`);
        }
        throw error;
      }
    },
  };
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

export function createAskMetricTools(client: BackendClient): AgentTool<any, any>[] {
  return [createMetricAskTool(client), createMetricCatalogSearchTool(client), createOrgCatalogSearchTool(client)];
}
