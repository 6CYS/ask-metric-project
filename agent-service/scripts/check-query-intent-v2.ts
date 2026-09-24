/** 默认仅离线验收语料与契约；--live 显式授权调用已配置模型，业务后端始终为合成桩。
 * 运行：node --import tsx scripts/check-query-intent-v2.ts [--live] [--case original] [--repeat 3] [--concurrency 2]
 * 模型配置由调用方加载环境；脚本不读取 .env，不输出配置、凭据或 HTTP 响应。
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {cases, metrics, organizations, defaultVisible, type AcceptanceCase, type Expectation} from "./query-intent-v2-cases.js";
import {syntheticMetricResolver} from "./syntheticMetricResolver.js";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {createBusinessSkillReadTool, loadBusinessSkills} from "../src/businessSkills.js";
import {createCapabilities} from "../src/business-context/capabilities.js";
import {projectEntries} from "../src/sessionProjection.js";
import {BackendApiError} from "../src/backendClient.js";
import type {BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";
import type {BusinessFrame, FieldResolution, OrganizationScope, OrganizationScopeInput} from "../src/business-context/types.js";

const args = process.argv.slice(2);
function option(...names: string[]): string | undefined {
  const index = args.findIndex(arg => names.includes(arg));
  if (index < 0) return undefined;
  const value = args[index + 1];
  assert(value && !value.startsWith("--"), `Missing value for ${args[index]}`);
  return value;
}
const repeat = Number(option("--repeat") ?? 1);
assert(Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= 20, "--repeat must be 1..20");
const concurrency = Number(option("--concurrency") ?? 2);
assert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 3, "--concurrency must be 1..3");
const filter = option("--case", "--only")?.split(",");
const selected = filter ? cases.filter(test => filter.includes(test.id)) : cases;
assert(selected.length && (!filter || filter.every(id => selected.some(test => test.id === id))), "Unknown/empty case selection");
const forbiddenTools = new Set(["metric_ask", "metric_query_structured", "answer_present", "answer_evidence_check"]);
const runFile = promisify(execFile);
const backendDir = resolve(import.meta.dirname, "../../backend-next");
const fingerprint = (scope: OrganizationScope, codes: string[]) => createHash("sha256").update(JSON.stringify({scope, codes})).digest("hex");
const safeError = (error: unknown) => error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError";

async function resolveScope(raw: OrganizationScopeInput, visible: string[]): Promise<FieldResolution> {
  if (!raw || typeof raw !== "object" || typeof raw.sourceText !== "string" || !raw.sourceText.trim()) return {status: "invalid"};
  let scope: OrganizationScope;
  if (raw.kind === "authorized_cohort") {
    if (raw.cohort !== "rural_commercial_banks" || Object.keys(raw).some(key => !["kind", "cohort", "sourceText"].includes(key))) return {status: "invalid"};
    const {stdout} = await runFile(join(backendDir, ".venv/bin/python"), ["-c",
      "import json,sys;from ask_metric.domain.organization_scope import is_authorized_cohort_source;print(json.dumps(is_authorized_cohort_source(sys.argv[1],sys.argv[2])))", raw.cohort, raw.sourceText],
      {cwd: backendDir, env: {...process.env, PYTHONPATH: join(backendDir, "src")}});
    if (!JSON.parse(stdout)) throw new BackendApiError(422, "机构原文不是明确集合", "SCOPE_SOURCE_INVALID");
    scope = {kind: "authorized_cohort", cohort: "rural_commercial_banks"};
  } else if (raw.kind === "children_of") {
    if (typeof raw.parentName !== "string" || Object.keys(raw).some(key => !["kind", "parentName", "sourceText"].includes(key))) return {status: "invalid"};
    const parent = organizations.find(org => org.name === raw.parentName || org.code === raw.parentName);
    if (!parent || !visible.includes(parent.code)) return {status: "not_found"};
    scope = {kind: "children_of", parent_code: parent.code};
  } else return {status: "invalid"};
  const targets = organizations.filter(org => visible.includes(org.code) && (scope.kind === "authorized_cohort"
    ? org.kind === "rural_commercial_bank" : org.parent === scope.parent_code));
  if (!targets.length) throw new BackendApiError(422, "该机构范围内没有当前账号可查看的机构", "EMPTY_AUTHORIZED_SCOPE");
  const codes = targets.map(org => org.code);
  return {status: "resolved", value: {codes, names: targets.map(org => org.name), scope, scope_fingerprint: fingerprint(scope, codes)}};
}
async function validateFixtures() {
  assert(cases.length >= 30);
  assert.equal(new Set(cases.map(test => test.id)).size, cases.length);
  const schema = createCapabilities().get("metric_query");
  assert.deepEqual(schema.fields.selection?.validation?.enum, ["exact", "latest_in_range", "all_in_range"]);
  assert(schema.fields.operation?.inputSchema);
  assert(!("order" in schema.fields) && !("top_n" in schema.fields));
  assert(!createAskMetricTools().some(tool => forbiddenTools.has(tool.name)));
  for (const test of cases) for (const turn of test.turns) {
    assert(turn.text.trim());
    const expected = turn.expect;
    if (!expected.queryCount) continue;
    assert(Boolean(expected.scope) !== Boolean(expected.orgCodes));
    assert(expected.metricCodes?.length && expected.time && expected.selection && expected.operation);
    assert(expected.metricCodes.every(code => metrics.some(metric => metric.code === code)));
    if (expected.selection === "exact") assert.equal(expected.time.start, expected.time.end);
    if (expected.operation.kind === "ranking") assert(expected.operation.top_n >= 1 && expected.operation.top_n <= 100);
  }
  const scoped = await resolveScope({kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "各家农商行"}, ["O2", "B3"]);
  assert.deepEqual((scoped.value as {codes: string[]}).codes, ["O2"]);
  assert.match((scoped.value as {scope_fingerprint: string}).scope_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await resolveScope({kind: "children_of", parentName: "合成甲农商行", sourceText: "合成甲农商行下属"}, ["O2", "B3"])).status, "not_found");
  assert.equal((await resolveScope({kind: "children_of", parentName: "未知农商行", sourceText: "未知农商行下属"}, defaultVisible)).status, "not_found");
  assert.equal((await resolveScope({kind: "authorized_cohort", cohort: "unknown", sourceText: "各家"} as unknown as OrganizationScopeInput, defaultVisible)).status, "invalid");
  await assert.rejects(() => resolveScope({kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "各家农商行"}, ["B1"]),
    error => error instanceof BackendApiError && error.code === "EMPTY_AUTHORIZED_SCOPE");
  await assert.rejects(() => resolveScope({kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "合成不存在农商行"}, defaultVisible),
    error => error instanceof BackendApiError && error.code === "SCOPE_SOURCE_INVALID");
}
await validateFixtures();

interface Trace {method: string; input?: unknown; status?: string}
function syntheticBackend(test: AcceptanceCase) {
  const visible = test.visible ?? defaultVisible;
  const queries: BasicQuerySpec[] = [];
  const trace: Trace[] = [];
  const snapshots = new Map<string, Record<string, unknown>>();
  const scopeValues = new Map<string, {scope: OrganizationScope; codes: string[]}>();
  const match = syntheticMetricResolver(metrics);
  const implementation = {
    matchMetricQuestion: async (question: string) => {trace.push({method: "matchMetricQuestion", input: question}); return match(question);},
    resolveOrganizationScope: async (raw: OrganizationScopeInput) => {
      const event: Trace = {method: "resolveOrganizationScope", input: raw};
      trace.push(event);
      let response: FieldResolution;
      try {response = await resolveScope(raw, visible);} catch (error) {
        event.status = error instanceof BackendApiError ? error.code ?? "error" : "error";
        throw error;
      }
      event.status = response.status;
      if (response.status === "resolved") {
        const value = response.value as {scope: OrganizationScope; codes: string[]; scope_fingerprint: string};
        scopeValues.set(value.scope_fingerprint, value);
      }
      return response;
    },
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, referenceYear?: number): Promise<FieldResolution> => {
      trace.push({method: "resolveBusinessField", input: {entity, raw, referenceYear}});
      if (entity === "date") {
        const {stdout} = await runFile(join(backendDir, ".venv/bin/python"), ["-c",
          "import json,sys;from datetime import date;from ask_metric.application.field_resolution import resolve_date_field;print(json.dumps(resolve_date_field(sys.argv[1],date(2026,9,22),reference_year=int(sys.argv[2]) if sys.argv[2] else None)))", raw[0] ?? "", String(referenceYear ?? "")],
          {cwd: backendDir, env: {...process.env, PYTHONPATH: join(backendDir, "src")}});
        return JSON.parse(stdout);
      }
      if (entity === "organization") {
        const catalog = organizations.filter(org => visible.includes(org.code)).map(({code, name}) => ({code, name}));
        const {stdout} = await runFile(join(backendDir, ".venv/bin/python"), ["-c",
          "import json,sys;from ask_metric.application.field_resolution import resolve_catalog_field;from ask_metric.domain.semantics import OrganizationCatalogItem;print(json.dumps(resolve_catalog_field('organization',json.loads(sys.argv[1]),[OrganizationCatalogItem.model_validate(item) for item in json.loads(sys.argv[2])]),ensure_ascii=False))", JSON.stringify(raw), JSON.stringify(catalog)],
          {cwd: backendDir, env: {...process.env, PYTHONPATH: join(backendDir, "src")}});
        return JSON.parse(stdout);
      }
      const catalog = entity === "metric" ? metrics : organizations.filter(org => visible.includes(org.code));
      const found = raw.map(value => catalog.find(item => item.name === value || item.code === value));
      return found.length && found.every(Boolean) ? {status: "resolved", value: {codes: found.map(item => item!.code), names: found.map(item => item!.name)}} : {status: "not_found"};
    },
    searchMetrics: async (keyword: string) => {
      trace.push({method: "searchMetrics", input: keyword});
      const found = metrics.filter(item => item.name.includes(keyword) || item.code === keyword);
      return {total: found.length, items: found.map(item => ({metric_code: item.code, metric_name: item.name, score: 1, match_type: item.name === keyword ? "exact" : "contains"})), semantic_suggestions: []};
    },
    searchOrganizations: async (keyword: string) => {
      trace.push({method: "searchOrganizations", input: keyword});
      const found = organizations.filter(item => visible.includes(item.code) && (item.name.includes(keyword) || item.code === keyword));
      return {total: found.length, items: found.map(item => ({org_code: item.code, org_name: item.name, score: 1, match_type: item.name === keyword ? "exact" : "contains"}))};
    },
    createAgentQueryContext: async () => ({conversation_id: `synthetic-${test.id}`}),
    basicQueries: async (spec: BasicQuerySpec) => {
      trace.push({method: "basicQueries", input: spec});
      assert.equal(spec.schema_version, 2);
      assert(!("order" in spec) && !("top_n" in spec));
      assert(["exact", "latest_in_range", "all_in_range"].includes(spec.selection));
      let targets: string[];
      if (spec.organization_scope) {
        assert.equal(spec.org_codes, undefined, "scope must not also carry explicit codes");
        const resolved = scopeValues.get(spec.scope_fingerprint!);
        assert(resolved, "scope fingerprint must originate from resolver");
        assert.deepEqual(resolved.scope, spec.organization_scope);
        targets = resolved.codes;
        assert.equal(spec.scope_fingerprint, fingerprint(spec.organization_scope, targets));
      } else {
        assert(spec.org_codes?.length);
        assert.equal(spec.scope_fingerprint, undefined);
        targets = spec.org_codes;
      }
      assert(targets.every(code => visible.includes(code)), "query target outside synthetic permissions");
      assert(spec.metric_codes.every(code => metrics.some(metric => metric.code === code)));
      queries.push(structuredClone(spec));
      const taskId = `synthetic-${test.id}-${queries.length}`;
      let rows = targets.flatMap((code, index) => spec.metric_codes.map(metricCode => ({org_code: code, org_name: organizations.find(org => org.code === code)!.name,
        metric_code: metricCode, metric_name: metrics.find(metric => metric.code === metricCode)!.name,
        metric_value: String(731 - index * 37), unit: metrics.find(metric => metric.code === metricCode)!.unit,
        data_date: spec.time.end})));
      if (spec.operation?.kind === "ranking") {
        const order = spec.operation.order;
        rows.sort((a, b) => (Number(a.metric_value) - Number(b.metric_value)) * (order === "asc" ? 1 : -1));
        rows = rows.slice(0, spec.operation.top_n);
      }
      const snapshot = {task_id: taskId, result_id: `result:${taskId}`, status: "succeeded", rows,
        columns: ["org_name", "metric_name", "metric_value", "unit", "data_date"], row_count: rows.length,
        offset: 0, limit: 100, next_offset: null, has_more: false, truncated: false, comparisons: [],
        message: `合成数据查询成功，返回${rows.length}条，日期${spec.time.end}。`,
        evidence: {logical_dsl: {metrics: spec.metric_codes, orgs: targets, time: spec.time, options: {selection: spec.selection, operation: spec.operation}},
          catalog: {metrics: metrics.filter(metric => spec.metric_codes.includes(metric.code)), organizations: organizations.filter(org => targets.includes(org.code)).map(({code, name}) => ({code, name}))}}};
      snapshots.set(taskId, snapshot);
      return {query: spec, result: snapshot};
    },
    getTask: async (taskId: string) => {assert(snapshots.has(taskId)); return {task_id: taskId, status: "SUCCEEDED", version: 1, result: {result_id: `result:${taskId}`}};},
    getTaskResult: async (taskId: string) => {trace.push({method: "getTaskResult", input: taskId}); const snapshot = snapshots.get(taskId); assert(snapshot); return snapshot;},
  };
  // 未实现的方法显式失败；任何旧语义调用都留痕并使验收失败，禁止隐式联网。
  const backend = new Proxy(implementation, {get(target, property, receiver) {
    if (property === "withTraceId" || property === "then") return undefined;
    if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
    return (..._args: unknown[]) => {trace.push({method: `UNEXPECTED:${String(property)}`}); throw new Error("UNEXPECTED_SYNTHETIC_BACKEND_CALL");};
  }}) as unknown as BackendClient;
  return {backend, queries, trace};
}

function checkExpectation(expected: Expectation, queries: BasicQuerySpec[], frame: BusinessFrame | undefined, trace: Trace[]) {
  assert.equal(queries.length, expected.queryCount, "query count");
  if (expected.status) assert.equal(frame?.status, expected.status, "focus frame status");
  if (expected.issueField) assert(frame?.issues.some(issue => issue.field === expected.issueField), `missing issue ${expected.issueField}`);
  if (expected.noScopeCalls) assert(!trace.some(item => item.method === "resolveOrganizationScope" && item.status === "resolved"), "explicit/unknown institution must not resolve to scope");
  if (!expected.queryCount) return;
  const query = queries[0]!;
  assert(frame);
  assert.deepEqual([...query.metric_codes].sort(), [...expected.metricCodes!].sort(), "all requested metrics");
  assert.deepEqual(query.time, expected.time, "query dates");
  assert.equal(query.selection, expected.selection, "date selection");
  assert.deepEqual(query.operation ?? {kind: "value"}, expected.operation, "query operation");
  assert.deepEqual(frame.fields.operation?.resolvedValue ?? {kind: "value"}, expected.operation, "frame operation");
  assert.deepEqual(frame.fields.time?.resolvedValue, expected.time, "frame dates");
  const organizationsValue = frame.fields.organizations?.resolvedValue as {scope?: OrganizationScope; codes: string[]; scope_fingerprint?: string};
  if (expected.scope) {
    assert.deepEqual(query.organization_scope, expected.scope, "query scope");
    assert.deepEqual(organizationsValue.scope, expected.scope, "frame scope");
    assert.equal(query.scope_fingerprint, organizationsValue.scope_fingerprint);
    assert.equal(query.org_codes, undefined);
  } else {
    assert.deepEqual([...(query.org_codes ?? [])].sort(), [...expected.orgCodes!].sort(), "explicit targets must not expand to children");
    assert.equal(query.organization_scope, undefined);
    assert.equal(organizationsValue.scope, undefined);
  }
}

if (!args.includes("--live")) {
  console.log(JSON.stringify({status: "fixtures_and_protocol_valid", cases: cases.length, selected_cases: selected.length,
    selected_turns: selected.reduce((sum, test) => sum + test.turns.length, 0), repeats: repeat, concurrency, model_called: false,
    backend: "synthetic_only", limitation: "Offline validation does not prove real model intent parsing or SQL execution"}));
} else {
  const dir = await mkdtemp(join(tmpdir(), "query-intent-v2-"));
  // 每次模型流限时，避免单个坏网关请求拖住整批；不使用不能取消请求的 Promise.race。
  const config = {...loadConfig(), modelTimeoutMs: 60_000, dataDir: dir, maxSessionsPerUser: Math.max(cases.length * repeat, 100)};
  const store = new NativeSessionStore(dir);
  const skills = await loadBusinessSkills();
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store,
    [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
  const reports: Array<Record<string, unknown>> = [];
  const reportPath = option("--report") ?? join(dir, "report.json");
  let reportWrite: Promise<void> = Promise.resolve();
  const saveReport = () => {
    const content = JSON.stringify({environment: "configured_real_model_synthetic_backend_real_python_resolvers",
    model_called: true, production_backend_called: false, sql_executed: false, reference_date: "2026-09-22",
    model_name: config.model.name, model_timeout_ms: config.modelTimeoutMs, concurrency,
    selected_cases: selected.map(test => test.id), repeats: repeat, business_skills: skills.map(skill => skill.name),
    passed: reports.length === selected.reduce((sum, test) => sum + test.turns.length, 0) * repeat && reports.every(item => item.passed), reports}, null, 2);
    reportWrite = reportWrite.then(() => writeFile(reportPath, content));
    return reportWrite;
  };
  const runCase = async (test: AcceptanceCase, iteration: number) => {
      const actor: BackendUser = {id: `synthetic-${test.id}-${iteration}`, username: "synthetic", display_name: "合成入口验收", org_code: "O1", org_name: "合成甲农商行", role_code: "USER"};
      const {backend, queries, trace} = syntheticBackend(test);
      let session = await host.createSession(actor);
      try {
        for (const [turnIndex, turn] of test.turns.entries()) {
          if (turn.reopen) {const id = session.sessionId; await host.closeSession(id); session = (await host.openSession(actor, id))!; assert(session);}
          const queryStart = queries.length; const traceStart = trace.length;
          const initialEntries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
          const started = performance.now();
          const errors: string[] = [];
          const requestId = `${test.id}-${iteration}-${turnIndex}`;
          let operationId: string | undefined;
          try {
            const result = await host.runPrompt(session, {protocol_version: 3, request_id: requestId, message: turn.text}, {actor, backend});
            assert(result.ok, "host must admit and finish the prompt");
            operationId = result.operationId;
          }
          catch (error) {errors.push(`host: ${safeError(error)}`);}
          const frames = new NativeFrameStore(session.session);
          const state = await frames.state();
          const frame = state.focusFrameId ? await frames.get(state.focusFrameId) : undefined;
          const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
          const messages = entries.slice(initialEntries.length).filter(entry => entry.type === "message").map(entry => entry.message);
          const answer = projectEntries(entries.slice(initialEntries.length)).filter(message => message.role === "assistant").at(-1);
          const toolCalls = messages.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall").map(block => ({name: block.name, arguments: block.arguments})) : []);
          const toolResults = messages.filter(message => message.role === "toolResult").map(message => ({name: message.toolName,
            isError: message.isError, statuses: message.content.filter(block => block.type === "text").flatMap(block => {try {const value = JSON.parse(block.text); return [{status: value.status, error_code: value.error_code, frameId: value.frameId}];} catch {return [];}})}));
          const currentTrace = trace.slice(traceStart); const currentQueries = queries.slice(queryStart);
          try {
            assert(answer, "every turn must produce a visible answer");
            assert(answer.text.trim(), "every turn must produce a non-empty visible answer");
            assert(!answer.error, "visible answer must not be a transport failure");
            assert(!toolCalls.some(call => forbiddenTools.has(call.name)), "model must use only new business entry");
            assert(!currentTrace.some(item => item.method.startsWith("UNEXPECTED:") || /semantic|submit|clarify/i.test(item.method)), "legacy or undeclared backend call");
            assert(!messages.some(message => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)), "model must finish normally");
            assert(toolCalls.filter(call => call.name === "resolve_business_turn").length <= 3, "unbounded resolution retry");
            checkExpectation(turn.expect, currentQueries, frame, currentTrace);
            if (turn.expect.queryCount) {
              const resolvedAt = toolCalls.findIndex(call => call.name === "resolve_business_turn");
              const executeAt = toolCalls.findIndex(call => call.name === "execute_business_frame");
              const resolution = toolResults.find(result => result.name === "resolve_business_turn");
              const resolvedStatus = resolution?.statuses.some(status => ["READY", "succeeded"].includes(status.status));
              assert(resolvedAt >= 0 && resolvedStatus, "native model must resolve the business Frame");
              assert(executeAt > resolvedAt || resolution?.statuses.some(status => status.status === "succeeded"),
                "validated Frame must execute through the native tool receipt");
            }
          } catch (error) {errors.push(safeError(error));}
          const report = {case: test.id, group: test.group, iteration, turn: turnIndex + 1, input: turn.text,
            session_id: session.sessionId, request_id: requestId, operation_id: operationId, turn_id: operationId, answer,
            expected: turn.expect, passed: !errors.length, errors, elapsed_ms: Math.round(performance.now() - started),
            native_tool_calls: toolCalls, native_tool_results: toolResults,
            model_calls: messages.filter(message => message.role === "assistant").length,
            focus_frame: frame, basic_queries: currentQueries, backend_trace: currentTrace};
          reports.push(report);
          console.log(JSON.stringify({case: test.id, iteration, turn: turnIndex + 1, passed: report.passed, errors,
            tools: toolCalls.map(call => call.name), query_count: currentQueries.length, elapsed_ms: report.elapsed_ms}));
          await saveReport();
        }
      } finally {await host.closeSession(session.sessionId);}
  };
  try {
    const jobs = Array.from({length: repeat}, (_, index) => selected.map(test => ({test, iteration: index + 1}))).flat();
    let nextJob = 0;
    // 一个 case 的多轮严格串行；worker 之间会话、后端桩和查询记录完全隔离。
    const workers = Array.from({length: Math.min(concurrency, jobs.length)}, async () => {
      for (;;) {
        const job = jobs[nextJob++];
        if (!job) return;
        await runCase(job.test, job.iteration);
      }
    });
    const outcomes = await Promise.allSettled(workers);
    await reportWrite;
    for (const outcome of outcomes) if (outcome.status === "rejected") {
      process.exitCode = 1;
      console.log(JSON.stringify({status: "worker_failed", error: safeError(outcome.reason)}));
    }
    const passed = reports.length === selected.reduce((sum, test) => sum + test.turns.length, 0) * repeat
      && reports.every(item => item.passed) && outcomes.every(outcome => outcome.status === "fulfilled");
    console.log(JSON.stringify({report: reportPath, cases: selected.length, repeats: repeat, passed}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await store.close();}
}
