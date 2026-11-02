/**
 * 机构自主匹配合成验收：编排模型 + 桩后端，不接真实模型和真实后端。
 * 覆盖：orgSuggestion 直达、错字纠正明示、首推确认话术与“是”确认、org-catalog 失败降级不炸。
 * 运行：npx tsx scripts/check-org-suggestion.ts
 */
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createAssistantMessageEventStream, createModels, createProvider,
  type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import type {AgentServiceConfig} from "../src/config.js";
import type {BackendClient, FieldSuggestion} from "../src/backendClient.js";
import type {FieldResolution} from "../src/business-context/types.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

const ORGS = [
  {code: "O-JY", name: "江阴农商银行", aliases: ["江阴", "江银"]},
  {code: "O-SY", name: "沭阳农商银行", aliases: ["沭阳"]},
  {code: "O-XY", name: "锡银农商银行", aliases: ["锡银"]},
  {code: "O-XS", name: "锡山农商银行", aliases: ["锡山"]},
];
const DATE_TEXT = "2026年3月末";

type Reply = {text: string} | {args: Record<string, unknown>};

/** 编排模型：只按剧本返回原生事件，不发起任何 HTTP 模型请求；同时捕获每轮发送的消息副本。 */
function scriptedModel(script: Reply[], captured: string[][]) {
  const model: Model<"openai-completions"> = {id: "offline-org-suggestion", name: "offline-org-suggestion",
    api: "openai-completions", provider: "offline", baseUrl: "http://offline.invalid", reasoning: false, input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128_000, maxTokens: 8192};
  let calls = 0;
  const respond: ProviderStreams["streamSimple"] = (_model, context) => {
    const next = script[calls++];
    if (!next) throw new Error("OFFLINE_SCRIPT_EXHAUSTED");
    captured.push(context.messages.filter(message => message.role === "user")
      .map(message => typeof message.content === "string" ? message.content
        : message.content.filter(block => block.type === "text").map(block => block.text).join("")));
    const message: AssistantMessage = {role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: "text" in next ? [{type: "text", text: next.text}]
        : [{type: "toolCall", id: `script-${calls}`, name: "resolve_business_turn", arguments: next.args}],
      stopReason: "text" in next ? "stop" : "toolUse", timestamp: Date.now(),
      usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({type: "start", partial: message});
      stream.push({type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message});
      stream.end(message);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider(createProvider({id: "offline", name: "offline",
    auth: {apiKey: {name: "offline", resolve: async () => ({auth: {}})}},
    models: [model], api: {stream: respond, streamSimple: respond}}));
  return {models, model};
}

/** 桩后端：机构/日期目录、机构建议通道、查询执行均为合成数据；suggestCalls 记录建议通道负载。 */
function stubBackend(overrides: {
  suggest?: (suggested: FieldSuggestion[]) => Promise<FieldResolution>;
  orgCatalog?: () => Promise<{items: typeof ORGS}>;
  resolveOrg?: (raw: string[]) => Promise<FieldResolution>;
}) {
  const suggestCalls: FieldSuggestion[][] = [];
  const backend = {
    orgCatalog: overrides.orgCatalog ?? (async () => ({items: ORGS})),
    matchMetricQuestion: async (question: string) => {
      const text = "贷款余额";
      const start = question.indexOf(text);
      return start < 0 ? {mentions: []} : {mentions: [{text, start, end: start + text.length,
        resolution: {status: "resolved", value: {codes: ["M1"], names: ["贷款余额"]}}}]};
    },
    resolveBusinessField: async (entity: string, raw: string[]): Promise<FieldResolution> => {
      if (entity === "date") return raw[0] === DATE_TEXT
        ? {status: "resolved", value: {start: "2026-03-31", end: "2026-03-31"}} : {status: "invalid"};
      if (entity === "metric") return {status: "resolved", value: {codes: ["M1"], names: ["贷款余额"]}};
      if (overrides.resolveOrg) return overrides.resolveOrg(raw);
      const hit = ORGS.find(org => raw.every(value => [org.code, org.name].includes(value)));
      return hit ? {status: "resolved", value: {codes: [hit.code], names: [hit.name]},
        metadata: {resolution_source: "model_inferred"}} : {status: "not_found"};
    },
    resolveBusinessFieldSuggestion: async (_entity: string, suggested: FieldSuggestion[]): Promise<FieldResolution> => {
      suggestCalls.push(suggested);
      assert(overrides.suggest, "本场景不应进入模型建议通道");
      return overrides.suggest(suggested);
    },
    createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}),
    basicQueries: async () => ({result: {task_id: "synthetic-task", status: "succeeded",
      columns: [], rows: [], row_count: 0, message: "合成查询无记录。"}}),
    getTask: async (taskId: string) => ({task_id: taskId, status: "SUCCEEDED", version: 1,
      result: {result_id: `result:${taskId}`}}),
  } as unknown as BackendClient;
  return {backend, suggestCalls};
}

function config(dir: string): AgentServiceConfig {
  return {host: "127.0.0.1", port: 0, backendBaseUrl: "http://127.0.0.1:1", backendTimeoutMs: 1000, dataDir: dir,
    model: {baseUrl: "http://offline.invalid", name: "offline-org-suggestion", apiKey: "", authHeader: "Authorization",
      authPrefix: "Bearer", userMessageSuffix: "", extraBody: {}, contextWindow: 128_000, maxTokens: 8192},
    compaction: {enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000},
    modelRetry: {enabled: false, maxRetries: 0, baseDelayMs: 1}} as AgentServiceConfig;
}

/** 固定协议首轮参数：指标 fromQuestion + 机构（suggestion 或原文名称）+ 日期。 */
function askArgs(orgValue: unknown, sourceText: string) {
  return {protocol_version: 1, capability: "metric_query", base: null, mode: "execute",
    changes: {
      metrics: {action: "set", value: {fromQuestion: true}},
      organizations: {action: "set", source_text: sourceText, expected_count: null, value: orgValue},
      time: {action: "set", value: DATE_TEXT},
    }};
}

async function toolMessages(hosted: Awaited<ReturnType<HarnessHost["createSession"]>>) {
  const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  return entries.filter(entry => entry.type === "message").map(entry => entry.message);
}

interface ScenarioResult {scenario: string; passed: boolean}
const results: ScenarioResult[] = [];
const consoleErrors: string[] = [];
const originalError = console.error;
const originalInfo = console.info;
console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(" ")); };
console.info = () => {};

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    results.push({scenario: name, passed: true});
    console.log(JSON.stringify({scenario: name, passed: true}));
  } catch (error) {
    results.push({scenario: name, passed: false});
    console.log(JSON.stringify({scenario: name, passed: false,
      reason: error instanceof Error ? error.message : String(error)}));
  }
}

/** 场景一：orgSuggestion 直达（model_inferred），回执与兜底答案固定明示。 */
async function directSuggestion(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "org-suggestion-direct-"));
  const {backend, suggestCalls} = stubBackend({
    suggest: async suggested => {
      assert.equal(suggested.length, 1);
      assert.deepEqual(suggested[0], {name: "江阴", excerpt: "江阴"});
      return {status: "resolved", value: {codes: ["O-JY"], names: ["江阴农商银行"]},
        metadata: {resolution_source: "model_inferred"}};
    },
  });
  const captured: string[][] = [];
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: askArgs({kind: "suggestion", suggestion: {name: "江阴", excerpt: "江阴"}}, "江阴")},
    {text: "已按回执告知用户查询结果。"},
  ], captured), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "direct-1",
      message: `查江阴${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 1, "模型建议通道应被调用一次");
    // 机构清单已注入本轮上下文（编码|名称|别名）。
    assert(captured.some(messages => messages.some(text => text.includes("有权机构清单")
      && text.includes("O-JY|江阴农商银行|江阴,江银"))), "turn-state 应包含有权机构清单");
    const frames = await new NativeFrameStore(hosted.session).list();
    const success = frames.find(frame => frame.status === "success");
    assert(success, "应存在成功执行的 Frame");
    const org = success!.fields.organizations!;
    assert.deepEqual((org.resolvedValue as {codes: string[]}).codes, ["O-JY"]);
    assert.equal(org.metadata?.resolution_source, "model_inferred", "Frame 元数据应记录 resolution_source");
    assert.equal(org.metadata?.rawExcerpt, "江阴", "Frame 元数据应记录 rawExcerpt");
    const messages = await toolMessages(hosted);
    const landed = [...messages].reverse().find(message => message.role === "toolResult"
      && message.toolName === "resolve_business_turn");
    const details = landed?.details as {public_answer?: string; resolution_notice?: string[]} | undefined;
    assert(details?.resolution_notice?.includes("已按「江阴农商银行」查询（您说的是「江阴」）"),
      "落地回执应含固定明示 resolution_notice");
    assert(details?.public_answer?.startsWith("已按「江阴农商银行」查询（您说的是「江阴」）"),
      "兜底答案 public_answer 应前置同一明示");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** 场景二：错字纠正（corrected），corrections 记录并逐一明示。 */
async function typoCorrection(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "org-suggestion-typo-"));
  const {backend, suggestCalls} = stubBackend({
    suggest: async suggested => {
      assert.deepEqual(suggested[0], {name: "沐阳", excerpt: "沐阳"});
      return {status: "resolved", value: {codes: ["O-SY"], names: ["沭阳农商银行"]},
        metadata: {resolution_source: "corrected",
          corrections: [{raw: "沐阳", corrected_name: "沭阳农商银行", corrected_code: "O-SY"}]}};
    },
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: askArgs({kind: "suggestion", suggestion: {name: "沐阳", excerpt: "沐阳"}}, "沐阳")},
    {text: "已按回执告知用户查询结果。"},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "typo-1",
      message: `查沐阳${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 1);
    const frames = await new NativeFrameStore(hosted.session).list();
    const success = frames.find(frame => frame.status === "success");
    assert(success, "应存在成功执行的 Frame");
    const org = success!.fields.organizations!;
    assert.equal(org.metadata?.resolution_source, "corrected");
    const corrections = org.metadata?.corrections as Array<{corrected_code?: string}> | undefined;
    assert.equal(corrections?.[0]?.corrected_code, "O-SY", "Frame 元数据应记录 corrections");
    const messages = await toolMessages(hosted);
    const landed = [...messages].reverse().find(message => message.role === "toolResult"
      && message.toolName === "resolve_business_turn");
    const details = landed?.details as {public_answer?: string} | undefined;
    assert(details?.public_answer?.includes("已按「沭阳农商银行」查询（您说的是「沐阳」）"),
      "错字纠正必须在答案中明示正式名称与用户原话");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** 场景三：建议未唯一命中时首推置顶 + 确认式话术；用户回复“是”直接确认首选。 */
async function preferredConfirmation(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "org-suggestion-preferred-"));
  const {backend, suggestCalls} = stubBackend({
    suggest: async () => ({status: "needs_confirmation", candidates: [
      {value: "锡银农商银行", code: "O-XY"},
      {value: "锡山农商银行", code: "O-XS"},
    ]}),
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: askArgs({kind: "suggestion", suggestion: {name: "锡银农商银行", excerpt: "锡银"}}, "锡银")},
    {args: {protocol_version: 1, capability: "metric_query", base: "current", mode: "execute",
      changes: {organizations: {action: "confirm", source_text: "是", decision: "select", expected_count: null}}}},
    {text: "已按回执告知用户查询结果。"},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "preferred-1",
      message: `查锡银${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 1);
    const clarification = (await toolMessages(hosted)).find(message => message.role === "toolResult"
      && message.toolName === "resolve_business_turn"
      && (message.details as {status?: string})?.status === "NEEDS_CLARIFICATION");
    const answer = (clarification?.details as {public_answer?: string} | undefined)?.public_answer ?? "";
    assert(answer.includes("您是指「锡银农商银行」吗？"), "首推候选应改为确认式提问");
    assert(answer.includes("回复“是”直接确认；或选择以下其他机构："), "应给出“是”直接确认的话术");
    assert(answer.indexOf("锡银农商银行") <= answer.indexOf("锡山农商银行"), "首推候选应置顶");
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "preferred-2",
      message: "是"}, {actor: TEST_ACTOR, backend});
    const frames = await new NativeFrameStore(hosted.session).list();
    const success = frames.find(frame => frame.status === "success");
    assert(success, "确认“是”后应执行成功");
    assert.deepEqual((success!.fields.organizations!.resolvedValue as {codes: string[]}).codes, ["O-XY"],
      "“是”应确认首推候选而非其他机构");
    const messages = await toolMessages(hosted);
    const landed = [...messages].reverse().find(message => message.role === "toolResult"
      && message.toolName === "resolve_business_turn" && (message.details as {status?: string})?.status === "succeeded");
    const details = landed?.details as {public_answer?: string} | undefined;
    assert(details?.public_answer?.includes("已按「锡银农商银行」查询（您说的是「锡银」）"),
      "确认后明示仍应指向用户原话 excerpt");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** 场景四：org-catalog 接口失败降级——注入“暂不可用”，旧 rawValue 路径照常完成，不炸。 */
async function catalogDegradation(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "org-suggestion-degraded-"));
  const before = consoleErrors.length;
  const {backend, suggestCalls} = stubBackend({
    orgCatalog: async () => { throw new Error("synthetic catalog down"); },
  });
  const captured: string[][] = [];
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: askArgs({kind: "name", name: "江阴农商银行"}, "江阴农商银行")},
    {text: "已按回执告知用户查询结果。"},
  ], captured), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "degraded-1",
      message: `查江阴农商银行${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 0, "降级后不应进入模型建议通道");
    assert(captured.some(messages => messages.some(text => text.includes("有权机构清单：暂不可用"))),
      "目录失败时应注入“机构清单暂不可用”提示");
    assert(consoleErrors.slice(before).some(line => line.includes("org_catalog_unavailable")),
      "降级路径必须有 org_catalog_unavailable 日志");
    const frames = await new NativeFrameStore(hosted.session).list();
    const success = frames.find(frame => frame.status === "success");
    assert(success, "目录失败不得让整个提问失败");
    assert.deepEqual((success!.fields.organizations!.resolvedValue as {codes: string[]}).codes, ["O-JY"],
      "旧 rawValue 原文路径应照常解析");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

await scenario("org_suggestion_direct", directSuggestion);
await scenario("org_suggestion_typo_correction", typoCorrection);
await scenario("org_suggestion_preferred_confirmation", preferredConfirmation);
await scenario("org_catalog_failure_degradation", catalogDegradation);
console.error = originalError;
console.info = originalInfo;
const passed = results.every(result => result.passed);
console.log(JSON.stringify({passed, environment: "offline_scripted_model_stub_backend", scenarios: results.length}));
if (!passed) process.exitCode = 1;
