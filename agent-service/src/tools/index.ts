/** 新请求只注册统一调查工具；历史工具回执由投影与来源读取模块兼容。 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { withFocusedArgumentErrors } from "./shared.js";
import { createSessionHistoryReadTool } from "./readTools.js";
import { createConversationReplyTool } from "./turnContract.js";
import { createPartialAnalysisTool } from "./partialAnalysis.js";
import { createInquiryQueryTools } from "../inquiry/queryTools.js";
import { createInquiryAnswerTool } from "../inquiry/runtime.js";
import { createInquiryChartTool } from "../inquiry/chartTool.js";
import { createInquiryKnowledgeTool } from "../inquiry/knowledgeTool.js";
import { createInquiryCalculationTool } from "../inquiry/calculationTool.js";
import { createTopicQueryTool } from "../inquiry/topics/tool.js";

export function createAskMetricTools(
  options: { topicsEnabled?: boolean } = {},
): AgentHarnessTool<AskMetricRequestContext>[] {
  const queries = createInquiryQueryTools();
  return [
    ...(options.topicsEnabled
      ? [createTopicQueryTool(queries.find((tool) => tool.name === "metric_query")!)]
      : []),
    ...queries,
    createSessionHistoryReadTool(),
    createInquiryKnowledgeTool(),
    createInquiryCalculationTool(),
    createInquiryChartTool(),
    createInquiryAnswerTool(),
    createPartialAnalysisTool(),
    createConversationReplyTool(),
  ].map(withFocusedArgumentErrors);
}
