/**
 * P1 原生最小闭环验证（模型桩 + 临时原生目录）：
 * 1. 工具返回后确有第二次模型调用与最终 assistant 正文；
 * 2. 会话经原生 JSONL 保存/重开后历史仍在；
 * 3. 达到阈值后出现原生 compaction 条目（无自建摘要）；
 * 4. 授权失效时 provider 边界 fail-closed：内部流实现零调用。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  Type,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT,
  value,
  type AgentHarnessTool,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { AgentServiceConfig } from "../src/config.js";
import { createMetricReadTool } from "../src/tools/readTools.js";
import { BackendApiError } from "../src/backendClient.js";
import { HarnessHost, type HostedSession } from "../src/harnessHost.js";
import {requireRequestContext} from "../src/requestContext.js";
import { MODEL_STREAM_IDLE_EXCEEDED, wrapStreamsWithAuthorization } from "../src/models.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";
import type { BackendClient, BackendUser } from "../src/backendClient.js";
import { createBusinessSkillReadTool, loadBusinessSkills } from "../src/businessSkills.js";
import { EVIDENCE_REPAIR_TOOL, TOOL_LIMIT_ANSWER } from "../src/replyGuard.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { ACTION_REQUIRED, CONVERSATION_REPLY } from "../src/tools/turnContract.js";
import {toCompactTurnArgs, toContextDelta} from "../src/business-context/turnArgs.js";
import {getResolutionFailureDisposition} from "../src/business-context/resolutionFailure.js";
import {createCapabilities} from "../src/business-context/capabilities.js";
import {fromFixedTurnArgs, toFixedTurnArgs} from "../src/business-context/fixedTurnArgs.js";

const ACTOR: BackendUser = {
  id: "user-1",
  username: "user1",
  display_name: "用户一",
  org_code: "3200",
  org_name: "测试机构",
  role_code: "tester",
};

describe.each([false, true])("固定模型入口不受旧compact配置影响 compact=%s", compactTurnArgs => {
  it.each([false, true])("校验前接受输入 compact=%s，审计包装和发送副本不改原生调用", async compactInput => {
    const dir = tempDir();
    const delta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute" as const,
      fieldIntents: {organizations: {mode: "inherit" as const, sourceText: null, expectedCount: null}},
      fieldChanges: [{fieldHint: "selection", operation: "set" as const, rawValue: "exact"}]};
    const args = toFixedTurnArgs(compactInput ? toContextDelta(toCompactTurnArgs(delta)) : delta) as unknown as Record<string, unknown>;
    const faux = createFauxModel([
      {kind: "toolCall", name: "resolve_business_turn", args},
      {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "不客气。"}},
    ]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost({...testConfig(dir), compactTurnArgs}, () => ({models: faux.models, model: faux.model}),
      store, createAskMetricTools({compactTurnArgs}));
    try {
      const session = await host.createSession(ACTOR);
      await host.runPrompt(session, {protocol_version: 3, request_id: "compact-native", message: "新建一笔查询"},
        {actor: ACTOR, backend: {matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient});
      const {NativeFrameStore} = await import("../src/business-context/store.js");
      const frames = await new NativeFrameStore(session.session).list();
      expect(frames).toHaveLength(1);
      expect(frames[0]?.delta).toEqual(delta);
      const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
      const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const call = messages.flatMap(message => message.role === "assistant" ? message.content : [])
        .find(block => block.type === "toolCall" && block.name === "resolve_business_turn");
      expect(call?.type === "toolCall" && call.arguments).toEqual(args);
      const receipts = messages.filter(message => message.role === "toolResult");
      expect(JSON.stringify(receipts)).not.toContain("ARGUMENT_ERROR");
      expect(faux.providerCalls).toBe(1);
      // 澄清在工具回执处结束；下一用户回合仍应无损转换先前原生调用的发送副本。
      await host.runPrompt(session, {protocol_version: 3, request_id: "compact-next", message: "谢谢"},
        {actor: ACTOR, backend: {} as BackendClient});
      expect(faux.providerCalls).toBe(2);
      const second = faux.contexts[1] as {messages: Array<{role: string; content: Array<{type: string; name?: string; arguments?: unknown}>}>};
      const sent = second.messages.flatMap(message => message.role === "assistant" ? message.content : [])
        .find(block => block.type === "toolCall" && block.name === "resolve_business_turn");
      expect(sent?.arguments).toEqual(args);
      expect(fromFixedTurnArgs(sent?.arguments)).toEqual(delta);
      expect(JSON.stringify(faux.contexts.map(context => {const {tools: _privateRuntimeTools, ...rest} = context as Record<string, unknown>; return rest;})))
        .not.toMatch(/fieldChanges|fieldHint|capabilityHint|baseReference|executionMode/);
      expect(JSON.stringify(faux.payloads)).not.toMatch(/fieldChanges|fieldHint|capabilityHint|baseReference|executionMode/);
    } finally {await host.close(); await store.close();}
  });
});

it.each([false, true])("旧已保存planned调用经真实SDK重开恢复一次，新请求仍只能固定协议（旧compact=%s）", async compact => {
  const dir = tempDir(), original = "查询合成机构2026年4月30日合成指标";
  const delta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute" as const,
    fieldIntents: {organizations: {mode: "set" as const, sourceText: "合成机构", expectedCount: null}}, fieldChanges: [
      {fieldHint: "metrics", operation: "set" as const, rawValue: "合成指标"},
      {fieldHint: "organizations", operation: "set" as const, rawValue: "合成机构"},
      {fieldHint: "time", operation: "set" as const, rawValue: "2026年4月30日"},
      {fieldHint: "selection", operation: "set" as const, rawValue: "exact"},
    ]};
  const raw = compact ? toCompactTurnArgs(delta) : delta;
  const faux = createFauxModel([{kind: "text", text: "恢复查询完成。"}, {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "你好。"}}]);
  const basicQueries = vi.fn(async () => ({result: {task_id: "restored-task", status: "succeeded", columns: [], rows: [], row_count: 0}}));
  const backend = fixtureMetricBackend({basicQueries,
    resolveBusinessField: async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date"
      ? {start: "2026-04-30", end: "2026-04-30"} : {codes: [entity === "organization" ? "O" : "M"], names}}),
    createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
    getTask: async () => ({task_id: "restored-task", status: "SUCCEEDED", version: 1, result: {result_id: "restored-result"}}),
  } as unknown as BackendClient, ["合成指标"]);
  const store1 = new NativeSessionStore(dir), host1 = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store1, createAskMetricTools());
  const first = await host1.createSession(ACTOR);
  const admitted = await host1.admitPrompt(first, {protocol_version: 3, request_id: "legacy-saved", message: original}, {actor: ACTOR, backend});
  if (!admitted.ok) throw new Error(admitted.code);
  // 构造升级前原生已提交assistant、工具仍planned的持久化检查点；不运行旧模型或旧业务请求。
  const address = value<Record<string, unknown>>("askmetric", "request/legacy-saved");
  const {toolProtocol: _newProtocol, ...oldAssociation} = (await first.session.getValue(address, BACKGROUND_CONTEXT))!.value;
  await first.session.setValue(address, oldAssociation, BACKGROUND_CONTEXT);
  const branch = (await first.session.branch("main", BACKGROUND_CONTEXT))!;
  const assistantEntryId = await branch.appendMessage(buildAssistant(faux.model, {kind: "toolCall", name: "resolve_business_turn", args: raw}), BACKGROUND_CONTEXT);
  const stateAddress = value<Record<string, unknown>>("pi.op.state", admitted.operationId);
  const state = (await first.session.getValue(stateAddress, BACKGROUND_CONTEXT))!.value;
  const configuration = (await first.session.getValue(value("pi.lane.config", "main"), BACKGROUND_CONTEXT))!.value;
  await first.session.setValue(stateAddress, {...state, at: "tools", latestAssistantEntryId: assistantEntryId,
    batch: {assistantEntryId, configuration, turnId: admitted.operationId,
      calls: [{sourceIndex: 0, resultEntryId: first.session.idGenerator.next(), status: "planned"}]}}, BACKGROUND_CONTEXT);
  await host1.close(); await store1.close();
  const store2 = new NativeSessionStore(dir), host2 = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store2, createAskMetricTools());
  try {
    const reopened = (await host2.openSession(ACTOR, first.sessionId))!;
    expect(await host2.resumeOpenOperations(reopened, {actor: ACTOR, backend})).toBe(1);
    expect(basicQueries).toHaveBeenCalledTimes(1);
    expect(await host2.resumeOpenOperations(reopened, {actor: ACTOR, backend})).toBe(0);
    const saved = await reopened.session.getEntry(assistantEntryId, BACKGROUND_CONTEXT);
    expect(saved?.type === "message" && saved.message.role === "assistant" && saved.message.content[0]).toMatchObject({arguments: raw});
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const frames = await new NativeFrameStore(reopened.session).list();
    expect(frames[0]?.delta).toEqual(toContextDelta(raw)); expect(frames.at(-1)?.status).toBe("success");
    expect(JSON.stringify(faux.payloads)).not.toMatch(/capabilityHint|fieldChanges|baseReference|executionMode/);
    expect(JSON.stringify((faux.contexts[0] as {messages: unknown[]}).messages)).not.toContain('"rawValue":"合成指标"');
    await host2.runPrompt(reopened, {protocol_version: 3, request_id: "after-upgrade", message: "你好"}, {actor: ACTOR, backend});
    expect(basicQueries).toHaveBeenCalledTimes(1);
    expect((await reopened.session.getValue(value<Record<string, unknown>>("askmetric", "request/after-upgrade"), BACKGROUND_CONTEXT))?.value.toolProtocol).toBe("fixed_v1");
  } finally {await host2.close(); await store2.close();}
});

type FauxReply =
  | { kind: "error"; message: string; inputTokens?: number }
  | { kind: "text"; text: string; inputTokens?: number }
  | { kind: "toolCalls"; calls: Array<{name: string; args: Record<string, unknown>}>; inputTokens?: number }
  | { kind: "toolCall"; name: string; args: Record<string, unknown>; inputTokens?: number; preserveArguments?: true };

it.each([false, true])("新模型旧格式输出在SDK执行前拒绝，私有恢复Schema不授予新调用（旧compact=%s）", async compact => {
  const dir = tempDir();
  const delta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute" as const,
    fieldIntents: {organizations: {mode: "inherit" as const, sourceText: null, expectedCount: null}}, fieldChanges: []};
  const args = compact ? toCompactTurnArgs(delta) : delta;
  const proposal: FauxReply = {kind: "toolCall", name: "resolve_business_turn", args, preserveArguments: true};
  const faux = createFauxModel([proposal, proposal]);
  const store = new NativeSessionStore(dir), host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  const basicQueries = vi.fn();
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "fresh-legacy-denied", message: "新建查询"},
      {actor: ACTOR, backend: {basicQueries} as unknown as BackendClient});
    expect(basicQueries).not.toHaveBeenCalled();
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    expect(await new NativeFrameStore(session.session).list()).toHaveLength(0);
    const results = (await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
      .flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    expect(results).toHaveLength(2); expect(results.every(result => result.isError)).toBe(true);
    expect(JSON.stringify(results)).toContain("FIXED_TURN_ARGUMENTS_REQUIRED");
    expect(faux.providerCalls).toBe(3); // 原有重复保护在下一次assistant响应边界终止，第三个提案不执行。
    expect(JSON.stringify(faux.payloads)).not.toMatch(/fieldChanges|capabilityHint|baseReference|executionMode/);
  } finally {await host.close(); await store.close();}
});

interface FauxModel {
  streams: ProviderStreams;
  model: Model<"openai-completions">;
  models: ReturnType<typeof createModels>;
  providerCalls: number;
  contexts: unknown[];
  payloads: unknown[];
}

/** 合成目录全原文匹配桩：来源跨度与旧字段解析桩同源，不调用后端或模型。 */
function fixtureMetricBackend(backend: BackendClient, names: string[]): BackendClient {
  if (typeof backend.matchMetricQuestion === "function") return backend;
  backend.matchMetricQuestion = async question => {
    const selected: Array<{text: string; start: number; end: number}> = [];
    for (const text of [...names].sort((a, b) => b.length - a.length)) {
      const start = question.indexOf(text), end = start + text.length;
      if (start < 0 || selected.some(item => item.start < end && item.end > start)) continue;
      selected.push({text, start, end});
    }
    return {mentions: await Promise.all(selected.sort((a, b) => a.start - b.start).map(async item => ({...item,
      resolution: await backend.resolveBusinessField("metric", [item.text])})))};
  };
  return backend;
}

function buildAssistant(model: Model<"openai-completions">, reply: FauxReply): AssistantMessage {
  const usage = {
    input: reply.inputTokens ?? 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: (reply.inputTokens ?? 100) + 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (reply.kind === "toolCall" || reply.kind === "toolCalls") {
    return {
      role: "assistant",
      content: reply.kind === "toolCall" ? [{ type: "toolCall", id: "call-1", name: reply.name, arguments: reply.args }]
        : reply.calls.map((call, index) => ({type: "toolCall" as const, id: `call-${index + 1}`, name: call.name, arguments: call.args})),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: reply.kind === "error" ? "" : reply.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: reply.kind === "error" ? "error" : "stop",
    ...(reply.kind === "error" ? {errorMessage: reply.message} : {}),
    timestamp: Date.now(),
  };
}

/** 预编排模型桩：按调用顺序返回脚本响应，记录每次调用供断言 */
function createFauxModel(script: FauxReply[], contextWindow = 128_000): FauxModel {
  let calls = 0;
  const contexts: unknown[] = [];
  const payloads: unknown[] = [];
  const model: Model<"openai-completions"> = {
    id: "faux-1",
    name: "faux-1",
    api: "openai-completions",
    provider: "faux",
    baseUrl: "http://faux.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8192,
  };
  const respond = (reply: FauxReply, beforePayload?: () => Promise<void>): ReturnType<ProviderStreams["streamSimple"]> => {
    const message = buildAssistant(model, reply);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      await beforePayload?.();
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end(message);
    });
    return stream;
  };
  const scriptReply = (context: {messages: unknown[]}): FauxReply => {
    const reply = structuredClone(script[Math.min(calls - 1, script.length - 1)]!);
    // 旧场景的模型桩显式声明既定字段意图；生产入口和缺参专项场景不会自动补继承。
    const latestUser = [...context.messages].reverse().find(raw => (raw as {role?: string}).role === "user") as
      {content?: string | Array<{type: string; text?: string}>} | undefined;
    const question = (typeof latestUser?.content === "string" ? latestUser.content
      : latestUser?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") ?? "")
      .split("【服务端注入：本轮业务状态")[0]!.trim();
    const declareFixtureIntent = (call: {name: string; args: Record<string, unknown>}) => {
      if (call.name !== "resolve_business_turn" || Object.hasOwn(call.args, "protocol_version")) return;
      const capability = call.args.capabilityHint ?? call.args.capability ?? "metric_query";
      const schema = createCapabilities().list().find(item => item.capability === capability);
      const changes = call.args.fieldChanges as Array<{fieldHint: string; operation: string; rawValue?: unknown}> | undefined;
      const set = call.args.set as Record<string, unknown> | undefined;
      call.args.fieldIntents ??= Object.fromEntries(Object.entries(schema?.fields ?? {}).filter(([, field]) => field.requireTurnIntent)
        .map(([name]) => {
          const change = changes?.find(item => item.fieldHint === name);
          const raw = change?.rawValue ?? set?.[name];
          const operation = change?.operation ?? (set && Object.hasOwn(set, name) ? "set"
            : (call.args.clear as string[] | undefined)?.includes(name) ? "clear"
            : (call.args.remove as Record<string, unknown> | undefined)?.[name] !== undefined ? "remove" : "retain");
          const mode = operation === "retain" ? "inherit"
            : operation === "set" && raw && typeof raw === "object" && ((raw as {confirm?: boolean}).confirm === true
              || Object.hasOwn(raw, "candidateIndex")) ? "confirm" : operation;
          return [name, {mode, sourceText: mode === "inherit" ? null : raw && typeof raw === "object"
            && typeof (raw as {sourceText?: unknown}).sourceText === "string" ? (raw as {sourceText: string}).sourceText : question,
            expectedCount: mode === "set" && raw && typeof raw === "object" && typeof (raw as {expectedCount?: unknown}).expectedCount === "number"
              ? (raw as {expectedCount: number}).expectedCount : null}];
        }));
      // 仅迁移预编排测试数据：生产入口绝不接受旧格式。非法值仍作为固定Schema负例提交。
      const intents = call.args.fieldIntents as Record<string, {mode: string; sourceText: string | null; expectedCount: number | null}>;
      const changesByName: Record<string, unknown> = Object.fromEntries(Object.entries(intents).filter(([, intent]) => intent.mode === "inherit")
        .map(([name]) => [name, {action: "inherit"}]));
      const inputChanges: Array<{fieldHint: string; operation: string; rawValue?: unknown}> = changes ?? [
        ...Object.entries(set ?? {}).map(([fieldHint, rawValue]) => ({fieldHint, operation: "set", rawValue})),
        ...Object.entries(call.args.remove as Record<string, unknown> ?? {}).map(([fieldHint, rawValue]) => ({fieldHint, operation: "remove", rawValue})),
        ...(call.args.clear as string[] ?? []).map(fieldHint => ({fieldHint, operation: "clear"})),
        ...(call.args.retain as string[] ?? []).map(fieldHint => ({fieldHint, operation: "retain"})),
      ];
      for (const change of inputChanges) {
        const field = schema?.fields[change.fieldHint], intent = intents[change.fieldHint];
        const raw = change.rawValue, object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
        const evidence = field?.requireTurnIntent ? {source_text: intent?.sourceText, expected_count: intent?.expectedCount} : {};
        let value = raw;
        if (field?.resolver === "metric" && (typeof raw === "string" && question.includes(raw)
          || Array.isArray(raw) && raw.every(name => typeof name === "string" && question.includes(name)))) value = {fromQuestion: true};
        if (field?.resolver === "organization" && change.operation === "set" && !object?.confirm && !object?.clarify) {
          if (typeof raw === "string") value = {kind: "name", name: raw};
          else if (Array.isArray(raw)) value = {kind: "names", names: raw};
          else if (object) {
            const {sourceText: _source, expectedCount: _count, fromHistory, ...rest} = object;
            value = {...(fromHistory ? {kind: "history"} : {}), ...rest};
          }
        }
        changesByName[change.fieldHint] = change.operation === "retain" ? {action: "inherit"}
          : change.operation === "clear" ? {action: "clear", ...evidence}
          : object?.confirm === true ? {action: "confirm", ...evidence, source_text: intent?.sourceText ?? question,
            decision: (object.evidence as {decision?: string} | undefined)?.decision === "accept" ? "accept" : "select"}
          : object?.clarify === true ? {action: "clarify", ...evidence, source_text: object.sourceText}
          : {action: change.operation, ...evidence, value};
      }
      call.args = {protocol_version: 1, capability, base: Object.hasOwn(call.args, "baseReference") ? call.args.baseReference : call.args.base,
        mode: call.args.executionMode ?? call.args.mode, changes: changesByName};
    };
    if (reply.kind === "toolCall" && !reply.preserveArguments) declareFixtureIntent(reply);
    if (reply.kind === "toolCalls") reply.calls.forEach(declareFixtureIntent);
    const fillFrameReference = (call: {args: Record<string, unknown>}) => {
      if (call.args.frameId !== "__LATEST_FRAME__") return;
      const result = [...context.messages].reverse().find(raw => {
        const message = raw as {role?: string; toolName?: string};
        return message.role === "toolResult" && message.toolName === "resolve_business_turn";
      }) as {content: Array<{text?: string}>} | undefined;
      call.args.frameId = JSON.parse(result?.content[0]?.text ?? "{}").frameId;
    };
    if (reply.kind === "toolCall") fillFrameReference(reply);
    if (reply.kind === "toolCalls") reply.calls.forEach(fillFrameReference);
    return reply;
  };
  const streams: ProviderStreams = {
    stream: (requestModel, context, options) => {
      contexts.push(structuredClone(context));
      calls += 1;
      return respond(scriptReply(context), async () => {
        const payload = {tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []};
        payloads.push(await options?.onPayload?.(payload, requestModel) ?? payload);
      });
    },
    streamSimple: (requestModel, context, options) => {
      contexts.push(structuredClone(context));
      calls += 1;
      return respond(scriptReply(context), async () => {
        const payload = {tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []};
        payloads.push(await options?.onPayload?.(payload, requestModel) ?? payload);
      });
    },
  };
  const provider = createProvider({
    id: "faux",
    name: "faux",
    auth: { apiKey: { name: "faux", resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: streams,
  });
  const models = createModels();
  models.setProvider(provider);
  return { streams, model, models, contexts, payloads, get providerCalls() { return calls; }, set providerCalls(_v: number) { /* 只读 */ } } as FauxModel;
}

function createStubTool(calls: string[]): AgentHarnessTool<AskMetricRequestContext> {
  return {
    name: "stub_lookup",
    label: "桩查询",
    description: "返回固定数值的测试工具",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _onUpdate, toolContext) => {
      calls.push(toolContext.actor.id);
      return {
        content: [{ type: "text", text: JSON.stringify({ value: 42 }) }],
        details: { value: 42 },
      };
    },
  };
}

function testConfig(dataDir: string, compaction?: AgentServiceConfig["compaction"]): AgentServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    backendBaseUrl: "http://127.0.0.1:1",
    backendTimeoutMs: 1000,
    model: {
      baseUrl: "http://faux.local",
      name: "faux-1",
      apiKey: "",
      authHeader: "Authorization",
      authPrefix: "Bearer",
      userMessageSuffix: "",
      extraBody: {},
      contextWindow: 128_000,
      maxTokens: 8192,
    },
    dataDir,
    compaction: compaction ?? { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    modelRetry: { enabled: true, maxRetries: 1, baseDelayMs: 1_000 },
  };
}


function captureStreamModes(session: HostedSession) {
  const modes: Array<{mode?: string; callSeq?: number; step?: string}> = [];
  session.harness.hooks.on("before_payload", (_event, context) => {
    const request = requireRequestContext(context);
    modes.push({...request.answerStream, ...(request.modelCall ? {step: request.modelCall.step} : {})});
    return undefined;
  });
  return modes;
}

it.each(["frame", "legacy", "existing_reply"])("流式模式遵守本轮协议与已交付普通回答（%s）", async kind => {
  const dir = tempDir();
  const faux = createFauxModel([{kind: "text", text: "模型正文"}]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store,
    kind === "existing_reply" ? createAskMetricTools() : []);
  try {
    const session = await host.createSession(ACTOR);
    const modes = captureStreamModes(session);
    const admitted = await host.admitPrompt(session, {protocol_version: 3, request_id: kind, message: "你好"}, {actor: ACTOR, backend: {} as BackendClient});
    expect(admitted.ok).toBe(true); if (!admitted.ok) return;
    // 临时原生测试目录中模拟旧回合/升级前已写入普通回答回执的恢复点。
    if (kind === "legacy") await session.lane.appendMessage({role: "user", content: "旧协议回合", timestamp: Date.now()}, admitted.context);
    if (kind === "existing_reply") await session.lane.appendMessage({role: "toolResult", toolCallId: "reply-previous", toolName: CONVERSATION_REPLY,
      content: [{type: "text", text: "原普通回答"}], details: {answer: "原普通回答"}, isError: false, timestamp: Date.now()}, admitted.context);
    await host.drivePrompt(session, admitted);
    expect(modes.map(item => item.mode)).toEqual([kind === "frame" ? "text" : "none"]);
    expect(modes[0]?.callSeq).toBe(1);
    if (kind === "existing_reply") expect(faux.payloads[0]).toMatchObject({tool_choice: "none"});
  } finally {await host.close(); await store.close();}
});

it("已解析但未就地落地的 Frame 强制执行时不流式，执行后允许正文", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "data_availability", baseReference: null, executionMode: "execute",
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成机构"}, {fieldHint: "dimension", operation: "set", rawValue: "metrics"}]}},
    {kind: "toolCall", name: "execute_business_frame", args: {frameId: "__LATEST_FRAME__"}},
    {kind: "text", text: "覆盖查询已完成。"},
  ]);
  const backend = {resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O"], names: ["合成机构"]}}),
    dataAvailability: async () => ({status: "succeeded", org_codes: ["O"], items: [], total: 0})} as unknown as BackendClient;
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  // 模拟升级前的恢复点：解析成功后尚未进入就地执行，原生循环接续执行工具。
  vi.spyOn(host as unknown as {landValidatedAction: () => Promise<undefined>}, "landValidatedAction").mockResolvedValue(undefined);
  try {
    const session = await host.createSession(ACTOR); const modes = captureStreamModes(session);
    await host.runPrompt(session, {protocol_version: 3, request_id: "pending-stream", message: "合成机构有哪些指标"}, {actor: ACTOR, backend});
    expect(modes.map(item => item.mode)).toEqual(["reply", "none", "text"]);
    expect(modes.map(item => item.callSeq)).toEqual([1, 2, 3]);
  } finally {await host.close(); await store.close();}
});

it("同批目录重复失败后的可信执行成功不能被旧错误覆盖", async () => {
  const dir = tempDir();
  const catalog = {name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "合成指标"}]}};
  const faux = createFauxModel([
    {kind: "toolCalls", calls: [{name: "resolve_business_turn", args: {capabilityHint: "data_availability", baseReference: null,
      executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
        {fieldHint: "dimension", operation: "set", rawValue: "metrics"}]}}, {name: "business_context_read", args: {}}]},
    {kind: "toolCalls", calls: [catalog, catalog, {name: "execute_business_frame", args: {frameId: "__LATEST_FRAME__"}}]},
    {kind: "text", text: "覆盖查询已完成。"},
  ]);
  const searchMetrics = vi.fn(async () => {throw new Error("SYNTHETIC_DIRECTORY_FAILURE");});
  const dataAvailability = vi.fn(async (request: unknown) => ({status: "succeeded", mode: "metrics", request,
    org_names: ["合成机构"], org_count: 1, metric_count: 0, items: [], groups: [], page: 1, page_size: 20, has_more: false, notice: "合成验收数据"}));
  const backend = {searchMetrics, dataAvailability,
    resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O"], names: ["合成机构"]}})} as unknown as BackendClient;
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  // 与升级前 READY 尚未落地的恢复点相同，接续真实执行工具。
  vi.spyOn(host as unknown as {landValidatedAction: () => Promise<undefined>}, "landValidatedAction").mockResolvedValue(undefined);
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "execution-resets-loop", message: "合成机构有哪些指标"}, {actor: ACTOR, backend});
    expect(searchMetrics).toHaveBeenCalledTimes(2);
    expect(dataAvailability).toHaveBeenCalledTimes(1);
    const {projectEntries} = await import("../src/sessionProjection.js");
    const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
    expect(messages.at(-1)).toMatchObject({role: "assistant", text: "覆盖查询已完成。"});
    expect(faux.providerCalls).toBe(3);
  } finally {await host.close(); await store.close();}
});

it.each(["compaction", "branch_summary"] as const)("摘要步骤 %s 不流式且 payload 保持原样", async step => {
  const dir = tempDir(); const faux = createFauxModel([{kind: "text", text: "合成摘要"}]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, []);
  try {
    const session = await host.createSession(ACTOR);
    // 应用层摘要隔离测试；完整原生 compaction 流程另有集成用例。
    session.harness.hooks.on("before_request", (_event, context) => {
      requireRequestContext(context).modelCall!.step = step;
      return undefined;
    });
    const modes = captureStreamModes(session);
    await host.runPrompt(session, {protocol_version: 3, request_id: step, message: "摘要步骤"}, {actor: ACTOR, backend: {} as BackendClient});
    expect(modes).toEqual([{mode: "none", callSeq: 1, step}]);
    expect(faux.payloads[0]).not.toHaveProperty("tool_choice");
  } finally {await host.close(); await store.close();}
});

function entryTexts(entries: Entry[]): string[] {
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => {
      const message = (entry as { message?: { role?: string; content?: unknown } }).message;
      if (!message) return "";
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) {
        return (message.content as Array<{ type?: string; text?: string }>)
          .map((block) => block.text ?? "")
          .join("");
      }
      return "";
    });
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-metric-p1-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe.each([false, true])("确定业务限制 compact=%s", compactTurnArgs => {
  function args(capability: string, fields: Record<string, unknown>) {
    return compactTurnArgs ? {capability, base: null, mode: "execute", set: fields}
      : {capabilityHint: capability, baseReference: null, executionMode: "execute",
        fieldChanges: Object.entries(fields).map(([fieldHint, rawValue]) => ({fieldHint, operation: "set", rawValue}))};
  }

  async function runLimit(code: "EMPTY_AUTHORIZED_SCOPE" | "UNSUPPORTED_QUERY_COMBINATION", sameBatch = false, alternatives = 1) {
    const dir = tempDir();
    const first = {name: "resolve_business_turn", args: args("metric_query", {
      metrics: {fromQuestion: true}, organizations: {kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "各家农商行"},
      time: code === "EMPTY_AUTHORIZED_SCOPE" ? "2026年4月末" : "2026年4月每天",
      selection: code === "EMPTY_AUTHORIZED_SCOPE" ? "exact" : "all_in_range", operation: {kind: "ranking", position: "top", top_n: 3},
    })};
    const alternative = {name: "resolve_business_turn", args: args("data_availability", {organizations: "各家农商行", dimension: "metrics"})};
    const nextTurn = {kind: "toolCall" as const, name: "resolve_business_turn", args: args("data_availability", {organizations: "合成机构", dimension: "metrics"})};
    const faux = createFauxModel(sameBatch ? [
      {kind: "toolCalls", calls: [first, ...Array.from({length: alternatives}, () => alternative)]},
      {kind: "text", text: "本次目标无法完成。"}, nextTurn, {kind: "text", text: "新的覆盖查询已完成。"},
    ] : [
      {kind: "toolCall", ...first}, {kind: "toolCall", ...alternative}, nextTurn, {kind: "text", text: "新的覆盖查询已完成。"},
    ]);
    const dataAvailability = vi.fn(async () => ({status: "succeeded", items: [], total: 0, org_codes: ["O"]}));
    const basicQueries = vi.fn();
    const resolveOrganizationScope = vi.fn(async () => {
      if (code === "EMPTY_AUTHORIZED_SCOPE") throw new BackendApiError(422, "合成空范围", code);
      return {status: "resolved", value: {codes: ["O"], names: ["合成机构"], scope_fingerprint: "a".repeat(64),
        scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}}};
    });
    const backend = {
      matchMetricQuestion: async (question: string) => {
        const start = question.indexOf("合成指标");
        return {mentions: start < 0 ? [] : [{text: "合成指标", start, end: start + 4,
          resolution: {status: "resolved", value: {codes: ["M"], names: ["合成指标"]}}}]};
      },
      resolveBusinessField: async (entity: string, raw: string[]) => ({status: "resolved", value: entity === "date"
        ? {start: code === "EMPTY_AUTHORIZED_SCOPE" ? "2026-04-30" : "2026-04-01", end: "2026-04-30"}
        : {codes: ["O"], names: raw}}),
      resolveOrganizationScope, basicQueries, dataAvailability,
    } as unknown as BackendClient;
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost({...testConfig(dir), compactTurnArgs}, () => ({models: faux.models, model: faux.model}),
      store, createAskMetricTools({compactTurnArgs}));
    try {
      const session = await host.createSession(ACTOR);
      const message = code === "EMPTY_AUTHORIZED_SCOPE" ? "查询2026年4月末各家农商行合成指标前3名。" : "查询2026年4月每天各家农商行合成指标前3名。";
      await host.runPrompt(session, {protocol_version: 3, request_id: "business-limit", message}, {actor: ACTOR, backend});
      expect(resolveOrganizationScope).toHaveBeenCalledTimes(1);
      expect(basicQueries).not.toHaveBeenCalled();
      expect(dataAvailability).not.toHaveBeenCalled();
      expect(faux.providerCalls).toBe(2);
      expect(faux.payloads[1]).toMatchObject({tool_choice: "none"});
      expect(faux.payloads[1]).not.toHaveProperty("tools");
      const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
      const failure = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
        && (entry.message.details as {error_code?: string} | undefined)?.error_code === code);
      expect(failure?.type === "message" && failure.message.role === "toolResult" && failure.message.details)
        .toMatchObject({status: "error", retryable: false, error_code: code});
      const {NativeFrameStore} = await import("../src/business-context/store.js");
      expect(await new NativeFrameStore(session.session).list()).toHaveLength(0);
      const {projectEntries} = await import("../src/sessionProjection.js");
      const answers = projectEntries(entries).filter(item => item.role === "assistant" && item.text.trim());
      expect(answers).toHaveLength(1);
      if (!sameBatch) expect(answers[0]?.role === "assistant" && answers[0].text).toBe(getResolutionFailureDisposition(code)?.message);
      else expect(answers[0]?.role === "assistant" && answers[0].text).toBe("本次目标无法完成。");
      await host.runPrompt(session, {protocol_version: 3, request_id: "new-goal", message: "合成机构有哪些指标数据？"}, {actor: ACTOR, backend});
      expect(dataAvailability).toHaveBeenCalledTimes(1);
      expect(faux.providerCalls).toBe(4);
    } finally {await host.close(); await store.close();}
  }

  it.each(["EMPTY_AUTHORIZED_SCOPE", "UNSUPPORTED_QUERY_COMBINATION"] as const)("%s后忽略none也不能换能力重试，新回合可继续", async code => {
    await runLimit(code);
  });
  it.each([1, 3])("同批工具中确定失败后拦截%s个替代调用并保留真实终态正文", async alternatives => {
    await runLimit("EMPTY_AUTHORIZED_SCOPE", true, alternatives);
  });
});

describe("业务知识与原生工具循环、回答职责", () => {
  it("当前目录命中指标时先取得业务工具回执，技能读取不解除首轮工具约束", async () => {
    const dir = tempDir();
    const skills = await loadBusinessSkills();
    const question = "合成余额当日数和较上月增幅";
    const matchMetricQuestion = vi.fn(async () => ({mentions: [
      {text: "合成余额当日数", start: 0, end: 7,
        resolution: {status: "resolved", value: {codes: ["A"], names: ["合成余额当日数"]}}},
      {text: "较上月增幅", start: 8, end: 13,
        resolution: {status: "resolved", value: {codes: ["B"], names: ["合成余额较上月增幅"]}}},
    ]}));
    const faux = createFauxModel([
      {kind: "toolCall", name: "business_skill_read", args: {name: "metric-query"}},
      {kind: "toolCall", name: "business_context_read", args: {}},
      {kind: "text", text: "需要继续解析本轮条件。"},
    ]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}),
      store, [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
    try {
      const session = await host.createSession(ACTOR);
      await host.runPrompt(session, {protocol_version: 3, request_id: "shared-prefix", message: question},
        {actor: ACTOR, backend: {matchMetricQuestion} as unknown as BackendClient});
      expect(matchMetricQuestion).toHaveBeenCalledTimes(1);
      expect(faux.payloads.map(payload => (payload as {tool_choice?: string}).tool_choice))
        .toEqual(["required", "required", undefined]);
    } finally { await host.close(); await store.close(); }
  });

  it.each([{methods: []}, {methods: ["data-coverage"]}, {methods: ["analysis-boundary", "result-calculation"]}])(
    "业务知识读取不改变直接提交查询的能力：$methods", async ({methods}) => {
      const dir = tempDir();
      const skills = await loadBusinessSkills();
      const faux = createFauxModel([
        ...methods.map(name => ({kind: "toolCall" as const, name: "business_skill_read", args: {name}})),
        {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null,
          fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: "余额"}, {fieldHint: "organizations", operation: "set", rawValue: "测试机构"}, {fieldHint: "selection", operation: "set", rawValue: "exact"}], executionMode: "execute"}},
        {kind: "text", text: "请补充日期？"},
      ]);
      const submitQuestion = vi.fn(async (_question: string) => ({task_id: "waiting", conversation_id: "c", version: 1,
        status: "WAITING_USER", clarification: {id: "date", prompt: "请补充日期"}}));
      const store = new NativeSessionStore(dir);
      const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}),
        store, [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
      try {
        const session = await host.createSession(ACTOR);
        await host.runPrompt(session, {protocol_version: 3, request_id: "knowledge-only", message: "查询测试机构余额"},
          {actor: ACTOR, backend: fixtureMetricBackend({submitQuestion, resolveBusinessField: async (_entity: string, names: string[]) => ({status: "resolved", value: {codes: names, names}})} as unknown as BackendClient, ["余额"])});
        expect(submitQuestion).not.toHaveBeenCalled();

        expect(faux.providerCalls).toBe(methods.length + 1);
        const expectedTools = [...createAskMetricTools().map(tool => tool.name).filter(name => name !== ACTION_REQUIRED), "business_skill_read"].sort();
        expect(faux.payloads).toHaveLength(methods.length + 1);
        for (const raw of faux.payloads) {
          const payload = raw as {tools?: Array<{function: {name: string}}>; tool_choice?: string};
          if (payload.tool_choice === "none") {expect(payload.tools).toBeUndefined(); continue;}
          expect(payload.tools!.map(tool => tool.function.name).sort()).toEqual(expectedTools);
        }
      } finally { await host.close(); await store.close(); }
    },
  );

  it.each([{methods: []}, {methods: ["metric-query"]}, {methods: ["analysis-boundary", "data-coverage"]}])(
    "正式编码与日期已确认时无需覆盖回执即可结构化取数：$methods", async ({methods}) => {
      const dir = tempDir();
      const skills = await loadBusinessSkills();
      const faux = createFauxModel([
        ...methods.map(name => ({kind: "toolCall" as const, name: "business_skill_read", args: {name}})),
        {kind: "toolCall", name: "catalog", args: {action: "search", queries: [
          {entity: "metric", keyword: "演示余额"}, {entity: "organization", keyword: "演示行"},
        ]}},
        {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
          {fieldHint: "metrics", operation: "set", rawValue: "演示余额"}, {fieldHint: "organizations", operation: "set", rawValue: "演示行"},
          {fieldHint: "time", operation: "set", rawValue: "2026年3月31日"}, {fieldHint: "selection", operation: "set", rawValue: "exact"}]}},
        {kind: "toolCall", name: "execute_business_frame", args: {frameId: "__LATEST_FRAME__"}},
        {kind: "text", text: "查询完成"},
      ]);
      const basicQueries = vi.fn(async (_spec: unknown) => ({result: {
        task_id: "t", status: "succeeded", rows: [], columns: [], row_count: 0, message: "暂无匹配数据。",
      }}));
      const backend = {
        resolveBusinessField: async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date" ? {start: "2026-03-31", end: "2026-03-31"} : {codes: [entity === "metric" ? "M" : "O"], names}}),
        searchMetrics: async () => ({total: 1, items: [{metric_code: "M", metric_name: "演示余额", match_type: "exact"}]}),
        searchOrganizations: async () => ({total: 1, items: [{org_code: "O", org_name: "演示行", match_type: "exact"}]}),
        createAgentQueryContext: async () => ({conversation_id: "c"}), basicQueries,
        getTask: async () => ({task_id: "t", status: "SUCCEEDED", version: 3, result: {result_id: "r"}}),
      } as unknown as BackendClient;
  fixtureMetricBackend(backend, ["演示余额"]);
      const store = new NativeSessionStore(dir);
      const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}),
        store, [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
      try {
        const session = await host.createSession(ACTOR);
        await host.runPrompt(session, {protocol_version: 3, request_id: "direct-structured", message: "演示行2026年3月31日演示余额"}, {actor: ACTOR, backend});
        expect(basicQueries).toHaveBeenCalledTimes(1);
        expect(basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M"], org_codes: ["O"],
          time: {start: "2026-03-31", end: "2026-03-31"}, selection: "exact"});
        expect(faux.providerCalls).toBe(methods.length + 4);
      } finally { await host.close(); await store.close(); }
    },
  );

  it("计算知识不阻止用户查看历史结果，历史事实的计算范围由后端校验", async () => {
    const dir = tempDir();
    const skills = await loadBusinessSkills();
    const faux = createFauxModel([
      {kind: "toolCall", name: "business_skill_read", args: {name: "result-calculation"}},
      {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "计算规则已说明。"}},
      {kind: "text", text: "计算规则已说明。"},
      {kind: "toolCall", name: "read", args: {kind: "result", task_id: "t", result_id: "r"}},
      {kind: "text", text: "历史结果已显示。"},
    ]);
    const getTaskResult = vi.fn(async () => ({task_id: "t", result_id: "r", status: "succeeded",
      rows: [], columns: [], row_count: 0, has_more: false, message: "历史查询没有匹配记录。"}));
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}),
      store, [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
    try {
      const session = await host.createSession(ACTOR);
      const deps = {actor: ACTOR, backend: {getTaskResult} as unknown as BackendClient};
      await host.runPrompt(session, {protocol_version: 3, request_id: "rules", message: "解释计算规则"}, deps);
      await host.runPrompt(session, {protocol_version: 3, request_id: "history", message: "再显示历史查询结果"}, deps);
      expect(getTaskResult).toHaveBeenCalledTimes(1);
      expect(faux.providerCalls).toBe(5);
    } finally { await host.close(); await store.close(); }
  });

  it("能力边界由 Pi 解释，不把未支持的分析改成取数", async () => {
    const dir = tempDir();
    const skills = await loadBusinessSkills();
    const faux = createFauxModel([
      {kind: "toolCall", name: "business_skill_read", args: {name: "analysis-boundary"}},
      {kind: "toolCall", name: "business_capability_explain", args: {capability: "cause_analysis"}},
      {kind: "text", text: "当前尚未提供业务动因及客户流失归因能力，无法给出可靠归因。"},
    ]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}),
      store, [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
    try {
      const session = await host.createSession(ACTOR);
      await host.runPrompt(session, {protocol_version: 3, request_id: "unsupported-analysis", message: "解释客户流失原因"},
        {actor: ACTOR, backend: {} as BackendClient});
      expect(faux.providerCalls).toBe(3);
      const {projectEntries} = await import("../src/sessionProjection.js");
      const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
      expect(messages.filter(message => message.role === "tool").map(message => message.tool))
        .toEqual(["business_skill_read", "business_capability_explain"]);
      expect(messages.filter(message => message.role === "assistant").at(-1))
        .toMatchObject({text: expect.stringContaining("当前尚未提供业务动因及客户流失归因能力")});
    } finally { await host.close(); await store.close(); }
  });

  it("无需先读方法即可查询，重开会话并读取其他知识后仍可查询", async () => {
    const dir = tempDir();
    const skills = await loadBusinessSkills();
    const faux = createFauxModel([
      {kind: "toolCall", name: "metric_ask", args: {}},
      {kind: "toolCall", name: "business_skill_read", args: {name: "metric-query"}},
      {kind: "text", text: "正式结果：42元。"},
      {kind: "toolCall", name: "business_skill_read", args: {name: "data-coverage"}},
      {kind: "toolCall", name: "metric_ask", args: {}},
      {kind: "text", text: "正式结果：42元。"},
    ]);
    let calls = 0;
    const query: AgentHarnessTool<AskMetricRequestContext> = {
      name: "metric_ask", label: "查询", description: "合成查询", parameters: Type.Object({}),
      execute: async () => {
        calls++;
        return {content: [{type: "text", text: "已取数"}], details: {
          kind: "metric_ask", status: "succeeded", public_answer: "正式结果：42元。",
        }};
      },
    };
    const make = (store: NativeSessionStore) => new HarnessHost(testConfig(dir),
      () => ({models: faux.models, model: faux.model}), store,
      [query, createBusinessSkillReadTool(skills)], {skills});
    const firstStore = new NativeSessionStore(dir);
    const first = make(firstStore);
    const session = await first.createSession(ACTOR);
    await first.runPrompt(session, {protocol_version: 3, request_id: "missing-skill", message: "查余额"}, {actor: ACTOR, backend: {} as BackendClient});
    expect(calls).toBe(1);
    await first.close();
    await firstStore.close();
    const store = new NativeSessionStore(dir);
    const second = make(store);
    try {
      const restored = (await second.openSession(ACTOR, session.sessionId))!;
      await second.runPrompt(restored, {protocol_version: 3, request_id: "reuse-skill", message: "再查余额"}, {actor: ACTOR, backend: {} as BackendClient});
      expect(calls).toBe(2);
      expect(faux.providerCalls).toBe(6);
      const {projectEntries} = await import("../src/sessionProjection.js");
      const projected = projectEntries(await restored.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
      expect(projected.filter(message => message.role === "tool" && message.tool === "business_skill_read")).toHaveLength(2);
      expect(projected.filter(message => message.role === "assistant").at(-1)).toMatchObject({text: "正式结果：42元。"});
    } finally { await second.close(); await store.close(); }
  });

  it("Pi 的普通解释原样持久化，宿主不强制补查或插入第二条用户消息", async () => {
    const dir = tempDir();
    const answer = "2024年与2026年是不同统计期间；需要先明确时间口径。";
    const faux = createFauxModel([{kind: "toolCall", name: CONVERSATION_REPLY, args: {answer}}]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
    try {
      const session = await host.createSession(ACTOR);
      const result = await host.runPrompt(session, {protocol_version: 3, request_id: "explanation", message: "解释统计期间"}, {actor: ACTOR, backend: {} as BackendClient});
      const {projectEntries} = await import("../src/sessionProjection.js");
      const projected = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
      // 回答已在工具参数中完整给出：回执即结束本轮，不再为一次被原文替换的模型往返等待。
      expect(faux.providerCalls).toBe(1);
      expect(result).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
      expect(projected.filter(message => message.role === "user")).toHaveLength(1);
      expect(projected.filter(message => message.role === "tool").map(message => message.tool)).toEqual([CONVERSATION_REPLY]);
      expect(projected.at(-1)).toMatchObject({role: "assistant", text: answer, business_protocol: "frame_v1"});
      await host.closeSession(session.sessionId);
      const reopened = (await host.openSession(ACTOR, session.sessionId))!;
      expect(projectEntries(await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))).toEqual(projected);
    } finally {await host.close(); await store.close();}
  });
  it("新操作不激活回答交付及补救工具", async () => {
    const dir = tempDir();
    const faux = createFauxModel([{kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "请说明需要了解的业务口径。"}}]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
    try {
      const session = await host.createSession(ACTOR);
      await host.runPrompt(session, {protocol_version: 3, request_id: "active-tools", message: "你好"}, {actor: ACTOR, backend: {} as BackendClient});
      const active = await session.lane.getActiveTools(BACKGROUND_CONTEXT);
      expect(active).not.toContain("answer_present"); expect(active).not.toContain(EVIDENCE_REPAIR_TOOL);
      expect(faux.providerCalls).toBe(1);
      expect((faux.payloads[0] as {tools: Array<{function: {name: string}}>}).tools.map(tool => tool.function.name)).not.toContain(ACTION_REQUIRED);
    } finally {await host.close(); await store.close();}
  });
  it("读取计算知识后，取数成功仍继续计算", async () => {
    const dir = tempDir();
    const skills = await loadBusinessSkills();
    const faux = createFauxModel([
      {kind: "toolCall", name: "business_skill_read", args: {name: "result-calculation"}},
      {kind: "toolCall", name: "metric_query_structured", args: {}},
      {kind: "toolCall", name: "metric_calculate", args: {}},
      {kind: "text", text: "原值为10元和3元，受控计算差值7元。"},
    ]);
    const executed: string[] = [];
    const tool = (name: string, answer: string): AgentHarnessTool<AskMetricRequestContext> => ({
      name, label: name, description: "合成工具", parameters: Type.Object({}),
      execute: async () => {
        executed.push(name);
        return {content: [{type: "text", text: answer}], details: {kind: name, status: "succeeded", public_answer: answer}};
      },
    });
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), new NativeSessionStore(dir), [
      createBusinessSkillReadTool(skills),
      tool("metric_query_structured", "原值10元和3元。"),
      tool("metric_calculate", "差值7元。"),
    ], {skills});
    try {
      const session = await host.createSession(ACTOR);
      await host.runPrompt(session, {protocol_version: 3, request_id: "composed-skills", message: "查甲乙并求差"}, {actor: ACTOR, backend: {} as BackendClient});
      expect(executed).toEqual(["metric_query_structured", "metric_calculate"]);
      expect(faux.providerCalls).toBe(4);
      expect(entryTexts(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).at(-1)).toContain("差值7元");
    } finally { await host.close(); }
  });
});

describe("P1 原生最小闭环", () => {
  it("工具返回后继续原生模型循环并生成最终回答", async () => {
    const dir = tempDir();
    const faux = createFauxModel([
      { kind: "toolCall", name: "stub_lookup", args: {} },
      { kind: "text", text: "查询结果：数值为 42。" },
    ]);
    const toolCalls: string[] = [];
    const host = new HarnessHost(
      testConfig(dir),
      () => ({ models: faux.models, model: faux.model }),
      new NativeSessionStore(dir),
      [createStubTool(toolCalls)],
    );

    const hosted = await host.createSession(ACTOR);
    const outcome = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-1", message: "查一下测试数值" }, { actor: ACTOR, backend: {} as BackendClient });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcome.kind).toBe("settled");
    // 工具后确有第二次模型调用：第一次发起工具调用，第二次生成最终回答
    expect(faux.providerCalls).toBe(2);
    expect(toolCalls).toEqual(["user-1"]);

    const entries = await hosted.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    const texts = entryTexts(entries);
    expect(texts).toContain("查一下测试数值");
    expect(texts.some((text) => text.includes("42"))).toBe(true);
    await host.close();
  });

  it("会话重开后可从原生记录恢复历史", async () => {
    const dir = tempDir();
    const faux = createFauxModel([{ kind: "text", text: "你好，有什么可以帮你？" }]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(
      testConfig(dir),
      () => ({ models: faux.models, model: faux.model }),
      store,
      [],
    );
    const hosted = await host.createSession(ACTOR);
    const outcome = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-1", message: "你好" }, { actor: ACTOR, backend: {} as BackendClient });
    expect(outcome.ok).toBe(true);
    const sessionId = hosted.sessionId;
    await host.close();
    await store.close();

    // 模拟进程重启：全新 store 与 host 指向同一数据目录
    const store2 = new NativeSessionStore(dir);
    const host2 = new HarnessHost(
      testConfig(dir),
      () => ({ models: faux.models, model: faux.model }),
      store2,
      [],
    );
    const reopened = await host2.openSession(ACTOR, sessionId);
    expect(reopened).toBeDefined();
    const entries = await reopened!.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(entryTexts(entries)).toContain("你好");
    await host2.close();
    await store2.close();
  });

  it("达到阈值后出现原生 compaction 条目，无自建摘要", async () => {
    const dir = tempDir();
    // 窗口 1000，reserve 100：用量报 950 即越过阈值触发原生压缩
    const faux = createFauxModel(
      [
        { kind: "text", text: "第一轮回答", inputTokens: 950 },
        { kind: "text", text: "历史摘要：用户问过2026年3月末测试数值。", inputTokens: 100 },
        { kind: "text", text: "第二轮回答", inputTokens: 200 },
      ],
      1000,
    );
    const host = new HarnessHost(
      testConfig(dir, { enabled: true, reserveTokens: 100, keepRecentTokens: 50 }),
      () => ({ models: faux.models, model: faux.model }),
      new NativeSessionStore(dir),
      [],
    );
    const hosted = await host.createSession(ACTOR);
    const modes = captureStreamModes(hosted);
    const first = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-1", message: "第一轮问题" }, { actor: ACTOR, backend: {} as BackendClient });
    expect(first.ok).toBe(true);
    const second = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-2", message: "第二轮问题" }, { actor: ACTOR, backend: {} as BackendClient });
    expect(second.ok).toBe(true);

    const entries = await hosted.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    const compaction = entries.filter((entry) => entry.type === "compaction");
    expect(compaction.length).toBeGreaterThan(0);
    expect(compaction.some(entry => entry.summary.includes("2026年3月末"))).toBe(true);
    expect(modes.some(item => item.step === "compaction" && item.mode === "none")).toBe(true);
    expect(modes.filter(item => item.step === "assistant").every(item => item.mode === "text")).toBe(true);
    await host.close();
  });

  it("授权失效后 provider 边界 fail-closed：内部流实现零调用", async () => {
    const dir = tempDir();
    let innerCalls = 0;
    const faux = createFauxModel([{ kind: "text", text: "回答" }]);
    const counted: ProviderStreams = {
      stream: (model, context, options) => {
        innerCalls += 1;
        return faux.streams.stream(model, context, options);
      },
      streamSimple: (model, context, options) => {
        innerCalls += 1;
        return faux.streams.streamSimple(model, context, options);
      },
    };
    const host = new HarnessHost(
      testConfig(dir),
      (authorize) => {
        // 每个会话独立的授权包装：fail-closed 边界在 provider 层
        const models = createModels();
        models.setProvider(
          createProvider({
            id: "faux",
            name: "faux",
            auth: { apiKey: { name: "faux", resolve: async () => ({ auth: {} }) } },
            models: [faux.model],
            api: wrapStreamsWithAuthorization(counted, authorize),
          }),
        );
        return { models, model: faux.model };
      },
      new NativeSessionStore(dir),
      [],
      { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } },
    );
    const hosted = await host.createSession(ACTOR);
    const first = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-1", message: "第一问" }, { actor: ACTOR, backend: {} as BackendClient });
    expect(first.ok).toBe(true);
    expect(innerCalls).toBe(1);

    // 撤权后再次提问：provider 内部实现不得再被调用
    host.markContextAccessChanged(hosted.sessionId);
    const second = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-2", message: "第二问" }, { actor: ACTOR, backend: {} as BackendClient });
    expect(innerCalls).toBe(1);
    if (second.ok) {
      const outcome = second.outcome;
      const record = outcome.kind === "settled" ? outcome.outcome : undefined;
      expect(record?.status).not.toBe("completed");
    }
    await host.close();
  });

  it("重启后恢复未完成 operation：重开接管并补跑至完成", async () => {
    const dir = tempDir();
    const faux = createFauxModel([
      { kind: "toolCall", name: "stub_lookup", args: {} },
      { kind: "text", text: "恢复后的回答：42。" },
    ]);
    const toolCalls: string[] = [];
    const store1 = new NativeSessionStore(dir);
    const host1 = new HarnessHost(
      testConfig(dir),
      () => ({ models: faux.models, model: faux.model }),
      store1,
      [createStubTool(toolCalls)],
    );
    const hosted1 = await host1.createSession(ACTOR);
    // 只接纳不驱动，模拟进程在 accept 与 drive 之间崩溃
    const admitted = await host1.admitPrompt(
      hosted1,
      { protocol_version: 3, request_id: "req-crash", message: "查一下测试数值" },
      { actor: ACTOR, backend: {} as BackendClient },
    );
    expect(admitted.ok).toBe(true);
    await host1.close();
    await store1.close();

    // 重启：新宿主重开会话，恢复未完成操作
    const store2 = new NativeSessionStore(dir);
    const host2 = new HarnessHost(
      testConfig(dir),
      () => ({ models: faux.models, model: faux.model }),
      store2,
      [createStubTool(toolCalls)],
    );
    const hosted2 = await host2.openSession(ACTOR, hosted1.sessionId);
    expect(hosted2).toBeDefined();
    expect(hosted2!.open.length).toBeGreaterThan(0);
    const resumed = await host2.resumeOpenOperations(hosted2!, {
      actor: ACTOR,
      backend: {} as BackendClient,
    });
    expect(resumed).toBeGreaterThan(0);
    const entries = await hosted2!.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(entryTexts(entries).some((text) => text.includes("恢复后的回答：42"))).toBe(true);
    expect(toolCalls).toEqual(["user-1"]);
    await host2.close();
    await store2.close();
  });
});

describe("原生恢复及交付边界", () => {
  it("接纳后中断，原生重开恢复完整结构化输入", async () => {
    const dir=tempDir();
    const faux=createFauxModel([{kind:"toolCall",name:"capture",args:{}},{kind:"text",text:"完成"}]);
    const captured: AskMetricRequestContext[]=[];
    const tool: AgentHarnessTool<AskMetricRequestContext>={name:"capture",label:"capture",description:"capture",parameters:Type.Object({}),execute:async(_a,_b,_c,request)=>{captured.push(request);return {content:[{type:"text",text:"ok"}],details:{}};}};
    const make=()=>new HarnessHost(testConfig(dir),()=>({models:faux.models,model:faux.model}),new NativeSessionStore(dir),[tool]);
    const first=make(); const session=await first.createSession(ACTOR);
    const input={protocol_version:3 as const,request_id:"recover-card",message:"已选择机构",clarification_target:{task_id:"task",version:2,clarification_id:"cl"},selected_answers:{set:{orgs:["江阴"]}}};
    expect((await first.admitPrompt(session,input,{actor:ACTOR,backend:{} as BackendClient})).ok).toBe(true);
    await first.close();
    const second=make(); const restored=(await second.openSession(ACTOR,session.sessionId))!;
    expect(restored.open.length).toBeGreaterThan(0);
    expect((await restored.lane.inspectExecution(BACKGROUND_CONTEXT)).current).not.toBeNull();
    await second.resumeOpenOperations(restored,{actor:ACTOR,backend:{} as BackendClient});
    expect(captured[0]?.clarificationTarget).toEqual(input.clarification_target);
    expect(captured[0]?.selectedAnswers).toEqual(input.selected_answers);
    expect(captured[0]?.originalMessage).toBe(input.message);
    expect(restored.open).toHaveLength(0);
    await second.close();
  });
});


it("真实 pi 校验拒绝字符串历史引用，模型纠正后继续正常Frame流程", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: JSON.stringify({frameId: "source"}), fieldChanges: [], executionMode: "execute"}},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null, fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "exact"}], executionMode: "execute"}},
    {kind: "text", text: "请补充指标、机构和日期。"},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const outcome = await host.runPrompt(session, {protocol_version: 3, request_id: "reference-schema", message: "新建查询"}, {actor: ACTOR, backend: {} as BackendClient});
    expect(outcome.ok).toBe(true); expect(faux.providerCalls).toBe(2);
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames).toHaveLength(1); expect(frames[0]?.status).toBe("clarifying");
  } finally {await host.close(); await store.close();}
});

it("业务失败由 Pi 说明，运行完成不能冒充业务成功", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    { kind: "toolCall", name: "metric_ask", args: { action: "new" } },
    { kind: "text", text: "本次查询失败，未取得可核验结果。" },
  ]);
  const tool: AgentHarnessTool<AskMetricRequestContext> = {
    name: "metric_ask", label: "问数", description: "失败注入", parameters: Type.Object({action: Type.String()}),
    execute: async () => ({ content: [{type: "text", text: "查询失败"}],
      details: {kind: "metric_ask", task_id: "failed-task", status: "error", error_code: "INTERNAL_SERVER_ERROR"} }),
  };
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), new NativeSessionStore(dir), [tool]);
  const session = await host.createSession(ACTOR);
  const outcome = await host.runPrompt(session, {protocol_version: 3, request_id: "failure-injection", message: "那江阴呢？"}, {actor: ACTOR, backend: {} as BackendClient});
  expect(outcome.ok).toBe(true);
  expect(faux.providerCalls).toBe(2);
  const { projectEntries, projectBusinessTasks } = await import("../src/sessionProjection.js");
  const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(JSON.stringify(messages)).not.toContain("15147420074");
  expect(projectBusinessTasks(messages)[0]?.status).toBe("error");
  expect(messages.some(message => message.role === "assistant" && message.text.includes("未取得可核验"))).toBe(true);
  await host.close();
});

it("连续两次历史引用冲突后停止，不能交付模型猜测事实", async () => {
  const dir = tempDir();
  const args = {kind: "result", task_id: "wrong", result_id: "result:wrong"};
  const faux = createFauxModel([
    {kind: "toolCall", name: "metric_read", args},
    {kind: "toolCall", name: "metric_read", args},
    {kind: "text", text: "乙行金额987654321元。"},
  ]);
  let reads = 0;
  const backend = {getTaskResult: async () => {
    reads++;
    throw new BackendApiError(409, "机构冲突", "RESULT_REFERENCE_CONFLICT");
  }} as unknown as BackendClient;
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}),
    new NativeSessionStore(dir), [createMetricReadTool()]);
  const session = await host.createSession(ACTOR);
  const outcome = await host.runPrompt(session, {
    protocol_version: 3, request_id: "read-conflict", message: "刚才乙行的数据再显示",
  }, {actor: ACTOR, backend});
  expect(outcome.ok).toBe(true);
  expect(reads).toBe(2);
  expect(faux.providerCalls).toBe(3);
  const {projectEntries} = await import("../src/sessionProjection.js");
  const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(JSON.stringify(messages)).not.toContain("987654321");
  expect(messages.some(message => message.role === "assistant" && /未(?:能)?通过校验/.test(message.text))).toBe(true);
  await host.close();
});

it("原生上下文投影保留完整会话，宿主不静默替换模型选定的合法历史来源", async () => {
  const dir=tempDir();
  const faux=createFauxModel([
    {kind:"toolCall",name:"metric_ask",args:{action:"new"}},
    {kind:"text",text:"查询完成"},
    {kind:"toolCall",name:"metric_read",args:{}},
    {kind:"text",text:"查询完成"},
    {kind:"toolCall",name:"metric_ask",args:{action:"followup",source:{task_id:"old",version:3},change_field:"orgs"}},
    {kind:"text",text:"查询完成"},
  ]);
  const captured:unknown[]=[];
  function tool(name:string):AgentHarnessTool<AskMetricRequestContext> {
    return {name,label:name,description:"受控测试回执",parameters:Type.Object({
      action:Type.Optional(Type.String()),source:Type.Optional(Type.Object({task_id:Type.String(),version:Type.Integer()})),change_field:Type.Optional(Type.String()),
    }),execute:async(_id,args)=>{
      captured.push(args);
      const task=name==="metric_read"?"latest":"old";
      const date=name==="metric_read"?"2026-04-30":"2026-03-31";
      return {content:[{type:"text",text:JSON.stringify({task_id:task,result_id:`r:${task}`,version:3,status:"succeeded",row_count:20,
        rows:Array.from({length:20},(_,i)=>({metric_value:`private-row-${i}`})),
        query_evidence:{logical_dsl:{time:{start:date,end:date},metrics:["M"],orgs:["O"]}},
      })}],details:{kind:name,task_id:task,result_id:`r:${task}`,status:"succeeded",row_count:20,public_answer:"查询完成"}};
    }};
  }
  const host=new HarnessHost(testConfig(dir),()=>({models:faux.models,model:faux.model}),new NativeSessionStore(dir),[tool("metric_ask"),tool("metric_read")]);
  const session=await host.createSession(ACTOR);
  for(const [i,message] of ["甲行3月末余额","读取乙行4月末已完成结果","再看甲行"].entries()) {
    await host.runPrompt(session,{protocol_version:3,request_id:`projection-${i}`,message},{actor:ACTOR,backend:{} as BackendClient});
  }
  expect(faux.providerCalls).toBe(6);
  expect(captured[2]).toMatchObject({source:{task_id:"old",version:3},change_field:"orgs"});
  expect(JSON.stringify(faux.contexts[4])).not.toContain("private-row-");
  const original=await session.lane.findEntries({order:"oldestFirst"},BACKGROUND_CONTEXT);
  expect(entryTexts(original).join("\n")).toContain("private-row-19");
  await host.close();
});

it("宿主不因目录读取和历史查询而擅自替模型改写来源", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "synthetic_query", args: {action: "new"}}, {kind: "text", text: "查询完成"},
    {kind: "toolCall", name: "organization_search", args: {}},
    {kind: "toolCall", name: "synthetic_query", args: {action: "new"}}, {kind: "text", text: "查询完成"},
  ]);
  const submissions: unknown[] = [];
  const query: AgentHarnessTool<AskMetricRequestContext> = {name: "synthetic_query", label: "合成查询", description: "核对宿主不改写参数",
    parameters: Type.Object({action: Type.String()}), execute: async (_id, args) => {
      submissions.push(args);
      return {content: [{type: "text", text: "合成查询完成"}], details: {kind: "metric_query_structured", status: "succeeded", task_id: `t${submissions.length}`, row_count: 0}};
    }};
  const directory: AgentHarnessTool<AskMetricRequestContext> = {name: "organization_search", label: "目录", description: "机构目录", parameters: Type.Object({}),
    execute: async () => ({content: [{type: "text", text: '{"items":[{"code":"B","name":"虚构乙机构"}]}'}], details: {kind: "organization_search", status: "ok"}})};
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, [query, directory]);
  const session = await host.createSession(ACTOR);
  await host.runPrompt(session, {protocol_version: 3, request_id: "prime-candidate", message: "虚构甲机构2026年3月演示指标甲"}, {actor: ACTOR, backend: {} as BackendClient});
  await host.close(); await store.close();
  const restoredStore = new NativeSessionStore(dir);
  const restored = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), restoredStore, [query, directory]);
  try {
    const reopened = await restored.openSession(ACTOR, session.sessionId);
    const result = await restored.runPrompt(reopened!, {protocol_version: 3, request_id: "next-candidate", message: "乙机构四月份的呢？"}, {actor: ACTOR, backend: {} as BackendClient});
    expect(result.ok).toBe(true); expect(submissions).toEqual([{action: "new"}, {action: "new"}]); expect(faux.providerCalls).toBe(5);
  } finally {await restored.close(); await restoredStore.close();}
});

it("新链路拒绝旧澄清入口，缺项仍通过 Frame 保存并由 Pi 提问", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "metric_ask", args: {action: "clarify", target: {task_id: "failed", version: 0, clarification_id: "invented"}}},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "exact"}]}},
    {kind: "text", text: "请补充指标、机构和日期。"},
  ]);
  const submitClarification = vi.fn(); const basicQueries = vi.fn();
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "missing", message: "查一下"}, {actor: ACTOR, backend: {submitClarification, basicQueries} as unknown as BackendClient});
    expect(submitClarification).not.toHaveBeenCalled(); expect(basicQueries).not.toHaveBeenCalled();
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames).toHaveLength(1); expect(frames[0]?.status).toBe("clarifying");
    expect(faux.providerCalls).toBe(2);
  } finally {await host.close(); await store.close();}
});
it("原生组合：取数后继续计算，最终和历史保留计算证据而非中间答案", async () => {
  const dir=tempDir();
  const faux=createFauxModel([
    {kind:"toolCall",name:"metric_query_structured",args:{}},
    {kind:"toolCall",name:"metric_calculate",args:{}},
    {kind:"text",text:"甲10元，乙3元；受控计算甲减乙：7元。"},
  ]);
  const tool=(name:string,details:object):AgentHarnessTool<AskMetricRequestContext> => ({name,label:name,description:"合成测试",parameters:Type.Object({}),
    execute:async()=>({content:[{type:"text",text:JSON.stringify(details)}],details})});
  const host=new HarnessHost(testConfig(dir),()=>({models:faux.models,model:faux.model}),new NativeSessionStore(dir),[
    tool("metric_query_structured",{kind:"metric_query_structured",status:"succeeded",task_id:"t",result_id:"r",public_answer:"甲10元，乙3元。"}),
    tool("metric_calculate",{kind:"metric_calculate",status:"succeeded",task_id:"t",calculation_id:"calc",public_answer:"甲减乙：7元。"}),
  ]);
  try {
    const session=await host.createSession(ACTOR);
    await host.runPrompt(session,{protocol_version:3,request_id:"composed",message:"查甲乙并求差"},{actor:ACTOR,backend:{} as BackendClient});
    expect(faux.providerCalls).toBe(3);
    const {projectEntries}=await import("../src/sessionProjection.js");
    const projected=projectEntries(await session.lane.findEntries({order:"oldestFirst"},BACKGROUND_CONTEXT));
    const answer=projected.filter(m=>m.role==="assistant").at(-1);
    expect(answer && "text" in answer ? answer.text : "").toContain("甲减乙：7元");
    // 只检查交付正文，随机 entry_id 可能恰好含 999，不能作为业务金额断言。
    expect(projected.filter(message => message.role === "assistant")
      .map(message => "text" in message ? message.text : "").join("\n")).not.toContain("999");
  } finally {await host.close();}
});

it("覆盖回执经历原生压缩和重开后仍投影完整范围与分页", async () => {
  const dir=tempDir();
  const faux=createFauxModel([
    {kind:"toolCall",name:"data_availability",args:{}},
    {kind:"text",text:"覆盖查询完成。",inputTokens:950},
    {kind:"text",text:"历史只记得用户查询过覆盖。",inputTokens:100},
    {kind:"text",text:"请确认要选择的指标。",inputTokens:200},
  ],1000);
  const receipt={status:"succeeded",request:{dimension:"metrics",org_codes:["O"],start:"2020-01-01",end:"2026-09-21"},
    org_names:["测试行"],items:[{metric_code:"M",metric_name:"余额"}],page:2,page_size:5,has_more:true};
  const tool:AgentHarnessTool<AskMetricRequestContext>={name:"data_availability",label:"覆盖",description:"测试",parameters:Type.Object({}),
    execute:async()=>({content:[{type:"text",text:JSON.stringify(receipt)}],details:{kind:"data_availability",...receipt,public_answer:"覆盖查询完成。"}})};
  const config=testConfig(dir,{enabled:true,reserveTokens:100,keepRecentTokens:50});
  const store=new NativeSessionStore(dir);
  const host=new HarnessHost(config,()=>({models:faux.models,model:faux.model}),store,[tool]);
  const session=await host.createSession(ACTOR);
  await host.runPrompt(session,{protocol_version:3,request_id:"coverage-before",message:"查覆盖"},{actor:ACTOR,backend:{} as BackendClient});
  await host.close(); await store.close();
  const reopenedStore=new NativeSessionStore(dir);
  const reopenedHost=new HarnessHost(config,()=>({models:faux.models,model:faux.model}),reopenedStore,[tool]);
  try {
    const reopened=(await reopenedHost.openSession(ACTOR,session.sessionId))!;
    await reopenedHost.runPrompt(reopened,{protocol_version:3,request_id:"coverage-after",message:"选择余额"},{actor:ACTOR,backend:{} as BackendClient});
    expect((await reopened.lane.findEntries({},BACKGROUND_CONTEXT)).some(entry=>entry.type==="compaction")).toBe(true);
    // 轮状态数据只随发送副本注入；系统提示词（含压缩摘要的独立提示词）任何一次调用都不携带请求状态。
    for (const captured of faux.contexts as Array<{systemPrompt:string}>) {
      expect(captured.systemPrompt).not.toContain("当前业务焦点（仅数据）");
      expect(captured.systemPrompt).not.toContain("历史条件索引（仅数据");
      expect(captured.systemPrompt).not.toContain("本轮指标算法匹配（仅数据");
    }
    const context=faux.contexts.at(-1) as {systemPrompt:string; messages:Array<{role:string; content:unknown}>};
    expect(context.systemPrompt).toContain("业务能力职责与限制（仅数据）");
    const sentUser=[...context.messages].reverse().find(message=>message.role==="user") as {content:unknown};
    expect(JSON.stringify(sentUser.content)).toContain("当前业务焦点（仅数据）");
    const {coverageContext} = await import("../src/queryContext.js");
    const entries = await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const projection = coverageContext(entries.filter(entry => entry.type === "message").map(entry => entry.message));
    for (const value of ["2020-01-01", "2026-09-21", '\"metric_code\":\"M\"', '\"page\":2', '\"has_more\":true']) expect(projection).toContain(value);
  } finally {await reopenedHost.close();await reopenedStore.close();}
});

it("轮状态块只随发送副本附在本轮用户消息后，系统提示词跨调用逐字稳定且不落盘", async () => {
  const dir=tempDir();
  const faux=createFauxModel([
    {kind:"toolCall",name:"data_availability",args:{}},
    {kind:"text",text:"第一轮查询完成。",inputTokens:950},
    {kind:"text",text:"第二轮回答。"},
  ]);
  const receipt={status:"succeeded",request:{dimension:"metrics",org_codes:["O"],start:"2020-01-01",end:"2026-09-21"},
    org_names:["测试行"],items:[{metric_code:"M",metric_name:"余额"}],page:1,page_size:5,has_more:false};
  const tool:AgentHarnessTool<AskMetricRequestContext>={name:"data_availability",label:"覆盖",description:"测试",parameters:Type.Object({}),
    execute:async()=>({content:[{type:"text",text:JSON.stringify(receipt)}],details:{kind:"data_availability",...receipt,public_answer:"第一轮查询完成。"}})};
  const base=testConfig(dir,{enabled:true,reserveTokens:100,keepRecentTokens:50});
  const config={...base,model:{...base.model,userMessageSuffix:"\n/no_think"}};
  const store=new NativeSessionStore(dir);
  const host=new HarnessHost(config,()=>({models:faux.models,model:faux.model}),store,[tool]);
  try {
    const session=await host.createSession(ACTOR);
    await host.runPrompt(session,{protocol_version:3,request_id:"turn-state-1",message:"查覆盖"},{actor:ACTOR,backend:{} as BackendClient});
    await host.runPrompt(session,{protocol_version:3,request_id:"turn-state-2",message:"再查一次"},{actor:ACTOR,backend:{} as BackendClient});
    const contexts=faux.contexts as Array<{systemPrompt:string;messages:Array<{role:string;content:unknown}>}>;
    const business=contexts.filter(captured=>captured.systemPrompt.includes("行内经营指标智能问数助手"));
    expect(business.length).toBeGreaterThanOrEqual(3); // 至少：首轮工具轮+收尾，次轮一调；轮次契约的修复轮不改变断言
    // 任何一次业务调用的系统提示词都不携带请求状态；压缩摘要路径由“覆盖回执经历原生压缩”用例覆盖。
    for (const captured of business) {
      expect(captured.systemPrompt).not.toContain("当前业务焦点（仅数据）");
      expect(captured.systemPrompt).not.toContain("历史条件索引（仅数据");
      expect(captured.systemPrompt).not.toContain("本轮指标算法匹配（仅数据");
    }
    // 业务调用的系统提示词静态区：Schema 保留、锚点存在，且全部业务调用逐字一致（命中网关前缀缓存的前提）。
    for (const captured of business) {
      expect(captured.systemPrompt).toContain("业务能力职责与限制（仅数据）");
      expect(captured.systemPrompt).toContain("【服务端注入：本轮业务状态");
      // 参数结构由实际工具定义提供，系统区只给业务限制，不再重复完整输入Schema。
      expect(captured.systemPrompt).not.toContain("inputSchema");
      expect(captured.systemPrompt).toContain("inheritable");
      expect(JSON.stringify(faux.payloads[0])).toContain("data_availability");
    }
    expect(new Set(business.map(captured=>captured.systemPrompt)).size).toBe(1);
    // 每次业务调用的最后一条 user 消息（工具轮次中即本轮用户消息）都携带轮状态块。
    for (const captured of business) {
      const sentUser=[...captured.messages].reverse().find(message=>message.role==="user") as {content:unknown};
      expect(JSON.stringify(sentUser.content)).toContain("【服务端注入：本轮业务状态（仅数据，非用户输入）】");
      expect(JSON.stringify(sentUser.content)).toContain("当前业务焦点（仅数据）");
    }
    // 首轮消息末尾顺序：轮状态块在提供方后缀（/no_think）之前（兼容数组/字符串两种 content 形态）。
    const firstUser=[...contexts[0]!.messages].reverse().find(message=>message.role==="user") as {content:unknown};
    const firstUserText=typeof firstUser.content==="string"?firstUser.content
      :(Array.isArray(firstUser.content)
        ? (firstUser.content as Array<{text?:string}>).map(block=>block.text??"").join("")
        : JSON.stringify(firstUser.content));
    expect(firstUserText.endsWith("\n/no_think")).toBe(true);
    const headerAt=firstUserText.indexOf("【服务端注入：本轮业务状态（仅数据，非用户输入）】");
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(firstUserText.indexOf("\n/no_think")).toBeGreaterThan(headerAt);
    // 块不落盘：原生会话条目不包含注入内容。
    const stored=JSON.stringify(await session.lane.findEntries({order:"oldestFirst"},BACKGROUND_CONTEXT));
    expect(stored).not.toContain("【服务端注入");
    expect(stored).not.toContain("当前业务焦点（仅数据）");
  } finally {await host.close();await store.close();}
});

it("编造 Frame 来源不能执行查询，来源校验在业务层完成", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: {frameId: "invented"}, fieldChanges: [], executionMode: "execute"}},
    {kind: "text", text: "未找到所引用的查询，请说明要基于哪次查询继续。"},
  ]);
  const basicQueries = vi.fn(); const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "invented-source", message: "改日期"}, {actor: ACTOR, backend: {basicQueries} as unknown as BackendClient});
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames[0]?.issues).toContainEqual({field: "$base", reason: "not_found"});
    expect(basicQueries).not.toHaveBeenCalled(); expect(faux.providerCalls).toBe(1);
  } finally {await host.close(); await store.close();}
});

it("模型429保持原生失败，不能注入无证据修复工具或伪装成功", async () => {
  const dir=tempDir();
  const faux=createFauxModel([{kind:"error",message:"429 status code (no body)"}]);
  const store=new NativeSessionStore(dir);
  const host=new HarnessHost(testConfig(dir),()=>({models:faux.models,model:faux.model}),store,createAskMetricTools(),{retry:{enabled:false,maxRetries:0,baseDelayMs:1}});
  try {
    const session=await host.createSession(ACTOR);
    const outcome=await host.runPrompt(session,{protocol_version:3,request_id:"rate-limit",message:"查询余额"},{actor:ACTOR,backend:{} as BackendClient});
    expect(outcome.ok).toBe(true);
    const entries=await session.lane.findEntries({},BACKGROUND_CONTEXT);
    const messages=entries.filter(entry=>entry.type==="message").map(entry=>entry.message);
    expect(messages.some(message=>message.role==="assistant" && message.stopReason==="error")).toBe(true);
    expect(messages.some(message=>message.role==="toolResult")).toBe(false);
    expect(messages.some(message=>message.role==="assistant" && message.content.some(block=>block.type==="toolCall" && block.name===EVIDENCE_REPAIR_TOOL))).toBe(false);
    if (outcome.ok && outcome.outcome.kind==="settled") expect(outcome.outcome.outcome.status).toBe("failed");
  } finally {await host.close();await store.close();}
});

it("旧覆盖工具不能绕过 Frame，目录返回编码也不能解除门禁", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "data_availability", args: {dimension: "metrics", org_codes: ["invented"]}},
    {kind: "toolCall", name: "catalog", args: {action: "search", queries: [{entity: "organization", keyword: "合成机构"}]}},
    {kind: "toolCall", name: "data_availability", args: {dimension: "metrics", org_codes: ["O"]}},
    {kind: "text", text: "需要先解析并确认查询条件。"},
  ]);
  const dataAvailability = vi.fn(); const searchOrganizations = vi.fn(async () => ({total: 1, items: [{org_code: "O", org_name: "合成机构", match_type: "exact"}]}));
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "no-bypass", message: "合成机构有哪些指标"}, {actor: ACTOR, backend: {dataAvailability, searchOrganizations} as unknown as BackendClient});
    expect(dataAvailability).not.toHaveBeenCalled(); expect(searchOrganizations).toHaveBeenCalledTimes(1);
    expect(faux.providerCalls).toBe(4);
  } finally {await host.close(); await store.close();}
});

it("未确认的编码不能结构化取值，缺日期仍可直接提交正式澄清", async()=>{
  const dir=tempDir();
  const skills=await loadBusinessSkills();
  const faux=createFauxModel([
    {kind:"toolCall",name:"business_skill_read",args:{name:"data-coverage"}},
    {kind:"toolCall",name:"metric_query_structured",args:{metric_codes:["M"],org_codes:["O"],start:"2026-09-21",end:"2026-09-21",selection:"exact"}},
    {kind:"toolCall",name:"business_skill_read",args:{name:"metric-query"}},
    {kind:"toolCall",name:"resolve_business_turn",args:{capabilityHint:"metric_query",baseReference:null,executionMode:"execute",fieldChanges:[
      {fieldHint:"metrics",operation:"set",rawValue:"贷款余额当日数"},{fieldHint:"organizations",operation:"set",rawValue:"省联社"},{fieldHint:"selection",operation:"set",rawValue:"exact"}]}},
    {kind:"text",text:"请补充日期？"},
  ]);
  const submitQuestion=vi.fn(async()=>({task_id:"missing-date",conversation_id:"c",status:"WAITING_USER",version:1,clarification:{id:"date",prompt:"请补充日期"}}));
  const basicQueries=vi.fn();
  const store=new NativeSessionStore(dir);
  const host=new HarnessHost(testConfig(dir),()=>({models:faux.models,model:faux.model}),store,[...createAskMetricTools(),createBusinessSkillReadTool(skills)],{skills});
  try {
    const session=await host.createSession(ACTOR);
    await host.runPrompt(session,{protocol_version:3,request_id:"no-coverage",message:"查询省联社贷款余额当日数"},{actor:ACTOR,backend:fixtureMetricBackend({submitQuestion,basicQueries,resolveBusinessField:async (_entity: string, names: string[])=>({status:"resolved",value:{codes:names,names}})} as unknown as BackendClient,["贷款余额当日数"])});
    expect(basicQueries).not.toHaveBeenCalled();
    expect(submitQuestion).not.toHaveBeenCalled();
    const entries=await session.lane.findEntries({order: "oldestFirst"},BACKGROUND_CONTEXT);
    const {projectEntries} = await import("../src/sessionProjection.js");
    expect(projectEntries(entries).at(-1)).toMatchObject({role: "assistant", text: "请补充日期范围。"});
  } finally {await host.close();await store.close();}
});

it("连续成功工具达到预算后交付明确未完成正文，重开仍可见且不执行额外调用", async () => {
  const dir = tempDir();
  const faux = createFauxModel([{kind: "toolCall", name: "stub_lookup", args: {}}]);
  const toolCalls: string[] = [];
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, [createStubTool(toolCalls)]);
  const session = await host.createSession(ACTOR);
  const outcome = await host.runPrompt(session, {protocol_version: 3, request_id: "limit", message: "查询指标"}, {actor: ACTOR, backend: {} as BackendClient});
  expect(outcome.ok).toBe(true);
  expect(toolCalls).toHaveLength(24);
  const {projectEntries} = await import("../src/sessionProjection.js");
  const before = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(before.at(-1)).toMatchObject({role: "assistant", tools: []});
  expect(JSON.stringify(before.at(-1))).toContain("已达到工具调用限额");
  const id = session.sessionId;
  await host.close();
  await store.close();
  const reopenedStore = new NativeSessionStore(dir);
  const reopenedHost = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), reopenedStore, []);
  const reopened = await reopenedHost.openSession(ACTOR, id);
  expect(projectEntries(await reopened!.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))).toEqual(before);
  await reopenedHost.close();
  await reopenedStore.close();
});


it("Pi 同轮纠正非法枚举与截短名称，宿主不锁入澄清且只执行一次", async () => {
  const dir = tempDir();
  const query = (corrected: boolean): FauxReply => ({kind: "toolCall", name: "resolve_business_turn", args: {
    capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: corrected ? "合成余额本期数" : "合成余额"},
      {fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
      {fieldHint: "time", operation: "set", rawValue: "2026年5月18日"},
      {fieldHint: "selection", operation: "set", rawValue: corrected ? "exact" : "本期数"},
    ],
  }});
  const faux = createFauxModel([query(false), query(true),
    {kind: "toolCall", name: "execute_business_frame", args: {frameId: "__LATEST_FRAME__"}},
    {kind: "text", text: "合成查询无记录。"},
  ]);
  const basicQueries = vi.fn(async (_spec: unknown) => ({result: {task_id: "synthetic-task", status: "succeeded", rows: [], columns: [], row_count: 0}}));
  const backend = {
    resolveBusinessField: async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date"
      ? {start: "2026-05-18", end: "2026-05-18"} : {codes: [entity === "organization" ? "O" : names[0] === "合成余额本期数" ? "FULL" : "SHORT"], names}}),
    createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}), basicQueries,
    getTask: async () => ({task_id: "synthetic-task", status: "SUCCEEDED", version: 1, result: {result_id: "synthetic-result"}}),
  } as unknown as BackendClient;
  fixtureMetricBackend(backend, ["合成余额本期数"]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "enum-correction", message: "查合成机构2026年5月18日合成余额本期数"}, {actor: ACTOR, backend});
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames.map(frame => frame.status)).toEqual(["ready", "executing", "success"]);
    expect(frames.at(-1)?.fields.metrics?.rawValue).toEqual(["合成余额本期数"]);
    expect(basicQueries).toHaveBeenCalledTimes(1);
    expect(basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["FULL"], selection: "exact"});
    expect(faux.providerCalls).toBe(4);
    expect(faux.payloads.slice(0, 3).every(payload => (payload as {tool_choice?: string}).tool_choice !== "none")).toBe(true);
    expect(JSON.stringify((faux.contexts[1] as {messages: unknown[]}).messages)).toContain("FIXED_TURN_ARGUMENTS_INVALID");
    // 就地执行后回执换成查询结果，仍保留解析出的条件供页面执行过程展示；条件不进入模型上下文。
    const {projectEntries} = await import("../src/sessionProjection.js");
    const resolves = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
      .flatMap(message => message.role === "tool" && message.tool === "resolve_business_turn" ? [message.details] : []);
    const firstNativeResult = (await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))
      .flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [])[0];
    expect(firstNativeResult).toMatchObject({isError: true});
    expect(firstNativeResult?.details).toBeUndefined();
    expect(resolves.at(-1)).toMatchObject({display_conditions: [
      {label: "指标", value: "合成余额本期数"}, {label: "机构", value: "合成机构"}, {label: "日期", value: "2026-05-18"},
    ]});
    expect(JSON.stringify(faux.payloads)).not.toContain("display_conditions");
  } finally {await host.close(); await store.close();}
});

it("目录短别名不能改写完整原文指标，重复解析只执行正确目标一次且重开保留结果", async () => {
  const dir = tempDir();
  const query = (code: string): FauxReply => ({kind: "toolCall", name: "resolve_business_turn", args: {
    capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: code === "TOTAL" ? "贷款余额" : "贷款余额当日数"},
      {fieldHint: "organizations", operation: "set", rawValue: "演示行"}, {fieldHint: "time", operation: "set", rawValue: "2026年3月31日"},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ],
  }});
  const faux = createFauxModel([
    {kind: "toolCall", name: "catalog", args: {action: "search", queries: [
      {entity: "metric", keyword: "贷款余额"}, {entity: "organization", keyword: "演示行"},
    ]}},
    query("TOTAL"),
    {kind: "toolCall", name: "execute_business_frame", args: {frameId: "__LATEST_FRAME__"}},
    {kind: "toolCall", name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "贷款余额当日数"}]}},
    query("EXPLICIT"),
    {kind: "toolCall", name: "execute_business_frame", args: {frameId: "__LATEST_FRAME__"}},
    {kind: "toolCall", name: "data_availability", args: {dimension: "metrics", org_codes: ["O"], start: "2026-03-31", end: "2026-03-31"}},
    {kind: "text", text: "演示行贷款余额当日数为1.123456元。"},
  ]);
  const queries: unknown[] = [];
  const backend = {
    resolveBusinessField: async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date" ? {start: "2026-03-31", end: "2026-03-31"} : {codes: [entity === "organization" ? "O" : names[0] === "贷款余额" ? "TOTAL" : "DAILY"], names}}),
    searchMetrics: async (keyword: string) => ({total: 1, items: [{metric_code: keyword === "贷款余额" ? "TOTAL" : "EXPLICIT",
      metric_name: keyword === "贷款余额" ? "各项贷款余额当日数" : "贷款余额当日数", match_type: "exact"}]}),
    searchOrganizations: async () => ({total: 1, items: [{org_code: "O", org_name: "演示行", match_type: "exact"}]}),
    createAgentQueryContext: async () => ({conversation_id: "c"}),
    basicQueries: async (spec: {metric_codes: string[]}) => {
      queries.push(spec);
      if (spec.metric_codes[0] === "TOTAL") throw new BackendApiError(422, "原文完整指标贷款余额当日数与短别名冲突，请重新核对。", "QUERY_METRIC_REFERENCE_CONFLICT");
      return {result: {task_id: "t", status: "succeeded", rows: [], columns: [], row_count: 1, message: "演示行贷款余额当日数为1.123456元。"}};
    },
    getTask: async () => ({task_id: "t", status: "SUCCEEDED", version: 3, result: {result_id: "r"}}),
    dataAvailability: async (request: unknown) => ({status: "succeeded", mode: "metrics", request, org_names: ["演示行"],
      metric_count: 4830, items: [{metric_name: "其他指标"}], page: 1, has_more: true, notice: "合成覆盖目录"}),
  } as unknown as BackendClient;
  fixtureMetricBackend(backend, ["贷款余额当日数"]);
  const store = new NativeSessionStore(dir);
  const makeHost = () => new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  const host = makeHost();
  const session = await host.createSession(ACTOR);
  const {projectEntries} = await import("../src/sessionProjection.js");
  try {
    await host.runPrompt(session, {protocol_version: 3, request_id: "collision", message: "演示行2026年3月31日贷款余额当日数"}, {actor: ACTOR, backend});
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({metric_codes: ["DAILY"]});
    expect(queries[0]).toMatchObject({calculation_context: {user_question: "演示行2026年3月31日贷款余额当日数"}});
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const projected = projectEntries(entries);
    expect(projected.at(-1)).toMatchObject({role: "assistant", text: "演示行贷款余额当日数为1.123456元。"});
    expect(projected.some(m => m.role === "tool" && [EVIDENCE_REPAIR_TOOL, "answer_present"].includes(m.tool))).toBe(false);
    expect(faux.providerCalls).toBe(8);
    // 固定入口不接收改写指标名，两个查询提案引用同一完整原文；额外执行沿用同一幂等结果。
    expect(faux.payloads[0]).toMatchObject({tool_choice: "required"});
    for (const payload of faux.payloads.slice(1)) expect(payload).not.toHaveProperty("tool_choice");
    expect(projected.filter(m => m.role === "assistant").some(m => m.text.includes("4830"))).toBe(false);
    await host.close();
    const reopenedHost = makeHost();
    try {
      const reopened = (await reopenedHost.openSession(ACTOR, session.sessionId))!;
      expect(projectEntries(await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))).toEqual(projected);
    } finally { await reopenedHost.close(); }
  } finally { await host.close(); await store.close(); }
});

it("旧活跃操作可恢复原目录调用，完成后新请求只暴露合并工具", async () => {
  const dir = tempDir();
  const {legacyToolsFor} = await import("../src/tools/index.js");
  const currentTools = createAskMetricTools();
  const oldTools = [...currentTools.filter(tool => !["catalog", "read"].includes(tool.name)), ...legacyToolsFor(currentTools)];
  const faux = createFauxModel([
    {kind: "toolCall", name: "metric_catalog_search", args: {keyword: "演示余额"}},
    {kind: "text", text: "目录检索完成"},
    {kind: "toolCall", name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "演示余额"}]}},
    {kind: "text", text: "目录检索完成"},
  ]);
  const searchMetrics = vi.fn(async () => ({total: 1, items: [{metric_code: "M", match_type: "exact"}]}));
  const backend = {searchMetrics} as unknown as BackendClient;
  const store1 = new NativeSessionStore(dir);
  const host1 = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store1, oldTools);
  const session1 = await host1.createSession(ACTOR);
  await host1.admitPrompt(session1, {protocol_version: 3, request_id: "legacy-pending", message: "查询目录"}, {actor: ACTOR, backend});
  await host1.close(); await store1.close();
  const store2 = new NativeSessionStore(dir);
  const host2 = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store2, currentTools);
  try {
    const session2 = (await host2.openSession(ACTOR, session1.sessionId))!;
    await host2.resumeOpenOperations(session2, {actor: ACTOR, backend});
    expect(searchMetrics).toHaveBeenCalledTimes(1);
    await host2.runPrompt(session2, {protocol_version: 3, request_id: "merged-next", message: "再查看目录"}, {actor: ACTOR, backend});
    expect(searchMetrics).toHaveBeenCalledTimes(2);
    const tools = (faux.payloads.at(-1) as {tools: Array<{function: {name: string}}>}).tools.map(tool => tool.function.name);
    expect(tools.sort()).toEqual(currentTools.map(tool => tool.name).filter(name => ![ACTION_REQUIRED, CONVERSATION_REPLY].includes(name)).sort());
  } finally {await host2.close(); await store2.close();}
});

it("待确认只生成澄清，模型忽略 tool_choice 也不能重复检索", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: "合成指标"}, {fieldHint: "organizations", operation: "set", rawValue: "合成简称"},
      {fieldHint: "time", operation: "set", rawValue: "2026年2月末"}, {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ]}},
    {kind: "toolCall", name: "catalog", args: {action: "search", queries: [{entity: "organization", keyword: "合成全称"}]}},
    {kind: "text", text: "请确认机构是否为合成全称？指标及日期已确定。"},
  ]);
  const searchOrganizations = vi.fn();
  const basicQueries = vi.fn();
  const backend = {searchOrganizations, basicQueries, resolveBusinessField: async (entity: string, raw: string[]) =>
    entity === "organization" ? {status: "needs_confirmation", candidates: [{value: "合成全称", code: "O"}]}
      : {status: "resolved", value: entity === "date" ? {start: "2026-02-28", end: "2026-02-28"} : {codes: ["M"], names: raw}}} as unknown as BackendClient;
  fixtureMetricBackend(backend, ["合成指标"]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const modes = captureStreamModes(session);
    await host.runPrompt(session, {protocol_version: 3, request_id: "wait-user", message: "合成简称 合成指标 2026年2月末"}, {actor: ACTOR, backend});
    expect(faux.providerCalls).toBe(1);
    expect(modes.map(item => item.mode)).toEqual(["reply"]);
    expect(searchOrganizations).not.toHaveBeenCalled(); expect(basicQueries).not.toHaveBeenCalled();
    const {projectEntries} = await import("../src/sessionProjection.js");
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const messages = projectEntries(entries);
    const last = messages.at(-1);
    expect(last?.role === "assistant" && last.text).not.toContain("指标及日期已确定");
    // 正文只采用已保存的规范清单，忽略网关仍提出的额外调用与模型自拟确认对象。
    expect(last?.role === "assistant" && last.text).toMatch(/请确认以下候选，同意可回复“是”，或回复序号、名称：\n请确认「合成简称」对应的机构：\n1\. 合成全称$/);
    const modelContext = JSON.stringify(entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.content] : []));
    expect(modelContext).toContain("pendingChoices");
    expect(modelContext).not.toMatch(/\\"candidates\\":\[\{/);
  } finally {await host.close(); await store.close();}
});

it("澄清回执在原生工具处终止，永远失败的第二次模型响应不会被请求", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null,
      executionMode: "execute", fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "exact"}]}},
    {kind: "error", message: "MODEL_TOOL_PROTOCOL_ERROR: <｜DSML｜function_calls>网关持续返回损坏协议"},
  ]);
  const basicQueries = vi.fn();
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const outcome = await host.runPrompt(session, {protocol_version: 3, request_id: "clarification-terminate", message: "新建查询"},
      {actor: ACTOR, backend: {basicQueries} as unknown as BackendClient});
    expect(faux.providerCalls).toBe(1);
    expect(basicQueries).not.toHaveBeenCalled();
    if (outcome.ok && outcome.outcome.kind === "settled") expect(outcome.outcome.outcome.status).toBe("completed");
    const {projectEntries} = await import("../src/sessionProjection.js");
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    expect(projectEntries(entries).at(-1)).toMatchObject({role: "assistant", text: "请补充指标。\n\n请补充机构。\n\n请补充日期范围。"});
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error")).toEqual([]);
  } finally {await host.close(); await store.close();}
});

it("同批先读取再澄清也就地结束，后续目录调用受原生工具门禁阻止", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCalls", calls: [
      {name: "business_context_read", args: {}},
      {name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
        fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "exact"}]}},
      {name: "catalog", args: {action: "search", queries: [{entity: "organization", keyword: "合成机构"}]}},
    ]},
    {kind: "error", message: "MODEL_TOOL_PROTOCOL_ERROR: 不应请求第二次模型"},
  ]);
  const searchOrganizations = vi.fn(); const basicQueries = vi.fn();
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "mixed-clarification", message: "新建查询"}, {actor: ACTOR, backend: {searchOrganizations, basicQueries} as unknown as BackendClient});
    expect(faux.providerCalls).toBe(1);
    expect(searchOrganizations).not.toHaveBeenCalled(); expect(basicQueries).not.toHaveBeenCalled();
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const tools = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    expect(tools.map(tool => tool.toolName)).toEqual(["business_context_read", "resolve_business_turn", "catalog"]);
    expect(tools.at(-1)?.isError).toBe(true);
    const {projectEntries} = await import("../src/sessionProjection.js");
    expect(projectEntries(entries).filter(message => message.role === "assistant" && message.text)).toHaveLength(1);
  } finally {await host.close(); await store.close();}
});

it.each([
  {label: "非法目录参数", sibling: {name: "catalog", args: {}}, rejectBatch: false},
  {label: "未知工具", sibling: {name: "unknown_tool", args: {}}, rejectBatch: false},
  {label: "非法第二份业务提案", sibling: {name: "resolve_business_turn", args: {
    capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
    fieldIntents: {organizations: {mode: "set", sourceText: "另一个目标", expectedCount: null}},
    fieldChanges: [{fieldHint: "organizations", operation: "replace", rawValue: "另一个目标"}],
  }}, rejectBatch: true},
])("同批$label不会迫使澄清再次请求模型，冲突提案整批拒绝", async ({sibling, rejectBatch}) => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCalls", calls: [
      {name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: rejectBatch ? "current" : null,
        executionMode: "execute", fieldChanges: rejectBatch ? [] : [{fieldHint: "selection", operation: "set", rawValue: "exact"}]}},
      sibling,
    ]},
    {kind: "error", message: "MODEL_TOOL_PROTOCOL_ERROR: <｜DSML｜function_calls>第二次模型永久返回损坏协议"},
  ]);
  const searchOrganizations = vi.fn(); const basicQueries = vi.fn();
  const audit = vi.spyOn(console, "info").mockImplementation(() => {});
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const frames = new NativeFrameStore(session.session);
    if (rejectBatch) {
      // 合法半份提案若被独自执行，会沿用这个旧目标；坏提案中的新目标不能被静默丢掉。
      await frames.save({frameId: "saved-target", operationFrameId: "saved-target", sessionId: session.sessionId,
        turnId: "saved-turn", requestId: "saved-request", capability: "metric_query", status: "ready",
        fields: {
          metrics: {resolutionStatus: "resolved", resolvedValue: {codes: ["M"], names: ["原指标"]}, source: "resolved"},
          organizations: {resolutionStatus: "resolved", resolvedValue: {codes: ["O"], names: ["原机构"]}, source: "resolved"},
          time: {resolutionStatus: "resolved", resolvedValue: {start: "2026-02-28", end: "2026-02-28"}, source: "resolved"},
          selection: {resolutionStatus: "resolved", resolvedValue: "exact", source: "resolved"},
        }, delta: {capabilityHint: "metric_query", baseReference: null, executionMode: "resolve_more", fieldChanges: []},
        issues: [], createdAt: "2026-10-13T00:00:00.000Z"}, 0, "seed-saved-target");
    }
    const before = {state: await frames.state(), frames: await frames.list()};
    const result = await host.runPrompt(session, {protocol_version: 3, request_id: "invalid-clarification-sibling", message: rejectBatch ? "查询另一个目标" : "新建查询"},
      {actor: ACTOR, backend: {searchOrganizations, basicQueries} as unknown as BackendClient});
    expect(faux.providerCalls).toBe(1);
    expect(searchOrganizations).not.toHaveBeenCalled(); expect(basicQueries).not.toHaveBeenCalled();
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const receipts = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    const {projectEntries} = await import("../src/sessionProjection.js");
    const answers = projectEntries(entries).filter(message => message.role === "assistant" && message.text);
    const blocked = audit.mock.calls.flatMap(([line]) => {
      const record = JSON.parse(String(line)) as {event?: string; stage?: string; tool?: string};
      return record.event === "agent_tool_call" && record.stage === "blocked" ? [record.tool] : [];
    });
    expect(answers).toHaveLength(1);
    if (rejectBatch) {
      expect(result).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "failed"}}});
      expect(receipts).toEqual([]);
      expect({state: await frames.state(), frames: await frames.list()}).toEqual(before);
      expect(blocked).toEqual(["resolve_business_turn", "resolve_business_turn"]);
      expect(entries.some(entry => entry.type === "message" && entry.message.role === "assistant"
        && entry.message.stopReason === "error" && entry.message.errorMessage === "BUSINESS_BATCH_ARGUMENTS_INVALID")).toBe(true);
      expect(answers[0]).toMatchObject({text: "本轮业务参数批次未通过校验，原条件已保留，未执行新的查询。请重试本轮请求。",
        error: "本轮业务参数批次未通过校验，原条件已保留，未执行新的查询。请重试本轮请求。"});
    } else {
      expect(result).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
      expect(receipts.map(receipt => receipt.toolName)).toEqual(["resolve_business_turn"]);
      expect(receipts[0]?.details).toMatchObject({status: "NEEDS_CLARIFICATION", retryable: false, delivery: "frame_clarification_v1"});
      expect((await frames.list()).at(-1)?.status).toBe("clarifying");
      expect(blocked).toEqual([sibling.name === "unknown_tool" ? "unknown" : "catalog"]);
      expect(answers[0]).toMatchObject({text: "请补充指标。\n\n请补充机构。\n\n请补充日期范围。"});
    }
  } finally {audit.mockRestore(); await host.close(); await store.close();}
});

it("无候选澄清禁止模型虚构确认，回复是只澄清一次，重开后补齐原文继承完整条件并执行一次", async () => {
  const dir = tempDir();
  const initial = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: "合成指标"},
    {fieldHint: "organizations", operation: "set", rawValue: "未知对象"},
    {fieldHint: "time", operation: "set", rawValue: "2026年2月末"},
    {fieldHint: "selection", operation: "set", rawValue: "exact"},
  ]};
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: initial},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {confirm: true}}]}},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成机构"}]}},
    {kind: "text", text: "已查询合成机构。"},
  ]);
  const basicQueries = vi.fn(async (_spec: unknown) => ({result: {task_id: "synthetic-recovered", status: "succeeded", rows: [], columns: [], row_count: 0}}));
  const searchOrganizations = vi.fn();
  const backend = {basicQueries, searchOrganizations,
    resolveBusinessField: async (entity: string, raw: string[]) => entity === "date"
      ? {status: "resolved", value: {start: "2026-02-28", end: "2026-02-28"}}
      : entity === "organization" && raw[0] === "未知对象" ? {status: "not_found", candidates: []}
      : {status: "resolved", value: {codes: [entity === "metric" ? "M" : "O"], names: raw}},
    createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
    getTask: async () => ({task_id: "synthetic-recovered", status: "SUCCEEDED", version: 1, result: {result_id: "synthetic-result"}}),
  } as unknown as BackendClient;
  fixtureMetricBackend(backend, ["合成指标"]);
  let store = new NativeSessionStore(dir);
  let host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    let session = await host.createSession(ACTOR);
    const sessionId = session.sessionId;
    await host.runPrompt(session, {protocol_version: 3, request_id: "unmatched", message: "未知对象 合成指标 2026年2月末"}, {actor: ACTOR, backend});
    const {projectEntries} = await import("../src/sessionProjection.js");
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
    expect(messages.at(-1)).toMatchObject({role: "assistant", text: "尚未确定机构，请提供具体的机构。"});
    expect(JSON.stringify(messages.at(-1))).not.toMatch(/凭空|请回答是/);
    const frames = new NativeFrameStore(session.session);
    const before = await frames.state();
    await host.runPrompt(session, {protocol_version: 3, request_id: "ungrounded-yes", message: "是"}, {actor: ACTOR, backend});
    expect(faux.providerCalls).toBe(2);
    expect(await frames.state()).toEqual(before);
    expect(basicQueries).not.toHaveBeenCalled();
    expect(searchOrganizations).not.toHaveBeenCalled();
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const lastReceipt = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []).at(-1);
    expect(lastReceipt?.details).toMatchObject({status: "NEEDS_CLARIFICATION", retryable: false, frame_id: before.focusFrameId});
    await host.close(); await store.close();
    store = new NativeSessionStore(dir);
    host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
    session = (await host.openSession(ACTOR, sessionId))!;
    await host.runPrompt(session, {protocol_version: 3, request_id: "recovered", message: "机构用合成机构，其他不变"}, {actor: ACTOR, backend});
    expect(faux.providerCalls).toBe(4);
    expect(basicQueries).toHaveBeenCalledTimes(1);
    expect(basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M"], org_codes: ["O"], time: {start: "2026-02-28", end: "2026-02-28"}});
    const recovered = (await new NativeFrameStore(session.session).list()).at(-1)!;
    expect(recovered.status).toBe("success");
    expect(recovered.fields.metrics?.source).toBe("inherited");
    expect(recovered.fields.time?.source).toBe("inherited");
  } finally {await host.close(); await store.close();}
});

it("交错目录调用不能绕过相同失败提案的循环检测，焦点不被错误调用污染", async () => {
  const dir = tempDir();
  const delta = {executionMode: "execute", fieldChanges: []};
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: delta},
    {kind: "toolCall", name: "business_context_read", args: {}},
    {kind: "toolCall", name: "resolve_business_turn", args: {...delta, capabilityHint: "unknown"}},
    {kind: "toolCall", name: "resolve_business_turn", args: delta},
    {kind: "toolCall", name: "business_context_read", args: {}},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "bad-input-loop", message: "继续"}, {actor: ACTOR, backend: {} as BackendClient});
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    expect(await new NativeFrameStore(session.session).list()).toHaveLength(0);
    expect(faux.providerCalls).toBe(5);
    const {projectEntries} = await import("../src/sessionProjection.js");
    const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
    expect(messages.filter(message => message.role === "tool" && message.tool === "business_context_read")).toHaveLength(1);
    const last = messages.at(-1);
    expect(last?.role === "assistant" && last.text).toContain("已停止重复尝试");
  } finally {await host.close(); await store.close();}
});

it("不同原文和组合错误逐步修正超过三次后仍可执行完整月范围一次", async () => {
  const dir = tempDir();
  const proposal = (selection?: string, metric = "合成余额"): FauxReply => ({kind: "toolCall", name: "resolve_business_turn", args: {
    capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: metric},
      {fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
      {fieldHint: "time", operation: "set", rawValue: "2026年7月"},
      ...(selection ? [{fieldHint: "selection", operation: "set", rawValue: selection}] : []),
      {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "top", top_n: 3}},
    ],
  }});
  const faux = createFauxModel([proposal("latest_in_range", "非原文指标"), proposal("ranking"), proposal(),
    proposal("exact"), proposal("latest_in_range"), {kind: "text", text: "合成查询无记录。"}]);
  const basicQueries = vi.fn(async (_spec: unknown) => ({result: {task_id: "month-repair", status: "succeeded", rows: [], columns: [], row_count: 0}}));
  const backend = {
    resolveBusinessField: async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date"
      ? {start: "2026-07-01", end: "2026-07-31"} : {codes: [entity === "organization" ? "O" : "M"], names}}),
    createAgentQueryContext: async () => ({conversation_id: "month-repair"}), basicQueries,
    getTask: async () => ({task_id: "month-repair", status: "SUCCEEDED", version: 1, result: {result_id: "month-result"}}),
  } as unknown as BackendClient;
  fixtureMetricBackend(backend, ["合成余额"]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "progressive-repair",
      message: "给合成机构按2026 年 7 月内最后有数据日的合成余额排名前3。"}, {actor: ACTOR, backend});
    expect(basicQueries).toHaveBeenCalledTimes(1);
    expect(basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M"], org_codes: ["O"],
      time: {start: "2026-07-01", end: "2026-07-31"}, selection: "latest_in_range", operation: {kind: "ranking", position: "top", top_n: 3}});
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    expect((await new NativeFrameStore(session.session).list()).map(frame => frame.status)).toEqual(["ready", "executing", "success"]);
    expect(faux.providerCalls).toBe(6);
  } finally {await host.close(); await store.close();}
});

it("不同无效提案仍受既有总调用预算约束，不无限试错", async () => {
  const dir = tempDir();
  const faux = createFauxModel(Array.from({length: 30}, (_, index): FauxReply => ({kind: "toolCall", name: "resolve_business_turn", args: {
    capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
    fieldChanges: [{fieldHint: `unknown_${index}`, operation: "set", rawValue: "合成值"}],
  }})));
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "unique-invalid-budget", message: "合成查询"}, {actor: ACTOR, backend: {} as BackendClient});
    const {projectEntries} = await import("../src/sessionProjection.js");
    const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
    expect(messages.filter(message => message.role === "tool")).toHaveLength(24);
    expect(messages.at(-1)).toMatchObject({role: "assistant", text: TOOL_LIMIT_ANSWER});
    expect(faux.providerCalls).toBe(25);
  } finally {await host.close(); await store.close();}
});

it("连续换日期、换指标时解析即执行，模型多余调用与错误引用不重复查询；复用只回读一次", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}},
      {fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
      {fieldHint: "time", operation: "set", rawValue: "2026年4月末"},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ]}},
    {kind: "text", text: "第一轮查询完成。"},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldChanges: [
      {fieldHint: "time", operation: "set", rawValue: "3月末"},
    ]}},
    // 执行已在解析回执里落地，模型仍主动发起一次错误历史引用：不得再查一次数。
    {kind: "toolCall", name: "execute_business_frame", args: {frameId: "错误的历史引用"}},
    {kind: "text", text: "第二轮查询完成。"},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}},
    ]}},
    {kind: "text", text: "第三轮查询完成。"},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: "current", executionMode: "reuse_result", fieldChanges: []}},
    {kind: "text", text: "结果已回读。"},
  ]);
  const queries: Array<{metric_codes: string[]; org_codes: string[]; time: {start: string; end: string}}> = [];
  const getTaskResult = vi.fn(async () => ({status: "succeeded", task_id: "t3", result_id: "r3", rows: [], columns: [], row_count: 0, has_more: false}));
  const backend = {
    matchMetricQuestion: async (question: string) => {
      const name = question.includes("较年初") ? "个人经营性贷款余额较年初" : "个人经营性贷款余额全省均值";
      const start = question.indexOf(name);
      return {mentions: start < 0 ? [] : [{text: name, start, end: start + name.length,
        resolution: {status: "resolved", value: {codes: [question.includes("较年初") ? "M2" : "M1"], names: [name]}}}]};
    },
    resolveBusinessField: async (entity: string, raw: string[]) => ({status: "resolved", value: entity === "date"
      ? {start: raw[0]!.includes("4") ? "2026-04-30" : "2026-03-31", end: raw[0]!.includes("4") ? "2026-04-30" : "2026-03-31"}
      : {codes: ["O"], names: raw}}),
    createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
    basicQueries: async (spec: typeof queries[number]) => {
      queries.push(spec); return {result: {task_id: `t${queries.length}`, status: "succeeded", rows: [], columns: [], row_count: 0}};
    },
    getTask: async (taskId: string) => ({task_id: taskId, status: "SUCCEEDED", version: 1, result: {result_id: `r${queries.length}`}}),
    getTaskResult,
  } as unknown as BackendClient;
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    let session = await host.createSession(ACTOR);
    const questions = ["合成机构2026年4月末个人经营性贷款余额全省均值是多少？", "3月末的呢？", "个人经营性贷款余额较年初是多少呢？", "展示刚才的结果，不重新查询"];
    for (const [i, message] of questions.entries()) {
      if (i === 2) {
        await host.closeSession(session.sessionId);
        session = (await host.openSession(ACTOR, session.sessionId))!;
      }
      await host.runPrompt(session, {protocol_version: 3, request_id: `chain-${i}`, message}, {actor: ACTOR, backend});
      expect(queries).toHaveLength(Math.min(i + 1, 3));
    }
    expect(queries.map(query => [query.metric_codes, query.org_codes, query.time.end])).toEqual([
      [["M1"], ["O"], "2026-04-30"], [["M1"], ["O"], "2026-03-31"], [["M2"], ["O"], "2026-03-31"],
    ]);
    expect(getTaskResult).toHaveBeenCalledTimes(1);
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const {projectEntries} = await import("../src/sessionProjection.js");
    const answers = projectEntries(entries).filter(message => message.role === "assistant").map(message => message.text).join("\n");
    expect(answers).toContain("第一轮查询完成。");
    expect(answers).toContain("第三轮查询完成。");
    expect(answers).toContain("结果已回读。");
    // 命中目录但尚无业务回执的步骤只要求调用某个工具，不指定查询能力或重放旧 Frame。
    expect((faux.payloads[0] as {tool_choice?: string}).tool_choice).toBe("required");
    for (const payload of faux.payloads) {
      expect([undefined, "required"]).toContain((payload as {tool_choice?: string}).tool_choice);
    }
    expect(faux.providerCalls).toBe(9);
  } finally {await host.close(); await store.close();}
});

it.each(["resolve_more", "failure", "error"])("执行接续尊重只解析、执行失败和模型中止（%s）", async mode => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "data_availability", baseReference: null, executionMode: mode === "resolve_more" ? "resolve_more" : "execute", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
      {fieldHint: "dimension", operation: "set", rawValue: "metrics"},
    ]}},
    mode === "error" ? {kind: "error", message: "Synthetic interruption"} : {kind: "text", text: "条件已齐全。"},
    {kind: "text", text: "业务执行失败，未自动重试。"},
  ]);
  const dataAvailability = vi.fn(async () => {throw new BackendApiError(422, "合成失败", "SYNTHETIC_FAILURE");});
  const backend = {dataAvailability, resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O"], names: ["合成机构"]}})} as unknown as BackendClient;
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: `boundary-${mode}`, message: "合成机构有哪些指标"}, {actor: ACTOR, backend});
    // 执行意图在解析回执上就地落地：只有 resolve_more 明确不执行时才不查数；
    // 执行失败随回执返回，模型后面的传输错误不再回头阻止已经校验的查询（重试幂等，不重复查数）。
    expect(dataAvailability).toHaveBeenCalledTimes(mode === "resolve_more" ? 0 : 1);
    expect(faux.payloads[1]).not.toHaveProperty("tool_choice");
    if (mode === "failure") expect(faux.payloads.at(-1)).not.toHaveProperty("tool_choice");
  } finally {await host.close(); await store.close();}
});

it.each([
  {replies: 1, calls: 2, text: "你好。"},
  {replies: 6, calls: 2, text: "模型服务响应超时，请稍后重试。已确认的查询条件仍保留，无需重复输入。"},
])("模型首次响应超时自动重试一次，仍超时则明确提示（超时次数=$replies）", async ({replies, calls, text}) => {
  const dir = tempDir();
  const timeout = {kind: "error" as const, message: "MODEL_FIRST_RESPONSE_TIMEOUT: 模型服务未在时限内开始返回内容（first response timeout）。"};
  const faux = createFauxModel([...Array.from({length: replies}, () => timeout), {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "你好。"}}]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools(),
    {retry: {enabled: true, maxRetries: 1, baseDelayMs: 1}});
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: `first-response-${replies}`, message: "你好"},
      {actor: ACTOR, backend: {} as BackendClient});
    expect(faux.providerCalls).toBe(calls);
    const {projectEntries} = await import("../src/sessionProjection.js");
    const last = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).at(-1);
    expect(last?.role === "assistant" && last.text).toBe(text);
  } finally {await host.close(); await store.close();}
});

it("已有输出后停滞不自动重放模型请求，交付明确失败说明", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "error", message: `${MODEL_STREAM_IDLE_EXCEEDED}: 模型输出长时间没有有效进展，本轮未正常完成。`},
    {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "不应自动重放"}},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools(),
    {retry: {enabled: true, maxRetries: 1, baseDelayMs: 1}});
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "stream-idle-no-retry", message: "你好"},
      {actor: ACTOR, backend: {} as BackendClient});
    expect(faux.providerCalls).toBe(1);
    const {projectEntries} = await import("../src/sessionProjection.js");
    const last = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).at(-1);
    expect(last?.role === "assistant" && last.text).toBe("模型输出长时间没有进展，本轮未完成。已确认的查询条件仍保留，无需重复输入。");
  } finally {await host.close(); await store.close();}
});

it("模型连续失败只重试一次即暴露，不按 SDK 默认指数退避拖满两分钟", async () => {
  const dir = tempDir();
  // 可重试的网关错误：SDK 默认 maxRetries=3 会发 4 次请求并叠加 1s/2s/4s 退避；
  // 收紧后最多 1 次重试 = 2 次请求，失败在约一个请求超时内暴露给用户。
  const faux = createFauxModel(Array.from({length: 6}, () => ({kind: "error" as const, message: "502 upstream connect error"})));
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const outcome = await host.runPrompt(session, {protocol_version: 3, request_id: "retry-budget", message: "合成机构存款余额是多少"}, {
      actor: ACTOR,
      backend: {resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O"], names: ["合成机构"]}})} as unknown as BackendClient,
    });
    expect(faux.providerCalls).toBe(2);
    expect(outcome.ok).toBe(true);
  } finally {await host.close(); await store.close();}
});

it("本轮没有指标命中且网关忽略 required 时，纯计划须在同一 Pi 循环纠正为实际业务动作", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "text", text: "我会调用工具保存条件，然后继续。"},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null,
      executionMode: "execute", fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "exact"}]}},
    {kind: "text", text: "请补充指标、机构和日期。"},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const result = await host.runPrompt(session, {protocol_version: 3, request_id: "no-mention-action", message: "新建一笔查询"},
      {actor: ACTOR, backend: {matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient});
    expect(result.ok).toBe(true);
    expect(faux.providerCalls).toBe(2);
    expect(faux.payloads[0]).toMatchObject({tool_choice: "required"});
    const entries = await session.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    const tools = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolName] : []);
    expect(tools.sort()).toEqual([ACTION_REQUIRED, "resolve_business_turn"].sort());
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    expect((await new NativeFrameStore(session.session).list())[0]?.status).toBe("clarifying");
  } finally {await host.close(); await store.close();}
});

it("普通问候走明确无业务动作分支，未建Frame且不访问后端", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "你好，请问有什么可以帮助你？"}},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    expect((await host.runPrompt(session, {protocol_version: 3, request_id: "hello", message: "你好"},
      {actor: ACTOR, backend: {} as BackendClient})).ok).toBe(true);
    expect(faux.providerCalls).toBe(1);
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    expect(await new NativeFrameStore(session.session).list()).toEqual([]);
    const entries = await session.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(entries.some(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === CONVERSATION_REPLY && !entry.message.isError)).toBe(true);
  } finally {await host.close(); await store.close();}
});

it("连续只输出计划时有界失败，不能无调用假装完成或无限重试", async () => {
  const dir = tempDir();
  const faux = createFauxModel([{kind: "text", text: "我会切换到第一笔，再替换机构查询。"}]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const result = await host.runPrompt(session, {protocol_version: 3, request_id: "no-action-limit", message: "回到第一笔"},
      {actor: ACTOR, backend: {} as BackendClient});
    // ok 表示 drive 调用成功；原生 operation outcome 才是本轮业务运行状态。
    expect(result).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "failed"}}});
    expect(faux.providerCalls).toBe(3);
    const entries = await session.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === ACTION_REQUIRED)).toHaveLength(2);
  } finally {await host.close(); await store.close();}
});

it("普通回答后即使网关忽略 none 又提议查询，也只交付原回答且不执行查询", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "你好。"}},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null,
      executionMode: "execute", fieldChanges: []}},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "no-action-is-final", message: "你好"},
      {actor: ACTOR, backend: {} as BackendClient});
    // 回执即结束本轮：脚本里第二次“提议查询”的模型响应根本不会被请求。
    expect(faux.providerCalls).toBe(1);
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    expect(await new NativeFrameStore(session.session).list()).toEqual([]);
    const {projectEntries} = await import("../src/sessionProjection.js");
    expect(projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT)).at(-1))
      .toMatchObject({role: "assistant", text: "你好。"});
  } finally {await host.close(); await store.close();}
});

it("上轮已有回答不能解除本轮动作约束，纠错不追加用户消息", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    {kind: "toolCall", name: CONVERSATION_REPLY, args: {answer: "你好。"}},
    {kind: "text", text: "我会创建查询。"},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", baseReference: null,
      executionMode: "execute", fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "exact"}]}},
    {kind: "text", text: "请补充指标、机构和日期。"},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    let session = await host.createSession(ACTOR);
    const deps = {actor: ACTOR, backend: {} as BackendClient};
    await host.runPrompt(session, {protocol_version: 3, request_id: "before-reopen", message: "你好"}, deps);
    await host.closeSession(session.sessionId);
    session = (await host.openSession(ACTOR, session.sessionId))!;
    await host.runPrompt(session, {protocol_version: 3, request_id: "after-reopen", message: "创建一笔查询"}, deps);
    expect(faux.providerCalls).toBe(3);
    expect(faux.payloads[1]).toMatchObject({tool_choice: "required"});
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === ACTION_REQUIRED)).toHaveLength(1);
  } finally {await host.close(); await store.close();}
});

it("相同报错但参数正在变化不提前终止，移除虚构日期后保留已给条件并正常澄清", async () => {
  const dir = tempDir();
  const fields = [
    {fieldHint: "metrics", operation: "set", rawValue: "余额"},
    {fieldHint: "organizations", operation: "set", rawValue: "测试机构"},
    {fieldHint: "selection", operation: "set", rawValue: "exact"},
  ];
  const attempt = (rawValue?: string): FauxReply => ({kind: "toolCall", name: "resolve_business_turn", args: {
    capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      ...fields, ...(rawValue ? [{fieldHint: "time", operation: "set", rawValue}] : []),
    ],
  }});
  const faux = createFauxModel([attempt("当前业务日期"), attempt("2026-09-28"), attempt(), {kind: "text", text: "请补充查询日期。"}]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    const basicQueries = vi.fn();
    await host.runPrompt(session, {protocol_version: 3, request_id: "correct-missing-date", message: "查询测试机构余额"},
      {actor: ACTOR, backend: fixtureMetricBackend({basicQueries, resolveBusinessField: async (_entity: string, names: string[]) =>
        ({status: "resolved", value: {codes: names, names}})} as unknown as BackendClient, ["余额"])});
    expect(faux.providerCalls).toBe(3);
    expect(basicQueries).not.toHaveBeenCalled();
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({status: "clarifying", fields: {
      metrics: {resolvedValue: {names: ["余额"]}}, organizations: {resolvedValue: {names: ["测试机构"]}},
      time: {resolutionStatus: "missing"},
    }});
  } finally {await host.close(); await store.close();}
});

it("理解问题阶段向页面播报上下文、指标识别与模型分析，工具回执之后不再播报", async () => {
  const dir = tempDir();
  const query = (changes: unknown[], base: unknown): FauxReply => ({kind: "toolCall", name: "resolve_business_turn", args: {
    capabilityHint: "metric_query", baseReference: base, executionMode: "execute", fieldChanges: changes}});
  const faux = createFauxModel([
    query([{fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}}, {fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
      {fieldHint: "time", operation: "set", rawValue: "2026年4月30日"}, {fieldHint: "selection", operation: "set", rawValue: "exact"}], null),
    {kind: "text", text: "第一轮完成。"},
    query([{fieldHint: "time", operation: "set", rawValue: "3月末"}], "current"),
    {kind: "text", text: "第二轮完成。"},
  ]);
  const name = "合成余额当日数";
  const backend = {
    matchMetricQuestion: async (question: string) => {
      const start = question.indexOf(name);
      return {mentions: start < 0 ? [] : [{text: name, start, end: start + name.length, resolution: {status: "resolved", value: {codes: ["M"], names: [name]}}}]};
    },
    resolveBusinessField: async (entity: string, raw: string[]) => ({status: "resolved", value: entity === "date"
      ? {start: raw[0]!.includes("3月") ? "2026-03-31" : "2026-04-30", end: raw[0]!.includes("3月") ? "2026-03-31" : "2026-04-30"} : {codes: ["O"], names: raw}}),
    createAgentQueryContext: async () => ({conversation_id: "synthetic"}),
    basicQueries: async () => ({result: {task_id: "t", status: "succeeded", rows: [], columns: [], row_count: 0}}),
    getTask: async () => ({task_id: "t", status: "SUCCEEDED", version: 1, result: {result_id: "r"}}),
  } as unknown as BackendClient;
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  const {mentionNote} = await import("../src/harnessHost.js");
  try {
    const session = await host.createSession(ACTOR);
    const ask = async (message: string, request_id: string) => {
      const reported: Array<Record<string, unknown>> = [];
      const admitted = await host.admitPrompt(session, {protocol_version: 3, request_id, message}, {actor: ACTOR, backend});
      if (!admitted.ok) throw new Error(admitted.code);
      admitted.request.reportActivity = activity => reported.push({...activity});
      await host.drivePrompt(session, admitted);
      return reported;
    };
    const first = await ask(`合成机构2026年4月30日${name}是多少？`, "activity-1");
    expect(first.map(item => `${item.activity_id}:${item.status}`)).toEqual([
      "context:running", "context:done", "mentions:running", "mentions:done", "model:running", "model:done"]);
    expect(first[1]).toMatchObject({note: "新的话题，没有可沿用的条件"});
    expect(first[1]).not.toHaveProperty("conditions");
    expect(first[3]).toMatchObject({note: `识别到：${name}`});
    const {NativeFrameStore} = await import("../src/business-context/store.js");
    const fs = new NativeFrameStore(session.session);
    const second = await ask("3月末的呢？", "activity-2");
    expect(second.filter(item => item.status === "done")).toEqual([
      {activity_id: "context", label: "读取对话上下文", status: "done", note: "沿用当前话题", conditions: [
        {label: "指标", value: name}, {label: "机构", value: "合成机构"}, {label: "日期", value: "2026-04-30"}]},
      {activity_id: "mentions", label: "识别问题中的指标", status: "done", note: "未提到新指标，沿用当前话题的指标"},
      {activity_id: "model", label: "理解问题，确定处理方式", status: "done"},
    ]);
    expect(JSON.stringify(faux.payloads)).not.toContain("沿用当前话题");
    expect(mentionNote({mentions: [], status: "temporary_error"}, false)).toBe("指标目录暂时不可用，解析条件时会再试");
    expect(mentionNote({mentions: [{text: "余额", start: 0, end: 2, resolution: {status: "ambiguous"}}]}, true)).toBe("“余额”可能对应多个指标，需要确认");
  } finally {await host.close(); await store.close();}
});
