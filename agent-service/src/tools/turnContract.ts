import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool, AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {publicTextProblem} from "../runtime/delivery.js";
import {receiptRole} from "../runtime/control.js";
import {missingCatalogDefinitionAnswer} from "../runtime/queryDefinitions.js";

export const CONVERSATION_REPLY = "respond_without_business_action";

/** 只识别完整的寒暄句；“好的”“继续”等可能是业务确认，带业务目标的问候也不能在此截断。 */
export function standaloneConversationReply(message: string): string | undefined {
  const text = message.normalize("NFKC").trim().replace(/[\s，。！？、,.!?~～]+$/gu, "").toLowerCase();
  if (/^(?:(?:你|您|大家|你们)好(?:呀|啊|哇|哦|哈)?|早上好|上午好|中午好|下午好|晚上好|早安|晚安|嗨|哈喽|hello|hi|hey|在吗)$/u.test(text))
    return "你好，请问有什么可以帮助你？";
  if (/^(?:谢谢(?:你|您)?|多谢|辛苦了|感谢(?:你|您)?)$/u.test(text)) return "不客气，有需要可以继续提问。";
  return undefined;
}

/**
 * 普通对话是明确的无副作用选择，不创建 Frame、业务结果或查询成功凭据。
 * 回答已完整写在参数里：回执带 terminate 结束本轮，不再为一次必然被原文替换的模型往返付出整份上下文的耗时；
 * 页面由回执投影出助手回答（见 sessionProjection）。被 before_tool 拦截时回执不带 terminate，循环照常继续。
 */
const replyParameters = Type.Object({answer: Type.String({minLength: 1, maxLength: 4000,
  description: "无需业务操作即可交付的普通回答，不含未验证业务事实或操作计划。"})}, {additionalProperties: false});
export function createConversationReplyTool(): AgentHarnessTool<AskMetricRequestContext, typeof replyParameters> {
  return {name: CONVERSATION_REPLY, label: "普通对话回答",
    description: "用于问候、致谢、通用解释或尚未表达业务目标时的询问；可依据已读取的正式目录说明和口径回答指标定义，资料缺失时如实说明，不需执行数值查询；也可解释本轮business_context_read已读取的任务状态、失败原因和错误回执，不重新执行或修改原任务。需要选择/切换业务焦点、变更条件、读取数值结果、查询/计算/目录或补充业务澄清时必须使用对应业务工具，不能用此工具叙述调用计划、承诺稍后执行或声称已经完成。",
    parameters: replyParameters,
    execute: async (_id, params, _update, request) => {
      const answer = missingCatalogDefinitionAnswer(await request.turnMessages?.() ?? [], params.answer) ?? params.answer;
      const problem = publicTextProblem(answer);
      if (problem) return {content: [{type: "text", text: `${problem}。请直接回答用户，业务目标使用对应工具执行。`}],
        details: {kind: "conversation_reply", status: "ARGUMENT_ERROR", retryable: true}};
      return {content: [{type: "text", text: answer}],
      details: {kind: "conversation_reply", status: "answered", answer,
        history_sources: request.replyHistorySources ?? {tasks: [], organizationScopes: []}}, terminate: true};
    },
  };
}

export function currentTurnMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  return messages.slice(start + 1);
}

export function hasTurnAction(messages: AgentMessage[]): boolean {
  if (topicExplanationAnswer(messages) !== undefined) return true;
  return messages.some(message => message.role === "toolResult" && ["execution", "delivery"].includes(receiptRole(message)));
}

/** 正式主题映射的确定缺口可以交付，不把普通主题读取当作业务完成。 */
export function topicExplanationAnswer(messages: AgentMessage[]): string | undefined {
  const receipt = messages.find(message => message.role === "toolResult" && !message.isError
    && message.toolName === "business_topic_read"
    && (message.details as {kind?: string} | undefined)?.kind === "business_topic_explanation");
  const details = receipt?.role === "toolResult" ? receipt.details as {delivery?: string; status?: string; public_answer?: unknown} : undefined;
  return details?.delivery === "business_evidence_v1" && details.status === "unsupported"
    && typeof details.public_answer === "string" ? details.public_answer : undefined;
}

export function conversationAnswer(messages: AgentMessage[]): string | undefined {
  const reply = messages.find(message => message.role === "toolResult" && !message.isError
    && message.toolName === CONVERSATION_REPLY);
  const details = reply?.role === "toolResult" ? reply.details as {answer?: unknown} | undefined : undefined;
  return typeof details?.answer === "string" ? details.answer : undefined;
}
