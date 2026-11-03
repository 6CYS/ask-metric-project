import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {searchBusinessKnowledge} from "../businessKnowledgeContext.js";
import {analysisCandidates, catalogBindingState} from "../analysis/bindings.js";

const parameters = Type.Object({
  query: Type.String({minLength: 1, maxLength: 2000, pattern: "\\S",
    description: "结合本轮问题和已授权历史，明确要了解的业务含义、分析方法或案例。省略追问应写出所指主题，不照抄没有主题的短句。"}),
}, {additionalProperties: false});

export function createInquiryKnowledgeTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: "business_knowledge_search", label: "查阅业务知识", parameters,
    description: "当前参考资料不足以确定业务含义或调查方法时，按需检索已启用知识，可在取数前使用。最多返回3条、总计8000字；本轮已提供且适用的知识无需重复读取。知识不能代替正式定义、当前数值或原因证据。linked_catalog是知识明确关联指标的正式目录候选，含定义、口径及可直接metric_query的引用，按本次问题选择，无需全部查询；无适用候选时继续metric_search。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      const query = input.query.trim();
      // 与自动前置资料共用读取和验证；显式检索不覆盖按实际指标生成的自动快照。
      const result = await searchBusinessKnowledge(request, query, [], context.abortSignal);
      return {content: [{type: "text", text: JSON.stringify(result)}], isError: result.status === "unavailable",
        details: {kind: "business_knowledge_search", query, ...result,
          ...(result.status === "ok" && result.linked_catalog ? {
            binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request),
          } : {})}};
    },
  };
}
