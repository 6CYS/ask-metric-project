import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";

const capabilities = {
  customer_transactions: "具体客户、账户交易流水和资金去向明细查询",
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
    description: "说明尚未提供的客户交易明细、业务因果归因、异常诊断、预测或血缘能力，并结束本轮。customer_transactions仅用于用户索要具体客户或账户名单、交易流水、资金去向明细；机构排名、机构余额变化和客户数等已有指标查询仍走正常问数，不能因出现客户字样而拒绝。机构汇总不能推断客户行为；即使已读取历史机构分析，也应说明当前接口明细限制，不重复旧报告、不要求重给机构日期。无需先取数来证明能力缺失，不擅自改换用户目标。",
    execute: async (_id, params) => {
      const answer = params.capability === "customer_transactions"
        ? "当前问数接口尚未提供具体客户、账户交易流水和资金去向明细查询，无法据此列出具体客户。机构余额变化不能证明是哪位客户转走了资金。要核实，需要对应机构、同一期间的客户或账户交易流水及资金去向资料。"
        : `当前尚未提供${capabilities[params.capability]}能力，无法完成这项分析。可以查询已有指标，或按您给定的公式计算；如需改为这些查询，请明确要查看的内容。`;
      return {content: [{type: "text", text: answer}], details: {
        kind: "business_capability_explain", status: "unsupported", public_answer: answer,
      }};
    },
  };
}
