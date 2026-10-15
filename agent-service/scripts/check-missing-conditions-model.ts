/** 同一真实模型的缺项/继承回归；业务目录和SQL全部隔离，不连接业务数据库。 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, mkdtemp} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core';
import type {BackendClient, BackendUser} from '../src/backendClient.js';
import {assertSuccessfulQueryEvidence, assertSuccessfulQueryFrames, authoritativeAnswer, assertAuthoritativeAnswer, type EvidenceQuery} from './model-evidence-assertions.js';

assert(process.argv.includes('--live'), '真实模型验证须显式传入 --live');
const arg = (key: string, fallback: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const sourceRoot = resolve(arg('source-root', '.'));
const report = resolve(arg('report', '../docs/verification/missing-conditions-loop-20261015/after.json'));
const selected = new Set(arg('cases', '').split(',').filter(Boolean));
const imports = await Promise.all(['config', 'models', 'harnessHost', 'nativeSessions', 'businessSkills', 'sessionProjection', 'tools/index', 'semantic-task/feedback', 'semantic-task/store', 'backendClient'].map(name => import(pathToFileURL(join(sourceRoot, 'src', `${name}.ts`)).href)));
const [{loadConfig}, {createAskMetricModels}, {HarnessHost}, {NativeSessionStore}, {loadBusinessSkills, createBusinessSkillReadTool}, {projectEntries}, {createAskMetricTools}, {isSemanticFeedback}, {NativeSemanticTaskStore}, {BackendApiError}] = imports;
const config = loadConfig();
const cache = new Map<string, any>();
const fixture = join(import.meta.dirname, 'missing-conditions-fixture.py');
const pythonPath = resolve('../backend-next/.venv/bin/python');
function python(payload: Record<string, unknown>) {
  const key = JSON.stringify(payload);
  if (payload.action !== 'query' && cache.has(key)) return structuredClone(cache.get(key));
  const out = JSON.parse(execFileSync(pythonPath, [fixture], {input: key, encoding: 'utf8', timeout: 30000,
    maxBuffer: 4 * 1024 * 1024, env: {PATH: '/usr/bin:/bin:/opt/homebrew/bin'}}));
  if (!out.ok) throw new BackendApiError(422, out.message, out.error);
  if (payload.action !== 'query') cache.set(key, out.value);
  return out.value;
}
const metrics = [
  {metric_code: 'SYNTH_M:D', metric_name: '经营收益金额当日数', unit: '元', score: 1, match_type: 'exact'},
  {metric_code: 'SYNTH_M:Y', metric_name: '经营收益金额较同期', unit: '元', score: 1, match_type: 'exact'},
  {metric_code: 'SYNTH_DEPOSIT:D', metric_name: '对公协定存款余额当日数', unit: '元', score: 1, match_type: 'exact'},
];
function backend() {
  const queries: any[] = [], results = new Map<string, any>();
  const client = {
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, year?: number, source?: unknown) => python({action: 'resolve', entity, raw, year, source}),
    inspectBusinessGoal: async (question: string, businessDate: string, _options?: unknown, reference_year?: number) => python({action: 'inspect', question, business_date: businessDate, reference_year}),
    admitSemanticPlan: async (payload: unknown) => python({action: 'admit', payload}),
    matchMetricQuestion: async (question: string) => python({action: 'mentions', question}),
    metricCatalogOverview: async () => ({total: metrics.length, groups: [{unit: '元', count: metrics.length, examples: metrics.map(m => ({code: m.metric_code, name: m.metric_name}))}]}),
    searchMetrics: async (keyword: string) => ({total: metrics.filter(m => m.metric_name.includes(keyword)).length, items: metrics.filter(m => m.metric_name.includes(keyword)), semantic_suggestions: []}),
    searchOrganizations: async (keyword: string) => {const items = ['甲', '乙', '丙', '丁'].map((name, index) => ({org_code: `SYNTH_O${index + 1}`, org_name: `合成机构${name}`, score: 1, match_type: 'exact'})).filter(o => o.org_name.includes(keyword)); return {total: items.length, items};},
    createAgentQueryContext: async () => ({conversation_id: 'synthetic-semantic'}),
    basicQueries: async (spec: any) => {
      const row: any = {spec}; queries.push(row);
      const actual = python({action: 'query', spec}), id = `query-${queries.length}`;
      const result = {status: 'succeeded', task_id: id, result_id: `result-${id}`, rows: actual.rows,
        columns: Object.keys(actual.rows[0] ?? {}), row_count: actual.rows.length, truncated: false,
        facts: actual.rows.flatMap((r: any, index: number) => r.metric_value == null ? [] : [{fact_id: `fact:${id}:${index}:metric_value`, task_id: id, field: 'metric_value', value: String(r.metric_value), unit: r.unit ?? '元', metric_code: r.metric_code, org_code: r.org_code, date: r.stat_date}])};
      row.row_count = actual.rows.length; row.result_ref = `query:${id}:${result.result_id}`; results.set(id, result); return {query: spec, result};
    },
    getTask: async (id: string) => {if (!results.has(id)) throw new BackendApiError(404, '合成任务不存在', 'TASK_NOT_FOUND'); return {task_id: id, status: 'SUCCEEDED', version: 1, result: {result_id: `result-${id}`}};},
    getTaskResult: async (id: string) => {if (!results.has(id)) throw new BackendApiError(404, '合成结果不存在', 'RESULT_NOT_FOUND'); return results.get(id);},
  } as unknown as BackendClient;
  return {client, queries};
}
type Expected = {status: string | string[]; missing?: string[]; metric?: string; metrics?: string[]; org?: string; day?: string;
  queries?: EvidenceQuery[]; no_query?: boolean; allow_evidence_reuse?: boolean; evidence_queries?: EvidenceQuery[];
  /** 真歧义场景允许Pi直接追问；每组别名代表一个必须出现在追问中的候选目标。 */
  clarification?: {options: string[][]; question_markers: string[]}};
type Scenario = {id: string; messages: string[]; expected: Expected[]};
const success = (metric = 'SYNTH_M:D', org = 'SYNTH_O1', day = '2026-05-31'): Expected => ({status: 'succeeded', metric, org, day});
const missing = (...fields: string[]): Expected => ({status: 'needs_user', missing: fields});
const defaultScenarios: Scenario[] = [
  ...[1, 2, 3].map(i => ({id: `original-missing-both-${i}`, messages: ['帮我查对公协定存款余额当日数'], expected: [missing('organizations', 'time')]})),
  {id: 'other-metric-missing-both', messages: ['查询经营收益金额当日数'], expected: [missing('organizations', 'time')]},
  {id: 'missing-date', messages: ['查合成机构甲的经营收益金额当日数'], expected: [missing('time')]},
  {id: 'missing-organization', messages: ['查2026年5月31日的经营收益金额当日数'], expected: [missing('organizations')]},
  {id: 'supplement-and-inherit', messages: ['查询经营收益金额当日数', '机构用合成机构甲', '日期用2026年5月31日', '再查对公协定存款余额当日数'], expected: [missing('organizations', 'time'), missing('time'), success(), success('SYNTH_DEPOSIT:D')]},
  {id: 'confirmed-prepare-inherit', messages: ['准备合成机构乙2026年6月30日的经营收益金额当日数查询条件，先不要执行', '查询对公协定存款余额当日数'], expected: [{status: 'prepared'}, success('SYNTH_DEPOSIT:D', 'SYNTH_O2', '2026-06-30')]},
  {id: 'partially-confirmed-inherit', messages: ['查合成机构甲的经营收益金额当日数', '改查对公协定存款余额当日数'], expected: [missing('time'), missing('time')]},
  {id: 'confirmed-multiple-new-metrics', messages: ['准备合成机构乙2026年6月30日的经营收益金额当日数查询条件，先不要执行', '分别查询对公协定存款余额当日数和经营收益金额较同期'], expected: [{status: 'prepared'}, {status: 'succeeded', metrics: ['SYNTH_DEPOSIT:D', 'SYNTH_M:Y'], org: 'SYNTH_O2', day: '2026-06-30'}]},
  {id: 'explicit-clear-date', messages: ['查合成机构甲2026年5月31日的经营收益金额当日数', '清除日期，保留机构和指标', '日期用2026年6月30日'], expected: [success(), missing('time'), success('SYNTH_M:D', 'SYNTH_O1', '2026-06-30')]},
  {id: 'complete-direct-query', messages: ['查合成机构甲2026年5月31日的经营收益金额当日数'], expected: [success()]},
];
const scenarioPath = arg('scenarios', '');
const scenarios: Scenario[] = scenarioPath ? JSON.parse(await readFile(resolve(scenarioPath), 'utf8')) : defaultScenarios;
assert(Array.isArray(scenarios) && scenarios.every(s => typeof s.id === 'string' && Array.isArray(s.messages)
  && s.messages.every(m => typeof m === 'string') && s.expected.length === s.messages.length), 'SCENARIO_CONTRACT');
const repeats = Number(arg('repeat', '1'));
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, 'REPEAT_RANGE');
const runScenarios = Array.from({length: repeats}, (_, repetition) => scenarios.filter(s => !selected.size || selected.has(s.id))
  .map(s => ({...s, repetition: repetition + 1}))).flat();
const directory = await mkdtemp(join(tmpdir(), 'missing-conditions-model-'));
const sessions = new NativeSessionStore(directory), skills = await loadBusinessSkills();
const local = {...config, dataDir: directory, businessProtocol: 'semantic_v2'};
const host = new HarnessHost(local, (association: any) => createAskMetricModels(local, association), sessions,
  [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
const actor: BackendUser = {id: 'synthetic-semantic', username: 'synthetic', display_name: '缺项循环合成验收', org_code: 'SYNTH_ROOT', org_name: '合成集团', role_code: 'USER'};
const turns: any[] = [];
let gatewayBlocked = false;
const sourceHashes = Object.fromEntries(await Promise.all(['src/harnessHost.ts', 'src/semantic-task/store.ts', 'src/semantic-task/service.ts', 'src/semantic-task/planService.ts', 'src/semantic-task/tools.ts', 'src/semantic-task/protocol.ts', 'src/semantic-task/feedback.ts', 'src/semantic-task/prompt.ts', 'src/semantic-task/transition.ts', 'src/semantic-task/display.ts'].map(async p => [p, createHash('sha256').update(await readFile(join(sourceRoot, p))).digest('hex')])));
try {sourceHashes['src/semantic-task/turnContext.ts'] = createHash('sha256').update(await readFile(join(sourceRoot, 'src/semantic-task/turnContext.ts'))).digest('hex');} catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
// Python桥始终调用当前后端源码，因此报告必须同时记录它，不能把不同版本混为一次验收。
for (const path of ['scripts/check-missing-conditions-model.ts', 'scripts/model-evidence-assertions.ts', 'scripts/missing-conditions-fixture.py', 'scripts/semantic-task-fixture.py', '../backend-next/src/ask_metric/application/goal_facts.py', '../backend-next/src/ask_metric/application/semantic_transition.py', '../backend-next/src/ask_metric/application/analysis_selection.py', '../backend-next/src/ask_metric/api/routes/business_context.py']) {
  sourceHashes[path] = createHash('sha256').update(await readFile(resolve(path))).digest('hex');
}
async function save() {await mkdir(dirname(report), {recursive: true}); await writeFile(report, JSON.stringify({
  environment: 'real_model_synthetic_catalog_in_memory_SQL', real_database: false, source_root: sourceRoot, source_hashes: sourceHashes,
  model: config.model.name, gateway_origin: new URL(config.model.baseUrl).origin,
  model_settings: {max_tokens: config.model.maxTokens, context_window: config.model.contextWindow,
    extra_body: Object.fromEntries(Object.entries(config.model.extraBody).filter(([key]) => ['temperature', 'top_p', 'top_k', 'seed', 'enable_thinking', 'thinking', 'reasoning_effort'].includes(key))),
    retry: config.modelRetry, first_response_timeout_ms: config.modelFirstResponseTimeoutMs, stream_idle_timeout_ms: config.modelStreamIdleTimeoutMs},
  native_session_directory: directory, repetitions: repeats, scenario_file: scenarioPath || null, planned_turns: runScenarios.reduce((n, s) => n + s.messages.length, 0),
  gateway_blocked: gatewayBlocked, total: turns.length, passed: turns.filter(t => t.passed).length, turns,
}, null, 2));}
try {
  scenariosLoop: for (const scenario of runScenarios) {
    const hosted = await host.createSession(actor), b = backend();
    const priorFrames = new Map<string, {fields: string; frame: string}>();
    try {
      for (const [index, message] of scenario.messages.entries()) {
        const expected = scenario.expected[index]!, before = b.queries.length, started = performance.now();
        let failure: string | undefined, guardAborted = false;
        const admission = await host.admitPrompt(hosted, {protocol_version: 3, request_id: `${scenario.id}-${index}`, message}, {actor, backend: b.client});
        assert(admission.ok);
        // 验收预算只防止失败基线消耗模型费用，业务修复不调整任何超时或重试配置。
        const timer = setTimeout(() => {guardAborted = true; void host.abort(hosted, admission.operationId);}, Number(arg('guard-ms', '90000')));
        try {const result = await host.drivePrompt(hosted, admission); assert(result.ok && result.outcome.kind === 'settled' && result.outcome.outcome.status === 'completed', 'TURN_COMPLETED');}
        catch (e) {failure = e instanceof Error ? e.message : String(e);} finally {clearTimeout(timer);}
        const entries = await hosted.lane.findEntries({order: 'oldestFirst'}, BACKGROUND_CONTEXT);
        const start = entries.map((e: any) => e.type === 'message' && e.message.role === 'user').lastIndexOf(true);
        const current = entries.slice(start), messages = current.flatMap((e: any) => e.type === 'message' ? [e.message] : []);
        const receipts = messages.flatMap((m: any) => m.role === 'toolResult' ? [{name: m.toolName, details: m.details, is_error: !!m.isError}] : []);
        const calls = messages.flatMap((m: any) => m.role === 'assistant' ? m.content.filter((c: any) => c.type === 'toolCall').map((c: any) => ({name: c.name, args: c.arguments})) : []);
        const modelErrorCodes = messages.flatMap((m: any) => m.role === 'assistant' && ['error', 'aborted'].includes(m.stopReason)
          ? [/^(\d{3})\b/u.exec(m.errorMessage ?? '')?.[1] ? `HTTP_${/^(\d{3})\b/u.exec(m.errorMessage)![1]}` : 'MODEL_TRANSPORT_ERROR'] : []);
        gatewayBlocked = modelErrorCodes.some((code: string) => ['HTTP_401', 'HTTP_402', 'HTTP_403'].includes(code));
        const formal = receipts.filter((r: any) => isSemanticFeedback(r.details)).at(-1)?.details;
        const delivery = authoritativeAnswer(projectEntries(current));
        const answer = delivery.final?.text ?? '';
        const finalModelMessage = messages.filter((message: any) => message.role === 'assistant').at(-1);
        const queries = b.queries.slice(before);
        const actualStatus = formal?.status ?? (expected.clarification && answer.trim() && !modelErrorCodes.length ? 'clarification' : undefined);
        try {
          const statuses = Array.isArray(expected.status) ? [...expected.status] : [expected.status];
          if (expected.allow_evidence_reuse && queries.length === 0 && statuses.includes('succeeded')) statuses.push('reused');
          assert(!guardAborted, 'TEST_GUARD_ABORTED'); assertAuthoritativeAnswer(delivery, finalModelMessage); assert(statuses.includes(actualStatus), 'FORMAL_STATUS');
          if (expected.clarification) {
            assert.equal(queries.length, 0, 'AMBIGUITY_MUST_NOT_EXECUTE');
            assert(expected.clarification.options.length >= 2 && expected.clarification.options.every(aliases => aliases.length > 0), 'CLARIFICATION_OPTIONS_CONTRACT');
            if (formal) {assert.equal(formal.status, 'needs_user', 'CLARIFICATION_STATUS'); assert.equal(formal.continuation.actor, 'user', 'CLARIFICATION_USER_RESPONSIBILITY');}
            assert(!receipts.some((receipt: any) => receipt.is_error), 'CLARIFICATION_NOT_TOOL_FAILURE');
            assert(expected.clarification.options.every(aliases => aliases.some(alias => answer.includes(alias))), 'CLARIFICATION_NAMES_ACTUAL_OPTIONS');
            assert(expected.clarification.question_markers.some(marker => answer.includes(marker)), 'CLARIFICATION_ACTUALLY_ASKS');
          } else if (expected.missing) {
            assert.equal(formal.continuation.actor, 'user', 'USER_RESPONSIBILITY'); assert.equal(queries.length, 0, 'NO_PREMATURE_EXECUTION');
            for (const field of expected.missing) assert(formal.issues.some((issue: any) => issue.field === field && issue.remediation === 'user'), `MISSING_${field}`);
            assert.deepEqual([...new Set(formal.issues.filter((issue: any) => issue.remediation === 'user').map((issue: any) => issue.field))].sort(), [...expected.missing].sort(), 'ONLY_ACTUAL_MISSING_FIELDS');
            const waiting = receipts.findIndex((r: any) => isSemanticFeedback(r.details) && r.details.status === 'needs_user');
            assert.equal(receipts.slice(waiting + 1).filter((r: any) => r.name === 'read' || r.name === 'business_context_read').length, 0, 'NO_HISTORY_AFTER_WAITING');
          } else if (expected.allow_evidence_reuse && queries.length === 0) {
            const identities = expected.queries ?? (expected.metrics ?? [expected.metric]).map(metric => ({metric: metric!, org: expected.org!, day: expected.day!}));
            assert(identities.length && identities.every(identity => identity.metric && identity.org && identity.day), 'REUSE_EXPECTED_IDENTITY_REQUIRED');
            assertSuccessfulQueryEvidence(formal, identities);
          } else if (expected.no_query) {
            assert.equal(queries.length, 0, 'HISTORY_DOES_NOT_REQUERY');
            assert(expected.evidence_queries?.length, 'HISTORY_EXPECTED_IDENTITY_REQUIRED');
            assertSuccessfulQueryEvidence(formal, expected.evidence_queries);
          } else if (expected.status === 'succeeded') {
            if (expected.queries) {
              const actual = queries.flatMap(q => q.spec.metric_codes.flatMap((metric: string) => q.spec.org_codes.map((org: string) => ({metric, org, day: q.spec.time.start, end: q.spec.time.end}))));
              const tuple = (v: {metric: string; org: string; day: string}) => JSON.stringify([v.metric, v.org, v.day]);
              assert.deepEqual(actual.map(tuple).sort(), expected.queries.map(tuple).sort(), 'EXACT_BOUND_TARGETS');
              assert(actual.every(v => v.day === v.end), 'EXACT_SINGLE_DAYS');
            } else if (expected.metrics) {
              assert(queries.length >= 1 && queries.length <= expected.metrics.length, 'ONLY_REQUIRED_EXECUTIONS');
              assert.deepEqual(queries.flatMap(q => q.spec.metric_codes).sort(), [...expected.metrics].sort(), 'ALL_METRICS_ONCE');
            } else {assert.equal(queries.length, 1, 'ONE_EXECUTION'); assert.deepEqual(queries[0].spec.metric_codes, [expected.metric]);}
            if (!expected.queries) for (const query of queries) {assert.deepEqual(query.spec.org_codes, [expected.org]); assert.equal(query.spec.time.start, expected.day); assert.equal(query.spec.time.end, expected.day);}
            const identities = expected.queries ?? (expected.metrics ?? [expected.metric]).map(metric => ({metric: metric!, org: expected.org!, day: expected.day!}));
            assertSuccessfulQueryEvidence(formal, identities);
          } else assert.equal(queries.length, 0, 'PREPARE_DOES_NOT_EXECUTE');
        } catch (e) {failure ??= e instanceof Error ? e.message : String(e);}
        const store = new NativeSemanticTaskStore(hosted.session), plan = await store.plan((await store.planIndex()).focus ?? '');
        const frames: any[] = [];
        try {
          const frameState = await admission.request.frames!.state();
          for (const [id, hashes] of priorFrames) {
            assert(frameState.frameOrder.includes(id), 'HISTORY_FRAME_ORDER_LOST');
            const old = await admission.request.frames!.get(id); assert(old, 'HISTORY_FRAME_MISSING');
            assert.equal(createHash('sha256').update(JSON.stringify(old.fields)).digest('hex'), hashes.fields, 'HISTORY_FRAME_MUTATED');
            assert.equal(createHash('sha256').update(JSON.stringify(old)).digest('hex'), hashes.frame, 'HISTORY_FRAME_OR_EVIDENCE_MUTATED');
          }
          const allFrames: any[] = [];
          // 核验整个原生Frame账本；焦点移动不能漏掉旧目标、结果和中间执行快照。
          for (const id of frameState.frameOrder) {
            const frame = await admission.request.frames!.get(id); assert(frame, 'FRAME_NOT_PERSISTED'); allFrames.push(frame);
            const hash = createHash('sha256').update(JSON.stringify(frame.fields)).digest('hex');
            const frameHash = createHash('sha256').update(JSON.stringify(frame)).digest('hex');
            priorFrames.set(id, {fields: hash, frame: frameHash});
            frames.push({frame_id: id, parent_frame_id: frame.parentFrameId, fields_sha256: hash, frame_sha256: frameHash,
              result_ref: frame.resultRef, capability: frame.capability, status: frame.status});
          }
          assertSuccessfulQueryFrames(queries, allFrames);
        } catch(e) {failure ??= e instanceof Error ? e.message : String(e);}
        const turn = {scenario: scenario.id, repetition: scenario.repetition, turn: index + 1, message, expected, passed: !failure, failure, guard_aborted: guardAborted, model_error_codes: modelErrorCodes,
          status: actualStatus, elapsed_ms: Math.round(performance.now() - started), model_calls: admission.request.timings?.model_ms.length,
          history_reads: calls.filter((c: any) => c.name === 'read').length, calls, receipts, queries, frames, preserved_frame_count: priorFrames.size, completion: plan?.completion,
          answer, final_answer_entry: delivery.final?.entry_id, final_model_stop_reason: finalModelMessage?.stopReason,
          delivery_recovered: delivery.recovered, model_recovered: !failure && modelErrorCodes.length > 0,
          intermediate_delivery_errors: delivery.intermediate_errors};
        turns.push(turn); await save(); console.log(JSON.stringify({scenario: turn.scenario, turn: turn.turn, passed: turn.passed, status: turn.status, history_reads: turn.history_reads, elapsed_ms: turn.elapsed_ms, failure}));
        if (gatewayBlocked) break scenariosLoop;
        if (guardAborted) break;
      }
    } finally {await host.closeSession(hosted.sessionId);}
  }
} finally {await save(); await host.close(); await sessions.close();}
if (turns.some(t => !t.passed)) process.exitCode = 1;
