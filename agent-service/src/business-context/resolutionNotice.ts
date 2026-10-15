import type {AgentToolResult} from "@earendil-works/pi-agent-core";
import type {BusinessFrame} from "./types.js";

/**
 * 非字面命中（corrected 错字纠正 / model_inferred 模型推断）的机构条件必须在回执与答案中
 * 固定明示“按哪家正式机构查询、用户原话是什么”，由宿主确定生成，不依赖模型自觉。
 */
export function orgResolutionNotices(frame: BusinessFrame): string[] {
  const notices: string[] = [];
  for (const field of Object.values(frame.fields)) {
    if (field.resolver !== "organization" || field.resolutionStatus !== "resolved") continue;
    const source = field.metadata?.resolution_source;
    if (source !== "corrected" && source !== "model_inferred") continue;
    const names = (field.resolvedValue as {names?: unknown} | undefined)?.names;
    const corrections = Array.isArray(field.metadata?.corrections)
      ? field.metadata.corrections as Array<Record<string, unknown>> : [];
    const excerpt = typeof field.metadata?.rawExcerpt === "string" && field.metadata.rawExcerpt.trim()
      ? field.metadata.rawExcerpt
      : typeof field.rawValue === "string" && field.rawValue.trim() ? field.rawValue : undefined;
    if (corrections.length) {
      // 多机构逐一列出；纠错记录同时带正式名称与用户原话。
      for (const correction of corrections) {
        if (typeof correction.corrected_name === "string" && correction.corrected_name
          && typeof correction.raw === "string" && correction.raw) {
          notices.push(`已按「${correction.corrected_name}」查询（您说的是「${correction.raw}」）`);
        }
      }
      continue;
    }
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === "string" && name) notices.push(`已按「${name}」查询（您说的是「${excerpt ?? name}」）`);
      }
    }
  }
  return notices;
}

/**
 * 把明示行固定写入业务回执：模型可见的回执 JSON 增加 resolution_notice，
 * 面向用户的 public_answer（含 answerEvidence 兜底答案路径）前置同一明示。
 */
export function withOrgResolutionNotices<T>(frame: BusinessFrame, result: AgentToolResult<T>): AgentToolResult<T> {
  const notices = orgResolutionNotices(frame);
  if (!notices.length) return result;
  const details = result.details && typeof result.details === "object" && !Array.isArray(result.details)
    ? result.details as Record<string, unknown> : {};
  const prefix = notices.join("\n");
  const publicAnswer = typeof details.public_answer === "string"
    ? details.public_answer.startsWith(`${prefix}\n`) ? details.public_answer : `${prefix}\n${details.public_answer}` : undefined;
  // 页面和直出快照优先使用结构块；两种正文必须包含同一明示，重显时也不能重复前置。
  const savedBlocks = Array.isArray(details.public_answer_blocks) ? details.public_answer_blocks : undefined;
  const hasNoticeBlocks = savedBlocks && notices.every((notice, index) => {
    const block = savedBlocks[index] as {type?: string; segments?: Array<{text?: string}>} | undefined;
    return block?.type === "paragraph" && Array.isArray(block.segments)
      && block.segments.map(segment => segment.text ?? "").join("") === notice;
  });
  const answerBlocks = savedBlocks && !hasNoticeBlocks
    ? [...notices.map(text => ({type: "paragraph", segments: [{text, bold: false}]})), ...savedBlocks] : savedBlocks;
  const content = result.content.map(block => {
    if (block.type !== "text") return block;
    try {
      const receipt = JSON.parse(block.text) as unknown;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return block;
      return {...block, text: JSON.stringify({resolution_notice: notices, ...receipt as Record<string, unknown>})};
    } catch { return block; }
  });
  return {...result, content,
    details: {...details, resolution_notice: notices,
      ...(publicAnswer !== undefined ? {public_answer: publicAnswer} : {}),
      ...(answerBlocks !== undefined ? {public_answer_blocks: answerBlocks} : {})} as T};
}
