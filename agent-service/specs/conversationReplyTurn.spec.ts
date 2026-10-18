/**
 * 普通对话回执即结束本轮（B 阶段）：只省掉回答后那次被替换的模型往返；
 * 被拦截的普通回答、业务动作与下一轮约束保持原有行为。模型桩 + 临时原生目录，不访问后端。
 */
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it} from "vitest";
import {createAssistantMessageEventStream, createModels, createProvider, type AssistantMessage, type Model,
  type ProviderStreams} from "@earendil-works/pi-ai";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import type {AgentServiceConfig} from "../src/config.js";
import type {BackendClient, BackendUser} from "../src/backendClient.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {projectEntries} from "../src/sessionProjection.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {ACTION_REQUIRED, CONVERSATION_REPLY} from "../src/tools/turnContract.js";

const ACTOR: BackendUser = {id: "user-1", username: "user1", display_name: "用户一", org_code: "3200",
  org_name: "测试机构", role_code: "USER"};
type Reply = {text: string} | {call: string; args: Record<string, unknown>};

/** 按顺序返回脚本响应；calls 为实际模型往返次数，payloads 记录每次发出的 tool_choice。 */
function scriptedModel(script: Reply[]) {
  const record = {calls: 0, toolChoices: [] as unknown[]};
  const model: Model<"openai-completions"> = {id: "faux-1", name: "faux-1", api: "openai-completions", provider: "faux",
    baseUrl: "http://faux.local", reasoning: false, input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128_000, maxTokens: 8192};
  const respond: ProviderStreams["streamSimple"] = (_model, context, options) => {
    const reply = script[Math.min(record.calls, script.length - 1)]!;
    record.calls += 1;
    const message: AssistantMessage = {role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: "text" in reply ? [{type: "text", text: reply.text}]
        : [{type: "toolCall", id: `call-${record.calls}`, name: reply.call, arguments: reply.args}],
      stopReason: "text" in reply ? "stop" : "toolUse", timestamp: Date.now(),
      usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const payload = {tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []};
      const sent = await options?.onPayload?.(payload, model) as {tool_choice?: unknown} | undefined;
      record.toolChoices.push(sent?.tool_choice);
      stream.push({type: "start", partial: message});
      stream.push({type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message});
      stream.end(message);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider(createProvider({id: "faux", name: "faux", auth: {apiKey: {name: "faux", resolve: async () => ({auth: {}})}},
    models: [model], api: {stream: respond, streamSimple: respond}}));
  return {models, model, record};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup(script: Reply[]) {
  const dir = mkdtempSync(join(tmpdir(), "ask-metric-reply-"));
  const faux = scriptedModel(script);
  const config = {host: "127.0.0.1", port: 0, backendBaseUrl: "http://127.0.0.1:1", backendTimeoutMs: 1000, dataDir: dir,
    model: {baseUrl: "http://faux.local", name: "faux-1", apiKey: "", authHeader: "Authorization", authPrefix: "Bearer",
      userMessageSuffix: "", extraBody: {}, contextWindow: 128_000, maxTokens: 8192},
    compaction: {enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000},
    modelRetry: {enabled: false, maxRetries: 0, baseDelayMs: 1}} as AgentServiceConfig;
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  cleanups.push(async () => { await host.close(); await store.close(); rmSync(dir, {recursive: true, force: true}); });
  const session = await host.createSession(ACTOR);
  const ask = (requestId: string, message: string) => host.runPrompt(session, {protocol_version: 3, request_id: requestId, message},
    {actor: ACTOR, backend: {} as BackendClient});
  const projected = async () => projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  return {host, session, faux, ask, projected};
}

it("普通回答一次模型往返即完成，页面恰好一条完整回答，重开会话后一致", async () => {
  const answer = "你好，我可以帮你查询经营指标、查看历史结果和解释指标口径。";
  const {host, session, faux, ask, projected} = await setup([{call: CONVERSATION_REPLY, args: {answer}}]);
  const outcome = await ask("hello", "你好");

  expect(outcome).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
  expect(faux.record.calls).toBe(1);
  const messages = await projected();
  expect(messages.flatMap(message => message.role === "assistant" && message.text ? [message.text] : [])).toEqual([answer]);
  expect(messages.at(-1)).toMatchObject({role: "assistant", text: answer, business_protocol: "frame_v1"});
  expect(await host.isRunning(session.sessionId)).toBe(false);
  await host.closeSession(session.sessionId);
  const reopened = (await host.openSession(ACTOR, session.sessionId))!;
  expect(projectEntries(await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))).toEqual(messages);
});

it("上下文读取不算业务动作，仍可显式选择普通回答结束本轮", async () => {
  const {faux, ask, projected} = await setup([
    {call: "business_context_read", args: {}},
    {call: CONVERSATION_REPLY, args: {answer: "当前会话还没有业务条件，请告诉我要查询的指标、机构和日期。"}},
  ]);
  const outcome = await ask("read-then-reply", "我之前查过什么");

  expect(outcome).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
  expect(faux.record.calls).toBe(2);
  const messages = await projected();
  expect(messages.at(-1)).toMatchObject({role: "assistant", text: "当前会话还没有业务条件，请告诉我要查询的指标、机构和日期。"});
});
