import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool, AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {analysisDiscoveryStarted} from "../analysis/bindings.js";
import {metricMentions} from "../business-context/metricMentions.js";

export const CONVERSATION_REPLY = "respond_without_business_action";
export const ACTION_REQUIRED = "business_action_required";
export const MAX_ACTION_REPAIRS = 2;

/** 只识别完整的寒暄句；“好的”“继续”等可能是业务确认，带业务目标的问候也不能在此截断。 */
export function standaloneConversationReply(message: string): string | undefined {
  const text = message.normalize("NFKC").trim().replace(/[\s，。！？、,.!?~～]+$/gu, "").toLowerCase();
  if (/^(?:(?:你|您|大家|你们)好(?:呀|啊|哇|哦|哈)?|早上好|上午好|中午好|下午好|晚上好|早安|晚安|嗨|哈喽|hello|hi|hey|在吗)$/u.test(text))
    return "你好，请问有什么可以帮助你？";
  if (/^(?:谢谢(?:你|您)?|多谢|辛苦了|感谢(?:你|您)?)$/u.test(text)) return "不客气，有需要可以继续提问。";
  return undefined;
}

const catalogActionChecks = new WeakMap<AskMetricRequestContext, Promise<boolean>>();
/** 目录明确匹配的请求或已有焦点的明确续接必须执行；不靠主题词代选指标、机构或分析方法。 */
export function requiresCatalogAction(request: AskMetricRequestContext): Promise<boolean> {
  const cached = catalogActionChecks.get(request);
  if (cached) return cached;
  const checking = (async () => {
    if (!/(?:情况|表现|变化|趋势|排名|增长|下降|多少|怎么样|如何|分析|查[询看]|看看|只看|重点看|对比|比较)/u.test(request.originalMessage)) return false;
    if (/^(?:那|继续|接着|还是|再)|呢[？?。！!\s]*$/u.test(request.originalMessage.trim()) && request.frames) {
      const state = await request.frames.state();
      if (state.focusFrameId) return true;
    }
    if (typeof request.backend.matchMetricQuestion === "function" && (await metricMentions(request)).mentions.length) return true;
    if (typeof request.backend.searchOrganizations !== "function") return false;
    const response = await request.backend.searchOrganizations(request.originalMessage, 20);
    const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
    const question = normalize(request.originalMessage);
    return (response?.items ?? []).some(item => [item.org_name, ...(item.aliases ?? [])].some(term => {
      const name = normalize(term);
      return name.length >= 2 && question.includes(name);
    }));
  })();
  catalogActionChecks.set(request, checking);
  return checking;
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
    description: "用于问候、致谢、通用解释或尚未表达业务目标时的询问；也可解释本轮business_context_read已读取的任务状态、失败原因和错误回执，不重新执行或修改原任务。需要选择/切换业务焦点、变更条件、读取数值结果、查询/计算/目录或补充业务澄清时必须使用对应业务工具，不能用此工具叙述调用计划、承诺稍后执行或声称已经完成。",
    parameters: replyParameters,
    execute: async (_id, params, _update, request) => ({content: [{type: "text", text: params.answer as string}],
      details: {kind: "conversation_reply", status: "answered", answer: params.answer as string,
        history_sources: request.replyHistorySources ?? {tasks: [], organizationScopes: []}}, terminate: true}),
  };
}

/** 仅由宿主补入的协议纠错回执，继续同一个 Pi 循环，不解析原文或代选业务动作。 */
const actionRequiredParameters = Type.Object({reason: Type.Optional(Type.Literal("output_limit"))}, {additionalProperties: false});
export function createActionRequiredTool(): AgentHarnessTool<AskMetricRequestContext, typeof actionRequiredParameters> {
  return {name: ACTION_REQUIRED, label: "纠正未落地的工具调用",
    description: "宿主内部工具，不由模型主动调用。", parameters: actionRequiredParameters,
    execute: async (_id, params, _update, request) => {
      if (params.reason === "output_limit") return {content: [{type: "text", text: JSON.stringify({status: "MODEL_OUTPUT_LIMIT",
        message: "上次生成达到输出上限，截断的调用未执行。仅重发一个完整、紧凑的目标：不要复制已执行目标或重复整个计划。补查必须填写inquiry并只查询该疑问需要的新指标，保留真实来源引用；已有证据足够则直接提交报告。不增加max_tokens，不从截断参数推测业务条件。"})}],
        details: {kind: "turn_contract", status: "MODEL_OUTPUT_LIMIT"}};
      const pending = await request.answerEvidence?.() ?? [];
      const analysisPending = pending.some(item => item.evidence.kind === "analysis_evidence");
      const overviewPending = pending.some(item => item.evidence.kind === "business_overview" && item.evidence.answer_policy === "overview_evidence_v2");
      return {content: [{type: "text", text: JSON.stringify({status: "ACTION_REQUIRED",
        message: analysisPending ? "本轮通用分析只有中间证据。继续按证据补查或调用analysis_report_present，使用回执原子ref完成报告，不能直接结束或改为普通对话。"
          : analysisDiscoveryStarted(request) ? "本轮仅发现了目录，尚未执行分析。请用business_analysis提交计划（无关系时observe，指标缺失用gap_reason），执行后analysis_report_present。不得输出内部权衡、询问已可默认的机构日期或直接结束。"
          : overviewPending ? "本轮经营概览仅提供了中间证据，尚未交付报告。请继续补查或调用 business_report_present，使用真实原子 ref 撰写报告；不能直接结束、输出参数排查过程或改用普通对话回答。"
          : "上一条没有形成有效的动作选择，不能作为本轮完成。请直接产生原生工具调用：业务请求使用对应业务工具；确实无需业务动作的普通对话使用 respond_without_business_action。普通回答与业务动作不能在同一条调用中混用。读取主题、Skill或目录后仍需resolve_business_turn规划并执行，没有本轮执行证据时不能调用报告工具或编造数值。不要再次输出调用计划。"})}],
        details: {kind: "turn_contract", status: "ACTION_REQUIRED"}};
    },
  };
}

export function currentTurnMessages(messages: AgentMessage[]): AgentMessage[] {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  return messages.slice(start + 1);
}

export function hasTurnAction(messages: AgentMessage[]): boolean {
  if (topicExplanationAnswer(messages) !== undefined) return true;
  return messages.some(message => message.role === "toolResult" && !message.isError
    && ![ACTION_REQUIRED, "business_skill_read", "business_topic_read"].includes(message.toolName)
    && (message.details as {status?: string} | undefined)?.status !== "ARGUMENT_ERROR");
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
