/** 空历史首问契约验收：仅 --live 访问配置模型；目录、权限、查询和结果始终使用隔离合成桩。 */
import assert from "node:assert/strict";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {BusinessContextService} from "../src/business-context/service.js";
import {createCapabilities} from "../src/business-context/capabilities.js";
import {createFieldResolvers} from "../src/business-context/resolvers.js";
import {toContextDelta} from "../src/business-context/turnArgs.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {projectEntries} from "../src/sessionProjection.js";
import type {BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";
import type {BusinessFrame, ContextDelta, FieldResolution} from "../src/business-context/types.js";

// 名称仅复用获授权的事故问句；正式编码、权限和结果均为显式合成事实。
const ORG = "江苏农商联合银行";
const ORG_CODE = "SYNTH_ORG_1";
const METRIC = "净利润金融当日数";
const METRIC_CODE = "SYNTH_METRIC_1";
const MONTH = {start: "2026-07-01", end: "2026-07-31"};
const DAY = {start: "2026-07-31", end: "2026-07-31"};
const actor: BackendUser = {id: "synthetic-first-turn-contract", username: "synthetic", display_name: "合成首问验收",
  org_code: ORG_CODE, org_name: ORG, role_code: "USER"};
type Scenario = {name: string; message: string; dateText: string; time: typeof MONTH;
  selection?: BasicQuerySpec["selection"]; diagnostic?: true};
const scenarios: Scenario[] = [
  {name: "month_spaced_last_available_top3", message: `对${ORG} 2026 年 7 月${METRIC}进行排名，取该月最后有数据的日期，列出前3名。`,
    dateText: "2026 年 7 月", time: MONTH, selection: "latest_in_range"},
  {name: "month_fullwidth_last_available_top3", message: `对${ORG}２０２６年７月${METRIC}进行排名，取该月最后有数据的日期，列出前３名。`,
    dateText: "２０２６年７月", time: MONTH, selection: "latest_in_range"},
  {name: "single_day_top3", message: `对${ORG} 2026 年 7 月 31 日${METRIC}进行排名，列出前3名。`,
    dateText: "2026 年 7 月 31 日", time: DAY, selection: "exact"},
  {name: "incident_ambiguous_month_ranking", message: `对${ORG} 2026 年 7 月${METRIC}进行排名`,
    dateText: "2026 年 7 月", time: MONTH, diagnostic: true},
];
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
async function resolveCatalog(entity: string, raw: string[]): Promise<FieldResolution> {
  if (entity === "date") {
    if (raw.length !== 1) return {status: "invalid"};
    const value = normalized(raw[0]!);
    if (value === "2026年7月") return {status: "resolved", value: MONTH};
    if (["2026年7月31日", "2026年7月末", "2026-07-31"].includes(value)) return {status: "resolved", value: DAY};
    return {status: "invalid"};
  }
  const name = entity === "metric" ? METRIC : ORG;
  const code = entity === "metric" ? METRIC_CODE : ORG_CODE;
  return raw.length === 1 && [name, code].includes(raw[0]!)
    ? {status: "resolved", value: {codes: [code], names: [name]}} : {status: "not_found", candidates: []};
}
function expectedSpec(scenario: Scenario) {
  return {org_codes: [ORG_CODE], metric_codes: [METRIC_CODE], time: scenario.time,
    selection: scenario.selection, operation: {kind: "ranking", position: "top", top_n: 3}};
}
function fixtureDelta(scenario: Scenario): ContextDelta {
  assert.ok(scenario.selection);
  return {capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
    fieldIntents: {organizations: {mode: "set", sourceText: ORG, expectedCount: null},
      time: {mode: "set", sourceText: scenario.dateText, expectedCount: null}},
    fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: METRIC},
      {fieldHint: "organizations", operation: "set", rawValue: ORG},
      {fieldHint: "time", operation: "set", rawValue: scenario.dateText},
      {fieldHint: "selection", operation: "set", rawValue: scenario.selection},
      {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "top", top_n: 3}}]};
}
async function checkFixtures(sessions: NativeSessionStore) {
  const proof: Array<Record<string, unknown>> = [];
  for (const scenario of scenarios.filter(item => !item.diagnostic)) {
    const session = await sessions.create(actor.id);
    const frames = new NativeFrameStore(session);
    assert.deepEqual(await frames.list(), []);
    const service = new BusinessContextService(frames, createCapabilities(), createFieldResolvers());
    const frame = await service.resolve(fixtureDelta(scenario),
      {sessionId: session.metadata.id, turnId: scenario.name, requestId: scenario.name},
      {originalMessage: scenario.message, currentDate: "2026-10-13", turnId: scenario.name,
        requireFieldIntents: true, resolveCatalog});
    assert.equal(frame.status, "ready");
    assert.deepEqual(frame.fields.time?.resolvedValue, scenario.time);
    assert.equal(frame.fields.selection?.resolvedValue, scenario.selection);
    assert.deepEqual(frame.fields.operation?.resolvedValue, {kind: "ranking", position: "top", top_n: 3});
    proof.push({case: scenario.name, passed: true, model_called: false, empty_history: true});
  }
  const scenario = scenarios[0]!;
  for (const control of [
    {name: "different_month_is_not_equivalent", raw: "2026年8月", source: scenario.dateText, code: "FIELD_INPUT_NOT_CURRENT"},
    {name: "invented_evidence_is_rejected", raw: scenario.dateText, source: "2026年8月", code: "FIELD_INTENT_EVIDENCE_INVALID"},
  ]) {
    const session = await sessions.create(actor.id);
    const frames = new NativeFrameStore(session);
    const service = new BusinessContextService(frames, createCapabilities(), createFieldResolvers());
    const delta = fixtureDelta(scenario);
    delta.fieldChanges.find(field => field.fieldHint === "time")!.rawValue = control.raw;
    delta.fieldIntents!.time!.sourceText = control.source;
    await assert.rejects(service.resolve(delta, {sessionId: session.metadata.id, turnId: control.name, requestId: control.name},
      {originalMessage: scenario.message, currentDate: "2026-10-13", turnId: control.name, requireFieldIntents: true, resolveCatalog}),
    {code: control.code});
    assert.deepEqual(await frames.list(), [], "错误来源不能落地可执行或成功Frame");
    proof.push({case: control.name, passed: true, model_called: false, expected_error: control.code});
  }
  return proof;
}
function assertSuccessful(scenario: Scenario, calls: Array<{name: string; args: unknown}>, queries: BasicQuerySpec[],
  focus: BusinessFrame | undefined, turnFrames: BusinessFrame[]) {
  assert.equal(queries.length, 1, "清楚首问须实际执行一次，零查询和重复执行均不通过");
  const spec = queries[0]!;
  const expected = expectedSpec(scenario);
  for (const name of ["org_codes", "metric_codes", "time", "selection", "operation"] as const) {
    assert.deepEqual(spec[name], expected[name], `正式spec.${name}必须完整兑现原文目标`);
  }
  const deltas = calls.filter(call => call.name === "resolve_business_turn").flatMap(call => {
    try {return [toContextDelta(call.args)];} catch {return [];}
  });
  assert.ok(deltas.some(delta => delta.baseReference === null), "空历史首问必须明确新建，不能生成历史来源");
  assert.ok(deltas.some(delta => delta.fieldChanges.some(change => change.fieldHint === "time"
    && change.operation === "set" && typeof change.rawValue === "string"
    && normalized(change.rawValue) === normalized(scenario.dateText))), "工具参数须保留本轮完整日期表达，允许格式等价");
  assert.ok(deltas.every(delta => delta.fieldChanges.every(change => change.fieldHint !== "organizations"
    || change.operation !== "set" || change.rawValue === ORG
    || Array.isArray(change.rawValue) && change.rawValue.length === 1 && change.rawValue[0] === ORG)),
  "不得为排名自动展开机构、引用空历史或伪造正式编码");
  assert.equal(focus?.status, "success");
  assert.deepEqual(focus?.fields.organizations?.resolvedValue, {codes: [ORG_CODE], names: [ORG]});
  assert.deepEqual(focus?.fields.metrics?.resolvedValue, {codes: [METRIC_CODE], names: [METRIC]});
  assert.deepEqual(focus?.fields.time?.resolvedValue, scenario.time);
  assert.equal(focus?.fields.selection?.resolvedValue, scenario.selection);
  assert.deepEqual(focus?.fields.operation?.resolvedValue, expected.operation);
  assert.ok(turnFrames.some(frame => frame.status === "success"), "本轮须保存成功快照");
}
function diagnoseAmbiguity(scenario: Scenario, queries: BasicQuerySpec[], receipts: Array<{name: string; details: unknown}>,
  focus: BusinessFrame | undefined, turnFrames: BusinessFrame[], answer: string) {
  if (queries.length) return {outcome: "executed_without_user_time_or_rank_limit_basis", acceptable: false,
    reason: "原句未指明时间选取方式与排名条数；不能把自动latest/月末/top10作为正确业务期望。"};
  const clarification = receipts.find(receipt => receipt.name === "resolve_business_turn"
    && (receipt.details as {status?: string} | undefined)?.status === "NEEDS_CLARIFICATION");
  const preserved = focus?.status === "clarifying"
    && (focus.fields.organizations?.resolvedValue as {codes?: string[]} | undefined)?.codes?.[0] === ORG_CODE
    && (focus.fields.metrics?.resolvedValue as {codes?: string[]} | undefined)?.codes?.[0] === METRIC_CODE
    && JSON.stringify(focus.fields.time?.resolvedValue) === JSON.stringify(MONTH);
  const pendingTargets = ["selection", "operation"].every(name => {
    const field = focus?.fields[name];
    const raw = field?.rawValue as {clarify?: unknown; sourceText?: unknown} | undefined;
    return field?.resolutionStatus === "ambiguous" && field.metadata?.userInputIssue === true && raw?.clarify === true
      && typeof raw.sourceText === "string" && !!raw.sourceText.trim() && normalized(scenario.message).includes(normalized(raw.sourceText))
      && typeof field.metadata.userClarificationQuestion === "string" && answer.includes(field.metadata.userClarificationQuestion);
  });
  return clarification && preserved && pendingTargets && !turnFrames.some(frame => ["executing", "success"].includes(frame.status))
    ? {outcome: "structured_clarification_with_known_target_preserved", acceptable: true,
      reason: "已知机构、指标和完整月份保留；时间取数与排名范围均保存未决状态、本轮依据和服务端问题，未登记执行。"}
    : {outcome: "no_legal_structured_clarification", acceptable: false,
      reason: "没有执行不等于成功：缺少保留已知条件的业务澄清回执，参数兜底或普通文字不能代替该状态。"};
}

/** 在同一真实待澄清会话中只追加一次明确补充；不重新抽样首问、不补成功Frame。 */
async function checkExplicitRecovery(host: HarnessHost, hosted: Awaited<ReturnType<HarnessHost["createSession"]>>,
  backend: BackendClient, queries: BasicQuerySpec[], timeoutMs: number) {
  const name = "incident_explicit_followup_recovery";
  const message = "取该月最后有数据的日期，列出前3名，其他条件保持不变，请继续排名。";
  const before = queries.length;
  let failure: string | undefined;
  let completion: unknown;
  let timedOut = false;
  let abortFailure: string | undefined;
  const started = performance.now();
  try {
    const admitted = await host.admitPrompt(hosted, {protocol_version: 3, request_id: name, message}, {actor, backend});
    assert.ok(admitted.ok);
    const timer = setTimeout(() => {timedOut = true; void host.abort(hosted, admitted.operationId)
      .catch(error => {abortFailure = error instanceof Error ? error.message : String(error);});}, timeoutMs);
    try {completion = await host.drivePrompt(hosted, admitted);} finally {clearTimeout(timer);}
    assert.ok(!timedOut, "恢复回合超过验收时限，已原生取消");
    const outcome = completion as Awaited<ReturnType<HarnessHost["drivePrompt"]>>;
    assert.ok(outcome.ok && outcome.outcome.kind === "settled" && outcome.outcome.outcome.status === "completed");
  } catch (error) {failure = error instanceof Error ? error.message : String(error);}
  const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const lastUser = entries.map(entry => entry.type === "message" && entry.message.role === "user").lastIndexOf(true);
  const turnEntries = entries.slice(lastUser);
  const messages = turnEntries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
  const calls = messages.flatMap(item => item.role === "assistant" ? item.content.filter(block => block.type === "toolCall")
    .map(block => ({name: block.name, args: block.arguments})) : []);
  const receipts = messages.flatMap(item => item.role === "toolResult" ? [{name: item.toolName, details: item.details,
    text: item.content.filter(block => block.type === "text").map(block => block.text).join("\n")}] : []);
  const frames = new NativeFrameStore(hosted.session);
  const state = await frames.state();
  const focus = state.focusFrameId ? await frames.get(state.focusFrameId) : undefined;
  const turnFrames = (await frames.list()).filter(frame => frame.requestId === name);
  const answer = projectEntries(turnEntries).filter(item => item.role === "assistant" && item.text.trim()).at(-1);
  let reopenVerified = false;
  try {
    if (failure) throw new Error(failure);
    assert.equal(queries.length - before, 1);
    const expected = expectedSpec(scenarios[0]!);
    for (const key of ["org_codes", "metric_codes", "time", "selection", "operation"] as const) {
      assert.deepEqual(queries.at(-1)![key], expected[key], `恢复spec.${key}必须保留原目标并兑现本轮补充`);
    }
    const deltas = calls.filter(call => call.name === "resolve_business_turn").flatMap(call => {
      try {return [toContextDelta(call.args)];} catch {return [];}
    });
    assert.ok(deltas.length && deltas.every(delta => delta.baseReference !== null), "恢复须沿用已保存待澄清目标");
    assert.ok(deltas.every(delta => delta.fieldChanges.every(change => !["organizations", "metrics", "time"].includes(change.fieldHint)
      || change.operation === "retain")), "本轮只补时间取数和排名范围，已知业务字段不可重写");
    assert.equal(focus?.status, "success");
    assert.deepEqual(focus?.fields.time?.resolvedValue, MONTH);
    assert.equal(focus?.fields.selection?.resolvedValue, "latest_in_range");
    assert.deepEqual(focus?.fields.operation?.resolvedValue, expected.operation);
    assert.deepEqual(focus?.fields.organizations?.resolvedValue, {codes: [ORG_CODE], names: [ORG]});
    assert.deepEqual(focus?.fields.metrics?.resolvedValue, {codes: [METRIC_CODE], names: [METRIC]});
    assert.ok(answer?.role === "assistant" && answer.text.trim());
    await host.closeSession(hosted.sessionId);
    const reopened = (await host.openSession(actor, hosted.sessionId))!;
    const reopenedFrames = new NativeFrameStore(reopened.session);
    assert.deepEqual(await reopenedFrames.state(), state);
    assert.deepEqual(state.focusFrameId ? await reopenedFrames.get(state.focusFrameId) : undefined, focus);
    const reopenedAnswer = projectEntries(await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
      .filter(item => item.role === "assistant" && item.text.trim()).at(-1);
    assert.deepEqual(reopenedAnswer, answer);
    reopenVerified = true;
  } catch (error) {failure = error instanceof Error ? error.message : String(error);}
  return {name, scope: "followup_recovery", passed: !failure, ...(failure ? {failure} : {}), message,
    expected: expectedSpec(scenarios[0]!), elapsed_ms: Math.round(performance.now() - started), completion,
    validation_deadline_exceeded: timedOut, ...(abortFailure ? {abort_failure: abortFailure} : {}), query_count: queries.length - before, calls, receipts,
    query_specs: queries.slice(before), focus, turn_frames: turnFrames,
    reopen_verified: reopenVerified, answer: answer?.role === "assistant" ? answer.text : null};
}

async function main() {
  const live = process.argv.includes("--live");
  const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice("--case=".length);
  const customReport = process.argv.find(arg => arg.startsWith("--report-base="))?.slice("--report-base=".length);
  const timeoutMs = Number(process.argv.find(arg => arg.startsWith("--turn-timeout-ms="))?.slice("--turn-timeout-ms=".length) ?? 180_000);
  assert.ok(!selected || scenarios.some(item => item.name === selected), "未知case");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 600_000);
  const dir = await mkdtemp(join(tmpdir(), "pi-first-turn-contract-"));
  const sessions = new NativeSessionStore(dir);
  if (!live) {
    try {console.log(JSON.stringify({status: "fixtures_valid", proof: await checkFixtures(sessions), model_called: false,
      real_database_verified: false, production_accessed: false, session_data: dir}));}
    finally {await sessions.close();}
    return;
  }
  const config = {...loadConfig(), dataDir: dir};
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), sessions,
    createAskMetricTools({compactTurnArgs: config.compactTurnArgs}));
  const reports: Array<Record<string, unknown>> = [];
  try {
    const fixtureChecks = await checkFixtures(sessions);
    for (const scenario of scenarios.filter(item => !selected || item.name === selected)) {
      let hosted = await host.createSession(actor);
      let frames = new NativeFrameStore(hosted.session);
      assert.deepEqual(await frames.list(), [], "每例须空业务历史");
      assert.equal((await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
        .filter(entry => entry.type === "message").length, 0, "每例须空聊天历史");
      const queries: BasicQuerySpec[] = [];
      const lookups: Array<{entity: string; raw: string[]}> = [];
      const backend = {
        resolveBusinessField: async (entity: string, raw: string[]) => {lookups.push({entity, raw}); return resolveCatalog(entity, raw);},
        searchMetrics: async (keyword: string) => {
          const matched = METRIC.includes(keyword) || keyword === METRIC_CODE;
          return {total: matched ? 1 : 0, items: matched ? [{metric_code: METRIC_CODE, metric_name: METRIC,
            unit: "合成单位", score: 1, match_type: [METRIC, METRIC_CODE].includes(keyword) ? "exact" : "contains"}] : [], semantic_suggestions: []};
        },
        searchOrganizations: async (keyword: string) => {
          const matched = ORG.includes(keyword) || keyword === ORG_CODE;
          return {total: matched ? 1 : 0, items: matched ? [{org_code: ORG_CODE, org_name: ORG,
            score: 1, match_type: [ORG, ORG_CODE].includes(keyword) ? "exact" : "contains"}] : []};
        },
        metricCatalogOverview: async () => ({total: 1, groups: [{unit: "合成单位", count: 1, examples: [{code: METRIC_CODE, name: METRIC}]}]}),
        matchMetricQuestion: async (question: string) => ({mentions: question.includes(METRIC)
          ? [{text: METRIC, start: question.indexOf(METRIC), end: question.indexOf(METRIC) + METRIC.length,
            resolution: {status: "resolved", value: {codes: [METRIC_CODE], names: [METRIC]}}}] : []}),
        createAgentQueryContext: async () => ({conversation_id: "synthetic-first-turn-contract"}),
        basicQueries: async (spec: BasicQuerySpec) => {
          queries.push(structuredClone(spec));
          const task = `synthetic-first-turn-${queries.length}`;
          return {query: spec, result: {task_id: task, result_id: `result:${task}`, status: "succeeded", rows: [], columns: [],
            row_count: 0, message: "隔离合成查询已完成，无记录。", evidence: {logical_dsl: spec}}};
        },
        getTask: async (task_id: string) => ({task_id, status: "SUCCEEDED", version: 1, result: {result_id: `result:${task_id}`}}),
        getTaskResult: async (task_id: string) => ({task_id, result_id: `result:${task_id}`, status: "succeeded", rows: [], columns: [],
          row_count: 0, has_more: false, offset: 0, message: "合成查询结果，无记录。"}),
      } as unknown as BackendClient;
      let failure: string | undefined;
      let completion: unknown;
      let deadlineExceeded = false;
      let abortFailure: string | undefined;
      const started = performance.now();
      try {
        const admitted = await host.admitPrompt(hosted, {protocol_version: 3, request_id: scenario.name, message: scenario.message}, {actor, backend});
        assert.ok(admitted.ok);
        const timer = setTimeout(() => {deadlineExceeded = true; void host.abort(hosted, admitted.operationId)
          .catch(error => {abortFailure = error instanceof Error ? error.message : String(error);});}, timeoutMs);
        let outcome: Awaited<ReturnType<HarnessHost["drivePrompt"]>>;
        try {outcome = await host.drivePrompt(hosted, admitted);} finally {clearTimeout(timer);}
        completion = outcome;
        assert.ok(!deadlineExceeded, `VALIDATION_TURN_DEADLINE: 超过${timeoutMs}ms，已原生取消`);
        assert.ok(outcome.ok && outcome.outcome.kind === "settled" && outcome.outcome.outcome.status === "completed", "本轮须正常结束");
      } catch (error) {failure = error instanceof Error ? error.message : String(error);}
      const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
      const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const calls = messages.flatMap(message => message.role === "assistant" ? message.content
        .filter(block => block.type === "toolCall").map(block => ({name: block.name, args: block.arguments})) : []);
      const receipts = messages.flatMap(message => message.role === "toolResult" ? [{name: message.toolName, details: message.details,
        text: message.content.filter(block => block.type === "text").map(block => block.text).join("\n")}] : []);
      const answer = projectEntries(entries).filter(item => item.role === "assistant" && item.text.trim()).at(-1);
      const state = await frames.state();
      const focus = state.focusFrameId ? await frames.get(state.focusFrameId) : undefined;
      const turnFrames = (await frames.list()).filter(frame => frame.requestId === scenario.name);
      const diagnostic = scenario.diagnostic ? diagnoseAmbiguity(scenario, queries, receipts, focus, turnFrames,
        answer?.role === "assistant" ? answer.text : "") : undefined;
      let reopenVerified = false;
      try {
        if (failure) throw new Error(failure);
        assert.ok(answer?.role === "assistant" && answer.text.trim(), "须有用户可见的最终回复");
        assert.ok(queries.length <= 1, "首问不得重复业务查询");
        if (!scenario.diagnostic) assertSuccessful(scenario, calls, queries, focus, turnFrames);
        await host.closeSession(hosted.sessionId);
        hosted = (await host.openSession(actor, hosted.sessionId))!;
        frames = new NativeFrameStore(hosted.session);
        assert.deepEqual(await frames.state(), state, "重开须保留全部业务会话状态");
        assert.deepEqual(state.focusFrameId ? await frames.get(state.focusFrameId) : undefined, focus, "重开须保留完整焦点Frame");
        const reopenedAnswer = projectEntries(await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
          .filter(item => item.role === "assistant" && item.text.trim()).at(-1);
        assert.deepEqual(reopenedAnswer, answer, "重开后的用户可见结果须一致");
        reopenVerified = true;
      } catch (error) {failure = error instanceof Error ? error.message : String(error);}
      reports.push({name: scenario.name, scope: scenario.diagnostic ? "independent_diagnostic" : "acceptance",
        ...(!scenario.diagnostic ? {passed: !failure} : {}), ...(failure ? {failure} : {}), ...(diagnostic ? {diagnostic} : {}),
        message: scenario.message, expected: scenario.diagnostic ? {time: MONTH, known_org_codes: [ORG_CODE], known_metric_codes: [METRIC_CODE],
          time_selection: "not_supplied", ranking_limit: "not_supplied", cannot_assume_default: true} : expectedSpec(scenario),
        elapsed_ms: Math.round(performance.now() - started), completion, validation_deadline_exceeded: deadlineExceeded,
        ...(abortFailure ? {abort_failure: abortFailure} : {}), empty_history: true, query_count: queries.length,
        calls, receipts, query_specs: structuredClone(queries), authorized_lookups: structuredClone(lookups), focus,
        turn_frames: turnFrames, reopen_verified: reopenVerified,
        answer: answer?.role === "assistant" ? answer.text : null});
      console.log(JSON.stringify({case: scenario.name, scope: scenario.diagnostic ? "diagnostic" : "acceptance", passed: scenario.diagnostic ? null : !failure,
        failure, diagnostic, query_count: queries.length, tools: calls.map(call => call.name)}));
      if (scenario.diagnostic && diagnostic?.acceptable && !failure) {
        const recovery = await checkExplicitRecovery(host, hosted, backend, queries, timeoutMs);
        reports.push(recovery);
        console.log(JSON.stringify({case: recovery.name, scope: recovery.scope, passed: recovery.passed,
          failure: recovery.failure, query_count: recovery.query_count, tools: recovery.calls.map(call => call.name)}));
      }
      await host.closeSession(hosted.sessionId);
    }
    const acceptance = reports.filter(item => item.scope === "acceptance");
    const recovery = reports.filter(item => item.scope === "followup_recovery");
    const diagnostics = reports.filter(item => item.scope === "independent_diagnostic");
    const passed = acceptance.length > 0 && acceptance.every(item => item.passed);
    const diagnosticsAcceptable = diagnostics.filter(item => !item.failure && (item.diagnostic as {acceptable?: boolean} | undefined)?.acceptable === true);
    const objectivesPassed = (!acceptance.length || passed) && diagnosticsAcceptable.length === diagnostics.length
      && recovery.every(item => item.passed);
    const report = {environment: "configured_model_synthetic_backend", created_at: new Date().toISOString(), model: config.model.name,
      model_called: true, model_max_tokens: config.model.maxTokens, compact_turn_args: !!config.compactTurnArgs,
      validation_turn_timeout_ms: timeoutMs, real_database_verified: false, production_accessed: false, fixture_mode: "empty_first_turn",
      fixture_scope: "Each scenario starts with no native chat messages and no Frames. Names reuse the authorized incident; all formal codes, permissions, dates and query results are synthetic.",
      session_data: dir, fixture_checks: fixtureChecks, acceptance_passed: passed, acceptance_cases: acceptance.length,
      acceptance_passed_cases: acceptance.filter(item => item.passed).length,
      contract_objectives_passed: objectivesPassed, diagnostic_cases: diagnostics.length, diagnostic_acceptable_cases: diagnosticsAcceptable.length,
      followup_recovery_cases: recovery.length, followup_recovery_passed_cases: recovery.filter(item => item.passed).length, reports};
    const reportBase = customReport ? resolve(customReport) : resolve(import.meta.dirname, "../../docs/verification/first-turn-contract-20261013");
    await mkdir(dirname(reportBase), {recursive: true});
    await writeFile(`${reportBase}.json`, JSON.stringify(report, null, 2));
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    const lines = reports.map(item => `| ${item.name} | ${item.scope === "independent_diagnostic" ? "独立诊断，不并入通过率" : item.passed ? "通过" : "失败"} | ${item.query_count} | ${item.failure ?? (item.diagnostic as {outcome?: string} | undefined)?.outcome ?? "完整目标与重开一致"} |`);
    await writeFile(`${reportBase}.md`, `# 空历史首问工具契约真实模型验收\n\n时间：${report.created_at}\n\n模型：${report.model}；compact 参数：${report.compact_turn_args}。\n\n仅调用配置模型；业务目录、权限、查询及结果全部是隔离合成桩，未访问生产业务服务或任何真实业务数据库。每个首问独立新建空聊天、空 Frame；恢复回合沿用同一诊断会话。\n\n${report.acceptance_cases ? `明确目标首问 ${report.acceptance_passed_cases}/${report.acceptance_cases} 通过；` : "此次未重跑前三个明确首问；"}独立诊断 ${report.diagnostic_acceptable_cases}/${report.diagnostic_cases} 可接受；同会话恢复 ${report.followup_recovery_passed_cases}/${report.followup_recovery_cases} 通过。本结论仅限本次所选合成场景。事故原句另作为独立诊断，缺少月范围取数方式及排名条数，不能通过自动月末、latest 或 top10 获得虚假的成功。\n\n| 场景 | 结果 | 查询次数 | 说明 |\n| --- | --- | --- | --- |\n${lines.join("\n")}\n\n明确目标通过条件同时检查工具参数、正式查询 spec 的机构/指标/完整日期范围/selection/排名条数、查询次数恰为一次、成功 Frame、重开后的 Frame 与最终消息。零查询或文字正常不算通过；格式等价不允许改年/月/日或裁掉日期限定、排名和机构。\n\n事故原句诊断需要结构化澄清及已给目标的持久化证据。原契约将普通回答限定于非业务对话，selection 缺失视为模型参数错误，ranking 输入又要求完整 position/top_n；诊断要求通过公开的字段澄清契约保留已知目标和两项未决业务选择，不能用普通文字或参数兜底代替。\n\n详细工具参数、回执、正式 spec、持久化 Frame 及失败见 [JSON 报告](${basename(reportBase)}.json)。本报告仅证明这些合成样本的本地宿主行为，不代表生产部署、真实目录、数据库或任意自然语言均已验收。\n`);
    console.log(JSON.stringify({contract_objectives_passed: objectivesPassed, acceptance_passed: passed, acceptance_cases: acceptance.length,
      diagnostics: report.diagnostic_cases, diagnostic_acceptable_cases: diagnosticsAcceptable.length, report: `${reportBase}.json`}));
    if (!objectivesPassed) process.exitCode = 1;
  } finally {await host.close(); await sessions.close();}
}

await main();
