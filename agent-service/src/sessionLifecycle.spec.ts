/**
 * 会话生命周期：同一 request_id 的重试与并发接纳、空闲会话回收与列表读取不常驻内存。
 * 模型桩 + 临时原生目录，不调用真实模型或后端。
 */
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createAssistantMessageEventStream, createModels, createProvider, type AssistantMessage, type Model,
  type ProviderStreams} from "@earendil-works/pi-ai";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import type {AgentServiceConfig} from "./config.js";
import type {BackendClient, BackendUser} from "./backendClient.js";
import {HarnessHost} from "./harnessHost.js";
import {NativeSessionStore} from "./nativeSessions.js";

const ACTOR: BackendUser = {id: "user-1", username: "user1", display_name: "用户一", org_code: "3200",
  org_name: "测试机构", role_code: "tester"};
const DEPS = {actor: ACTOR, backend: {} as BackendClient};

/** 每次调用都直接给出最终正文的模型桩；calls 记录真实模型往返次数。 */
function textModel() {
  const counter = {calls: 0};
  const model: Model<"openai-completions"> = {id: "faux-1", name: "faux-1", api: "openai-completions", provider: "faux",
    baseUrl: "http://faux.local", reasoning: false, input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128_000, maxTokens: 8192};
  const respond = () => {
    counter.calls += 1;
    const message: AssistantMessage = {role: "assistant", content: [{type: "text", text: `第${counter.calls}次回答`}],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({type: "start", partial: message});
      stream.push({type: "done", reason: "stop", message});
      stream.end(message);
    });
    return stream;
  };
  const streams: ProviderStreams = {stream: respond, streamSimple: respond};
  const models = createModels();
  models.setProvider(createProvider({id: "faux", name: "faux", auth: {apiKey: {name: "faux", resolve: async () => ({auth: {}})}},
    models: [model], api: streams}));
  return {models, model, counter};
}

function config(dataDir: string): AgentServiceConfig {
  return {host: "127.0.0.1", port: 0, backendBaseUrl: "http://127.0.0.1:1", backendTimeoutMs: 1000,
    model: {baseUrl: "http://faux.local", name: "faux-1", apiKey: "", authHeader: "Authorization", authPrefix: "Bearer",
      userMessageSuffix: "", extraBody: {}, contextWindow: 128_000, maxTokens: 8192},
    dataDir, compaction: {enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000},
    modelRetry: {enabled: false, maxRetries: 0, baseDelayMs: 1}} as AgentServiceConfig;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup(residency?: ConstructorParameters<typeof HarnessHost>[4] extends infer O
  ? O extends {residency?: infer R} ? R : never : never) {
  const dir = mkdtempSync(join(tmpdir(), "ask-metric-lifecycle-"));
  const faux = textModel();
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config(dir), () => ({models: faux.models, model: faux.model}), store, [],
    residency ? {residency} : {});
  cleanups.push(async () => { await host.close(); await store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {host, store, faux};
}

async function userMessages(host: HarnessHost, sessionId: string) {
  const hosted = await host.openSession(ACTOR, sessionId);
  const entries = await hosted!.lane.findEntries({type: "message", order: "oldestFirst"}, BACKGROUND_CONTEXT);
  return entries.filter(entry => entry.type === "message" && entry.message.role === "user");
}

describe("同一 request_id 的重试", () => {
  it("原请求完成后重试只回放原终态，不追加用户消息、不重跑模型", async () => {
    const {host, faux} = await setup();
    const session = await host.createSession(ACTOR);
    const input = {protocol_version: 3 as const, request_id: "r1", message: "查询余额"};
    const first = await host.runPrompt(session, input, DEPS);
    const retry = await host.runPrompt(session, input, DEPS);

    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.outcome).toMatchObject({kind: "settled", outcome: {operationId: first.operationId, status: "completed"}});
    expect(faux.counter.calls).toBe(1);
    expect(await userMessages(host, session.sessionId)).toHaveLength(1);
  });

  it("并发提交同一 request_id 共用同一 operation，关联不被覆盖", async () => {
    const {host, faux} = await setup();
    const session = await host.createSession(ACTOR);
    const input = {protocol_version: 3 as const, request_id: "r1", message: "查询余额"};
    const [a, b] = await Promise.all([host.admitPrompt(session, input, DEPS), host.admitPrompt(session, input, DEPS)]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.operationId).toBe(a.operationId);
    await host.drivePrompt(session, a);
    expect(faux.counter.calls).toBe(1);
    expect(await userMessages(host, session.sessionId)).toHaveLength(1);
  });

  it("并发提交不同 request_id 时只接纳一个，另一个明确返回忙碌", async () => {
    const {host} = await setup();
    const session = await host.createSession(ACTOR);
    const [a, b] = await Promise.all([
      host.admitPrompt(session, {protocol_version: 3, request_id: "r1", message: "问题一"}, DEPS),
      host.admitPrompt(session, {protocol_version: 3, request_id: "r2", message: "问题二"}, DEPS),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find(outcome => !outcome.ok)).toMatchObject({code: "SESSION_BUSY"});
  });
});

describe("会话常驻内存治理", () => {
  it("空闲超时的会话被回收，重新打开后历史仍在", async () => {
    const {host} = await setup({idleMs: 1_000});
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "r1", message: "查询余额"}, DEPS);

    expect(await host.evictIdle(Date.now())).toEqual([]);
    expect(await host.evictIdle(Date.now() + 5_000)).toEqual([session.sessionId]);
    const reopened = await host.openSession(ACTOR, session.sessionId);
    expect(reopened).not.toBe(session);
    expect(await userMessages(host, session.sessionId)).toHaveLength(1);
  });

  it("运行中的会话不回收", async () => {
    const {host} = await setup({idleMs: 1_000});
    const session = await host.createSession(ACTOR);
    const admitted = await host.admitPrompt(session, {protocol_version: 3, request_id: "r1", message: "查询余额"}, DEPS);
    expect(admitted.ok).toBe(true);
    expect(await host.evictIdle(Date.now() + 5_000)).toEqual([]);
    expect(await host.isRunning(session.sessionId)).toBe(true);
  });

  it("超过常驻上限时从最久未用的空闲会话开始回收", async () => {
    const {host} = await setup({maxResident: 1});
    const older = await host.createSession(ACTOR);
    await new Promise(resolve => setTimeout(resolve, 5));
    const newer = await host.createSession(ACTOR);
    expect(await host.evictIdle()).toEqual([older.sessionId]);
    expect(await host.openSession(ACTOR, newer.sessionId)).toBe(newer);
  });

  it("列表读取标题不让未打开的会话常驻", async () => {
    const {host, store} = await setup();
    const session = await host.createSession(ACTOR);
    await session.harness.setName("余额查询", BACKGROUND_CONTEXT);
    await host.closeSession(session.sessionId);
    const release = vi.spyOn(store, "release");
    const [metadata] = await store.list(ACTOR.id);

    expect(await host.sessionTitle(ACTOR.id, metadata!)).toBe("余额查询");
    expect(release).toHaveBeenCalledWith(ACTOR.id, session.sessionId);
    // 正式打开不受列表读取影响。
    expect((await host.openSession(ACTOR, session.sessionId))?.sessionId).toBe(session.sessionId);
  });

  it("并发打开同一会话只挂载一个 harness", async () => {
    const {host} = await setup();
    const session = await host.createSession(ACTOR);
    await host.closeSession(session.sessionId);
    const [a, b] = await Promise.all([host.openSession(ACTOR, session.sessionId), host.openSession(ACTOR, session.sessionId)]);
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });
});
