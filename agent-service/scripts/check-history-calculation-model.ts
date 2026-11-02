/** 配置中的真实模型 + 隔离合成后端：检查历史原值计算是否省去回读/纠错轮次，不访问业务数据库。 */
import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {loadBusinessSkills, createBusinessSkillReadTool} from "../src/businessSkills.js";
import {projectEntries} from "../src/sessionProjection.js";
import {BackendApiError} from "../src/backendClient.js";
import type {BackendClient, BackendUser, BasicQuerySpec, CalculationFact, CalculationSpec} from "../src/backendClient.js";
import type {FieldResolution} from "../src/business-context/types.js";

if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({model_called: false, usage: "node --env-file=.env --import tsx scripts/check-history-calculation-model.ts --live --repeat=3"}));
} else {
  const repeat = Number(process.argv.find(arg => arg.startsWith("--repeat="))?.split("=")[1] ?? 3);
  assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 5, "repeat 必须为 1 到 5");
  const dir = await mkdtemp(join(tmpdir(), "pi-history-calculation-"));
  const config = {...loadConfig(), dataDir: dir};
  const sessions = new NativeSessionStore(dir);
  const skills = await loadBusinessSkills();
  const host = new HarnessHost(config, authorized => createAskMetricModels(config, authorized), sessions,
    [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
  const actor: BackendUser = {id: "synthetic-calculation", username: "synthetic", display_name: "合成验收",
    org_code: "O1", org_name: "合成机构甲", role_code: "USER"};
  const orgs: Record<string, string> = {合成机构甲: "O1", 合成机构乙: "O2"};
  const reports: Array<Record<string, unknown>> = [];
  try {
    for (let iteration = 1; iteration <= repeat; iteration++) {
      const hosted = await host.createSession(actor);
      const task = randomUUID();
      // 行序与减法方向相反，断言必须按机构身份绑定，不能按数组先后猜测。
      const facts: CalculationFact[] = [
        {org_code: "O2", org_name: "合成机构乙", value: "210.25"},
        {org_code: "O1", org_name: "合成机构甲", value: "125.50"},
      ].map((org, row) => ({...org, fact_id: `fact:${task}:${row}:metric_value`, task_id: task,
        field: "metric_value", metric_code: "M1", metric_name: "合成收入指标", date: "2026-04-30", unit: "元"}));
      const rows = facts.map(fact => ({org_code: fact.org_code, org_name: fact.org_name,
        metric_code: fact.metric_code, metric_name: fact.metric_name, stat_date: fact.date, metric_value: fact.value}));
      let queryCount = 0;
      let calculationCount = 0;
      let factChecks = 0;
      const backend = {
        matchMetricQuestion: async (question: string) => ({mentions: question.includes("合成收入指标") ? [{
          text: "合成收入指标", start: question.indexOf("合成收入指标"), end: question.indexOf("合成收入指标") + 6,
          resolution: {status: "resolved", value: {codes: ["M1"], names: ["合成收入指标"]}}}] : []}),
        resolveBusinessField: async (entity: string, raw: string[]): Promise<FieldResolution> => {
          if (entity === "date") return raw[0]?.includes("2026-04-30")
            ? {status: "resolved", value: {start: "2026-04-30", end: "2026-04-30"}} : {status: "not_found"};
          const catalog = entity === "metric" ? {合成收入指标: "M1"} as Record<string, string> : orgs;
          return raw.every(name => catalog[name])
            ? {status: "resolved", value: {codes: raw.map(name => catalog[name]!), names: raw}} : {status: "not_found"};
        },
        createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
        basicQueries: async (spec: BasicQuerySpec) => {
          queryCount++;
          assert.deepEqual(spec.metric_codes, ["M1"]);
          assert.deepEqual([...spec.org_codes!].sort(), ["O1", "O2"]);
          assert.deepEqual(spec.time, {start: "2026-04-30", end: "2026-04-30"});
          return {result: {task_id: task, result_id: `result:${task}`, status: "succeeded", facts, rows,
            columns: Object.keys(rows[0]!), row_count: 2, truncated: false, message: "合成查询已完成。",
            evidence: {logical_dsl: {metrics: spec.metric_codes, orgs: spec.org_codes, time: spec.time}}}};
        },
        getTask: async (id: string) => {
          assert.equal(id, task);
          return {task_id: task, status: "SUCCEEDED", version: 1, result: {result_id: `result:${task}`}};
        },
        getTaskResult: async (id: string, offset = 0, limit = 20) => {
          assert.equal(id, task);
          factChecks++;
          return {task_id: task, result_id: `result:${task}`, status: "succeeded", facts: facts.slice(offset, offset + limit),
            rows: rows.slice(offset, offset + limit), columns: Object.keys(rows[0]!), row_count: 2, truncated: false,
            offset, limit, has_more: offset + limit < 2, next_offset: offset + limit < 2 ? offset + limit : null, comparisons: []};
        },
        calculate: async (spec: CalculationSpec & {source_policy: string; user_question: string; scope_id: string}) => {
          calculationCount++;
          assert.equal(spec.source_policy, "conversation_snapshots");
          // 与真实后端一致：业务口径错误属于可纠正的422，不能把探针断言伪装为服务器故障。
          if (spec.scope_policy !== "cross_org") throw new BackendApiError(422,
            "不同机构的事实计算须显式设置 scope_policy=cross_org。", "CALCULATION_SCOPE_MISMATCH");
          assert.equal(Object.keys(spec.bindings).length, 2);
          assert.equal(spec.expressions.length, 1);
          assert.ok(!spec.constants || Object.keys(spec.constants).length === 0);
          const expression = spec.expressions[0]!;
          const match = expression.expression.replace(/[()\s]/g, "").match(/^([A-Za-z_]\w*)-([A-Za-z_]\w*)$/);
          assert.ok(match, "必须使用两条原值作减法");
          assert.equal(spec.bindings[match[1]!]!.fact_id, facts[1]!.fact_id, "被减数必须是甲");
          assert.equal(spec.bindings[match[2]!]!.fact_id, facts[0]!.fact_id, "减数必须是乙");
          const inputs = Object.fromEntries(Object.entries(spec.bindings).map(([name, binding]) =>
            [name, facts.find(fact => fact.fact_id === binding.fact_id)!]));
          return {status: "succeeded", calculation_id: randomUUID(), task_id: task, scope_id: spec.scope_id, inputs,
            results: [{...expression, value: "-84.75", display_value: "-84.75", unit: "元", variables: [match[1], match[2]]}],
            public_answer: "合成机构甲减合成机构乙：125.50 - 210.25 = -84.75 元。"};
        },
      } as unknown as BackendClient;
      let failure: string | undefined;
      let measurement: Record<string, unknown> = {};
      try {
        const prime = await host.runPrompt(hosted, {protocol_version: 3, request_id: "prime",
          message: "查询合成机构甲和合成机构乙2026-04-30的合成收入指标原值。"}, {actor, backend});
        assert.ok(prime.ok && prime.outcome.kind === "settled" && prime.outcome.outcome.status === "completed");
        assert.equal(queryCount, 1);
        const admitted = await host.admitPrompt(hosted, {protocol_version: 3, request_id: "calculate",
          message: "就用刚才查到的两家原值，按合成机构甲减合成机构乙计算差额，并列出原值和计算结果。"}, {actor, backend});
        assert.ok(admitted.ok);
        const start = performance.now();
        const result = await host.drivePrompt(hosted, admitted);
        const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
        const lastUser = entries.map(entry => entry.type === "message" && entry.message.role === "user").lastIndexOf(true);
        const turn = entries.slice(lastUser);
        const messages = turn.flatMap(entry => entry.type === "message" ? [entry.message] : []);
        const calls = messages.flatMap(message => message.role === "assistant"
          ? message.content.filter(block => block.type === "toolCall").map(block => block.name) : []);
        const errors = messages.filter(message => message.role === "toolResult" && (message.isError ||
          message.content.some(block => block.type === "text" && /ARGUMENT_ERROR|CALCULATION_SOURCE_UNAVAILABLE/.test(block.text))));
        const timings = admitted.request.timings!;
        measurement = {elapsed_ms: Math.round(performance.now() - start), model_calls: timings.model_ms.length,
          model_ms: timings.model_ms, tool_ms: timings.tool_ms, calls, error_count: errors.length,
          query_count: queryCount, calculation_count: calculationCount, backend_fact_checks: factChecks};
        assert.ok(result.ok && result.outcome.kind === "settled" && result.outcome.outcome.status === "completed");
        assert.equal(queryCount, 1, "沿用快照不得重新业务取数");
        assert.equal(calculationCount, 1);
        assert.equal(errors.length, 0, "不可经过参数纠错");
        assert.ok(!calls.includes("read_business_result"), "有完整索引时不需模型回读历史");
        assert.equal(timings.model_ms.length, 2, "直接计算及最终回答应只需两次模型调用");
        assert.ok(factChecks >= 2, "省去模型回读不能省去后端精确事实复核");
        const answer = projectEntries(turn).filter(message => message.role === "assistant" && message.text.trim()).at(-1);
        assert.ok(answer?.role === "assistant" && !answer.error && answer.text.includes("84.75"), "最终回答须引用正确差额");
      } catch (error) {failure = error instanceof Error ? error.message : String(error);}
      const report = {iteration, passed: !failure, ...measurement, ...(failure ? {failure} : {})};
      reports.push(report);
      console.log(JSON.stringify(report));
      await host.closeSession(hosted.sessionId);
    }
    const passed = reports.every(report => report.passed);
    const path = join(dir, "report.json");
    await writeFile(path, JSON.stringify({environment: "configured_model_synthetic_backend", model: config.model.name,
      real_database_verified: false, passed, reports}, null, 2));
    console.log(JSON.stringify({passed, report: path}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await sessions.close();}
}
