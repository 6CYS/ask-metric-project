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
      "用途：在正式目录确认机构编码。前提：具体机构名称或编码关键词。返回：后端只做确定性匹配（exact/前缀/包含，不模糊匹配），返回切片前命中总数 total。" +
      "边界：不取数、不证明机构有数据；类别词的空结果不代表集合不存在，基础查询的集合范围交由 metric_ask 解析原文。",
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
                "仅确定性命中可用于确认机构编码；空结果表示该关键词没有确定性命中，不代表机构或集合不存在，不得猜测编码。" +
                "基础取值、趋势、比较或排名可用 metric_ask 提交本轮原文，由后端解析机构范围或返回正式澄清；" +
                "实际数据覆盖或组合计算仍须从正式目录确认编码，不能改用 metric_ask 替代目标，也不能擅自扩大为全部机构。",
            }),
          },
        ],
        details: { kind: "org_catalog_search", keyword: params.keyword, total: result.total },
      };
    },
  };
}
