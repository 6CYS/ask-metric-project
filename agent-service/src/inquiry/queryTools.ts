import { createHash } from "node:crypto";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import type {
  AgentHarnessTool,
  AgentMessage,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";
import { businessEvidences, currentTurnEvidence, type EvidenceReference } from "../answerEvidence.js";
import {
  analysisCandidates,
  catalogBindingState,
  catalogBindingView,
  restoreAnalysisDiscovery,
} from "../analysis/bindings.js";
import type { AnalysisEvidence } from "../analysis/tools.js";
import type { AnalysisPlan } from "../analysis/contracts.js";
import type {
  FieldResolution,
  DateModelValue,
  ResolvedOrganizations,
  TimeAlternative,
} from "../business-context/types.js";
import { businessDate } from "../business-context/resolvers.js";
import { inquiryCatalogView, inquiryEvidenceView, inquiryMetadataBlockers, type InquiryMetadataBlocker } from "./view.js";
import { MAX_QUERY_METRICS, PLAN_METRIC_LIMIT } from "./limits.js";
import { isCalendarDate } from "../tools/shared.js";
import { currentTurnMessages } from "../tools/turnContract.js";
import type { InquiryAcceptedTarget } from "./admission.js";
import { availabilityScopeKey, reusableAvailability } from "./availabilityReuse.js";
import {
  inquiryTargetChangeSchema,
  inquiryDateCalendarSchema,
  currentInquiryTarget,
  inquiryTargetCoverage,
  inquirySourceContext,
  inquiryTargetHasAncestor,
  readInquiryTargetSnapshot,
  resolveInquiryTarget,
  InquiryTargetError,
  type InquiryTargetSnapshot,
} from "./target.js";
import {
  sourceConditions,
  uniformQueryDate,
  rangeSelection,
  type QueryDate,
  type QuerySourceContext,
} from "./sourceConditions.js";

const SEARCH_CONCURRENCY = 4;
const searchParameters = Type.Object(
  {
    keywords: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      minItems: 1,
      maxItems: PLAN_METRIC_LIMIT,
      description:
        "每项独立检索一个完整指标表达，将业务主体与所需口径放在同一项；多项用于不同指标或同一指标的完整替代表达，不是分词后的AND条件。",
    }),
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  },
  { additionalProperties: false },
);
const queryParameters = Type.Object(
  {
    target_change: Type.Optional(inquiryTargetChangeSchema),
    target_ref: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 300,
        description:
          "本轮参考资料中已接纳目标的targetRef；多个目标时必须明确选择，单个目标可省略。已确认指标、机构、期间由宿主绑定，不受其他参数改写。",
      }),
    ),
    independent: Type.Optional(
      Type.Boolean({
        description:
          "所有已接纳目标已完成本轮取数后，显式设为true进行其他独立补查；不能与target_ref同时填写。",
      }),
    ),
    purpose: Type.String({ minLength: 1, maxLength: 500 }),
    metric_refs: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: MAX_QUERY_METRICS,
      uniqueItems: true,
      description:
        "正式目录指标引用；同范围、同期间、同方法所需的指标合并提交，包括正式值、变化额和增幅。执行器按现有单步、单批容量拆分，同条件已完成来源可复用。",
    }),
    scope: Type.Optional(
      Type.Union([Type.Literal("all_banks"), Type.Literal("named")], {
        description:
          "本次取数的机构范围，省略时继承普通主目标；named配合org_names，可在主目标机构内选子集；all_banks为有权农商行集合。已接纳target_ref仍由宿主绑定。",
      }),
    ),
    org_names: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        maxItems: 100,
        uniqueItems: true,
        description:
          "scope=named时须填写非空的名称、目录别名或正式编码；all_banks省略或传空数组，不携带具体名单。结合本轮问题与已授权历史选择；首次未指定机构时用参考资料中的账号机构，真正延续原对象时沿用历史机构，已有信息无需用户重复说明。比较多家时保留全部目标。",
      }),
    ),
    date: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          "本次取数的统计期或latest；普通查询省略时继承主目标期间，填写时仅改变本次取数，不改变会话主目标。已接纳target_ref及页面选定期间仍由宿主绑定。旧无目标协议省略时沿用所选机构和指标已确认期间。",
      }),
    ),
    date_calendar: Type.Optional(inquiryDateCalendarSchema),
    method: Type.Union(
      [
        Type.Literal("observe"),
        Type.Literal("compare"),
        Type.Literal("trend"),
        Type.Literal("ranking"),
        Type.Literal("structure"),
      ],
      {
        description:
          "observe直接读取正式指标（含正式差额、增幅）；compare从同一指标的不同期间值计算变化，不能把变化额当作原指标的上期值；ranking对所选指标在机构间排序，不要求另找名称含排名的指标。",
      },
    ),
    comparisons: Type.Optional(
      Type.Array(Type.Union([Type.Literal("mom"), Type.Literal("yoy"), Type.Literal("ytd")]), {
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      }),
    ),
    top_n: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description:
          "排名数量；省略时返回本次授权机构范围内的完整排名，最多100家。用户只要求前/后若干名时明确填写。",
      }),
    ),
    position: Type.Optional(Type.Union([Type.Literal("top"), Type.Literal("bottom")])),
    relation_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);
type QueryInput = Static<typeof queryParameters>;
const availabilityParameters = Type.Object(
  {
    target_change: queryParameters.properties.target_change,
    target_ref: queryParameters.properties.target_ref,
    independent: queryParameters.properties.independent,
    metric_refs: queryParameters.properties.metric_refs,
    scope: queryParameters.properties.scope,
    org_names: queryParameters.properties.org_names,
    start: Type.Optional(
      Type.String({
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "限定日期覆盖区间时与end成对填写；都省略时查看所选指标和机构的全部已有日期。",
      }),
    ),
    end: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  },
  { additionalProperties: false },
);
const readParameters = Type.Object(
  {
    run_ref: Type.String({ minLength: 1, maxLength: 128 }),
    focus: Type.Optional(Type.Object({
      org_code: Type.String({ minLength: 1, maxLength: 200 }),
      metric_codes: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 4, uniqueItems: true }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false, description: "仅用于本轮主题投影省略的事实，指定一家机构和至多4个指标，按50行分页回读已有来源，不重新查询。" })),
  },
  { additionalProperties: false },
);
interface InquiryEvidence extends AnalysisEvidence {
  conversation_id: string;
  query_key?: string;
  resolved_query_key?: string;
  inquiry_date?: QueryDate;
  inquiry_scope?: ResolvedOrganizations;
  actual_dates?: string[];
  time_variants?: TimeAlternative[];
  inquiry_target?: {
    target_ref: string;
    source: InquiryAcceptedTarget["source"];
    metric_codes: string[];
    metric_refs: string[];
    organizations: ResolvedOrganizations;
    target_organizations?: ResolvedOrganizations;
    comparison_organizations?: ResolvedOrganizations;
    time?: QueryDate;
  };
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item)
    : [];

function error(
  code: string,
  message: string,
  resolution?: unknown,
  correctionFields?: readonly (keyof QueryInput | "start" | "end")[],
  validation?: { validation_stage?: string; target_ref?: string },
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code, message, ...(resolution ? { resolution } : {}) }),
      },
    ],
    details: {
      kind: "inquiry_query_error",
      status: "error",
      code,
      ...(resolution ? { resolution } : {}),
      ...(record(resolution).status ? { resolution_status: record(resolution).status } : {}),
      ...(correctionFields ? { correction_fields: correctionFields } : {}),
      ...validation,
    },
  };
}

function dateResolutionMessage(resolution: FieldResolution): string {
  switch (resolution.metadata?.reason) {
    case "unsupported_expression":
      return "日期表达暂不支持直接解析。保留期间原表达，按业务日期提供对应日历换算后重试；含义不明确时只澄清该期间，不能改查latest。";
    case "invalid_calendar":
      return "日期的日历值不合法，请核对并修正原日期；日期换算不能替代非法日历，不能改查latest。";
    case "incomplete_range":
      return "日期区间缺少边界，请从已有上下文补齐原期间，仍不明确时澄清缺失边界；不能用单个日期或latest代替原区间。";
    default:
      return "取数日期未确定，请按返回原因修正期间原表达或日历换算，不能改成默认最新。";
  }
}
function successful(value: unknown): value is InquiryEvidence {
  return (
    !!value &&
    typeof value === "object" &&
    (value as AnalysisEvidence).kind === "analysis_evidence" &&
    (value as AnalysisEvidence).status === "succeeded"
  );
}
async function laneEvidence(
  request: AskMetricRequestContext,
  messages?: AgentMessage[],
): Promise<InquiryEvidence[]> {
  const receipts = (messages ?? (await request.turnMessages?.()) ?? []).flatMap((message) =>
    message.role === "toolResult" && !message.isError
      ? [message.details as unknown, ...businessEvidences(message.details)]
      : [],
  );
  // k 引用只从当前分支真实工具回执恢复，不接受模型提交的历史或绑定表。
  restoreAnalysisDiscovery(request, receipts);
  return receipts
    .filter(successful)
    .filter((item, index, all) => all.findIndex((other) => other === item) === index);
}
function bindingSnapshot(request: AskMetricRequestContext) {
  return { binding_map: catalogBindingState(request), candidate_map: analysisCandidates(request) };
}

/** 失败仍保留正式目录身份，便于核对部分纠正；不把它转为成功取数证据。 */
function preserveFailureBindings(
  result: AgentToolResult<unknown>,
  request: AskMetricRequestContext,
) {
  return "isError" in result && result.isError === true
    ? { ...result, details: { ...record(result.details), ...bindingSnapshot(request) } }
    : result;
}

interface CatalogSearchPage {
  keyword: string;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  exact_refs: string[];
}

function catalogSearchPage(value: unknown): CatalogSearchPage | undefined {
  const data = record(value);
  const { keyword, page, page_size: pageSize, total, has_more: hasMore } = data;
  if (
    typeof keyword !== "string" ||
    typeof hasMore !== "boolean" ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    typeof pageSize !== "number" ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0
  )
    return undefined;
  return {
    keyword,
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    exact_refs: strings(data.exact_refs),
  };
}

/** 只采用本轮实际检索回执；旧轮次或缺少分页元数据不能成为停止依据。 */
function catalogSearchPages(messages: AgentMessage[]): CatalogSearchPage[] {
  return currentTurnMessages(messages).flatMap((message) => {
    if (message.role !== "toolResult" || message.toolName !== "metric_search" || message.isError)
      return [];
    const details = record(message.details);
    if (
      details.kind !== "analysis_catalog" ||
      details.status !== "succeeded" ||
      !Array.isArray(details.search_pages)
    )
      return [];
    return details.search_pages.flatMap((value: unknown) => {
      const page = catalogSearchPage(value);
      return page ? [page] : [];
    });
  });
}

function toolView(message: AgentMessage): Record<string, unknown> | undefined {
  if (message.role !== "toolResult" || message.content.length !== 1 || message.content[0]?.type !== "text") return;
  try {
    return record(JSON.parse(message.content[0].text));
  } catch {
    return;
  }
}

/** 复用已完成的原页，不用累计候选冒充该页，也不重新注册已签发的短引用。 */
function reusableCatalogPage(
  request: AskMetricRequestContext, messages: AgentMessage[], keyword: string, page: number, pageSize: number,
): Record<string, unknown> | undefined {
  const bindings = catalogBindingState(request);
  for (const message of currentTurnMessages(messages).reverse()) {
    if (message.role !== "toolResult" || message.toolName !== "metric_search" || message.isError) continue;
    const details = record(message.details);
    if (details.kind !== "analysis_catalog" || details.status !== "succeeded" ||
      details.execution_turn_id !== request.operationId) continue;
    const view = toolView(message);
    const original = records(view?.results).find(result => result.keyword === keyword &&
      result.page === page && result.page_size === pageSize && catalogSearchPage(result));
    if (!original || original.pagination_status === "exhausted") continue;
    const descriptors = records(view?.items);
    const items = Array.isArray(original.items) ? records(original.items) : records(original.matches).map(match => {
      const descriptor = descriptors.find(item => item.binding_ref === match.binding_ref);
      return descriptor ? { ...descriptor, ...match } : undefined;
    });
    if (items.some(item => !item)) return;
    const savedBindings = record(details.binding_map);
    if ([...items, ...records(original.related_metrics)].some(item => item && typeof item.binding_ref === "string" &&
      (savedBindings[item.binding_ref] !== savedBindings[`code:${String(item.code)}`] ||
        savedBindings[item.binding_ref] !== bindings[item.binding_ref] ||
        savedBindings[`code:${String(item.code)}`] !== bindings[`code:${String(item.code)}`]))) return;
    return { ...original, items, reused: true, no_new_evidence: true,
      reuse_notice: "该目录页已在本轮完整返回，本次复用原候选和分页信息，没有新增检索结果。已有适用候选可直接取数；缺失定义不会通过重读同页补齐。" };
  }
  return;
}
async function conversationId(request: AskMetricRequestContext, signal?: AbortSignal) {
  let conversation = await request.commands.getConversationId();
  if (!conversation) {
    conversation = (await request.backend.createAgentQueryContext(request.sessionId, { signal }))
      .conversation_id;
    await request.commands.setConversationId(conversation);
  }
  return conversation;
}
const rankingLimit = (input: QueryInput, orgs: ResolvedOrganizations) =>
  input.top_n ?? Math.min(orgs.codes.length, 100);
const STEP_METRIC_LIMIT = 12;
function chunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}
function queryIdentity(
  request: AskMetricRequestContext,
  refs: string[],
  orgs: ResolvedOrganizations,
  date: QueryDate,
  input: QueryInput,
) {
  // 目的说明不改变查询；集合排序后生成稳定键，后端仍校验真实请求与幂等键的一致性。
  return createHash("sha256")
    .update(
      JSON.stringify({
        actor: request.actor.id,
        session: request.sessionId,
        operation: request.operationId,
        ...(input.target_ref ? { target: input.target_ref } : {}),
        metrics: [...refs].sort(),
        orgs: [...orgs.codes].sort(),
        scope: orgs.scope ?? null,
        fingerprint: orgs.scope_fingerprint ?? null,
        date,
        method: input.method,
        comparisons: [...(input.comparisons ?? [])].sort(),
        position: input.method === "ranking" ? (input.position ?? "top") : null,
        top_n: input.method === "ranking" ? rankingLimit(input, orgs) : null,
        relation_id: input.relation_id ?? null,
      }),
    )
    .digest("hex");
}

function reusableMetadataBlockers(
  sources: EvidenceReference[], request: AskMetricRequestContext, refs: string[],
  orgs: ResolvedOrganizations, date: QueryDate, input: QueryInput,
): {sources: EvidenceReference[]; refs: string[]; blockers: Map<string, InquiryMetadataBlocker[]>} {
  const reusedSources: EvidenceReference[] = [], reusedRefs = new Set<string>();
  const blockers = new Map<string, InquiryMetadataBlocker[]>();
  for (const source of sources) {
    const evidence = source.evidence as InquiryEvidence, steps = evidence.plan?.steps;
    const first = steps?.[0];
    if (evidence.execution_turn_id !== request.operationId || !first) continue;
    // 只放宽方法身份；用户、轮次、目标、正式绑定版本及授权后机构期间仍须与原请求一致。
    const originalInput: QueryInput = {purpose: input.purpose, metric_refs: input.metric_refs, method: first.method,
      ...(input.target_ref ? {target_ref: input.target_ref} : {}),
      ...(first.comparisons ? {comparisons: first.comparisons} : {}),
      ...(first.position ? {position: first.position} : {}),
      ...(first.top_n !== undefined ? {top_n: first.top_n} : {}),
      ...(first.relation_id ? {relation_id: first.relation_id} : {})};
    if (steps.some(step => step.method !== first.method || JSON.stringify(step.comparisons) !== JSON.stringify(first.comparisons)
      || step.position !== first.position || step.top_n !== first.top_n || step.relation_id !== first.relation_id)) continue;
    const sourceRefs = [...new Set(steps.flatMap(step => step.metric_refs))];
    const key = queryIdentity(request, sourceRefs, orgs, date, originalInput);
    if (key !== evidence.query_key && key !== evidence.resolved_query_key) continue;
    const unavailable = inquiryMetadataBlockers({...evidence});
    const covered = refs.filter(ref => !reusedRefs.has(ref) && sourceRefs.includes(ref)
      && evidence.metric_descriptors.some(metric => metric.binding_ref === ref && unavailable.some(item => item.metric_code === metric.code)));
    if (!covered.length) continue;
    const codes = new Set(evidence.metric_descriptors.filter(metric => covered.includes(metric.binding_ref)).map(metric => metric.code));
    reusedSources.push(source);
    covered.forEach(ref => reusedRefs.add(ref));
    blockers.set(source.ref, unavailable.filter(item => codes.has(item.metric_code)));
  }
  return {sources: reusedSources, refs: [...reusedRefs], blockers};
}

function reusableObserveSubset(
  sources: EvidenceReference[],
  request: AskMetricRequestContext,
  refs: string[],
  orgs: ResolvedOrganizations,
  date: QueryDate,
  input: QueryInput,
): EvidenceReference | undefined {
  if (input.method !== "observe") return undefined;
  return sources.find(({ evidence: source }) => {
    const evidence = source as InquiryEvidence;
    const steps = evidence.plan?.steps;
    if (
      evidence.execution_turn_id !== request.operationId ||
      record(evidence).complete !== true ||
      !Array.isArray(steps) ||
      !steps.length ||
      steps.some((step) => record(step).method !== "observe")
    )
      return false;
    const sourceRefs = [...new Set(steps.flatMap((step) => strings(record(step).metric_refs)))];
    if (sourceRefs.length <= refs.length || refs.some((ref) => !sourceRefs.includes(ref)))
      return false;
    // 仅放宽指标集合，仍用原身份核对当前用户、轮次、目标、机构范围与期间。
    const sourceKey = queryIdentity(request, sourceRefs, orgs, date, input);
    return sourceKey === evidence.query_key || sourceKey === evidence.resolved_query_key;
  });
}

/** 主题已执行的普通观测（包括正常缺数）可覆盖后续局部补查；只收敛新主题路径。 */
function reusableTopicObservations(
  sources: EvidenceReference[], request: AskMetricRequestContext, refs: string[],
  orgs: ResolvedOrganizations, date: QueryDate, input: QueryInput,
): { sources: EvidenceReference[]; refs: string[] } | undefined {
  if (input.method !== "observe" || input.comparisons?.length || input.relation_id) return;
  const candidates = analysisCandidates(request);
  const bindings = catalogBindingState(request);
  const reusedSources: EvidenceReference[] = [], reusedRefs = new Set<string>();
  for (const source of sources) {
    const evidence = source.evidence as InquiryEvidence;
    const topic = record(record(evidence).topic_execution);
    if (evidence.execution_turn_id !== request.operationId || topic.completed !== true ||
      !orgs.codes.every(code => evidence.inquiry_scope?.codes.includes(code))) continue;
    const sameDate = JSON.stringify(evidence.inquiry_date) === JSON.stringify(date) ||
      date.date_selection === "latest_snapshot" && topic.requested_date === "latest" &&
      typeof topic.selected_date === "string" && evidence.inquiry_date?.start === topic.selected_date && evidence.inquiry_date.end === topic.selected_date;
    if (!sameDate) continue;
    const completed = new Set(strings(topic.completed_metric_codes));
    const sourceRefs = new Set((evidence.plan?.steps ?? []).flatMap(step => strings(record(step).metric_refs)));
    const covered = refs.filter(ref => !reusedRefs.has(ref) && sourceRefs.has(ref) && candidates.some(item => bindings[item.binding_ref] === ref && completed.has(item.code)));
    if (covered.length) { reusedSources.push(source); covered.forEach(ref => reusedRefs.add(ref)); }
  }
  return reusedSources.length ? { sources: reusedSources, refs: [...reusedRefs] } : undefined;
}

function dateValue(value: unknown): QueryDate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const time = value as {
    preset?: string;
    date_selection?: string;
    record_selection?: string;
    start?: string;
    end?: string;
    dates?: string[];
  };
  if (time.preset === "latest" || time.date_selection === "latest_snapshot")
    return { date_selection: "latest_snapshot", anchor_date: businessDate() };
  if (!time.start || !time.end) return undefined;
  return {
    date_selection:
      time.record_selection ??
      time.date_selection ??
      (time.start === time.end || time.dates ? "exact" : "available_in_range"),
    start: time.start,
    end: time.end,
    ...(time.dates ? { dates: time.dates } : {}),
  };
}
function resolvedTimeAlternative(
  resolution: FieldResolution,
  date: QueryDate | undefined,
): TimeAlternative | undefined {
  const alternative = resolution.alternative;
  // 备选只属于同次解析实际采用的期间，不能从查询结果或旧目标反推。
  if (
    resolution.status !== "resolved" ||
    !date ||
    JSON.stringify(date) !== JSON.stringify(dateValue(resolution.value)) ||
    !alternative ||
    typeof alternative.label !== "string" ||
    !alternative.label.trim() ||
    typeof alternative.start !== "string" ||
    typeof alternative.end !== "string" ||
    !isCalendarDate(alternative.start) ||
    !isCalendarDate(alternative.end) ||
    alternative.start > alternative.end
  )
    return undefined;
  return { label: alternative.label, start: alternative.start, end: alternative.end };
}
/** 按用户回合保留最近业务条件；旧查询缺少条件也是边界，不能穿透到更早分析。 */
function queryContexts(messages: AgentMessage[]) {
  let current: QuerySourceContext[] = [],
    previous: QuerySourceContext[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (current.length) previous = current;
      current = [];
      continue;
    }
    if (message.role !== "toolResult") continue;
    const entries = businessEvidences(message.details);
    const contexts = (entries.length ? entries : [message.details])
      .map((source) => sourceConditions(source, message))
      .filter((value): value is NonNullable<typeof value> => value !== undefined);
    current.push(...contexts);
  }
  return { current, previous };
}

function inheritedDates(
  contexts: ReturnType<typeof queryContexts>,
  metrics: Array<{ code: string; ref: string }>,
  orgCodes: string[],
  override?: { start: string; end: string },
) {
  const { current, previous } = contexts;
  const groups = new Map<string, { metric_refs: string[]; org_codes: string[]; date: QueryDate }>();
  const missing: Array<{ metric_ref: string; org_codes: string[] }> = [];
  for (const metric of metrics) {
    const byOrganization = new Map<string, QueryDate | undefined>();
    for (const source of [...previous, ...current])
      for (const [org, date] of source.metric_dates.get(metric.code) ?? [])
        byOrganization.set(
          org,
          override
            ? {
                ...override,
                date_selection:
                  override.start === override.end
                    ? "exact"
                    : (source.range_selection ?? "available_in_range"),
              }
            : date,
        );
    // 换到未查过的机构，只能沿用该指标唯一已确认的期间；不从其他指标或最后一笔查询猜日期。
    const uniqueDates = [
      ...new Map([...byOrganization.values()].map((date) => [JSON.stringify(date), date])).values(),
    ];
    const fallback =
      uniqueDates.length === 1
        ? uniqueDates[0]
        : override && !byOrganization.size
          ? dateValue(override)
          : undefined;
    const metricGroups = new Map<string, { org_codes: string[]; date: QueryDate }>();
    const unresolved: string[] = [];
    for (const org of orgCodes) {
      const date = byOrganization.has(org) ? byOrganization.get(org) : fallback;
      if (!date) {
        unresolved.push(org);
        continue;
      }
      const key = JSON.stringify(date),
        group = metricGroups.get(key) ?? { org_codes: [], date };
      group.org_codes.push(org);
      metricGroups.set(key, group);
    }
    if (unresolved.length) missing.push({ metric_ref: metric.ref, org_codes: unresolved });
    for (const value of metricGroups.values()) {
      value.org_codes.sort();
      const key = JSON.stringify(value),
        group = groups.get(key) ?? { metric_refs: [], ...value };
      group.metric_refs.push(metric.ref);
      groups.set(key, group);
    }
  }
  return { groups: [...groups.values()], missing };
}

async function queryOrganizations(
  input: Pick<QueryInput, "scope" | "org_names">,
  request: AskMetricRequestContext,
  signal?: AbortSignal,
  accepted?: ResolvedOrganizations,
): Promise<ResolvedOrganizations | ReturnType<typeof error>> {
  if (accepted) {
    const scope = accepted.scope;
    const resolved = scope
      ? await request.backend.resolveOrganizationScope(
          scope.kind === "authorized_cohort"
            ? { ...scope, sourceText: request.originalMessage }
            : {
                kind: "children_of",
                parentName: scope.parent_code,
                sourceText: request.originalMessage,
              },
          { signal },
        )
      : await request.backend.resolveBusinessField("organization", accepted.codes, { signal });
    const value = resolved.value as ResolvedOrganizations | undefined;
    if (resolved.status !== "resolved" || !value?.codes?.length)
      return error(
        "ANALYSIS_SCOPE_UNRESOLVED",
        "已确认的机构暂时无法核验，请按返回结果补齐条件，不能改用账号机构。",
        resolved,
      );
    if (
      !scope &&
      JSON.stringify([...value.codes].sort()) !== JSON.stringify([...accepted.codes].sort())
    )
      return error(
        "INQUIRY_TARGET_SCOPE_CHANGED",
        "机构解析结果与已确认目标不同，请重新确认机构，不能静默替换。",
      );
    return value;
  }
  // 模型负责结合问题和可信上下文选对象；执行层只解析显式选择，不从查询顺序猜业务焦点。
  if (
    (input.scope !== "named" && input.scope !== "all_banks") ||
    (input.scope === "named" && !input.org_names?.length) ||
    (input.scope === "all_banks" && input.org_names?.length)
  )
    return error(
      "ANALYSIS_SCOPE_INVALID",
      "请用named和org_names明确提交本次机构名称或编码，或用all_banks查询有权农商行集合。账号和历史机构已在参考资料中提供，请结合本轮问题选择，无需用户重复说明已有条件。",
    );
  const resolved =
    input.scope === "named"
      ? await request.backend.resolveBusinessField("organization", input.org_names!, { signal })
      : await request.backend.resolveOrganizationScope(
          {
            kind: "authorized_cohort",
            cohort: "rural_commercial_banks",
            sourceText: request.originalMessage,
          },
          { signal },
        );
  const value = resolved.value as ResolvedOrganizations | undefined;
  return resolved.status === "resolved" && value?.codes?.length
    ? value
    : error(
        "ANALYSIS_SCOPE_UNRESOLVED",
        "机构范围尚未唯一确定，请按返回候选修正或向用户确认。",
        resolved,
      );
}
function acceptedQueryTarget(
  request: AskMetricRequestContext,
  input: Pick<QueryInput, "target_ref" | "independent">,
  receipts: InquiryEvidence[],
  purpose: "query" | "availability" = "query",
): InquiryAcceptedTarget | ReturnType<typeof error> | undefined {
  const targets = request.inquiryAdmission?.targets ?? [];
  if (input.independent && input.target_ref)
    return error("INQUIRY_TARGET_INVALID", "独立补查不能同时指定已接纳目标。");
  if (input.independent) {
    const incomplete = targets.filter(
      (target) =>
        !target.metrics?.codes.length ||
        target.metrics.codes.some(
          (code) =>
            !receipts.some(
              (receipt) =>
                receipt.execution_turn_id === request.operationId &&
                receipt.inquiry_target?.target_ref === target.targetRef &&
                receipt.inquiry_target.metric_codes.includes(code),
            ),
        ),
    );
    return incomplete.length
      ? error("INQUIRY_TARGET_INCOMPLETE", "请先完成本轮已确认目标的取数，再开始独立补查。", {
          target_refs: incomplete.map((target) => target.targetRef),
        })
      : undefined;
  }
  if (!targets.length)
    return input.target_ref
      ? error("INQUIRY_TARGET_INVALID", "目标引用不属于本轮已接纳条件。")
      : undefined;
  const target = input.target_ref
    ? targets.find((item) => item.targetRef === input.target_ref)
    : targets.length === 1
      ? targets[0]
      : undefined;
  if (!target)
    return error(
      input.target_ref ? "INQUIRY_TARGET_INVALID" : "INQUIRY_TARGET_REQUIRED",
      "请从本轮已接纳目标中明确选择target_ref，不能自动合并不同目标。",
      { target_refs: targets.map((item) => item.targetRef) },
    );
  const needsTime = purpose === "query" && !request.timeOverride;
  const pending = target.pending.filter((item) => item.field !== "time" || needsTime);
  if (
    pending.length ||
    !target.metrics?.codes.length ||
    !target.organizations?.codes.length ||
    (needsTime && !dateValue(target.time))
  )
    return error(
      "INQUIRY_TARGET_UNRESOLVED",
      "已接纳目标仍有未确认或已拒绝的条件，请继续澄清，不能用模型猜测值或默认值取数。",
      { target_ref: target.targetRef, pending },
    );
  return target;
}

async function acceptedMetricRefs(
  request: AskMetricRequestContext,
  target: InquiryAcceptedTarget,
  signal?: AbortSignal,
) {
  const codes = [...target.metrics!.codes].sort();
  if (codes.length > MAX_QUERY_METRICS)
    return error(
      "INQUIRY_TARGET_METRIC_LIMIT",
      `同一目标最多查询${MAX_QUERY_METRICS}个指标，请明确拆分查询目标。`,
      {
        target_ref: target.targetRef,
      },
      ["target_ref"],
      { target_ref: target.targetRef },
    );
  const matches: Array<Record<string, unknown> | undefined> = [];
  // 旧目标可以包含100项，目录重绑定保持有限并发，不能一次发出全部请求。
  for (const group of chunks(codes, 8))
    matches.push(
      ...(await Promise.all(
        group.map(async (code) => {
          const catalog = await request.backend.analysisCatalog(code, 1, 30, { signal });
          const items = Array.isArray(catalog.items)
            ? catalog.items
                .map(record)
                .filter(
                  (item) =>
                    item.code === code &&
                    item.match_type !== "semantic" &&
                    typeof item.binding_ref === "string" &&
                    item.binding_ref.trim(),
                )
            : [];
          return items.length === 1 ? items[0] : undefined;
        }),
      )),
    );
  if (matches.some((item) => !item))
    return error(
      "INQUIRY_TARGET_METRIC_UNAVAILABLE",
      "已确认指标未取得当前正式目录引用，请核对目录状态，不能换用相似指标或旧绑定。",
      { target_ref: target.targetRef },
      ["target_ref"],
      { target_ref: target.targetRef },
    );
  catalogBindingView(request, { items: matches });
  return codes.map(
    (code) => analysisCandidates(request).find((item) => item.code === code)!.binding_ref,
  );
}
function reused(source: EvidenceReference, primary = false, requestedMetricCodes?: string[], metadataBlockers?: InquiryMetadataBlocker[]) {
  const topicCompleted = record(record(source.evidence).topic_execution).completed === true;
  const sourceMetricCodes = (source.evidence as AnalysisEvidence).metric_descriptors.map(
    (metric) => metric.code,
  );
  const reuse = {
    kind: "inquiry_query_reuse",
    status: "succeeded",
    reused: true,
    no_new_evidence: true,
    evidence_ref: source.ref,
    run_ref: (source.evidence as AnalysisEvidence).run_ref,
    ...(topicCompleted ? { topic_execution: record(record(source.evidence).topic_execution) } : {}),
    requested_metric_codes: requestedMetricCodes ?? sourceMetricCodes,
    source_metric_codes: sourceMetricCodes,
    ...(metadataBlockers?.length ? {metadata_blockers: metadataBlockers} : {}),
  };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          topicCompleted
            ? {
                ...reuse,
                notice:
                  "所需指标已包含在本轮已有来源中，本次未重新取数或返回新表体；使用前面的profiles及事实引用交付。仅省略的明细使用analysis_read的focus分页读取，重复无focus读取不会得到更多事实。",
              }
            : {
                ...inquiryEvidenceView({ ...source.evidence }, source.ref),
                ...reuse,
              },
        ),
      },
    ],
    details: {
      ...reuse,
      ...(primary
        ? { inquiry_primary_run_refs: [(source.evidence as AnalysisEvidence).run_ref] }
        : {}),
    },
  };
}

/** 声明与结果同回执提交；失败和缺数不撤回用户本轮已经改变的查询条件。 */
async function executeWithInquiryTarget(
  input: Pick<
    QueryInput,
    "target_change" | "independent" | "date" | "date_calendar" | "scope" | "org_names"
  >,
  request: AskMetricRequestContext,
  signal: AbortSignal | undefined,
  execute: (
    conditions?: Pick<InquiryTargetSnapshot, "organizations" | "time">,
    timeAlternative?: TimeAlternative,
  ) => Promise<AgentToolResult<unknown>>,
): Promise<AgentToolResult<unknown>> {
  if (input.date_calendar && !input.date && !request.timeOverride && !request.inquiryAdmission)
    return error(
      "ANALYSIS_DATE_UNRESOLVED",
      "日期换算须附带date原表达，不能独立改变取数期间。",
      undefined,
      ["date", "date_calendar"],
      { validation_stage: "query_date" },
    );
  if (!request.inquiryTargetContext || request.inquiryAdmission) return execute();
  const messages = (await request.turnMessages?.()) ?? [];
  const current = currentInquiryTarget(messages, request.operationId);
  if (input.independent) {
    if (input.target_change)
      return error("INQUIRY_TARGET_INVALID", "独立补查不能改变当前业务目标。");
    if (!current)
      return error("INQUIRY_TARGET_REQUIRED", "请先声明并查询本轮业务目标，再进行独立补查。");
    if (!inquiryTargetCoverage(messages, current).complete)
      return error(
        "INQUIRY_TARGET_INCOMPLETE",
        "本轮目标尚未完成取数；日期覆盖查询不能代替核心查询，正常缺数回执也须先取得。",
      );
    return execute();
  }
  let target: InquiryTargetSnapshot;
  let timeAlternative: TimeAlternative | undefined;
  const resolveTime = async (
    value: string,
    calendar?: DateModelValue,
    sourceQuestion = value,
  ): Promise<QueryDate> => {
    const resolution = await request.backend.resolveBusinessField(
      "date",
      [value],
      { signal },
      undefined,
      {
        business_date: businessDate(),
        source_question: sourceQuestion,
      },
      ...(calendar ? [calendar] : []),
    );
    const date = resolution.status === "resolved" ? dateValue(resolution.value) : undefined;
    if (!date)
      throw new InquiryTargetError(
        "ANALYSIS_DATE_UNRESOLVED",
        dateResolutionMessage(resolution),
        undefined,
        { ...resolution, expression: value },
      );
    timeAlternative = resolvedTimeAlternative(resolution, date);
    return date;
  };
  try {
    if (!input.target_change && !current)
      throw new InquiryTargetError(
        "INQUIRY_TARGET_REQUIRED",
        "本轮首次查询请通过target_change声明新目标、仅改变的字段或沿用目标；不要把历史来源清单当作当前目标。",
      );
    const change = input.target_change ?? { mode: "continue" as const, base_ref: current!.ref };
    const base = change.base_ref === current?.ref ? current : request.inquiryTargetContext.baseline;
    target = await resolveInquiryTarget(change, {
      ...(base ? { baseline: base } : {}),
      operationId: request.operationId,
      sourceQuestion: request.originalMessage || current?.sourceQuestion || "",
      ...(request.inquiryTargetContext.time_contract ? { timeContract: request.inquiryTargetContext.time_contract } : {}),
      resolveOrganizations: async (scope, names) => {
        const resolved = await queryOrganizations(
          { scope, ...(names ? { org_names: names } : {}) },
          request,
          signal,
        );
        if ("isError" in resolved)
          throw new InquiryTargetError(
            resolved.details.code,
            "目标机构未能唯一解析或当前不可访问，请核对目录候选。",
            undefined,
            resolved.details.resolution,
          );
        return resolved;
      },
      resolveTime: (value, calendar) => resolveTime(value, calendar, request.originalMessage || value),
    });
    if (request.timeOverride)
      target.time = dateValue({
        ...request.timeOverride,
        ...(request.timeOverride.start !== request.timeOverride.end &&
        rangeSelection(target.time.date_selection)
          ? { record_selection: target.time.date_selection }
          : {}),
      })!;
    if (current) {
      const identity = (value: InquiryTargetSnapshot) =>
        JSON.stringify({
          topic: value.topic,
          orgs: [...value.organizations.codes].sort(),
          scope: value.organizations.scope,
          time: value.time,
        });
      if (identity(current) !== identity(target))
        throw new InquiryTargetError(
          "INQUIRY_TARGET_CHANGED",
          "本轮主目标已声明；局部取数用scope/org_names/date，目标之外的参考机构用independent，不通过查询顺序改写主目标。",
        );
      target = { ...target, ...(current.parentRef ? { parentRef: current.parentRef } : {}) };
    }
  } catch (cause) {
    if (cause instanceof InquiryTargetError)
      return error(
        cause.code,
        cause.message,
        cause.resolution,
        cause.code === "ANALYSIS_DATE_UNRESOLVED"
          ? ["target_change"]
          : cause.validationStage ? [] : undefined,
        cause.code === "ANALYSIS_DATE_UNRESOLVED"
          ? { validation_stage: "target_date" }
          : cause.validationStage ? { validation_stage: cause.validationStage } : undefined,
      );
    throw cause;
  }
  let result: AgentToolResult<unknown>;
  try {
    // 主目标用于连续追问；本次取数可以聚焦其中的机构或另一个期间，不反写主目标。
    const organizations =
      input.scope !== undefined || input.org_names !== undefined
        ? await queryOrganizations(input, request, signal)
        : target.organizations;
    if ("isError" in organizations) {
      result = organizations;
    } else {
      if (organizations.codes.some((code) => !target.organizations.codes.includes(code)))
        throw new InquiryTargetError(
          "INQUIRY_TARGET_SCOPE_CHANGED",
          "本次机构超出主目标范围。用户改变对象时通过target_change替换或追加；仅作目标之外参考的取数使用independent。",
        );
      const time =
        input.date !== undefined && !request.timeOverride
          ? await resolveTime(input.date, input.date_calendar)
          : target.time;
      result = await execute(
        { organizations, time },
        request.timeOverride ? undefined : timeAlternative,
      );
    }
  } catch (cause) {
    if (cause instanceof InquiryTargetError) {
      result = error(
        cause.code,
        cause.message,
        cause.resolution,
        cause.code === "ANALYSIS_DATE_UNRESOLVED" ? ["date", "date_calendar"] : undefined,
        cause.code === "ANALYSIS_DATE_UNRESOLVED" ? { validation_stage: "query_date" } : undefined,
      );
    } else {
      if (
        !(cause instanceof BackendApiError) ||
        [401, 403].includes(cause.status) ||
        signal?.aborted
      )
        throw cause;
      result = error(cause.code ?? "INQUIRY_QUERY_FAILED", "查询暂未完成；已保留本轮查询条件。", {
        retryable: cause.status >= 500,
        http_status: cause.status,
      });
    }
  }
  return { ...result, details: { ...record(result.details), inquiry_target_snapshot: target } };
}

/** 只预览已有证据能证明的重复调查；未知条件继续交给正式工具解析和校验。 */
export function inquiryRepeatedInvestigation(
  tool: string,
  args: unknown,
  request: AskMetricRequestContext,
  messages: AgentMessage[],
): boolean {
  if (!request.inquiryTargetContext || request.inquiryAdmission || request.timeOverride) return false;
  const input = tool === "metric_query" && Check(queryParameters, args)
    ? args : tool === "metric_availability" && Check(availabilityParameters, args) ? args : undefined;
  if (!input || input.target_ref) return false;
  const current = currentTurnMessages(messages);
  const target = currentInquiryTarget(current, request.operationId);
  if (!target) return false;
  const change = input.target_change;
  if (change && (change.mode !== "continue" || change.base_ref !== target.ref || input.independent ||
    Object.keys(change).some(key => key !== "mode" && key !== "base_ref"))) return false;
  if (input.independent && !inquiryTargetCoverage(current, target).complete) return false;

  const orgs = target.organizations;
  if (input.scope !== undefined || input.org_names !== undefined) {
    // 精确目录名与编码可对应已有目标；未知别名、子集和集合范围仍须重新解析。
    if (input.scope !== "named" || !input.org_names || orgs.scope) return false;
    const selected = input.org_names.map(name => orgs.codes.find((code, index) => name === code || name === orgs.names[index]));
    if (selected.some(code => !code) || new Set(selected).size !== orgs.codes.length || selected.length !== orgs.codes.length) return false;
  } else if (input.independent) return false;

  const bindings = catalogBindingState(request), candidates = analysisCandidates(request);
  const selected = input.metric_refs.map(ref => {
    const binding = bindings[ref] ?? bindings[`code:${ref}`];
    const metric = candidates.find(candidate => bindings[candidate.binding_ref] === binding);
    return binding && metric ? {binding, code: metric.code} : undefined;
  });
  if (selected.some(item => !item) || new Set(selected.map(item => item?.binding)).size !== selected.length) return false;
  const refs = selected.map(item => item!.binding);
  const metricCodes = selected.map(item => item!.code);
  const receipts = current.filter(message => message.role === "toolResult").filter(message => !message.isError);

  if (tool === "metric_availability") {
    const availability = input as Static<typeof availabilityParameters>;
    const {start, end} = availability;
    if ((start !== undefined || end !== undefined) &&
      (!start || !end || !isCalendarDate(start) || !isCalendarDate(end) || start > end)) return false;
    const spec = {dimension: "dates" as const, org_codes: [...orgs.codes].sort(), metric_codes: metricCodes.sort(),
      ...(start && end ? {start, end} : {}), match: "any" as const, page: availability.page ?? 1, page_size: availability.page_size ?? 12};
    const scopeKey = availabilityScopeKey(request, refs, orgs);
    const previous = reusableAvailability(current, scopeKey, spec);
    if (!previous) return false;
    return receipts.some(message => {
      const details = record(message.details);
      return message.toolName === "metric_availability" && details.kind === "data_availability" &&
        details.status === "succeeded" && details.no_new_evidence === true &&
        details.availability_scope_key === scopeKey && details.availability_source_key === previous.sourceKey;
    });
  }

  const query = input as QueryInput;
  // 日期换算和方法前置条件的纠正不属于旧证据已覆盖的输入。
  if (query.date_calendar || query.method === "compare" && !query.comparisons?.length ||
    query.method === "structure" && (!query.relation_id || refs.length > STEP_METRIC_LIMIT)) return false;
  let date: QueryDate;
  if (!query.date) {
    if (input.independent) return false;
    date = target.time;
  } else if (isCalendarDate(query.date)) {
    date = {date_selection: "exact", start: query.date, end: query.date};
  } else return false;
  const sources = currentTurnEvidence(current.filter(message => message.role !== "toolResult" || !message.isError))
    .filter(source => successful(source.evidence));
  const reusable = reusableMetadataBlockers(sources, request, refs, orgs, date, query);
  if (reusable.refs.length !== refs.length) return false;
  return reusable.sources.every(source => {
    const blockers = reusable.blockers.get(source.ref) ?? [];
    return blockers.length > 0 && receipts.some(message => {
      if (message.toolName !== "metric_query") return false;
      const details = record(message.details);
      const results = details.kind === "semantic_results" ? records(details.results) : [details];
      return results.some(result => result.kind === "inquiry_query_reuse" && result.status === "succeeded" &&
        result.no_new_evidence === true && result.run_ref === record(source.evidence).run_ref &&
        blockers.every(blocker => strings(result.requested_metric_codes).includes(blocker.metric_code) &&
          records(result.metadata_blockers).some(previous => previous.metric_code === blocker.metric_code && previous.reason === blocker.reason)));
    });
  });
}

export function createInquiryQueryTools(): AgentHarnessTool<AskMetricRequestContext>[] {
  const search: AgentHarnessTool<AskMetricRequestContext, typeof searchParameters> = {
    name: "metric_search",
    label: "检索业务指标",
    parameters: searchParameters,
    description:
      "按业务目标检索正式指标，返回名称、定义、单位、可用方法与k引用。已有符合业务目标与口径的正式候选即可metric_query，无需翻完目录；exact仅表示名称、编码或别名匹配，不代表口径适用。同一对象存在不同业务口径且用户条件不足以区分时，使用已有候选澄清，不必穷尽目录；重复检索不会补全候选中缺失的定义。仅候选不足且has_more=true时继续分页，has_more=false时该关键词没有下一页；缺少其他目标指标时可另行检索。分页未完不能断言不存在。semantic_suggestions只有推荐含义，须再按名称或编码检索取得正式引用。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      context.abortSignal?.throwIfAborted();
      const messages = (await request.turnMessages?.()) ?? [];
      await laneEvidence(request, messages);
      const previousPages = catalogSearchPages(messages);
      const page = input.page ?? 1,
        pageSize = input.page_size ?? 12;
      const existingRefs = new Set<string>();
      const fetchPage = async (keyword: string) => {
        const result = {
          keyword,
          ...(await request.backend.analysisCatalog(keyword, page, pageSize, { signal: context.abortSignal })),
        };
        const returned = catalogSearchPage(result);
        return { ...result, ...(returned ? { next_page: returned.has_more ? returned.page + 1 : null } : {}) };
      };
      const searchKeyword = async (keyword: string) => {
        const previous = previousPages.filter((item) => item.keyword === keyword);
        const latest = previous.at(-1);
        previous.forEach((item) => item.exact_refs.forEach((ref) => existingRefs.add(ref)));
        const reused = reusableCatalogPage(request, messages, keyword, page, pageSize);
        if (reused) return reused;
        const endKnown =
          latest && previous.some((item) => !item.has_more && item.total === latest.total);
        // 总量与请求偏移量比较，允许换页大小后仍有数据的页；新回合重新检索。
        if (page > 1 && latest && endKnown && (page - 1) * pageSize >= latest.total) {
          return {
            keyword,
            page,
            page_size: pageSize,
            total: latest.total,
            has_more: false,
            next_page: null,
            pagination_status: "exhausted",
            items: [],
            notice:
              "该关键词已无后续页，本次未重复访问目录。请核对已有候选的定义、单位和方法后取数；不适用时换关键词，不再增加该关键词页码。",
          };
        }
        return fetchPage(keyword);
      };
      const results: Record<string, unknown>[] = [];
      // 业务批次可以包含多个所需指标，后端目录请求仍保持有限并发。
      const keywords = [...new Set(input.keywords.map((value) => value.trim()))];
      for (const group of chunks(keywords, SEARCH_CONCURRENCY)) {
        context.abortSignal?.throwIfAborted();
        results.push(...(await Promise.all(group.map(searchKeyword))));
      }
      context.abortSignal?.throwIfAborted();
      const boundResults = results.map(result => record(result).reused === true ? record(result) : record(catalogBindingView(request, result)));
      // 同批新关键词可能带来新版口径；登记完新结果后再核对复用页，避免并存新旧引用。
      for (const [index, result] of boundResults.entries()) {
        if (result.reused === true && typeof result.keyword === "string" &&
          !reusableCatalogPage(request, messages, result.keyword, page, pageSize))
          boundResults[index] = record(catalogBindingView(request, await fetchPage(result.keyword)));
      }
      context.abortSignal?.throwIfAborted();
      const reused = boundResults.every(result => result.reused === true);
      const view: Record<string, unknown> = {
        results: boundResults,
        ...(reused ? { reused: true, no_new_evidence: true } : {}),
      };
      const searchPages = (Array.isArray(view.results) ? view.results : []).flatMap(
        (value: unknown) => {
          const result = record(value),
            page = catalogSearchPage(result);
          if (!page || result.pagination_status === "exhausted") return [];
          return [
            {
              ...page,
              exact_refs: (Array.isArray(result.items) ? result.items : []).flatMap(
                (value: unknown) => {
                  const item = record(value);
                  return item.match_type === "exact" && typeof item.binding_ref === "string"
                    ? [item.binding_ref]
                    : [];
                },
              ),
            },
          ];
        },
      );
      // 已注册的短引用直接复用，不能再次当作后端签名注册，也不自动替用户选定指标。
      const returnedRefs = new Set(
        (Array.isArray(view.results) ? view.results : []).flatMap((value: unknown) => {
          const result = record(value);
          return (Array.isArray(result.items) ? result.items : []).map(
            (item: unknown) => record(item).binding_ref,
          );
        }),
      );
      const existingCandidates = analysisCandidates(request).filter(
        (item) => existingRefs.has(item.binding_ref) && !returnedRefs.has(item.binding_ref),
      );
      if (existingCandidates.length) view.existing_candidates = existingCandidates;
      return {
        content: [{ type: "text", text: JSON.stringify(inquiryCatalogView(view)) }],
        details: {
          kind: "analysis_catalog",
          status: "succeeded",
          execution_turn_id: request.operationId,
          ...(reused ? { reused: true, no_new_evidence: true } : {}),
          search_pages: searchPages,
          ...bindingSnapshot(request),
        },
      };
    },
  };
  const query: AgentHarnessTool<AskMetricRequestContext, typeof queryParameters> = {
    name: "metric_query",
    label: "查询指标数据",
    parameters: queryParameters,
    description:
      "使用metric_search或业务知识linked_catalog的正式binding_ref直接取数；按原问题选择指标和方法，可依据结果继续补查。参考资料有已接纳目标时，多目标须选target_ref、单目标可省略；宿主重新绑定已确认指标、机构和日期，模型参数不能覆盖。目标都已完成取数后可用independent=true独立补查。普通问数每轮首次调用通过target_change声明会话主目标；后续省略声明。scope/org_names/date只选择本次取数的机构和期间，省略时继承主目标；可选择主目标内的部分机构或其他期间，不改写主目标。主目标之外的参考机构使用independent=true，不携带target_change。旧无目标协议显式提交机构，date可指定期间，省略时按所选机构和指标沿用已确认期间；不同期间返回date_groups，按对应分组分别查询。正文机构以回执为准，不能把全省汇总、账号机构和用户指定机构互称别名。observe也适用于正式差额/同比指标直接取值；compare用于同指标基期计算。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      const result = await executeWithInquiryTarget(
        input,
        request,
        context.abortSignal,
        async (queryConditions, selectedTimeAlternative) => {
          const messages = (await request.turnMessages?.()) ?? [];
          const receipts = await laneEvidence(request, messages);
          const target = acceptedQueryTarget(request, input, receipts);
          if (target && "isError" in target) return target;
          if (target) {
            const metricRefs = await acceptedMetricRefs(request, target, context.abortSignal);
            if (!Array.isArray(metricRefs)) return metricRefs;
            input = { ...input, target_ref: target.targetRef, metric_refs: metricRefs };
            if (target.operation) {
              delete input.comparisons;
              delete input.relation_id;
              delete input.top_n;
              delete input.position;
              input = {
                ...input,
                method: target.operation.kind === "value" ? "observe" : "ranking",
                ...(target.operation.kind === "ranking"
                  ? { position: target.operation.position, top_n: target.operation.top_n }
                  : {}),
              };
              if (target.operation.kind === "rank_position" && !target.comparisonOrganizations)
                return error(
                  "INQUIRY_TARGET_UNRESOLVED",
                  "已确认排名目标缺少比较范围，不能改用默认机构集合。",
                );
            }
            if (target.comparisonOrganizations && input.method !== "ranking")
              return error(
                "INQUIRY_TARGET_METHOD_REQUIRED",
                "该目标保存了机构排名比较范围，请使用ranking核对主目标在该范围内的位置，不能只查询主目标后标记完成。",
                { target_ref: target.targetRef, method: "ranking" },
              );
          }
          const bindings = catalogBindingState(request);
          const resolvedRefs = input.metric_refs.map(
            (ref) => bindings[ref] ?? bindings[`code:${ref}`],
          );
          const refs = resolvedRefs.filter((ref): ref is string => !!ref);
          if (refs.length !== resolvedRefs.length)
            return error(
              "ANALYSIS_BINDING_INVALID",
              "指标引用不属于当前目录回执，请先用metric_search检索。不能编造引用或直接传入签名。",
              undefined,
              ["metric_refs"],
              { validation_stage: "binding_resolution" },
            );
          if (new Set(refs).size !== refs.length)
            return error(
              "ANALYSIS_BINDING_INVALID",
              "同一批查询不要重复选择同一正式指标。",
              undefined,
              ["metric_refs"],
              { validation_stage: "binding_duplicates" },
            );
          if (input.method === "structure" && refs.length > STEP_METRIC_LIMIT)
            return error(
              "ANALYSIS_METHOD_BATCH_UNSUPPORTED",
              "结构分析需要完整审核关系，不能拆分关系中的指标执行。请明确可独立执行的查询目标。",
            );
          const metricCodes = new Set(
            analysisCandidates(request)
              .filter((item) => {
                const signed = bindings[item.binding_ref];
                return signed !== undefined && refs.includes(signed);
              })
              .map((item) => item.code),
          );
          const selectedMetrics = input.metric_refs.map((ref, index) => ({
            ref,
            code:
              analysisCandidates(request).find((item) => bindings[item.binding_ref] === refs[index])
                ?.code ?? "",
          }));
          if (input.method === "compare" && !input.comparisons?.length)
            return error(
              "ANALYSIS_METHOD_INVALID",
              "compare须提供comparisons：mom、yoy或ytd。直接读取正式比较指标时使用observe。",
              undefined,
              ["method", "comparisons"],
            );
          if (input.method === "structure" && !input.relation_id)
            return error(
              "ANALYSIS_METHOD_INVALID",
              "structure须使用目录返回的审核关系relation_id；没有关系时可先observe，不计算未经确认的占比。",
              undefined,
              ["method", "relation_id"],
            );
          const current = ((await request.answerEvidence?.()) ?? []).filter((item) =>
            successful(item.evidence),
          );
          const contexts = queryContexts(messages);
          const inherited = contexts.current[0] ?? contexts.previous.at(-1);
          const orgs =
            queryConditions?.organizations ??
            (await queryOrganizations(
              input,
              request,
              context.abortSignal,
              target?.comparisonOrganizations ?? target?.organizations,
            ));
          if ("isError" in orgs) return orgs;
          if (
            target?.comparisonOrganizations &&
            target.organizations?.codes.some((code) => !orgs.codes.includes(code))
          )
            return error(
              "INQUIRY_TARGET_SCOPE_CHANGED",
              "已确认比较范围不包含主目标机构，不能改变范围后计算名次。",
              { target_ref: target.targetRef },
            );
          if (target?.comparisonOrganizations)
            input = { ...input, top_n: Math.min(orgs.codes.length, 100), position: "top" };
          const firstQuery = !current.some(
            (item) => item.evidence.execution_turn_id === request.operationId,
          );
          let date: QueryDate | undefined;
          let timeAlternative = selectedTimeAlternative;
          if (queryConditions) {
            date = queryConditions.time;
          } else if (target) {
            date = request.timeOverride
              ? dateValue({
                  ...request.timeOverride,
                  ...(request.timeOverride.start !== request.timeOverride.end &&
                  rangeSelection(target.time?.record_selection)
                    ? { record_selection: target.time?.record_selection }
                    : {}),
                })
              : dateValue(target.time);
          } else if (request.timeOverride) {
            // 点击区间由宿主绑定，整轮都优先于模型和原文日期；只从可信历史保留区间记录选择。
            const dates = inheritedDates(
              contexts,
              selectedMetrics,
              orgs.codes,
              request.timeOverride,
            );
            if (dates.missing.length || dates.groups.length > 1)
              return error(
                "ANALYSIS_DATE_GROUPS_REQUIRED",
                "这些机构与指标原有的区间记录选择不同，请按返回分组分别查询，不能把全部日期改成区间最新一期。",
                {
                  unresolved_targets: dates.missing,
                  date_groups: dates.groups.map((group) => ({
                    metric_refs: group.metric_refs,
                    org_codes: group.org_codes,
                    date: `${group.date.start}至${group.date.end}`,
                    date_selection: group.date.date_selection,
                  })),
                },
              );
            date = dates.groups[0]?.date ?? dateValue(request.timeOverride);
          } else {
            const resolved = await request.backend.resolveBusinessField(
              "date",
              [input.date ?? "latest"],
              { signal: context.abortSignal },
              undefined,
              { business_date: businessDate(), source_question: request.originalMessage },
              ...(input.date_calendar ? [input.date_calendar] : []),
            );
            const calendar = record(resolved.metadata?.source_calendar);
            const ranges = Array.isArray(calendar.ranges)
              ? [
                  ...new Map(
                    calendar.ranges.map((range) => [JSON.stringify(dateValue(range)), range]),
                  ).values(),
                ]
              : [];
            const useOriginalPeriod = firstQuery || !input.date;
            if (
              useOriginalPeriod &&
              (strings(calendar.unresolved).length || (!input.date && ranges.length > 1))
            )
              return error(
                "ANALYSIS_DATE_UNRESOLVED",
                "原问题的日期尚未唯一确定，请按原文期间分批查询或补齐未决条件，不能改查最新日期。",
                resolved,
              );
            // 后续分批省略日期仍遵守原文明示期间；显式补查日期在目标执行后可单独选择。
            if (useOriginalPeriod && ranges.length === 1) date = dateValue(ranges[0]);
            else if (input.date)
              date = resolved.status === "resolved" ? dateValue(resolved.value) : undefined;
            if (!date && (input.date || (useOriginalPeriod && ranges.length)))
              return error(
                "ANALYSIS_DATE_UNRESOLVED",
                dateResolutionMessage(resolved),
                { ...resolved, expression: input.date },
                ["date", "date_calendar"],
                { validation_stage: "query_date" },
              );
            timeAlternative = resolvedTimeAlternative(resolved, date);
          }
          if (!date) {
            if (!inherited)
              date = { date_selection: "latest_snapshot", anchor_date: businessDate() };
            else {
              const dates = inheritedDates(contexts, selectedMetrics, orgs.codes);
              const dateGroups = dates.groups.map((group) => ({
                metric_refs: group.metric_refs,
                org_codes: group.org_codes,
                date:
                  group.date.start === group.date.end
                    ? group.date.start
                    : `${group.date.start}至${group.date.end}`,
              }));
              if (dates.missing.length)
                return error(
                  "ANALYSIS_CONTEXT_UNAVAILABLE",
                  "这些机构与指标没有唯一可继承的期间。请结合本轮问题和已有参考资料明确填写date（新问题可选latest），无需让用户重复已说明的条件。",
                  { unresolved_targets: dates.missing, date_groups: dateGroups },
                );
              if (dates.groups.length > 1)
                return error(
                  "ANALYSIS_DATE_GROUPS_REQUIRED",
                  "这些机构与指标的实际期间不同。可按date_groups的机构、指标和日期分批查询；需要同期间对比时，请结合问题明确选择共同date，不要静默合并。",
                  { date_groups: dateGroups },
                );
              date = dates.groups[0]?.date;
            }
          }
          if (!date)
            return error("ANALYSIS_DATE_AMBIGUOUS", "当前统计期间未确定，不能改为默认最新日期。");
          const topicReuse = reusableTopicObservations(current, request, refs, orgs, date, input);
          const metadataReuse = reusableMetadataBlockers(current, request, refs.filter(ref => !topicReuse?.refs.includes(ref)), orgs, date, input);
          const initialSources = [...new Set([...(topicReuse?.sources ?? []), ...metadataReuse.sources])];
          const batches = chunks(refs.filter(ref => !topicReuse?.refs.includes(ref) && !metadataReuse.refs.includes(ref)), PLAN_METRIC_LIMIT);
          if (!batches.length && initialSources.length === 1)
            return reused(initialSources[0]!, !input.independent, [...metricCodes], metadataReuse.blockers.get(initialSources[0]!.ref));
          const received: EvidenceReference[] = [...initialSources];
          const results: InquiryEvidence[] = [];
          let reusedSubset = false;
          let failure: Record<string, unknown> | undefined;
          const evidenceOffset = ((await request.answerEvidence?.()) ?? []).length;
          const ordinaryQuestion = target
            ? undefined
            : request.originalMessage || currentInquiryTarget(messages, request.operationId)?.sourceQuestion;
          const question = request.originalMessage || target?.sourceQuestion || ordinaryQuestion || input.purpose;
          // 同轮各批次回应同一个问题；局部取数目的只解释步骤，不重建业务要求。
          const requirementQuestion = target
            ? target.sourceQuestion || "查询已确认指标"
            : ordinaryQuestion || input.purpose;
          const purpose = requirementQuestion.slice(0, 500);
          for (const batch of batches) {
            const batchCodes = new Set(
              selectedMetrics
                .filter((_, index) => batch.includes(refs[index]!))
                .map((item) => item.code),
            );
            const queryKey = queryIdentity(request, batch, orgs, date, input);
            const existing = current.find((item) => {
              const evidence = item.evidence as InquiryEvidence;
              return evidence.query_key === queryKey || evidence.resolved_query_key === queryKey;
            });
            if (existing) {
              received.push(existing);
              continue;
            }
            const subset =
              batches.length === 1
                ? reusableObserveSubset(current, request, batch, orgs, date, input)
                : undefined;
            if (subset) {
              received.push(subset);
              reusedSubset = true;
              continue;
            }
            const plan: AnalysisPlan = {
              objective: purpose,
              scope_notice: "本次解析的机构和期间，实际覆盖见取数回执。",
              requirements: [{ id: "q1", question: requirementQuestion.slice(0, 8000) }],
              steps: chunks(batch, STEP_METRIC_LIMIT).map((step, index) => ({
                id: `s${index + 1}`,
                method: input.method,
                metric_refs: [...step].sort(),
                answers: ["q1"],
                rationale: input.purpose,
                ...(input.comparisons ? { comparisons: [...input.comparisons].sort() } : {}),
                ...(input.method === "ranking"
                  ? { position: input.position ?? "top", top_n: rankingLimit(input, orgs) }
                  : {}),
                ...(input.relation_id ? { relation_id: input.relation_id } : {}),
              })),
            };
            const executionKey = createHash("sha256")
              .update(JSON.stringify({ queryKey, purpose }))
              .digest("hex");
            try {
              const result = await request.backend.analysisExecute(
                {
                  plan,
                  execution_mode: "inquiry",
                  conversation_id: await conversationId(request, context.abortSignal),
                  ...date,
                  ...(orgs.scope
                    ? {
                        organization_scope: orgs.scope,
                        scope_fingerprint: orgs.scope_fingerprint,
                        org_codes: [],
                      }
                    : { org_codes: [...orgs.codes].sort() }),
                  calculation_context: {
                    scope_id: request.operationId,
                    user_question: question,
                  },
                },
                executionKey,
                { signal: context.abortSignal },
              );
              if (!successful(result) || !Array.isArray(result.evidence_items))
                throw new BackendApiError(
                  502,
                  "查询未返回完整证据回执。",
                  "ANALYSIS_EVIDENCE_INVALID",
                );
              // 后端返回的正式后续指标复用目录绑定，避免紧凑视图丢失可查询入口。
              catalogBindingView(request, result.followup_metrics);
              const details: InquiryEvidence = {
                ...result,
                execution_turn_id: request.operationId,
                query_key: queryKey,
                inquiry_date: date,
                inquiry_scope: orgs,
                ...(input.independent ? { inquiry_scope_role: "reference" } : {}),
                ...bindingSnapshot(request),
              };
              delete details.inquiry_target;
              if (target)
                details.inquiry_target = {
                  target_ref: target.targetRef,
                  source: structuredClone(target.source),
                  metric_codes: [...batchCodes],
                  metric_refs: [...batch],
                  organizations: orgs,
                  time: date,
                  ...(target.comparisonOrganizations
                    ? {
                        target_organizations: structuredClone(target.organizations!),
                        comparison_organizations: orgs,
                      }
                    : {}),
                };
              delete details.time_variants;
              if (timeAlternative) details.time_variants = [timeAlternative];
              const actualDate = uniformQueryDate(sourceConditions(details), batchCodes);
              if (
                !target &&
                date.date_selection === "latest_snapshot" &&
                actualDate?.date_selection === "exact"
              )
                // latest 请求身份保持稳定；旧协议沿用实际日时可命中同一运行的已解析身份。
                details.resolved_query_key = queryIdentity(request, batch, orgs, actualDate, input);
              received.push({ ref: `e${evidenceOffset + results.length + 1}`, evidence: details });
              results.push(details);
            } catch (cause) {
              if (
                batches.length === 1 && !initialSources.length ||
                context.abortSignal?.aborted ||
                (cause instanceof BackendApiError && [401, 403].includes(cause.status))
              )
                throw cause;
              if (!(cause instanceof BackendApiError))
                console.error(
                  JSON.stringify({
                    event: "inquiry_batch_failed",
                    request_id: request.requestId,
                    operation_id: request.operationId,
                    query_key: queryKey,
                    error: cause instanceof Error ? cause.name : "UnknownError",
                    ...(cause instanceof Error && cause.stack
                      ? { stack: cause.stack.split("\n").slice(1).join("\n") }
                      : {}),
                  }),
                );
              // 已完成批次必须随失败一起落入工具回执；后续调用只恢复剩余批次。
              failure = {
                kind: "analysis_evidence",
                status: "failed",
                execution_turn_id: request.operationId,
                error_code:
                  cause instanceof BackendApiError
                    ? (cause.code ?? "ANALYSIS_BATCH_FAILED")
                    : "ANALYSIS_BATCH_FAILED",
                retryable: cause instanceof BackendApiError && cause.status >= 500,
                ...(cause instanceof BackendApiError ? { http_status: cause.status } : {}),
                query_key: queryKey,
                requested_metric_codes: [...batchCodes],
                notice:
                  "本批查询未完成，已取得的其他批次证据保留。重试会复用已完成批次，不能将当前结果视为目标全部完成。",
              };
              break;
            }
          }
          if (batches.length === 1 && !initialSources.length) {
            if (!results.length)
              return reused(
                received[0]!,
                !input.independent,
                reusedSubset ? [...metricCodes] : undefined,
              );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(inquiryEvidenceView({ ...results[0]! }, received[0]!.ref)),
                },
              ],
              details: results[0]!,
            };
          }
          const completedCodes = new Set(
            received.flatMap((item) =>
              ((item.evidence as InquiryEvidence).metric_descriptors ?? [])
                .map((metric) => metric.code)
                .filter((code) => metricCodes.has(code)),
            ),
          );
          const progress = {
            target_ref: target?.targetRef,
            requested_metric_codes: [...metricCodes],
            completed_metric_codes: [...completedCodes],
            pending_metric_codes: [...metricCodes].filter((code) => !completedCodes.has(code)),
          };
          const status = failure ? (received.length ? "partial" : "failed") : "succeeded";
          const reuse =
            !results.length && !failure
              ? {
                  reused: true,
                  no_new_evidence: true,
                  evidence_refs: received.map((item) => item.ref),
                }
              : {};
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  kind: "semantic_results",
                  status,
                  ...reuse,
                  query_progress: progress,
                  results: [
                    ...received.map((item) => metadataReuse.blockers.has(item.ref)
                      ? {...inquiryEvidenceView({...item.evidence}, item.ref), kind: "inquiry_query_reuse", status: "succeeded",
                          no_new_evidence: true, metadata_blockers: metadataReuse.blockers.get(item.ref)}
                      : topicReuse?.sources.includes(item)
                      ? { kind: "inquiry_query_reuse", status: "succeeded", no_new_evidence: true, evidence_ref: item.ref,
                          run_ref: (item.evidence as AnalysisEvidence).run_ref, notice: "已完成部分沿用原引用，本次只查询剩余指标。" }
                      : inquiryEvidenceView({ ...item.evidence }, item.ref)),
                    ...(failure ? [failure] : []),
                  ],
                }),
              },
            ],
            details: {
              kind: "semantic_results",
              status,
              ...reuse,
              ...(!input.independent
                ? {
                    inquiry_primary_run_refs: received.map(
                      (item) => (item.evidence as AnalysisEvidence).run_ref,
                    ),
                  }
                : {}),
              query_progress: progress,
              results: [...results, ...(failure ? [failure] : [])],
            },
          };
        },
      );
      return preserveFailureBindings(result, request);
    },
  };
  const availability: AgentHarnessTool<AskMetricRequestContext, typeof availabilityParameters> = {
    name: "metric_availability",
    label: "查看指标数据日期",
    parameters: availabilityParameters,
    description:
      "指定日期没有数据或需要确认哪天有记录时，用正式k引用查看日期覆盖。target_change、target_ref与independent边界同metric_query：已接纳目标的指标与机构由宿主绑定，覆盖查询本身不算目标已完成取数。默认不填start/end，返回所选指标与授权机构的全部已有日期范围、最早/最新日期及分页。仅查特定区间时成对填写start/end，局部区间为空不能推断整体没有数据。覆盖查询不改变原问数日期，发现其他日期不能静默替换用户条件。有记录不等于数值有效或连续覆盖。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      context.abortSignal?.throwIfAborted();
      const result = await executeWithInquiryTarget(
        input,
        request,
        context.abortSignal,
        async (queryConditions) => {
          const receipts = await laneEvidence(request);
          const target = acceptedQueryTarget(request, input, receipts, "availability");
          if (target && "isError" in target) return target;
          if (target) {
            const metricRefs = await acceptedMetricRefs(request, target, context.abortSignal);
            if (!Array.isArray(metricRefs)) return metricRefs;
            input = { ...input, target_ref: target.targetRef, metric_refs: metricRefs };
          }
          const bindings = catalogBindingState(request),
            candidates = analysisCandidates(request);
          const selected = input.metric_refs.map((ref) => ({
            ref,
            signature: bindings[ref] ?? bindings[`code:${ref}`],
          }));
          const metrics = selected.map((item) => ({
            ref: item.ref,
            code: item.signature
              ? candidates.find((candidate) => bindings[candidate.binding_ref] === item.signature)
                  ?.code
              : undefined,
          }));
          if (
            metrics.some((item) => !item.code) ||
            new Set(metrics.map((item) => item.code)).size !== metrics.length
          )
            return error(
              "ANALYSIS_BINDING_INVALID",
              "请使用metric_search返回的非重复正式指标引用，不能编造编码或签名。",
              undefined,
              ["metric_refs"],
              {
                validation_stage: metrics.some((item) => !item.code)
                  ? "binding_resolution"
                  : "binding_duplicates",
              },
            );
          const orgs =
            queryConditions?.organizations ??
            (await queryOrganizations(
              input,
              request,
              context.abortSignal,
              target?.comparisonOrganizations ?? target?.organizations,
            ));
          if ("isError" in orgs) return orgs;
          const { start, end } = input;
          if (
            (start !== undefined || end !== undefined) &&
            (!start || !end || !isCalendarDate(start) || !isCalendarDate(end) || start > end)
          )
            return error(
              "AVAILABILITY_DATE_REQUIRED",
              "限定覆盖区间时请成对填写有效start/end；查看该指标和机构的全部已有日期时都省略，不必猜测日期范围。",
              undefined,
              ["start", "end"],
            );
          const spec = {
            dimension: "dates" as const,
            org_codes: [...orgs.codes].sort(),
            metric_codes: metrics.map((item) => item.code!).sort(),
            ...(start && end ? { start, end } : {}),
            match: "any" as const,
            page: input.page ?? 1,
            page_size: input.page_size ?? 12,
          };
          const availabilityKey = createHash("sha256").update(JSON.stringify({
            actor: request.actor.id, session: request.sessionId, operation: request.operationId,
            target: input.target_ref ?? null, spec,
            bindings: selected.map(item => item.signature).sort(),
            scope: orgs.scope ?? null, fingerprint: orgs.scope_fingerprint ?? null,
          })).digest("hex");
          const scopeKey = availabilityScopeKey(request, selected.map(item => item.signature!), orgs, input.target_ref);
          const messages = (await request.turnMessages?.()) ?? [];
          // 机构与正式指标仍先核验；旧回执只走精确条件复用，完整新回执才可推导子区间。
          const previous = currentTurnMessages(messages).reverse().find(message =>
            message.role === "toolResult" && message.toolName === "metric_availability" && !message.isError &&
            record(message.details).kind === "data_availability" && record(message.details).status === "succeeded" &&
            record(message.details).availability_key === availabilityKey);
          const previousView = previous && toolView(previous);
          context.abortSignal?.throwIfAborted();
          if (previous?.role === "toolResult" && previousView) {
            const reuse = { reused: true, no_new_evidence: true };
            return {
              content: [{ type: "text", text: JSON.stringify({ ...previousView, ...reuse,
                reuse_notice: "该机构、指标、日期范围和页码已在本轮查询，本次复用原日期证据，没有新增记录；有日期记录仍不代表指标数值有效。" }) }],
              details: { ...record(previous.details), ...reuse, availability_scope_key: scopeKey,
                availability_source_key: record(previous.details).availability_source_key ?? availabilityKey,
                execution_turn_id: request.operationId, request: spec },
            };
          }
          const reused = reusableAvailability(messages, scopeKey, spec);
          const result = reused?.result ?? await request.backend.dataAvailability(spec, {
            signal: context.abortSignal,
          });
          if (result.status !== "succeeded")
            throw new BackendApiError(
              502,
              "日期覆盖未返回完整回执。",
              "AVAILABILITY_EVIDENCE_INVALID",
            );
          // 模型只需日期覆盖；完整机构条件仍保留在回执中，供权限核验和历史审计。
          const view = {
            status: result.status,
            metric_names: result.metric_names,
            org_count: result.org_count,
            request: { start: start ?? null, end: end ?? null, match: spec.match },
            groups: result.groups.map((group) => ({
              date_count: group.date_count,
              earliest: group.earliest,
              latest: group.latest,
              dates: group.dates,
              has_more: group.has_more,
            })),
            page: result.page,
            page_size: result.page_size,
            notice: result.notice,
            ...(reused ? {reused: true, no_new_evidence: true,
              reuse_notice: "本次日期范围已包含在本轮完整覆盖证据中，按本次范围和页码筛选已有日期，没有新增记录；有日期记录仍不代表指标数值有效。"} : {}),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(view) }],
            details: {
              kind: "data_availability",
              ...result,
              availability_key: availabilityKey,
              availability_scope_key: scopeKey,
              ...(reused ? {reused: true, no_new_evidence: true, availability_source_key: reused.sourceKey} : {}),
              execution_turn_id: request.operationId,
              request: spec,
              ...(target
                ? {
                    inquiry_target: {
                      target_ref: target.targetRef,
                      source: structuredClone(target.source),
                      metric_codes: metrics.map((item) => item.code!),
                      organizations: orgs,
                      time: request.timeOverride ?? structuredClone(target.time),
                    },
                  }
                : {}),
            },
          };
        },
      );
      return preserveFailureBindings(result, request);
    },
  };
  const read: AgentHarnessTool<AskMetricRequestContext, typeof readParameters> = {
    name: "analysis_read",
    label: "读取已有查询结果",
    parameters: readParameters,
    description:
      "读取当前会话分支中真实出现过的run_ref，重新核验权限并返回本轮e引用。只讨论或画已有结果时使用，无需重新查询；不能读取另一会话或猜测run_ref。本轮主题省略的明细可用focus指定机构编码和指标编码分页读取，已展示事实直接复用。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      const runRef = String(input.run_ref);
      const messages = (await request.turnMessages?.()) ?? [];
      const source =
        (await laneEvidence(request, messages)).find((item) => item.run_ref === runRef) ??
        (await request.history.analysisSource?.(runRef));
      const conversation = await request.commands.getConversationId();
      if (!source || !conversation)
        return error(
          "ANALYSIS_RUN_NOT_FOUND",
          "当前会话分支没有该查询回执，不能读取其他会话结果。",
        );
      const result = await request.backend.analysisEvidence(runRef, conversation, {
        signal: context.abortSignal,
      });
      if (
        !successful(result) ||
        result.run_ref !== runRef ||
        result.conversation_id !== conversation
      )
        throw new BackendApiError(502, "历史查询回执身份不一致。", "ANALYSIS_EVIDENCE_INVALID");
      const current = (await request.answerEvidence?.()) ?? [];
      const existing = current.find(
        (item) => successful(item.evidence) && item.evidence.run_ref === runRef,
      );
      if (existing && input.focus) {
        if (record(record(existing.evidence).topic_execution).completed !== true)
          return error("TOPIC_READ_SOURCE_REQUIRED", "focus用于本轮已完成主题的省略明细；其他来源按原方式读取。");
        const focus = input.focus;
        const key = JSON.stringify([runRef, focus.org_code, [...focus.metric_codes].sort(), focus.offset ?? 0]);
        const messages = (await request.turnMessages?.()) ?? [];
        if (messages.some(message => message.role === "toolResult" && record(message.details).topic_slice_key === key))
          return reused(existing);
        const view = record(inquiryEvidenceView(record(existing.evidence), existing.ref));
        // 只补尚未展示的引用，focus不能变成重复注入完整主题的旁路。
        const shown = new Set<string>();
        const visit = (value: unknown) => {
          if (typeof value === "string") shown.add(value);
          else if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === "object") Object.values(value).forEach(visit);
        };
        for (const message of messages) if (message.role === "toolResult") for (const block of message.content) {
          if (block.type !== "text") continue;
          try { visit(JSON.parse(block.text)); } catch { /* 非JSON回执不提供主题事实。 */ }
        }
        const tables = records(view.tables).filter(table => focus.metric_codes.includes(String(table.metric_code)));
        const selected = tables.flatMap(table => (Array.isArray(table.rows) ? table.rows : [])
          .filter((row: unknown): row is string[] => Array.isArray(row) && row[1] === focus.org_code)
          .map(row => ({table, row})));
        const offset = focus.offset ?? 0;
        const page = selected.slice(offset, offset + 50).filter(item => !shown.has(String(item.row[0])));
        if (!page.length) return reused(existing);
        const body = {
          kind: "topic_evidence_slice", status: "succeeded", run_ref: runRef, evidence_ref: existing.ref,
          organizations: { [focus.org_code]: record(view.organizations)[focus.org_code] },
          tables: tables.flatMap(table => {
            const rows = page.filter(item => item.table === table).map(item => item.row);
            return rows.length ? [{...table, rows}] : [];
          }),
          unavailable_metrics: records(view.unavailable_metrics).filter(metric => focus.metric_codes.includes(String(metric.metric_code))),
          next_offset: offset + 50 < selected.length ? offset + 50 : null,
          notice: "来自同一已授权主题的省略明细；引用身份不变，无新增取数。",
        };
        if (Buffer.byteLength(JSON.stringify(body)) > 64000)
          return error("TOPIC_READ_BUDGET", "本页超过展示预算，请减少本次指标数；无需重新查询。");
        return { content: [{ type: "text", text: JSON.stringify(body) }], details: {
          kind: "inquiry_query_reuse", status: "succeeded", run_ref: runRef,
          no_new_evidence: true, topic_slice_key: key,
        } };
      }
      if (existing) return reused(existing);
      catalogBindingView(request, result.metric_descriptors);
      catalogBindingView(request, result.followup_metrics);
      const original = messages.find(message => message.role === "toolResult" &&
        businessEvidences(message.details).some(evidence => evidence === source));
      const provenance = inquirySourceContext(source, original?.role === "toolResult" ? original.details : undefined);
      const origin = provenance.inquiry_target_snapshot;
      const target = currentInquiryTarget(messages, request.operationId) ?? request.inquiryTargetContext?.baseline;
      const snapshots = messages.flatMap(message => {
        if (message.role !== "toolResult") return [];
        const snapshot = readInquiryTargetSnapshot(record(message.details).inquiry_target_snapshot);
        return snapshot ? [snapshot] : [];
      });
      const continues = origin && target && provenance.inquiry_scope_role !== "reference" &&
        origin.topic === target.topic &&
        (inquiryTargetHasAncestor(target, origin.ref, snapshots) ||
          await request.history.inquiryTargetAncestor?.(target, origin.ref));
      const details: InquiryEvidence = {
        ...result,
        execution_turn_id: source.execution_turn_id ?? source.scope_id,
        result_reused: true,
        ...bindingSnapshot(request),
      };
      // 后端只提供事实，目标关联只由宿主原回执及本轮父链证明；旧回读证明不跨轮继承。
      for (const key of ["inquiry_target_snapshot", "inquiry_reuse_target_ref", "inquiry_scope_role", "inquiry_date", "inquiry_scope"])
        delete (details as unknown as Record<string, unknown>)[key];
      Object.assign(details, provenance, continues ? {inquiry_reuse_target_ref: target.ref} : {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(inquiryEvidenceView({ ...details }, `e${current.length + 1}`)),
          },
        ],
        details,
      };
    },
  };
  return [search, query, availability, read];
}
