import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import {BackendApiError} from "../backendClient.js";
import type {AskMetricRequestContext} from "../requestContext.js";

const DENIED = "当前账号无权访问本次所需的数据，请联系管理员确认权限。";

export function inquiryPermissionDenied(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const value = details as {kind?: string; version?: number; status?: string; outcome?: string; error_code?: string};
  return value.kind === "runtime_delivery" && value.version === 1 && value.status === "delivered"
    && value.outcome === "incomplete" && value.error_code === "INQUIRY_FORBIDDEN";
}

/** 403是权限终态，不进入模型参数修正；401仍由原登录失效边界处理。 */
export function withInquiryAuthorization(tool: AgentHarnessTool<AskMetricRequestContext>): AgentHarnessTool<AskMetricRequestContext> {
  return {...tool, execute: async (...args) => {
    try {return await tool.execute(...args);}
    catch (error) {
      const request = args[3], context = args[5];
      if (request.executionFlow !== "inquiry_v1" || context.abortSignal?.aborted
        || !(error instanceof BackendApiError) || error.status !== 403) throw error;
      return {content: [{type: "text", text: DENIED}], isError: false, terminate: true,
        details: {kind: "runtime_delivery", version: 1, operation_id: request.operationId,
          status: "delivered", outcome: "incomplete", error_code: "INQUIRY_FORBIDDEN",
          source_call_ids: [args[0]], public_answer: DENIED,
          history_sources: {tasks: [], organizationScopes: []}}};
    }
  }};
}
