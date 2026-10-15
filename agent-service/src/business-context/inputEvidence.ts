/** 仅消除既有输入解析允许的格式差异；不删否定、转折或日期限定词，不推断业务语义。 */
export function normalizeInputEvidence(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 证据须非空且锚定调用方提供的本轮原文；不能把历史话语或模型生成值补成用户依据。 */
export function hasInputEvidence(originalMessage: string, sourceText: string): boolean {
  const evidence = normalizeInputEvidence(sourceText);
  return !!evidence && normalizeInputEvidence(originalMessage).includes(evidence);
}
