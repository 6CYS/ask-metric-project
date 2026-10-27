import {createHash} from "node:crypto";
import {Type, type Static} from "@earendil-works/pi-ai";
import type {AgentHarnessTool, AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";
import {businessEvidences, type EvidenceReference} from "../answerEvidence.js";
import {analysisCandidates, catalogBindingState, catalogBindingView, restoreAnalysisDiscovery} from "../analysis/bindings.js";
import type {AnalysisEvidence} from "../analysis/tools.js";
import type {AnalysisPlan} from "../analysis/contracts.js";
import type {ResolvedOrganizations} from "../business-context/types.js";
import {businessDate} from "../business-context/resolvers.js";
import {inquiryCatalogView, inquiryEvidenceView} from "./view.js";
import {isCalendarDate} from "../tools/shared.js";

const searchParameters = Type.Object({
  keywords: Type.Array(Type.String({minLength: 1, maxLength: 200}), {minItems: 1, maxItems: 4}),
  page: Type.Optional(Type.Integer({minimum: 1, maximum: 1000})),
  page_size: Type.Optional(Type.Integer({minimum: 1, maximum: 30})),
}, {additionalProperties: false});
const queryParameters = Type.Object({
  purpose: Type.String({minLength: 1, maxLength: 500}),
  metric_refs: Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 8, uniqueItems: true}),
  scope: Type.Union([Type.Literal("all_banks"), Type.Literal("named")], {
    description: "named明确提交本次查询的机构；all_banks为有权农商行集合。工具不会自动选择账号或历史机构。",
  }),
  org_names: Type.Optional(Type.Array(Type.String({minLength: 1, maxLength: 200}), {
    minItems: 1, maxItems: 100, uniqueItems: true,
    description: "scope=named时必填名称、目录别名或正式编码。结合本轮问题与已授权历史选择；首次未指定机构时用参考资料中的账号机构，真正延续原对象时沿用历史机构，已有信息无需用户重复说明。比较多家时保留全部目标。",
  })),
  date: Type.Optional(Type.String({minLength: 1, maxLength: 200,
    description: "明确统计期或latest。省略仅沿用所选机构和指标已确认的期间；新指标请依据本轮问题选择日期，需要保持同期间时填写已有回执日期。首次无历史及原文期间时默认最新。"})),
  method: Type.Union([Type.Literal("observe"), Type.Literal("compare"), Type.Literal("trend"), Type.Literal("ranking"), Type.Literal("structure")]),
  comparisons: Type.Optional(Type.Array(Type.Union([Type.Literal("mom"), Type.Literal("yoy"), Type.Literal("ytd")]), {minItems: 1, maxItems: 3, uniqueItems: true})),
  top_n: Type.Optional(Type.Integer({minimum: 1, maximum: 100,
    description: "排名数量；省略时返回本次授权机构范围内的完整排名，最多100家。用户只要求前/后若干名时明确填写。"})),
  position: Type.Optional(Type.Union([Type.Literal("top"), Type.Literal("bottom")])),
  relation_id: Type.Optional(Type.String({minLength: 1, maxLength: 100})),
}, {additionalProperties: false});
type QueryInput = Static<typeof queryParameters>;
const availabilityParameters = Type.Object({
  metric_refs: queryParameters.properties.metric_refs,
  scope: queryParameters.properties.scope,
  org_names: queryParameters.properties.org_names,
  start: Type.Optional(Type.String({pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "限定日期覆盖区间时与end成对填写；都省略时查看所选指标和机构的全部已有日期。"})),
  end: Type.Optional(Type.String({pattern: "^\\d{4}-\\d{2}-\\d{2}$"})),
  page: Type.Optional(Type.Integer({minimum: 1, maximum: 1000})),
  page_size: Type.Optional(Type.Integer({minimum: 1, maximum: 30})),
}, {additionalProperties: false});
const readParameters = Type.Object({run_ref: Type.String({minLength: 1, maxLength: 128})}, {additionalProperties: false});
interface QueryDate {date_selection: string; start?: string; end?: string; dates?: string[]; anchor_date?: string}
interface InquiryEvidence extends AnalysisEvidence {
  conversation_id: string;
  query_key?: string;
  inquiry_date?: QueryDate;
  inquiry_scope?: ResolvedOrganizations;
  actual_dates?: string[];
}
interface QuerySourceContext {
  metric_dates: Map<string, Map<string, QueryDate | undefined>>;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];

function error(code: string, message: string, resolution?: unknown) {
  return {isError: true, content: [{type: "text" as const, text: JSON.stringify({code, message, ...(resolution ? {resolution} : {})})}],
    details: {kind: "inquiry_query_error", status: "error", code}};
}
function successful(value: unknown): value is InquiryEvidence {
  return !!value && typeof value === "object" && (value as AnalysisEvidence).kind === "analysis_evidence"
    && (value as AnalysisEvidence).status === "succeeded";
}
async function laneEvidence(request: AskMetricRequestContext): Promise<InquiryEvidence[]> {
  const receipts = (await request.turnMessages?.() ?? []).flatMap(message => message.role === "toolResult" && !message.isError
    ? [message.details, ...businessEvidences(message.details)] : []);
  // k 引用只从当前分支真实工具回执恢复，不接受模型提交的历史或绑定表。
  restoreAnalysisDiscovery(request, receipts);
  return receipts.filter(successful).filter((item, index, all) => all.findIndex(other => other === item) === index);
}
function bindingSnapshot(request: AskMetricRequestContext) {
  return {binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request)};
}
async function conversationId(request: AskMetricRequestContext, signal?: AbortSignal) {
  let conversation = await request.commands.getConversationId();
  if (!conversation) {
    conversation = (await request.backend.createAgentQueryContext(request.sessionId, {signal})).conversation_id;
    await request.commands.setConversationId(conversation);
  }
  return conversation;
}
const rankingLimit = (input: QueryInput, orgs: ResolvedOrganizations) => input.top_n ?? Math.min(orgs.codes.length, 100);
function queryIdentity(request: AskMetricRequestContext, refs: string[], orgs: ResolvedOrganizations,
  date: QueryDate, input: QueryInput) {
  // 目的说明不改变查询；集合排序后生成稳定键，后端仍校验真实请求与幂等键的一致性。
  return createHash("sha256").update(JSON.stringify({actor: request.actor.id, session: request.sessionId,
    operation: request.operationId, metrics: [...refs].sort(), orgs: [...orgs.codes].sort(),
    scope: orgs.scope ?? null, fingerprint: orgs.scope_fingerprint ?? null, date,
    method: input.method, comparisons: [...(input.comparisons ?? [])].sort(),
    position: input.method === "ranking" ? input.position ?? "top" : null,
    top_n: input.method === "ranking" ? rankingLimit(input, orgs) : null, relation_id: input.relation_id ?? null})).digest("hex");
}
function dateValue(value: unknown): QueryDate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const time = value as {date_selection?: string; record_selection?: string; start?: string; end?: string; dates?: string[]};
  if (time.date_selection === "latest_snapshot") return {date_selection: "latest_snapshot", anchor_date: businessDate()};
  if (!time.start || !time.end) return undefined;
  return {date_selection: time.record_selection ?? time.date_selection
    ?? (time.start === time.end || time.dates ? "exact" : "available_in_range"), start: time.start, end: time.end,
  ...(time.dates ? {dates: time.dates} : {})};
}
function inheritedDate(source: InquiryEvidence | undefined, codes: Set<string>, orgCode?: string): QueryDate | undefined {
  if (!source) return undefined;
  if (source.date_selection && !["latest_snapshot", "exact"].includes(source.date_selection)
    && source.requested_start && source.requested_end)
    return {date_selection: source.date_selection, start: source.requested_start, end: source.requested_end};
  const currentKeys = new Set((source.rows ?? []).flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const value = row as {value_role?: string; metric_name?: string; org_name?: string; stat_date?: string};
    return value.value_role === "分析时点" ? [JSON.stringify([value.metric_name, value.org_name, value.stat_date])] : [];
  }));
  const values = source.evidence_items?.filter(item => {
    const fact = item as typeof item & {org_name?: string};
    return ["fact", "value"].includes(item.type ?? "") && item.date
      && (!currentKeys.size || currentKeys.has(JSON.stringify([fact.metric_name, fact.org_name, fact.date])));
  }) ?? [];
  const selected = values.filter(item => (!codes.size || codes.has(item.metric_code ?? ""))
    && (!orgCode || item.org_code === orgCode || !item.org_code && source.org_codes.length === 1 && source.org_codes[0] === orgCode));
  const dates = [...new Set(selected.map(item => item.date!))];
  if (!values.length) dates.push(...(source.actual_dates ?? (source.analysis_date ? [source.analysis_date] : [])));
  // 单日查无数据仍确认了查询条件，不能把空结果误当成日期未确定。
  if (!dates.length && source.date_selection === "exact" && source.requested_start === source.requested_end
    && source.requested_start && isCalendarDate(source.requested_start))
    return {date_selection: "exact", start: source.requested_start, end: source.requested_start};
  const day = dates.length === 1 ? dates[0] : undefined;
  return day ? {date_selection: "exact", start: day, end: day} : undefined;
}

function analysisContext(source: InquiryEvidence): QuerySourceContext {
  const codes = new Set([...(source.metric_descriptors ?? []).map(item => item.code),
    ...(source.evidence_items ?? []).map(item => item.metric_code).filter((code): code is string => !!code)]);
  return {metric_dates: new Map([...codes].map(code => [code, new Map(source.org_codes.map(org =>
    [org, inheritedDate(source, new Set([code]), org)]))]))};
}

/** 旧普通查询只从正式DSL或完整事实恢复日期，不能从截断样例行猜测统计期。 */
function legacyContext(receipt: Record<string, unknown>): QuerySourceContext {
  const context: QuerySourceContext = {metric_dates: new Map()};
  if (String(receipt.status).toLowerCase() !== "succeeded") return context;
  const evidence = record(receipt.query_evidence), dsl = record(evidence.logical_dsl), time = record(dsl.time);
  const rawFacts = Array.isArray(receipt.facts) ? receipt.facts : undefined;
  const completeFacts = rawFacts !== undefined && receipt.fact_count === rawFacts.length
    && !receipt.facts_truncated && !receipt.truncated && !receipt.has_more;
  const facts = completeFacts ? rawFacts.map(record) : [];
  const codes = strings(dsl.metrics);
  if (!codes.length) codes.push(...new Set(facts.map(item => item.metric_code).filter((code): code is string => typeof code === "string" && !!code)));
  const orgs = strings(dsl.orgs);
  if (!orgs.length) orgs.push(...new Set(facts.map(item => item.org_code).filter((code): code is string => typeof code === "string" && !!code)));
  const exact = (days: string[]): QueryDate | undefined => {
    const day = days.length === 1 ? days[0] : undefined;
    return day && isCalendarDate(day) ? {date_selection: "exact", start: day, end: day} : undefined;
  };
  const queryDates = record(evidence.query_dates ?? receipt.query_dates);
  // 全局摘要仅能还原单目标旧回执；完整事实中缺失的目标没有已知实际日期。
  const uniform = !completeFacts && codes.length === 1 && orgs.length === 1 && queryDates.complete === true
    ? exact([...new Set(strings(queryDates.actual_dates))]) : undefined;
  const start = typeof time.start === "string" && isCalendarDate(time.start) ? time.start : undefined;
  const end = typeof time.end === "string" && isCalendarDate(time.end) ? time.end : undefined;
  const targets = strings(record(dsl.options).target_dates);
  const trend = Array.isArray(dsl.ops) && dsl.ops.some(item => record(item).type === "trend");
  const range: QueryDate | undefined = start && end && start <= end ? {
    date_selection: targets.length || start === end ? "exact" : trend ? "all_in_range" : "latest_in_range",
    start, end, ...(targets.length && targets.every(isCalendarDate) ? {dates: targets} : {}),
  } : undefined;
  // 寻找最新值的检索区间不是结果统计期；只有真实序列继续保留完整日期范围。
  const inherit = (actual: QueryDate | undefined) => trend || targets.length ? range : actual ?? range;
  for (const code of codes) {
    context.metric_dates.set(code, new Map(orgs.map(org => {
      const days = [...new Set(facts.filter(item => item.metric_code === code && (item.org_code === org
        || !item.org_code && orgs.length === 1)).map(item => item.date)
        .filter((day): day is string => typeof day === "string" && isCalendarDate(day)))];
      return [org, inherit(exact(days) ?? uniform)];
    })));
  }
  return context;
}

/** 按用户回合保留最近业务条件；旧查询缺少条件也是边界，不能穿透到更早分析。 */
function queryContexts(messages: AgentMessage[]) {
  let current: QuerySourceContext[] = [], previous: QuerySourceContext[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (current.length) previous = current;
      current = [];
      continue;
    }
    if (message.role !== "toolResult") continue;
    const details = record(message.details);
    const entries = businessEvidences(details);
    const analyses = entries.filter(successful);
    if (entries.some(item => item.kind === "analysis_evidence")) {
      current.push(...(!message.isError && analyses.length ? analyses.map(analysisContext) : [{metric_dates: new Map()}]));
      continue;
    }
    const legacy = entries.find(item => ["metric_query_structured", "metric_read", "metric_ask"].includes(item.kind));
    if (!legacy && !["metric_query_structured", "metric_read", "metric_ask"].includes(String(details.kind))) continue;
    let content: Record<string, unknown> = {};
    try { content = record(JSON.parse(message.content.filter(item => item.type === "text").map(item => item.text).join(""))); }
    catch { /* 旧版只有 details 时保留可验证条件；其余字段按缺失处理。 */ }
    if (content.task_id !== (legacy ?? details).task_id) content = {};
    current.push(message.isError ? {metric_dates: new Map()} : legacyContext({...content, ...record(legacy ?? details)}));
  }
  return {current, previous};
}

function inheritedDates(contexts: ReturnType<typeof queryContexts>, metrics: Array<{code: string; ref: string}>, orgCodes: string[]) {
  const {current, previous} = contexts;
  const groups = new Map<string, {metric_refs: string[]; org_codes: string[]; date: QueryDate}>();
  const missing: Array<{metric_ref: string; org_codes: string[]}> = [];
  for (const metric of metrics) {
    const byOrganization = new Map<string, QueryDate | undefined>();
    for (const source of [...previous, ...current])
      for (const [org, date] of source.metric_dates.get(metric.code) ?? []) byOrganization.set(org, date);
    // 换到未查过的机构，只能沿用该指标唯一已确认的期间；不从其他指标或最后一笔查询猜日期。
    const uniqueDates = [...new Map([...byOrganization.values()].map(date => [JSON.stringify(date), date])).values()];
    const fallback = uniqueDates.length === 1 ? uniqueDates[0] : undefined;
    const metricGroups = new Map<string, {org_codes: string[]; date: QueryDate}>();
    const unresolved: string[] = [];
    for (const org of orgCodes) {
      const date = byOrganization.has(org) ? byOrganization.get(org) : fallback;
      if (!date) {unresolved.push(org); continue;}
      const key = JSON.stringify(date), group = metricGroups.get(key) ?? {org_codes: [], date};
      group.org_codes.push(org); metricGroups.set(key, group);
    }
    if (unresolved.length) missing.push({metric_ref: metric.ref, org_codes: unresolved});
    for (const value of metricGroups.values()) {
      value.org_codes.sort();
      const key = JSON.stringify(value), group = groups.get(key) ?? {metric_refs: [], ...value};
      group.metric_refs.push(metric.ref); groups.set(key, group);
    }
  }
  return {groups: [...groups.values()], missing};
}

async function queryOrganizations(input: Pick<QueryInput, "scope" | "org_names">,
  request: AskMetricRequestContext, signal?: AbortSignal): Promise<ResolvedOrganizations | ReturnType<typeof error>> {
  // 模型负责结合问题和可信上下文选对象；执行层只解析显式选择，不从查询顺序猜业务焦点。
  if (input.scope !== "named" && input.scope !== "all_banks"
    || input.scope === "named" && !input.org_names?.length || input.scope === "all_banks" && input.org_names?.length)
    return error("ANALYSIS_SCOPE_INVALID", "请用named和org_names明确提交本次机构名称或编码，或用all_banks查询有权农商行集合。账号和历史机构已在参考资料中提供，请结合本轮问题选择，无需用户重复说明已有条件。");
  const resolved = input.scope === "named"
    ? await request.backend.resolveBusinessField("organization", input.org_names!, {signal})
    : await request.backend.resolveOrganizationScope({kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: request.originalMessage}, {signal});
  const value = resolved.value as ResolvedOrganizations | undefined;
  return resolved.status === "resolved" && value?.codes?.length ? value
    : error("ANALYSIS_SCOPE_UNRESOLVED", "机构范围尚未唯一确定，请按返回候选修正或向用户确认。", resolved);
}
function reused(source: EvidenceReference) {
  return {content: [{type: "text" as const, text: JSON.stringify(inquiryEvidenceView({...source.evidence}, source.ref))}],
    details: {kind: "inquiry_query_reuse", status: "succeeded", reused: true, evidence_ref: source.ref,
      run_ref: (source.evidence as AnalysisEvidence).run_ref}};
}

export function createInquiryQueryTools(): AgentHarnessTool<AskMetricRequestContext>[] {
  const search: AgentHarnessTool<AskMetricRequestContext, typeof searchParameters> = {
    name: "metric_search", label: "检索业务指标", parameters: searchParameters,
    description: "按业务目标检索正式指标，返回名称、定义、单位、可用方法与k引用。可合并相关关键词；分页未完不能断言不存在。semantic_suggestions只有推荐含义，须再按名称或编码检索取得正式引用。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      await laneEvidence(request);
      const results = await Promise.all([...new Set(input.keywords.map(value => value.trim()))].map(async keyword => ({keyword,
        ...await request.backend.analysisCatalog(keyword, input.page ?? 1, input.page_size ?? 12, {signal: context.abortSignal})})));
      const view = catalogBindingView(request, {results});
      return {content: [{type: "text", text: JSON.stringify(inquiryCatalogView(view))}],
        details: {kind: "analysis_catalog", status: "succeeded", ...bindingSnapshot(request)}};
    },
  };
  const query: AgentHarnessTool<AskMetricRequestContext, typeof queryParameters> = {
    name: "metric_query", label: "查询指标数据", parameters: queryParameters,
    description: "使用metric_search的k引用直接取数；按原问题选择指标和方法，可依据结果继续补查。每批用named及org_names明确机构，或用all_banks查询有权农商行集合；不按首批/末批查询自动选机构。正文机构以回执为准，不能把全省汇总、账号机构和用户指定机构互称别名。date省略时按机构和指标沿用已确认期间；不同期间返回date_groups，按对应机构、指标分批执行。同期间对比、新指标或改变日期时明确填写date，由后端解析，无需用户重复已有条件。observe也适用于正式差额/同比指标直接取值；compare用于同指标基期计算。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      await laneEvidence(request);
      const bindings = catalogBindingState(request);
      const resolvedRefs = input.metric_refs.map(ref => bindings[ref] ?? bindings[`code:${ref}`]);
      const refs = resolvedRefs.filter((ref): ref is string => !!ref);
      if (refs.length !== resolvedRefs.length) return error("ANALYSIS_BINDING_INVALID", "指标引用不属于当前目录回执，请先用metric_search检索。不能编造引用或直接传入签名。");
      if (new Set(refs).size !== refs.length) return error("ANALYSIS_BINDING_INVALID", "同一批查询不要重复选择同一正式指标。");
      const metricCodes = new Set(analysisCandidates(request).filter(item => {
        const signed = bindings[item.binding_ref];
        return signed !== undefined && refs.includes(signed);
      }).map(item => item.code));
      const selectedMetrics = input.metric_refs.map((ref, index) => ({ref, code: analysisCandidates(request)
        .find(item => bindings[item.binding_ref] === refs[index])?.code ?? ""}));
      if (input.method === "compare" && !input.comparisons?.length)
        return error("ANALYSIS_METHOD_INVALID", "compare须提供comparisons：mom、yoy或ytd。直接读取正式比较指标时使用observe。");
      if (input.method === "structure" && !input.relation_id)
        return error("ANALYSIS_METHOD_INVALID", "structure须使用目录返回的审核关系relation_id；没有关系时可先observe，不计算未经确认的占比。");
      const current = (await request.answerEvidence?.() ?? []).filter(item => successful(item.evidence));
      const contexts = queryContexts(await request.turnMessages?.() ?? []);
      const inherited = contexts.current[0] ?? contexts.previous.at(-1);
      const orgs = await queryOrganizations(input, request, context.abortSignal);
      if ("isError" in orgs) return orgs;
      const firstQuery = !current.some(item => item.evidence.execution_turn_id === request.operationId);
      let date: QueryDate | undefined;
      if (request.timeOverride && !input.date) date = dateValue(request.timeOverride);
      else {
        const resolved = await request.backend.resolveBusinessField("date", [input.date ?? "latest"], {signal: context.abortSignal}, undefined,
          {business_date: businessDate(), source_question: request.originalMessage});
        const calendar = record(resolved.metadata?.source_calendar);
        const ranges = Array.isArray(calendar.ranges) ? [...new Map(calendar.ranges
          .map(range => [JSON.stringify(dateValue(range)), range])).values()] : [];
        const useOriginalPeriod = firstQuery || !input.date;
        if (useOriginalPeriod && (strings(calendar.unresolved).length || !input.date && ranges.length > 1))
          return error("ANALYSIS_DATE_UNRESOLVED", "原问题的日期尚未唯一确定，请按原文期间分批查询或补齐未决条件，不能改查最新日期。", resolved);
        // 后续分批省略日期仍遵守原文明示期间；显式补查日期在目标执行后可单独选择。
        if (useOriginalPeriod && ranges.length === 1) date = dateValue(ranges[0]);
        else if (input.date) date = resolved.status === "resolved" ? dateValue(resolved.value) : undefined;
        if (!date && (input.date || useOriginalPeriod && ranges.length))
          return error("ANALYSIS_DATE_UNRESOLVED", "日期尚未确定，请按返回结果修正或确认日期。", resolved);
      }
      if (!date) {
        if (!inherited) date = {date_selection: "latest_snapshot", anchor_date: businessDate()};
        else {
          const dates = inheritedDates(contexts, selectedMetrics, orgs.codes);
          const dateGroups = dates.groups.map(group => ({metric_refs: group.metric_refs, org_codes: group.org_codes,
            date: group.date.start === group.date.end ? group.date.start : `${group.date.start}至${group.date.end}`}));
          if (dates.missing.length) return error("ANALYSIS_CONTEXT_UNAVAILABLE",
            "这些机构与指标没有唯一可继承的期间。请结合本轮问题和已有参考资料明确填写date（新问题可选latest），无需让用户重复已说明的条件。",
            {unresolved_targets: dates.missing, date_groups: dateGroups});
          if (dates.groups.length > 1) return error("ANALYSIS_DATE_GROUPS_REQUIRED",
            "这些机构与指标的实际期间不同。可按date_groups的机构、指标和日期分批查询；需要同期间对比时，请结合问题明确选择共同date，不要静默合并。",
            {date_groups: dateGroups});
          date = dates.groups[0]?.date;
        }
      }
      if (!date) return error("ANALYSIS_DATE_AMBIGUOUS", "当前统计期间未确定，不能改为默认最新日期。");
      const queryKey = queryIdentity(request, refs, orgs, date, input);
      const existing = current.find(item => (item.evidence as InquiryEvidence).query_key === queryKey);
      if (existing) return reused(existing);

      const plan: AnalysisPlan = {objective: input.purpose, scope_notice: "本次解析的机构和期间，实际覆盖见取数回执。",
        requirements: [{id: "q1", question: request.originalMessage}], steps: [{id: "s1", method: input.method,
          metric_refs: [...refs].sort(), answers: ["q1"], rationale: input.purpose,
          ...(input.comparisons ? {comparisons: [...input.comparisons].sort()} : {}),
          ...(input.method === "ranking" ? {position: input.position ?? "top", top_n: rankingLimit(input, orgs)} : {}),
          ...(input.relation_id ? {relation_id: input.relation_id} : {})}]};
      const executionKey = createHash("sha256").update(JSON.stringify({queryKey, purpose: input.purpose})).digest("hex");
      const result = await request.backend.analysisExecute({plan, execution_mode: "inquiry",
        conversation_id: await conversationId(request, context.abortSignal), ...date,
        ...(orgs.scope ? {organization_scope: orgs.scope, scope_fingerprint: orgs.scope_fingerprint, org_codes: []} : {org_codes: [...orgs.codes].sort()}),
        calculation_context: {scope_id: request.operationId, user_question: request.originalMessage}}, executionKey, {signal: context.abortSignal});
      if (!successful(result) || !Array.isArray(result.evidence_items)) throw new BackendApiError(502, "查询未返回完整证据回执。", "ANALYSIS_EVIDENCE_INVALID");
      const details: InquiryEvidence = {...result, execution_turn_id: request.operationId, query_key: queryKey,
        inquiry_date: date, inquiry_scope: orgs, ...bindingSnapshot(request)};
      const actualDate = inheritedDate(details, metricCodes);
      if (date.date_selection === "latest_snapshot" && actualDate?.date_selection === "exact")
        details.query_key = queryIdentity(request, refs, orgs, actualDate, input);
      const evidenceRef = `e${(await request.answerEvidence?.() ?? []).length + 1}`;
      return {content: [{type: "text", text: JSON.stringify(inquiryEvidenceView({...details}, evidenceRef))}], details};
    },
  };
  const availability: AgentHarnessTool<AskMetricRequestContext, typeof availabilityParameters> = {
    name: "metric_availability", label: "查看指标数据日期", parameters: availabilityParameters,
    description: "指定日期没有数据或需要确认哪天有记录时，用正式k引用查看日期覆盖。默认不填start/end，返回所选指标与授权机构的全部已有日期范围、最早/最新日期及分页。仅查特定区间时成对填写start/end，局部区间为空不能推断整体没有数据。机构规则同metric_query；覆盖查询不改变原问数日期，发现其他日期不能静默替换用户条件。有记录不等于数值有效或连续覆盖。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      await laneEvidence(request);
      const bindings = catalogBindingState(request), candidates = analysisCandidates(request);
      const selected = input.metric_refs.map(ref => ({ref, signature: bindings[ref] ?? bindings[`code:${ref}`]}));
      const metrics = selected.map(item => ({ref: item.ref, code: item.signature
        ? candidates.find(candidate => bindings[candidate.binding_ref] === item.signature)?.code : undefined}));
      if (metrics.some(item => !item.code) || new Set(metrics.map(item => item.code)).size !== metrics.length)
        return error("ANALYSIS_BINDING_INVALID", "请使用metric_search返回的非重复正式指标引用，不能编造编码或签名。");
      const orgs = await queryOrganizations(input, request, context.abortSignal);
      if ("isError" in orgs) return orgs;
      const {start, end} = input;
      if ((start !== undefined || end !== undefined) && (!start || !end || !isCalendarDate(start) || !isCalendarDate(end) || start > end))
        return error("AVAILABILITY_DATE_REQUIRED", "限定覆盖区间时请成对填写有效start/end；查看该指标和机构的全部已有日期时都省略，不必猜测日期范围。");
      const spec = {dimension: "dates" as const, org_codes: [...orgs.codes].sort(), metric_codes: metrics.map(item => item.code!).sort(),
        ...(start && end ? {start, end} : {}), match: "any" as const, page: input.page ?? 1, page_size: input.page_size ?? 12};
      const result = await request.backend.dataAvailability(spec, {signal: context.abortSignal});
      if (result.status !== "succeeded") throw new BackendApiError(502, "日期覆盖未返回完整回执。", "AVAILABILITY_EVIDENCE_INVALID");
      // 模型只需日期覆盖；完整机构条件仍保留在回执中，供权限核验和历史审计。
      const view = {status: result.status, metric_names: result.metric_names, org_count: result.org_count,
        request: {start: start ?? null, end: end ?? null, match: spec.match},
        groups: result.groups.map(group => ({date_count: group.date_count, earliest: group.earliest,
          latest: group.latest, dates: group.dates, has_more: group.has_more})),
        page: result.page, page_size: result.page_size, notice: result.notice};
      return {content: [{type: "text", text: JSON.stringify(view)}], details: {kind: "data_availability", ...result, request: spec}};
    },
  };
  const read: AgentHarnessTool<AskMetricRequestContext, typeof readParameters> = {
    name: "analysis_read", label: "读取已有查询结果", parameters: readParameters,
    description: "读取当前会话分支中真实出现过的run_ref，重新核验权限并返回本轮e引用。只讨论或画已有结果时使用，无需重新查询；不能读取另一会话或猜测run_ref。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      const runRef = String(input.run_ref);
      const source = (await laneEvidence(request)).find(item => item.run_ref === runRef)
        ?? await request.history.analysisSource?.(runRef);
      const conversation = await request.commands.getConversationId();
      if (!source || !conversation) return error("ANALYSIS_RUN_NOT_FOUND", "当前会话分支没有该查询回执，不能读取其他会话结果。");
      const result = await request.backend.analysisEvidence(runRef, conversation, {signal: context.abortSignal});
      if (!successful(result) || result.run_ref !== runRef || result.conversation_id !== conversation)
        throw new BackendApiError(502, "历史查询回执身份不一致。", "ANALYSIS_EVIDENCE_INVALID");
      const current = await request.answerEvidence?.() ?? [];
      const existing = current.find(item => successful(item.evidence) && item.evidence.run_ref === runRef);
      if (existing) return reused(existing);
      catalogBindingView(request, result.metric_descriptors);
      const details: InquiryEvidence = {...result, execution_turn_id: source.execution_turn_id ?? source.scope_id,
        result_reused: true, ...bindingSnapshot(request)};
      return {content: [{type: "text", text: JSON.stringify(inquiryEvidenceView({...details}, `e${current.length + 1}`))}], details};
    },
  };
  return [search, query, availability, read];
}
