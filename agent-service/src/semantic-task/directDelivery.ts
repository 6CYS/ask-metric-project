import {createHash} from "node:crypto";
import type {AnswerBlock} from "../backendClient.js";
import {isSemanticFeedback, type SemanticFeedback} from "./feedback.js";

export interface DirectAnswerSource {
  target_ref: string; frame_id: string; task_id: string; result_id: string; result_ref: string;
  row_count: number; truncated: false;
}
export interface DirectAnswerSnapshot {
  version: 1; renderer_version: "query_result_v1"; delivery_path: "direct_query";
  answer_id: string; operation_id: string; plan_ref: string; plan_revision: number;
  public_answer: string; answer_blocks: AnswerBlock[]; sources: DirectAnswerSource[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const segments = (value: unknown): boolean => Array.isArray(value) && value.every(item => object(item) && typeof item.text === "string" && typeof item.bold === "boolean");
function answerBlock(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.type === "paragraph") return segments(value.segments);
  if (value.type === "list") return typeof value.ordered === "boolean" && Array.isArray(value.items) && value.items.every(segments);
  const header = value.header;
  return value.type === "table" && Array.isArray(header) && header.every(segments)
    && Array.isArray(value.rows) && value.rows.every(row => Array.isArray(row) && row.length === header.length && row.every(segments))
    && Array.isArray(value.aligns) && value.aligns.length === header.length && value.aligns.every(item => ["left", "center", "right"].includes(item as string));
}
const snapshotId = (value: Omit<DirectAnswerSnapshot, "answer_id">) => "direct-answer-" + createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 唯一恢复入口：只认真实工具回执内的版本化完整快照，校验失败不能变成成功答案。 */
export function readDirectAnswerSnapshot(details: unknown): DirectAnswerSnapshot | undefined {
  if (!isSemanticFeedback(details) || !["succeeded", "reused"].includes(details.status)
    || details.state.completion !== "full" || !Array.isArray(details.issues) || details.issues.length
    || !object(details.continuation) || details.continuation.action !== "deliver_saved_answer"
    || !Array.isArray(details.state.targets) || details.state.targets.some(target => !object(target) || !nonempty(target.target_ref)
      || target.status !== "succeeded" || !Array.isArray(target.pending) || target.pending.length)) return;
  const candidate = (details as SemanticFeedback & {direct_answer?: unknown}).direct_answer;
  if (!object(candidate) || candidate.version !== 1 || candidate.renderer_version !== "query_result_v1" || candidate.delivery_path !== "direct_query"
    || !nonempty(candidate.answer_id) || !nonempty(candidate.operation_id) || !nonempty(candidate.plan_ref)
    || !Number.isInteger(candidate.plan_revision) || Number(candidate.plan_revision) < 1 || !nonempty(candidate.public_answer)
    || !Array.isArray(candidate.answer_blocks) || !candidate.answer_blocks.length || !candidate.answer_blocks.every(answerBlock)
    || !Array.isArray(candidate.sources) || !candidate.sources.length || candidate.sources.some(source => !object(source)
      || ![source.target_ref, source.frame_id, source.task_id, source.result_id, source.result_ref].every(nonempty)
      || !Number.isInteger(source.row_count) || Number(source.row_count) < 0 || source.truncated !== false
      || source.result_ref !== `query:${encodeURIComponent(String(source.task_id))}:${encodeURIComponent(String(source.result_id))}`)) return;
  const snapshot = candidate as unknown as DirectAnswerSnapshot;
  if (new Set(snapshot.sources.map(source => source.target_ref)).size !== snapshot.sources.length
    || snapshot.plan_ref !== details.state.task_ref || snapshot.sources.length !== details.state.targets.length
    || details.state.targets.some(target => target.status !== "succeeded" || target.pending.length || !snapshot.sources.some(source => source.target_ref === target.target_ref))) return;
  const {answer_id, ...body} = snapshot;
  return snapshotId(body) === answer_id ? structuredClone(snapshot) : undefined;
}
