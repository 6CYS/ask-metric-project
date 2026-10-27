import { createHash } from "node:crypto";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "./requestContext.js";

/** 日志只保留控制字段、数量和指纹；完整参数仍由受归属保护的 pi 原生记录保存。 */
export function summarizeToolArguments(args: unknown): Record<string, unknown> {
  const value = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const summary: Record<string, unknown> = {
    arguments_sha256: createHash("sha256").update(JSON.stringify(args) ?? "null").digest("hex"),
  };
  const enums: Record<string, string[]> = {
    action: ["new", "clarify", "followup", "clarify_context", "search", "overview"], kind: ["task", "result", "list", "entry"],
    dimension: ["metrics", "dates"], selection: ["exact", "latest_in_range", "all_in_range"],
    name: ["metric-query", "data-coverage", "result-calculation", "analysis-boundary"],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (typeof value[key] === "string" && allowed.includes(value[key])) summary[key] = value[key];
  }
  for (const key of ["org_codes", "metric_codes", "expressions", "queries"]) {
    if (Array.isArray(value[key])) summary[`${key}_count`] = value[key].length;
  }
  for (const key of ["source", "target"]) {
    if (value[key] !== undefined) summary[`${key}_sha256`] = createHash("sha256").update(JSON.stringify(value[key])).digest("hex");
  }
  return summary;
}

export function auditToolCall(request: AskMetricRequestContext, toolCallId: string, tool: string,
  stage: "proposed" | "admitted" | "blocked" | "executed" | "finished", args: unknown,
  timing?: {duration_ms: number; execution_outcome: "returned" | "threw" | "aborted"}): void {
  console.info(JSON.stringify({event: "agent_tool_call", request_id: request.requestId,
    session_id: request.sessionId, operation_id: request.operationId, tool_call_id: toolCallId,
    tool, stage, ...summarizeToolArguments(args), ...timing}));
}

/** execute 是 Hook 及原生 schema 校验之后的实际执行边界，不把放行等同执行。 */
export function withToolExecutionAudit(tool: AgentHarnessTool<AskMetricRequestContext>): AgentHarnessTool<AskMetricRequestContext> {
  return {...tool, execute: async (...args) => {
    auditToolCall(args[3], args[0], tool.name, "executed", args[1]);
    const started = performance.now();
    let outcome: "returned" | "threw" = "returned";
    try {
      return await tool.execute(...args);
    } catch (error) {
      outcome = "threw";
      throw error;
    } finally {
      // returned 只表示工具返回，业务失败仍以正式回执为准；不记录异常正文或结果。
      auditToolCall(args[3], args[0], tool.name, "finished", args[1], {
        duration_ms: Math.round(performance.now() - started),
        execution_outcome: args[5].abortSignal?.aborted ? "aborted" : outcome,
      });
    }
  }};
}
