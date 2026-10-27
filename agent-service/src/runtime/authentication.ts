import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import {BackendApiError} from "../backendClient.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import {backendErrorResult} from "../tools/shared.js";

export const AUTHENTICATION_REQUIRED = "登录状态已失效，请刷新页面重新登录。";
const authenticationCodes = new Set(["AUTH_SESSION_REPLACED", "AUTH_TOKEN_INVALID", "AUTH_TOKEN_EXPIRED", "UNAUTHORIZED"]);

/** 仅认后端鉴权状态，不把业务范围拒绝或模型正文当作登录失效。 */
export function authenticationFailure(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const value = details as {http_status?: unknown; error_code?: unknown; issues?: Array<{code?: unknown}>};
  return value.http_status === 401 || typeof value.error_code === "string" && authenticationCodes.has(value.error_code)
    || Array.isArray(value.issues) && value.issues.some(issue => typeof issue.code === "string" && authenticationCodes.has(issue.code));
}

/** SDK 会把抛出的异常转成无 details 的工具结果；在此保留鉴权终态。 */
export function withBackendAuthentication(tool: AgentHarnessTool<AskMetricRequestContext>): AgentHarnessTool<AskMetricRequestContext> {
  return {...tool, execute: async (...args) => {
    try {return await tool.execute(...args);}
    catch (error) {
      if (!(error instanceof BackendApiError) || error.status !== 401) throw error;
      const result = backendErrorResult(error, {kind: tool.name, status: "error"});
      if (result) return result;
      throw error;
    }
  }};
}
