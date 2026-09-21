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
      "用途：搜索、浏览某类指标或为结构化取值/覆盖查询确认正式编码，例如有哪些存款指标。" +
      "本工具只检索启用目录，不能校验整句多指标覆盖、停用状态或代替业务澄清。" +
      "前提：提供用户完整名称、编码或类别关键词，确认指定指标时不删减名称限定词。返回：后端按确定性命中（exact/contains/lexical）排序并返回切片前总数 total，另附 embedding 近似推荐。",
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
              exact_matches: result.items.filter(item => item.match_type === "exact"),
              semantic_suggestions: result.semantic_suggestions,
              usage_hint:
                "exact_matches 仅表示命中了本次检索词（可能是短别名），不表示符合用户原文。先核对用户完整名称及限定词；原文存在更完整名称时必须重新检索完整名称。match_type 为 exact/contains/lexical 的条目可作为编码来源，不能替代语义确认；" +
                "semantic_suggestions 仅是语义近似推荐，不得据此锁定编码。未命中或 has_more 时不要断定指标不存在，" +
                "纯基础取数可用 metric_ask 解析原句；计算或覆盖组合目标缺少正式编码时应缩小检索或澄清，不能改用 metric_ask。" +
                "结构化取值必须核对本次全部指标；未确认的指标不能丢弃后执行部分取数。限定指标类别的覆盖查询也必须保留该类别过滤。",
            }),
          },
        ],
        details: { kind: "metric_catalog_search", keyword: params.keyword, total: result.total },
      };
    },
  };
}
