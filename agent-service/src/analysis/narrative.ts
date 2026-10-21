/** 只修复代码片段之外重复转义的段落换行，不解码路径、引号或证据内容。 */
export function normalizeReportParagraphs(source: string): string {
  const normalize = (text: string) => text.replace(/(?<!\\)(?:\\r\\n|\\n){2,}/gu,
    value => "\n".repeat(value.match(/\\r\\n|\\n/gu)!.length));
  const markers = /`+|^ {0,3}~{3,}/gmu;
  let result = "", cursor = 0, marker: RegExpExecArray | null;
  while ((marker = markers.exec(source))) {
    const delimiter = marker[0].trimStart();
    const lineStart = source.lastIndexOf("\n", marker.index - 1) + 1;
    const fenced = delimiter.length >= 3 && /^ {0,3}$/u.test(source.slice(lineStart, marker.index));
    const closing = fenced
      ? new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}[ \\t]*\\r?$`, "gmu")
      : /`+/gu;
    const nextLine = source.indexOf("\n", markers.lastIndex);
    closing.lastIndex = fenced ? nextLine < 0 ? source.length : nextLine + 1 : markers.lastIndex;
    let end = source.length, match: RegExpExecArray | null;
    while ((match = closing.exec(source))) {
      if (fenced || match[0].length === delimiter.length) {
        end = match.index + match[0].length;
        break;
      }
    }
    result += normalize(source.slice(cursor, marker.index)) + source.slice(marker.index, end);
    cursor = end;
    markers.lastIndex = end;
  }
  return result + normalize(source.slice(cursor));
}

/** 新报告先规范段落再进入事实校验；历史格式仍可回放，不改写正文事实。 */
export function normalizeReportNarrative(input: {body?: string; summary?: string;
  sections?: Array<{title: string; text: string; evidence_refs: string[]}>}) {
  if (input.body !== undefined) {
    if (!input.body.trim() || input.summary !== undefined || input.sections !== undefined)
      throw new Error("新报告只提交body正文；历史summary/sections不能与body混用。");
    return {summary: normalizeReportParagraphs(input.body), sections: [] as Array<{title: string; text: string; evidence_refs: string[]}>};
  }
  if (!input.summary?.trim() || !Array.isArray(input.sections)) throw new Error("请用body提交自然正文，或保留历史summary和sections完整格式。");
  return {summary: normalizeReportParagraphs(input.summary),
    sections: input.sections.map(section => ({...section, text: normalizeReportParagraphs(section.text)}))};
}

const editorialReviews = new WeakSet<object>();

/** cite只关联证据，不展示数值；引用仍须经过与普通占位符相同的来源校验。 */
export function narrativeEvidenceRefs(text: string) {
  return [...text.matchAll(/\{\{([^{}]+)\}\}/gu)].map(match => match[1]!.replace(/\|cite$/u, ""));
}

export function narrativeParagraphEvidence(text: string) {
  return text.split(/\n\s*\n/u).filter(paragraph => paragraph.trim()).map((paragraph, index) => ({
    paragraph: index + 1, evidence_refs: [...new Set(narrativeEvidenceRefs(paragraph))],
  })).filter(paragraph => paragraph.evidence_refs.length);
}

/** 检查明显的整表复述，仅提醒一次；表达风格不是事实错误，不进入事实兜底计数。 */
export function reviewNarrativeDensity(request: object & {originalMessage: string}, body: string | undefined,
  atoms: Array<{ref: string; type?: string}>, findings: Array<{question: string; evidence_refs: string[]}> = []) {
  if (!body || editorialReviews.has(request) || /逐项|逐个|全部数值|列出|明细|具体数值|表格/u.test(request.originalMessage)) return undefined;
  const available = new Set(atoms.filter(atom => ["fact", "calculation"].includes(atom.type ?? "")).map(atom => atom.ref));
  const used = new Set([...body.matchAll(/\{\{([^{}]+)\}\}/gu)].map(match => match[1]!).filter(ref => available.has(ref)));
  // 只识别明显复述，不据此决定分析好坏；少量关键数字、历史格式与普通查询不受影响。
  if (used.size < 8 || used.size < available.size * 0.75) return undefined;
  editorialReviews.add(request);
  return {content: [{type: "text" as const, text: `正文引用了${used.size}/${available.size}个事实或计算值，仍在复述数据表。请重新选择这次最影响判断的发现，围绕补查前后判断的变化重写body。通常三至六个关键数字即可支撑重点，按问题需要取舍，不逐项重写各主题现值与全部比较量；其他已核实方面可用简洁文字回应。展开应增加分化、反例或判断边界，不在开篇、各节与结尾重复同一结论。栏目和段落自由选择，不必按主题分章，也不要用空泛建议增加篇幅。若已有可查询的具体疑问，可先用inquiry补查。数字、日期及引用仍须通过事实校验。这是本轮唯一一次成文提醒，无需为增加篇幅补查。`
    + "\n无需展示数值的已核实判断，在对应句后用{{实际原子ref|cite}}关联依据；该引用仍核验并保存在证据中，但不会把次要数值插入正文。正文关键数字才用{{实际原子ref}}。"
    + (findings.length ? `\n当前真实证据触发的线索（不证明原因，按用户目标选择重点）：${JSON.stringify(findings.slice(0, 3))}` : "")}],
    details: {kind: "report_editorial_review", status: "needs_revision", retryable: true}};
}
