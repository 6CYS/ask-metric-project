import {isDeepStrictEqual} from "node:util";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {analysisEvidenceAliases} from "../analysis/verifiedFindings.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(record) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const pick = (source: Row, names: readonly string[]): Row => Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
const decimal = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

interface EvidenceTable extends Row {
  metric_code: string; date: string; unit: string; columns: ["ref", "org", "value"]; rows: string[][]; step_ids: string[];
}
interface UnavailableMetric extends Row {metric_code: string; reason: string; org_codes: string[]; row_count: number}

/** 只改变模型读取形式；原子身份、权限、原始精度及审计记录仍由原回执维护。 */
export function inquiryEvidenceView(evidence: Row, evidenceRef: string): object {
  const scope = pick(evidence, ["kind", "status", "run_ref", "scope_id", "frame_id", "execution_turn_id", "actual_dates", "analysis_date",
    "date_selection", "requested_start", "requested_end", "checked_on", "complete", "row_count", "gaps", "limitations",
    "requirement_dispositions", "source_notice", "snapshot_notice", "defaults_applied", "plan"]);
  if (evidence.status !== "succeeded") return {...scope, ...pick(evidence, ["error_code", "retryable"])};
  const atoms = rows(evidence.evidence_items);
  // 必须从完整集合建立别名；不可用值仍占原编号，后面的可用事实不能前移。
  const aliases = new Map([...analysisEvidenceAliases(evidenceRef, atoms.map(atom => ({ref: text(atom.ref), type: text(atom.type),
    judgment_kind: text(atom.judgment_kind)})))].map(([alias, ref]) => [ref, alias]));
  const descriptors = new Map(rows(evidence.metric_descriptors).map(metric => [text(metric.code), metric]));
  const byFact = new Map(atoms.filter(atom => typeof atom.fact_id === "string").map(atom => [text(atom.fact_id), text(atom.ref)]));
  const inputs = (atom: Row) => [...new Set([...strings(atom.input_refs), ...strings(atom.input_fact_refs)].map(ref => byFact.get(ref) ?? ref))];
  const unavailable = new Map<string, string>();
  const metadata = (atom: Row) => {
    const metric = descriptors.get(text(atom.metric_code)) ?? {};
    return {metric, unit: text(atom.unit) || text(metric.unit), encoding: atom.value_encoding ?? metric.value_encoding};
  };
  const numericAtoms = atoms.filter(atom => ["fact", "calculation"].includes(text(atom.type)));
  for (const atom of numericAtoms) {
    const {unit, encoding} = metadata(atom);
    const reason = !unit ? "unknown_unit" : unit === "%" && !["ratio", "percent"].includes(text(encoding)) ? "unknown_percentage_encoding"
      : !decimal.test(text(atom.value)) || !text(atom.display) ? "missing_value" : undefined;
    if (reason) unavailable.set(text(atom.ref), reason);
  }
  // 已知不可用输入不能通过派生计算重新变成可引用数值。
  for (let changed = true; changed;) {
    changed = false;
    for (const atom of numericAtoms) if (atom.type === "calculation" && !unavailable.has(text(atom.ref))
      && inputs(atom).some(ref => unavailable.has(ref))) {
      unavailable.set(text(atom.ref), "unavailable_calculation_input"); changed = true;
    }
  }
  const organizations: Record<string, string> = {};
  const codes = strings(evidence.org_codes), names = strings(evidence.org_names);
  codes.forEach((code, index) => {if (names[index]) organizations[code] = names[index];});
  const tables = new Map<string, EvidenceTable>(), missing = new Map<string, UnavailableMetric>();
  const calculations: Row[] = [];
  for (const atom of numericAtoms) {
    const {metric, unit, encoding} = metadata(atom), org = text(atom.org_code), ref = text(atom.ref);
    if (org && text(atom.org_name)) organizations[org] = text(atom.org_name);
    const metricCode = text(atom.metric_code) || text(atom.calculation_id) || "calculation";
    const date = text(atom.date), hint = record(metric.analysis_hint) ? metric.analysis_hint : {};
    const basis = atom.comparison ?? hint.comparison ?? metric.value_basis;
    const role = atom.comparison_role ?? hint.comparison_role;
    const header = {metric_code: metricCode, metric_name: text(atom.metric_name) || text(metric.name), date, unit,
      ...pick(metric, ["description", "explanation", "quantity_kind", "frequency", "limitations"]),
      ...(basis !== undefined ? {basis} : {}), ...(role !== undefined ? {comparison_role: role} : {}),
      ...(encoding !== undefined ? {value_encoding: encoding} : {})};
    const key = JSON.stringify([metricCode, date, unit, basis, role]), reason = unavailable.get(ref);
    if (reason) {
      const id = `${key}:${reason}`, group = missing.get(id) ?? {...header, reason, org_codes: [], row_count: 0};
      if (org && !group.org_codes.includes(org)) group.org_codes.push(org);
      group.row_count++; missing.set(id, group); continue;
    }
    const table = tables.get(key) ?? {...header, columns: ["ref", "org", "value"], rows: [], step_ids: []} as EvidenceTable;
    table.rows.push([aliases.get(ref) ?? ref, org, text(atom.display)]);
    table.step_ids = [...new Set([...table.step_ids, ...strings(atom.step_ids)])]; tables.set(key, table);
    if (atom.type === "calculation") calculations.push({ref: aliases.get(ref) ?? ref,
      ...pick(atom, ["calculation", "formula", "method"]), input_refs: inputs(atom).map(input => aliases.get(input) ?? input)});
  }
  const byRef = new Map(atoms.map(atom => [text(atom.ref), atom])), rankingOrder = new Map<string, number>();
  const findings = atoms.filter(atom => text(atom.judgment_kind) && !inputs(atom).some(ref => unavailable.has(ref)))
    .map(atom => {
      const refs = inputs(atom);
      const ranked = atom.judgment_kind === "ranking" ? refs.map(ref => byRef.get(ref)).filter(item => item?.type === "fact"
        && item.org_code === atom.org_code && item.date === atom.date) : [];
      const subject = ranked.length === 1 ? ranked[0] : undefined;
      // 全体比较依据保存在原回执；模型只需本条排名对应的事实和后端已算好的名次。
      if (subject) {
        const ref = aliases.get(text(subject.ref)) ?? text(subject.ref);
        if (!rankingOrder.has(ref)) rankingOrder.set(ref, rankingOrder.size);
      }
      return {ref: aliases.get(text(atom.ref)) ?? text(atom.ref),
        ...pick(atom, ["judgment_kind", "display", "rank", "position", "org_code", "date", "step_ids"]),
        ...(subject ? {metric_code: subject.metric_code} : {}),
        input_refs: (subject ? [text(subject.ref)] : refs).map(ref => aliases.get(ref) ?? ref)};
    });
  for (const table of tables.values()) table.rows.sort((left, right) =>
    (rankingOrder.get(left[0] ?? "") ?? Number.MAX_SAFE_INTEGER) - (rankingOrder.get(right[0] ?? "") ?? Number.MAX_SAFE_INTEGER));
  return {...scope, evidence_ref: evidenceRef, organizations, tables: [...tables.values()], unavailable_metrics: [...missing.values()],
    findings, calculations};
}

/** 同一正式身份只发送一次定义；分页、匹配关系和未确认建议仍属于各自检索结果。 */
export function inquiryCatalogView(value: unknown): unknown {
  if (!record(value)) return value;
  const results = Array.isArray(value.results) ? value.results : Array.isArray(value.items) ? [value] : undefined;
  if (!results) return value;
  const items = new Map<string, Row>(), bindings = new Map<string, string>(), output: Row[] = [];
  for (const result of results) {
    if (!record(result) || !Array.isArray(result.items)) return value;
    const matches: Row[] = [], suggestions = rows(result.semantic_suggestions).map(({binding_ref: _binding, ...item}) => item);
    for (const item of result.items) {
      if (!record(item)) return value;
      if (item.match_type === "semantic") {const {binding_ref: _binding, ...suggestion} = item; suggestions.push(suggestion); continue;}
      const {match_type, ...descriptor} = item, code = text(item.code), binding = text(item.binding_ref);
      if (!code || !binding || items.has(code) && !isDeepStrictEqual(items.get(code), descriptor)
        || bindings.has(binding) && bindings.get(binding) !== code) return value;
      items.set(code, descriptor); bindings.set(binding, code);
      matches.push({binding_ref: binding, ...(match_type !== undefined ? {match_type} : {})});
    }
    const {items: _items, semantic_suggestions: _suggestions, binding_map: _bindings, candidate_map: _candidates, ...metadata} = result;
    output.push({...metadata, matches, ...(suggestions.length || result.semantic_suggestions !== undefined ? {semantic_suggestions: suggestions} : {})});
  }
  const {results: _results, items: _items, binding_map: _bindings, candidate_map: _candidates, catalog_answer: _answer,
    ...metadata} = Array.isArray(value.results) ? value : {};
  return {...metadata, items: [...items.values()], results: output};
}

function projectEvidence(value: unknown, full: unknown): unknown {
  if (!record(value)) return value;
  if (value.protocol_version === 2 && record(value.state)) {
    const raw = record(full) && record(full.state) ? full.state.evidence : undefined;
    return {...value, state: {...value.state, evidence: projectEvidence(value.state.evidence, raw)}};
  }
  if (value.kind === "semantic_results" && Array.isArray(value.results)) {
    const sources = record(full) ? rows(full.results) : [];
    return {...value, results: value.results.map(item => projectEvidence(item,
      record(item) ? sources.find(source => source.run_ref === item.run_ref) : undefined))};
  }
  if (value.kind !== "analysis_evidence" || value.status !== "succeeded" || Array.isArray(value.tables)) return value;
  const body = rows(value.payloads).find(payload => payload.kind === value.kind && typeof payload.evidence_ref === "string");
  const ref = text(value.evidence_ref) || text(body?.evidence_ref);
  if (!/^e[1-9]\d*$/u.test(ref)) return value;
  const source = record(full) && full.kind === value.kind && full.run_ref === value.run_ref ? full : value;
  // 老历史可能只保存已过滤的短引用正文；没有完整原子集合时不能重新签发编号。
  if (rows(source.evidence_items).some(atom => /^e[1-9]\d*\.[vj][1-9]\d*$/u.test(text(atom.ref)))) return value;
  return inquiryEvidenceView(source, ref);
}

/** 仅压缩 SDK 明确未执行的参数错误，保留字段约束；原会话仍保存完整参数用于诊断。 */
function validationFailures(messages: readonly AgentMessage[]) {
  const calls = new Map<string, {name: string; arguments: Record<string, unknown>}>();
  const failures = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block);
      continue;
    }
    if (message.role !== "toolResult" || !message.isError || message.details != null
      || message.content.length !== 1 || message.content[0]?.type !== "text") continue;
    const call = calls.get(message.toolCallId), body = message.content[0].text;
    if (!call || call.name !== message.toolName || !body.startsWith(`Validation failed for tool "${call.name}":\n`)) continue;
    // 与当前锁定的 SDK 回显格式及参数严格对应，不把业务错误或任意文本当作 schema 失败。
    const echo = `\n\nReceived arguments:\n${JSON.stringify(call.arguments, null, 2)}`;
    if (body.endsWith(echo)) failures.set(message.toolCallId,
      `${body.slice(0, -echo.length)}\n该调用未执行，失败参数已从发送副本移除。请按原问题及工具定义修正参数。`);
  }
  return failures;
}

/** 历史只沿用每条回执签发时的别名，不以本轮证据顺序重新编号。宿主先筛选可访问历史。 */
export function projectInquiryMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const failures = validationFailures(messages);
  return messages.map(message => {
    if (message.role === "assistant" && message.content.some(block => block.type === "toolCall" && failures.has(block.id)))
      return {...message, content: message.content.map(block => block.type === "toolCall" && failures.has(block.id)
        ? {...block, arguments: {}} : block)};
    const failure = message.role === "toolResult" ? failures.get(message.toolCallId) : undefined;
    if (failure !== undefined) return {...message, content: [{type: "text", text: failure}]};
    if (message.role !== "toolResult" || message.isError || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
    let value: unknown;
    try {value = JSON.parse(message.content[0].text);} catch {return message;}
    const view = message.toolName === "analysis_catalog" ? inquiryCatalogView(value) : projectEvidence(value, message.details);
    const projected = JSON.stringify(view);
    return projected === message.content[0].text ? message : {...message, content: [{type: "text", text: projected}]};
  });
}
