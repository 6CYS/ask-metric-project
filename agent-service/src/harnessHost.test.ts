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
import { afterEach, describe, expect, it } from "vitest";
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
  type AgentHarnessTool,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { AgentServiceConfig } from "./config.js";
import { createMetricAskTool } from "./tools/metricAsk.js";
import { createMetricReadTool } from "./tools/readTools.js";
import { BackendApiError } from "./backendClient.js";
import { HarnessHost } from "./harnessHost.js";
import { wrapStreamsWithAuthorization } from "./models.js";
import { NativeSessionStore } from "./nativeSessions.js";
import type { AskMetricRequestContext } from "./requestContext.js";
import type { BackendClient, BackendUser } from "./backendClient.js";

const ACTOR: BackendUser = {
  id: "user-1",
  username: "user1",
  display_name: "用户一",
  org_code: "3200",
  org_name: "测试机构",
  role_code: "tester",
};

type FauxReply =
  | { kind: "text"; text: string; inputTokens?: number }
  | { kind: "toolCall"; name: string; args: Record<string, unknown>; inputTokens?: number };

interface FauxModel {
  streams: ProviderStreams;
  model: Model<"openai-completions">;
  models: ReturnType<typeof createModels>;
  providerCalls: number;
  contexts: unknown[];
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
  if (reply.kind === "toolCall") {
    return {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: reply.name, arguments: reply.args }],
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
    content: [{ type: "text", text: reply.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** 预编排模型桩：按调用顺序返回脚本响应，记录每次调用供断言 */
function createFauxModel(script: FauxReply[], contextWindow = 128_000): FauxModel {
  let calls = 0;
  const contexts: unknown[] = [];
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
  const respond = (reply: FauxReply): ReturnType<ProviderStreams["streamSimple"]> => {
    const message = buildAssistant(model, reply);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
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
  const streams: ProviderStreams = {
    stream: (_model, context) => {
      contexts.push(structuredClone(context));
      calls += 1;
      return respond(script[Math.min(calls - 1, script.length - 1)]!);
    },
    streamSimple: (_model, context) => {
      contexts.push(structuredClone(context));
      calls += 1;
      return respond(script[Math.min(calls - 1, script.length - 1)]!);
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
  return { streams, model, models, contexts, get providerCalls() { return calls; }, set providerCalls(_v: number) { /* 只读 */ } } as FauxModel;
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
    maxSessionsPerUser: 20,
    compaction: compaction ?? { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  };
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
    const first = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-1", message: "第一轮问题" }, { actor: ACTOR, backend: {} as BackendClient });
    expect(first.ok).toBe(true);
    const second = await host.runPrompt(hosted, { protocol_version: 3 as const, request_id: "req-2", message: "第二轮问题" }, { actor: ACTOR, backend: {} as BackendClient });
    expect(second.ok).toBe(true);

    const entries = await hosted.lane.findEntries(undefined, BACKGROUND_CONTEXT);
    const compaction = entries.filter((entry) => entry.type === "compaction");
    expect(compaction.length).toBeGreaterThan(0);
    expect(compaction.some(entry => entry.summary.includes("2026年3月末"))).toBe(true);
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


it("真实 pi 校验链还原字符串 source，业务回执原生结束，无复述模型调用", async () => {
  const dir=tempDir();
  const faux=createFauxModel([{kind:"toolCall",name:"metric_ask",args:{action:"followup",source:JSON.stringify({task_id:"source",version:3}),change_field:"compose"}}]);
  let submitted: unknown[]=[];
  const backend={
    submitQuestion:async(...args:unknown[])=>{submitted=args;return {task_id:"t",conversation_id:"c",status:"RUNNING",current_stage:"LOGICAL_DSL",version:1};},
    executeTask:async()=>({task_id:"t",status:"succeeded",columns:[],rows:[],row_count:0}),
    getTask:async()=>({task_id:"t",status:"SUCCEEDED",version:2,result:{result_id:"r"}}),
  } as unknown as BackendClient;
  const host=new HarnessHost(testConfig(dir),()=>({models:faux.models,model:faux.model}),new NativeSessionStore(dir),[createMetricAskTool()]);
  const session=await host.createSession(ACTOR);
  const outcome=await host.runPrompt(session,{protocol_version:3,request_id:"source-string",message:"那江阴呢"},{actor:ACTOR,backend});
  expect(outcome.ok).toBe(true);
  expect(submitted[3]).toEqual({task_id:"source",version:3,change_field:"compose"});
  expect(faux.providerCalls).toBe(1);
  await host.close();
});

it("业务 500 后原生结束，恶意金额候选没有机会进入交付", async () => {
  const dir = tempDir();
  const faux = createFauxModel([
    { kind: "toolCall", name: "metric_ask", args: { action: "new" } },
    { kind: "text", text: "江阴农商行金额15147420074元。" },
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
  expect(faux.providerCalls).toBe(1);
  const { projectEntries, projectBusinessTasks } = await import("./sessionProjection.js");
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
  const {projectEntries} = await import("./sessionProjection.js");
  const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  expect(JSON.stringify(messages)).not.toContain("987654321");
  expect(messages.some(message => message.role === "assistant" && message.text.includes("未能通过校验"))).toBe(true);
  await host.close();
});

it("原生上下文投影保留完整会话，纯换机构纠正旧日期来源，不增加模型调用", async () => {
  const dir=tempDir();
  const faux=createFauxModel([
    {kind:"toolCall",name:"metric_ask",args:{action:"new"}},
    {kind:"toolCall",name:"metric_read",args:{}},
    {kind:"toolCall",name:"metric_ask",args:{action:"followup",source:{task_id:"old",version:3},change_field:"orgs"}},
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
  expect(faux.providerCalls).toBe(3);
  expect(captured[2]).toMatchObject({source:{task_id:"latest",version:3},change_field:"orgs"});
  expect(JSON.stringify(faux.contexts[2])).not.toContain("private-row-");
  const original=await session.lane.findEntries({order:"oldestFirst"},BACKGROUND_CONTEXT);
  expect(entryTexts(original).join("\n")).toContain("private-row-19");
  await host.close();
});
