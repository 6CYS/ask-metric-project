import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore, NativeBusinessResultStore} from "../../src/business-context/store.js";
import {NativeSemanticTaskStore} from "../../src/semantic-task/store.js";
import {MemoryCommandBridge, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient, BasicQuerySpec} from "../../src/backendClient.js";
import {BackendApiError} from "../../src/backendClient.js";
import type {MetricMention} from "../../src/business-context/metricMentions.js";
import type {SemanticRequest, SemanticOperation, SemanticSource} from "../../src/semantic-task/protocol.js";
import type {SemanticTransition, TransitionField} from "../../src/semantic-task/transition.js";

export const metricNames = {M1: "合成指标甲", M2: "合成指标乙", M3: "合成指标丙"};
export function proposal(operations: SemanticOperation[], source: SemanticSource = {kind: "new"}, intent: SemanticRequest["intent"] = "query"): SemanticRequest {
  return {protocol_version: 2, intent, targets: [{source, operations}]};
}
export const complete = (): SemanticOperation[] => [
  {action: "set", field: "organizations", value: "合成机构甲"},
  {action: "set", field: "metrics", value: "合成指标甲"},
  {action: "set", field: "time", value: "2025年末"},
];
export function syntheticBackend() {
  const resolveBusinessField = vi.fn(async (entity: string, raw: string[], _options?: unknown, _year?: number, source?: {source_question: string}) => {
    if (entity === "date") {
      if (raw[0]?.includes("无效")) return {status: "invalid", metadata: {reason: "unsupported_expression"}};
      if (raw[0]?.includes("近5年")) return {status: "ambiguous", candidates: [
        {value: "向前滚动5年（2021-10-14至2026-10-14）", metadata: {calendar: {start: "2021-10-14", end: "2026-10-14"}}},
        {value: "最近5个完整年度（2021-01-01至2025-12-31）", metadata: {calendar: {start: "2021-01-01", end: "2025-12-31"}}},
      ], metadata: {reason: "calendar_scope_ambiguous", businessDate: "2026-10-14"}};
      const day = raw[0]?.includes("2024") ? "2024-12-31" : raw[0]?.includes("3号") ? "2026-04-03" : "2025-12-31";
      const original = source?.source_question ?? raw[0] ?? "";
      const sourceDay = original.includes("2024") ? "2024-12-31" : original.includes("3号") ? "2026-04-03" : "2025-12-31";
      return {status: "resolved", value: {start: day, end: day}, metadata: {source_calendar: {ranges: [{start: sourceDay, end: sourceDay}], unresolved: []}}};
    }
    if (entity === "organization") {
      const codes = raw.flatMap(text => ["O1", "O2"].filter((code, index) => text === code || text.includes(index ? "合成机构乙" : "合成机构甲")));
      return {status: codes.length ? "resolved" : "not_found", value: {codes, names: codes.map(code => code === "O1" ? "合成机构甲" : "合成机构乙")},
        metadata: {source_codes: source ? ["O1", "O2"].filter((code, index) => source.source_question.includes(index ? "合成机构乙" : "合成机构甲")) : codes}};
    }
    if (raw.some(text => text === "存款记录")) return {status: "not_found"};
    if (raw.some(text => text === "待定指标")) return {status: "needs_confirmation", candidates: Object.entries(metricNames).map(([code, value]) => ({code, value}))};
    const codes = Object.entries(metricNames).filter(([code, name]) => raw.some(text => text === code || text.includes(name))).map(([code]) => code);
    return {status: codes.length ? "resolved" : "not_found", value: {codes, names: codes.map(code => metricNames[code as keyof typeof metricNames])}};
  });
  const matchMetricQuestion = vi.fn(async (question: string) => {
    const chars = Array.from(question), mentions: MetricMention[] = [];
    for (let start = 0; start < chars.length; start++) for (const [code, text] of Object.entries(metricNames)) {
      if (chars.slice(start, start + text.length).join("") !== text) continue;
      mentions.push({text, start, end: start + text.length, resolution: {status: "resolved", value: {codes: [code], names: [text]}}});
    }
    const pending = question.indexOf("待定指标");
    if (pending >= 0) mentions.push({text: "待定指标", start: pending, end: pending + 4,
      resolution: {status: "needs_confirmation", candidates: Object.entries(metricNames).map(([code, value]) => ({code, value}))}});
    return {mentions};
  });
  const basicQueries = vi.fn(async (_spec?: unknown, _key?: string) => ({result: {status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result",
    columns: [], rows: [], row_count: 0, truncated: false, message: "查询完成，无匹配数据。"}}));
  return {resolveBusinessField, matchMetricQuestion, basicQueries,
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "synthetic-conversation"})),
    getTask: vi.fn(async () => ({task_id: "synthetic-query", version: 1, status: "succeeded", result: {result_id: "synthetic-result"}})),
    getTaskResult: vi.fn(async () => ({status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result", columns: [], rows: [], row_count: 0, truncated: false})),
  };
}
export async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "semantic-task-"));
  const sessions = new NativeSessionStore(dir);
  const session = await sessions.create("user-1");
  const backend = syntheticBackend();
  const bridge = new MemoryCommandBridge();
  const request = (operationId = "operation-1", originalMessage = "查询合成机构甲2025年末的合成指标甲") => testRequestContext(backend as unknown as BackendClient, bridge,
    {sessionId: session.metadata.id, operationId, requestId: operationId, originalMessage, businessProtocol: "semantic_v2",
      frames: new NativeFrameStore(session), businessResults: new NativeBusinessResultStore(session), semanticTasks: new NativeSemanticTaskStore(session)});
  return {dir, sessions, session, backend, request, async close() {await sessions.close(); rmSync(dir, {recursive: true, force: true});}};
}

export function addPlanBackend(backend: ReturnType<typeof syntheticBackend>) {
  const receipts = new Map<string, BasicQuerySpec>();
  const inspectBusinessGoal = vi.fn(async (question: string) => {
    const fragments = await Promise.all(question.split(/[；;，,]/u).filter(Boolean).map(async part => ({question: part,
      organizations: ["O1", "O2"].filter((_, i) => part.includes(i ? "合成机构乙" : "合成机构甲")),
      calendar: {ranges: /202[45]/u.test(part) ? [{start: part.includes("2024") ? "2024-12-31" : "2025-12-31", end: part.includes("2024") ? "2024-12-31" : "2025-12-31"}] : [], unresolved: []},
      mentions: (await backend.matchMetricQuestion(part)).mentions})));
    // 与真实inspect_goal一致：无目录/日历事实的尾部限定合并前一片段，不制造额外查询目标。
    const inspected: typeof fragments = [];
    for (const fragment of fragments) {
      if (fragment.organizations.length || fragment.mentions.length || fragment.calendar.ranges.length || fragment.calendar.unresolved.length) inspected.push(fragment);
      else if (inspected.length) inspected[inspected.length - 1]!.question += "，" + fragment.question;
    }
    return {question, reference_year: null, fragments: inspected.length ? inspected : fragments.slice(0, 1)};
  });
  const valueOf = (spec: BasicQuerySpec, field: TransitionField): unknown => field === "metrics" ? spec.metric_codes
    : field === "organizations" ? spec.org_codes ?? [] : field === "comparison_organizations" ? spec.comparison_scope?.org_codes ?? [] : spec[field] ?? null;
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const fields: TransitionField[] = ["metrics", "organizations", "comparison_organizations", "time", "selection", "operation"];
  const reject = (code: string): never => {throw new BackendApiError(409, code, code);};
  const admitSemanticPlan = vi.fn(async (payload: {steps: Array<{target_ref: string; fragment: number; origin?: string; spec: BasicQuerySpec; transition?: SemanticTransition}>; goal: string; context_sources?: SemanticTransition[]}) => {
    const goal = await inspectBusinessGoal(payload.goal);
    for (const step of [...payload.steps, ...(payload.context_sources ?? []).map(transition => ({spec: transition.before, transition}))]) {
      const transition = step.transition; if (!transition) continue;
      const receiptSource = transition.source_semantic_receipt && receipts.get(transition.source_semantic_receipt);
      if (transition.source_semantic_receipt ? !receiptSource || !equal(receiptSource, transition.before) : !transition.source_question) reject("TRANSITION_SOURCE_INVALID");
      if (!receiptSource) {
        const mentions = (await backend.matchMetricQuestion(transition.source_question!)).mentions;
        const expected = mentions.flatMap(mention => mention.resolution.status === "resolved" ? (mention.resolution.value as {codes: string[]}).codes : []);
        if (!equal([...new Set(expected)].sort(), [...transition.before.metric_codes].sort())) reject("TRANSITION_SOURCE_INVALID");
      }
      const current = new Map(fields.map(field => [field, structuredClone(valueOf(transition.before, field))]));
      for (const change of transition.changes) {
        if (!fields.includes(change.field) || !equal(current.get(change.field), change.before)) reject("TRANSITION_BASE_MISMATCH");
        if (["metrics", "organizations", "comparison_organizations"].includes(change.field)) {
          if (!Array.isArray(change.before) || !Array.isArray(change.after) || change.after.some(code => typeof code !== "string") || new Set(change.after).size !== change.after.length) reject("TRANSITION_VALUE_INVALID");
          const before = change.before as string[], after = change.after as string[];
          const allowed = change.field === "metrics" ? Object.keys(metricNames) : ["O1", "O2"];
          if (after.some(code => !allowed.includes(code)) || change.action === "add" && before.some(code => !after.includes(code))
            || change.action === "exclude" && after.some(code => !before.includes(code)) || change.action === "clear" && after.length) reject("TRANSITION_ACTION_CONFLICT");
        } else if (!["set", "replace", "confirm", "clear"].includes(change.action) || change.action === "clear" && change.after !== null) reject("TRANSITION_ACTION_CONFLICT");
        current.set(change.field, structuredClone(change.after));
      }
      if (fields.some(field => !equal(current.get(field), valueOf(step.spec, field)))) reject("TRANSITION_AFTER_MISMATCH");
    }
    if (payload.steps.every(step => step.transition)) {
      const transitions = [...payload.steps.map(step => step.transition!), ...(payload.context_sources ?? [])];
      const sourceValues = (field: TransitionField) => [
        ...payload.steps.map(step => valueOf(step.spec, field)), ...transitions.map(transition => valueOf(transition.before, field)),
        ...transitions.flatMap(transition => transition.changes.filter(change => change.field === field).flatMap(change => [change.before, change.after])),
      ];
      const metrics = sourceValues("metrics").flatMap(value => Array.isArray(value) ? value : []);
      const organizations = [...sourceValues("organizations"), ...sourceValues("comparison_organizations")].flatMap(value => Array.isArray(value) ? value : []);
      const calendars = sourceValues("time") as Array<{start?: string; end?: string} | null>;
      if (goal.fragments.some(fragment => fragment.organizations.some(code => !organizations.includes(code))
        || fragment.mentions.some(mention => mention.resolution.status === "resolved" && (mention.resolution.value as {codes: string[]}).codes.some(code => !metrics.includes(code)))
        || fragment.calendar.ranges.some(range => !calendars.some(calendar => calendar?.start === range.start && calendar.end === range.end)))) reject("PLAN_TARGETS_INCOMPLETE");
    } else for (const [index, fragment] of goal.fragments.entries()) {
      const bound = payload.steps.filter(step => step.fragment === index), steps = bound.filter(step => !step.transition);
      const sources = bound.flatMap(step => step.transition ? [step.transition.before, step.spec] : [step.spec]);
      if (!bound.length || fragment.organizations.some(org => !sources.some(spec => [...(spec.org_codes ?? []), ...(spec.comparison_scope?.org_codes ?? [])].includes(org)))
        || fragment.mentions.some(mention => mention.resolution.status === "resolved" && (mention.resolution.value as {codes: string[]}).codes.some(code => !sources.some(spec => spec.metric_codes.includes(code))))
        || fragment.calendar.ranges.some(range => !sources.some(spec => spec.time.start === range.start && spec.time.end === range.end))) {
        reject("PLAN_TARGETS_INCOMPLETE");
      }
      // 完全继承的目标由before/after账本解释；独立新目标仍须完整覆盖它对应的正向目录事实。
      if (steps.length && fragment.mentions.some(mention => mention.resolution.status === "resolved" && (mention.resolution.value as {codes: string[]}).codes.some(code =>
        !bound.some(step => step.transition && (step.transition.before.metric_codes.includes(code) || step.spec.metric_codes.includes(code))) && !steps.some(step => step.spec.metric_codes.includes(code))))) reject("PLAN_TARGETS_INCOMPLETE");
    }
    return {status: "admitted", receipts: payload.steps.map(step => {
      const receipt = `synthetic-server-receipt-${receipts.size + 1}`; receipts.set(receipt, structuredClone(step.spec));
      return {target_ref: step.target_ref, receipt};
    })};
  });
  Object.assign(backend, {inspectBusinessGoal, admitSemanticPlan});
  return {inspectBusinessGoal, admitSemanticPlan};
}
