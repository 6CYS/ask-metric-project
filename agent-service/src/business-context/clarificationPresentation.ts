import {createCapabilities} from "./capabilities.js";
import {fieldLabels} from "./core.js";
import {clarificationOptions, renderClarificationOptions} from "./clarificationOptions.js";
import type {BusinessFrame} from "./types.js";

/** 澄清只展示保存的字段与候选；模型正文不能临时建立另一个确认对象。 */
export function renderFrameClarification(frame: BusinessFrame, recoveryMessage?: string): string {
  const labels = fieldLabels(createCapabilities().get(frame.capability));
  const groups = clarificationOptions(frame, labels);
  const listed = new Set(groups.map(group => group.field));
  const pending = new Map(frame.issues.map(issue => [issue.field, issue]));
  for (const [field, value] of Object.entries(frame.fields)) {
    if (value.resolutionStatus !== "resolved" && value.resolutionStatus !== "missing" && !pending.has(field)) {
      pending.set(field, {field, reason: value.resolutionStatus});
    }
  }
  const questions = [...pending.values()].filter(issue => !listed.has(issue.field)).map(issue => {
    const label = labels[issue.field] ?? ({$base: "历史来源", $result: "历史结果"} as Record<string, string>)[issue.field] ?? "查询条件";
    const reference = frame.fields[issue.field]?.metadata?.referenceIssue as {message?: unknown} | undefined;
    if (typeof reference?.message === "string") return `${label}：${reference.message}`;
    const clarification = frame.fields[issue.field]?.metadata;
    if (clarification?.userInputIssue === true && typeof clarification.userClarificationQuestion === "string") {
      return clarification.userClarificationQuestion;
    }
    if (issue.field === "$base") return `${label}：无法确定您指的是哪次查询，请说明需要沿用的历史条件。`;
    if (issue.field === "$result") return `${label}：没有可读取的已完成结果，请说明需要查询的条件。`;
    if (issue.reason === "missing") return `请补充${label}。`;
    if (issue.reason === "invalid") return `${label}无效，请提供有效的${label}。`;
    return `尚未确定${label}，请提供具体的${label}。`;
  });
  for (const [field, value] of Object.entries(frame.fields)) {
    if (!listed.has(field)) continue;
    const additions = value.metadata?.referenceAdditionIssues as Array<{index: number; raw: string; status: string}> | undefined;
    if (!Array.isArray(additions)) continue;
    const itemsWithChoices = new Set(groups.filter(group => group.field === field).map(group => group.item));
    for (const addition of additions) {
      if (addition.status !== "resolved" && !itemsWithChoices.has(addition.index)) {
        questions.push(`新增${labels[field] ?? "条件"}「${addition.raw}」尚未确定，请补充具体名称；已确定的历史条件仍保留。`);
      }
    }
  }
  const listing = renderClarificationOptions(groups,
    Object.values(frame.fields).some(field => field.metadata?.confirmationUnclear === true));
  return [recoveryMessage, ...questions, listing].filter(Boolean).join("\n\n") || "请补充需要查询的具体条件。";
}
