import {isDeepStrictEqual} from "node:util";
import type {AgentMessage} from "@earendil-works/pi-agent-core";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const duplicateFields = new Set(["status", "task_id", "result_id", "version", "frame_id", "columns", "row_count", "truncated", "facts", "fact_count", "facts_truncated"]);

/** 仅删除有同一正式父回执作依据的完全相同表示；冲突、未知字段和独有事实全部保留。 */
function evidenceView(evidence: RecordValue): RecordValue {
  const view = {...evidence};
  if (evidence.kind === "semantic_results" && Array.isArray(evidence.results)) {
    view.results = evidence.results.map(item => record(item) ? evidenceView(item) : item);
  }
  if (!Array.isArray(evidence.payloads)) return view;
  const payloads = evidence.payloads.map(payload => {
    if (!record(payload)) return payload;
    const retained = {...payload};
    for (const key of duplicateFields) {
      if (Object.hasOwn(evidence, key) && Object.hasOwn(retained, key)
        && isDeepStrictEqual(evidence[key], retained[key])) delete retained[key];
    }
    if (Object.hasOwn(evidence, "rows") && Object.hasOwn(retained, "sample_rows")
      && isDeepStrictEqual(evidence.rows, retained.sample_rows)) delete retained.sample_rows;
    if (Object.hasOwn(evidence, "public_answer") && Object.hasOwn(retained, "message")
      && isDeepStrictEqual(evidence.public_answer, retained.message)) delete retained.message;
    return retained;
  }).filter(payload => !record(payload) || Object.keys(payload).length > 0);
  if (payloads.length) view.payloads = payloads;
  else delete view.payloads;
  return view;
}

/** 模型发送视图不是持久化协议；不裁行、不合并目标、不移除来源或完整性信息。 */
export function projectSemanticFeedback(value: unknown): unknown {
  if (!record(value) || value.protocol_version !== 2 || !record(value.state) || !record(value.state.evidence)) return value;
  return {...value, state: {...value.state, evidence: evidenceView(value.state.evidence)}};
}

export function projectSemanticModelMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map(message => {
    if (message.role !== "toolResult" || message.isError || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
    let receipt: unknown;
    try {receipt = JSON.parse(message.content[0].text);} catch {return message;}
    const view = projectSemanticFeedback(receipt);
    if (view === receipt) return message;
    const text = JSON.stringify(view);
    return text === message.content[0].text ? message : {...message, content: [{type: "text", text}]};
  });
}
