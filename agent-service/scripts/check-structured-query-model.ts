/** 当前真实模型 → 结构化工具参数 → 真实Python绑定与SQL builder → 内存合成数据。 */
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {projectEntries} from "../src/sessionProjection.js";
import {isSemanticFeedback, type SemanticFeedback} from "../src/semantic-task/feedback.js";
import {BackendApiError, type BackendClient, type BackendUser} from "../src/backendClient.js";
import {authoritativeAnswer} from "./model-evidence-assertions.js";

const arg = (key: string, fallback: string) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const reportPath = resolve(arg("report", "../docs/verification/structured-query-model-20261018.json"));
const selected = new Set(arg("cases", "").split(",").filter(Boolean));
const pythonPath = resolve("../backend-next/.venv/bin/python"), fixturePath = join(import.meta.dirname, "structured-query-fixture.py");
const cache = new Map<string, unknown>();
function python(payload: Record<string, unknown>): any {
  const key = JSON.stringify(payload);
  if (payload.action !== "query" && cache.has(key)) return structuredClone(cache.get(key));
  const result = JSON.parse(execFileSync(pythonPath, [fixturePath], {input: key, encoding: "utf8", timeout: 30000,
    maxBuffer: 8 * 1024 * 1024, env: {PATH: "/usr/bin:/bin:/opt/homebrew/bin"}}));
  if (!result.ok) throw new BackendApiError(422, result.message, result.error);
  if (payload.action !== "query") cache.set(key, result.value);
  return result.value;
}
const catalog = python({action: "catalog"});
const orgs = catalog.organizations as Array<{code: string; name: string; aliases: string[]}>;
const metrics = catalog.metrics as Array<{code: string; name: string; unit: string}>;
const ALL = orgs.map(o => o.code).sort();
type Expected = {metric: string; organizations?: string[]; day?: string; start?: string; end?: string;
  selection?: string; operation?: unknown; rows?: number};
type Turn = {message: string; expected?: Expected[]; status?: string; initial?: boolean; publicFailure?: boolean};
type Scenario = {id: string; unavailable?: boolean; turns: Turn[]};
const scenarios: Scenario[] = [
  {id: "incident_all_values", turns: [{message: "2026年4月末各家农商行个人活期存款余额当日数分别是多少？", initial: true,
    expected: [{metric: "SYNTH_DDA:D", day: "2026-04-30", operation: {kind: "value"}, rows: ALL.length}]}]},
  {id: "incident_top3", turns: [{message: "查询2026年4月末各家农商行信贷客户数量当日数前3名。", initial: true,
    expected: [{metric: "SYNTH_CREDIT:D", day: "2026-04-30", operation: {kind: "ranking", position: "top", top_n: 3}, rows: 3}]}]},
  {id: "bottom5_other_date", turns: [{message: "列出今年六月底全省农商行信贷客户数量当日数最少的五家。", initial: true,
    expected: [{metric: "SYNTH_CREDIT:D", day: "2026-06-30", operation: {kind: "ranking", position: "bottom", top_n: 5}, rows: 5}]}]},
  {id: "all_sorted", turns: [{message: "把五月末全省各家农商行的对公协定存款余额当日数按从高到低排列，全部列出。", initial: true,
    expected: [{metric: "SYNTH_DEP:D", day: "2026-05-31", operation: {kind: "ranking", position: "top", top_n: ALL.length}, rows: ALL.length}]}]},
  {id: "named_scope_then_change", turns: [
    {message: "查无锡和江阴两家在2026年5月底的信贷客户数量当日数，较少的那家排前面。", initial: true,
      expected: [{metric: "SYNTH_CREDIT:D", organizations: ["SYNTH_WX", "SYNTH_JY"], day: "2026-05-31",
        operation: {kind: "ranking", position: "bottom", top_n: 2}, rows: 2}]},
    {message: "改到六月底，只取最多的那一家。", expected: [{metric: "SYNTH_CREDIT:D", organizations: ["SYNTH_WX", "SYNTH_JY"],
      day: "2026-06-30", operation: {kind: "ranking", position: "top", top_n: 1}, rows: 1}]},
    {message: "取消排序，两家的数都要。", expected: [{metric: "SYNTH_CREDIT:D", organizations: ["SYNTH_WX", "SYNTH_JY"],
      day: "2026-06-30", operation: {kind: "value"}, rows: 2}]},
  ]},
  {id: "interval_all", turns: [{message: "查询无锡2026年五月到六月全部已有的对公协定存款余额当日数记录。", initial: true,
    expected: [{metric: "SYNTH_DEP:D", organizations: ["SYNTH_WX"], start: "2026-05-01", end: "2026-06-30", selection: "all_in_range", operation: {kind: "value"}, rows: 2}]}]},
  {id: "interval_latest", turns: [{message: "无锡在2026年五月到六月最后有数据那一期的对公协定存款余额当日数是多少？", initial: true,
    expected: [{metric: "SYNTH_DEP:D", organizations: ["SYNTH_WX"], start: "2026-05-01", end: "2026-06-30", selection: "latest_in_range", operation: {kind: "value"}, rows: 1}]}]},
  {id: "rank_position", turns: [{message: "2026年五月末无锡的信贷客户数量当日数在全省各家农商行中排第几？", initial: true,
    expected: [{metric: "SYNTH_CREDIT:D", organizations: ["SYNTH_WX"], day: "2026-05-31", operation: {kind: "rank_position"}, rows: 1}]}]},
  {id: "separate_targets", turns: [{message: "分别查无锡2026年四月底的对公协定存款余额当日数，以及江阴2026年六月底的信贷客户数量当日数。", initial: true,
    expected: [{metric: "SYNTH_DEP:D", organizations: ["SYNTH_WX"], day: "2026-04-30", operation: {kind: "value"}, rows: 1},
      {metric: "SYNTH_CREDIT:D", organizations: ["SYNTH_JY"], day: "2026-06-30", operation: {kind: "value"}, rows: 1}]}]},
  {id: "missing_ranking_count", turns: [{message: "查2026年五月末全省各家农商行信贷客户数量当日数的前几名。", initial: true, status: "needs_user"}]},
  {id: "missing_date", turns: [{message: "请列出各家农商行信贷客户数量当日数最多的三家。", initial: true, status: "needs_user"}]},
  {id: "backend_unavailable", unavailable: true, turns: [{message: "查询2026年五月末各家农商行对公协定存款余额当日数。", initial: true, status: "failed", publicFailure: true}]},
];
function backend(unavailable = false) {
  const queries: any[] = [], scopes: any[] = [], results = new Map<string, any>();
  const client = {
    orgCatalog: async () => ({items: orgs}),
    inspectBusinessGoal: async (question: string, business_date: string, _options?: unknown, reference_year?: number) => python({action: "inspect", question, business_date, reference_year}),
    matchMetricQuestion: async (question: string) => python({action: "mentions", question}),
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, year?: number, source?: unknown, model_value?: unknown) =>
      python({action: "resolve", entity, raw, year, source, model_value}),
    resolveBusinessFieldSuggestion: async (entity: string, suggested: unknown, _options?: unknown, source_question?: string, raw: string[] = []) =>
      python({action: "resolve", entity, raw, suggested, source: {source_question}}),
    resolveOrganizationScope: async (scope: any) => {
      scopes.push(scope);
      if (unavailable) throw new BackendApiError(503, "isolated_backend_failure", "SYNTH_BACKEND_UNAVAILABLE");
      return python({action: "scope", scope: {kind: scope.kind, source_text: scope.sourceText,
        ...(scope.kind === "authorized_cohort" ? {cohort: scope.cohort} : {parent_name: scope.parentName})}});
    },
    metricCatalogOverview: async () => ({total: metrics.length, groups: [{unit: "元", count: metrics.length, examples: metrics}]}),
    searchMetrics: async (keyword: string) => ({total: metrics.filter(m => m.name.includes(keyword)).length,
      items: metrics.filter(m => m.name.includes(keyword)).map(m => ({metric_code: m.code, metric_name: m.name, unit: m.unit, score: 1, match_type: "exact"})), semantic_suggestions: []}),
    searchOrganizations: async (keyword: string) => ({total: orgs.filter(o => o.name.includes(keyword)).length,
      items: orgs.filter(o => o.name.includes(keyword)).map(o => ({org_code: o.code, org_name: o.name, score: 1, match_type: "exact"}))}),
    createAgentQueryContext: async () => ({conversation_id: "synthetic-structured"}),
    basicQueries: async (spec: any) => {
      const actual = python({action: "query", spec}), id = `query-${queries.length + 1}`;
      queries.push({spec, bound_organizations: actual.bound_organizations, sql: actual.sql, parameters: actual.parameters, rows: actual.rows});
      const result = {status: "succeeded", task_id: id, result_id: `result-${id}`, rows: actual.rows,
        columns: Object.keys(actual.rows[0] ?? {}), row_count: actual.rows.length, truncated: false};
      results.set(id, result); return {query: spec, result};
    },
    getTask: async (id: string) => {assert(results.has(id)); return {task_id: id, status: "SUCCEEDED", version: 1, result: {result_id: `result-${id}`}};},
    getTaskResult: async (id: string) => {assert(results.has(id)); return results.get(id);},
  } as unknown as BackendClient;
  return {client, queries, scopes};
}

if (!process.argv.includes("--live")) {
  const scope = python({action: "scope", scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks", source_text: "各家农商行"}}).value;
  assert.equal(scope.codes.length, ALL.length);
  assert.equal(python({action: "query", spec: {conversation_id: "synthetic-structured", calculation_context: {scope_id: "synthetic-operation"}, organization_scope: scope.scope, scope_fingerprint: scope.scope_fingerprint, metric_codes: ["SYNTH_CREDIT:D"], time: {start: "2026-04-30", end: "2026-04-30"}, selection: "exact", operation: {kind: "ranking", position: "top", top_n: 3}}}).rows.length, 3);
  assert.equal(python({action: "query", spec: {org_codes: ALL, metric_codes: ["SYNTH_CREDIT:D"], time: {start: "2026-04-30", end: "2026-04-30"}, selection: "exact", operation: {kind: "ranking", position: "top", top_n: 3}}}).rows.length, 3);
  const position = python({action: "query", spec: {org_codes: ["SYNTH_WX"], comparison_scope: {organization_scope: scope.scope, scope_fingerprint: scope.scope_fingerprint},
    metric_codes: ["SYNTH_CREDIT:D"], time: {start: "2026-05-31", end: "2026-05-31"}, selection: "exact", operation: {kind: "rank_position"}}});
  assert.equal(position.rows.length, 1); assert(!("rank_metadata" in position.rows[0]));
  console.log(JSON.stringify({fixture: "passed", real_model: false}));
} else {
  const config = loadConfig(), directory = await mkdtemp(join(tmpdir(), "structured-query-live-"));
  const store = new NativeSessionStore(directory), host = new HarnessHost({...config, dataDir: directory},
    authorize => createAskMetricModels(config, authorize), store, createAskMetricTools());
  const actor: BackendUser = {id: "synthetic-structured", username: "synthetic", display_name: "结构化验收", org_code: "SYNTH_ROOT", org_name: "合成省联社", role_code: "USER"};
  const reports: any[] = [];
  const planned = scenarios.filter(s => !selected.size || selected.has(s.id));
  const plannedTurns = planned.reduce((count, scenario) => count + scenario.turns.length, 0);
  const sources = ["src/semantic-task/protocol.ts", "src/semantic-task/structuredQuery.ts", "src/semantic-task/prompt.ts", "src/semantic-task/service.ts",
    "src/semantic-task/planService.ts", "src/semantic-task/actionBinding.ts", "src/semantic-task/feedback.ts", "scripts/structured-query-fixture.py"];
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
  const save = async () => {await mkdir(dirname(reportPath), {recursive: true}); await writeFile(reportPath, JSON.stringify({
    environment: "real_model_real_python_binding_in_memory_SQL", real_database: false, model: config.model.name,
    native_session_directory: directory, source_hashes: sourceHashes, planned_scenarios: planned.length, planned_turns: plannedTurns,
    passed: reports.length === plannedTurns && reports.every(r => r.passed), turns: reports,
  }, null, 2));};
  try {
    for (const scenario of planned) {
      const hosted = await host.createSession(actor), b = backend(scenario.unavailable);
      for (const [index, turn] of scenario.turns.entries()) {
        const before = b.queries.length, started = performance.now();
        const admission = await host.admitPrompt(hosted, {protocol_version: 3, request_id: `${scenario.id}-${index}`, message: turn.message}, {actor, backend: b.client});
        assert(admission.ok);
        let failure: string | undefined;
        const timer = setTimeout(() => {void host.abort(hosted, admission.operationId);}, 120000);
        try {assert((await host.drivePrompt(hosted, admission)).ok);} catch (error) {failure = String(error);} finally {clearTimeout(timer);}
        const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
        const start = entries.map((entry: any) => entry.type === "message" && entry.message.role === "user").lastIndexOf(true);
        const current = entries.slice(start), messages = current.flatMap((entry: any) => entry.type === "message" ? [entry.message] : []);
        const proposals = messages.flatMap((message: any) => message.role === "assistant" ? message.content.filter((c: any) => c.type === "toolCall" && c.name === "resolve_business_turn").map((c: any) => c.arguments) : []);
        const formal = messages.filter((message: any) => message.role === "toolResult" && isSemanticFeedback(message.details)).at(-1)?.details as SemanticFeedback | undefined;
        const answer = authoritativeAnswer(projectEntries(current)).final?.text ?? "", queries = b.queries.slice(before);
        try {
          assert(!failure, failure);
          assert.equal(formal?.status, turn.status ?? "succeeded", JSON.stringify(formal?.issues));
          if (turn.initial) assert(proposals[0]?.targets.every((target: any) => target.query && !target.operations), "INITIAL_STRUCTURED_QUERY_REQUIRED");
          if (turn.expected) {
            assert.equal(queries.length, turn.expected.length, "QUERY_COUNT");
            for (const expected of turn.expected) {
              const actual = queries.find(q => q.spec.metric_codes.length === 1 && q.spec.metric_codes[0] === expected.metric);
              assert(actual, "EXPECTED_METRIC");
              assert.deepEqual([...(actual.spec.org_codes?.length ? actual.spec.org_codes : actual.bound_organizations)].sort(), [...(expected.organizations ?? ALL)].sort());
              assert.deepEqual(actual.spec.time, {start: expected.start ?? expected.day, end: expected.end ?? expected.day});
              assert.equal(actual.spec.selection, expected.selection ?? "exact");
              assert.deepEqual(actual.spec.operation, expected.operation);
              assert.equal(actual.rows.length, expected.rows);
              assert(actual.sql && actual.parameters, "REAL_SQL_BUILDER_REQUIRED");
            }
          } else assert.equal(queries.length, 0, "UNREADY_MUST_NOT_QUERY");
          if (turn.publicFailure) assert.equal(answer, "没能完成这次查询。");
        } catch (error) {failure = error instanceof Error ? error.message : String(error);}
        const report = {scenario: scenario.id, turn: index + 1, message: turn.message, passed: !failure, failure,
          status: formal?.status, elapsed_ms: Math.round(performance.now() - started), proposals, scopes: b.scopes,
          queries, issues: formal?.issues, answer};
        reports.push(report); await save();
        console.log(JSON.stringify({scenario: scenario.id, turn: index + 1, passed: !failure, status: formal?.status, failure}));
        if (failure) break;
      }
    }
  } finally {await save(); await host.close(); await store.close();}
  if (reports.some(report => !report.passed)) process.exitCode = 1;
}
