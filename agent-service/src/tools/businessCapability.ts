import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";

const capabilities = {
  cause_analysis: "业务动因及客户流失归因",
  anomaly_diagnosis: "业务异常诊断",
  forecast: "未来指标预测",
  lineage: "数据血缘分析",
} as const;
const parameters = Type.Object({
  capability: StringEnum(Object.keys(capabilities) as Array<keyof typeof capabilities>),
}, {additionalProperties: false});

/** 能力说明是终止回执，不查数据，不把用户分析目标改写成基础查询。 */
export function createBusinessCapabilityTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {
    name: "business_capability_explain", label: "说明当前能力", parameters,
    description: "用途：说明尚未提供的归因、异常诊断、预测、血缘或综合报告能力，并结束本轮。仅在用户实际请求此类分析时适用；受支持的基础取值、排名或有界公式计算不因此拒绝，指标名称里的增幅、排名等统计口径不代表额外分析任务。无需先取数来证明能力缺失，也可直接说明限制。返回边界与可选目标，是否改目标由用户选择。",
    execute: async (_id, params) => {
      const answer = `当前尚未提供${capabilities[params.capability]}能力，无法完成这项分析。可以查询已有指标，或按您给定的公式计算；如需改为这些查询，请明确要查看的内容。`;
      return {content: [{type: "text", text: answer}], details: {
        kind: "business_capability_explain", status: "unsupported", public_answer: answer,
      }};
    },
  };
}
