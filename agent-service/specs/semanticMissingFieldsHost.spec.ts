import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {createAssistantMessageEventStream, createModels, createProvider, type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import type {BackendClient} from "../src/backendClient.js";
import type {AgentServiceConfig} from "../src/config.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {projectEntries} from "../src/sessionProjection.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";
import {CONVERSATION_REPLY} from "../src/tools/turnContract.js";
import {complete, proposal, syntheticBackend} from "./semantic-task/fixtures.js";

type Reply = string | Array<{name: string; args: unknown}>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});

async function setup(script: Reply[]) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "semantic-host-continuation-"));
  let calls = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const model: Model<"openai-completions"> = {id: "continuation-faux", name: "continuation-faux", api: "openai-completions", provider: "continuation-faux",
    baseUrl: "http://faux.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  const respond: ProviderStreams["streamSimple"] = (current, context, options) => {
    const reply = script[Math.min(calls++, script.length - 1)]!;
    const message: AssistantMessage = {role: "assistant", content: typeof reply === "string" ? [{type: "text", text: reply}]
      : reply.map((call, index) => ({type: "toolCall", id: `continuation-call-${calls}-${index}`, name: call.name, arguments: call.args as Record<string, unknown>})),
      api: current.api, provider: current.provider, model: current.id, stopReason: typeof reply === "string" ? "stop" : "toolUse", timestamp: Date.now(),
      usage: {input: 100, output: 20, totalTokens: 120, cacheRead: 0, cacheWrite: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const payload = {tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []};
      payloads.push(await options?.onPayload?.(payload, current) as Record<string, unknown> ?? payload);
      stream.push({type: "start", partial: message});
      stream.push({type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message});
      stream.end(message);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider(createProvider({id: model.provider, name: model.provider, models: [model],
    auth: {apiKey: {name: "synthetic", resolve: async () => ({auth: {}})}}, api: {stream: respond, streamSimple: respond}}));
  const config: AgentServiceConfig = {host: "127.0.0.1", port: 0, backendBaseUrl: "http://faux.invalid", backendTimeoutMs: 1000, dataDir: dir,
    compaction: {enabled: false, reserveTokens: 1000, keepRecentTokens: 1000},
    modelRetry: {enabled: false, maxRetries: 0, baseDelayMs: 1}, model: {baseUrl: "http://faux.invalid", name: model.id, apiKey: "", authHeader: "Authorization", authPrefix: "Bearer",
      userMessageSuffix: "", extraBody: {}, contextWindow: 128000, maxTokens: 8192}};
  const backend = syntheticBackend();
  const tools = createAskMetricTools();
  const read = tools.find(tool => tool.name === "read")!;
  const readExecute = vi.fn(read.execute);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, () => ({models, model}), store, tools.map(tool => tool.name === "read" ? {...tool, execute: readExecute} : tool));
  cleanup.push(async () => {await host.close(); await store.close(); rmSync(dir, {recursive: true, force: true});});
  const session = await host.createSession(TEST_ACTOR);
  const run = (id: string, message: string) => host.runPrompt(session, {protocol_version: 3, request_id: id, message}, {actor: TEST_ACTOR, backend: backend as unknown as BackendClient});
  const entries = () => session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  return {backend, session, run, entries, payloads, readExecute, calls: () => calls};
}

it("新会话缺机构和日期时直接交付缺项，不能继续读历史", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal([{action: "set", field: "metrics", value: "合成指标甲"}])}],
    [{name: "read", args: {kind: "list"}}]]);
  await f.run("missing-both", "查询合成指标甲");
  expect(f.calls()).toBe(1);
  expect(f.readExecute).not.toHaveBeenCalled(); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toHaveLength(1); expect(answers[0]).toContain("机构"); expect(answers[0]).toContain("日期范围");
});

it("空上下文后的纯计划不能交付，继续同轮提案后正式追问机构日期", async () => {
  const f = await setup([[{name: "business_context_read", args: {limit: 10}}], "我将提交查询并在之后确认机构和日期。",
    [{name: "resolve_business_turn", args: proposal([{action: "set", field: "metrics", value: "合成指标甲"}])}]]);
  await f.run("context-plan-missing-both", "查询合成指标甲");
  expect(f.calls()).toBe(3); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(receipts[0]?.details).toMatchObject({context: {tasks: []}});
  expect(receipts[1]?.toolCallId).toBe("semantic-action-required-1");
  expect(receipts[2]?.details).toMatchObject({status: "needs_user"});
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toHaveLength(1); expect(answers[0]).toContain("机构"); expect(answers[0]).toContain("日期范围");
  expect(answers[0]).not.toContain("我将提交");
});

it("只读上下文后普通对话仍可显式交付，不强迫进入查询", async () => {
  const f = await setup([[{name: "business_context_read", args: {}}], [{name: CONVERSATION_REPLY, args: {answer: "你好，请问有什么需要帮助？"}}]]);
  await f.run("context-ordinary-reply", "你好");
  expect(f.calls()).toBe(2); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toEqual(["你好，请问有什么需要帮助？"]);
});

it("上下文探索后的正式目录说明可交付，不强迫解析查询条件", async () => {
  const f = await setup([[{name: "business_context_read", args: {}}],
    [{name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "合成指标甲"}]}}], "目录中存在合成指标甲。"]);
  const searchMetrics = vi.fn(async () => ({total: 1, items: [{code: "M1", name: "合成指标甲", match_type: "exact"}], semantic_suggestions: []}));
  Object.assign(f.backend, {searchMetrics});
  await f.run("context-catalog-explanation", "查看合成指标甲的目录说明");
  expect(f.calls()).toBe(3); expect(searchMetrics).toHaveBeenCalledTimes(1); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolName] : []);
  expect(receipts).not.toContain("resolve_business_turn");
});

it.each(["before", "after"])("同批读取在缺项解析%s时，正式澄清结束本轮且没有多余模型往返", async order => {
  const resolution = {name: "resolve_business_turn", args: proposal(complete().filter(operation => operation.field !== "time"))};
  const read = {name: "read", args: {kind: "list"}};
  const f = await setup([order === "before" ? [read, resolution] : [resolution, read], "不应请求模型"]);
  await f.run("clarification-batch", "查询合成机构甲的合成指标甲");
  expect(f.calls()).toBe(1); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect(f.readExecute).toHaveBeenCalledTimes(order === "before" ? 1 : 0);
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toHaveLength(1); expect(answers[0]).toContain("日期范围");
});

it("旧在途澄清没有终止标记时，发送禁用工具且忽略网关额外读取", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete().filter(operation => operation.field !== "time"))}],
    [{name: "read", args: {kind: "list"}}]]);
  // 模拟升级前已持久化待用户回执但原生批次尚未结束的接续状态。
  f.session.harness.hooks.on("after_tool", event => event.toolName === "resolve_business_turn" ? {terminate: false} : undefined);
  await f.run("old-pending-clarification", "查询合成机构甲的合成指标甲");
  expect(f.calls()).toBe(2); expect(f.readExecute).not.toHaveBeenCalled(); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect(f.payloads[1]).toMatchObject({tool_choice: "none"}); expect(f.payloads[1]).not.toHaveProperty("tools");
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers.every(answer => answer.includes("日期范围"))).toBe(true);
});

it("协议字段动作不合法时按Schema纠正一次，业务条件不重复对账", async () => {
  const wrong = proposal([...complete(), {action: "exclude", field: "time", subject: "2025年末"}]);
  const f = await setup([[{name: "resolve_business_turn", args: wrong}], [{name: "resolve_business_turn", args: proposal(complete())}], "查询已完成。"]);
  await f.run("semantic-repair", "查询合成机构甲2025年末的合成指标甲");
  expect(f.payloads[1]).toMatchObject({tool_choice: {type: "function", function: {name: "resolve_business_turn"}}});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1); expect(f.readExecute).not.toHaveBeenCalled();
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.details] : []);
  expect(receipts[0]).toMatchObject({status: "invalid_input", issues: [expect.objectContaining({code: "INPUT_SHAPE_INVALID"})]});
});

it.each(["read", "business_capability_explain"])("网关忽略协议修正要求而返回%s时仍允许完成参数修正", async tool => {
  const wrong = proposal([...complete(), {action: "exclude", field: "time", subject: "2025年末"}]);
  const f = await setup([[{name: "resolve_business_turn", args: wrong}],
    [{name: tool, args: tool === "read" ? {kind: "list"} : {capability: "comprehensive_analysis"}}],
    [{name: "resolve_business_turn", args: proposal(complete())}], "查询已完成。"]);
  await f.run("ignored-proposal-choice", "查询合成机构甲2025年末的合成指标甲");
  // 修复引导只剩 payload 层 tool_choice 强制；网关忽略时不再拦截旁支或合成 semantic-proposal-repair 回执。
  expect(f.payloads[1]).toMatchObject({tool_choice: {type: "function", function: {name: "resolve_business_turn"}}});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(receipts.some(receipt => receipt.toolCallId.startsWith("semantic-proposal-repair-"))).toBe(false);
});

it("真正引用冲突仍允许历史探索，不用通用修复接续挤掉read", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete(), {kind: "current"})}],
    [{name: "read", args: {kind: "list"}}], [{name: "resolve_business_turn", args: proposal(complete())}], "查询已完成。"]);
  await f.run("reference-exploration", "查询合成机构甲2025年末的合成指标甲");
  expect(f.payloads[1]).not.toHaveProperty("tool_choice");
  expect(f.payloads[1]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({function: expect.objectContaining({name: "read"})})]));
  expect(f.readExecute).toHaveBeenCalledTimes(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("分析确实缺目录证据时允许catalog探索并在同一循环继续", async () => {
  const input = proposal([...complete(), {action: "set", field: "objective", value: "经营规模"}], {kind: "new"}, "analyze");
  const f = await setup([[{name: "resolve_business_turn", args: input}],
    [{name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "经营"}]}}],
    [{name: "resolve_business_turn", args: input}], "分析已完成。"]);
  const searchMetrics = vi.fn(async () => ({total: 1, items: [{code: "M1", name: "合成指标甲", match_type: "contains"}], semantic_suggestions: []}));
  Object.assign(f.backend, {searchMetrics});
  await f.run("catalog-exploration", "分析合成机构甲2025年末的经营情况");
  expect(f.payloads[1]).not.toHaveProperty("tool_choice");
  expect(searchMetrics).toHaveBeenCalledTimes(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});
