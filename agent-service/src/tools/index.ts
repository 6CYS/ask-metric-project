/**
 * Agent 业务工具入口：汇总各工具供原生 harness 注册。
 * 模型只选择工具与动作；指标/机构校验、权限裁剪、SQL 模板执行全部在后端完成。
 * 工具不再绑定具体用户客户端：后端访问经 toolContext 的当次请求绑定。
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { createMetricAskTool } from "./metricAsk.js";
import { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
import { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
import { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
import { createStructuredQueryTool } from "./structuredQuery.js";

export { createMetricAskTool, type MetricAskDetails } from "./metricAsk.js";
export { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
export { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
export { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
export { createStructuredQueryTool } from "./structuredQuery.js";
export type { CatalogSearchDetails, StructuredQueryDetails } from "./shared.js";

/** 普通自然语言会话的默认工具集：结构化快路径不在其中，避免绕过语义治理 */
export function createAskMetricTools(): AgentHarnessTool<AskMetricRequestContext>[] {
  return [
    createMetricAskTool(),
    createMetricReadTool(),
    createSessionHistoryReadTool(),
    createMetricCatalogSearchTool(),
    createOrgCatalogSearchTool(),
  ] as AgentHarnessTool<AskMetricRequestContext>[];
}
