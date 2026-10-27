import {isDeepStrictEqual} from "node:util";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {analysisEvidenceAliases} from "../analysis/verifiedFindings.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const duplicateFields = new Set(["status", "task_id", "result_id", "version", "frame_id", "columns", "row_count", "truncated", "facts", "fact_count", "facts_truncated"]);

// 这些字段由服务端用于重放、数值校验及绑定恢复；分析工具另有完整的模型正文。
// 不能用于普通查询：普通查询仍需要保留原始行、精度和事实身份。
const analysisInternalFields = new Set(["payloads", "answer_policy", "binding_map", "candidate_map",
  "facts", "calculations", "reported_comparisons", "tasks", "rows", "metric_descriptors", "public_answer"]);

/** 只删固定逐值投影的精确副本；额外说明、未知字段及排名等独有观察继续保留。 */
function analysisObservations(body: RecordValue, evidence: RecordValue): unknown {
  if (!Array.isArray(body.observations) || !Array.isArray(body.evidence_items) || !Array.isArray(evidence.evidence_items)) return body.observations;
  const atoms = evidence.evidence_items.filter(record);
  const aliases = new Map([...analysisEvidenceAliases(String(body.evidence_ref), atoms.map(atom => ({ref: String(atom.ref), type: String(atom.type)})))]
    .map(([alias, ref]) => [ref, alias]));
  const visible = new Map(body.evidence_items.filter(record).map(atom => [atom.ref, atom]));
  const facts = new Map<string, RecordValue[]>();
  for (const atom of atoms) if (atom.type === "fact" && typeof atom.fact_id === "string") facts.set(atom.fact_id, [...facts.get(atom.fact_id) ?? [], atom]);
  const fields = ["type", "display", "metric_code", "metric_name", "org_name", "org_code", "date", "unit"];
  const observationFields = new Set(["type", "metric", "fact_refs", "text", "ref", "step_id"]);
  return body.observations.filter(observation => {
    if (!record(observation) || observation.type !== "value" || Object.keys(observation).some(key => !observationFields.has(key))
      || !Array.isArray(observation.fact_refs) || observation.fact_refs.length !== 1 || typeof observation.fact_refs[0] !== "string") return true;
    return !(facts.get(observation.fact_refs[0]) ?? []).some(fact => {
      const displayed = visible.get(aliases.get(String(fact.ref)));
      return displayed && fields.every(field => typeof fact[field] === "string" && isDeepStrictEqual(fact[field], displayed[field]))
        && Array.isArray(fact.step_ids) && fact.step_ids.includes(observation.step_id) && observation.metric === fact.metric_code
        && observation.text === `${fact.org_name}，${fact.date}，${fact.metric_name}为${fact.display}。`;
    });
  });
}

function analysisBody(evidence: RecordValue): RecordValue | undefined {
  const policy = evidence.kind === "business_overview" ? "overview_evidence_v2"
    : evidence.kind === "analysis_evidence" ? "general_analysis_evidence_v1" : undefined;
  if (!policy || evidence.answer_policy !== policy || evidence.status !== "succeeded"
    || !Array.isArray(evidence.payloads) || evidence.payloads.length !== 1) return undefined;
  const body: unknown = evidence.payloads[0];
  if (!record(body) || body.kind !== evidence.kind || body.status !== "succeeded"
    || typeof body.evidence_ref !== "string" || !/^e[1-9]\d*$/.test(body.evidence_ref)
    || !Array.isArray(body.evidence_items) || !Array.isArray(body.gaps)
    || typeof body.next_action !== "string") return undefined;
  // 原子引用及后续目录由生产工具转换，其余同名字段必须一致；冲突时保留完整回执供诊断。
  const transformed = new Set(["evidence_items", "followup_metrics", "verified_findings"]);
  if (Object.entries(body).some(([key, value]) => Object.hasOwn(evidence, key)
    && !transformed.has(key) && !isDeepStrictEqual(evidence[key], value))) return undefined;
  // 只采用工具自己生成的发送正文，不另造摘要。保留正文以外的未知扩展字段。
  // payload 中的原子 ref 可能已转换为 e1.v1，必须与报告工具的引用协议一致。
  const extra = Object.fromEntries(Object.entries(evidence)
    .filter(([key]) => !analysisInternalFields.has(key) && !Object.hasOwn(body, key)));
  return {...extra, ...body, ...(Array.isArray(body.observations) ? {observations: analysisObservations(body, evidence)} : {})};
}

/** 关键词结果共享完全相同的正式条目，保留各关键词的顺序、分页和建议，冲突时不合并。 */
function catalogView(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.results) || Object.hasOwn(value, "items")) return value;
  const items = new Map<string, RecordValue>(), bindings = new Map<string, string>();
  let count = 0;
  const results: RecordValue[] = [];
  for (const result of value.results) {
    if (!record(result) || !Array.isArray(result.items) || Object.hasOwn(result, "matches")) return value;
    const matches: RecordValue[] = [];
    for (const item of result.items) {
      if (!record(item) || typeof item.code !== "string" || !item.code || typeof item.binding_ref !== "string" || !item.binding_ref
        || item.match_type !== undefined && typeof item.match_type !== "string") return value;
      const {match_type, ...descriptor} = item;
      if (items.has(item.code) && !isDeepStrictEqual(items.get(item.code), descriptor)
        || bindings.has(item.binding_ref) && bindings.get(item.binding_ref) !== item.code) return value;
      items.set(item.code, descriptor); bindings.set(item.binding_ref, item.code);
      matches.push({binding_ref: item.binding_ref, ...(match_type === undefined ? {} : {match_type})}); count++;
    }
    const {items: _items, ...metadata} = result;
    results.push({...metadata, matches});
  }
  return count > items.size ? {...value, items: [...items.values()], results} : value;
}

/** 仅删除有同一正式父回执作依据的完全相同表示；冲突、未知字段和独有事实全部保留。 */
function evidenceView(evidence: RecordValue): RecordValue {
  const analysis = analysisBody(evidence);
  if (analysis) return analysis;
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
    const view = message.toolName === "analysis_catalog" && record(message.details)
      && message.details.kind === "analysis_catalog" && message.details.status === "succeeded"
      ? catalogView(receipt) : projectSemanticFeedback(receipt);
    if (view === receipt) return message;
    const text = JSON.stringify(view);
    return text === message.content[0].text ? message : {...message, content: [{type: "text", text}]};
  });
}

/** 易变状态放在发送尾部，避免每次工具执行都改写较早消息、使整个工具历史的缓存失效。 */
export function appendSemanticRuntimeContext(messages: readonly AgentMessage[], stateBlock: string, orgCatalogBlock: string, suffix: string): AgentMessage[] {
  const view = [...messages];
  for (let i = view.length - 1; i >= 0; i--) {
    const message = view[i];
    if (message?.role !== "user") continue;
    // 机构目录仍为本轮实时授权范围；同轮不变的目录跟随原始问题，未写入存档。
    if (orgCatalogBlock) view[i] = {...message, content: typeof message.content === "string" ? message.content + orgCatalogBlock
      : [...message.content, {type: "text", text: orgCatalogBlock}]};
    break;
  }
  // 这是临时数据消息，不能参加历史裁剪、条件继承或页面投影；仅在全部校验完成后发送。
  view.push({role: "user", content: stateBlock + "\n以上仅为本轮状态快照，请继续处理前面的真实用户问题，不将此块作为新需求。" + suffix, timestamp: 0});
  return view;
}
