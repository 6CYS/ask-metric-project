import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { BackendApiError } from "../backendClient.js";
import { commandKey } from "../harnessHost.js";
import type { AskMetricRequestContext } from "../requestContext.js";
import { backendErrorResult, NAME_PATTERN, strictRecord } from "./shared.js";

const name = Type.String({pattern: NAME_PATTERN});
const parameters = Type.Object({
  expressions: Type.Array(Type.Object({
    name, label: Type.String({minLength: 1, maxLength: 80}), expression: Type.String({minLength: 1, maxLength: 2000}),
    display: Type.Optional(StringEnum(["decimal", "percent"] as const)),
    decimal_places: Type.Optional(Type.Integer({minimum: 0, maximum: 8})),
  }, {additionalProperties: false}), {minItems: 1, maxItems: 10}),
  bindings: strictRecord(Type.Object({fact_id: Type.String({minLength: 1, maxLength: 180})}, {additionalProperties: false}), {minProperties: 1, maxProperties: 100}),
  constants: Type.Optional(strictRecord(Type.Object({value: Type.String({pattern: "^-?\\d{1,30}(\\.\\d{1,20})?$"}), source_text: Type.String({minLength: 1, maxLength: 200})}, {additionalProperties: false}), {maxProperties: 20})),
  scope_policy: Type.Optional(StringEnum(["same_org_date", "cross_date", "cross_org", "explicit"] as const, {description: "默认同机构同日期；跨日期、跨机构或两者均不同必须按用户确认的计算口径显式选择。"})),
}, {additionalProperties: false});

export function createMetricCalculateTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {
    name: "metric_calculate", label: "受控结果计算", parameters,
    description: "用途：按用户公式对本会话经过权限复核的查询快照做有界运算，支持历史原值接续计算。不适用：提槽取数、归因或预测。输入须为完整查询或历史结果回执中的 fact_id，不能手填业务数值；过期、缺数、截断、单位冲突或零分母会拒绝。返回：计算引用、公式、输入来源和结果。",
    execute: async (_id, params, _update, request, _invocation, context) => {
      try {
        const conversationId = await request.commands.getConversationId();
        if (!conversationId) throw new BackendApiError(422, "请先查询本次计算需要的指标。", "CALCULATION_CONTEXT_MISSING");
        // 来源策略、会话和本轮原文由宿主绑定，模型只能提交公式与事实引用。
        const payload = {...params, conversation_id: conversationId, scope_id: request.operationId,
          source_policy: "conversation_snapshots" as const, user_question: request.originalMessage};
        const key = commandKey({owner: request.actor.id, session: request.sessionId, request: request.requestId, action: "calculate", payload});
        const result = await request.backend.calculate(payload, key, {signal: context.abortSignal});
        return {content: [{type: "text", text: JSON.stringify(result)}], details: {kind: "metric_calculate", ...result}};
      } catch (error) {
        if (request.businessExecutionFrame && (!(error instanceof BackendApiError) || error.status >= 500)) throw error;
        // 错误语义统一走共享分类：401/403 固定文案，422 可纠正并透传后端原因，其余如实表达未知状态。
        const apiError = error instanceof BackendApiError ? error : undefined;
        const mapped = backendErrorResult(error, {
          kind: "metric_calculate", status: "error", message: apiError?.message, error_code: apiError?.code,
        });
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
