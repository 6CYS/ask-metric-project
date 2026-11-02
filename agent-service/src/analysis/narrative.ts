/** 只修复代码片段之外重复转义的段落换行，不解码路径、引号或证据内容。 */
export function normalizeReportParagraphs(source: string): string {
  const normalize = (text: string) =>
    text.replace(/(?<!\\)(?:\\r\\n|\\n){2,}/gu, (value) =>
      "\n".repeat(value.match(/\\r\\n|\\n/gu)!.length),
    );
  const markers = /`+|^ {0,3}~{3,}/gmu;
  let result = "",
    cursor = 0,
    marker: RegExpExecArray | null;
  while ((marker = markers.exec(source))) {
    const delimiter = marker[0].trimStart();
    const lineStart = source.lastIndexOf("\n", marker.index - 1) + 1;
    const fenced = delimiter.length >= 3 && /^ {0,3}$/u.test(source.slice(lineStart, marker.index));
    const closing = fenced
      ? new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}[ \\t]*\\r?$`, "gmu")
      : /`+/gu;
    const nextLine = source.indexOf("\n", markers.lastIndex);
    closing.lastIndex = fenced ? (nextLine < 0 ? source.length : nextLine + 1) : markers.lastIndex;
    let end = source.length,
      match: RegExpExecArray | null;
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
export function normalizeReportNarrative(input: {
  body?: string;
  summary?: string;
  sections?: Array<{ title: string; text: string; evidence_refs: string[] }>;
}) {
  if (input.body !== undefined) {
    if (!input.body.trim() || input.summary !== undefined || input.sections !== undefined)
      throw new Error("新报告只提交body正文；历史summary/sections不能与body混用。");
    return {
      summary: normalizeReportParagraphs(input.body),
      sections: [] as Array<{ title: string; text: string; evidence_refs: string[] }>,
    };
  }
  if (!input.summary?.trim() || !Array.isArray(input.sections))
    throw new Error("请用body提交自然正文，或保留历史summary和sections完整格式。");
  return {
    summary: normalizeReportParagraphs(input.summary),
    sections: input.sections.map((section) => ({
      ...section,
      text: normalizeReportParagraphs(section.text),
    })),
  };
}

/** cite只关联证据，不展示数值；引用仍须经过与普通占位符相同的来源校验。 */
export class NarrativeReferenceError extends Error {}

export function parseNarrativeReference(value: string) {
  // Markdown 表格会转义竖线；仅解码引用协议内这一种格式转义。
  const [ref, ...fields] = value.replaceAll("\\|", "|").split("|");
  if (!ref) throw new NarrativeReferenceError("引用缺少事实编号。");
  const coordinates: Record<string, string> = {};
  let citation = false;
  for (const field of fields) {
    if (field === "cite" && !citation) {
      citation = true;
      continue;
    }
    const separator = field.indexOf("=");
    const key = field.slice(0, separator),
      content = field.slice(separator + 1);
    if (
      separator < 1 ||
      !["org", "metric", "date"].includes(key) ||
      !content ||
      coordinates[key] !== undefined
    )
      throw new NarrativeReferenceError(
        "数字引用使用 {{ref}}，已写数值紧随 {{ref|cite}} 关联依据；不要添加其他字段。",
      );
    coordinates[key] = content;
  }
  if (Object.keys(coordinates).length && Object.keys(coordinates).length !== 3)
    throw new NarrativeReferenceError("旧坐标声明不完整；请改用工具结果中的 {{ref}} 引用。");
  return {
    ref,
    citation,
    binding: coordinates.org
      ? {
          ref,
          org_code: coordinates.org,
          metric_code: coordinates.metric!,
          date: coordinates.date!,
        }
      : undefined,
  };
}

export function narrativeEvidenceRefs(text: string) {
  const remaining = text.replace(/\{\{([^{}]+)\}\}/gu, "");
  if (remaining.includes("{{") || remaining.includes("}}"))
    throw new NarrativeReferenceError("事实引用必须完整闭合且非空，请检查 {{...}} 格式。");
  return [...text.matchAll(/\{\{([^{}]+)\}\}/gu)].map(
    (match) => parseNarrativeReference(match[1]!).ref,
  );
}

export function narrativeParagraphEvidence(text: string) {
  return text
    .split(/\n\s*\n/u)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph, index) => ({
      paragraph: index + 1,
      evidence_refs: [...new Set(narrativeEvidenceRefs(paragraph))],
    }))
    .filter((paragraph) => paragraph.evidence_refs.length);
}

/** 配图只使用最终正文已核验的依据；原文引用仅用于保留叙述顺序。 */
export function verifiedNarrativeRefs(
  report: unknown,
  originalRefs: readonly string[] = [],
): string[] | undefined {
  if (!report || typeof report !== "object" || !("body_evidence" in report)) return;
  if (!Array.isArray(report.body_evidence)) return [];
  const refs = report.body_evidence.flatMap((paragraph: unknown) => {
    if (
      !paragraph ||
      typeof paragraph !== "object" ||
      !("evidence_refs" in paragraph) ||
      !Array.isArray(paragraph.evidence_refs)
    )
      return [];
    return paragraph.evidence_refs.filter(
      (ref: unknown): ref is string => typeof ref === "string" && !!ref,
    );
  });
  const verified = new Set(refs);
  return [...new Set([...originalRefs.filter((ref) => verified.has(ref)), ...refs])];
}
