import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {createAssistantMessageEventStream, createModels, createProvider, type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {HarnessHost} from "../../src/harnessHost.js";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {createAskMetricTools} from "../../src/tools/index.js";
import {TEST_ACTOR} from "../../src/tools/testUtils.js";
import {projectEntries} from "../../src/sessionProjection.js";
import type {AgentServiceConfig} from "../../src/config.js";
import {BackendApiError, type BackendClient} from "../../src/backendClient.js";
import {complete, proposal, syntheticBackend, addPlanBackend} from "./fixtures.js";
import {readDirectAnswerSnapshot} from "../../src/semantic-task/directDelivery.js";
import {NativeSemanticTaskStore} from "../../src/semantic-task/store.js";
import {contextEstimate} from "../../src/semantic-task/contextMemory.js";

type Reply = string | Array<{name: string; args: unknown}>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
function modelFixture(script: Reply[]) {
  let calls = 0;
  const contexts: unknown[] = [], payloads: unknown[] = [];
  const model: Model<"openai-completions"> = {id: "semantic-faux", name: "semantic-faux", api: "openai-completions", provider: "semantic-faux",
    baseUrl: "http://faux.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  const respond: ProviderStreams["streamSimple"] = (current, context, options) => {
    contexts.push(structuredClone(context));
    const reply = script[Math.min(calls++, script.length - 1)]!;
    const message: AssistantMessage = {role: "assistant", content: typeof reply === "string" ? [{type: "text", text: reply}]
      : reply.map((call, i) => ({type: "toolCall", id: `semantic-call-${calls}-${i}`, name: call.name, arguments: call.args as Record<string, unknown>})),
      api: current.api, provider: current.provider, model: current.id, stopReason: typeof reply === "string" ? "stop" : "toolUse", timestamp: Date.now(),
      usage: {input: 100, output: 20, totalTokens: 120, cacheRead: 0, cacheWrite: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const payload = {tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []};
      payloads.push(await options?.onPayload?.(payload, current) ?? payload);
      stream.push({type: "start", partial: message});
      stream.push({type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message});
      stream.end(message);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider(createProvider({id: model.provider, name: "semantic-faux", models: [model],
    auth: {apiKey: {name: "synthetic", resolve: async () => ({auth: {}})}}, api: {stream: respond, streamSimple: respond}}));
  return {models, model, contexts, payloads, calls: () => calls};
}
function config(dir: string): AgentServiceConfig {
  return {host: "127.0.0.1", port: 0, backendBaseUrl: "http://faux.invalid", backendTimeoutMs: 1000, dataDir: dir,
    businessProtocol: "semantic_v2", compaction: {enabled: false, reserveTokens: 1000, keepRecentTokens: 1000},
    modelRetry: {enabled: false, maxRetries: 0, baseDelayMs: 1}, model: {baseUrl: "http://faux.invalid", name: "semantic-faux", apiKey: "", authHeader: "Authorization", authPrefix: "Bearer",
      userMessageSuffix: "", extraBody: {}, contextWindow: 128000, maxTokens: 8192}};
}
async function setup(script: Reply[], protocol: "fixed_v1" | "semantic_v2" = "semantic_v2", directQueryDelivery: NonNullable<AgentServiceConfig["directQueryDelivery"]> = "off",
  overrides: Partial<AgentServiceConfig> = {}) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "semantic-native-"));
  const model = modelFixture(script), backend = syntheticBackend(); addPlanBackend(backend);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost({...config(dir), businessProtocol: protocol, directQueryDelivery, ...overrides}, () => model, store, createAskMetricTools());
  cleanup.push(async () => {await host.close(); await store.close(); rmSync(dir, {recursive: true, force: true});});
  const session = await host.createSession(TEST_ACTOR);
  const run = (id: string, message: string) => host.runPrompt(session, {protocol_version: 3, request_id: id, message}, {actor: TEST_ACTOR, backend: backend as unknown as BackendClient});
  return {dir, model, backend, store, host, session, run};
}
it("百轮后经原生压缩与重开恢复仍精确读早期业务来源，压缩不额外调用模型",async()=>{
 const script:Reply[]=[[{name:"resolve_business_turn",args:proposal(complete())}]];
 const f=await setup(script,"semantic_v2","on",{compaction:{enabled:true,reserveTokens:1000,keepRecentTokens:1000}});
 await f.run("origin","查询合成机构甲2025年末的合成指标甲");
 const store=new NativeSemanticTaskStore(f.session.session),origin=(await store.plan((await store.planIndex()).focus!))!;
 for(let i=0;i<105;i++){script.push("这是合成非业务话题说明。");await f.run(`filler-${i}`,`合成非业务话题${i}，用于长会话上下文验收。`.repeat(12));}
 const calls=f.model.calls();await f.session.lane.compact(undefined,BACKGROUND_CONTEXT);expect(f.model.calls()).toBe(calls);
 expect(await store.plan(origin.ref)).toEqual(origin);
 await f.host.close();await f.store.close();
 const reopenedStore=new NativeSessionStore(f.dir),reopenedHost=new HarnessHost({...config(f.dir),directQueryDelivery:"on"},()=>f.model,reopenedStore,createAskMetricTools());
 cleanup.push(async()=>{await reopenedHost.close();await reopenedStore.close();});
 const reopened=(await reopenedHost.openSession(TEST_ACTOR,f.session.sessionId))!;
 expect(await new NativeSemanticTaskStore(reopened.session).plan(origin.ref)).toEqual(origin);
 script.push([{name:"business_context_read",args:{query_number:1}}],[{name:"read_business_result",args:{task_ref:origin.ref,target_ref:origin.steps[0]!.targetRef,discussion:true}}],"已读取正式结果");
 await reopenedHost.runPrompt(reopened,{protocol_version:3,request_id:"read-origin",message:"重新展示本对话第一次查询的正式结果，不要重新查询"},{actor:TEST_ACTOR,backend:f.backend as unknown as BackendClient});
 expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
 expect(contextEstimate((f.model.contexts.at(-1) as {messages:unknown[]}).messages)).toBeLessThan(12000);
 const entries=await reopened.lane.findEntries({order:"oldestFirst"},BACKGROUND_CONTEXT);
 expect(entries.some(entry=>entry.type==="compaction")).toBe(true);
},30000);
it("真实Pi宿主自动消费许可、交付正文和表格；发送只暴露唯一v2Schema", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}], "已完成查询，请查看结果。"]);
  await f.run("exact", "查询合成机构甲2025年末的合成指标甲");
  expect(f.model.calls()).toBe(2);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const payload = JSON.stringify(f.model.payloads);
  expect(payload).toContain('"const":2');
  expect(payload).not.toContain("mentionIndexes"); expect(payload).not.toContain("fieldIntents");
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const projected = projectEntries(entries);
  expect(projected.some(message => message.role === "assistant" && message.text === "已完成查询，请查看结果。")).toBe(true);
  expect(projected.some(message => message.role === "tool" && (message.details as {kind?: string}).kind === "metric_query_structured")).toBe(true);
});

it("普通完整问数由真实工具回执直接交付，省掉总结调用且快照与正文同源", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}], "不应请求此总结"], "semantic_v2", "on");
  await f.run("direct", "查询合成机构甲2025年末的合成指标甲");
  expect(vi.mocked(console.info).mock.calls.flatMap(call => {
    try {const value = JSON.parse(String(call[0])); return value.event === "direct_query_delivery" ? [value] : [];} catch {return [];}
  })).toContainEqual(expect.objectContaining({eligible: true, reason: "complete_verified_result_only"}));
  expect(f.model.calls()).toBe(1);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const receipt = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []).at(-1)!;
  const snapshot = readDirectAnswerSnapshot(receipt.details);
  expect(snapshot).toMatchObject({version: 1, delivery_path: "direct_query", plan_revision: 1,
    sources: [{task_id: "synthetic-query", result_id: "synthetic-result", row_count: 0, truncated: false}]});
  const content = receipt.content.find(block => block.type === "text");
  expect(content?.type === "text" ? JSON.parse(content.text) : undefined).toEqual(receipt.details);
  expect(projectEntries(entries).some(message => message.role === "assistant" && message.text === snapshot?.public_answer)).toBe(true);
});

it("观察模式保存资格但保持两轮；on 的多目标完整覆盖后整批直出", async () => {
  const observe = await setup([[{name: "resolve_business_turn", args: proposal(complete())}], "观察模式仍由Pi总结"], "semantic_v2", "observe");
  await observe.run("observe", "查询合成机构甲2025年末的合成指标甲");
  expect(observe.model.calls()).toBe(2);
  const observed = await observe.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  expect(observed.some(entry => entry.type === "message" && entry.message.role === "toolResult" && readDirectAnswerSnapshot(entry.message.details))).toBe(false);
  const input = proposal(complete());
  input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"})});
  const f = await setup([[{name: "resolve_business_turn", args: input}], "不应总结"], "semantic_v2", "on");
  await f.run("direct-multi", "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
  expect(f.model.calls()).toBe(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const snapshots = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [readDirectAnswerSnapshot(entry.message.details)].filter(Boolean) : []);
  expect(snapshots).toHaveLength(1); expect(snapshots[0]?.sources).toHaveLength(2);
  expect(snapshots[0]?.public_answer).toContain("合成机构甲"); expect(snapshots[0]?.public_answer).toContain("合成机构乙");
});

it("直出后继续修改日期保持业务继承，两轮各一次模型调用，重复request不重跑", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}],
    [{name: "resolve_business_turn", args: proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"})}], "不应总结"], "semantic_v2", "on");
  await f.run("direct-before", "查询合成机构甲2025年末的合成指标甲");
  await f.run("direct-followup", "日期改成2024年末");
  expect(f.model.calls()).toBe(2); expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  expect(f.backend.basicQueries.mock.calls[1]?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31", end: "2024-12-31"}});
  await f.run("direct-followup", "日期改成2024年末");
  expect(f.model.calls()).toBe(2); expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const snapshots = (await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
    .flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [readDirectAnswerSnapshot(entry.message.details)].filter(Boolean) : []);
  expect(snapshots).toHaveLength(2);
  expect(new Set(snapshots.map(snapshot => snapshot?.answer_id)).size).toBe(2);
});

it.each([
  {field: "time" as const, value: "2024年末", question: "日期改为2024年末，其他条件不变", expected: {metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31", end: "2024-12-31"}}},
  {field: "organizations" as const, value: "合成机构乙", question: "机构改成合成机构乙，其余条件保持不变", expected: {metric_codes: ["M1"], org_codes: ["O2"], time: {start: "2025-12-31", end: "2025-12-31"}}},
  {field: "metrics" as const, value: "合成指标乙", question: "指标换成合成指标乙，其它条件不变", expected: {metric_codes: ["M2"], org_codes: ["O1"], time: {start: "2025-12-31", end: "2025-12-31"}}},
])("确定追问保留其他条件且可直出：$question", async ({field, value, question, expected}) => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}],
    [{name: "resolve_business_turn", args: proposal([{action: "set", field, value}], {kind: "current"})}], "不应总结"], "semantic_v2", "on");
  await f.run("unchanged-before", "查询合成机构甲2025年末的合成指标甲");
  await f.run("unchanged-after", question);
  expect(f.model.calls()).toBe(2); expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  expect(f.backend.basicQueries.mock.calls[1]?.[0]).toMatchObject(expected);
});

it("只读首次查询签发本轮交付来源，历史plan不改写且不重新查询", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}],
    [{name: "resolve_business_turn", args: proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"})}], "占位"], "semantic_v2", "on");
  await f.run("history-first", "查询合成机构甲2025年末的合成指标甲");
  const store = new NativeSemanticTaskStore(f.session.session);
  const first = (await store.plan((await store.planIndex()).focus!))!;
  await f.run("history-second", "日期改成2024年末");
  await f.host.close(); await f.store.close();
  const model = modelFixture([[{name: "read_business_result", args: {task_ref: first.ref, target_ref: first.steps[0]!.targetRef}}], "不应总结"]);
  const reopenedStore = new NativeSessionStore(f.dir), host = new HarnessHost({...config(f.dir), directQueryDelivery: "on"}, () => model, reopenedStore, createAskMetricTools());
  cleanup.push(async () => {await host.close(); await reopenedStore.close();});
  const reopened = (await host.openSession(TEST_ACTOR, f.session.sessionId))!;
  await host.runPrompt(reopened, {protocol_version: 3, request_id: "history-read", message: "重新展示本对话第一次查询的正式结果，不要重新查询"},
    {actor: TEST_ACTOR, backend: f.backend as unknown as BackendClient});
  expect(model.calls()).toBe(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const restored = new NativeSemanticTaskStore(reopened.session);
  expect(await restored.plan(first.ref)).toEqual(first);
  const receipt = (await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    ? [readDirectAnswerSnapshot(entry.message.details)].filter(Boolean) : []).at(-1)!;
  expect(receipt.plan_ref).toBe(first.ref); expect(receipt.operation_id).not.toBe(first.operationId);
  expect((await restored.turn(receipt.operation_id))?.readDelivery).toMatchObject({planRef: first.ref, revision: first.revision, source: "query_ordinal"});
});

it("已保存直出快照重开后同ID恢复，配置回退不重跑模型和SQL", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}], "不应总结"], "semantic_v2", "on");
  await f.run("direct-reopen", "查询合成机构甲2025年末的合成指标甲");
  const before = projectEntries(await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).filter(message => message.role === "assistant" && message.text);
  expect(before).toHaveLength(1);
  await f.host.close(); await f.store.close();
  const model = modelFixture(["不应重跑"]), store = new NativeSessionStore(f.dir);
  const host = new HarnessHost({...config(f.dir), directQueryDelivery: "off"}, () => model, store, createAskMetricTools());
  cleanup.push(async () => {await host.close(); await store.close();});
  const reopened = (await host.openSession(TEST_ACTOR, f.session.sessionId))!;
  await host.runPrompt(reopened, {protocol_version: 3, request_id: "direct-reopen", message: "查询合成机构甲2025年末的合成指标甲"}, {actor: TEST_ACTOR, backend: f.backend as unknown as BackendClient});
  expect(model.calls()).toBe(0); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(projectEntries(await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).filter(message => message.role === "assistant" && message.text)).toEqual(before);
});

it("在途operation接纳时冻结on，重开后off配置仍按原版本完成；新轮可回退", async () => {
  const f = await setup(["未驱动"], "semantic_v2", "on");
  const input = {protocol_version: 3 as const, request_id: "direct-frozen", message: "查询合成机构甲2025年末的合成指标甲"};
  const admission = await f.host.admitPrompt(f.session, input, {actor: TEST_ACTOR, backend: f.backend as unknown as BackendClient});
  expect(admission.ok).toBe(true);
  if (!admission.ok) return;
  expect((await new NativeSemanticTaskStore(f.session.session).turn(admission.operationId))?.directQueryDelivery).toBe("on");
  await f.host.close(); await f.store.close();
  const model = modelFixture([[{name: "resolve_business_turn", args: proposal(complete())}], "不应总结"]), store = new NativeSessionStore(f.dir);
  const host = new HarnessHost({...config(f.dir), directQueryDelivery: "off"}, () => model, store, createAskMetricTools());
  cleanup.push(async () => {await host.close(); await store.close();});
  const reopened = (await host.openSession(TEST_ACTOR, f.session.sessionId))!;
  await host.resumeOpenOperations(reopened, {actor: TEST_ACTOR, backend: f.backend as unknown as BackendClient});
  expect(model.calls()).toBe(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect((await new NativeSemanticTaskStore(reopened.session).turn(admission.operationId))?.directQueryDelivery).toBe("on");
});

it("单原生batch带旁支工具时保留Pi总结，解释诉求即使误标query也不直出", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}, {name: "business_context_read", args: {}}], "Pi负责完整交付"], "semantic_v2", "on");
  await f.run("direct-sibling", "查询合成机构甲2025年末的合成指标甲");
  expect(f.model.calls()).toBe(2);
  const explain = await setup([[{name: "resolve_business_turn", args: proposal(complete())}], "解释待完整取证"], "semantic_v2", "on");
  await explain.run("direct-explain", "查询合成机构甲2025年末的合成指标甲，并解释原因");
  expect(explain.model.calls()).toBe(2);
  const entries = await explain.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  expect(entries.some(entry => entry.type === "message" && entry.message.role === "toolResult" && readDirectAnswerSnapshot(entry.message.details))).toBe(false);
});

it.each([null, "0"])("直接取值原样保留NULL与零，不能混淆：%s", async value => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}], "不应总结"], "semantic_v2", "on");
  const rows = [{org_name: "合成机构甲", metric_name: "合成指标甲", stat_date: "2025-12-31", metric_value: value, unit: "元"}];
  f.backend.basicQueries.mockResolvedValue({result: {status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result",
    columns: ["metric_value"], rows, row_count: 1, truncated: false, message: ""}} as unknown as Awaited<ReturnType<typeof f.backend.basicQueries>>);
  f.backend.getTaskResult.mockResolvedValue({status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result",
    columns: ["metric_value"], rows, row_count: 1, truncated: false} as unknown as Awaited<ReturnType<typeof f.backend.getTaskResult>>);
  await f.run(`direct-value-${value}`, "查询合成机构甲2025年末的合成指标甲");
  expect(f.model.calls()).toBe(1);
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const snapshot = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [readDirectAnswerSnapshot(entry.message.details)].filter(Boolean) : []).at(-1)!;
  expect(snapshot.public_answer).toContain(value === null ? "暂无可用值" : "为0元");
  expect(snapshot.sources[0]?.row_count).toBe(1);
});

it("多目标任一来源在交付前失权时整批取消事实交付，不能只返回有权子集或再让Pi转述", async () => {
  const input = proposal(complete());
  input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"})});
  const f = await setup([[{name: "resolve_business_turn", args: input}], "不应总结"], "semantic_v2", "on");
  let reads = 0;
  f.backend.getTaskResult.mockImplementation(async () => {
    if (++reads === 2) throw new BackendApiError(403, "FORBIDDEN", "synthetic");
    return {status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result", columns: [], rows: [], row_count: 0, truncated: false};
  });
  await f.run("direct-multi-denied", "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
  expect(f.model.calls()).toBe(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const details = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.details] : []).at(-1) as {status: string; state: {evidence?: unknown}};
  expect(details.status).toBe("denied"); expect(details.state.evidence).toBeUndefined();
  expect(readDirectAnswerSnapshot(details)).toBeUndefined();
  expect(projectEntries(entries).filter(message => message.role === "assistant").at(-1)?.text).toContain("权限已变化");
});

it("observe只保留成功总结，已确认来源403仍清事实并停止第二次模型请求", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}], "不得转述失权事实"], "semantic_v2", "observe");
  f.backend.getTaskResult.mockRejectedValue(new BackendApiError(403, "FORBIDDEN", "synthetic"));
  await f.run("observe-denied", "查询合成机构甲2025年末的合成指标甲");
  expect(f.model.calls()).toBe(1);
  const details = (await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.details] : []).at(-1) as {status: string; state: {evidence?: unknown}};
  expect(details.status).toBe("denied"); expect(details.state.evidence).toBeUndefined();
});

it("发送副本的精简入口真实生效，正式查询和落盘回执一致，基础上下文与第二轮输入字节减少", async () => {
  const script: Reply[] = [[{name: "resolve_business_turn", args: proposal(complete())}], "查询完成"];
  const raw = await setup(script, "semantic_v2", "off", {modelContextView: "raw", semanticPromptVariant: "full"});
  const compact = await setup(script, "semantic_v2", "off", {modelContextView: "compact_v1", semanticPromptVariant: "compact_v1"});
  for (const f of [raw, compact]) await f.run("context-view", "查询合成机构甲2025年末的合成指标甲");
  expect(raw.model.calls()).toBe(2); expect(compact.model.calls()).toBe(2);
  const canonical = (value: unknown) => {
    const {calculation_context: _context, ...spec} = value as Record<string, unknown>; return spec;
  };
  expect(canonical(compact.backend.basicQueries.mock.calls[0]?.[0])).toEqual(canonical(raw.backend.basicQueries.mock.calls[0]?.[0]));
  expect(Buffer.byteLength(JSON.stringify(compact.model.contexts[0]))).toBeLessThan(Buffer.byteLength(JSON.stringify(raw.model.contexts[0])));
  expect(Buffer.byteLength(JSON.stringify(compact.model.contexts[1]))).toBeLessThan(Buffer.byteLength(JSON.stringify(raw.model.contexts[1])));
  const receipts = await Promise.all([raw, compact].map(async f => (await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
    .flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.details as {state: {evidence: unknown}}] : [])));
  const formal = (value: unknown) => {
    const {frame_id: _frame, payloads: _payloads, ...evidence} = value as Record<string, unknown>; return evidence;
  };
  expect(formal(receipts[1]?.[0]?.state.evidence)).toEqual(formal(receipts[0]?.[0]?.state.evidence));
});

it("普通缺项问数的catalog成功不能冒充完成，必须保存已知指标并澄清，次轮补条件继承成功", async () => {
  const f = await setup([[{name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "合成指标甲"}]}}],
    "目录中存在这个指标，请提供机构和日期。",
    [{name: "resolve_business_turn", args: proposal([{action: "set", field: "metrics", value: "合成指标甲"}])}],
    [{name: "resolve_business_turn", args: proposal([{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2025年末"}], {kind: "current"})}]],
  "semantic_v2", "on");
  Object.assign(f.backend, {searchMetrics: vi.fn(async () => ({total: 1, items: [{metric_code: "M1", metric_name: "合成指标甲", match_type: "exact"}], semantic_suggestions: []}))});
  await f.run("catalog-missing-first", "帮我查合成指标甲");
  expect(f.model.calls()).toBe(3); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect(f.model.payloads[2]).toMatchObject({tool_choice: {type: "function", function: {name: "resolve_business_turn"}}});
  const store = new NativeSemanticTaskStore(f.session.session), plan = (await store.plan((await store.planIndex()).focus!))!;
  expect(plan.status).toBe("waiting_input");
  const task = (await store.get(plan.steps[0]!.taskRef!))!;
  expect(task.target.fields.metrics?.resolvedValue).toMatchObject({codes: ["M1"]});
  const first = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const receipts = first.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(receipts.map(receipt => receipt.toolName)).toEqual(["catalog", "business_action_required", "resolve_business_turn"]);
  expect(receipts.at(-1)?.details).toMatchObject({status: "needs_user"});
  const answer = projectEntries(first).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []).at(-1);
  expect(answer).toContain("机构"); expect(answer).toContain("日期范围"); expect(answer).not.toContain("目录中存在这个指标");
  await f.run("catalog-missing-second", "机构是合成机构甲日期是2025年末");
  const nextReceipts = (await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.details] : []);
  const next = nextReceipts.at(-1);
  expect(next, JSON.stringify(nextReceipts)).toMatchObject({status: "succeeded"});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2025-12-31", end: "2025-12-31"}});
});

it.each(["合成指标甲的口径是什么", "搜索合成指标甲", "查看合成指标甲的目录说明", "合成指标甲有吗"])("合法目录/说明目的不因catalog成功而被强迫查询：%s", async question => {
  const f = await setup([[{name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "合成指标甲"}]}}], "这是目录说明。"], "semantic_v2", "on");
  Object.assign(f.backend, {searchMetrics: vi.fn(async () => ({total: 1, items: [{metric_code: "M1", metric_name: "合成指标甲", match_type: "exact"}], semantic_suggestions: []}))});
  await f.run("catalog-explanation", question);
  expect(f.model.calls()).toBe(2); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect((await new NativeSemanticTaskStore(f.session.session).planIndex()).order).toEqual([]);
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  expect(entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolName] : [])).toEqual(["catalog"]);
  expect(projectEntries(entries).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []).at(-1)).toBe("这是目录说明。");
});

it("缺项续补误用new及删除历史指标均得到签发来源冲突，Pi同轮current修复后正确执行", async () => {
  const supplied = [{action: "set" as const, field: "organizations" as const, value: "合成机构甲"}, {action: "set" as const, field: "time" as const, value: "2025年末"}];
  const f = await setup([[{name: "resolve_business_turn", args: proposal([{action: "set", field: "metrics", value: "合成指标甲"}])}],
    [{name: "resolve_business_turn", args: proposal([...supplied, {action: "set", field: "metrics", value: "合成指标甲"}])}],
    [{name: "resolve_business_turn", args: proposal(supplied)}],
    [{name: "resolve_business_turn", args: proposal(supplied, {kind: "current"})}]], "semantic_v2", "on");
  await f.run("source-missing", "帮我查合成指标甲");
  const store = new NativeSemanticTaskStore(f.session.session), first = (await store.plan((await store.planIndex()).focus!))!;
  await f.run("source-completion", "机构是合成机构甲日期是2025年末");
  expect(f.model.calls()).toBe(4); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  for (const index of [2, 3]) {
    expect(f.model.payloads[index]).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(f.model.payloads[index])).toContain("business_context_read");
  }
  const receipts = (await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(receipts.map(receipt => receipt.toolName)).toEqual(["resolve_business_turn", "resolve_business_turn", "resolve_business_turn", "resolve_business_turn"]);
  for (const receipt of receipts.slice(1, 3)) expect(receipt.details).toMatchObject({status: "conflict", continuation: {actor: "pi", action: "revise_proposal"},
    issues: [{code: "CONFIRMED_CONTEXT_SOURCE_REQUIRED", source_options: [{task_ref: first.ref, target_ref: first.steps[0]!.targetRef}]}]});
  expect(receipts.at(-1)?.details).toMatchObject({status: "succeeded"});
  expect(await store.plan(first.ref)).toEqual(first);
  expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2025-12-31"}});
});
it("缺项澄清直接来自已保存任务，结束后不额外请求模型", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete().filter(op => op.field !== "time"))}]]);
  await f.run("missing", "查询合成机构甲的合成指标甲");
  expect(f.model.calls()).toBe(1); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const messages = projectEntries(await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(messages.some(message => message.role === "assistant" && message.text.includes("日期范围") && message.text.includes("合成指标甲"))).toBe(true);
});
it("新会话模型补造机构日期和取数口径时立即澄清，不能进入反复历史读取", async () => {
  const args = proposal([
    {action: "set", field: "metrics", value: "合成指标甲"}, {action: "set", field: "time", value: "2026-10-15"},
    {action: "set", field: "selection", value: "当日取值"}, {action: "set", field: "organizations", value: "待确认机构"},
  ]);
  const f = await setup([[{name: "resolve_business_turn", args}], [{name: "business_context_read", args: {}}]]);
  await f.run("missing-invented", "查合成指标甲");
  expect(f.model.calls()).toBe(1); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const calls = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolName] : []);
  expect(calls).toEqual(["resolve_business_turn"]);
  const answer = projectEntries(entries).filter(message => message.role === "assistant").at(-1)?.text;
  expect(answer).toContain("机构"); expect(answer).toContain("日期范围"); expect(answer).toContain("合成指标甲");
  expect(answer).not.toMatch(/待确认机构|取数方式|提议/u);
});
it("重复形状错误作为正式反馈收束，SDK不转换版本，不发第三次模型请求", async () => {
  const args = {...proposal(complete()), protocol_version: "2"};
  const f = await setup([[{name: "resolve_business_turn", args}], [{name: "resolve_business_turn", args}], "不应请求此响应"]);
  await f.run("bad-shape", "查询合成机构甲2025年末的合成指标甲");
  expect(f.model.calls()).toBe(2); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const feedback = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.details] : []) as Array<{status?: string}>;
  expect(feedback.map(item => item.status)).toEqual(["invalid_input", "failed"]);
});
it("提案待修时模型纯文字不能结束，同一Pi修正后才执行", async () => {
  const invalid = proposal([...complete(), {action: "set", field: "metrics", value: "合成指标乙"}]);
  const f = await setup([[{name: "resolve_business_turn", args: invalid}], "请用户重新提供指标", [{name: "resolve_business_turn", args: proposal(complete())}], "查询已完成"]);
  await f.run("repair-required", "查询合成机构甲2025年末的合成指标甲");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.model.payloads[1]).toMatchObject({tool_choice: {type:"function",function:{name:"resolve_business_turn"}}});
  const messages = projectEntries(await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(messages.some(message => message.role === "assistant" && message.text.includes("请用户重新提供指标"))).toBe(false);
  expect(messages.some(message => message.role === "assistant" && message.text === "查询已完成")).toBe(true);
});
it("网关持续忽略修复工具要求时有界结束且不交付内部计划", async () => {
  const invalid = proposal([...complete(), {action: "set", field: "metrics", value: "合成指标乙"}]);
  const f = await setup([[{name: "resolve_business_turn", args: invalid}], "我计划稍后修复"]);
  await f.run("repair-bounded", "查询合成机构甲2025年末的合成指标甲");
  expect(f.model.calls()).toBe(4);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const messages = projectEntries(await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(messages.some(message => message.role === "assistant" && message.text.includes("内部提案尚未修正完成"))).toBe(true);
  expect(messages.some(message => message.role === "assistant" && message.text.includes("稍后修复"))).toBe(false);
});
it("同一模型批次两份resolve在任何业务执行前被阻止", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete())}, {name: "resolve_business_turn", args: proposal(complete())}]]);
  await f.run("batch", "查询合成机构甲2025年末的合成指标甲");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("重开后协议与任务条件保持，修改日期不重新解释已确认指标", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete(), {kind: "new"}, "prepare")}]]);
  await f.run("prepare", "先整理合成机构甲2025年末的合成指标甲，暂不查询");
  const id = f.session.sessionId;
  await f.host.close(); await f.store.close();
  const model = modelFixture([[{name: "resolve_business_turn", args: proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"})}], "已更新并查询。"]);
  const store = new NativeSessionStore(f.dir);
  const host = new HarnessHost({...config(f.dir), businessProtocol: "fixed_v1"}, () => model, store, createAskMetricTools());
  cleanup.push(async () => {await host.close(); await store.close();});
  const reopened = await host.openSession(TEST_ACTOR, id);
  expect(reopened?.businessProtocol).toBe("semantic_v2");
  await host.runPrompt(reopened!, {protocol_version: 3, request_id: "modify", message: "日期改成2024年末"}, {actor: TEST_ACTOR, backend: f.backend as unknown as BackendClient});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const spec = f.backend.basicQueries.mock.calls[0]![0] as {time: {start: string}; metric_codes: string[]};
  expect(spec.time.start).toBe("2024-12-31"); expect(spec.metric_codes).toEqual(["M1"]);
});
it("开启候选默认值不会把已有固定协议Session切换到新Schema", async () => {
  const f = await setup(["占位"], "fixed_v1"), id = f.session.sessionId;
  await f.host.close(); await f.store.close();
  const model = modelFixture(["占位"]), store = new NativeSessionStore(f.dir);
  const host = new HarnessHost(config(f.dir), () => model, store, createAskMetricTools());
  cleanup.push(async () => {await host.close(); await store.close();});
  expect((await host.openSession(TEST_ACTOR, id))?.businessProtocol).toBe("fixed_v1");
});
it("整批自动执行两项目标，正式证据保留两个结果身份", async () => {
  const input = proposal(complete());
  input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"})});
  const f = await setup([[{name: "resolve_business_turn", args: input}], "已完成两个目标。"]);
  await f.run("multi", "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const entries = await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  const native = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "resolve_business_turn" ? [entry.message] : [])[0]!;
  const block = native.content.find(block => block.type === "text");
  expect(block?.type === "text" ? JSON.parse(block.text) : undefined).toEqual(native.details);
  const messages = projectEntries(await f.session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(messages.some(item => item.role === "tool" && (item.details as {kind?: string})?.kind === "semantic_results")).toBe(true);
});

it("查询仅读取上下文后不能用计划文字结束，仍在同一Pi循环修正动作", async () => {
  const f = await setup([[{name: "business_context_read", args: {}}], "我打算去查询。", [{name: "resolve_business_turn", args: proposal(complete())}], "查询完成。"]);
  await f.run("context-only", "查询合成机构甲2025年末的合成指标甲");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("接纳前按request_id停止会持久化，重开后迟到请求仍不能执行且不影响其它请求",async()=>{
 const f=await setup(["不应请求模型"]);
 await f.host.cancelRequest(f.session,"stopped-before-admit");
 const input={protocol_version:3 as const,request_id:"stopped-before-admit",message:"查合成机构甲2025年末的合成指标甲"};
 const deps={actor:TEST_ACTOR,backend:f.backend as unknown as BackendClient};
 expect(await f.host.admitPrompt(f.session,input,deps)).toMatchObject({ok:false,code:"REQUEST_CANCELLED"});
 await f.host.closeSession(f.session.sessionId);
 const reopened=await f.host.openSession(TEST_ACTOR,f.session.sessionId);expect(reopened).toBeDefined();
 expect(await f.host.admitPrompt(reopened!,input,deps)).toMatchObject({ok:false,code:"REQUEST_CANCELLED"});
 const next=await f.host.admitPrompt(reopened!,{...input,request_id:"different-request"},deps);expect(next.ok).toBe(true);
 if(next.ok)await f.host.abort(reopened!,next.operationId);
 expect(f.model.calls()).toBe(0);expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("接纳后但accepted交付前按request_id停止，不能启动模型和查询",async()=>{
 const f=await setup(["不应请求模型"]),request_id="stopped-after-admit";
 const admission=await f.host.admitPrompt(f.session,{protocol_version:3,request_id,message:"查询合成机构甲2025年末的合成指标甲"},{actor:TEST_ACTOR,backend:f.backend as unknown as BackendClient});expect(admission.ok).toBe(true);
 await f.host.cancelRequest(f.session,request_id);
 if(admission.ok){await f.host.drivePrompt(f.session,admission);}
 expect(f.model.calls()).toBe(0);expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
