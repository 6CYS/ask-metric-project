/** 阶段4合成后端；不读取数据库配置，复用当前Python目录、日历、准入及内存SQL。 */
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {BackendApiError,type BackendClient} from '../src/backendClient.js';
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
export function createSyntheticBackend() {
  const queries: any[] = [], results = new Map<string, any>();
  return {queries, client: {
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, year?: number, source?: unknown) => python({action: 'resolve', entity, raw, year, source}),
    inspectBusinessGoal: async (question: string, businessDate: string, _options?: unknown, reference_year?: number) => python({action: 'inspect', question, business_date: businessDate, reference_year}),
    admitSemanticPlan: async (payload: unknown) => python({action: 'admit', payload}),
    calculate: async (spec: any) => {
      const known = [...results.values()].flatMap(result => result.facts ?? []);
      const inputs = Object.fromEntries(Object.entries(spec.bindings).map(([name, binding]: [string, any]) => {
        const fact = known.find(fact => fact.fact_id === binding.fact_id); if (!fact) throw new Error('UNOBSERVED_FACT'); return [name, fact];
      }));
      const result = python({action: 'calculate', spec, inputs}); return {...result, public_answer: result.results.map((item: any) => `${item.label}：${item.display_value}${item.unit}`).join('\n')};
    },
    matchMetricQuestion: async (question: string) => python({action: 'mentions', question}),
    metricCatalogOverview: async () => ({total: 2, groups: [{unit: '元', count: 2, examples: [{code: 'SYNTH_M:D', name: '经营收益金额当日数'}]}]}),
    searchMetrics: async (keyword: string) => ({total: 2, items: [{metric_code: 'SYNTH_M:D', metric_name: '经营收益金额当日数', unit: '元', score: 1, match_type: 'exact'}, {metric_code: 'SYNTH_M:Y', metric_name: '经营收益金额较同期', unit: '元', score: 1, match_type: 'exact'}].filter(item => item.metric_name.includes(keyword)), semantic_suggestions: []}),
    searchOrganizations: async (keyword: string) => {const items = ['甲','乙','丙','丁'].map((name,index) => ({org_code: `SYNTH_O${index+1}`,org_name: `合成机构${name}`,score: 1,match_type: 'exact'})).filter(item => item.org_name.includes(keyword));return {total:items.length,items};},
    createAgentQueryContext: async () => ({conversation_id: 'synthetic-semantic'}),
    basicQueries: async (query: any) => {
      const item: any = {spec: query}; queries.push(item); const actual = python({action: 'query', spec: query});
      const id = `query-${queries.length}`;
      const result = {status: 'succeeded', task_id: id, result_id: `result-${id}`, rows: actual.rows, columns: Object.keys(actual.rows[0] ?? {}), row_count: actual.rows.length, truncated: false, message: '合成数据SQL完成', facts: actual.rows.flatMap((row: any, index: number) => row.metric_value === null || row.metric_value === undefined ? [] : [{fact_id: `fact:${id}:${index}:metric_value`, task_id: id, field: 'metric_value', value: String(row.metric_value), unit: row.unit ?? '元', metric_code: row.metric_code, metric_name: row.metric_name, org_code: row.org_code, org_name: row.org_name, date: row.stat_date}])};
      item.row_count = actual.rows.length; item.rows = actual.rows; results.set(id, result); return {query, result};
    },
    getTask: async (id: string) => {if(!results.has(id))throw new BackendApiError(404,'合成查询任务不存在','TASK_NOT_FOUND');return {task_id: id, status: 'SUCCEEDED', version: 1, result: {result_id: `result-${id}`}};},
    getTaskResult: async (id: string) => {if(!results.has(id))throw new BackendApiError(404,'合成查询结果不存在','RESULT_NOT_FOUND');return results.get(id);},
  } as unknown as BackendClient};
}
