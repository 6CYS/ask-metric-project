/**
 * 同 semantic_v2、当前模型、授权开发数据库的版本配对验收。
 * --freeze 只读取目录/业务数据并创建专用验收任务；--live 才调用真实模型。
 * 令牌只从受保护临时文件读取。报告不写凭据或业务金额，原生记录仅存私有 tmp。
 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, stat, access} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core';

const arg = (key: string, fallback: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const work = resolve(arg('work', '/private/tmp/ask-metric-token-optimization-20261015'));
const corpusPath = resolve(arg('corpus', '../docs/verification/token-optimization-20261015/corpus-v1.json'));
const reportPath = resolve(arg('report', '../docs/verification/token-optimization-20261015/paired.json'));
const baselineRoot = resolve(arg('baseline-root', join(work, 'baseline/agent-service')));
const candidateRoot = resolve(arg('candidate-root', '.'));
const mode = arg('mode', 'paired');
const repeat = Number(arg('repeat', '3'));
const diagnosticRepeat = Number(arg('diagnostic-repeat', String(repeat)));
const caseRepeats = Object.fromEntries(arg('case-repeats', '').split(',').filter(Boolean).map(value => {
  const [id, count] = value.split(':');
  assert(id && /^\d+$/.test(count ?? '') && Number(count) >= 1, 'INVALID_CASE_REPETITIONS');
  return [id, Number(count)];
}));
const stopOnCandidateFailure = process.argv.includes('--stop-on-candidate-failure');
const selected = new Set(arg('cases', '').split(',').filter(Boolean));
const stopFile = resolve(arg('stop-file', join(work, 'stop-paid-matrix')));
const resumePath = arg('resume-report', '');
const scriptSha = createHash('sha256').update(await readFile(import.meta.filename)).digest('hex');
const imports = async (root: string) => {
  const names = ['config', 'models', 'harnessHost', 'nativeSessions', 'businessSkills', 'sessionProjection', 'tools/index',
    'semantic-task/store', 'semantic-task/feedback', 'backendClient', 'routes', 'requestContext', 'modelUsage'];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await import(pathToFileURL(join(root, 'src', `${name}.ts`)).href)])));
};
const current = await imports(candidateRoot);
const loadedConfig = current.config.loadConfig();
const config = {...loadedConfig, backendBaseUrl: arg('backend-base-url', loadedConfig.backendBaseUrl).replace(/\/+$/, '')};
const publicModelSettings = Object.fromEntries(Object.entries(config.model.extraBody).filter(([key]) =>
  ['temperature', 'top_p', 'top_k', 'seed', 'presence_penalty', 'frequency_penalty', 'enable_thinking', 'thinking', 'reasoning_effort'].includes(key)));
assert.equal(new URL(config.backendBaseUrl).hostname, '127.0.0.1', 'ONLY_LOOPBACK_DEVELOPMENT_BACKEND');
assert(['8010', '8015'].includes(new URL(config.backendBaseUrl).port), 'ONLY_CONFIRMED_DEVELOPMENT_BACKEND');
assert(['baseline', 'candidate', 'paired'].includes(mode), 'INVALID_MODE');
assert(Number.isInteger(repeat) && repeat >= 1, 'INVALID_REPETITIONS');
assert(Number.isInteger(diagnosticRepeat) && diagnosticRepeat >= 1 && diagnosticRepeat <= repeat, 'INVALID_DIAGNOSTIC_REPETITIONS');
const canonical = (value: any): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
const hash = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
function decimal(value: any): string | null {
  if (value === null || value === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value)); assert(m, 'EXACT_DECIMAL_REQUIRED');
  const whole = m[2]!.replace(/^0+(?=\d)/, ''), fraction = (m[3] ?? '').replace(/0+$/, '');
  return `${whole === '0' && !fraction ? '' : m[1]}${whole}${fraction ? `.${fraction}` : ''}`;
}
function rowProjection(row: any) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !['task_id', 'result_id', 'query_run_id'].includes(key))
    .map(([key, value]) => [key, key === 'metric_value' ? decimal(value) : value]));
}
const resultHash = (rows: any[]) => hash(rows.map(rowProjection));
const tuple = (t: any) => canonical([t.metric, t.org, t.start, t.end]);
const identity = (metric: string, org: string, start: string, end = start) => ({metric, org, start, end});
const A = '无锡农村商业银行股份有限公司', B = '江苏苏州农村商业银行股份有限公司';
const X = '对公协定存款余额当日数', Y = '个人活期存款余额当日数';
const MX = 'ORG_CORP_AGRMT_DEPT_BAL', MY = 'ORG_PSON_DEDMDPT_BAL';
const first = identity(MX, '01', '2026-05-31');
const scenarios = [
  {id: 'ordinary-multiturn', group: 'ordinary', turns: [
    {message: `查询${A}2026年5月31日的${X}`, expected: [first]},
    {message: '日期改为2026年6月30日，其他条件不变', expected: [identity(MX, '01', '2026-06-30')]},
    {message: `机构改成${B}，其他条件不变`, expected: [identity(MX, '070667800', '2026-06-30')]},
    {message: `指标换成${Y}，其他条件不变`, expected: [identity(MY, '070667800', '2026-06-30')]},
    {message: '重新展示本对话第一次查询的正式结果，不要重新查询', expected: [first], reuse: true},
  ]},
  {id: 'bound-multi-target', group: 'ordinary', turns: [
    {message: `分别查询${A}2026年5月31日的${X}，以及${B}2026年6月30日的${Y}`, expected: [first, identity(MY, '070667800', '2026-06-30')]},
  ]},
  {id: 'multiple-metrics', group: 'ordinary', turns: [
    {message: `查询${A}2026年6月30日的${X}和${Y}`, expected: [identity(MX, '01', '2026-06-30'), identity(MY, '01', '2026-06-30')]},
  ]},
  {id: 'missing-then-confirm', group: 'clarification', turns: [
    {message: `帮我查${X}`, expected: [], missing: ['organizations', 'time']},
    {message: `机构是${A}，日期是2026年5月31日`, expected: [first]},
  ]},
  {id: 'empty-result', group: 'diagnostic', turns: [
    {message: `查询张家港农商行2021年1月1日至2025年12月31日所有日期的${X}`, expected: [identity(MX, '980000', '2021-01-01', '2025-12-31')], empty: true},
  ]},
  {id: 'empty-exact', group: 'boundary', turns: [
    {message: `查询张家港农商行2025年12月31日的${X}`, expected: [identity(MX, '980000', '2025-12-31')], empty: true},
  ]},
  {id: 'calculation-retains-model', group: 'complex', turns: [
    {message: `查询${A}2026年5月31日和2026年6月30日的${X}，计算六月末减五月末的金额差额，并用一句话说明变化方向`, expected: [first, identity(MX, '01', '2026-06-30')], calculation: true},
  ]},
];
if (!process.argv.includes('--live') && !process.argv.includes('--freeze')) {
  const selectedScenarios = scenarios.filter(s => !selected.size || selected.has(s.id));
  const count = (s: typeof scenarios[number]) => caseRepeats[s.id] ?? (s.group === 'diagnostic' ? diagnosticRepeat : repeat);
  const versionCount = mode === 'paired' ? 2 : 1;
  console.log(JSON.stringify({dry_run: true, mode, repeat, scenario_count: selectedScenarios.length,
    repetitions_by_case: Object.fromEntries(selectedScenarios.map(s => [s.id, count(s)])),
    planned_tasks: selectedScenarios.reduce((n, s) => n + count(s), 0) * versionCount,
    planned_turns: selectedScenarios.reduce((n, s) => n + count(s) * s.turns.length, 0) * versionCount,
    token_required: true, real_database: true, backend_origin: new URL(config.backendBaseUrl).origin,
    protocol: 'semantic_v2', model: config.model.name})); process.exit(0);
}
assert(process.argv.includes('--ack-development'), 'DEVELOPMENT_ENVIRONMENT_ACK_REQUIRED');
const tokenPath = join(work, 'dev-token');
assert.equal((await stat(tokenPath)).mode & 0o077, 0, 'TOKEN_FILE_MUST_BE_PRIVATE');
const token = (await readFile(tokenPath, 'utf8')).trim(); assert(token, 'CURRENT_AUTHORIZED_TOKEN_REQUIRED');
const backend = new current.backendClient.BackendClient(config.backendBaseUrl, token, config.backendTimeoutMs);
const actor = await backend.getMe();
await mkdir(work, {recursive: true, mode: 0o700});
await mkdir(dirname(reportPath), {recursive: true});

if (process.argv.includes('--freeze')) {
  const availability = [];
  for (const metric of [MX, MY]) {
    const report = await backend.dataAvailability({dimension: 'dates', org_codes: ['01', '070667800'], metric_codes: [metric], start: '2026-05-01', end: '2026-06-30', match: 'all', page: 1, page_size: 50});
    assert(report.groups.some((group: any) => ['2026-05-31', '2026-06-30'].every(date => group.dates.includes(date))), 'EXPECTED_DATES_COVERED');
    availability.push(report);
  }
  for (const [entity, raw, code] of [['metric', X, MX], ['metric', Y, MY], ['organization', A, '01'], ['organization', B, '070667800']]) {
    const r = await backend.resolveBusinessField(entity, [raw]);
    assert.equal(r.status, 'resolved', 'OFFICIAL_DIRECTORY_EXACT_MATCH');
    assert(r.value.codes.includes(code), 'OFFICIAL_DIRECTORY_CODE');
  }
  const references: any[] = [], privateReferences: any[] = [];
  const targets = [...new Map(scenarios.flatMap(s => s.turns.flatMap(t => t.expected)).map(t => [tuple(t), t])).values()];
  const context = await backend.createAgentQueryContext(randomUUID());
  for (const target of targets) {
    const spec = {conversation_id: context.conversation_id, metric_codes: [target.metric], org_codes: [target.org],
      time: {start: target.start, end: target.end}, selection: target.start === target.end ? 'exact' : 'all_in_range', operation: {kind: 'value'}};
    const response = await backend.basicQueries(spec, `token-opt-reference-${randomUUID()}`), result = response.result;
    assert.equal(result.status, 'succeeded', 'REFERENCE_QUERY_SUCCESS'); assert(!result.truncated, 'REFERENCE_COMPLETE');
    const reference = {target, row_count: result.row_count, rows_sha256: resultHash(result.rows), columns: result.columns,
      nullable_values: result.rows.filter((row: any) => row.metric_value == null).length,
      units: [...new Set(result.rows.map((row: any) => row.unit))], coverage_sha256: hash(result.evidence ?? {}),
      task_id: result.task_id};
    references.push(reference); privateReferences.push({...reference, rows: result.rows});
  }
  assert(references.filter(r => r.target.org === '980000').every(r => r.row_count === 0), 'FROZEN_EMPTY_BOUNDARY');
  assert(references.filter(r => r.target.org !== '980000').every(r => r.row_count === 1 && r.nullable_values === 0), 'FROZEN_NONEMPTY_VALUES');
  await writeFile(join(work, 'private-reference-results.json'), JSON.stringify(privateReferences, null, 2), {mode: 0o600});
  const corpus = {version: 2, revision_note: 'Preserve v1 empty-range failure unchanged; add independently verified exact-day empty result.',
    frozen_at: new Date().toISOString(), backend_origin: new URL(config.backendBaseUrl).origin,
    environment: 'authorized_current_development_database', production_accessed: false, model: config.model.name,
    model_settings_sha256: hash({name: config.model.name, extraBody: config.model.extraBody, maxTokens: config.model.maxTokens, contextWindow: config.model.contextWindow}),
    protocol: 'semantic_v2', availability, references, scenarios, business_values_exported: false, credentials_exported: false};
  await mkdir(dirname(corpusPath), {recursive: true}); await writeFile(corpusPath, JSON.stringify(corpus, null, 2));
  console.log(JSON.stringify({frozen: true, corpus: corpusPath, references: references.length, scenarios: scenarios.length, business_values_exported: false})); process.exit(0);
}

const corpusBytes = await readFile(corpusPath), corpus = JSON.parse(corpusBytes.toString());
assert.equal(corpus.model, config.model.name, 'FROZEN_MODEL');
assert.equal(corpus.model_settings_sha256, hash({name: config.model.name, extraBody: config.model.extraBody, maxTokens: config.model.maxTokens, contextWindow: config.model.contextWindow}), 'FROZEN_MODEL_SETTINGS');
const refs = new Map(corpus.references.map((r: any) => [tuple(r.target), r]));
const privateRefs = new Map(JSON.parse(await readFile(join(work, 'private-reference-results.json'), 'utf8')).map((r: any) => [tuple(r.target), r]));
function subtract(a: any, b: any): string {
  const split = (v: any) => {const value = decimal(v)!; const [whole, fraction = ''] = value.split('.'); return {n: BigInt(`${whole}${fraction}`), scale: fraction.length};};
  const x = split(a), y = split(b), scale = Math.max(x.scale, y.scale), n = x.n * 10n ** BigInt(scale - x.scale) - y.n * 10n ** BigInt(scale - y.scale);
  const sign = n < 0n ? '-' : '', digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  return decimal(`${sign}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`)!;
}
function resultSources(value: any, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return out;
  if (typeof value.task_id === 'string' && typeof value.result_id === 'string') out.add(value.task_id);
  for (const child of Object.values(value)) if (child && typeof child === 'object') resultSources(child, out);
  return out;
}
const chosen = corpus.scenarios.filter((s: any) => !selected.size || selected.has(s.id)); assert(chosen.length, 'CASES_REQUIRED');
assert(Object.keys(caseRepeats).every(id => corpus.scenarios.some((s: any) => s.id === id)), 'UNKNOWN_REPEATED_CASE');
const repetitionsFor = (scenario: any): number => caseRepeats[scenario.id] ?? (scenario.group === 'diagnostic' ? diagnosticRepeat : repeat);
const versions = mode === 'paired' ? ['baseline', 'candidate'] : [mode];
const runRoot = join(work, `native-${arg('run-id', Date.now().toString())}`);
await mkdir(runRoot, {recursive: true, mode: 0o700});
const tasks: any[] = [], bundles = new Map<string, any>();
let resumedFrom: {path: string; sha256: string; completed_tasks: number} | undefined;
const nativeDirectories = [runRoot];
let gatewayBlocked = false;
let stoppedAtTaskBoundary = false;
const allQueryRequests: any[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (url.startsWith(config.backendBaseUrl) && new URL(url).pathname === '/api/v1/basic-queries' && init?.method === 'POST')
    allQueryRequests.push({at: Date.now(), spec_sha256: hash(JSON.parse(init.body))});
  return originalFetch(input, init);
};
const sourceFiles = ['src/config.ts', 'src/harnessHost.ts', 'src/modelContext.ts', 'src/sessionProjection.ts', 'src/routes.ts', 'src/semantic-task/prompt.ts', 'src/semantic-task/planService.ts', 'src/semantic-task/tools.ts', 'src/semantic-task/store.ts'];
for (const version of versions) {
  const sourceRoot = version === 'baseline' ? baselineRoot : candidateRoot, modules = await imports(sourceRoot);
  const localConfig = {...modules.config.loadConfig(), backendBaseUrl: config.backendBaseUrl, businessProtocol: 'semantic_v2', dataDir: join(runRoot, version)};
  const store = new modules.nativeSessions.NativeSessionStore(localConfig.dataDir), skills = await modules.businessSkills.loadBusinessSkills();
  const host = new modules.harnessHost.HarnessHost(localConfig, (association: any) => modules.models.createAskMetricModels(localConfig, association), store,
    [...modules['tools/index'].createAskMetricTools(), modules.businessSkills.createBusinessSkillReadTool(skills)], {skills});
  const app = modules.routes.createApp(localConfig, host, store);
  const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async p => [p, createHash('sha256').update(await readFile(join(sourceRoot, p))).digest('hex')])));
  bundles.set(version, {modules, sourceRoot, config: localConfig, store, host, app, hashes});
}
if (resumePath) {
  const bytes = await readFile(resolve(resumePath)), prior = JSON.parse(bytes.toString());
  assert.equal(prior.script_sha256, scriptSha, 'RESUME_REQUIRES_SAME_MEASUREMENT_SCRIPT');
  assert.equal(prior.corpus_sha256, createHash('sha256').update(corpusBytes).digest('hex'), 'RESUME_REQUIRES_SAME_CORPUS');
  assert.equal(prior.model, config.model.name, 'RESUME_REQUIRES_SAME_MODEL');
  assert.equal(prior.mode, mode, 'RESUME_REQUIRES_SAME_VERSION_SET');
  assert.equal(prior.backend_origin ?? 'http://127.0.0.1:8010', new URL(config.backendBaseUrl).origin, 'RESUME_REQUIRES_SAME_BACKEND');
  assert.deepEqual(prior.settings, {max_tokens: config.model.maxTokens, context_window: config.model.contextWindow, extra_body: publicModelSettings, retry: config.modelRetry}, 'RESUME_REQUIRES_SAME_MODEL_PARAMETERS');
  assert.deepEqual(prior.effective_variants, Object.fromEntries([...bundles].map(([v, b]) => [v, {
    direct_query_delivery: b.config.directQueryDelivery ?? 'absent_baseline', context_view: b.config.modelContextView ?? 'absent_baseline', prompt_variant: b.config.semanticPromptVariant ?? 'absent_baseline'}])), 'RESUME_REQUIRES_SAME_VARIANTS');
  assert.deepEqual(prior.source_hashes, Object.fromEntries([...bundles].map(([v, b]) => [v, b.hashes])), 'RESUME_REQUIRES_IDENTICAL_FROZEN_SOURCE');
  assert(prior.tasks.filter((t: any) => t.version === 'candidate').every((t: any) => t.passed), 'CANDIDATE_FAILED_DIAGNOSTIC_CANNOT_ADVANCE_TO_ACCEPTANCE');
  assert(prior.tasks.every((t: any) => t.turns.length === corpus.scenarios.find((s: any) => s.id === t.case_id)?.turns.length), 'INCOMPLETE_TASK_CANNOT_BE_REUSED');
  tasks.push(...prior.tasks);
  nativeDirectories.unshift(...(prior.native_session_directories ?? [prior.native_session_directory]));
  resumedFrom = {path: resolve(resumePath), sha256: createHash('sha256').update(bytes).digest('hex'), completed_tasks: prior.tasks.length};
}
async function save() {
  await writeFile(reportPath, JSON.stringify({created_at: new Date().toISOString(), mode, repeat, protocol: 'semantic_v2',
    environment: 'configured_real_model_authorized_development_database', production_accessed: false,
    corpus_sha256: createHash('sha256').update(corpusBytes).digest('hex'), source_hashes: Object.fromEntries([...bundles].map(([v, b]) => [v, b.hashes])),
    model: config.model.name, gateway_origin: new URL(config.model.baseUrl).origin, backend_origin: new URL(config.backendBaseUrl).origin,
    script_sha256: scriptSha,
    effective_variants: Object.fromEntries([...bundles].map(([v, b]) => [v, {
      direct_query_delivery: b.config.directQueryDelivery ?? 'absent_baseline', context_view: b.config.modelContextView ?? 'absent_baseline', prompt_variant: b.config.semanticPromptVariant ?? 'absent_baseline'}])),
    settings: {max_tokens: config.model.maxTokens, context_window: config.model.contextWindow, extra_body: publicModelSettings, retry: config.modelRetry},
    native_session_directory: runRoot, native_session_directories: nativeDirectories, resumed_from: resumedFrom,
    planned_tasks: chosen.reduce((n: number, s: any) => n + repetitionsFor(s), 0) * versions.length, finished_tasks: tasks.length,
    repetitions_by_case: Object.fromEntries(chosen.map((s: any) => [s.id, repetitionsFor(s)])),
    guard_ms: Number(arg('guard-ms', '120000')), gateway_blocked: gatewayBlocked,
    stopped_at_task_boundary: stoppedAtTaskBoundary,
    sampling: 'whole tasks; failures and retries retained; AB/BA alternates per case and repetition',
    business_values_exported: false, credentials_exported: false, tasks}, null, 2));
}
const failureText = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
async function run(scenario: any, version: string, repetition: number) {
  const bundle = bundles.get(version)!, {host, modules, app} = bundle;
  let hosted = await host.createSession(actor);
  const sessionId = hosted.sessionId, queryRecords: any[] = [], calculations: any[] = [], usages: any[] = [], usageAdjustments: any[] = [], physicalCalls: any[] = [], turns: any[] = [];
  const oldFrames = new Map<string, string>();
  function tracked(client: any): any {return new Proxy(client, {get(target, key) {
    const fn = target[key]; if (typeof fn !== 'function') return fn;
    if (key === 'withTraceId') return (...args: any[]) => tracked(fn.apply(target, args));
    if (key === 'basicQueries') return async (...args: any[]) => {const row: any = {spec: args[0], status: 'pending'}; queryRecords.push(row);
      try {const response = await fn.apply(target, args); row.status = response.result.status; row.result = response.result; return response;}
      catch (error) {row.status = 'error'; row.error = failureText(error); throw error;}};
    if (key === 'calculate') return async (...args: any[]) => {const response = await fn.apply(target, args); calculations.push({spec: args[0], result: response}); return response;};
    return fn.bind(target);
  }});}
  const b = tracked(new modules.backendClient.BackendClient(config.backendBaseUrl, token, config.backendTimeoutMs));
  const listen = () => {
    hosted.harness.hooks.on('before_request', (event: any, context: any) => {
      const request = modules.requestContext.requireRequestContext(context);
      physicalCalls.push({call_index: physicalCalls.length + 1, request_id: request.requestId, operation_id: request.operationId,
        step: event.step, attempt: event.attempt, usage_ids: []});
      return undefined;
    });
    hosted.harness.events.on('usage', (event: any, context: any) => {
      const request = modules.requestContext.requireRequestContext(context), normalized = modules.modelUsage.modelUsage(event.row.usage);
      if (event.row.adjustment) {usageAdjustments.push({usage_id: event.row.id, request_id: request.requestId, adjustment: true, ...normalized}); return;}
      const call = physicalCalls.findLast(c => c.request_id === request.requestId); if (call) call.usage_ids.push(event.row.id);
      usages.push({usage_id: event.row.id, entry_id: event.row.entryId, operation_id: request.operationId, request_id: request.requestId,
        call_index: call?.call_index ?? null, step: request.modelCall?.step ?? 'unknown', attempt: request.modelCall?.attempt ?? null, ...normalized,
        noncache_input_tokens: normalized.usage_known ? event.row.usage.input : null});
    });
    hosted.harness.hooks.on('after_response', (event: any, context: any) => {
      const request = modules.requestContext.requireRequestContext(context), call = physicalCalls.findLast(c => c.request_id === request.requestId);
      if (call) {call.stop_reason = event.message.stopReason; call.response_status = event.status ?? null;}
      return undefined;
    });
  };
  listen();
  try {for (const [index, turn] of scenario.turns.entries()) {
    const beforeQueries = queryRecords.length, beforeCalc = calculations.length, beforeUsage = usages.length, beforePhysical = physicalCalls.length;
    const failures: string[] = [], started = performance.now(); let guardAborted = false;
    const admission = await host.admitPrompt(hosted, {protocol_version: 3, request_id: `token-opt-${version}-${scenario.id}-${repetition}-${index}-${randomUUID()}`, message: turn.message}, {actor, backend: b});
    assert(admission.ok, 'TURN_ADMISSION');
    const timer = setTimeout(() => {guardAborted = true; void host.abort(hosted, admission.operationId);}, Number(arg('guard-ms', '120000')));
    try {const result = await host.drivePrompt(hosted, admission); assert(result.ok && result.outcome.kind === 'settled' && result.outcome.outcome.status === 'completed', 'TURN_COMPLETED');}
    catch (error) {failures.push(failureText(error));} finally {clearTimeout(timer);}
    if (guardAborted) failures.push('TEST_GUARD_ABORTED');
    const entries = await hosted.lane.findEntries({order: 'oldestFirst'}, BACKGROUND_CONTEXT), start = entries.map((e: any) => e.type === 'message' && e.message.role === 'user').lastIndexOf(true);
    const currentEntries = entries.slice(start), messages = currentEntries.flatMap((e: any) => e.type === 'message' ? [e.message] : []);
    const projected = modules.sessionProjection.projectEntries(currentEntries), answers = projected.filter((m: any) => m.role === 'assistant' && m.text?.trim());
    const answer = answers.at(-1), feedback = messages.filter((m: any) => m.role === 'toolResult' && modules['semantic-task/feedback'].isSemanticFeedback(m.details)).at(-1)?.details;
    const queries = queryRecords.slice(beforeQueries), calcs = calculations.slice(beforeCalc);
    const collectAccounting = () => {
      const turnPhysical = physicalCalls.slice(beforePhysical), uniqueUsage = [...new Map(usages.slice(beforeUsage).map(u => [u.usage_id, u])).values()];
      for (const missing of turnPhysical.filter(c => c.usage_ids.length === 0)) uniqueUsage.push({usage_id: `unreported:${missing.operation_id}:${missing.call_index}`,
        operation_id: missing.operation_id, request_id: missing.request_id, call_index: missing.call_index, step: missing.step, attempt: missing.attempt,
        usage_known: false, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, noncache_input_tokens: null});
      for (const usage of uniqueUsage) {
        const call = turnPhysical.find(c => c.call_index === usage.call_index);
        usage.stop_reason = call?.stop_reason ?? 'unknown';
        usage.accounting_complete = usage.usage_known && !!call?.stop_reason && !['error', 'aborted'].includes(call.stop_reason);
        usage.accounting_status = usage.accounting_complete ? 'provider_reported_settled' : usage.usage_known ? 'reported_only_incomplete' : 'unreported';
      }
      return {turnPhysical, uniqueUsage};
    };
    let {turnPhysical, uniqueUsage} = collectAccounting();
    const queryEvidence: any[] = [];
    try {
      assert(answer && !answer.error, 'AUTHORITATIVE_VISIBLE_ANSWER');
      assert.equal(answers.length, 1, 'SINGLE_AUTHORITATIVE_ANSWER');
      if (feedback?.direct_answer) {
        assert.equal(hash(answer.text), hash(feedback.direct_answer.public_answer), 'VISIBLE_ANSWER_IS_SAVED_FORMAL_DELIVERY');
        assert.equal(feedback.direct_answer.operation_id, admission.operationId, 'DIRECT_DELIVERY_OPERATION_IDENTITY');
      }
      if (turn.missing) {assert.equal(feedback?.status, 'needs_user', 'MISSING_FORMAL_STATUS'); assert.equal(queries.length, 0, 'MISSING_MUST_NOT_QUERY');
        assert.deepEqual([...new Set(feedback.issues.filter((i: any) => i.remediation === 'user').map((i: any) => i.field))].sort(), [...turn.missing].sort(), 'ONLY_MISSING_FIELDS');}
      else {
        assert(['succeeded', 'reused'].includes(feedback?.status), 'FORMAL_QUERY_SUCCESS');
        assert.equal(feedback?.state?.completion, 'full', 'ALL_REQUIRED_TARGETS_COMPLETE');
        if (turn.reuse) {
          assert.equal(queries.length, 0, 'HISTORY_MUST_NOT_REQUERY');
          const ids = [...resultSources(feedback.state.evidence)]; assert(ids.length, 'HISTORY_FORMAL_RESULT_SOURCES');
          const rows: any[] = [];
          for (const id of ids) {const result = await b.getTaskResult(id); assert(!result.truncated && !result.has_more, 'HISTORY_COMPLETE'); rows.push(...result.rows);}
          const expectedRows = turn.expected.flatMap((target: any) => (privateRefs.get(tuple(target)) as any).rows);
          assert.equal(resultHash(rows), resultHash(expectedRows), 'HISTORY_EXACT_FIRST_RESULT');
        }
        else {
          const actual = queries.flatMap(q => q.spec.metric_codes.flatMap((metric: string) => q.spec.org_codes.flatMap((org: string) =>
            q.spec.time.dates?.length ? q.spec.time.dates.map((date: string) => identity(metric, org, date)) : [identity(metric, org, q.spec.time.start, q.spec.time.end)])));
          assert.deepEqual(actual.map(tuple).sort(), turn.expected.map(tuple).sort(), 'EXACT_TARGET_BINDINGS_NO_CROSS_PRODUCT');
          for (const query of queries) {
            assert.equal(query.status, 'succeeded', 'QUERY_SUCCEEDED'); assert(!query.result.truncated, 'FORMAL_RESULT_COMPLETE');
            assert.equal(query.spec.operation?.kind ?? 'value', 'value', 'ONLY_REQUIRED_VALUE_OPERATION');
            assert.equal(query.spec.selection, query.spec.time.start === query.spec.time.end || query.spec.time.dates?.length ? 'exact' : 'all_in_range', 'EXACT_REQUESTED_SELECTION');
            const targets = turn.expected.filter((t: any) => query.spec.metric_codes.includes(t.metric) && query.spec.org_codes.includes(t.org)
              && (query.spec.time.dates?.length ? t.start === t.end && query.spec.time.dates.includes(t.start) : t.start === query.spec.time.start && t.end === query.spec.time.end));
            const expectedCount = targets.reduce((n: number, t: any) => n + (refs.get(tuple(t)) as any).row_count, 0);
            assert.equal(query.result.row_count, expectedCount, 'FORMAL_ALL_ROWS'); assert.equal(query.result.rows.length, expectedCount, 'FORMAL_ROWS_PRESENT');
            for (const target of targets) {
              const reference: any = refs.get(tuple(target));
              const rows = query.result.rows.filter((r: any) => r.metric_code === target.metric && r.org_code === target.org && r.stat_date >= target.start && r.stat_date <= target.end);
              assert.equal(resultHash(rows), reference.rows_sha256, 'EXACT_DECIMAL_NULL_UNIT_ORDER_REFERENCE');
              queryEvidence.push({target, row_count: rows.length, rows_sha256: resultHash(rows), unit_set: [...new Set(rows.map((r: any) => r.unit))], null_count: rows.filter((r: any) => r.metric_value == null).length});
            }
          }
        }
        if (turn.empty) assert(/暂无|没有|无匹配|未查到|未查询到|未找到|无数据|无记录/.test(answer.text), 'EMPTY_MUST_BE_EXPLICIT');
        if (turn.calculation) {
          const calculation = calcs.find((c: any) => c.result.status === 'succeeded'); assert(calculation, 'FORMAL_CALCULATION_REQUIRED');
          const may: any = privateRefs.get(tuple(first)), june: any = privateRefs.get(tuple(identity(MX, '01', '2026-06-30')));
          assert.equal(decimal(calculation.result.results[0].value), subtract(june.rows[0].metric_value, may.rows[0].metric_value), 'EXACT_DECIMAL_DIFFERENCE_DIRECTION');
          assert.equal(calculation.result.results[0].unit, may.rows[0].unit, 'CALCULATION_UNIT');
          const difference = subtract(june.rows[0].metric_value, may.rows[0].metric_value);
          const direction = difference === '0' ? /持平|不变|相同|一致/ : difference.startsWith('-') ? /减少|下降|降低|低于/ : /增加|上升|增长|高于/;
          assert(direction.test(answer.text), 'FINAL_PROSE_CHANGE_DIRECTION');
          assert(uniqueUsage.length >= 2, 'COMPLEX_MUST_RETAIN_MODEL');
        }
      }
      const frames = await admission.request.frames.state();
      for (const id of frames.frameOrder) {
        const frame = await admission.request.frames.get(id), digest = hash(frame);
        if (oldFrames.has(id)) assert.equal(digest, oldFrames.get(id), 'OLD_FRAME_IMMUTABLE');
        oldFrames.set(id, digest);
      }
    } catch (error) {failures.push(failureText(error));}
    const beforeRestoreSql = allQueryRequests.length, beforeRestorePhysical = physicalCalls.length, beforeRestoreUsage = usages.length;
    const beforeSnapshot = await app.request(`/sessions/${sessionId}`, {headers: {Authorization: `Bearer ${token}`}});
    let snapshot: any, restored: any;
    try {assert.equal(beforeSnapshot.status, 200, 'AUTHORIZED_REFRESH_STATUS'); snapshot = await beforeSnapshot.json();
      await host.closeSession(sessionId); hosted = await host.openSession(actor, sessionId); assert(hosted, 'PERSISTENT_SESSION_REOPEN'); listen();
      const response = await app.request(`/sessions/${sessionId}`, {headers: {Authorization: `Bearer ${token}`}});
      assert.equal(response.status, 200, 'AUTHORIZED_RECOVERY_STATUS'); restored = await response.json();
      assert.equal(hash(snapshot.messages), hash(restored.messages), 'RESTORED_MESSAGES_IDENTICAL');
      assert.equal(allQueryRequests.length, beforeRestoreSql, 'REFRESH_RECOVERY_ZERO_QUERY_SUBMISSIONS');
      assert.equal(physicalCalls.length, beforeRestorePhysical, 'REFRESH_RECOVERY_ZERO_MODEL_REQUESTS');
      assert.equal(usages.length, beforeRestoreUsage, 'REFRESH_RECOVERY_ZERO_MODEL_USAGE');
      const other = {...actor, id: `isolated-other-${randomUUID()}`};
      assert.equal(await host.openSession(other, sessionId), undefined, 'CROSS_OWNER_SESSION_BLOCKED');
    } catch (error) {failures.push(failureText(error));}
    // 恢复中的异常请求也进入同一回合账本，不能在恢复前冻结用量而漏账。
    ({turnPhysical, uniqueUsage} = collectAccounting());
    const record = {turn: index + 1, message: turn.message, expected: turn, passed: failures.length === 0, failures,
      elapsed_ms: Math.round(performance.now() - started), status: feedback?.status, completion: feedback?.state?.completion,
      formal_issue_codes: feedback?.issues?.map((i: any) => ({code: i.code, field: i.field, remediation: i.remediation})) ?? [],
      model_calls: turnPhysical.length, physical_calls: turnPhysical, usage: uniqueUsage,
      usage_adjustments: usageAdjustments.filter(a => a.request_id === admission.request.requestId),
      query_count: queries.length, queries: queries.map(q => ({status: q.status,
        spec: {metric_codes: q.spec.metric_codes, org_codes: q.spec.org_codes, time: q.spec.time, selection: q.spec.selection, operation: q.spec.operation},
        task_id: q.result?.task_id, row_count: q.result?.row_count, truncated: q.result?.truncated, error: q.error})), query_evidence: queryEvidence,
      calculation_count: calcs.length, calculation_result_sha256: hash(calcs.map(c => c.result.results)),
      answer_sha256: hash(answer?.text ?? ''), answer_entry_id: answer?.entry_id, answer_length: answer?.text?.length ?? 0,
      old_frame_count: oldFrames.size, frames_sha256: hash([...oldFrames]), restored_messages_sha256: hash(restored?.messages ?? []),
      model_error_codes: messages.filter((m: any) => m.role === 'assistant' && ['error', 'aborted'].includes(m.stopReason)).map((m: any) => /^(\d{3})\b/.exec(m.errorMessage ?? '')?.[1] ?? m.stopReason),
      restore_zero_sql: allQueryRequests.length === beforeRestoreSql,
      restore_zero_model: physicalCalls.length === beforeRestorePhysical && usages.length === beforeRestoreUsage,
      restore_model_request_delta: physicalCalls.length - beforeRestorePhysical, restore_usage_row_delta: usages.length - beforeRestoreUsage,
      direct_delivery: feedback?.direct_answer?.delivery_path ?? null,
      saved_answer_id: feedback?.direct_answer?.answer_id ?? null,
      calls: messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.content.filter((c: any) => c.type === 'toolCall').map((c: any) => ({name: c.name, arguments_sha256: hash(c.arguments)})))};
    turns.push(record); await save();
    console.log(JSON.stringify({version, case: scenario.id, repetition, turn: index + 1, passed: record.passed, model_calls: record.model_calls, query_count: record.query_count, failures}));
    gatewayBlocked = messages.some((m: any) => m.role === 'assistant' && /^(401|402|403)\b/.test(m.errorMessage ?? ''));
    if (guardAborted || gatewayBlocked) break;
  }} finally {await host.closeSession(sessionId);}
  tasks.push({case_id: scenario.id, group: scenario.group, version, repetition, session_id: sessionId, passed: turns.length === scenario.turns.length && turns.every(t => t.passed), turns});
  await save();
}
try {
  matrix: for (let repetition = 1; repetition <= Math.max(...chosen.map(repetitionsFor)); repetition++) for (const scenario of chosen) {
    if (repetition > repetitionsFor(scenario)) continue;
    const index = corpus.scenarios.findIndex((s: any) => s.id === scenario.id);
    const order = mode === 'paired' ? ((index + repetition) % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) : versions;
    for (const version of order) {
      if (tasks.some(t => t.case_id === scenario.id && t.version === version && t.repetition === repetition)) continue;
      try {await access(stopFile); stoppedAtTaskBoundary = true; break matrix;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      await run(scenario, version, repetition); if (gatewayBlocked) break matrix;
      // 新候选已出现失败时在完整任务边界停账，不再启动下一项付费请求。
      if (stopOnCandidateFailure && version === 'candidate' && !tasks.at(-1)?.passed) {
        await writeFile(stopFile, JSON.stringify({case_id: scenario.id, repetition, reason: 'candidate_task_failed'}));
        stoppedAtTaskBoundary = true; break matrix;
      }
    }
  }
} finally {
  await save(); globalThis.fetch = originalFetch;
  for (const bundle of bundles.values()) {await bundle.host.close(); await bundle.store.close();}
}
if (tasks.some(t => !t.passed)) process.exitCode = 1;
