/**
 * Agent 业务工具入口：汇总各工具供原生 harness 注册。
 * 模型只选择工具与动作；指标/机构校验、权限裁剪、SQL 模板执行全部在后端完成。
 * 工具不再绑定具体用户客户端：后端访问经 toolContext 的当次请求绑定。
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { createMetricCalculateTool } from "./metricCalculate.js";
import { createMetricCatalogOverviewTool } from "./metricCatalogOverview.js";
import { createMetricAskTool } from "./metricAsk.js";
import { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
import { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
import { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
import { createStructuredQueryTool } from "./structuredQuery.js";
import { createDataAvailabilityTool } from "./dataAvailability.js";
import { createBusinessCapabilityTool } from "./businessCapability.js";
import { withFocusedArgumentErrors } from "./shared.js";
import { createCatalogTool } from "./catalog.js";
import { createReadTool } from "./readTools.js";
import { createResolveBusinessTurnTool, createExecuteBusinessFrameTool, createReadBusinessResultTool, createBusinessContextReadTool } from "./businessContext.js";
import { createAnswerPresentTool } from "./answerPresent.js";

export { createMetricAskTool, type MetricAskDetails } from "./metricAsk.js";
export { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
export { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
export { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
export { createStructuredQueryTool } from "./structuredQuery.js";
export type { CatalogSearchDetails, StructuredQueryDetails } from "./shared.js";

/** pi 选择业务工具；结构化查询仍接受后端目录、权限与能力校验。 */
export function createAskMetricTools(): AgentHarnessTool<AskMetricRequestContext>[] {
  const tools = [
    deliverable(createBusinessCapabilityTool()),
    createResolveBusinessTurnTool(),
    createBusinessContextReadTool(),
    deliverable(createExecuteBusinessFrameTool()),
    deliverable(createReadBusinessResultTool()),

    createReadTool(),
    deliverable(createCatalogTool()),
  ] as AgentHarnessTool<AskMetricRequestContext>[];
  return tools.map(withFocusedArgumentErrors);
}

/** 交付标记只由服务注册适配器添加，不能从模型正文认定成功；终止仍另判。 */
function deliverable<T extends AgentHarnessTool<AskMetricRequestContext>>(tool: T): T {
  return {...tool, execute: async (...args: Parameters<T["execute"]>) => {
    const result = await tool.execute(args[0], args[1], args[2], args[3], args[4], args[5]);
    const details = result.details as Record<string, unknown> | undefined;
    return {...result, details: details && typeof details.public_answer === "string"
      ? {...details, delivery: "business_evidence_v1"} : details};
  }} as T;
}

/** 仅供旧持久化操作恢复；不向新模型请求暴露旧工具定义。 */
export function legacyToolsFor(tools: AgentHarnessTool<AskMetricRequestContext>[]): AgentHarnessTool<AskMetricRequestContext>[] {
  return [
    ...(tools.some(tool => tool.name === "resolve_business_turn") ? [createAnswerPresentTool(), createMetricAskTool(), createStructuredQueryTool(), createDataAvailabilityTool(), createMetricCalculateTool()] : []),
    ...(tools.some(tool => tool.name === "catalog") ? [createMetricCatalogSearchTool(), createOrgCatalogSearchTool(), deliverable(createMetricCatalogOverviewTool())] : []),
    ...(tools.some(tool => tool.name === "read") ? [createMetricReadTool(), createSessionHistoryReadTool()] : []),
  ].filter(legacy => !tools.some(tool => tool.name === legacy.name)).map(withFocusedArgumentErrors);
}
