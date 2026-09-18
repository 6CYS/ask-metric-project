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
    stream: () => {
      calls += 1;
      return respond(script[Math.min(calls - 1, script.length - 1)]!);
    },
    streamSimple: () => {
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
  return { streams, model, models, get providerCalls() { return calls; }, set providerCalls(_v: number) { /* 只读 */ } } as FauxModel;
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
        { kind: "text", text: "历史摘要：用户问过测试数值。", inputTokens: 100 },
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
