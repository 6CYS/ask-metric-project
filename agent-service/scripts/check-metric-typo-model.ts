/** 真实模型 + 真实指标算法 + 合成目录；高分直接查询，低分确认后查询。 */
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {syntheticMetricResolver} from "./syntheticMetricResolver.js";
import type {BackendClient, BackendUser, BasicQuerySpec} from "../src/backendClient.js";

const cases = [
  {input: "贷款余额当日树", name: "贷款余额当日数", autoSelect: true},
  {input: "存款余鹅月日均", name: "存款余额月日均", autoSelect: true},
  {input: "贷款讯额当日数", name: "贷款余额当日数", autoSelect: false},
];
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({cases: cases.length, model_called: false}));
} else {
  const dir = await mkdtemp(join(tmpdir(), "pi-metric-typo-"));
  const config = {...loadConfig(), dataDir: dir};
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store, createAskMetricTools());
  const actor: BackendUser = {id: "synthetic-typo", username: "synthetic", display_name: "合成验收", org_code: "O", org_name: "合成机构", role_code: "USER"};
  const reports: Array<Record<string, unknown>> = [];
  try {
    for (const item of cases) {
      const queries: BasicQuerySpec[] = [];
      const backend = {
        matchMetricQuestion: syntheticMetricResolver([{code: "M", name: item.name}]),
        resolveBusinessField: async (entity: string, raw: string[]) => entity === "date"
          ? {status: "resolved", value: {start: "2026-03-31", end: "2026-03-31"}}
          : entity === "metric" ? raw[0] === "M"
            ? {status: "resolved", value: {codes: ["M"], names: [item.name]}} : {status: "not_found"}
          : {status: "resolved", value: {codes: ["O"], names: ["合成机构"]}},
        createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}),
        basicQueries: async (spec: BasicQuerySpec) => {
          queries.push(spec);
          return {result: {task_id: "synthetic-task", status: "succeeded", rows: [], columns: [], row_count: 0, message: "合成查询无记录。"}};
        },
        getTask: async () => ({task_id: "synthetic-task", status: "SUCCEEDED", version: 1, result: {result_id: "synthetic-result"}}),
      } as unknown as BackendClient;
      const session = await host.createSession(actor);
      const started = performance.now();
      await host.runPrompt(session, {protocol_version: 3, request_id: "typo", message: `查询合成机构2026年3月31日${item.input}。`}, {actor, backend});
      const frames = new NativeFrameStore(session.session);
      const initial = (await frames.list()).at(-1);
      const before = queries.length;
      if (!item.autoSelect) {
        await host.runPrompt(session, {protocol_version: 3, request_id: "confirm", message: "是，选择第一个指标"}, {actor, backend});
      }
      const last = (await frames.list()).at(-1);
      const passed = queries.length === 1 && queries[0]?.metric_codes.join(",") === "M" && last?.status === "success"
        && (item.autoSelect ? before === 1 && initial?.status === "success"
          : before === 0 && initial?.status === "clarifying"
            && last.fields.metrics?.source === "confirmed" && last.fields.time?.source === "inherited");
      reports.push({input: item.input, auto_select: item.autoSelect, passed, queries_after_first_turn: before, query_count: queries.length,
        initial_status: initial?.status, final_status: last?.status, elapsed_ms: Math.round(performance.now() - started)});
      console.log(JSON.stringify(reports.at(-1)));
      await host.closeSession(session.sessionId);
    }
    const passed = reports.every(report => report.passed);
    await writeFile(join(dir, "report.json"), JSON.stringify({passed, environment: "configured_model_real_algorithm_synthetic_backend", reports}, null, 2));
    console.log(JSON.stringify({passed, report: join(dir, "report.json")}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await store.close();}
}
