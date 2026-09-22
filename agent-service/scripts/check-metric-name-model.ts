/** 完整指标名与控制枚举的语义边界；--live 使用配置模型，目录和取数始终为隔离合成数据。 */
import {syntheticMetricResolver} from "./syntheticMetricResolver.js";
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

const cases = [
  {metric: "贷款余额当日数", short: "贷款余额", org: "省联社", date: "2026年3月31日", iso: "2026-03-31"},
  {metric: "存款余额月日均", short: "存款余额", org: "合成机构乙", date: "2025年7月16日", iso: "2025-07-16"},
  {metric: "合成业务发生额本期累计", short: "合成业务发生额", org: "合成机构丙", date: "2024年11月20日", iso: "2024-11-20"},
  {metric: "合成不良率期末值", short: "合成不良率", org: "合成机构丁", date: "2026年6月30日", iso: "2026-06-30"},
];
for (const item of cases) assert(item.metric.startsWith(item.short) && item.metric !== item.short);
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({status: "fixtures_valid", cases: cases.length, model_called: false}));
} else {
  const dir = await mkdtemp(join(tmpdir(), "pi-metric-name-"));
  const config = {...loadConfig(), dataDir: dir};
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store, createAskMetricTools());
  const actor: BackendUser = {id: "synthetic-metric-name", username: "synthetic", display_name: "合成验收", org_code: "O", org_name: "合成机构", role_code: "USER"};
  const reports: Array<Record<string, unknown>> = [];
  try {
    for (const item of cases) {
      const queries: BasicQuerySpec[] = [];
      const backend = {
    matchMetricQuestion: syntheticMetricResolver([{code: "FULL", name: item.metric}, {code: "SHORT", name: item.short}]),
        resolveBusinessField: async (entity: string, raw: string[]): Promise<FieldResolution> => {
          if (entity === "date") return raw[0] === item.date ? {status: "resolved", value: {start: item.iso, end: item.iso}} : {status: "invalid"};
          const catalog = entity === "metric" ? {[item.metric]: "FULL", [item.short]: "SHORT"} : {[item.org]: "O"};
          return raw.every(name => catalog[name]) ? {status: "resolved", value: {codes: raw.map(name => catalog[name]), names: raw}} : {status: "not_found"};
        },
        createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}),
        basicQueries: async (spec: BasicQuerySpec) => {
          queries.push(spec);
          return {result: {task_id: "synthetic-task", status: "succeeded", rows: [], columns: [], row_count: 0, message: "合成查询无记录。"}};
        },
        getTask: async () => ({task_id: "synthetic-task", status: "SUCCEEDED", version: 1, result: {result_id: "synthetic-result"}}),
      } as unknown as BackendClient;
      const hosted = await host.createSession(actor);
      const started = performance.now();
      await host.runPrompt(hosted, {protocol_version: 3, request_id: "full-name", message: `查询${item.org}${item.date}${item.metric}。`}, {actor, backend});
      const frames = await new NativeFrameStore(hosted.session).list();
      const messages = (await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
        .filter(entry => entry.type === "message").map(entry => entry.message);
      const tools = messages.filter(message => message.role === "toolResult").map(message => message.toolName);
      const final = messages.filter(message => message.role === "assistant").at(-1);
      const text = final?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
      const success = frames.find(frame => frame.status === "success");
      const raw = success?.fields.metrics?.rawValue;
      const passed = queries.length === 1 && queries[0]?.metric_codes.join(",") === "FULL"
        && queries[0]?.selection === "exact" && queries[0]?.time.start === item.iso && queries[0]?.time.end === item.iso
        && (raw === item.metric || Array.isArray(raw) && raw.length === 1 && raw[0] === item.metric)
        && frames.every(frame => frame.status !== "clarifying") && !!text
        && !/\b(?:exact|latest_in_range|all_in_range|ranking|selection)\b/.test(text)
        && tools.filter(name => name === "resolve_business_turn").length === 1
        && tools.filter(name => name === "execute_business_frame").length === 1 && tools.length === 2;
      const report = {metric: item.metric, passed, query_count: queries.length, selection: queries[0]?.selection,
        full_metric: raw, tools, elapsed_ms: Math.round(performance.now() - started)};
      reports.push(report); console.log(JSON.stringify(report));
      await host.closeSession(hosted.sessionId);
    }
    const passed = reports.every(report => report.passed);
    await writeFile(join(dir, "report.json"), JSON.stringify({passed, environment: "configured_model_synthetic_backend", reports}, null, 2));
    console.log(JSON.stringify({passed, report: join(dir, "report.json")}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await store.close();}
}
