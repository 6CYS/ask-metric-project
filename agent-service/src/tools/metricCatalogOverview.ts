import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";

/** 能力目录不创建问数任务，事实来自本次鉴权后的实时启用目录。 */
export function createMetricCatalogOverviewTool(): AgentHarnessTool<AskMetricRequestContext> {
  return {
    name: "metric_catalog_overview", label: "可查询指标总览",
    description: "用途：介绍系统指标目录。边界：指定机构或时间内哪些指标实际有数据必须使用 data_availability，不用本工具。前提：不需要机构、日期。返回：启用指标数量及按单位分组的名称示例，不创建查询任务。查某类具体名称用 metric_catalog_search。",
    parameters: Type.Object({}),
    execute: async (_id, _params, _update, request, _invocation, context) => {
      try {
        const overview = await request.backend.metricCatalogOverview({signal: context.abortSignal});
        const answer = `当前目录启用了 ${overview.total} 个指标。` + overview.groups.map(group =>
          `${group.unit}类共 ${group.count} 个，例如${group.examples.map(item => item.name).join("、")}。`,
        ).join("\n") + "\n可以告诉我感兴趣的指标名称或关键词；取数时请补充机构和日期。具体结果以你的权限和该日期的数据为准。";
        return {content: [{type: "text", text: JSON.stringify(overview)}],
          details: {kind: "metric_catalog_overview", status: "catalog", public_answer: answer}};
      } catch (error) {
        if (!(error instanceof BackendApiError)) throw error;
        return {content: [{type: "text", text: "目录暂时不可用"}], details: {
          kind: "metric_catalog_overview", status: "error", public_answer: "指标目录暂时无法读取，请稍后重试。",
        }};
      }
    },
  };
}
