/** 两轮候选确认验收；真实模型只用 --live 开启，后端始终为隔离合成数据。 */
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
import {createAskMetricTools} from "../src/tools/index.js";
import type {BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";
import type {FieldResolution} from "../src/business-context/types.js";

if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({status: "fixtures_valid", confirmations: ["是", "就这个"], model_called: false}));
} else {
  const dir = await mkdtemp(join(tmpdir(), "pi-confirmation-"));
  const config = {...loadConfig(), dataDir: dir};
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store, createAskMetricTools());
  const actor: BackendUser = {id: "synthetic-confirmation", username: "synthetic", display_name: "合成验收", org_code: "O1", org_name: "合成机构全称", role_code: "USER"};
  const reports: Array<Record<string, unknown>> = [];
  try {
    for (const scenario of [
      {reply: "是", selected: "O1"}, {reply: "就这个", selected: "O1"}, {reply: "没问题", selected: "O1"}, {reply: "OK", selected: "O1"},
      {reply: "第二个", selected: "O2"}, {reply: "不是第一个，是第二个", selected: "O2"},
    ]) {
      const {reply, selected} = scenario;
      const queries: BasicQuerySpec[] = [];
      const metricName = "合成指标甲";
      const metricResolver = async (question: string) => {
        const start = question.indexOf(metricName);
        return {mentions: start < 0 ? [] : [{text: metricName, start, end: start + metricName.length,
          resolution: {status: "resolved" as const, value: {codes: ["M1"], names: [metricName]}}}]};
      };
      const backend = {
        matchMetricQuestion: metricResolver,
        inspectBusinessGoal: async (question: string) => ({question, reference_year: null, requires_calculation: false,
          fragments: [{question, organizations: [], calendar: {ranges: [{start: "2026-03-31", end: "2026-03-31"}], unresolved: []},
            mentions: (await metricResolver(question)).mentions}]}),
        resolveBusinessField: async (entity: string, raw: string[]): Promise<FieldResolution> => {
          if (entity === "date") return raw[0] === "2026年3月末" ? {status: "resolved", value: {start: "2026-03-31", end: "2026-03-31"}} : {status: "invalid"};
          if (entity === "metric") return raw.length && raw.every(name => name === "M1" || name.includes(metricName))
            ? {status: "resolved", value: {codes: raw.map(() => "M1"), names: raw.map(() => metricName)}} : {status: "not_found"};
          const organization = raw[0] === "O1" || raw[0] === "合成机构全称" ? {code: "O1", name: "合成机构全称"}
            : raw[0] === "O2" || raw[0] === "合成机构乙" ? {code: "O2", name: "合成机构乙"} : undefined;
          if (organization) return {status: "resolved", value: {codes: [organization.code], names: [organization.name]}};
          return {status: "needs_confirmation", candidates: [
            {value: "合成机构全称", code: "O1", metadata: {rawValueIndex: 0}},
            ...(selected === "O2" ? [{value: "合成机构乙", code: "O2", metadata: {rawValueIndex: 0}}] : []),
          ]};
        },
        resolveBusinessFieldSuggestion: async (entity: string, _suggestions: unknown, _options: unknown,
          _source: string | undefined, rawValues: string[] = []) => backend.resolveBusinessField(entity, rawValues),
        createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}),
        basicQueries: async (spec: BasicQuerySpec) => {
          queries.push(spec);
          assert.deepEqual(spec.metric_codes, ["M1"]); assert.deepEqual(spec.org_codes, [selected]);
          assert.deepEqual(spec.time, {start: "2026-03-31", end: "2026-03-31"});
          return {result: {task_id: "synthetic-task", status: "succeeded", rows: [], columns: [], row_count: 0, message: "合成查询无记录。"}};
        },
        getTask: async () => ({task_id: "synthetic-task", status: "SUCCEEDED", version: 1, result: {result_id: "result:synthetic-task"}}),
        getTaskResult: async () => ({status: "succeeded", task_id: "synthetic-task", result_id: "result:synthetic-task",
          columns: [], rows: [], row_count: 0, truncated: false}),
      } as unknown as BackendClient;
      const hosted = await host.createSession(actor);
      const started = performance.now();
      await host.runPrompt(hosted, {protocol_version: 3, request_id: "initial", message: "查询合成简称2026年3月末合成指标甲。"}, {actor, backend});
      const queriedBeforeConfirmation = queries.length;
      await host.runPrompt(hosted, {protocol_version: 3, request_id: "confirmation", message: reply}, {actor, backend});
      const frames = await new NativeFrameStore(hosted.session).list();
      const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
      const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
      const userIndex = messages.findLastIndex(message => message.role === "user");
      const turn = messages.slice(userIndex + 1);
      const tools = turn.filter(message => message.role === "toolResult").map(message => message.toolName);
      // 当前宿主可在解析回执中落地执行；核对成功证据，而非要求额外一次模型工具调用。
      const executions = turn.filter(message => message.role === "toolResult"
        && ["resolve_business_turn", "execute_business_frame"].includes(message.toolName)
        && message.content.some(block => {
          if (block.type !== "text") return false;
          try { return JSON.parse(block.text).status === "succeeded"; } catch { return false; }
        })).length;
      const modelCalls = turn.filter(message => message.role === "assistant").length;
      const success = frames.find(frame => frame.requestId === "confirmation" && frame.status === "success");
      const passed = queriedBeforeConfirmation === 0 && queries.length === 1 && !!success
        && success.fields.organizations?.metadata?.confirmed === true && tools.filter(name => name === "resolve_business_turn").length >= 1
        && executions === 1 && tools.length <= 3;
      const report = {reply, passed, queried_before_confirmation: queriedBeforeConfirmation, query_count: queries.length,
        confirmation_tools: tools, confirmation_model_calls: modelCalls, elapsed_ms: Math.round(performance.now() - started)};
      reports.push(report); console.log(JSON.stringify(report));
      await host.closeSession(hosted.sessionId);
    }
    const passed = reports.every(report => report.passed);
    await writeFile(join(dir, "report.json"), JSON.stringify({passed, environment: "configured_model_synthetic_backend",
      model: config.model.name, prompt_variant: config.semanticPromptVariant ?? "compact_v1", max_tokens: config.model.maxTokens, reports}, null, 2));
    console.log(JSON.stringify({passed, report: join(dir, "report.json")}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await store.close();}
}
