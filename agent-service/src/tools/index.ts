/**
 * Agent 业务工具入口：汇总各工具供原生 harness 注册。
 * 模型只选择工具与动作；指标/机构校验、权限裁剪、SQL 模板执行全部在后端完成。
 * 工具不再绑定具体用户客户端：后端访问经 toolContext 的当次请求绑定。
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { createMetricCatalogOverviewTool } from "./metricCatalogOverview.js";
import { createMetricAskTool } from "./metricAsk.js";
import { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
import { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
import { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
import { createStructuredQueryTool } from "./structuredQuery.js";
import { createDataAvailabilityTool } from "./dataAvailability.js";

export { createMetricAskTool, type MetricAskDetails } from "./metricAsk.js";
export { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
export { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
export { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
export { createStructuredQueryTool } from "./structuredQuery.js";
export type { CatalogSearchDetails, StructuredQueryDetails } from "./shared.js";

/** pi 选择业务工具；结构化查询仍接受后端目录、权限与能力校验。 */
export function createAskMetricTools(): AgentHarnessTool<AskMetricRequestContext>[] {
  return [
    createMetricAskTool(),
    createDataAvailabilityTool(),
    createStructuredQueryTool(),
    createMetricReadTool(),
    createSessionHistoryReadTool(),
    createMetricCatalogSearchTool(),
    createMetricCatalogOverviewTool(),
    createOrgCatalogSearchTool(),
  ] as AgentHarnessTool<AskMetricRequestContext>[];
}
