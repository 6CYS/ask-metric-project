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
      "仅用于用户明确要求搜索、浏览某类指标或确认编码的目录问题，例如有哪些存款指标。" +
      "用户输入具体指标名称或取数问题时使用 metric_ask；补充最新待澄清任务缺项用 clarify，独立查询用 new，沿用已完成查询用 followup。" +
      "本工具只检索启用目录，不能校验整句多指标覆盖、停用状态或代替业务澄清。" +
      "后端按确定性命中（exact/contains/lexical）排序并返回切片前总数 total，另附 embedding 近似推荐。",
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
                "取数请求应改用 metric_ask，由宿主提交用户原句（不得删改指标名称中的任何字样）。" +
                "禁止根据局部检索结果自己追问机构和日期；必须先调用 metric_ask，让后端校验全部指标并生成正式澄清。",
            }),
          },
        ],
        details: { kind: "metric_catalog_search", keyword: params.keyword, total: result.total },
      };
    },
  };
}
