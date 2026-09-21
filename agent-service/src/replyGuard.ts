import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "./requestContext.js";

export const EVIDENCE_REPAIR_TOOL = "answer_evidence_check";
export const TOOL_LIMIT_ANSWER = "本轮已达到工具调用限额，处理未完成。请重试本轮问题，无需重复已确认的条件。";
export const EVIDENCE_BLOCKED_ANSWER = "本次回答缺少当前查询条件对应的工具证据，已被系统拦截。自动核验仍未完成，暂时无法提供结果；这不表示您提供的查询条件不完整。";

/** 宿主通过原生工具循环反馈缺口，不插入假用户消息，也不代模型选择业务查询。 */
export function createEvidenceRepairTool(): AgentHarnessTool<AskMetricRequestContext> {
  return {
    name: EVIDENCE_REPAIR_TOOL, label: "核验回答依据",
    description: "回答缺少本轮工具证据时检查下一步；不查询数据，不产生业务事实。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({
      content: [{ type: "text", text: "刚才未形成有效回答（缺少本轮证据或尚未选择最终交付的证据），未交付给用户。若已有多条证据且目标已完成，请用 answer_present 选择与目标对应的引用，不要自动拼接全部中间结果。否则根据用户目标和已有回执继续取得覆盖本轮条件的证据；需要业务口径时按需查阅知识。不要把历史数值当作本轮结果，不要因系统尚未取数而让用户重述已有条件。只有确实存在歧义时才澄清，能力不足时如实说明。" }],
      details: { kind: EVIDENCE_REPAIR_TOOL, status: "checked" },
    }),
  };
}

/** 提取数字 token：全角转半角，保留千分位与小数，去逗号归一化。集合成员比较，"2" 蒙混不了用户写的 "2026"。 */
export function numberTokens(text: string): Set<string> {
  const halfWidth = text.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
  const tokens = halfWidth.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return new Set(tokens.map(token => token.replace(/,/g, "")));
}

export function mayDeliverWithoutEvidence(reply: string, question: string): boolean {
  if (!reply.trim()) return false;
  const known = numberTokens(question);
  // 分句核验：在无证据事实后追加一个问句，不能让前面的陈述一起绕过检查。
  const prose = reply.replace(/(^|[\s。？?])\d+[.、)]\s+/gu, "$1");
  return (prose.match(/[^。！？!?]+[。！？!?]?/g) ?? []).every(sentence =>
    /[？?]\s*$/.test(sentence) || [...numberTokens(sentence)].every(token => known.has(token)),
  );
}
