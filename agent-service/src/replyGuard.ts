export const EVIDENCE_REPAIR_TOOL = "answer_evidence_check";
export const TOOL_LIMIT_ANSWER = "本轮已达到工具调用限额，处理未完成。请重试本轮问题，无需重复已确认的条件。";
export const EVIDENCE_BLOCKED_ANSWER = "本次回答缺少当前查询条件对应的工具证据，已被系统拦截。自动核验仍未完成，暂时无法提供结果；这不表示您提供的查询条件不完整。";

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
