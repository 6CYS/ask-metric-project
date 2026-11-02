/** 可选真实模型探针：仅合成目录和后端，验证Frame组合追问，不连接业务数据库。 */
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import assert from "node:assert/strict";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {createAskMetricTools} from "../src/tools/index.js";
import type {AvailabilityRequest, BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";

const dataDir = await mkdtemp(join(tmpdir(), "composed-model-probe-"));
const config = {...loadConfig(), dataDir};
const actor: BackendUser = {id: "synthetic", username: "synthetic", display_name: "合成测试", org_code: "A", org_name: "虚构甲机构", role_code: "tester"};
const store = new NativeSessionStore(dataDir);
const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store, createAskMetricTools());
const report: Array<Record<string, unknown>> = [];
const filter = process.argv.find(value => value.startsWith("--contains="))?.slice("--contains=".length) ?? "";
const organizations = [{code: "A", name: "虚构甲机构", alias: "甲机构"}, {code: "B", name: "虚构乙机构", alias: "乙机构"}];
const metrics = [{code: "M1", name: "演示指标甲"}, {code: "M2", name: "演示指标乙"}];

function fixture() {
  const queries: BasicQuerySpec[] = []; const coverage: AvailabilityRequest[] = [];
  const results = new Map<string, Record<string, unknown>>();
  const backend = {
    matchMetricQuestion: async (question: string) => ({mentions: metrics.flatMap(metric => {
      const start = question.indexOf(metric.name);
      return start < 0 ? [] : [{text: metric.name, start, end: start + metric.name.length,
        resolution: {status: "resolved", value: {codes: [metric.code], names: [metric.name]}}}];
    })}),
    resolveBusinessField: async (entity: string, raw: string[]) => {
      if (entity === "date") {
        const text = raw[0]!.replace(/\s/g, "").replace("四月", "4月");
        if (text === "去年") return {status: "resolved", value: {start: "2025-01-01", end: "2025-12-31"}};
        const match = text.match(/(?:(\d{4})年)?(\d{1,2})月(?:(\d{1,2})日)?/);
        if (!match) return {status: "invalid"};
        const year = Number(match[1] ?? 2026); const month = Number(match[2]);
        if (month < 1 || month > 12) return {status: "invalid"};
        const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); const day = match[3] ? Number(match[3]) : undefined;
        if (day !== undefined && (day < 1 || day > last)) return {status: "invalid"};
        const prefix = `${year}-${String(month).padStart(2, "0")}`;
        return {status: "resolved", value: {start: `${prefix}-${String(day ?? (text.includes("月末") ? last : 1)).padStart(2, "0")}`,
          end: `${prefix}-${String(day ?? last).padStart(2, "0")}`}};
      }
      const catalog = entity === "organization" ? organizations : metrics;
      const items = raw.map(name => catalog.find(item => item.code === name || item.name === name || ("alias" in item && item.alias === name)));
      return items.some(item => !item) ? {status: "not_found"} : {status: "resolved", value: {codes: items.map(item => item!.code), names: items.map(item => item!.name)}};
    },
    createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
    basicQueries: async (spec: BasicQuerySpec) => {
      assert(spec.org_codes && spec.org_codes.every(code => organizations.some(org => org.code === code)));
      assert(spec.metric_codes.every(code => metrics.some(metric => metric.code === code)));
      queries.push(spec); const id = `synthetic-${queries.length}`;
      const rows = spec.org_codes.flatMap(code => spec.metric_codes.map(metric => ({org_code: code, org_name: organizations.find(org => org.code === code)!.name,
        metric_code: metric, metric_name: metrics.find(item => item.code === metric)!.name, stat_date: spec.time.end, metric_value: "1", unit: "个"})));
      const result = {task_id: id, status: "succeeded", columns: Object.keys(rows[0]!), rows, row_count: rows.length};
      results.set(id, result); return {query: spec, result};
    },
    getTask: async (id: string) => {assert(results.has(id)); return {task_id: id, version: 1, status: "SUCCEEDED", result: {result_id: `result:${id}`}};},
    getTaskResult: async (id: string) => {assert(results.has(id)); return {...results.get(id), result_id: `result:${id}`, offset: 0, has_more: false};},
    dataAvailability: async (request: AvailabilityRequest) => {
      coverage.push(request);
      return {status: "succeeded", mode: "dates", request, org_names: request.org_codes.map(code => organizations.find(org => org.code === code)!.name),
        metric_names: ["演示指标甲"], groups: [{date_count: 2, earliest: "2025-01-31", latest: "2026-01-31", dates: ["2025-01-31", "2026-01-31"], has_more: false}],
        page: 1, page_size: 20, notice: "合成回归数据"};
    },
  } as unknown as BackendClient;
  return {backend, queries, coverage};
}
const probes = [
  {question: "这个指标还有哪些月份有数据？", coverage: true},
  {question: "最早哪天开始有？", coverage: true},
  {question: "那虚构乙机构去年的呢？", orgs: ["B"], start: "2025-01-01", end: "2025-12-31"},
  {question: "加上虚构乙机构，并换成四月份", orgs: ["A", "B"], start: "2026-04-01", end: "2026-04-30"},
  {question: "换成演示指标乙看看", orgs: ["A"], metrics: ["M2"], start: "2026-01-31", end: "2026-01-31"},
  ...["乙机构四月份的呢？", "四月换乙机构", "乙机构，4月份"].map(question => ({question, orgs: ["B"], start: "2026-04-01", end: "2026-04-30"})),
];
async function verifyTools(session: Awaited<ReturnType<HarnessHost["createSession"]>>) {
  const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const tools = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolName] : []);
  assert(!tools.includes("metric_ask"), "禁止旧语义入口");
  // 执行意图在解析回执上就地落地：本轮由 resolve_business_turn 一个入口完成解析与执行。
  assert(tools.includes("resolve_business_turn"), "必须通过完整Frame入口");
  assert(!entries.some(entry => entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason)), "模型失败不能算通过");
  return tools;
}
try {
  for (const probe of process.argv.includes("--pending-only") ? [] : probes) {
    if (filter && !probe.question.includes(filter)) continue;
    const f = fixture(); const session = await host.createSession(actor); let error: string | undefined;
    try {
      await host.runPrompt(session, {protocol_version: 3, request_id: "prime", message: "虚构甲机构2026年1月31日演示指标甲是多少"}, {actor, backend: f.backend});
      assert.equal(f.queries.length, 1, "初始查询须执行一次");
      await host.runPrompt(session, {protocol_version: 3, request_id: "followup", message: probe.question}, {actor, backend: f.backend});
      await verifyTools(session);
      if ("coverage" in probe) {
        assert.equal(f.queries.length, 1); assert.equal(f.coverage.length, 1);
        assert.equal(f.coverage[0]?.dimension, "dates"); assert.deepEqual(f.coverage[0]?.org_codes, ["A"]);
        assert.equal(f.coverage[0]?.start, undefined, "问其他月份/最早日期不能锁在旧单日");
      } else {
        assert.equal(f.queries.length, 2); const spec = f.queries[1]!;
        assert.deepEqual([...spec.org_codes!].sort(), [...probe.orgs].sort());
        assert.deepEqual(spec.metric_codes, "metrics" in probe ? probe.metrics : ["M1"]);
        assert.deepEqual(spec.time, {start: probe.start, end: probe.end});
      }
    } catch (failure) {error = failure instanceof Error ? failure.message : String(failure);}
    const item = {question: probe.question, queries: f.queries, coverage: f.coverage, passed: !error, error}; report.push(item); console.log(JSON.stringify(item));
  }
  for (const independent of [false, true]) {
    const question = independent ? "改查虚构乙机构2026年5月31日演示指标乙" : "演示指标甲";
    if (filter && !question.includes(filter)) continue;
    const f = fixture(); const session = await host.createSession(actor); let error: string | undefined;
    try {
      await host.runPrompt(session, {protocol_version: 3, request_id: "pending-prime", message: "虚构甲机构2026年4月30日"}, {actor, backend: f.backend});
      const frames = await new NativeFrameStore(session.session).list();
      assert(frames.some(frame => frame.issues.some(issue => issue.field === "metrics")), "真实缺项必须保留Frame");
      assert.equal(f.queries.length, 0);
      await host.runPrompt(session, {protocol_version: 3, request_id: "natural-reply", message: question}, {actor, backend: f.backend});
      await verifyTools(session); assert.equal(f.queries.length, 1);
      assert.deepEqual(f.queries[0]!.org_codes, [independent ? "B" : "A"]);
      assert.deepEqual(f.queries[0]!.metric_codes, [independent ? "M2" : "M1"]);
      assert.deepEqual(f.queries[0]!.time, {start: independent ? "2026-05-31" : "2026-04-30", end: independent ? "2026-05-31" : "2026-04-30"});
    } catch (failure) {error = failure instanceof Error ? failure.message : String(failure);}
    const item = {question, independent, queries: f.queries, passed: !error, error}; report.push(item); console.log(JSON.stringify(item));
  }
} finally {
  await host.close(); await store.close();
  await writeFile(join(dataDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({report: join(dataDir, "report.json")}));
}
if (report.some(item => !item.passed)) process.exitCode = 1;
