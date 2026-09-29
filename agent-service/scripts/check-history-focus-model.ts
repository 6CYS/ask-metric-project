/** 真实配置模型 + 隔离合成后端：验证语义引用、焦点切换和分支继承，不访问业务数据库。 */
import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
import type {BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";
import type {FieldResolution} from "../src/business-context/types.js";

interface Step {message: string; source: number; org?: string; orgs?: string[]; date?: string; query?: boolean; reopen?: boolean; read?: boolean; clarify?: boolean}
const cases: Array<{name: string; fresh?: boolean; unseeded?: boolean; steps: Step[]}> = [
  {name: "ordinal", steps: [{message: "把第一次我问的问题中组织机构更换为合成机构乙，查询出数据", source: 0, org: "O2"}]},
  {name: "relative", steps: [{message: "沿用上一笔之前那笔的条件，只把机构换成合成机构乙，查一下。", source: 1, org: "O2"}]},
  {name: "constraint", steps: [{message: "回到合成机构丙那笔，机构和指标不变，日期换为2026-06-30，查一下。", source: 1, org: "O3", date: "2026-06-30"}]},
  {name: "focus", steps: [
    {message: "回到最早那笔，告诉我当时的查询条件，暂时不要查询。", source: 0, org: "O1", query: false, reopen: true},
    {message: "现在只把机构换成合成机构乙，查一下。", source: 0, org: "O2"},
  ]},
  {name: "current", steps: [{message: "把机构换成合成机构乙，其他条件保留，查询数据。", source: 2, org: "O2"}]},
  // 机构话语指代：“上述两家”原样直传，服务端按会话历史解析为最近讨论的去重机构（合成机构甲、合成机构丙）。
  {name: "org_reference", steps: [{message: "上述两家机构，2026-05-31的数据分别是多少？", source: 2, orgs: ["O1", "O3"], date: "2026-05-31"}]},
  {name: "replay", steps: [
    {message: "重新显示第一次查询的已有结果，不要重新查询数据。", source: 0, org: "O1", query: false, read: true, reopen: true},
    {message: "把机构换成合成机构乙，其他条件不变，查一下。", source: 0, org: "O2"},
  ]},
  {name: "conversation", steps: [
    {message: "你好", source: 2, org: "O1", query: false},
    {message: "谢谢，先不用查询。", source: 2, org: "O1", query: false},
    {message: "一般来说，什么叫统计期间？只解释概念，不操作之前的查询。", source: 2, org: "O1", query: false},
  ]},
  {name: "clarification", unseeded: true, steps: [
    {message: "查询合成机构甲的合成指标甲和合成指标乙。", source: 0, org: "O1", query: false, clarify: true},
    {message: "日期为2026-04-30，请查询。", source: 0, org: "O1"},
  ]},
  // 历史也由真实用户回合建立，检验首轮建档、多指标继承、分支续接和重开后的焦点。
  {name: "fresh", fresh: true, steps: [
    {message: "把第一次问题的机构换成合成机构乙，保留其他条件查询。", source: 0, org: "O2"},
    {message: "日期改成2026-06-30，其他不变，查一下。", source: 0, org: "O2", date: "2026-06-30"},
    {message: "列出各次查询的条件，保持当前讨论对象不变，暂时不要查询。", source: 0, org: "O2", date: "2026-06-30", query: false},
    {message: "回到第二次查询，我们继续讨论那笔，先告诉我它的条件，不要取数。", source: 1, org: "O3", query: false, reopen: true},
    {message: "现在只把机构换成合成机构甲，查询数据。", source: 1, org: "O1"},
  ]},
];
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({status: "cases_listed", cases: cases.map(c => c.name), model_called: false}));
} else {
  const dir = await mkdtemp(join(tmpdir(), "pi-history-focus-"));
  const config = {...loadConfig(), dataDir: dir};
  const sessions = new NativeSessionStore(dir);
  const host = new HarnessHost(config, authorized => createAskMetricModels(config, authorized), sessions, createAskMetricTools());
  const actor: BackendUser = {id: "synthetic-history", username: "synthetic", display_name: "合成验收", org_code: "O1", org_name: "合成机构甲", role_code: "USER"};
  const metrics: Record<string, string> = {合成指标甲: "M1", 合成指标乙: "M2", 合成指标丙: "M3"};
  const orgs: Record<string, string> = {合成机构甲: "O1", 合成机构乙: "O2", 合成机构丙: "O3"};
  const seeds = [
    {metrics: ["合成指标甲", "合成指标乙"], org: "合成机构甲", date: "2026-04-30"},
    {metrics: ["合成指标乙"], org: "合成机构丙", date: "2026-02-28"},
    {metrics: ["合成指标丙"], org: "合成机构甲", date: "2026-03-31"},
  ];
  const resolveCatalog = async (entity: string, raw: string[]): Promise<FieldResolution> => {
    if (entity === "date") return /^2026-\d{2}-\d{2}$/.test(raw[0] ?? "")
      ? {status: "resolved", value: {start: raw[0], end: raw[0]}} : {status: "invalid"};
    const catalog = entity === "metric" ? metrics : orgs;
    return raw.every(name => catalog[name]) ? {status: "resolved", value: {codes: raw.map(name => catalog[name]!), names: raw}} : {status: "not_found"};
  };
  const reports: Array<Record<string, unknown>> = [];
  const filter = process.argv.find(arg => arg.startsWith("--case="))?.split("=")[1];
  const repeat = Number(process.argv.find(arg => arg.startsWith("--repeat="))?.split("=")[1] ?? 1);
  assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 10, "repeat 必须为 1 到 10");
  assert.ok(!filter || cases.some(test => test.name === filter), "未知 case");
  try {
    for (const {test, iteration} of Array.from({length: repeat}, (_, i) =>
      cases.filter(test => !filter || filter === test.name).map(test => ({test, iteration: i + 1}))).flat()) {
      let hosted = await host.createSession(actor);
      let frames = new NativeFrameStore(hosted.session);
      const service = new BusinessContextService(frames, createCapabilities(), createFieldResolvers());
      for (const [index, seed] of (test.fresh || test.unseeded ? [] : seeds).entries()) {
        const id = {sessionId: hosted.sessionId, requestId: `seed-${index}`, turnId: `seed-${index}`};
        const ready = await service.resolve({capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
          {fieldHint: "metrics", operation: "set", rawValue: seed.metrics},
          {fieldHint: "organizations", operation: "set", rawValue: seed.org},
          {fieldHint: "time", operation: "set", rawValue: seed.date},
          {fieldHint: "selection", operation: "set", rawValue: "exact"},
        ]}, id, {turnId: id.turnId, originalMessage: `${seed.org} ${seed.metrics.join(" ")} ${seed.date}`, currentDate: "2026-09-28", resolveCatalog});
        await service.finishExecution(await service.beginExecution(ready.frameId, id), {status: "success", resultRef: `query:seed-${index}:result`});
      }
      const queries: BasicQuerySpec[] = [];
      const reads: string[] = [];
      const backend = {
        resolveBusinessField: resolveCatalog,
        matchMetricQuestion: async (question: string) => ({mentions: Object.entries(metrics).filter(([name]) => question.includes(name)).map(([text, code]) => ({
          text, start: question.indexOf(text), end: question.indexOf(text) + text.length,
          resolution: {status: "resolved", value: {codes: [code], names: [text]}}}))}),
        createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
        basicQueries: async (spec: BasicQuerySpec) => {
          queries.push(spec);
          const task = `synthetic-${queries.length}`;
          return {result: {task_id: task, result_id: `result:${task}`, status: "succeeded", rows: [], columns: [], row_count: 0,
            message: "合成测试查询已完成，无记录。", evidence: {logical_dsl: {metrics: spec.metric_codes, orgs: spec.org_codes, time: spec.time}}}};
        },
        getTask: async (task_id: string) => ({task_id, status: "SUCCEEDED", version: 1,
          result: {result_id: task_id.startsWith("seed-") ? "result" : `result:${task_id}`}}),
        getTaskResult: async (task_id: string) => {
          reads.push(task_id);
          return {task_id, result_id: task_id.startsWith("seed-") ? "result" : `result:${task_id}`,
            status: "succeeded", rows: [], columns: [], row_count: 0, has_more: false, offset: 0,
            message: "合成历史结果，无记录。"};
        },
      } as unknown as BackendClient;
      const started = performance.now();
      let failure: string | undefined;
      const turns: Array<Record<string, unknown>> = [];
      try {
        const seedSteps: Step[] = test.fresh ? seeds.map((seed, source) => ({
          message: `查询${seed.org} ${seed.date} ${seed.metrics.join("和")}的数据。`, source, org: orgs[seed.org]!,
        })) : [];
        for (const [index, step] of [...seedSteps, ...test.steps].entries()) {
          const {message} = step;
          const expected = seeds[step.source]!;
          const expectedDate = step.date ?? expected.date;
          const before = queries.length;
          const readsBefore = reads.length;
          const turnStarted = performance.now();
          const outcome = await host.runPrompt(hosted, {protocol_version: 3, request_id: `${test.name}-${index}`, message}, {actor, backend});
          assert.equal(outcome.ok, true, `turn ${index + 1}: prompt completed`);
          const currentEntries = await hosted.lane.findEntries({order: "newestFirst"}, BACKGROUND_CONTEXT);
          const last = currentEntries.find(entry => entry.type === "message" && entry.message.role === "assistant");
          assert.ok(last?.type === "message" && last.message.role === "assistant");
          assert.equal(last.message.stopReason, "stop", last.message.errorMessage ?? `turn ${index + 1}: assistant must finish`);
          assert.ok(last.message.content.some(c => c.type === "text" && c.text.trim()), "assistant answer is required");
          assert.equal(queries.length - before, step.query === false ? 0 : 1, `turn ${index + 1}: business query count`);
          if (step.read) assert.ok(reads.slice(readsBefore).includes(`seed-${step.source}`), "历史结果必须经过鉴权读取");
          const state = await frames.state();
          const focus = state.focusFrameId ? await frames.get(state.focusFrameId) : undefined;
          assert.deepEqual(focus?.fields.metrics?.resolvedValue, {codes: expected.metrics.map(name => metrics[name]), names: expected.metrics});
          const expectedOrgs = step.orgs ?? [step.org!];
          assert.deepEqual((focus?.fields.organizations?.resolvedValue as {codes: string[]})?.codes, expectedOrgs);
          if (step.clarify) {
            assert.equal(focus?.status, "clarifying");
            assert.ok(focus.issues.some(issue => issue.field === "time"), "必须只在缺失时间时澄清");
          } else {
            assert.equal((focus?.fields.time?.resolvedValue as {start: string})?.start, expectedDate);
          }
          if (step.query !== false) {
            const query = queries.at(-1)!;
            assert.deepEqual(query.metric_codes, expected.metrics.map(name => metrics[name]));
            assert.deepEqual(query.org_codes, expectedOrgs);
            assert.deepEqual(query.time, {start: expectedDate, end: expectedDate});
          }
          turns.push({message, passed: true, elapsed_ms: Math.round(performance.now() - turnStarted),
            query_count: queries.length - before, result_reads: reads.slice(readsBefore), focus_frame_id: focus?.frameId});
          if (step.reopen) {
            // 原生恢复后继续，验证焦点不是仅存在于模型记忆或宿主临时变量中。
            await host.closeSession(hosted.sessionId);
            hosted = (await host.openSession(actor, hosted.sessionId))!;
            frames = new NativeFrameStore(hosted.session);
            assert.equal((await frames.state()).focusFrameId, focus?.frameId);
          }
        }
      } catch (error) {failure = error instanceof Error ? error.message : String(error);}
      const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
      const calls = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.content.filter(c => c.type === "toolCall").map(c => ({name: c.name, args: c.arguments})) : []);
      const responses = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
        ? [{stop_reason: entry.message.stopReason, error: entry.message.errorMessage,
          text: entry.message.content.filter(c => c.type === "text").map(c => c.text).join("")}] : []);
      const report = {name: test.name, iteration, passed: !failure, failure, elapsed_ms: Math.round(performance.now() - started), turns, queries, calls, responses};
      reports.push(report);
      console.log(JSON.stringify(report));
      await host.closeSession(hosted.sessionId);
    }
    const passed = reports.length > 0 && reports.every(report => report.passed);
    const reportPath = join(dir, "report.json");
    await writeFile(reportPath, JSON.stringify({environment: "configured_model_synthetic_backend", model: config.model.name,
      real_database_verified: false, passed, reports}, null, 2));
    console.log(JSON.stringify({passed, report: reportPath}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await sessions.close();}
}
