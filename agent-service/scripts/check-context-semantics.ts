/** 语义改写验收：--live 才调用配置模型，业务后端始终使用合成桩。 */
import {syntheticMetricResolver} from "./syntheticMetricResolver.js";
import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {BusinessContextService} from "../src/business-context/service.js";
import {createCapabilities} from "../src/business-context/capabilities.js";
import {createFieldResolvers} from "../src/business-context/resolvers.js";
import {createAskMetricTools} from "../src/tools/index.js";
import type {BasicQuerySpec, BackendClient, BackendUser} from "../src/backendClient.js";
import type {ContextDelta, FieldResolution} from "../src/business-context/types.js";

const groups = [
  {field: "organizations", value: "合成机构乙", variants: ["机构改为合成机构乙，其他条件保留。", "同一指标和日期，看看合成机构乙。", "把机构换成合成机构乙。"]},
  {field: "metrics", value: "合成指标乙", variants: ["把指标换为合成指标乙。", "机构和日期沿用，查合成指标乙。", "其他条件相同，改查合成指标乙。"]},
  {field: "time", value: "2026年4月30日", variants: ["日期换成2026年4月30日。", "其他都不改，查看2026年4月30日的数据。", "同一个机构和指标，查2026年4月30日。"]},
];
for (const group of groups) {
  assert(group.variants.length >= 3);
  for (const phrase of group.variants) assert(phrase.includes(group.value));
}
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({status: "fixtures_valid", groups: groups.length, variants: groups.reduce((n, group) => n + group.variants.length, 0), model_called: false}));
} else {
  const dir = await mkdtemp(join(tmpdir(), "pi-context-semantics-"));
  const config = {...loadConfig(), dataDir: dir};
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store, createAskMetricTools());
  const actor: BackendUser = {id: "synthetic-context", username: "synthetic", display_name: "合成验收", org_code: "O1", org_name: "合成机构甲", role_code: "USER"};
  const resolve = async (entity: string, raw: string[]): Promise<FieldResolution> => {
    if (entity === "date") {
      const dates: Record<string, string> = {"2026年3月31日": "2026-03-31", "2026年4月30日": "2026-04-30"};
      const date = dates[raw[0]!];
      return date ? {status: "resolved", value: {start: date, end: date}} : {status: "invalid"};
    }
    const catalog: Record<string, string> = entity === "metric" ? {合成指标甲: "M1", 合成指标乙: "M2"} : {合成机构甲: "O1", 合成机构乙: "O2"};
    return raw.every(name => catalog[name]) ? {status: "resolved", value: {codes: raw.map(name => catalog[name]), names: raw}} : {status: "not_found"};
  };
  let count = 0;
  const backend = {
    matchMetricQuestion: syntheticMetricResolver([{code: "M1", name: "合成指标甲"}, {code: "M2", name: "合成指标乙"}]),
    resolveBusinessField: resolve, createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}),
    basicQueries: async (_spec: BasicQuerySpec) => ({result: {task_id: `task-${++count}`, status: "succeeded", rows: [], columns: [], row_count: 0, message: "合成查询无记录。"}}),
    getTask: async (task: string) => ({task_id: task, status: "SUCCEEDED", version: 1, result: {result_id: `result:${task}`}}),
  } as unknown as BackendClient;
  const report: Array<Record<string, unknown>> = [];
  try {
    let variantIndex = 0;
    const selectedVariant = Number(process.argv.find(arg => arg.startsWith("--variant="))?.split("=")[1] ?? 0);
    for (const group of groups) for (const phrase of group.variants) {
      variantIndex++;
      if (selectedVariant && selectedVariant !== variantIndex) continue;
      const hosted = await host.createSession(actor);
      const frames = new NativeFrameStore(hosted.session);
      const service = new BusinessContextService(frames, createCapabilities(), createFieldResolvers());
      const seed: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
        {fieldHint: "metrics", operation: "set", rawValue: "合成指标甲"}, {fieldHint: "organizations", operation: "set", rawValue: "合成机构甲"},
        {fieldHint: "time", operation: "set", rawValue: "2026年3月31日"}, {fieldHint: "selection", operation: "set", rawValue: "exact"},
      ]};
      const identity = {sessionId: hosted.sessionId, turnId: "seed", requestId: "seed"};
      const ready = await service.resolve(seed, identity, {originalMessage: "合成指标甲 合成机构甲 2026年3月31日", currentDate: "2026-09-21", turnId: "seed", resolveCatalog: resolve});
      const executing = await service.beginExecution(ready.frameId, identity);
      const base = await service.finishExecution(executing, {status: "success", resultRef: "query:seed:result"});
      await host.runPrompt(hosted, {protocol_version: 3, request_id: "variant", message: phrase}, {actor, backend});
      const turns = (await frames.list()).filter(frame => frame.requestId === "variant");
      const resolved = turns.find(frame => frame.status === "ready");
      const changes = resolved?.delta.fieldChanges.filter(change => change.operation !== "retain") ?? [];
      const changed = changes.find(change => change.fieldHint === group.field);
      const changedRaw = resolved?.fields[group.field]?.rawValue;
      const equivalentRaw = changedRaw === group.value || Array.isArray(changedRaw)
        && changedRaw.length === 1 && changedRaw[0] === group.value;
      const passed = !!resolved && resolved.parentFrameId === base.frameId
        && !!changed && equivalentRaw
        // 同值 set 与 retain 在业务状态上等价，不能把无实质变化误判为额外字段修改。
        && changes.every(change => change.fieldHint === group.field ||
          JSON.stringify(resolved.fields[change.fieldHint]?.resolvedValue) === JSON.stringify(base.fields[change.fieldHint]?.resolvedValue))
        && Object.entries(base.fields).filter(([name]) => name !== group.field).every(([name, field]) =>
          JSON.stringify(resolved.fields[name]?.resolvedValue) === JSON.stringify(field.resolvedValue))
        && turns.some(frame => frame.status === "success");
      report.push({variant: variantIndex, phrase, expected_field: group.field, delta: resolved?.delta ?? null, passed});
      await host.closeSession(hosted.sessionId);
    }
    const passed = report.every(item => item.passed);
    await writeFile(join(dir, "report.json"), JSON.stringify({environment: "configured_model_synthetic_backend", passed, report}, null, 2));
    console.log(JSON.stringify({passed, report: join(dir, "report.json"), model: config.model.name}));
    if (!passed) process.exitCode = 1;
  } finally {await host.close(); await store.close();}
}
