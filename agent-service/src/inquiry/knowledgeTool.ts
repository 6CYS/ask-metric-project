import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {searchBusinessKnowledge} from "../businessKnowledgeContext.js";
import {analysisCandidates, catalogBindingState} from "../analysis/bindings.js";
import {isDeepStrictEqual} from "node:util";
import {currentTurnMessages} from "../tools/turnContract.js";

const parameters = Type.Object({
  query: Type.String({minLength: 1, maxLength: 2000, pattern: "\\S",
    description: "结合本轮问题和已授权历史，明确要了解的业务含义、分析方法或案例。省略追问应写出所指主题，不照抄没有主题的短句。"}),
}, {additionalProperties: false});

export function createInquiryKnowledgeTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: "business_knowledge_search", label: "查阅业务知识", parameters,
    description: "当前参考资料不足以确定业务含义或调查方法时，按需检索已启用知识，可在取数前使用。最多返回3条、总计8000字；本轮已提供且适用的知识无需重复读取。batch_query_enabled=true的条目允许作为分析方案，适用时以id调用topic_query；未开启的条目仍用于指导自主分析。知识不能代替正式定义、当前数值或原因证据。linked_catalog是知识明确关联指标的正式目录候选，含定义、口径及可直接metric_query的引用，按本次问题选择，无需全部查询；无适用候选时继续metric_search。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      const query = input.query.trim();
      // 与自动前置资料共用读取和验证；显式检索不覆盖按实际指标生成的自动快照。
      const result = await searchBusinessKnowledge(request, query, [], context.abortSignal);
      // 每次仍核验权限与知识版本；相同内容不是新的调查进展，避免原样正文反复诱发同一检索。
      const messages = currentTurnMessages(await request.turnMessages?.() ?? []);
      const repeated = result.status === "ok" && messages.some(message => {
        if (message.role !== "toolResult" || message.toolName !== "business_knowledge_search" || message.isError) return false;
        const previous = message.details as Partial<typeof result> & {query?: string} | undefined;
        return previous?.status === "ok" && previous.query === query && previous.revision === result.revision &&
          isDeepStrictEqual(previous.entries, result.entries) && isDeepStrictEqual(previous.linked_catalog, result.linked_catalog);
      });
      const reuse = repeated ? {reused: true, no_new_evidence: true} : {};
      const view = repeated ? {status: "ok", ...reuse,
        notice: "本轮已返回同主题、同版本的知识，正文和linked_catalog见之前回执，没有新增信息。已有适用正式指标引用就metric_query，缺少指标就metric_search；不要以反复读取方法代替业务取数。其他确有需要的新主题仍可检索。"} : result;
      return {content: [{type: "text", text: JSON.stringify(view)}], isError: result.status === "unavailable",
        details: {kind: "business_knowledge_search", query, ...result,
          ...reuse,
          ...(result.status === "ok" && result.linked_catalog ? {
            binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request),
          } : {})}};
    },
  };
}
