/** 真实Pi模型验收；默认拒绝联网，--live显式启用。结果仅记录合成业务数据。 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core';
import {loadConfig} from '../src/config.js';
import {createAskMetricModels} from '../src/models.js';
import {HarnessHost} from '../src/harnessHost.js';
import {NativeSessionStore} from '../src/nativeSessions.js';
import {NativeSemanticTaskStore} from '../src/semantic-task/store.js';
import {createAskMetricTools} from '../src/tools/index.js';
import {loadBusinessSkills, createBusinessSkillReadTool} from '../src/businessSkills.js';
import {projectEntries} from '../src/sessionProjection.js';
import {isSemanticFeedback} from '../src/semantic-task/feedback.js';
import {BackendApiError, type BackendClient, type BackendUser} from '../src/backendClient.js';

assert.ok(process.argv.includes('--live'), '使用 --live 明确启用真实模型；此脚本仅使用内存合成业务数据');
const report = resolve(process.argv.find(arg => arg.startsWith('--report='))?.slice(9) ?? '../docs/verification/pi-semantic-task-phase2-20261014/real-model-synthetic.json');
const pythonPath = resolve('../backend-next/.venv/bin/python');
const cache = new Map<string, unknown>();
function python(payload: Record<string, unknown>): any {
  const input = JSON.stringify(payload);
  if (payload.action !== 'query' && cache.has(input)) return structuredClone(cache.get(input));
  const response = JSON.parse(execFileSync(pythonPath, [join(import.meta.dirname, 'semantic-task-fixture.py')], {
    input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: {PATH: '/usr/bin:/bin:/opt/homebrew/bin'},
  }));
  if (!response.ok) throw new BackendApiError(422, response.message, response.error);
  if (payload.action !== 'query') cache.set(input, response.value);
  return response.value;
}
function backend() {
  const queries: any[] = [], results = new Map<string, any>();
  return {queries, client: {
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, year?: number, source?: unknown) => python({action: 'resolve', entity, raw, year, source}),
    matchMetricQuestion: async (question: string) => python({action: 'mentions', question}),
    metricCatalogOverview: async () => ({total: 2, groups: [{unit: '元', count: 2, examples: [{code: 'SYNTH_M:D', name: '经营收益金额当日数'}]}]}),
    searchMetrics: async (keyword: string) => ({total: 2, items: [{metric_code: 'SYNTH_M:D', metric_name: '经营收益金额当日数', unit: '元', score: 1, match_type: 'exact'}, {metric_code: 'SYNTH_M:Y', metric_name: '经营收益金额较同期', unit: '元', score: 1, match_type: 'exact'}].filter(item => item.metric_name.includes(keyword)), semantic_suggestions: []}),
    searchOrganizations: async () => ({total: 1, items: [{org_code: 'SYNTH_O1', org_name: '合成机构甲', score: 1, match_type: 'exact'}]}),
    createAgentQueryContext: async () => ({conversation_id: 'synthetic-semantic'}),
    basicQueries: async (query: any) => {
      const item: any = {spec: query}; queries.push(item); const actual = python({action: 'query', spec: query});
      const id = `query-${queries.length}`;
      const result = {status: 'succeeded', task_id: id, result_id: `result-${id}`, rows: actual.rows, columns: Object.keys(actual.rows[0] ?? {}), row_count: actual.rows.length, truncated: false, message: '合成数据SQL完成'};
      item.row_count = actual.rows.length; results.set(id, result); return {query, result};
    },
    getTask: async (id: string) => ({task_id: id, status: 'SUCCEEDED', version: 1, result: {result_id: `result-${id}`}}),
    getTaskResult: async (id: string) => results.get(id),
  } as unknown as BackendClient};
}
const actor: BackendUser = {id: 'synthetic-semantic', username: 'synthetic', display_name: '合成验收', org_code: 'SYNTH_ROOT', org_name: '合成集团', role_code: 'USER'};
const scenarios = [
  ...[1, 2, 3].map(index => ({name: `exact-repeat-${index}`, messages: ['查询合成机构甲2026年5月31日的经营收益金额当日数'], statuses: ['succeeded']})),
  {name: 'missing-and-followup', messages: ['查询合成机构甲的经营收益金额当日数', '日期用2026年5月31日'], statuses: ['needs_user', 'succeeded']},
  {name: 'relative-range', messages: ['查询合成机构甲近5年的经营收益金额当日数，取全部数据', '日期用第二项'], statuses: ['needs_user', 'succeeded']},
  {name: 'base-confirm', messages: ['查询合成机构甲2026年5月31日的经营收益金额', '指标用经营收益金额当日数'], statuses: ['needs_user', 'succeeded']},
  {name: 'catalog-typo', messages: ['查询合成机构甲2026年5月31日的经营收益金融当日数'], statuses: ['succeeded']},
];
const directory = await mkdtemp(join(tmpdir(), 'semantic-model-'));
const sessions = new NativeSessionStore(directory), skills = await loadBusinessSkills();
const config = {...loadConfig(), dataDir: directory, businessProtocol: 'semantic_v2' as const};
const host = new HarnessHost(config, association => createAskMetricModels(config, association), sessions,
  [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
const turns: any[] = [];
const sourceHashes = Object.fromEntries(await Promise.all(['src/harnessHost.ts', 'src/semantic-task/service.ts', 'src/semantic-task/prompt.ts', 'scripts/semantic-task-fixture.py', 'scripts/check-semantic-task-model.ts'].map(async path =>
  [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const save = async () => {await mkdir(dirname(report), {recursive: true}); await writeFile(report, JSON.stringify({
  environment: 'real_model_current_backend_contract_synthetic_in_memory_SQL', real_database: false,
  source_hashes: sourceHashes,
  model: config.model.name, native_session_directory: directory, passed: turns.filter(turn => turn.passed).length,
  total: turns.length, turns,
}, null, 2));};
try {
  for (const scenario of scenarios) {
    const hosted = await host.createSession(actor), b = backend(), tasks = new NativeSemanticTaskStore(hosted.session);
    for (const [index, message] of scenario.messages.entries()) {
      let failure: string | undefined; const before = b.queries.length, started = performance.now();
      const admission = await host.admitPrompt(hosted, {protocol_version: 3, request_id: `${scenario.name}-${index}`, message}, {actor, backend: b.client});
      assert.ok(admission.ok);
      const timer = setTimeout(() => void host.abort(hosted, admission.operationId), 120000);
      try {const result = await host.drivePrompt(hosted, admission); assert.ok(result.ok && result.outcome.kind === 'settled' && result.outcome.outcome.status === 'completed', 'TURN_COMPLETED');}
      catch (error) {failure = error instanceof Error ? error.message : String(error);} finally {clearTimeout(timer);}
      const entries = await hosted.lane.findEntries({order: 'oldestFirst'}, BACKGROUND_CONTEXT);
      const start = entries.map(entry => entry.type === 'message' && entry.message.role === 'user').lastIndexOf(true);
      const current = entries.slice(start), messages = current.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
      const receipts = messages.flatMap(message => message.role === 'toolResult' ? [{name: message.toolName, details: message.details, is_error: !!message.isError}] : []);
      const calls = messages.flatMap(message => message.role === 'assistant' ? message.content.filter(content => content.type === 'toolCall').map(call => ({name: call.name, args: call.arguments})) : []);
      const status = receipts.filter(receipt => isSemanticFeedback(receipt.details)).map(receipt => (receipt.details as any).status).at(-1);
      const task = await tasks.get((await tasks.index()).focus ?? ''), queries = b.queries.slice(before);
      const answer = projectEntries(current).filter(message => message.role === 'assistant').map(message => message.text).join('\n');
      try {
        assert.equal(status, scenario.statuses[index], 'FORMAL_EXPECTED_STATUS'); assert.ok(answer.trim(), 'VISIBLE_ANSWER');
        if (status === 'succeeded') {assert.equal(queries.length, 1, 'ONE_EXECUTION'); assert.equal(task?.completion, 'full'); assert.deepEqual(queries[0].spec.metric_codes, ['SYNTH_M:D']); assert.deepEqual(queries[0].spec.org_codes, ['SYNTH_O1']);}
        else assert.equal(queries.length, 0, 'NO_QUERY_BEFORE_CHOICE');
      } catch (error) {failure ??= error instanceof Error ? error.message : String(error);}
      const turn = {scenario: scenario.name, turn: index + 1, message, passed: !failure, failure, status,
        elapsed_ms: Math.round(performance.now() - started), model_calls: admission.request.timings?.model_ms.length,
        calls, receipts, queries, task, answer};
      turns.push(turn); await save(); console.log(JSON.stringify({scenario: turn.scenario, turn: turn.turn, passed: turn.passed, failure, status}));
    }
    await host.closeSession(hosted.sessionId);
  }
} finally {await save(); await host.close(); await sessions.close();}
if (turns.some(turn => !turn.passed)) process.exitCode = 1;
