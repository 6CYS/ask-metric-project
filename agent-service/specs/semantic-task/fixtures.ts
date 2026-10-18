import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore, NativeBusinessResultStore} from "../../src/business-context/store.js";
import {NativeSemanticTaskStore} from "../../src/semantic-task/store.js";
import {MemoryCommandBridge, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import type {MetricMention} from "../../src/business-context/metricMentions.js";
import type {SemanticRequest, SemanticOperation, SemanticSource} from "../../src/semantic-task/protocol.js";

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
  const resolveBusinessField = vi.fn(async (entity: string, raw: string[], _options?: unknown, _year?: number, source?: {source_question: string},
    modelValue?: {start: string; end: string; dates?: string[]}) => {
    if (entity === "date") {
      if (raw[0]?.includes("无效")) return {status: "invalid", metadata: {reason: "unsupported_expression"}};
      // 模型随原文提交换算（model_value 通道）：与真实后端契约一致——确定性规则命中时忽略换算并标记
      // deterministic；仅确定性不支持的表达采纳换算兜底并标记 model。近N年附完整年度备选口径。
      const calendar = modelValue ? {start: modelValue.start, end: modelValue.end, ...(modelValue.dates ? {dates: modelValue.dates} : {})} : undefined;
      const recentYears = /^(?:近|最近|过去)\s*(\d+)\s*个?年$/u.exec(raw[0]?.trim() ?? "");
      if (modelValue && calendar && recentYears) {
        const endYear = Number(modelValue.end.slice(0, 4));
        const amount = Number(recentYears[1]);
        return {status: "resolved", value: calendar,
          alternative: {label: `最近${amount}个完整年度`, start: `${endYear - amount}-01-01`, end: `${endYear - 1}-12-31`},
          metadata: {resolution_source: "deterministic", source_calendar: {ranges: [calendar], unresolved: []}}};
      }
      if (raw[0]?.includes("模糊时间")) {
        if (!calendar) return {status: "invalid", metadata: {reason: "unsupported_expression"}};
        return {status: "resolved", value: calendar,
          metadata: {resolution_source: "model", source_calendar: {ranges: [calendar], unresolved: []}}};
      }
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
  const inspectBusinessGoal = vi.fn(async (question: string) => {
    const fragments = await Promise.all(question.split(/[；;，,]/u).filter(Boolean).map(async part => ({question: part,
      organizations: ["O1", "O2"].filter((_, i) => part.includes(i ? "合成机构乙" : "合成机构甲")),
      calendar: {ranges: /202[45]/u.test(part) ? [{start: part.includes("2024") ? "2024-12-31" : "2025-12-31", end: part.includes("2024") ? "2024-12-31" : "2025-12-31"}] : [], unresolved: []},
      mentions: (await matchMetricQuestion(part)).mentions})));
    // 与真实inspect_goal一致：无目录/日历事实的尾部限定合并前一片段，不制造额外查询目标。
    const inspected: typeof fragments = [];
    for (const fragment of fragments) {
      if (fragment.organizations.length || fragment.mentions.length || fragment.calendar.ranges.length || fragment.calendar.unresolved.length) inspected.push(fragment);
      else if (inspected.length) inspected[inspected.length - 1]!.question += "，" + fragment.question;
    }
    return {question, reference_year: null, requires_calculation: /计算|相减|相加|差额/u.test(question), fragments: inspected.length ? inspected : fragments.slice(0, 1)};
  });
  return {resolveBusinessField, matchMetricQuestion, basicQueries, inspectBusinessGoal,
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
    {sessionId: session.metadata.id, operationId, requestId: operationId, originalMessage,
      frames: new NativeFrameStore(session), businessResults: new NativeBusinessResultStore(session), semanticTasks: new NativeSemanticTaskStore(session)});
  return {dir, sessions, session, backend, request, async close() {await sessions.close(); rmSync(dir, {recursive: true, force: true});}};
}
