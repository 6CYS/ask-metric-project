/** 工具只传引用与表达式；当前轮范围由服务端绑定，不暴露为模型可改写的参数。 */
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BackendApiError, type BackendClient, type CalculationInput } from "./backendClient.js";
import type { QueryToolContext } from "./tools.js";

const variable = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$" });
const parameters = Type.Object({
  expressions: Type.Array(Type.Object({
    name: variable,
    label: Type.String({ minLength: 1, maxLength: 80 }),
    expression: Type.String({ minLength: 1, maxLength: 2000 }),
    display: Type.Optional(StringEnum(["decimal", "percent"])),
    decimal_places: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
  }), { minItems: 1, maxItems: 10 }),
  bindings: Type.Record(variable, Type.Object({ fact_id: Type.String() }), { minProperties: 1, maxProperties: 100 }),
  constants: Type.Optional(Type.Record(variable, Type.Object({
    value: Type.String({ description: "用户明确提供的十进制常数，使用字符串" }),
    source_text: Type.String({ description: "逐字引用当前用户问题中包含此常数的文字" }),
  }), { maxProperties: 20 })),
});

export function createCalculationTool(client: BackendClient, context: QueryToolContext): AgentTool<typeof parameters> {
  return {
    name: "metric_calculate", label: "数据计算", parameters,
    description: "对当前提问查询工具返回的 facts 进行计算。只传 fact_id，不抄业务数值。支持 + - * /、括号、sum(a,b,...)、avg、min、max、abs；每个公式独立求值。" +
      "百分比用 (current-previous)/previous 并 display=percent，不乘100。公式仅允许0和1字面量，其他系数放constants且必须来自用户原文。" +
      "不能自行猜换算系数、跨任务引用或对截断结果汇总。分母或口径不明确时先澄清。返回值为精确十进制字符串，直接引用display_value和unit回答。",
    execute: async (callId, input) => {
      try {
        context.assertActive();
        if (Object.values(input.bindings).some(binding => !context.facts.has(binding.fact_id))) {
          throw new Error("只能使用当前提问已返回的数据引用，请先查询所需数据。");
        }
        const result = await client.calculate(input as CalculationInput, context.conversationId, context.scope.scope_id, callId);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { kind: "metric_calculate", ...result } };
      } catch (error) {
        const message = error instanceof BackendApiError || error instanceof Error ? error.message : "计算失败，请重试。";
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }],
          details: { kind: "metric_calculate", status: "error", message } };
      }
    },
  };
}
