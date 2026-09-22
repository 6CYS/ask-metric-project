/** 真实 Pi 连续追问 + 真实 Python DateResolver；目录/数据为隔离合成桩。 */
import {syntheticMetricResolver} from "./syntheticMetricResolver.js";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {createBusinessSkillReadTool, loadBusinessSkills} from "../src/businessSkills.js";
import {projectEntries} from "../src/sessionProjection.js";
import type {BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";
import type {FieldResolution} from "../src/business-context/types.js";

const handoff = process.argv.includes("--handoff");
const metricCatalog = handoff
  ? [{code: "M1", name: "个人经营性贷款余额全省均值"}, {code: "M2", name: "个人经营性贷款余额较年初"}]
  : [{code: "M1", name: "合成指标甲"}, {code: "M2", name: "合成指标乙"}];
const cases: Array<{text: string; org?: string; metric?: string; start?: string; end?: string; query: number; status?: string; reopen?: boolean}> = handoff ? [
  {text: "合成机构甲2024年4月末个人经营性贷款余额全省均值是多少？", org: "O1", start: "2024-04-30", end: "2024-04-30", query: 1},
  {text: "3月末的呢？", org: "O1", start: "2024-03-31", end: "2024-03-31", query: 1},
  {text: "个人经营性贷款余额较年初是多少呢？", org: "O1", metric: "M2", start: "2024-03-31", end: "2024-03-31", query: 1, reopen: true},
  {text: "把刚才的查询结果再展示一次，不要重新查。", org: "O1", metric: "M2", start: "2024-03-31", end: "2024-03-31", query: 0},
] : [
  {text: "查询合成机构甲2024年3月31日的合成指标甲。", org: "O1", start: "2024-03-31", end: "2024-03-31", query: 1},
  {text: "合成机构乙呢？", org: "O2", start: "2024-03-31", end: "2024-03-31", query: 1},
  {text: "4 月份的呢？", org: "O2", start: "2024-04-01", end: "2024-04-30", query: 1},
  {text: "把最开始那笔查询的已有结果再展示一次，不要重新查。", org: "O1", start: "2024-03-31", end: "2024-03-31", query: 0},
  {text: "回到最开始那笔，把日期改为5月末，查一下。", org: "O1", start: "2024-05-31", end: "2024-05-31", query: 1, reopen: true},
  {text: "另外新查合成机构甲的合成指标乙。", query: 0, status: "clarifying"},
  {text: "日期是2023年2月末。", org: "O1", metric: "M2", start: "2023-02-28", end: "2023-02-28", query: 1},
];
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({status: "fixtures_valid", turns: cases.length, model_called: false}));
} else {
  const dir = await mkdtemp(join(tmpdir(), "pi-multiturn-"));
  const config = {...loadConfig(), dataDir: dir};
  const store = new NativeSessionStore(dir);
  // 与正式服务一致加载可选业务知识，验证模型同时看到目录与当前工具契约的行为。
  const skills = await loadBusinessSkills();
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store,
    [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
  const actor: BackendUser = {id: "synthetic-multiturn", username: "synthetic", display_name: "合成验收", org_code: "O1", org_name: "合成机构甲", role_code: "USER"};
  const queries: BasicQuerySpec[] = [];
  const snapshots = new Map<string, Record<string, unknown>>();
  const reports: Array<Record<string, unknown>> = [];
  const backendDir = resolve("../backend-next");
  const runFile = promisify(execFile);
  let reads = 0;
  const backend = {
    matchMetricQuestion: syntheticMetricResolver(metricCatalog),
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, referenceYear?: number): Promise<FieldResolution> => {
      if (entity === "date") {
        const {stdout} = await runFile(join(backendDir, ".venv/bin/python"), ["-c",
          "import json,sys;from datetime import date;from ask_metric.application.field_resolution import resolve_date_field;print(json.dumps(resolve_date_field(sys.argv[1],date(2026,9,21),reference_year=int(sys.argv[2]) if sys.argv[2] else None)))", raw[0]!, String(referenceYear ?? "")],
          {cwd: backendDir, env: {...process.env, PYTHONPATH: join(backendDir, "src")}});
        return JSON.parse(stdout);
      }
      const catalog = entity === "metric" ? metricCatalog
        : [{code: "O1", name: "合成机构甲"}, {code: "O2", name: "合成机构乙"}];
      const matches = raw.map(value => catalog.find(item => item.name === value || item.code === value));
      return matches.length && matches.every(Boolean) ? {status: "resolved", value: {codes: matches.map(item => item!.code), names: matches.map(item => item!.name)}} : {status: "not_found"};
    },
    createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}),
    basicQueries: async (spec: BasicQuerySpec) => {
      queries.push(spec);
      const taskId = `synthetic-${queries.length}`;
      const snapshot = {task_id: taskId, result_id: `result:${taskId}`, status: "succeeded", rows: [{metric_value: "731.25", unit: "元", data_date: spec.time.end}],
        columns: ["metric_value", "unit", "data_date"], row_count: 1, offset: 0, limit: 20, has_more: false, truncated: false,
        message: `合成查询返回731.25元，日期${spec.time.end}。`, evidence: {logical_dsl: {metrics: spec.metric_codes, orgs: spec.org_codes, time: spec.time}}};
      snapshots.set(taskId, snapshot); return {result: snapshot};
    },
    getTask: async (taskId: string) => ({task_id: taskId, status: "SUCCEEDED", version: 1, result: {result_id: `result:${taskId}`}}),
    getTaskResult: async (taskId: string) => {reads++; const snapshot = snapshots.get(taskId); assert(snapshot); return snapshot;},
  } as unknown as BackendClient;
  try {
    let session = await host.createSession(actor);
    for (const [index, test] of cases.entries()) {
      if (test.reopen) {const id = session.sessionId; await host.closeSession(id); session = (await host.openSession(actor, id))!;}
      const before = queries.length; const beforeReads = reads; const started = performance.now();
      const requestId = `turn-${index + 1}`;
      await host.runPrompt(session, {protocol_version: 3, request_id: requestId, message: test.text}, {actor, backend});
      const frames = new NativeFrameStore(session.session);
      let clarificationFollowup = false;
      const interimState = await frames.state();
      const interim = interimState.focusFrameId ? await frames.get(interimState.focusFrameId) : undefined;
      // 整月与时点存在业务歧义时，方案允许只澄清口径；明确补充后再核验正式查询。
      if (index === 2 && interim?.status === "clarifying" && interim.issues.every(issue => issue.field === "selection")) {
        assert.deepEqual(interim.fields.time?.resolvedValue, {start: test.start, end: test.end});
        assert.deepEqual((interim.fields.organizations?.resolvedValue as {codes: string[]})?.codes, [test.org]);
        assert.equal(queries.length, before, "clarification must not query");
        clarificationFollowup = true;
        await host.runPrompt(session, {protocol_version: 3, request_id: `${requestId}-clarify`, message: "展示整个月的全部已有记录。"}, {actor, backend});
      }
      const state = await frames.state(); const focus = state.focusFrameId ? await frames.get(state.focusFrameId) : undefined;
      const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
      const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
      const turn = messages.slice(messages.findLastIndex(message => message.role === "user") + 1);
      const toolResults = turn.filter(message => message.role === "toolResult");
      const toolNames = toolResults.map(message => message.toolName);
      const answer = projectEntries(entries).filter(message => message.role === "assistant").at(-1);
      const errors: string[] = [];
      try {
        assert.equal(queries.length - before, test.query, "query count");
        assert.equal(focus?.status, test.status ?? "success", "frame status");
        if (test.org) {
          assert.deepEqual(focus?.fields.organizations?.resolvedValue, {codes: [test.org], names: [test.org === "O1" ? "合成机构甲" : "合成机构乙"]});
          assert.deepEqual(focus?.fields.time?.resolvedValue, {start: test.start, end: test.end});
          assert.deepEqual((focus?.fields.metrics?.resolvedValue as {codes: string[]})?.codes, [test.metric ?? "M1"]);
          assert(answer?.text.includes("731.25"), "native answer must use actual synthetic value");
        }
        if (index === 3) assert.equal(reads - beforeReads, 1, "result reuse read count");
        assert(!toolNames.some(name => ["answer_present", "answer_evidence_check", "metric_ask"].includes(name)));
        assert(toolNames.filter(name => name === "resolve_business_turn").length <= 2, "repeated resolution");
        assert(toolNames.length <= 4, "unexpected repeated tools");
        assert(!turn.some(message => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)));
      } catch (error) {errors.push(error instanceof Error ? error.message : String(error));}
      const report = {turn: index + 1, clarification_followup: clarificationFollowup, passed: !errors.length, errors, tools: toolNames, query_count: queries.length - before,
        reads: reads - beforeReads, model_calls: turn.filter(message => message.role === "assistant").length,
        elapsed_ms: Math.round(performance.now() - started), focus_status: focus?.status, fields: focus?.fields, answer};
      reports.push(report); console.log(JSON.stringify({turn: report.turn, passed: report.passed, errors, tools: toolNames, query_count: report.query_count, elapsed_ms: report.elapsed_ms}));
      await writeFile(join(dir, "report.json"), JSON.stringify({passed: reports.length === cases.length && reports.every(item => item.passed), environment: "configured_model_synthetic_backend_real_date_resolver", business_skills: skills.map(skill => skill.name), reports}, null, 2));
    }
    console.log(JSON.stringify({report: join(dir, "report.json"), passed: reports.every(item => item.passed)}));
    if (reports.some(item => !item.passed)) process.exitCode = 1;
  } finally {await host.close(); await store.close();}
}
