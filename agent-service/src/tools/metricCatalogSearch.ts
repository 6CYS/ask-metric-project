/**
 * metric_catalog_search 工具：在正式指标目录中检索指标，确认指标是否存在及准确编码。
 */
import { type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { catalogSearchParameters, type CatalogSearchDetails } from "./shared.js";

export function createMetricCatalogSearchTool(): AgentHarnessTool<AskMetricRequestContext, typeof catalogSearchParameters, CatalogSearchDetails> {
  return {
    name: "metric_catalog_search",
    label: "指标目录检索",
    description:
      "在正式指标目录中检索指标：后端按确定性命中（exact/contains/lexical）排序并返回切片前命中总数 total，" +
      "另附 embedding 语义近似推荐。用于确认指标是否存在及准确编码。",
    parameters: catalogSearchParameters,
    execute: async (_toolCallId, params: Static<typeof catalogSearchParameters>, _onUpdate, request, _invocation, context) => {
      const result = await request.backend.searchMetrics(params.keyword, params.limit ?? 10, { signal: context.abortSignal });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total: result.total,
              has_more: result.total > result.items.length,
              items: result.items,
              semantic_suggestions: result.semantic_suggestions,
              usage_hint:
                "match_type 为 exact/contains/lexical 的条目是确定性命中，可锁定编码用于 metric_query_structured；" +
                "semantic_suggestions 仅是语义近似推荐，不得据此锁定编码。未命中或 has_more 时不要断定指标不存在，" +
                "改用 metric_ask 并把用户原句完整传入（不得删改指标名称中的任何字样）。",
            }),
          },
        ],
        details: { kind: "metric_catalog_search", keyword: params.keyword, total: result.total },
      };
    },
  };
}
