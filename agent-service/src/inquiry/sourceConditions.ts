import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isCalendarDate } from "../tools/shared.js";

export interface QueryDate {
  date_selection: string;
  start?: string;
  end?: string;
  dates?: string[];
  anchor_date?: string;
}

export interface QuerySourceContext {
  metric_dates: Map<string, Map<string, QueryDate | undefined>>;
  range_selection?: string | undefined;
}

type Row = Record<string, unknown>;
interface SourceConditions extends QuerySourceContext {
  reference: Row;
}
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item)
    : [];
const unique = (values: string[]): string[] => [...new Set(values)];

export function rangeSelection(value: unknown): string | undefined {
  return typeof value === "string" &&
    ["all_in_range", "latest_in_range", "available_in_range"].includes(value)
    ? value
    : undefined;
}

function exactDate(days: string[]): QueryDate | undefined {
  const day = days.length === 1 ? days[0] : undefined;
  return day && isCalendarDate(day) ? { date_selection: "exact", start: day, end: day } : undefined;
}

/** 只有所有目标期间一致时才使用统一日期作为查询复用标识。 */
export function uniformQueryDate(
  conditions: QuerySourceContext | undefined,
  codes: Set<string>,
): QueryDate | undefined {
  if (!conditions) return undefined;
  const dates = [...conditions.metric_dates]
    .filter(([code]) => codes.has(code))
    .flatMap(([, organizations]) => [...organizations.values()]);
  const uniqueDates = new Map(dates.map((date) => [JSON.stringify(date), date]));
  return uniqueDates.size === 1 ? [...uniqueDates.values()][0] : undefined;
}

/** 兼容读取按任务身份定位；不从同一批次的其他任务借用条件。 */
function legacyReceipt(source: Row, message?: AgentMessage): Row {
  const find = (value: unknown): Row | undefined => {
    if (Array.isArray(value)) return value.map(find).find(Boolean);
    if (!value || typeof value !== "object") return undefined;
    const item = record(value);
    if (
      item.task_id === source.task_id &&
      (item.query_evidence || Array.isArray(item.facts)) &&
      (!source.result_id || !item.result_id || source.result_id === item.result_id)
    )
      return item;
    return find(item.payloads) ?? find(item.results) ?? find(record(item.state).evidence);
  };
  if (message?.role === "toolResult") {
    for (const block of message.content) {
      if (block.type !== "text") continue;
      try {
        const payload = find(JSON.parse(block.text));
        if (payload) return { ...payload, ...source };
      } catch {
        /* 非 JSON 正文不提供查询条件。 */
      }
    }
  }
  return source;
}

function currentFacts(source: Row): Row[] {
  const currentKeys = new Set(
    rows(source.rows)
      .filter((item) => item.value_role === "分析时点")
      .map((item) => JSON.stringify([item.metric_name, item.org_name, item.stat_date])),
  );
  return [
    ...rows(source.evidence_items).filter((item) => ["fact", "value"].includes(text(item.type))),
    ...rows(source.facts),
    ...rows(source.rows),
  ].filter(
    (item) =>
      !currentKeys.size ||
      currentKeys.has(
        JSON.stringify([item.metric_name, item.org_name, item.date ?? item.stat_date]),
      ),
  );
}

/** 一次解释来源回执，执行层与模型投影共用同一组机构、指标及期间。 */
export function sourceConditions(
  value: unknown,
  message?: AgentMessage,
): SourceConditions | undefined {
  const source = record(value);
  const legacy = ["metric_query_structured", "metric_read", "metric_ask"].includes(
    text(source.kind),
  );
  if (!legacy && !["analysis_evidence", "business_overview"].includes(text(source.kind)))
    return undefined;
  const runRef = text(source.run_ref),
    taskId = text(source.task_id);
  if (!runRef && !taskId) return undefined;
  const identity = runRef ? { run_ref: runRef } : { task_id: taskId, result_id: source.result_id };
  const empty: SourceConditions = {
    metric_dates: new Map(),
    reference: { ...identity, conditions_unconfirmed: true },
  };
  if (
    text(source.status).toLowerCase() !== "succeeded" ||
    (message?.role === "toolResult" && message.isError)
  )
    return empty;

  const receipt = legacy ? legacyReceipt(source, message) : source;
  const queryEvidence = record(receipt.query_evidence),
    dsl = record(queryEvidence.logical_dsl);
  const completeFacts =
    !legacy ||
    (Array.isArray(receipt.facts) &&
      receipt.fact_count === receipt.facts.length &&
      !receipt.facts_truncated &&
      !receipt.truncated &&
      !receipt.has_more);
  const facts = legacy ? (completeFacts ? rows(receipt.facts) : []) : currentFacts(source);
  const descriptors = rows(source.metric_descriptors);
  const orgs = legacy ? strings(dsl.orgs) : strings(source.org_codes);
  if (legacy && !orgs.length)
    orgs.push(...unique(facts.map((item) => text(item.org_code)).filter(Boolean)));
  const codes = legacy
    ? strings(dsl.metrics)
    : unique(
        [
          ...descriptors.map((item) => text(item.code)),
          ...facts.map((item) => text(item.metric_code)),
        ].filter(Boolean),
      );
  if (legacy && !codes.length)
    codes.push(...unique(facts.map((item) => text(item.metric_code)).filter(Boolean)));
  if (!orgs.length || !codes.length) return empty;

  const time = record(dsl.time),
    targets = strings(record(dsl.options).target_dates);
  const trend = rows(dsl.ops).some((item) => item.type === "trend");
  const queryDates = record(queryEvidence.query_dates ?? receipt.query_dates);
  const start = text(legacy ? time.start : source.requested_start);
  const end = text(legacy ? time.end : source.requested_end);
  const selection = legacy
    ? targets.length || start === end
      ? "exact"
      : trend
        ? "all_in_range"
        : "latest_in_range"
    : text(source.date_selection);
  const requested: QueryDate | undefined =
    isCalendarDate(start) && isCalendarDate(end) && start <= end
      ? {
          date_selection: selection,
          start,
          end,
          ...(targets.length && targets.every(isCalendarDate) ? { dates: targets } : {}),
        }
      : undefined;
  // 全局日期摘要无法证明多个目标都已取到数，只有单目标可兼容恢复。
  const uniform =
    codes.length === 1 &&
    orgs.length === 1 &&
    (legacy ? !completeFacts && queryDates.complete === true : !facts.length)
      ? exactDate(
          unique(
            strings(
              legacy ? queryDates.actual_dates : (source.actual_dates ?? [source.analysis_date]),
            ),
          ),
        )
      : undefined;

  const metricDates: QuerySourceContext["metric_dates"] = new Map();
  const observed = new Map<string, { metric_code: string; org_codes: string[]; dates: string[] }>();
  const periods = new Map<string, { metric_code: string; org_codes: string[]; time?: QueryDate }>();
  const factDates = new Map<string, Set<string>>();
  for (const fact of facts) {
    const metric = text(fact.metric_code),
      org = text(fact.org_code) || (orgs.length === 1 ? orgs[0] : "");
    const day = text(fact.date) || text(fact.stat_date);
    if (!metric || !org || !isCalendarDate(day)) continue;
    const key = JSON.stringify([metric, org]),
      days = factDates.get(key) ?? new Set<string>();
    days.add(day);
    factDates.set(key, days);
  }
  const datesByMetric = new Map<string, string[]>();
  for (const code of codes) {
    const byOrg = new Map<string, QueryDate | undefined>();
    for (const org of orgs) {
      const days = [...(factDates.get(JSON.stringify([code, org])) ?? [])].sort();
      const actual = exactDate(days) ?? uniform;
      const date = legacy
        ? trend || targets.length
          ? requested
          : (actual ?? requested)
        : rangeSelection(selection)
          ? requested
          : (actual ?? (start === end ? requested : undefined));
      byOrg.set(org, date);
      const periodKey = JSON.stringify([code, date]);
      const period = periods.get(periodKey) ?? {
        metric_code: code,
        org_codes: [],
        ...(date ? { time: date } : {}),
      };
      period.org_codes.push(org);
      periods.set(periodKey, period);
      const observedDays = days.length ? days : uniform?.start ? [uniform.start] : [];
      datesByMetric.set(code, unique([...(datesByMetric.get(code) ?? []), ...observedDays]).sort());
      if (!observedDays.length) continue;
      const key = JSON.stringify([code, observedDays]);
      const group = observed.get(key) ?? { metric_code: code, org_codes: [], dates: observedDays };
      group.org_codes.push(org);
      observed.set(key, group);
    }
    metricDates.set(code, byOrg);
  }
  const observedPeriods = [...observed.values()];
  const orgNames = strings(source.org_names),
    scope = record(record(source.inquiry_scope).scope);
  const organizations = orgs.slice(0, 100).map((code, index) => ({
    code,
    ...(!legacy
      ? {
          name: (
            orgNames[index] ?? text(facts.find((item) => item.org_code === code)?.org_name)
          ).slice(0, 240),
        }
      : {}),
  }));
  const metrics = codes.slice(0, 128).map((code) => {
    const descriptor = descriptors.find((item) => item.code === code);
    return {
      code,
      ...(!legacy
        ? {
            name: (
              text(descriptor?.name) ||
              text(facts.find((item) => item.metric_code === code)?.metric_name)
            ).slice(0, 240),
            ...(descriptor?.unit ? { unit: descriptor.unit } : {}),
            ...(descriptor?.value_basis ? { value_basis: descriptor.value_basis } : {}),
          }
        : {}),
      dates: (datesByMetric.get(code) ?? []).slice(0, 31),
    };
  });
  return {
    metric_dates: metricDates,
    range_selection: rangeSelection(
      legacy
        ? requested?.date_selection
        : (record(source.inquiry_date).date_selection ?? selection),
    ),
    reference: {
      ...identity,
      organizations,
      metrics,
      observed_periods: observedPeriods.slice(0, 128).map((group) => ({
        ...group,
        org_codes: group.org_codes.sort().slice(0, 100),
        dates: group.dates.slice(0, 31),
      })),
      query_periods: [...periods.values()]
        .slice(0, 128)
        .map((period) => ({ ...period, org_codes: period.org_codes.slice(0, 100) })),
      ...(periods.size > 128 ||
      [...periods.values()].some((period) => period.org_codes.length > 100)
        ? { query_periods_truncated: true }
        : {}),
      ...(observedPeriods.length > 128 ||
      observedPeriods.some((group) => group.org_codes.length > 100 || group.dates.length > 31)
        ? { observed_periods_truncated: true }
        : {}),
      ...(scope.kind === "authorized_cohort" && scope.cohort === "rural_commercial_banks"
        ? { organization_scope: { kind: scope.kind, cohort: scope.cohort } }
        : {}),
      ...(legacy
        ? {
            ...(Object.keys(time).length ? { time } : {}),
            ...(targets.length ? { target_dates: targets.slice(0, 31) } : {}),
            methods: rows(dsl.ops)
              .map((item) => item.type)
              .filter((type) => typeof type === "string"),
          }
        : {
            date_selection: source.date_selection,
            requested_start: source.requested_start,
            requested_end: source.requested_end,
            actual_dates: unique([...datesByMetric.values()].flat())
              .sort()
              .slice(0, 31),
            methods: rows(record(source.plan).steps).map((step) => ({
              method: step.method,
              comparisons: strings(step.comparisons),
            })),
          }),
      ...(!completeFacts && !uniform ? { actual_dates_unconfirmed: true } : {}),
      ...(orgs.length > organizations.length || codes.length > metrics.length
        ? { conditions_truncated: true }
        : {}),
    },
  };
}
