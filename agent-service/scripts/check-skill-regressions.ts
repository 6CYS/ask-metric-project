/** 真实配置模型的路由/多轮回归；仅合成后端，不验证数据库或后端语义模型。 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { loadConfig } from "../src/config.js";
import { createAskMetricModels } from "../src/models.js";
import { HarnessHost } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { loadBusinessSkills, createBusinessSkillReadTool } from "../src/businessSkills.js";
import { projectEntries } from "../src/sessionProjection.js";
import type { OrganizationScopeInput } from "../src/business-context/types.js";
import { BackendApiError, type BackendClient, type BackendUser, type BasicQuerySpec } from "../src/backendClient.js";

const dir = await mkdtemp(join(tmpdir(), "skill-regressions-"));
const config = {...loadConfig(), dataDir: dir};
const skills = await loadBusinessSkills();
const store = new NativeSessionStore(dir);
const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store,
  [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
const actor: BackendUser = {id: "synthetic", username: "synthetic", display_name: "合成回归",
  org_code: "A", org_name: "演示甲农商行", role_code: "SYSTEM_ADMIN"};
const organizations = [{code: "A", name: "演示甲农商行"}, {code: "B", name: "演示乙农商行"}];
const metrics = [{code: "M", name: "演示存款余额", unit: "元"}];
type Conditions = {orgs: string[]; start: string; end: string; ranking?: boolean};
type Trace = {name: string; args: unknown};
const trace: Trace[] = [];
const tasks = new Map<string, ReturnType<typeof result>>();
function result(id: string, conditions: Conditions) {
  const rows = conditions.orgs.map((code, index) => ({org_code: code,
    org_name: organizations.find(org => org.code === code)!.name,
    metric_code: "M", metric_name: "演示存款余额", stat_date: conditions.end,
    metric_value: String(42 + index), unit: "元"}));
  return {task_id: id, status: "succeeded", rows, row_count: rows.length,
    columns: Object.keys(rows[0]!), truncated: false,
    message: `${conditions.start}至${conditions.end}，${rows.map(row => row.org_name).join("、")}演示存款余额已取得。`,
    evidence: {logical_dsl: {task: "metric_query", metrics: ["M"], orgs: conditions.orgs,
      time: {start: conditions.start, end: conditions.end}, ops: conditions.ranking ? [{type: "ranking", top_n: 3}] : []},
      catalog: {metrics, organizations: organizations.filter(org => conditions.orgs.includes(org.code))}},
  };
}
const backend = {
  matchMetricQuestion: async (question: string) => ({mentions: metrics.flatMap(metric => {
    const start = question.indexOf(metric.name);
    return start < 0 ? [] : [{text: metric.name, start, end: start + metric.name.length,
      resolution: {status: "resolved", value: {codes: [metric.code], names: [metric.name]}}}];
  })}),
  resolveBusinessField: async (entity: string, raw: string[]) => {
    trace.push({name: "resolve-field", args: {entity, raw}});
    if (entity === "date") {
      const text = raw[0]!.replace(/\s/g, "");
      const month = text.match(/(\d{1,2})月/);
      if (!month) return {status: "invalid"};
      const m = Number(month[1]);
      const year = Number(text.match(/(\d{4})年/)?.[1] ?? 2026);
      if (m < 1 || m > 12) return {status: "invalid"};
      const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
      const prefix = `${year}-${String(m).padStart(2, "0")}`;
      return {status: "resolved", value: {start: `${prefix}-${text.includes("月末") ? last : "01"}`, end: `${prefix}-${last}`}};
    }
    const catalog = entity === "organization" ? organizations : metrics;
    const items = raw.map(name => catalog.find(item => item.code === name || item.name === name));
    if (items.some(item => !item)) return {status: "not_found"};
    return {status: "resolved", value: {codes: items.map(item => item!.code), names: items.map(item => item!.name)}};
  },
  resolveOrganizationScope: async (input: OrganizationScopeInput) => {
    trace.push({name: "resolve-scope", args: input});
    if (input.kind !== "authorized_cohort" || input.cohort !== "rural_commercial_banks") throw new BackendApiError(422, "合成目录不支持该范围", "CONFIGURATION_ERROR");
    return {status: "resolved", value: {codes: organizations.map(org => org.code), names: organizations.map(org => org.name),
      scope: {kind: input.kind, cohort: input.cohort}, scope_fingerprint: "a".repeat(64)}};
  },
  getTask: async (id: string) => {
    assert(tasks.has(id), "不得编造任务引用");
    return {task_id: id, version: 3, status: "SUCCEEDED", result: {result_id: `r:${id}`}};
  },
  getTaskResult: async (id: string) => {
    trace.push({name: "read", args: id});
    assert(tasks.has(id));
    return {...tasks.get(id), result_id: `r:${id}`, offset: 0, next_offset: null, has_more: false};
  },
  createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
  basicQueries: async (spec: BasicQuerySpec) => {
    if (spec.metric_codes.some(code => !metrics.some(metric => metric.code === code))
      || spec.org_codes?.some(code => !organizations.some(org => org.code === code))) {
      trace.push({name: "structured-rejected", args: spec});
      throw new BackendApiError(422, "编码未在合成目录中启用，请查询目录并使用正式编码。", "QUERY_INVALID");
    }
    trace.push({name: "structured", args: spec});
    const id = `synthetic-${tasks.size + 1}`;
    if (spec.organization_scope) {
      assert.equal(spec.organization_scope.kind, "authorized_cohort");
      assert.equal(spec.scope_fingerprint, "a".repeat(64));
      assert.equal(spec.org_codes, undefined);
    }
    const orgs = spec.organization_scope ? organizations.map(org => org.code) : spec.org_codes!;
    assert(orgs?.length, "不能猜测空机构范围");
    const value = result(id, {orgs, start: spec.time.start, end: spec.time.end, ranking: spec.operation?.kind === "ranking"});
    tasks.set(id, value);
    return {query: spec, result: value};
  },
  searchOrganizations: async (keyword: string) => {
    trace.push({name: "org-search", args: keyword});
    const items = organizations.filter(org => keyword.includes(org.name) || org.name.includes(keyword))
      .map(org => ({org_code: org.code, org_name: org.name, score: 1, match_type: "exact"}));
    return {total: items.length, items};
  },
  searchMetrics: async () => ({total: 1, items: [{metric_code: "M", metric_name: "演示存款余额", unit: "元", score: 1, match_type: "exact"}], semantic_suggestions: []}),
  dataAvailability: async (request: Record<string, unknown>) => {
    if (JSON.stringify(request.org_codes) !== JSON.stringify(["A"])
      || (Array.isArray(request.metric_codes) && request.metric_codes.some(code => code !== "M"))) {
      trace.push({name: "coverage-rejected", args: request});
      throw new BackendApiError(422, "请使用目录确认的正式编码，并保持指定机构范围。", "QUERY_INVALID");
    }
    trace.push({name: "coverage", args: request});
    return {status: "succeeded", mode: "metrics", request, org_names: ["演示甲农商行"],
      metric_count: 1, items: [{metric_code: "M", metric_name: "演示存款余额"}],
      page: 1, page_size: 20, has_more: false, notice: "隔离合成数据。"};
  },
} as unknown as BackendClient;
const reports: Array<Record<string, unknown>> = [];
let requestIndex = 0;
async function createSession() {
  const session = await host.createSession(actor);
  // 只给联网验收节流，不改变应用运行策略。
  session.harness.hooks.on("before_request", async () => { await setTimeout(3_000); return undefined; });
  return session;
}
async function turn(session: Awaited<ReturnType<typeof host.createSession>>, label: string, question: string,
  verify: (calls: Trace[], tools: string[], answer: string) => void) {
  // 串行探针留出供应商限流间隔；不将 429/空响应计为业务通过。
  if (requestIndex) await setTimeout(10_000);
  const before = trace.length;
  const entryCount = (await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).length;
  const start = performance.now();
  await host.runPrompt(session, {protocol_version: 3, request_id: `probe-${++requestIndex}`, message: question}, {actor, backend});
  const entries = (await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).slice(entryCount);
  const messages = projectEntries(entries);
  const tools = messages.filter(message => message.role === "tool").map(message => message.tool);
  const calls = trace.slice(before).filter(call => !["resolve-field", "resolve-scope"].includes(call.name));
  let error: string | undefined;
  try {
    assert(!entries.some(entry => entry.type === "message" && entry.message.role === "assistant"
      && ["error", "aborted"].includes(entry.message.stopReason)), "模型请求失败或被中断");
    const answer = messages.filter(message => message.role === "assistant").at(-1);
    assert(answer?.role === "assistant" && answer.text.length > 0, "必须交付非空答案");
    assert(!tools.includes("metric_ask"), "新入口禁止旧语义执行链");
    verify(calls, tools, answer.text);
    assert(!/部分步骤执行失败|自动核验仍未完成/.test(answer.text), "不得把中间失败或拦截算通过");
    for (const call of calls.filter(call => call.name === "structured")) {
      const spec = call.args as BasicQuerySpec;
      assert.deepEqual(spec.metric_codes, ["M"], "必须使用目录提供的正式指标编码");
    }
  } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  const report = {label, tools, calls: trace.slice(before), passed: !error, error, elapsed_ms: Math.round(performance.now() - start)};
  reports.push(report);
  console.log(JSON.stringify({probe: "regression", ...report}));
}
try {
  for (let repeat = 0; repeat < 3; repeat++) {
    await turn(await createSession(), `collective-ranking-${repeat + 1}`,
      "查询2026年4月末各家农商行演示存款余额前3名。", (calls, tools) => {
        assert(tools.includes("resolve_business_turn") && tools.includes("execute_business_frame"));
        assert(calls.some(call => {
          const spec = call.args as BasicQuerySpec;
          return call.name === "structured" && spec.selection === "exact" && spec.operation?.kind === "ranking"
            && spec.operation.order === "desc" && spec.operation.top_n === 3
            && spec.organization_scope?.kind === "authorized_cohort" && spec.org_codes === undefined
            && spec.time.start === "2026-04-30" && spec.time.end === "2026-04-30";
        }));
        assert(!calls.some(call => call.name === "org-search"));
      });
  }
  const session = await createSession();
  await turn(session, "initial-value", "演示甲农商行2026年3月末演示存款余额是多少？", calls => {
    assert(calls.some(call => call.name === "structured"));
  });
  await turn(session, "change-org", "演示乙农商行呢？", calls => {
    assert(calls.some(call => call.name === "structured" && (call.args as BasicQuerySpec).org_codes?.join() === "B"
        && (call.args as BasicQuerySpec).time.start === "2026-03-31"
        && (call.args as BasicQuerySpec).time.end === "2026-03-31"));
  });
  let monthClarification = false;
  await turn(session, "month-grain", "3 月份呢？", (calls, _tools, answer) => {
    if (!calls.length) {
      // 余额的月份口径可澄清；不能将合法澄清误判成无工具编造，也不能跳过后续取数验收。
      assert(/[?？]/.test(answer) && /每日|明细|日均|口径/.test(answer), "无取数时须明确澄清月份口径");
      assert(!/请.*(?:指标、机构|机构和日期|机构和指标)/.test(answer), "不能要求重述已确认条件");
      monthClarification = true;
      return;
    }
    assert(calls.some(call => call.name === "structured" && (call.args as BasicQuerySpec).time.start === "2026-03-01"
        && (call.args as BasicQuerySpec).time.end === "2026-03-31"
        && (call.args as BasicQuerySpec).org_codes?.join() === "B"
        && (call.args as BasicQuerySpec).selection === "all_in_range"));
  });
  if (monthClarification) await turn(session, "month-grain-confirmed", "按刚才那家机构，查询2026年3月整月每日明细，不求和，也不是只看月末。", calls => {
    assert(calls.some(call => call.name === "structured" && (call.args as BasicQuerySpec).time.start === "2026-03-01"
        && (call.args as BasicQuerySpec).time.end === "2026-03-31"
        && (call.args as BasicQuerySpec).org_codes?.join() === "B"
        && (call.args as BasicQuerySpec).selection === "all_in_range"));
  });
  const latestMonthTask = [...tasks.keys()].at(-1)!;
  await turn(session, "history-read", "把刚才演示乙农商行3月份整月的结果再显示一次。", calls => {
    assert(calls.some(call => call.name === "read" && call.args === latestMonthTask));
    assert(!calls.some(call => ["submit", "structured"].includes(call.name)));
  });
  const coverage = await createSession();
  await turn(coverage, "coverage", "演示甲农商行2026年3月1日至3月31日哪些指标有数据？", calls => {
    const request = calls.find(call => call.name === "coverage")?.args as Record<string, unknown>;
    assert.equal(request?.dimension, "metrics");
    assert.equal(request?.start, "2026-03-01");
    assert.equal(request?.end, "2026-03-31");
  });
  await turn(coverage, "coverage-to-value", "那查演示存款余额，整月每天的数据。", calls => {
    const spec = calls.find(call => call.name === "structured")?.args as BasicQuerySpec;
    assert.equal(spec?.time.start, "2026-03-01");
    assert.equal(spec?.time.end, "2026-03-31");
    assert.equal(spec?.selection, "all_in_range");
    assert.deepEqual(spec?.org_codes, ["A"]);
  });
  const clarificationSession = await createSession();
  await turn(clarificationSession, "missing-date", "查演示甲农商行演示存款余额。", (calls, tools) => {
    assert(tools.includes("resolve_business_turn"));
    assert(!calls.some(call => call.name === "structured"));
  });
  await turn(clarificationSession, "clarify-date", "2026年3月份每天的明细", (calls, tools) => {
    assert(tools.includes("resolve_business_turn") && tools.includes("execute_business_frame"));
    assert(calls.some(call => call.name === "structured"));
  });
  await turn(await createSession(), "unsupported-cause", "解释演示甲农商行存款余额下降的业务原因，判断是哪类客户流失导致的。", (calls, _tools, answer) => {
    assert(!calls.some(call => ["submit", "structured", "coverage"].includes(call.name)));
    assert(/尚未提供|无法|不支持/.test(answer), "必须如实说明当前能力边界");
  });
} finally {
  await host.close();
  await store.close();
  await writeFile(join(dir, "report.json"), JSON.stringify({model: config.model.name,
    environment: "configured_model_synthetic_backend", reports}, null, 2));
  console.log(JSON.stringify({report: join(dir, "report.json"), passed: reports.filter(report => report.passed).length, total: reports.length}));
  if (reports.some(report => !report.passed)) process.exitCode = 1;
}
