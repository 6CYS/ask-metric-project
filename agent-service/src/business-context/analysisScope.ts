import type {BusinessFrame, ResolvedField} from "./types.js";
import {isCalendarDate} from "../tools/shared.js";

export interface AnalysisMetricDates {metric_code: string; binding_ref: string; org_code: string; dates: string[]}
export interface AnalysisDates {complete: boolean; actual_dates: string[]; metric_dates: AnalysisMetricDates[]; execution_turn_id?: string}
export type AnalysisDatePolicy = Pick<ResolvedField, "rawValue" | "resolvedValue" | "resolutionStatus" | "resolver">;
export interface AnalysisExecutionScope {org_codes: string[]; org_names: string[]; dates: AnalysisDates}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown) => Array.isArray(value) ? value.filter(record) : [];
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && !!item);
const dates = (value: unknown): value is string[] => strings(value) && value.every(isCalendarDate) && new Set(value).size === value.length;

/** 专题正文统一按 analysis_date 取当前事实；历史 facts 和计算基期不改变这个分析范围。 */
function overviewExecutionScope(details: Record<string, unknown>): AnalysisExecutionScope | undefined {
  const day = details.analysis_date;
  if (details.status !== "succeeded" || details.truncated === true || details.period
    || !["latest_snapshot", "exact"].includes(String(details.date_selection))
    || !strings(details.org_codes) || details.org_codes.length !== 1 || typeof details.org_name !== "string" || !details.org_name
    || typeof day !== "string" || !isCalendarDate(day) || !record(details.facts)) return undefined;
  const orgCode = details.org_codes[0];
  const current = Object.values(details.facts).filter(record).map(metric => metric[day]).filter(record)
    .filter(fact => fact.org_code === orgCode && fact.org_name === details.org_name && fact.date === day
      && typeof fact.metric_code === "string" && typeof fact.fact_id === "string");
  const atoms = records(details.evidence_items).filter(atom => typeof atom.fact_id === "string");
  if (!current.some(fact => atoms.some(atom => atom.fact_id === fact.fact_id && atom.date === day))
    || atoms.some(atom => atom.date !== day)
    || records(details.table_rows).some(row => row.data_date !== undefined && row.data_date !== day)) return undefined;
  return {org_codes: [...details.org_codes], org_names: [details.org_name], dates: {
    complete: true, actual_dates: [day], metric_dates: [],
    ...(typeof details.execution_turn_id === "string" && details.execution_turn_id ? {execution_turn_id: details.execution_turn_id} : {}),
  }};
}

/** 只从正式成功回执取范围；比较基期不能冒充下一轮沿用的分析时点。 */
export function analysisExecutionScope(details: Record<string, unknown>): AnalysisExecutionScope | undefined {
  if (details.kind === "business_overview") return overviewExecutionScope(details);
  if (details.kind !== "analysis_evidence" || details.status !== "succeeded"
    || !strings(details.org_codes) || !details.org_codes.length || !strings(details.org_names)
    || details.org_codes.length !== details.org_names.length || new Set(details.org_codes).size !== details.org_codes.length) return undefined;
  const rows = records(details.rows), current = rows.filter(row => row.value_role === "分析时点");
  const atoms = records(details.evidence_items), descriptors = records(details.metric_descriptors);
  const grouped = new Map<string, AnalysisMetricDates>();
  let matched = 0;
  for (const row of current) {
    const facts = atoms.filter(atom => atom.type === "fact" && atom.metric_name === row.metric_name
      && atom.org_name === row.org_name && atom.date === row.stat_date);
    if (facts.length !== 1) continue;
    const fact = facts[0]!;
    const bindings = descriptors.filter(item => item.code === fact.metric_code && item.name === fact.metric_name);
    if (typeof fact.metric_code !== "string" || typeof fact.org_code !== "string" || !details.org_codes.includes(fact.org_code)
      || typeof fact.date !== "string" || !isCalendarDate(fact.date) || bindings.length !== 1
      || typeof bindings[0]!.binding_ref !== "string" || !bindings[0]!.binding_ref) continue;
    const key = JSON.stringify([fact.metric_code, fact.org_code]);
    const item = grouped.get(key) ?? {metric_code: fact.metric_code, binding_ref: bindings[0]!.binding_ref,
      org_code: fact.org_code, dates: []};
    if (!item.dates.includes(fact.date)) item.dates.push(fact.date);
    grouped.set(key, item); matched++;
  }
  const metric_dates = [...grouped.values()].map(item => ({...item, dates: item.dates.sort()}));
  const actual_dates = dates(details.actual_dates) ? [...details.actual_dates].sort() : [];
  const observed = [...new Set(metric_dates.flatMap(item => item.dates))].sort();
  return {org_codes: [...details.org_codes], org_names: [...details.org_names], dates: {
    ...(typeof details.execution_turn_id === "string" && details.execution_turn_id ? {execution_turn_id: details.execution_turn_id} : {}),
    complete: details.complete === true && details.truncated !== true && current.length > 0 && matched === current.length
      && rows.length === details.row_count && actual_dates.length > 0 && JSON.stringify(actual_dates) === JSON.stringify(observed),
    actual_dates, metric_dates,
  }};
}

/** 混合日期仅存映射，不能用全局最大日覆盖所有指标；沿用者须选择对应正式绑定。 */
export function settleAnalysisScopeFields(frame: BusinessFrame, scope: AnalysisExecutionScope | undefined): BusinessFrame["fields"] {
  const fields = structuredClone(frame.fields);
  if (!["business_analysis", "business_overview"].includes(frame.capability) || !scope) return fields;
  if (!fields.organizations || fields.organizations.resolutionStatus === "missing") fields.organizations = {
    rawValue: scope.org_names.join("、"), resolvedValue: {codes: [...scope.org_codes], names: [...scope.org_names]},
    resolutionStatus: "resolved", source: "resolved", resolver: "organization", metadata: {analysisScope: true},
  };
  const time = fields.time ?? {resolutionStatus: "missing", source: "resolved"};
  const value = record(time.resolvedValue) ? time.resolvedValue : undefined;
  const latest = time.resolutionStatus === "missing" || value?.date_selection === "latest_snapshot" || value?.preset === "latest";
  // 自动固定日期不能抹去本轮原始策略，后续新发现的指标可能有不同发布日。
  const policy: AnalysisDatePolicy | undefined = latest ? {resolutionStatus: time.resolutionStatus,
    ...(time.rawValue !== undefined ? {rawValue: structuredClone(time.rawValue)} : {}),
    ...(time.resolvedValue !== undefined ? {resolvedValue: structuredClone(time.resolvedValue)} : {}),
    ...(time.resolver ? {resolver: time.resolver} : {})}
    : time.source === "inherited" ? time.metadata?.analysisDatePolicy as AnalysisDatePolicy | undefined : undefined;
  time.metadata = {...time.metadata, analysisDates: structuredClone(scope.dates)};
  if (policy && frame.capability === "business_analysis") time.metadata.analysisDatePolicy = structuredClone(policy);
  else delete time.metadata.analysisDatePolicy;
  if (latest && scope.dates.complete && scope.dates.actual_dates.length === 1) {
    const day = scope.dates.actual_dates[0]!;
    Object.assign(time, {rawValue: day, resolvedValue: {start: day, end: day, date_selection: "exact"},
      resolutionStatus: "resolved", source: "resolved", resolver: "overview_date"});
  }
  fields.time = time;
  return fields;
}

/** 所选绑定全部具有完整实际日期才允许续用；调用方不能将 undefined 降回 latest。 */
export function selectedAnalysisDates(metadata: unknown, refs: readonly string[]): Pick<AnalysisDates, "actual_dates" | "metric_dates"> | undefined {
  if (!record(metadata) || metadata.complete !== true || !dates(metadata.actual_dates) || !refs.length
    || !Array.isArray(metadata.metric_dates)) return undefined;
  const actualDates = metadata.actual_dates;
  const entries = metadata.metric_dates.filter((item): item is AnalysisMetricDates => record(item)
    && typeof item.metric_code === "string" && typeof item.binding_ref === "string" && typeof item.org_code === "string"
    && dates(item.dates) && item.dates.length > 0 && item.dates.every(day => actualDates.includes(day)));
  if (entries.length !== metadata.metric_dates.length || refs.some(ref => !entries.some(item => item.binding_ref === ref))) return undefined;
  const metric_dates = entries.filter(item => refs.includes(item.binding_ref));
  return {actual_dates: [...new Set(metric_dates.flatMap(item => item.dates))].sort(), metric_dates: structuredClone(metric_dates)};
}
