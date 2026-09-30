import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool, AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";

export const CONVERSATION_REPLY = "respond_without_business_action";
export const ACTION_REQUIRED = "business_action_required";
export const MAX_ACTION_REPAIRS = 2;

/**
 * 普通对话是明确的无副作用选择，不创建 Frame、业务结果或查询成功凭据。
 * 回答已完整写在参数里：回执带 terminate 结束本轮，不再为一次必然被原文替换的模型往返付出整份上下文的耗时；
 * 页面由回执投影出助手回答（见 sessionProjection）。被 before_tool 拦截时回执不带 terminate，循环照常继续。
 */
const replyParameters = Type.Object({answer: Type.String({minLength: 1, maxLength: 4000,
  description: "无需业务操作即可交付的普通回答，不含未验证业务事实或操作计划。"})}, {additionalProperties: false});
export function createConversationReplyTool(): AgentHarnessTool<AskMetricRequestContext, typeof replyParameters> {
  return {name: CONVERSATION_REPLY, label: "普通对话回答",
    description: "仅用于问候、致谢、通用解释或尚未表达业务目标时的询问。必须本轮不需要选择/切换业务焦点、变更条件、读取历史业务/结果、查询/计算/目录或补充业务澄清。上述业务目标必须实际使用对应业务工具，不能用此工具叙述调用计划、承诺稍后执行或声称已经完成。",
    parameters: replyParameters,
    execute: async (_id, params) => ({content: [{type: "text", text: params.answer as string}],
      details: {kind: "conversation_reply", status: "answered", answer: params.answer as string}, terminate: true}),
  };
}

/** 仅由宿主补入的协议纠错回执，继续同一个 Pi 循环，不解析原文或代选业务动作。 */
export function createActionRequiredTool(): AgentHarnessTool<AskMetricRequestContext> {
  return {name: ACTION_REQUIRED, label: "纠正未落地的工具调用",
    description: "宿主内部工具，不由模型主动调用。", parameters: Type.Object({}, {additionalProperties: false}),
    execute: async () => ({content: [{type: "text", text: JSON.stringify({status: "ACTION_REQUIRED",
      message: "上一条没有形成有效的动作选择，不能作为本轮完成。请直接产生原生工具调用：业务请求使用对应业务工具；确实无需业务动作的普通对话使用 respond_without_business_action。普通回答与业务动作不能在同一条调用中混用。不要再次输出调用计划。"})}],
      details: {kind: "turn_contract", status: "ACTION_REQUIRED"}}),
  };
}

export function currentTurnMessages(messages: AgentMessage[]): AgentMessage[] {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  return messages.slice(start + 1);
}

export function hasTurnAction(messages: AgentMessage[]): boolean {
  return messages.some(message => message.role === "toolResult" && !message.isError
    && ![ACTION_REQUIRED, "business_skill_read"].includes(message.toolName)
    && (message.details as {status?: string} | undefined)?.status !== "ARGUMENT_ERROR");
}

export function conversationAnswer(messages: AgentMessage[]): string | undefined {
  const reply = messages.find(message => message.role === "toolResult" && !message.isError
    && message.toolName === CONVERSATION_REPLY);
  const details = reply?.role === "toolResult" ? reply.details as {answer?: unknown} | undefined : undefined;
  return typeof details?.answer === "string" ? details.answer : undefined;
}
