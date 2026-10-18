/**
 * 宿主协议无关能力验证（模型桩 + 临时原生目录）：
 * 工具循环、原生历史恢复、compaction、授权 fail-closed、重启恢复与模型重试预算。
 * 业务协议相关行为由 specs/semantic-task/ 下的 semantic_v2 套件覆盖；
 * fixed 协议已退役，旧会话只读行为见文件末尾专项。
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
import { HarnessHost, type HostedSession } from "../src/harnessHost.js";
import {requireRequestContext} from "../src/requestContext.js";
import { MODEL_STREAM_IDLE_EXCEEDED, wrapStreamsWithAuthorization } from "../src/models.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";
import type { BackendClient, BackendUser } from "../src/backendClient.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";
import {createCapabilities} from "../src/business-context/capabilities.js";

const ACTOR: BackendUser = {
  id: "user-1",
  username: "user1",
  display_name: "用户一",
  org_code: "3200",
  org_name: "测试机构",
  role_code: "tester",
};


type FauxReply =
  | { kind: "error"; message: string; inputTokens?: number }
  | { kind: "text"; text: string; inputTokens?: number }
  | { kind: "toolCalls"; calls: Array<{name: string; args: Record<string, unknown>}>; inputTokens?: number }
  | { kind: "toolCall"; name: string; args: Record<string, unknown>; inputTokens?: number; preserveArguments?: true };

interface FauxModel {
  streams: ProviderStreams;
  model: Model<"openai-completions">;
  models: ReturnType<typeof createModels>;
  providerCalls: number;
  contexts: unknown[];
  payloads: unknown[];
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
    // semantic 会话的压缩摘要由宿主统一指向业务账本，不采用模型自拟摘要。
    expect(compaction.some(entry => entry.summary.includes("业务账本"))).toBe(true);
    // semantic 会话压缩不额外调用模型，也没有 frame_v1 轮的回答流式。
    expect(modes.some(item => item.step === "compaction")).toBe(false);
    expect(modes.filter(item => item.step === "assistant").every(item => item.mode === "none")).toBe(true);
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



describe("退役 fixed 会话只读", () => {
  it("标记 fixed_v1 的会话打开为只读：历史可读、提问拒绝、在途操作不自动恢复", async () => {
    const dir = tempDir();
    const faux = createFauxModel([{kind: "text", text: "不应请求模型"}]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, [createStubTool([])]);
    const hosted = await host.createSession(ACTOR);
    // 只接纳不驱动，制造一个在途操作；随后标记为旧协议，模拟升级前的 fixed 会话。
    const admitted = await host.admitPrompt(hosted, {protocol_version: 3, request_id: "legacy-open", message: "查一下测试数值"},
      {actor: ACTOR, backend: {} as BackendClient});
    expect(admitted.ok).toBe(true);
    await hosted.session.setValue(value("askmetric", "businessProtocol"), "fixed_v1", BACKGROUND_CONTEXT);
    await host.close();
    await store.close();

    const store2 = new NativeSessionStore(dir);
    const host2 = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store2, [createStubTool([])]);
    const reopened = (await host2.openSession(ACTOR, hosted.sessionId))!;
    expect(reopened.businessProtocol).toBe("fixed_v1");
    expect(reopened.readOnlyReason).toBe("LEGACY_QUERY_REQUIRES_NEW_TURN");
    // 历史消息仍可读取。
    const entries = await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    expect(entryTexts(entries)).toContain("查一下测试数值");
    // 在途操作不自动恢复执行。
    await expect(host2.resumeOpenOperations(reopened, {actor: ACTOR, backend: {} as BackendClient}))
      .rejects.toThrow("LEGACY_QUERY_REQUIRES_NEW_TURN");
    expect(faux.providerCalls).toBe(0);
    // 继续提问明确拒绝。
    const retry = await host2.admitPrompt(reopened, {protocol_version: 3, request_id: "legacy-ask", message: "再查一次"},
      {actor: ACTOR, backend: {} as BackendClient});
    expect(retry).toMatchObject({ok: false, code: "LEGACY_QUERY_REQUIRES_NEW_TURN"});
    expect(faux.providerCalls).toBe(0);
    await host2.close();
    await store2.close();
  });

  it("缺少协议标记的历史会话沿用旧协议识别，不自动视为 semantic 会话", async () => {
    const dir = tempDir();
    const faux = createFauxModel([{kind: "text", text: "不应请求模型"}]);
    const store = new NativeSessionStore(dir);
    const raw = await store.create(ACTOR.id);
    await raw.setValue(value("askmetric", "owner"), ACTOR.id, BACKGROUND_CONTEXT);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, []);
    const opened = await host.openSession(ACTOR, raw.metadata.id);
    expect(opened?.businessProtocol).toBe("fixed_v1");
    expect(opened?.readOnlyReason).toBe("LEGACY_QUERY_REQUIRES_NEW_TURN");
    expect(faux.providerCalls).toBe(0);
    await host.close();
    await store.close();
  });
});
