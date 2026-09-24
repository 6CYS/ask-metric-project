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
  type AgentHarnessTool,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { AgentServiceConfig } from "./config.js";
import { createMetricReadTool } from "./tools/readTools.js";
import { BackendApiError } from "./backendClient.js";
import { HarnessHost } from "./harnessHost.js";
import { wrapStreamsWithAuthorization } from "./models.js";
import { NativeSessionStore } from "./nativeSessions.js";
import type { AskMetricRequestContext } from "./requestContext.js";
import type { BackendClient, BackendUser } from "./backendClient.js";
import { createBusinessSkillReadTool, loadBusinessSkills } from "./businessSkills.js";
import { EVIDENCE_REPAIR_TOOL } from "./replyGuard.js";
import { createAskMetricTools } from "./tools/index.js";

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
  | { kind: "toolCall"; name: string; args: Record<string, unknown>; inputTokens?: number };

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
    if (reply.kind === "toolCall" && reply.args.frameId === "__LATEST_FRAME__") {
      const result = [...context.messages].reverse().find(raw => {
        const message = raw as {role?: string; toolName?: string};
        return message.role === "toolResult" && message.toolName === "resolve_business_turn";
      }) as {content: Array<{text?: string}>} | undefined;
      reply.args.frameId = JSON.parse(result?.content[0]?.text ?? "{}").frameId;
    }
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
    maxSessionsPerUser: 20,
    compaction: compaction ?? { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    modelRetry: { enabled: true, maxRetries: 1, baseDelayMs: 1_000 },
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
          {actor: ACTOR, backend: {submitQuestion, resolveBusinessField: async (_entity: string, names: string[]) => ({status: "resolved", value: {codes: names, names}})} as unknown as BackendClient});
        expect(submitQuestion).not.toHaveBeenCalled();

        expect(faux.providerCalls).toBe(methods.length + 2);
        const expectedTools = [...createAskMetricTools().map(tool => tool.name), "business_skill_read"].sort();
        expect(faux.payloads).toHaveLength(methods.length + 2);
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
      expect(faux.providerCalls).toBe(4);
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
      const {projectEntries} = await import("./sessionProjection.js");
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
      const {projectEntries} = await import("./sessionProjection.js");
      const projected = projectEntries(await restored.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
      expect(projected.filter(message => message.role === "tool" && message.tool === "business_skill_read")).toHaveLength(2);
      expect(projected.filter(message => message.role === "assistant").at(-1)).toMatchObject({text: "正式结果：42元。"});
    } finally { await second.close(); await store.close(); }
  });

  it("Pi 的普通解释原样持久化，宿主不强制补查或插入第二条用户消息", async () => {
    const dir = tempDir();
    const answer = "2024年与2026年是不同统计期间；需要先明确时间口径。";
    const faux = createFauxModel([{kind: "text", text: answer}]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
    try {
      const session = await host.createSession(ACTOR);
      await host.runPrompt(session, {protocol_version: 3, request_id: "explanation", message: "解释统计期间"}, {actor: ACTOR, backend: {} as BackendClient});
      const {projectEntries} = await import("./sessionProjection.js");
      const projected = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
      expect(faux.providerCalls).toBe(1);
      expect(projected.filter(message => message.role === "user")).toHaveLength(1);
      expect(projected.filter(message => message.role === "tool")).toHaveLength(0);
      expect(projected.at(-1)).toMatchObject({role: "assistant", text: answer, business_protocol: "frame_v1"});
      await host.closeSession(session.sessionId);
      const reopened = (await host.openSession(ACTOR, session.sessionId))!;
      expect(projectEntries(await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT))).toEqual(projected);
    } finally {await host.close(); await store.close();}
  });
  it("新操作不激活回答交付及补救工具", async () => {
    const dir = tempDir();
    const faux = createFauxModel([{kind: "text", text: "请说明需要了解的业务口径。"}]);
    const store = new NativeSessionStore(dir);
    const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
    try {
      const session = await host.createSession(ACTOR);
      await host.runPrompt(session, {protocol_version: 3, request_id: "active-tools", message: "你好"}, {actor: ACTOR, backend: {} as BackendClient});
      const active = await session.lane.getActiveTools(BACKGROUND_CONTEXT);
      expect(active).not.toContain("answer_present"); expect(active).not.toContain(EVIDENCE_REPAIR_TOOL);
      expect(faux.providerCalls).toBe(1);
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
    expect(outcome.ok).toBe(true); expect(faux.providerCalls).toBe(3);
    const {NativeFrameStore} = await import("./business-context/store.js");
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
    const {NativeFrameStore} = await import("./business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames).toHaveLength(1); expect(frames[0]?.status).toBe("clarifying");
    expect(faux.providerCalls).toBe(3);
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
    const {projectEntries}=await import("./sessionProjection.js");
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
    const context=faux.contexts.at(-1) as {systemPrompt:string};
    expect(context.systemPrompt).toContain("当前业务焦点");
    const {coverageContext} = await import("./queryContext.js");
    const entries = await reopened.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const projection = coverageContext(entries.filter(entry => entry.type === "message").map(entry => entry.message));
    for (const value of ["2020-01-01", "2026-09-21", '\"metric_code\":\"M\"', '\"page\":2', '\"has_more\":true']) expect(projection).toContain(value);
  } finally {await reopenedHost.close();await reopenedStore.close();}
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
    const {NativeFrameStore} = await import("./business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames[0]?.issues).toContainEqual({field: "$base", reason: "not_found"});
    expect(basicQueries).not.toHaveBeenCalled(); expect(faux.providerCalls).toBe(2);
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
    await host.runPrompt(session,{protocol_version:3,request_id:"no-coverage",message:"查询省联社贷款余额当日数"},{actor:ACTOR,backend:{submitQuestion,basicQueries,resolveBusinessField:async (_entity: string, names: string[])=>({status:"resolved",value:{codes:names,names}})} as unknown as BackendClient});
    expect(basicQueries).not.toHaveBeenCalled();
    expect(submitQuestion).not.toHaveBeenCalled();
    const entries=await session.lane.findEntries({},BACKGROUND_CONTEXT);
    expect(entryTexts(entries).join("\n")).toContain("请补充日期");
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
  const {projectEntries} = await import("./sessionProjection.js");
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
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "enum-correction", message: "查合成机构2026年5月18日合成余额本期数"}, {actor: ACTOR, backend});
    const {NativeFrameStore} = await import("./business-context/store.js");
    const frames = await new NativeFrameStore(session.session).list();
    expect(frames.map(frame => frame.status)).toEqual(["ready", "executing", "success"]);
    expect(frames.at(-1)?.fields.metrics?.rawValue).toBe("合成余额本期数");
    expect(basicQueries).toHaveBeenCalledTimes(1);
    expect(basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["FULL"], selection: "exact"});
    expect(faux.providerCalls).toBe(4);
    expect(faux.payloads.slice(0, 3).every(payload => (payload as {tool_choice?: string}).tool_choice !== "none")).toBe(true);
    expect(JSON.stringify(faux.contexts[1])).toContain("ARGUMENT_ERROR");
  } finally {await host.close(); await store.close();}
});

it("完整名称冲突经 pi 纠正，最终选择目标结果且原生重开不夹带目录排查", async () => {
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
  const store = new NativeSessionStore(dir);
  const makeHost = () => new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  const host = makeHost();
  const session = await host.createSession(ACTOR);
  const {projectEntries} = await import("./sessionProjection.js");
  try {
    await host.runPrompt(session, {protocol_version: 3, request_id: "collision", message: "演示行2026年3月31日贷款余额当日数"}, {actor: ACTOR, backend});
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({calculation_context: {user_question: "演示行2026年3月31日贷款余额当日数"}});
    const entries = await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const projected = projectEntries(entries);
    expect(projected.at(-1)).toMatchObject({role: "assistant", text: "演示行贷款余额当日数为1.123456元。"});
    expect(projected.some(m => m.role === "tool" && [EVIDENCE_REPAIR_TOOL, "answer_present"].includes(m.tool))).toBe(false);
    expect(faux.providerCalls).toBe(8);
    // 两次 READY 都就地执行；脚本里模型又主动发的 execute_business_frame 是重复调用，
    // 幂等复用原执行，不产生第二次查询，也不再需要宿主强制 tool_choice。
    for (const payload of faux.payloads) expect(payload).not.toHaveProperty("tool_choice");
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
  const {legacyToolsFor} = await import("./tools/index.js");
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
    expect(tools.sort()).toEqual(currentTools.map(tool => tool.name).sort());
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
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "wait-user", message: "合成简称 合成指标 2026年2月末"}, {actor: ACTOR, backend});
    expect(faux.providerCalls).toBe(3);
    expect(faux.payloads.at(-1)).toMatchObject({tool_choice: "none"});
    expect(faux.payloads.at(-1)).not.toHaveProperty("tools");
    expect(searchOrganizations).not.toHaveBeenCalled(); expect(basicQueries).not.toHaveBeenCalled();
    const {projectEntries} = await import("./sessionProjection.js");
    const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
    const last = messages.at(-1);
    expect(last?.role === "assistant" && last.text).toContain("请确认机构");
    expect(last?.role === "assistant" && last.text).toContain("合成全称");
  } finally {await host.close(); await store.close();}
});

it("交错目录调用不能绕过连续参数错误预算，焦点不被错误调用污染", async () => {
  const dir = tempDir();
  const delta = {executionMode: "execute", fieldChanges: []};
  const faux = createFauxModel([
    {kind: "toolCall", name: "resolve_business_turn", args: delta},
    {kind: "toolCall", name: "business_context_read", args: {}},
    {kind: "toolCall", name: "resolve_business_turn", args: {...delta, capabilityHint: "unknown"}},
    {kind: "toolCall", name: "resolve_business_turn", args: {...delta, capabilityHint: "metric_query", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: "非本轮原文"},
    ]}},
    {kind: "toolCall", name: "business_context_read", args: {}},
  ]);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(testConfig(dir), () => ({models: faux.models, model: faux.model}), store, createAskMetricTools());
  try {
    const session = await host.createSession(ACTOR);
    await host.runPrompt(session, {protocol_version: 3, request_id: "bad-input-loop", message: "继续"}, {actor: ACTOR, backend: {} as BackendClient});
    const {NativeFrameStore} = await import("./business-context/store.js");
    expect(await new NativeFrameStore(session.session).list()).toHaveLength(0);
    expect(faux.providerCalls).toBe(5);
    const {projectEntries} = await import("./sessionProjection.js");
    const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
    expect(messages.filter(message => message.role === "tool" && message.tool === "business_context_read")).toHaveLength(1);
    const last = messages.at(-1);
    expect(last?.role === "assistant" && last.text).toContain("已停止重复尝试");
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
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: [
      {fieldHint: "time", operation: "set", rawValue: "3月末"},
    ]}},
    // 执行已在解析回执里落地，模型仍主动发起一次错误历史引用：不得再查一次数。
    {kind: "toolCall", name: "execute_business_frame", args: {frameId: "错误的历史引用"}},
    {kind: "text", text: "第二轮查询完成。"},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}},
    ]}},
    {kind: "text", text: "第三轮查询完成。"},
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "metric_query", executionMode: "reuse_result", fieldChanges: []}},
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
    const {projectEntries} = await import("./sessionProjection.js");
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
    {kind: "toolCall", name: "resolve_business_turn", args: {capabilityHint: "data_availability", executionMode: mode === "resolve_more" ? "resolve_more" : "execute", fieldChanges: [
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
