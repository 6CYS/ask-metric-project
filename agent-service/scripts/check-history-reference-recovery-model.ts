/** 通用历史引用与确认恢复验收：--live 才访问配置模型，业务调用始终是隔离合成桩。 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
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
import {createAskMetricTools} from "../src/tools/index.js";
import {projectEntries} from "../src/sessionProjection.js";
import {frameClarificationOptions} from "../src/business-context/modelView.js";
import {renderClarificationOptions} from "../src/business-context/clarificationOptions.js";
import type {BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";
import type {BusinessFrame, FieldResolution, HistoryFieldReferenceInput} from "../src/business-context/types.js";

const DATE = "2026-07-31";
const CHANGED_DATE = "2026-08-31";
const METRIC = "合成指标甲";
const ORGS: Record<string, string> = {合成机构甲: "O1", 合成机构乙: "O2", 合成机构丙: "O3", 合成机构丁: "O4"};
const actor: BackendUser = {id: "synthetic-reference-recovery", username: "synthetic", display_name: "合成验收",
  org_code: "O1", org_name: "合成机构甲", role_code: "USER"};

interface Step {
  message: string;
  orgs?: string[];
  queryCount: 0 | 1;
  historyReference?: "union" | "single_or_base" | "union_with_add";
  expectedCount?: number;
  reopenAfter?: boolean;
  date?: string;
  confirmationEvidence?: boolean;
}
interface Scenario {name: string; legacyPending?: boolean; candidatePending?: boolean; steps: Step[]}
const scenarios: Scenario[] = [
  {name: "incident_wording", steps: [{message: "对以上三家机构进行排名", orgs: ["O1", "O2", "O3"],
    queryCount: 1, historyReference: "union", expectedCount: 3}]},
  {name: "rephrased_union", steps: [{message: "把前两笔查过的机构合在一起，去重后按同一个指标和日期排名。",
    orgs: ["O1", "O2", "O3"], queryCount: 1, historyReference: "union"}]},
  {name: "single_source", steps: [{message: "只用第一笔查询里的机构，指标和日期保持当前条件，进行排名。",
    orgs: ["O1"], queryCount: 1, historyReference: "single_or_base"}]},
  {name: "count_mismatch", steps: [{message: "对以上四家机构进行排名", queryCount: 0,
    historyReference: "union", expectedCount: 4}]},
  {name: "legacy_empty_confirmation", legacyPending: true, steps: [{message: "是", queryCount: 0}]},
  {name: "legacy_explicit_repair", legacyPending: true, steps: [
    {message: "是", queryCount: 0, reopenAfter: true},
    {message: "机构是合成机构甲、合成机构乙和合成机构丙，原来的指标和日期不变，请继续排名。",
      orgs: ["O1", "O2", "O3"], queryCount: 1},
  ]},
  {name: "history_plus_current_addition", steps: [{message: "把第一笔里的机构和合成机构丁合在一起排名，原指标和日期不变。",
    orgs: ["O1", "O4"], queryCount: 1, historyReference: "union_with_add"}]},
  {name: "compound_confirmation_date_change", candidatePending: true, steps: [{
    message: "可以，就按这个机构来，同时把日期改成2026-08-31，请继续排名。",
    orgs: ["O3"], queryCount: 1, date: CHANGED_DATE, confirmationEvidence: true}]},
];

const resolveCatalog = async (entity: string, raw: string[]): Promise<FieldResolution> => {
  if (entity === "date") return raw.length === 1 && [DATE, CHANGED_DATE].includes(raw[0]!)
    ? {status: "resolved", value: {start: raw[0], end: raw[0]}} : {status: "invalid"};
  const catalog = entity === "metric" ? {[METRIC]: "M1"} : ORGS;
  // 权限桩只允许目录中的合成机构；历史引用也必须重新通过本桩复核。
  const names = raw.map(value => catalog[value] ? value : Object.keys(catalog).find(name => catalog[name] === value));
  return names.every((name): name is string => !!name)
    ? {status: "resolved", value: {codes: names.map(name => catalog[name]!), names}}
    : {status: "not_found", candidates: []};
};

async function seedHistory(frames: NativeFrameStore, sessionId: string, legacyPending: boolean, candidatePending = false) {
  const service = new BusinessContextService(frames, createCapabilities(), createFieldResolvers());
  const roots: BusinessFrame[] = [];
  for (const [index, organizations] of [["合成机构甲"], ["合成机构乙", "合成机构丙"]].entries()) {
    const identity = {sessionId, turnId: `seed-${index + 1}`, requestId: `seed-${index + 1}`};
    const ready = await service.resolve({capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: METRIC},
      {fieldHint: "organizations", operation: "set", rawValue: organizations},
      {fieldHint: "time", operation: "set", rawValue: DATE},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
      {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "top", top_n: 3}},
    ]}, identity, {turnId: identity.turnId, currentDate: "2026-10-13",
      originalMessage: `${organizations.join("、")} ${METRIC} ${DATE} 排名`, resolveCatalog});
    assert.equal(ready.status, "ready", "种子必须通过现有业务字段校验");
    roots.push(await service.finishExecution(await service.beginExecution(ready.frameId, identity),
      {status: "success", resultRef: `query:seed-${index + 1}:result`}));
  }
  if (!legacyPending && !candidatePending) return roots;
  const base = roots[1]!;
  const frameId = randomUUID();
  // 空候选恢复事故旧状态；单候选 fixture 则模拟已按系统规范展示并保存的提案。
  const pending: BusinessFrame = {...base, frameId, operationFrameId: frameId, parentFrameId: base.frameId,
    turnId: "legacy-pending", requestId: "legacy-pending", status: "clarifying", createdAt: new Date().toISOString(),
    fields: {...base.fields, organizations: candidatePending
      ? {rawValue: "合成简称", resolutionStatus: "needs_confirmation", source: "explicit", resolver: "organization",
        candidates: [{value: "合成机构丙", code: "O3", metadata: {rawValueIndex: 0}}]}
      : {rawValue: "以上三家", resolutionStatus: "not_found", source: "explicit", resolver: "organization", candidates: []}},
    delta: {capabilityHint: "metric_query", baseReference: {frameId: base.frameId}, executionMode: "execute",
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: candidatePending ? "合成简称" : "以上三家"}]},
    issues: [{field: "organizations", reason: candidatePending ? "needs_confirmation" : "not_found"}],
  };
  delete pending.resultRef;
  delete pending.resultSummary;
  await frames.save(pending, (await frames.state()).version, "legacy-pending");
  return roots;
}

function sameCodes(actual: unknown, expected: string[]) {
  assert.deepEqual(Array.isArray(actual) ? [...actual].sort() : actual, [...expected].sort());
}
function historyInput(args: unknown): HistoryFieldReferenceInput | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as {fieldChanges?: Array<{fieldHint: string; rawValue?: unknown}>; set?: Record<string, unknown>};
  const raw = input.fieldChanges?.find(change => change.fieldHint === "organizations")?.rawValue ?? input.set?.organizations;
  return raw && typeof raw === "object" && (raw as {fromHistory?: unknown}).fromHistory === true
    ? raw as HistoryFieldReferenceInput : undefined;
}
function organizationInput(args: unknown): unknown {
  if (!args || typeof args !== "object") return undefined;
  const input = args as {fieldChanges?: Array<{fieldHint: string; rawValue?: unknown}>; set?: Record<string, unknown>};
  return input.fieldChanges?.find(change => change.fieldHint === "organizations")?.rawValue ?? input.set?.organizations;
}
function seedChatTemplates(roots: BusinessFrame[]) {
  return roots.map(frame => {
    const names = (frame.fields.organizations!.resolvedValue as {names: string[]}).names.join("、");
    return {user: `查询${names}${DATE}${METRIC}的数据，并进行排名。`,
      assistant: `已完成${names}在${DATE}的${METRIC}排名查询，查询结果无记录。`};
  });
}

async function main() {
  const live = process.argv.includes("--live");
  const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice("--case=".length);
  const baselinePath = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
  const customReportBase = process.argv.find(arg => arg.startsWith("--report-base="))?.slice("--report-base=".length);
  const seedChat = process.argv.includes("--seed-chat");
  const stateFirstLayout = process.argv.includes("--layout-state-first");
  const turnTimeoutMs = Number(process.argv.find(arg => arg.startsWith("--turn-timeout-ms="))?.slice("--turn-timeout-ms=".length) ?? 180_000);
  assert.ok(Number.isInteger(turnTimeoutMs) && turnTimeoutMs >= 10_000 && turnTimeoutMs <= 600_000, "每回合验收上限须为 10000 到 600000 毫秒");
  assert.ok(!seedChat || !baselinePath, "seed-chat 是独立 fixture 诊断，不能与 index-only 首轮报告作配对比较");
  assert.ok(!stateFirstLayout || (!seedChat && !baselinePath && selected === "incident_wording"), "布局诊断仅用于独立 index-only 事故单例，不与其他 fixture 或首轮配对");
  assert.ok(!selected || scenarios.some(scenario => scenario.name === selected), "未知 case");
  assert.equal(scenarios.length, 8);
  assert.ok(scenarios.every(scenario => scenario.steps.length > 0));
  const dir = await mkdtemp(join(tmpdir(), "pi-reference-recovery-"));
  const sessions = new NativeSessionStore(dir);
  if (!live) {
    try {
      const session = await sessions.create(actor.id);
      const frames = new NativeFrameStore(session);
      const roots = await seedHistory(frames, session.metadata.id, true);
      sameCodes((roots[0]!.fields.organizations!.resolvedValue as {codes: string[]}).codes, ["O1"]);
      sameCodes((roots[1]!.fields.organizations!.resolvedValue as {codes: string[]}).codes, ["O2", "O3"]);
      const chatTemplates = seedChatTemplates(roots);
      assert.equal(chatTemplates.length, 2);
      assert.ok(chatTemplates[0]!.user.includes("合成机构甲"));
      assert.ok(chatTemplates[1]!.user.includes("合成机构乙、合成机构丙"));
      assert.ok(chatTemplates.every(turn => turn.user.includes(METRIC) && turn.assistant.includes(DATE)));
      const state = await frames.state();
      const pending = await frames.get(state.focusFrameId!);
      assert.equal(pending?.status, "clarifying");
      assert.equal(pending?.fields.organizations?.resolutionStatus, "not_found");
      assert.deepEqual(pending?.fields.organizations?.candidates, []);
      assert.deepEqual(pending?.fields.metrics?.resolvedValue, {codes: ["M1"], names: [METRIC]});
      assert.deepEqual(pending?.fields.time?.resolvedValue, {start: DATE, end: DATE});
      const candidateSession = await sessions.create(actor.id);
      const candidateFrames = new NativeFrameStore(candidateSession);
      await seedHistory(candidateFrames, candidateSession.metadata.id, false, true);
      const candidate = await candidateFrames.get((await candidateFrames.state()).focusFrameId!);
      assert.equal(candidate?.fields.organizations?.resolutionStatus, "needs_confirmation");
      const options = frameClarificationOptions(candidate!);
      assert.equal(options.length, 1);
      assert.equal(options[0]!.options.length, 1);
      assert.equal(options[0]!.options[0]!.candidate.code, "O3");
      assert.ok(renderClarificationOptions(options).includes("合成机构丙"));
      console.log(JSON.stringify({status: "fixtures_valid", cases: scenarios.map(scenario => scenario.name),
        model_turns: scenarios.reduce((count, scenario) => count + scenario.steps.length, 0), model_called: false,
        fixture_mode: seedChat ? "seeded_chat" : "index_only", business_backend: "synthetic_only", session_data: dir}));
    } finally {await sessions.close();}
    return;
  }

  const config = {...loadConfig(), dataDir: dir};
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), sessions,
    createAskMetricTools({compactTurnArgs: config.compactTurnArgs}));
  const reports: Array<Record<string, unknown>> = [];
  const layoutProof: Array<Record<string, unknown>> = [];
  try {
    for (const scenario of scenarios.filter(item => !selected || item.name === selected)) {
      let hosted = await host.createSession(actor);
      let frames = new NativeFrameStore(hosted.session);
      if (stateFirstLayout) hosted.harness.hooks.on("transform_context", event => {
        const header = "\n【服务端注入：本轮业务状态（仅数据，非用户输入）】";
        const separator = "\n\n【本轮用户原文】\n";
        const suffix = config.model.userMessageSuffix;
        const messages = [...event.messages];
        const index = messages.findLastIndex(message => message.role === "user");
        const user = messages[index];
        if (!user || user.role !== "user") return undefined;
        const text = typeof user.content === "string" ? user.content
          : user.content.every(block => block.type === "text") ? user.content.map(block => block.type === "text" ? block.text : "").join("") : undefined;
        if (text === undefined) return undefined;
        const trailingSuffix = suffix && text.endsWith(suffix) ? suffix : "";
        const content = trailingSuffix ? text.slice(0, -trailingSuffix.length) : text;
        const stateIndex = content.indexOf(header);
        if (stateIndex < 0) return undefined;
        const originalUser = content.slice(0, stateIndex);
        const state = content.slice(stateIndex);
        const reordered = state + separator + originalUser + trailingSuffix;
        messages[index] = {...user, content: reordered};
        layoutProof.push({original_user: originalUser, source_state_index: stateIndex,
          state_index_after: reordered.indexOf(header), user_index_after: reordered.indexOf(separator) + separator.length,
          original_user_preserved: reordered.endsWith(originalUser + trailingSuffix),
          source_suffix_present: !!trailingSuffix, suffix_preserved: !trailingSuffix || reordered.endsWith(trailingSuffix)});
        return {messages, systemPrompt: event.systemPrompt.replace("每轮用户消息末尾附有以", "每轮用户消息开头附有以")};
      });
      const roots = await seedHistory(frames, hosted.sessionId, !!scenario.legacyPending, !!scenario.candidatePending);
      if (seedChat) for (const turn of seedChatTemplates(roots)) {
        await hosted.lane.appendMessage({role: "user", content: turn.user, timestamp: Date.now()}, BACKGROUND_CONTEXT);
        await hosted.lane.appendMessage({role: "assistant", content: [{type: "text", text: turn.assistant}],
          api: "openai-completions", provider: "synthetic", model: "synthetic", stopReason: "stop", timestamp: Date.now(),
          usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}}, BACKGROUND_CONTEXT);
      }
      if (scenario.legacyPending || scenario.candidatePending) {
        const pending = await frames.get((await frames.state()).focusFrameId!);
        const previousQuestion = scenario.candidatePending ? "把机构换成合成简称，原指标和日期不变，继续排名。" : "对以上三家机构进行排名";
        const proposal = scenario.candidatePending ? renderClarificationOptions(frameClarificationOptions(pending!))
          : "请确认是否是合成机构甲、合成机构乙、合成机构丙。";
        await hosted.lane.appendMessage({role: "user", content: previousQuestion, timestamp: Date.now()}, BACKGROUND_CONTEXT);
        await hosted.lane.appendMessage({role: "assistant", content: [{type: "text", text: proposal}],
          api: "openai-completions", provider: "synthetic", model: "synthetic", stopReason: "stop", timestamp: Date.now(),
          usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}}, BACKGROUND_CONTEXT);
      }
      const queries: BasicQuerySpec[] = [];
      const authorizedLookups: Array<{entity: string; raw: string[]}> = [];
      const backend = {
        resolveBusinessField: async (entity: string, raw: string[]) => {authorizedLookups.push({entity, raw}); return resolveCatalog(entity, raw);},
        matchMetricQuestion: async (question: string) => ({mentions: question.includes(METRIC)
          ? [{text: METRIC, start: question.indexOf(METRIC), end: question.indexOf(METRIC) + METRIC.length,
            resolution: {status: "resolved", value: {codes: ["M1"], names: [METRIC]}}}] : []}),
        createAgentQueryContext: async () => ({conversation_id: "synthetic-reference-recovery"}),
        basicQueries: async (spec: BasicQuerySpec) => {
          queries.push(structuredClone(spec));
          const task = `synthetic-${queries.length}`;
          return {query: spec, result: {task_id: task, result_id: `result:${task}`, status: "succeeded", rows: [], columns: [],
            row_count: 0, message: "隔离合成查询已完成，无记录。", evidence: {logical_dsl: {metrics: spec.metric_codes, orgs: spec.org_codes, time: spec.time}}}};
        },
        getTask: async (task_id: string) => ({task_id, status: "SUCCEEDED", version: 1,
          result: {result_id: task_id.startsWith("seed-") ? "result" : `result:${task_id}`}}),
        getTaskResult: async (task_id: string) => ({task_id, result_id: task_id.startsWith("seed-") ? "result" : `result:${task_id}`,
          status: "succeeded", rows: [], columns: [], row_count: 0, has_more: false, offset: 0, message: "合成历史结果，无记录。"}),
      } as unknown as BackendClient;
      const turns: Array<Record<string, unknown>> = [];
      const started = performance.now();
      for (const [index, step] of scenario.steps.entries()) {
        const requestId = `${scenario.name}-${index + 1}`;
        const before = queries.length;
        const turnStarted = performance.now();
        let failure: string | undefined;
        let completion: unknown;
        let deadlineExceeded = false;
        let abortFailure: string | undefined;
        try {
          const admitted = await host.admitPrompt(hosted, {protocol_version: 3, request_id: requestId, message: step.message}, {actor, backend});
          assert.ok(admitted.ok, "验收回合必须成功接纳");
          // 使用与页面停止一致的原生取消入口，保留已执行回执；持续输出计划也有明确验收时限。
          const timer = setTimeout(() => {deadlineExceeded = true; void host.abort(hosted, admitted.operationId)
            .catch(error => {abortFailure = error instanceof Error ? error.message : String(error);});}, turnTimeoutMs);
          let outcome: Awaited<ReturnType<HarnessHost["drivePrompt"]>>;
          try {outcome = await host.drivePrompt(hosted, admitted);} finally {clearTimeout(timer);}
          completion = {...outcome, validation_deadline_exceeded: deadlineExceeded, ...(abortFailure ? {abort_failure: abortFailure} : {})};
          assert.ok(!deadlineExceeded, `VALIDATION_TURN_DEADLINE: 超过 ${turnTimeoutMs} ms，已原生取消本回合`);
          assert.ok(outcome.ok && outcome.outcome.kind === "settled" && outcome.outcome.outcome.status === "completed", "用户回合必须正常结束");
        } catch (error) {failure = error instanceof Error ? error.message : String(error);}
        const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
        const userIndex = entries.map(entry => entry.type === "message" && entry.message.role === "user").lastIndexOf(true);
        const turnEntries = entries.slice(userIndex);
        const messages = turnEntries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
        const calls = messages.flatMap(message => message.role === "assistant" ? message.content
          .filter(block => block.type === "toolCall").map(block => ({name: block.name, args: block.arguments})) : []);
        const receipts = messages.flatMap(message => message.role === "toolResult"
          ? [{name: message.toolName, details: message.details, text: message.content.filter(block => block.type === "text").map(block => block.text).join("\n")}] : []);
        const finalAnswer = projectEntries(turnEntries).filter(item => item.role === "assistant" && item.text.trim()).at(-1);
        const state = await frames.state();
        const focus = state.focusFrameId ? await frames.get(state.focusFrameId) : undefined;
        const turnFrames = (await frames.list()).filter(frame => frame.requestId === requestId);
        try {
          if (failure) throw new Error(failure);
          if (stateFirstLayout) {
            assert.ok(layoutProof.length > 0, "布局测试 hook 必须实际生效");
            assert.ok(layoutProof.every(proof => proof.state_index_after === 0 && proof.original_user_preserved && proof.suffix_preserved));
            const storedUser = messages.find(message => message.role === "user");
            assert.ok(storedUser?.role === "user");
            assert.equal(storedUser.content, step.message, "布局测试不能改写 native 用户输入");
          }
          assert.ok(finalAnswer?.role === "assistant" && finalAnswer.text.trim(), "必须有本轮用户可见回复");
          assert.equal(queries.length - before, step.queryCount, "业务查询次数");
          assert.deepEqual(focus?.fields.metrics?.resolvedValue, {codes: ["M1"], names: [METRIC]}, "指标必须完整继承");
          const expectedDate = step.date ?? DATE;
          assert.deepEqual(focus?.fields.time?.resolvedValue, {start: expectedDate, end: expectedDate}, "日期必须按本轮变化或完整继承");
          const references = calls.filter(call => call.name === "resolve_business_turn").map(call => historyInput(call.args)).filter(Boolean) as HistoryFieldReferenceInput[];
          if (step.historyReference === "union") {
            const reference = references.find(item => item.combine === "union");
            assert.ok(reference && reference.sources.length >= 2, "并集须提交多个结构化历史来源");
            assert.ok(reference.sources.every(source => source.field === "organizations"), "引用目标只能是机构字段");
            assert.ok(step.message.includes(reference.sourceText), "引用依据必须来自本轮原文");
            if (step.expectedCount) {
              const call = calls.find(item => historyInput(item.args) === reference) ?? calls.find(item => {
                const raw = historyInput(item.args);
                return raw?.combine === "union" && raw.sources.length >= 2;
              });
              const intent = (call?.args as {fieldIntents?: {organizations?: {expectedCount?: number}}} | undefined)?.fieldIntents?.organizations;
              assert.equal(intent?.expectedCount, step.expectedCount, "目标声明不能丢弃用户明确数量");
              if (reference.expectedCount !== undefined) assert.equal(reference.expectedCount, intent.expectedCount, "引用与目标声明的数量必须一致");
            }
          }
          if (step.historyReference === "single_or_base") {
            const resolves = calls.filter(call => call.name === "resolve_business_turn");
            assert.ok(references.some(reference => reference.combine === "single" && reference.sources.length === 1)
              || resolves.some(call => {
                const args = call.args as {baseReference?: {frameId?: string; ordinal?: number}; base?: {frameId?: string; ordinal?: number}};
                const base = args.baseReference ?? args.base;
                return base?.frameId === roots[0]!.frameId || base?.ordinal === 1;
              }), "单源须正确引用第一笔或从第一笔继承");
          }
          if (step.historyReference === "union_with_add") {
            const reference = references.find(item => item.combine === "union" && item.add?.includes("合成机构丁"));
            assert.ok(reference && reference.sources.length === 1, "历史加新机构须提交单个历史来源及 add");
            assert.equal(reference.sources[0]!.field, "organizations");
            assert.ok(step.message.includes(reference.sourceText));
            assert.deepEqual(reference.add, ["合成机构丁"], "add 只能包含本轮新增机构，不能展开历史名单");
          }
          if (step.confirmationEvidence) {
            const confirmation = calls.filter(call => call.name === "resolve_business_turn").map(call => organizationInput(call.args))
              .find(raw => !!raw && typeof raw === "object" && (raw as {confirm?: unknown}).confirm === true) as
              {confirm: true; evidence?: {decision?: string; sourceText?: string}} | undefined;
            assert.ok(confirmation, "复合肯定必须通过已存候选确认契约");
            assert.equal(confirmation.evidence?.decision, "accept");
            assert.ok(confirmation.evidence?.sourceText && step.message.includes(confirmation.evidence.sourceText), "确认语义必须锚定本轮同意片段");
            assert.equal(focus?.fields.organizations?.source, "confirmed");
          }
          if (step.queryCount === 1) {
            const spec = queries.at(-1)!;
            sameCodes(spec.org_codes, step.orgs!);
            assert.deepEqual(spec.metric_codes, ["M1"]);
            assert.deepEqual(spec.time, {start: expectedDate, end: expectedDate});
            assert.equal(spec.selection, "exact");
            assert.equal(spec.operation?.kind, "ranking", "不得丢弃排名目标");
            assert.equal(focus?.status, "success", "最终 Frame 必须成功");
            sameCodes((focus?.fields.organizations?.resolvedValue as {codes?: string[]})?.codes, step.orgs!);
            assert.ok(turnFrames.some(frame => frame.status === "success"), "成功必须有本轮持久化证据");
          } else {
            assert.ok(!turnFrames.some(frame => ["executing", "success"].includes(frame.status)), "澄清不得登记执行或成功");
            assert.equal(focus?.status, "clarifying", "未确定机构必须留在澄清状态");
            assert.notEqual(focus?.fields.organizations?.resolutionStatus, "resolved", "不能用纯确认制造已解析机构");
            const resolveCalls = calls.filter(call => call.name === "resolve_business_turn");
            // 模型结构错误可以修正；用户条件不完整必须转澄清，不能以参数错误上限的兜底停机冒充恢复。
            const clarificationIndex = messages.findIndex(message => message.role === "toolResult" && message.toolName === "resolve_business_turn"
              && (message.details as {status?: string} | undefined)?.status === "NEEDS_CLARIFICATION");
            assert.ok(resolveCalls.length === 0 || clarificationIndex >= 0, "需要用户补充时须落地澄清回执，不能循环参数错误后兜底停止");
            if (clarificationIndex >= 0) assert.ok(!messages.slice(clarificationIndex + 1).some(message => message.role === "assistant"
              && message.content.some(block => block.type === "toolCall" && block.name === "resolve_business_turn")),
              "收到需用户澄清回执后不得继续自动解析");
          }
        } catch (error) {failure = error instanceof Error ? error.message : String(error);}
        turns.push({request_id: requestId, message: step.message, passed: !failure, ...(failure ? {failure} : {}),
          completion, expected: {query_count: step.queryCount, org_codes: step.orgs ?? null, metric_codes: ["M1"],
            time: {start: step.date ?? DATE, end: step.date ?? DATE}, history_reference: step.historyReference ?? null},
          elapsed_ms: Math.round(performance.now() - turnStarted), validation_deadline_exceeded: deadlineExceeded,
          query_count: queries.length - before, calls, receipts,
          query_specs: queries.slice(before), focus, turn_frames: turnFrames,
          answer: finalAnswer?.role === "assistant" ? finalAnswer.text : null});
        console.log(JSON.stringify({case: scenario.name, turn: index + 1, passed: !failure, failure,
          query_count: queries.length - before, tools: calls.map(call => call.name)}));
        if (step.reopenAfter) {
          const expectedFocus = state.focusFrameId;
          await host.closeSession(hosted.sessionId);
          hosted = (await host.openSession(actor, hosted.sessionId))!;
          frames = new NativeFrameStore(hosted.session);
          assert.equal((await frames.state()).focusFrameId, expectedFocus, "重开必须保留澄清焦点");
        }
      }
      reports.push({name: scenario.name, passed: turns.every(turn => turn.passed), elapsed_ms: Math.round(performance.now() - started),
        queries, authorized_lookups: authorizedLookups, turns});
      await host.closeSession(hosted.sessionId);
    }
    const passed = reports.length > 0 && reports.every(report => report.passed);
    const baseline = baselinePath ? JSON.parse(await readFile(resolve(baselinePath), "utf8")) as {reports: Array<{name: string; passed: boolean; turns: Array<{failure?: string; query_count: number}>}>} : undefined;
    const firstRun = baseline ? {source: baselinePath, cases: baseline.reports.length, passed_cases: baseline.reports.filter(item => item.passed).length,
      note: "首轮数量不符 case 曾使用过严的最多一次解析断言；当前按澄清回执之后不得重试的契约检查，其余业务断言未放宽。",
      reports: baseline.reports.map(item => ({name: item.name, passed: item.passed,
        failures: item.turns.flatMap(turn => turn.failure ? [turn.failure] : []), query_counts: item.turns.map(turn => turn.query_count)}))} : undefined;
    const report = {environment: "configured_model_synthetic_backend", created_at: new Date().toISOString(), model: config.model.name,
      compact_turn_args: !!config.compactTurnArgs, model_called: true, real_database_verified: false, production_accessed: false,
      model_max_tokens: config.model.maxTokens, validation_turn_timeout_ms: turnTimeoutMs,
      fixture_mode: seedChat ? "seeded_chat" : "index_only",
      fixture_comparison: seedChat ? "independent diagnostic; not paired with index-only acceptance" : "unchanged index-only stress fixture",
      context_layout: stateFirstLayout ? "state_first_test_hook" : "default_production",
      ...(stateFirstLayout ? {layout_proof: layoutProof,
        layout_diagnostic_note: "Uses current generic history-source/base contract clarification; not a single-variable paired comparison with earlier full8."} : {}),
      fixture_scope: "two historical operations with O1 and O2+O3; M1; 2026-07-31; legacy pending has no candidates; current addition O4; single stored proposal O3 with date change 2026-08-31",
      session_data: dir, ...(firstRun ? {first_run: firstRun} : {}), passed, reports};
    const reportBase = customReportBase ? resolve(customReportBase) : stateFirstLayout ? join(dir, "state-first-layout-report") : seedChat ? join(dir, "seeded-chat-report")
      : resolve(import.meta.dirname, "../../docs/verification/history-reference-recovery-20261013");
    await mkdir(dirname(reportBase), {recursive: true});
    await writeFile(`${reportBase}.json`, JSON.stringify(report, null, 2));
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    const lines = reports.map(item => {const prior = baseline?.reports.find(previous => previous.name === item.name);
      return `| ${item.name} | ${prior ? prior.passed ? "通过" : "失败" : "新增"} | ${item.passed ? "通过" : "失败"} | ${(item.turns as Array<Record<string, unknown>>).map(turn => `${turn.query_count} 次查询`).join("；")} |`;});
    const baselineText = firstRun ? `首轮 ${firstRun.cases} 个 case 中 ${firstRun.passed_cases} 个通过。失败包括机构被误继承、错误新建来源导致参数修复循环、空候选确认循环。${firstRun.note}\n\n` : "";
    const fixtureText = seedChat ? "seeded-chat 独立诊断：在同样 Frame 之外补入两笔对应的用户与助手历史聊天；不与 index-only 压力样本作配对改善比较。"
      : "index-only 压力样本：两笔业务历史只有可信 Frame 索引；旧空候选和单候选场景另包含待确认的用户与助手消息。";
    await writeFile(`${reportBase}.md`, `# 历史引用、确认和恢复的真实模型验收\n\n时间：${report.created_at}\n\n模型：${report.model}；compact 参数：${report.compact_turn_args}。\n\n仅调用配置模型；所有目录、权限、查询、结果读取均为隔离合成桩，未访问生产业务服务或真实数据库。\n\n${fixtureText}\n\n${baselineText}| 场景 | 首轮 | 本轮 | 本轮实际业务调用 |\n| --- | --- | --- | --- |\n${lines.join("\n")}\n\n通过条件同时检查模型工具参数、正式查询 spec、持久化 Frame、业务查询次数和重开后的状态。零查询场景不能进入执行或成功；模型结构错误允许受控修正，收到需用户澄清回执后不得继续自动解析。详细参数和失败原因见 [JSON 报告](${basename(reportBase)}.json)。\n\n本次只证明这些合成样本下的配置模型和本地宿主行为，不代表生产部署、真实目录或数据库验收。\n`);
    console.log(JSON.stringify({passed, cases: reports.length, report: `${reportBase}.json`, model: config.model.name}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await sessions.close();}
}

await main();
