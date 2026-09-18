/**
 * org_catalog_search 工具：在正式机构目录中检索机构，确认机构是否存在及准确编码。
 */
import { type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { catalogSearchParameters, type CatalogSearchDetails } from "./shared.js";

export function createOrgCatalogSearchTool(): AgentHarnessTool<AskMetricRequestContext, typeof catalogSearchParameters, CatalogSearchDetails> {
  return {
    name: "org_catalog_search",
    label: "机构目录检索",
    description:
      "在正式机构目录中检索机构：后端只做确定性匹配（exact/前缀/包含，不模糊匹配），返回切片前命中总数 total。" +
      "用于确认机构是否存在及准确编码。",
    parameters: catalogSearchParameters,
    execute: async (_toolCallId, params: Static<typeof catalogSearchParameters>, _onUpdate, request, _invocation, context) => {
      const result = await request.backend.searchOrganizations(params.keyword, params.limit ?? 10, { signal: context.abortSignal });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total: result.total,
              has_more: result.total > result.items.length,
              items: result.items,
              usage_hint:
                "仅确定性命中可用于确认机构编码；空结果表示目录未确认到该机构，不得猜测编码，" +
                "改用 metric_ask 并把用户原句完整传入。",
            }),
          },
        ],
        details: { kind: "org_catalog_search", keyword: params.keyword, total: result.total },
      };
    },
  };
}
