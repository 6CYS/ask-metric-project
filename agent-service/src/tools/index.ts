/**
 * Agent 业务工具入口：直接组装 semantic_v2 协议工具供原生 harness 注册。
 * 模型只选择工具与动作；指标/机构校验、权限裁剪、SQL builder 生成和执行全部在后端完成。
 * 工具不再绑定具体用户客户端：后端访问经 toolContext 的当次请求绑定。
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { createBusinessCapabilityTool } from "./businessCapability.js";
import { withFocusedArgumentErrors } from "./shared.js";
import { createCatalogTool } from "./catalog.js";
import { createReadTool } from "./readTools.js";
import { createConversationReplyTool, createActionRequiredTool } from "./turnContract.js";
import {
  createSemanticResolveTool,
  createSemanticContextTool,
  createSemanticExecuteTool,
  createSemanticReadTool,
  createSemanticClarifyTool,
  semanticCapabilityTool,
} from "../semantic-task/tools.js";
import { createBusinessTopicReadTool } from "./businessOverview.js";
import { createBusinessReportTool } from "./businessReport.js";
import {createAnalysisCatalogTool, createAnalysisReportTool} from "../analysis/tools.js";
import {createPartialAnalysisTool} from "./partialAnalysis.js";

export { createMetricCatalogSearchTool } from "./metricCatalogSearch.js";
export { createOrgCatalogSearchTool } from "./orgCatalogSearch.js";
export { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
export { createStructuredQueryTool } from "./structuredQuery.js";
export type { CatalogSearchDetails, StructuredQueryDetails } from "./shared.js";

/** pi 选择业务工具；结构化查询仍接受后端目录、权限与能力校验。 */
export function createAskMetricTools(): AgentHarnessTool<AskMetricRequestContext>[] {
  const tools = [
    semanticCapabilityTool(deliverable(createBusinessCapabilityTool())),
    createSemanticResolveTool(),
    createSemanticContextTool(),
    createSemanticExecuteTool(),
    createSemanticReadTool(),
    createReadTool(),
    createBusinessTopicReadTool(),
    createBusinessReportTool(),
    createAnalysisCatalogTool(),
    createAnalysisReportTool(),
    createPartialAnalysisTool(),
    deliverable(createCatalogTool()),
    createConversationReplyTool(),
    createActionRequiredTool(),
    createSemanticClarifyTool(),
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
