import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { selectEvidence } from "../answerEvidence.js";

const parameters = Type.Object({
  evidence_refs: Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 24,
    description: "当前证据列表中的引用，按最终正文顺序选择。仅选择回答用户目标的结果；中间目录/排查记录不必交付。"}),
}, {additionalProperties: false});

export function createAnswerPresentTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {
    name: "answer_present", label: "交付回答", parameters,
    description: "完成用户目标后选择本轮证据交付最终回答并结束。不查询数据，不计算，不修改事实。必须引用当前证据列表中的 evidence_refs；保留未解决的失败、局部完成及截断信息。多个中间步骤不应全部照搬，诊断性目录/覆盖不能冒充目标结果。",
    execute: async (_id, params, _onUpdate, request) => {
      const references = await request.answerEvidence?.() ?? [];
      try {
        const details = selectEvidence(references, params.evidence_refs);
        return {content: [{type: "text", text: details.public_answer}], details};
      } catch (error) {
        return {content: [{type: "text", text: (error as Error).message}],
          details: {kind: "answer_present", status: "error", retryable: true}};
      }
    },
  };
}
