import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";
import { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
import { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
import { createMetricCatalogOverviewTool } from "./metricCatalogOverview.js";
import { catalogSearchParameters } from "./shared.js";

const catalogParameters = Type.Union([
  Type.Object({action: Type.Literal("search"), queries: Type.Array(Type.Object({
    entity: Type.Union([Type.Literal("metric"), Type.Literal("organization")]),
    purpose: Type.Optional(Type.Literal("definition", {description: "用户要求解释指标口径时声明；混合查值问题仅附本次正式查询指标的已维护定义"})),
    ...catalogSearchParameters.properties,
  }, {additionalProperties: false}), {minItems: 1, maxItems: 4,
    description: "独立检索可合批；保留用户完整名称和限定词，各项单独返回命中与截断信息"})}, {additionalProperties: false}),
  Type.Object({action: Type.Literal("overview")}, {additionalProperties: false,
    description: "启用指标总数、单位分组和名称示例；不支持机构总览"}),
]);
// 顶层必须声明 type=object：DeepSeek 等 OpenAI 兼容接口会拒绝 type 为空的
// function.parameters（anyOf 只用于分支判别）。
const parameters = Type.Unsafe<Static<typeof catalogParameters>>({type: "object", anyOf: catalogParameters.anyOf});

/** 只合并模型入口，匹配规则与鉴权继续复用原有实现；最多四项只读检索并发。 */
export function createCatalogTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  const metric = createMetricCatalogSearchTool();
  const organization = createOrgCatalogSearchTool();
  const overview = createMetricCatalogOverviewTool();
  return {
    name: "catalog", label: "目录查询", parameters,
    description: "搜索正式指标/机构编码、读取已维护的指标说明与口径，或介绍指标目录。用户要求解释口径时，在指标search项声明purpose=definition；混合查值问题会将定义绑定到本次正式查询指标。search 可同时检索指标与机构；各项返回 total、items、has_more，指标另有近似推荐。exact 只证明命中检索词，须核对原文；近似推荐不能锁定编码，空结果不证明对象不存在。不查询数值或证明有数据，实际记录范围用 data_availability。业务查询用 resolve_business_turn 解析原文名称，无需先查目录。",
    execute: async (id, params, update, request, invocation, context) => {
      if (params.action === "overview") return overview.execute(id, {}, update, request, invocation, context);
      const results = await Promise.all(params.queries.map(async (query) => {
        const tool = query.entity === "metric" ? metric : organization;
        try {
          const result = await tool.execute(id, query, update, request, invocation, context);
          const text = result.content.find(block => block.type === "text");
          if (!text || text.type !== "text") throw new Error("CATALOG_RESULT_INVALID");
          const {usage_hint: _hint, ...payload} = JSON.parse(text.text);
          return {...payload, entity: query.entity, keyword: query.keyword, status: "succeeded"};
        } catch (error) {
          // 取消和鉴权失败必须整体传播；可识别的单项业务失败保留，不能冒充空结果。
          if (context.abortSignal?.aborted || !(error instanceof BackendApiError)
            || error.status === 401 || error.status === 403) throw error;
          return {entity: query.entity, keyword: query.keyword, status: "error", error_code: error.code ?? "BACKEND_ERROR",
            message: "目录检索失败，请重试该项；不能据此认定目录无匹配。"};
        }
      }));
      const status = results.every(item => item.status === "succeeded") ? "succeeded"
        : results.every(item => item.status === "error") ? "error" : "partial";
      const definitions = params.queries.flatMap((query, index) => {
        if (query.entity !== "metric" || query.purpose !== "definition") return [];
        const result = results[index]!;
        const items = result.status === "succeeded" && Array.isArray(result.items) ? result.items : [];
        return [{keyword: query.keyword, status: result.status, has_more: result.has_more === true,
          items: items.flatMap((item: Record<string, unknown> | null) =>
            item && ["exact", "contains", "lexical"].includes(String(item.match_type))
            && typeof item.metric_code === "string" && typeof item.metric_name === "string" ? [{
              metric_code: item.metric_code, metric_name: item.metric_name,
              metric_explanation: typeof item.metric_explanation === "string" ? item.metric_explanation : "",
              description: typeof item.description === "string" ? item.description : "",
            }] : [])}];
      });
      return {content: [{type: "text", text: JSON.stringify({status, results,
        usage_hint: "metric_explanation 是指标说明，description 是正式口径；仅解释定义时依据这些资料回答，不要求机构日期或执行数值查询。空值或缺失如实说明，不能按名称、别名或常识猜正式口径。仅确定性命中可确认编码，须核对完整名称；semantic_suggestions 不可锁定。has_more 时不能认定候选齐全，缺项或失败不能省略后执行部分取数。"})}],
        details: {kind: "catalog", action: "search", status,
          definition_only: definitions.length === params.queries.length,
          ...(definitions.length ? {metric_definition_searches: definitions} : {}),
          catalog_answer: results.map(result => {
          if (result.status === "error") return `「${result.keyword}」的目录检索暂时失败，请稍后重试。`;
          const items = (result as {items?: Array<{metric_name?: string; org_name?: string; name?: string}>}).items ?? [];
          const names = items.map(item => item.metric_name ?? item.org_name ?? item.name).filter(Boolean);
          return names.length ? `「${result.keyword}」的目录匹配项：${names.join("、")}。`
            : `「${result.keyword}」本次检索未返回目录匹配项，可以换用完整名称继续检索。`;
        }).join("\n")}};
    },
  };
}
