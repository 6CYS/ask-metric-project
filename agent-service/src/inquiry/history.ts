import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {businessEvidences} from "../answerEvidence.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import {safeWorkingHistory} from "../semantic-task/contextMemory.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(record) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const MAX_HISTORY_TURNS = 3;
const MAX_SOURCES_PER_TURN = 16;
const MAX_ANSWER_LENGTH = 6000;
const MAX_OBSERVED_PERIODS = 128;

/** 只投影条件，按相同日期合并机构；不把多机构日期压平成无法对应的两个集合。 */
function observedPeriods(facts: Row[], orgs: string[]) {
  const targets = new Map<string, {metric_code: string; org_code: string; dates: Set<string>}>();
  for (const fact of facts) {
    const metric = text(fact.metric_code), org = text(fact.org_code) || (orgs.length === 1 ? orgs[0]! : ""),
      date = text(fact.date) || text(fact.stat_date);
    if (!metric || !org || !date || !orgs.includes(org)) continue;
    const key = JSON.stringify([metric, org]), target = targets.get(key) ?? {metric_code: metric, org_code: org, dates: new Set<string>()};
    target.dates.add(date); targets.set(key, target);
  }
  const grouped = new Map<string, {metric_code: string; org_codes: string[]; dates: string[]}>();
  for (const target of targets.values()) {
    const dates = [...target.dates].sort(), key = JSON.stringify([target.metric_code, dates]);
    const group = grouped.get(key) ?? {metric_code: target.metric_code, org_codes: [], dates};
    group.org_codes.push(target.org_code); grouped.set(key, group);
  }
  const periods = [...grouped.values()];
  return {observed_periods: periods.slice(0, MAX_OBSERVED_PERIODS).map(group => ({...group,
    org_codes: group.org_codes.sort().slice(0, 100), dates: group.dates.slice(0, 31)})),
  ...(periods.length > MAX_OBSERVED_PERIODS || periods.some(group => group.org_codes.length > 100 || group.dates.length > 31)
    ? {observed_periods_truncated: true} : {})};
}

function turns(messages: readonly AgentMessage[]): AgentMessage[][] {
  const output: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") output.push([]);
    output.at(-1)?.push(message);
  }
  return output;
}

function legacyQueryContext(source: Row, message: AgentMessage): Row | undefined {
  if (source.kind !== "metric_query_structured" || message.role !== "toolResult" || !text(source.task_id)) return;
  const find = (value: unknown): Row | undefined => {
    if (Array.isArray(value)) return value.map(find).find(Boolean);
    if (!record(value)) return;
    if (value.task_id === source.task_id && (record(value.query_evidence) || Array.isArray(value.facts))) return value;
    return find(value.payloads) ?? find(value.results) ?? find(record(value.state) ? value.state.evidence : undefined);
  };
  let payload: Row | undefined;
  for (const block of message.content) {
    if (block.type !== "text") continue;
    try {payload = find(JSON.parse(block.text));} catch {continue;}
    if (payload) break;
  }
  if (!payload) return;
  const evidence = record(payload.query_evidence) ? payload.query_evidence : {};
  const dsl = record(evidence.logical_dsl) ? evidence.logical_dsl : {};
  const facts = rows(payload.facts), dates = record(evidence.query_dates) ? evidence.query_dates : {};
  const complete = payload.fact_count === facts.length && !payload.facts_truncated && !payload.truncated && !payload.has_more;
  // 兼容仅保存完整事实的旧回执；截断样例不能代表原机构或指标全集。
  const factConditions = complete && facts.length > 0 && facts.every(item => text(item.org_code) && text(item.metric_code));
  const orgs = strings(dsl.orgs).length ? strings(dsl.orgs)
    : factConditions ? [...new Set(facts.map(item => text(item.org_code)))] : [];
  const metrics = strings(dsl.metrics).length ? strings(dsl.metrics)
    : factConditions ? [...new Set(facts.map(item => text(item.metric_code)))] : [];
  if (!orgs.length || !metrics.length) return;
  const uniform = dates.complete === true && strings(dates.actual_dates).length === 1 ? strings(dates.actual_dates) : [];
  return {task_id: source.task_id, result_id: source.result_id,
    organizations: orgs.slice(0, 100).map(code => ({code})),
    ...observedPeriods(complete ? facts : [], orgs),
    metrics: metrics.slice(0, 100).map(code => ({code,
      dates: complete ? [...new Set(facts.filter(item => item.metric_code === code).map(item => text(item.date)).filter(Boolean))].sort().slice(0, 31) : uniform})),
    ...(record(dsl.time) ? {time: dsl.time} : {}),
    ...(record(dsl.options) && Array.isArray(dsl.options.target_dates) ? {target_dates: strings(dsl.options.target_dates).slice(0, 31)} : {}),
    methods: rows(dsl.ops).map(operation => operation.type).filter(type => typeof type === "string"),
    ...(!complete && !uniform.length ? {actual_dates_unconfirmed: true} : {}),
    ...(orgs.length > 100 || metrics.length > 100 ? {conditions_truncated: true} : {})};
}

/** 历史仅保留重查所需的身份和条件，不携带可误当成本轮引用的 eN 编号。 */
function sourceContext(source: Row, message: AgentMessage): Row | undefined {
  const runRef = text(source.run_ref), taskId = text(source.task_id);
  if (!runRef && !taskId) return;
  if (source.kind === "metric_query_structured") return legacyQueryContext(source, message)
    ?? {task_id: taskId, result_id: source.result_id, conditions_unconfirmed: true};
  const currentRows = rows(source.rows).filter(item => item.value_role === "分析时点");
  const currentKeys = new Set(currentRows.map(item => JSON.stringify([item.metric_name, item.org_name, item.stat_date])));
  const facts = [...rows(source.evidence_items).filter(item => item.type === "fact"), ...rows(source.facts), ...rows(source.rows)]
    .filter(item => !currentKeys.size || currentKeys.has(JSON.stringify([item.metric_name, item.org_name, item.date ?? item.stat_date])));
  const descriptors = rows(source.metric_descriptors);
  const codes = [...new Set([...descriptors.map(item => text(item.code)), ...facts.map(item => text(item.metric_code))].filter(Boolean))];
  const metrics = codes.slice(0, 128).map(code => {
    const descriptor = descriptors.find(item => item.code === code), values = facts.filter(item => item.metric_code === code);
    return {code, name: (text(descriptor?.name) || text(values[0]?.metric_name)).slice(0, 240),
      ...(descriptor?.unit ? {unit: descriptor.unit} : {}),
      ...(descriptor?.value_basis ? {value_basis: descriptor.value_basis} : {}),
      dates: [...new Set(values.map(item => text(item.date) || text(item.stat_date)).filter(Boolean))].sort().slice(0, 31)};
  });
  const orgCodes = strings(source.org_codes), orgNames = strings(source.org_names);
  const organizations = orgCodes.slice(0, 100).map((code, index) => ({code,
    name: (orgNames[index] ?? text(facts.find(item => item.org_code === code)?.org_name)).slice(0, 240)}));
  const steps = rows(record(source.plan) ? source.plan.steps : undefined).map(step => ({
    method: step.method, comparisons: strings(step.comparisons),
  }));
  const scope = record(source.inquiry_scope) ? source.inquiry_scope.scope : undefined;
  // 保留“有权农商行集合”的语义；下一次查询重新解析权限，不沿用历史集合签名。
  const organizationScope = record(scope) && scope.kind === "authorized_cohort" && scope.cohort === "rural_commercial_banks"
    ? {kind: scope.kind, cohort: scope.cohort} : undefined;
  return {...(runRef ? {run_ref: runRef} : {task_id: taskId, result_id: source.result_id}), organizations, metrics,
    ...observedPeriods(facts, orgCodes),
    ...(organizationScope ? {organization_scope: organizationScope} : {}),
    date_selection: source.date_selection, requested_start: source.requested_start, requested_end: source.requested_end,
    actual_dates: strings(source.actual_dates).slice(0, 31), methods: steps,
    ...(orgCodes.length > organizations.length || codes.length > metrics.length ? {conditions_truncated: true} : {})};
}

function historicalAnswer(messages: AgentMessage[]): string {
  if (messages.some(message => message.role === "toolResult" && message.details === undefined
    && message.content.some(block => block.type === "text" && block.text === "历史来源当前不可访问。")))
    return "此轮历史证据当前不可访问，不能据此复述数值或继承条件。";
  for (const message of [...messages].reverse()) {
    if (message.role === "toolResult" && !message.isError && record(message.details)) {
      const details = message.details;
      if (details.kind === "conversation_reply" && details.status === "answered" && text(details.answer)) return text(details.answer);
      if (details.kind === "runtime_delivery" && details.status === "delivered" && text(details.public_answer)) return text(details.public_answer);
      const answers = businessEvidences(details).filter(source => source.status === "succeeded" && text(source.public_answer));
      if (answers.length) return answers.map(source => source.public_answer).join("\n\n");
    }
  }
  return "上一轮未完成可交付的回答。";
}

function compactTurn(messages: AgentMessage[]): {messages: AgentMessage[]; reference?: Row} {
  const user = messages[0], assistant = [...messages].reverse().find(message => message.role === "assistant");
  if (!user || !assistant || assistant.role !== "assistant") return {messages: user ? [user] : []};
  const seen = new Set<string>();
  const sources = messages.flatMap(message => message.role === "toolResult" && !message.isError
    ? businessEvidences(message.details).map(source => ({source, message})) : [])
    .filter(({source}) => source.status === "succeeded")
    .flatMap(({source, message}) => {
      if (source.kind === "business_report") return [];
      const context = sourceContext(source as unknown as Row, message);
      if (!context) return [];
      const id = String(context.run_ref ?? context.task_id);
      if (seen.has(id)) return [];
      seen.add(id); return [context];
    });
  const body = historicalAnswer(messages);
  const content = body.length > MAX_ANSWER_LENGTH ? `${body.slice(0, MAX_ANSWER_LENGTH)}\n（历史正文后续部分省略。）` : body;
  const question = user.role === "user" ? typeof user.content === "string" ? user.content
    : user.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
  // 来源条件独立交给参考资料入口，不能伪装成助手已经向用户说过的正文。
  return {messages: [user, {...assistant, content: [{type: "text", text: content}], stopReason: "stop"}],
    ...(sources.length ? {reference: {question, sources: sources.slice(0, MAX_SOURCES_PER_TURN),
      ...(sources.length > MAX_SOURCES_PER_TURN ? {sources_truncated: true} : {})}} : {})};
}

/** 先核验最近回合的原始来源，再压缩已完成轮；本轮完整保留，历史目录大小不再决定是否失忆。 */
export async function prepareInquiryHistory(request: AskMetricRequestContext, messages: readonly AgentMessage[]) {
  const grouped = turns(messages), current = grouped.pop() ?? [];
  const selected = [...grouped.slice(-MAX_HISTORY_TURNS).flat(), ...current];
  const authorizedMessages = await safeWorkingHistory(request, selected);
  const checked = turns(authorizedMessages), active = checked.pop() ?? [];
  const history = checked.map(compactTurn);
  return {authorizedMessages, messages: [...history.flatMap(turn => turn.messages), ...active],
    referenceContext: history.flatMap(turn => turn.reference ? [turn.reference] : [])};
}
