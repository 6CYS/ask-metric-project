/**
 * 路由级集成测试：协议 V3 校验、原生 SSE 事件序列、历史投影与旧会话只读。
 * 模型用 faux provider 脚本，后端用全局 fetch 桩；不连真实服务。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Type,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { AgentServiceConfig } from "../src/config.js";
import { HarnessHost } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { NativeSemanticTaskStore } from "../src/semantic-task/store.js";
import type { PendingQuestion, QuestionBinding } from "../src/semantic-task/questions.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";
import { createApp, parsePromptInput } from "../src/routes.js";
import { loadBusinessSkills, createBusinessSkillReadTool } from "../src/businessSkills.js";

const skills = await loadBusinessSkills();
const runtimeTools = () => [...createAskMetricTools(), createBusinessSkillReadTool(skills)];

const USER = {
  id: "user-1",
  username: "user1",
  display_name: "测试用户",
  org_code: "3200",
  org_name: "测试机构",
  role_code: "USER",
};

/** 桩也经过真实 payload 钩子与分段输出，防止只验证最终快照而漏测流式路径。 */
function streamReply(message: AssistantMessage, beforePayload: () => unknown) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    await beforePayload();
    const partial = {...message, content: [] as AssistantMessage["content"], stopReason: "pending" as const};
    stream.push({type: "start", partial});
    const block = message.content[0]!;
    if (block.type === "text") {
      partial.content = [{type: "text", text: ""}];
      stream.push({type: "text_start", contentIndex: 0, partial});
      for (const text of [block.text.slice(0, 4), block.text]) {
        const previous = (partial.content[0] as {text: string}).text;
        partial.content = [{type: "text", text}];
        stream.push({type: "text_delta", contentIndex: 0, delta: text.slice(previous.length), partial: structuredClone(partial)});
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } else if (block.type === "toolCall") {
      partial.content = [{...block, arguments: {}}];
      stream.push({type: "toolcall_start", contentIndex: 0, partial: structuredClone(partial)});
      if (block.name === CONVERSATION_REPLY) {
        for (const answer of [String(block.arguments.answer).slice(0, 4), String(block.arguments.answer)]) {
          partial.content = [{...block, arguments: {answer}}];
          stream.push({type: "toolcall_delta", contentIndex: 0, delta: "", partial: structuredClone(partial)});
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    }
    stream.push({type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message});
    stream.end(message);
  });
  return stream;
}

function fauxModel(): { model: Model<"openai-completions">; models: ReturnType<typeof createModels> } {
  const model: Model<"openai-completions"> = {
    id: "faux-1",
    name: "faux-1",
    api: "openai-completions",
    provider: "faux",
    baseUrl: "http://faux.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
  let calls = 0;
  const respond: ProviderStreams["streamSimple"] = (_model, context, options) => {
    calls += 1;
    const message: AssistantMessage =
      calls <= 2
        ? {
            role: "assistant",
            content: [calls === 1
              ? { type: "toolCall", id: "skill-1", name: "business_skill_read", arguments: { name: "metric-query" } }
              : { type: "toolCall", id: "call-1", name: "resolve_business_turn", arguments: {
                protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, operations: [
                  {action: "set", field: "metrics", value: "存款余额"},
                  {action: "set", field: "organizations", value: "无锡分行"},
                  {action: "set", field: "time", value: "2026年8月"},
                  {action: "set", field: "selection", value: "latest_in_range"},
                ]}],
              }}],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: Date.now(),
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: "2026年8月无锡分行存款余额为 15147420074 元。" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          };
    return streamReply(message, () => options?.onPayload?.({tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []}, model));
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "faux",
      name: "faux",
      auth: { apiKey: { name: "faux", resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: { stream: respond, streamSimple: respond },
    }),
  );
  return { model, models };
}

/** 只做普通对话回答的模型桩：回答写在工具参数中，回执即结束本轮。 */
function replyModel(answer: string): { model: Model<"openai-completions">; models: ReturnType<typeof createModels>; calls: () => number } {
  const { model } = fauxModel();
  let calls = 0;
  const respond: ProviderStreams["streamSimple"] = (_model, context, options) => {
    calls += 1;
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "toolCall", id: `reply-${calls}`, name: CONVERSATION_REPLY, arguments: { answer } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return streamReply(message, () => options?.onPayload?.({tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []}, model));
  };
  const models = createModels();
  models.setProvider(createProvider({ id: "faux", name: "faux", auth: { apiKey: { name: "faux", resolve: async () => ({ auth: {} }) } },
    models: [model], api: { stream: respond, streamSimple: respond } }));
  return { model, models, calls: () => calls };
}

function stubBackendFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/auth/me")) {
        // 按 Bearer 区分身份，验证跨用户隔离
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        return json(auth === "Bearer token-2" ? { ...USER, id: "user-2", username: "user2" } : USER);
      }
      if (url.endsWith("/api/v1/business-context/inspect-goal")) {
        const payload = JSON.parse(String(init?.body)) as {question: string};
        const question = payload.question;
        const start = question.indexOf("存款余额");
        return json({question, reference_year: null, fragments: [{question,
          organizations: question.includes("无锡分行") ? ["WX01"] : [],
          calendar: {ranges: question.includes("2026年8月") ? [{start: "2026-08-01", end: "2026-08-31"}] : [], unresolved: []},
          mentions: start < 0 ? [] : [{text: "存款余额", start, end: start + 4,
            resolution: {status: "resolved", value: {codes: ["存款余额"], names: ["存款余额"]}}}],
        }]});
      }
      if (url.includes("/api/v1/catalog/organizations/search")) {
        return json({total: 1, items: [{org_code: "WX01", org_name: "无锡分行", score: 1, match_type: "exact"}]});
      }
      if (url.endsWith("/api/v1/business-context/admit-plan")) {
        const payload = JSON.parse(String(init?.body)) as {steps: Array<{target_ref: string}>};
        return json({status: "admitted", receipts: payload.steps.map(step => ({target_ref: step.target_ref, receipt: `receipt:${step.target_ref}`}))});
      }
      if (url.endsWith("/metric-mentions")) {
        const payload = JSON.parse(String(init?.body)) as {question: string};
        const start = payload.question.indexOf("存款余额");
        return json({mentions: start < 0 ? [] : [{text: "存款余额", start, end: start + 4,
          resolution: {status: "resolved", value: {codes: ["存款余额"], names: ["存款余额"]}}}]});
      }
      if (url.endsWith("/resolve-field")) {
        const payload = JSON.parse(String(init?.body));
        return json({status: "resolved", value: payload.entity === "date" ? {start: "2026-08-01", end: "2026-08-31"}
          : payload.entity === "organization" ? {codes: ["WX01"], names: ["无锡分行"]}
          : {codes: payload.raw_values, names: payload.raw_values},
          ...(payload.entity === "organization" ? {metadata: {source_codes: ["WX01"]}} : {})});
      }
      if (url.endsWith("/agent-query-contexts")) return json({conversation_id: "conv-1"});
      if (url.endsWith("/basic-queries")) return json({result: {
        task_id: "task-1", status: "succeeded", columns: ["org_name", "metric_value"],
        rows: [{org_name: "无锡分行", metric_name: "存款余额", stat_date: "2026-08-31", metric_value: "15147420074.00", unit: "元"}], row_count: 1,
      }});
      if (url.endsWith("/query-tasks/task-1")) {
        return json({
          task_id: "task-1",
          conversation_id: "conv-1",
          version: 2,
          status: "SUCCEEDED",
          result: { result_id: "result:task-1", status: "succeeded", row_count: 1 },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function testConfig(dataDir: string): AgentServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    backendBaseUrl: "http://backend.test",
    backendTimeoutMs: 5000,
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
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    modelRetry: { enabled: true, maxRetries: 1, baseDelayMs: 1_000 },
  };
}

interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

async function readSse(response: Response): Promise<SseEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
      const dataLines = block.split("\n").filter((line) => line.startsWith("data:"));
      if (eventLine && dataLines.length) {
        events.push({
          type: eventLine.slice(6).trim(),
          data: JSON.parse(dataLines.map((line) => line.slice(5).trim()).join("\n")),
        });
      }
      if (eventLine?.includes("run_terminal")) return events;
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

describe("路由：协议 V3 与原生投影", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ask-metric-routes-"));
    stubBackendFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  function buildApp(answerStreaming = false) {
    const config = {...testConfig(dir), answerStreaming};
    const store = new NativeSessionStore(dir);
    const { model, models } = fauxModel();
    const host = new HarnessHost(config, () => ({ models, model }), store, runtimeTools(), {skills});
    return createApp(config, host, store);
  }

  it("旧业务工具会话只读且不恢复在途执行，新会话仍可提问", async () => {
    const {BackendClient} = await import("../src/backendClient.js");
    const config = testConfig(dir);
    const firstStore = new NativeSessionStore(dir); const firstModel = fauxModel();
    const first = new HarnessHost(config, () => firstModel, firstStore, [{name: "metric_ask", label: "旧工具", description: "只读迁移测试", parameters: Type.Object({action: Type.String()}),
      execute: async () => {throw new Error("RETIRED_TOOL_MUST_NOT_EXECUTE");}}]);
    const session = await first.createSession(USER);
    const input = {protocol_version: 3 as const, request_id: "old-pending", message: "查询无锡分行2026年8月最新一期存款余额"};
    await first.admitPrompt(session, input, {actor: USER, backend: new BackendClient(config.backendBaseUrl, "token-1", 5000)});
    await first.close(); await firstStore.close();
    const store = new NativeSessionStore(dir); const model = fauxModel();
    const host = new HarnessHost(config, () => model, store, runtimeTools(), {skills});
    const app = createApp(config, host, store); const headers = {Authorization: "Bearer token-1"};
    try {
      const detail = await app.request(`/sessions/${session.sessionId}`, {headers});
      expect(await detail.json()).toMatchObject({legacy: true, running: false, read_only_reason: "LEGACY_QUERY_REQUIRES_NEW_TURN"});
      const listed = await app.request("/sessions", {headers});
      expect((await listed.json() as {items: unknown[]}).items).toContainEqual(expect.objectContaining({session_id: session.sessionId, legacy: true, running: false}));
      const streamed = await readSse(await app.request(`/sessions/${session.sessionId}/stream`, {headers}));
      expect(streamed[0]?.data).toMatchObject({legacy: true, running: false});
      expect(streamed.at(-1)?.type).toBe("run_terminal");
      const post = await app.request(`/sessions/${session.sessionId}/prompt`, {method: "POST", headers: {...headers, "Content-Type": "application/json"}, body: JSON.stringify(input)});
      expect(post.status).toBe(409); expect(await post.json()).toMatchObject({code: "LEGACY_QUERY_REQUIRES_NEW_TURN"});
      expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith("/auth/me"))).toBe(true);
      const fresh = await host.createSession(USER);
      expect(fresh.readOnlyReason).toBeUndefined();
      const admitted = await host.admitPrompt(fresh, {...input, request_id: "fresh"}, {actor: USER, backend: new BackendClient(config.backendBaseUrl, "token-1", 5000)});
      expect(admitted.ok).toBe(true);
    } finally {await host.close(); await store.close();}
  });

  it("重启后 GET 观察流推进原 operation，只创建一笔业务任务", async () => {
    const config = testConfig(dir);
    const firstStore = new NativeSessionStore(dir);
    const firstModel = fauxModel();
    const first = new HarnessHost(config, () => firstModel, firstStore, runtimeTools(), {skills});
    const session = await first.createSession(USER);
    // accept 已落盘，模型和业务工具尚未执行；重开后 current 与 open 同时非空。
    const { BackendClient } = await import("../src/backendClient.js");
    const admitted = await first.admitPrompt(session, {
      protocol_version: 3, request_id: "recovered-request", message: "查询无锡分行2026年8月最新一期存款余额",
    }, { actor: USER, backend: new BackendClient(config.backendBaseUrl, "token-1", 5000) });
    expect(admitted.ok).toBe(true);
    await first.close();
    await firstStore.close();

    const restoredStore = new NativeSessionStore(dir);
    const restoredModel = fauxModel();
    const restored = new HarnessHost(config, () => restoredModel, restoredStore, runtimeTools(), {skills});
    try {
      const app = createApp(config, restored, restoredStore);
      const response = await app.request(`/sessions/${session.sessionId}/stream`, {
        headers: { Authorization: "Bearer token-1" },
      });
      const events = await readSse(response);
      const initial = events.find(event => event.type === "snapshot")!;
      expect(initial.data.running).toBe(true);
      if (admitted.ok) expect(initial.data.operation_id).toBe(admitted.operationId);
      expect(events.at(-1)?.data).toMatchObject({ run_status: "completed",
        business_tasks: [{ task_id: "task-1", status: "succeeded", result_id: "result:task-1" }],
      });
      const requests = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
      expect(requests.filter(url => url.endsWith("/api/v1/questions"))).toHaveLength(0);
      expect(requests.filter(url => url.endsWith("/basic-queries"))).toHaveLength(1);
    } finally {
      await restored.close();
      await restoredStore.close();
    }
  });

  it("缺 protocol_version=3 的旧请求被拒绝", async () => {
    const app = buildApp();
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" },
    });
    expect(created.status).toBe(201);
    const { session_id: sessionId } = (await created.json()) as { session_id: string };

    const rejected = await app.request(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-1" },
      body: JSON.stringify({ message: "查存款余额" }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code?: string }).code).toBe("CLIENT_UPGRADE_REQUIRED");
  });

  it.each([
    {frame_id: "", option_ids: ["metrics:0:code:A"]},
    {frame_id: "f1", option_ids: []},
    {frame_id: "f1", option_ids: [1]},
    {frame_id: "f1", option_ids: ["metrics:0:code:A"], extra: true},
    ["f1"],
  ])("不合法的待确认点选整体拒绝：%j", async selection => {
    const app = buildApp();
    const created = await app.request("/sessions", {method:"POST", headers:{Authorization:"Bearer token-1"}});
    const {session_id} = await created.json() as {session_id:string};
    const response = await app.request(`/sessions/${session_id}/prompt`, {
      method:"POST", headers:{"Content-Type":"application/json",Authorization:"Bearer token-1"},
      body:JSON.stringify({protocol_version:3,request_id:"bad-selection",message:"对公日均存款余额当日数",clarification_selection:selection}),
    });
    expect(response.status).toBe(400);
  });

  it("已移除的强制新问题字段被拒绝，不再存在隐藏路由开关", async () => {
    const app = buildApp();
    const created = await app.request("/sessions", {method:"POST", headers:{Authorization:"Bearer token-1"}});
    const {session_id} = await created.json() as {session_id:string};
    const response = await app.request(`/sessions/${session_id}/prompt`, {
      method:"POST", headers:{"Content-Type":"application/json",Authorization:"Bearer token-1"},
      body:JSON.stringify({protocol_version:3,request_id:"retired",message:"演示查询",send_as:"new_question"}),
    });
    expect(response.status).toBe(400);
    expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).endsWith("/api/v1/questions"))).toBe(false);
  });

  it.each([false, true])("普通对话一次模型往返即交付，流式开关 %s：快照与历史回答一致", async answerStreaming => {
    const answer = "你好，我可以帮你查询经营指标、查看历史结果和解释指标口径。";
    const config = {...testConfig(dir), answerStreaming};
    const store = new NativeSessionStore(dir);
    const faux = replyModel(answer);
    const app = createApp(config, new HarnessHost(config, () => faux, store, runtimeTools(), {skills}), store);
    const headers = { Authorization: "Bearer token-1", "X-Agent-Answer-Streaming": "v1" };
    const { session_id: sessionId } = (await (await app.request("/sessions", { method: "POST", headers })).json()) as { session_id: string };

    const response = await app.request(`/sessions/${sessionId}/prompt`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ protocol_version: 3, request_id: "hello", message: "你好" }),
    });
    const events = await readSse(response);
    const terminal = events.at(-1)!;
    expect(terminal.type).toBe("run_terminal");
    expect(terminal.data).toMatchObject({ run_status: "completed", answer_status: "ok" });
    expect(faux.calls()).toBe(1);
    const snapshot = [...events].reverse().find(event => event.type === "snapshot")!.data as { messages: Array<{ role: string; text?: string }> };
    expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant", text: answer });
    // semantic_v2 轮的回答流式只适用于 frame_v1 历史协议，本轮不产生 answer_delta。
    expect(events.filter(event => event.type === "answer_delta")).toHaveLength(0);
    expect(events.some(event => event.type.startsWith("answer_"))).toBe(false);
    void answerStreaming;
    expect(terminal.data.timings_ms).toMatchObject({first_visible_ms: expect.any(Number), model_first_token_ms: [expect.any(Number)]});
    const detail = (await (await app.request(`/sessions/${sessionId}`, { headers })).json()) as { messages: Array<{ role: string; text?: string }> };
    expect(detail.messages.filter(message => message.role === "assistant" && message.text).map(message => message.text)).toEqual([answer]);
  });

  it("流式开关开启，旧 V3 页面未声明支持时仍使用原有快照事件序列", async () => {
    const config = {...testConfig(dir), answerStreaming: true};
    const store = new NativeSessionStore(dir); const faux = replyModel("你好。");
    const app = createApp(config, new HarnessHost(config, () => faux, store, runtimeTools(), {skills}), store);
    const headers = {Authorization: "Bearer token-1"};
    const created = await app.request("/sessions", {method: "POST", headers});
    const {session_id: id} = await created.json() as {session_id: string};
    const response = await app.request(`/sessions/${id}/prompt`, {method: "POST", headers: {...headers, "Content-Type": "application/json"},
      body: JSON.stringify({protocol_version: 3, request_id: "old-v3", message: "你好"})});
    const events = await readSse(response);
    expect(events.map(event => event.type).filter(type => type !== "activity")).toEqual([
      "accepted", "tool_start", "tool_end", "snapshot", "run_terminal",
    ]);
    expect(events.at(-1)!.data.timings_ms).toMatchObject({first_visible_ms: expect.any(Number)});
  });

  it.each([false, true])("完整提问，流式开关 %s：最终快照在临时回答之后，业务任务带 task_id", async answerStreaming => {
    const app = buildApp(answerStreaming);
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" },
    });
    const { session_id: sessionId } = (await created.json()) as { session_id: string };

    const response = await app.request(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-1", "X-Agent-Answer-Streaming": "v1" },
      body: JSON.stringify({
        protocol_version: 3,
        request_id: "req-1",
        message: "查询无锡分行2026年8月最新一期存款余额",
      }),
    });
    expect(response.status).toBe(200);
    const events = await readSse(response);
    const types = events.map((event) => event.type);
    expect(types).toContain("accepted");
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("snapshot");
    expect(types).not.toContain("text_delta");
    expect(types[types.length - 1]).toBe("run_terminal");
    // semantic_v2 轮的回答流式只适用于 frame_v1 历史协议，本轮不产生 answer_delta。
    expect(events.filter(event => event.type === "answer_delta")).toHaveLength(0);
    expect(types.some(type => type.startsWith("answer_"))).toBe(false);
    void answerStreaming;

    const terminal = events[events.length - 1]!.data;
    expect(terminal.run_status).toBe("completed");
    expect(terminal.answer_status).toBe("ok");
    expect(terminal.business_tasks).toEqual([{ task_id: "task-1", result_id: "result:task-1", status: "succeeded", error_code: null }]);
    expect(terminal.protocol_version).toBe(3);

    // 历史投影：原生记录重读得到同一消息序列
    const history = await app.request(`/sessions/${sessionId}`, {
      headers: { Authorization: "Bearer token-1" },
    });
    const detail = (await history.json()) as { messages: Array<{ text?: string }> };
    const texts = detail.messages.map((message: { text?: string }) => message.text ?? "");
    expect(texts).toContain("查询无锡分行2026年8月最新一期存款余额");
    expect(texts.some((text: string) => text.includes("15147420074"))).toBe(true);
  });

  it("他人会话与不存在会话一律 404，不泄露存在性", async () => {
    const app = buildApp();
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" },
    });
    const { session_id: sessionId } = (await created.json()) as { session_id: string };

    // 伪造另一用户身份：桩按 Bearer 区分用户
    const other = await app.request(`/sessions/${sessionId}`, {
      headers: { Authorization: "Bearer token-2" },
    });
    expect(other.status).toBe(404);
    const missing = await app.request("/sessions/00000000-0000-4000-8000-000000000000", {
      headers: { Authorization: "Bearer token-1" },
    });
    expect(missing.status).toBe(404);
  });

  it("列表读取标题后再打开会话不冲突（会话打开去重回归）", async () => {
    const app = buildApp();
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" },
    });
    const { session_id: sessionId } = (await created.json()) as { session_id: string };

    // 列表会只读打开每个会话取标题；随后详情/提问必须复用同一 Session 对象
    const list = await app.request("/sessions", { headers: { Authorization: "Bearer token-1" } });
    expect(list.status).toBe(200);
    const detail = await app.request(`/sessions/${sessionId}`, { headers: { Authorization: "Bearer token-1" } });
    expect(detail.status).toBe(200);
    const response = await app.request(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-1" },
      body: JSON.stringify({ protocol_version: 3, request_id: "req-dup", message: "查询存款余额" }),
    });
    expect(response.status).toBe(200);
    const events = await readSse(response);
    expect(events[events.length - 1]!.type).toBe("run_terminal");
  });

  it("旧 JSON 会话只读可见，不可提问", async () => {
    // 旧 SessionStore 快照：切换后仅保留只读展示
    writeFileSync(
      join(dir, "00000000-0000-4000-8000-0000000000aa.json"),
      JSON.stringify({
        id: "00000000-0000-4000-8000-0000000000aa",
        userId: "user-1",
        username: "user1",
        title: "旧会话",
        createdAt: 1,
        lastActiveAt: 2,
        messages: [{ role: "user", content: "旧问题", timestamp: 1 }],
      }),
    );
    const app = buildApp();
    const detail = await app.request("/sessions/00000000-0000-4000-8000-0000000000aa", {
      headers: { Authorization: "Bearer token-1" },
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { legacy?: boolean; messages: Array<{ text?: string }> };
    expect(body.legacy).toBe(true);
    expect(body.messages[0]?.text).toBe("旧问题");

    const prompt = await app.request("/sessions/00000000-0000-4000-8000-0000000000aa/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-1" },
      body: JSON.stringify({ protocol_version: 3, request_id: "req-x", message: "继续" }),
    });
    expect(prompt.status).toBe(404);
  });
  it("request身份可在接纳前停止，迟到POST被拒绝且不能跨用户取消",async()=>{
    const app=buildApp(),headers={Authorization:"Bearer token-1","Content-Type":"application/json"};
    const created=await app.request("/sessions",{method:"POST",headers});const {session_id}=await created.json() as {session_id:string};
    const path=`/sessions/${session_id}/cancel`,body=JSON.stringify({request_id:"stopped-request"});
    expect((await app.request(path,{method:"POST",headers:{...headers,Authorization:"Bearer token-2"},body})).status).toBe(404);
    expect((await app.request(path,{method:"POST",headers,body})).status).toBe(204);
    expect((await app.request(path,{method:"POST",headers,body})).status).toBe(204);
    const delayed=await app.request(`/sessions/${session_id}/prompt`,{method:"POST",headers,body:JSON.stringify({protocol_version:3,request_id:"stopped-request",message:"不能执行的迟到请求"})});
    expect(delayed.status).toBe(400);expect(await delayed.json()).toMatchObject({code:"REQUEST_CANCELLED"});
    expect((await app.request(path,{method:"POST",headers,body:JSON.stringify({operation_id:"op",request_id:"request"})})).status).toBe(400);
  });

  it("V3 answers 严格解析，允许纯点击并保留 time_override", () => {
    const answer = {question_id: "q1", version: 1, choice: {type: "select", option_ids: ["opt-b", "opt-a"]}};
    expect(parsePromptInput({protocol_version: 3, request_id: "answers", message: " ", answers: [answer],
      time_override: {start: "2026-09-01", end: "2026-09-30"}})).toEqual({
      protocol_version: 3, request_id: "answers", message: "",
      answers: [{question_id: "q1", version: 1, choice: {type: "select", option_ids: ["opt-a", "opt-b"]}}],
      time_override: {start: "2026-09-01", end: "2026-09-30"},
    });
    expect(parsePromptInput({protocol_version: 3, request_id: "empty", message: " "})).toBeNull();
    expect(parsePromptInput({protocol_version: 3, request_id: "empty", message: "", answers: []})).toBeNull();
    expect(parsePromptInput({protocol_version: 3, request_id: "bad-message", message: 1, answers: [answer]})).toBeNull();
    expect(parsePromptInput({protocol_version: 3, request_id: "missing-message", answers: [answer]})).toBeNull();
    expect(parsePromptInput({protocol_version: 3, request_id: "too-many", message: "", answers:
      Array.from({length: 21}, (_, index) => ({...answer, question_id: `q${index}`}))})).toBeNull();
    for (const extra of [{source: {}}, {channel: "click"}, {evidence: {excerpt: "伪造"}}, {unknown: true}]) {
      expect(parsePromptInput({protocol_version: 3, request_id: "invalid", message: "", answers: [{...answer, ...extra}]})).toBeNull();
    }
    expect(parsePromptInput({protocol_version: 3, request_id: "invalid-choice", message: "", answers: [
      {...answer, choice: {type: "select", option_ids: ["opt-a"], evidence: {}}},
    ]})).toBeNull();
    expect(parsePromptInput({protocol_version: 3, request_id: "mixed", message: "", answers: [answer],
      clarification_selection: {frame_id: "old", option_ids: ["opt-a"]}})).toBeNull();
    expect(parsePromptInput({protocol_version: 3, request_id: "mixed", message: "", answers: [answer], selected_answers: {metrics: "opt-a"}})).toBeNull();
    expect(parsePromptInput({protocol_version: 3, request_id: "mixed", message: "", answers: [answer],
      clarification_target: {task_id: "old", clarification_id: "old", version: 0}})).toBeNull();
  });

  it("semantic_v2 收到旧 clarification_selection 返回明确不支持", async () => {
    const app = buildApp(), headers = {Authorization: "Bearer token-1", "Content-Type": "application/json"};
    const created = await app.request("/sessions", {method: "POST", headers});
    const {session_id} = await created.json() as {session_id: string};
    const response = await app.request(`/sessions/${session_id}/prompt`, {method: "POST", headers,
      body: JSON.stringify({protocol_version: 3, request_id: "legacy-click", message: "选第一个",
        clarification_selection: {frame_id: "old-frame", option_ids: ["old-option"]}})});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({code: "CLARIFICATION_SELECTION_UNSUPPORTED", detail: expect.stringContaining("answers")});
  });

  it("GET、重连 snapshot 和提问 accepted/final snapshot 只投影可见问题最新状态", async () => {
    const config = testConfig(dir), store = new NativeSessionStore(dir), faux = replyModel("好的。");
    const host = new HarnessHost(config, () => faux, store, runtimeTools(), {skills});
    const app = createApp(config, host, store), headers = {Authorization: "Bearer token-1", "Content-Type": "application/json"};
    const question = {question_id: "q-visible", version: 1,
      scope: {task_ref: "plan", target_ref: "target", field: "metrics" as const, item_ref: "item"},
      prompt: "请选择指标", selection_mode: "single" as const, options: [{option_id: "opt-1", no: 1, label: "合成指标"}],
      status: "open" as const, issued_operation_id: "issued", kind: "choice" as const};
    const feedback = {protocol_version: 2, status: "needs_user",
      state: {task_status: "waiting_input", completion: "unmet", raw_message_retained: true, proposals_retained: true, targets: []},
      issues: [], continuation: {actor: "user", action: "ask_user"}, pending_questions: [question], answer_receipts: []};
    const states = vi.spyOn(NativeSemanticTaskStore.prototype, "questionStates").mockImplementation(async ids =>
      ids.flatMap(id => id === question.question_id ? [{question_id: id, version: 2, status: "answered" as const}] : []));
    try {
      const hosted = await host.createSession(USER);
      await hosted.harness.setName("问数会话", BACKGROUND_CONTEXT);
      await hosted.lane.appendMessage({role: "user", content: "原问题", timestamp: 1}, BACKGROUND_CONTEXT);
      await hosted.lane.appendMessage({role: "toolResult", toolName: "resolve_business_turn", toolCallId: "resolve",
        content: [{type: "text", text: JSON.stringify(feedback)}], details: feedback, isError: false, timestamp: 2}, BACKGROUND_CONTEXT);
      const detailResponse = await app.request(`/sessions/${hosted.sessionId}`, {headers});
      const detail = await detailResponse.json() as {question_states: unknown; messages: Array<{role: string; details?: {pending_questions?: unknown[]}}>};
      expect(detail.question_states).toEqual([{question_id: "q-visible", version: 2, status: "answered"}]);
      expect(detail.messages.find(message => message.role === "tool")?.details?.pending_questions).toHaveLength(1);
      const reconnected = await readSse(await app.request(`/sessions/${hosted.sessionId}/stream`, {headers}));
      expect(reconnected.find(event => event.type === "snapshot")?.data.question_states)
        .toEqual([{question_id: "q-visible", version: 2, status: "answered"}]);
      const prompted = await readSse(await app.request(`/sessions/${hosted.sessionId}/prompt`, {method: "POST", headers,
        body: JSON.stringify({protocol_version: 3, request_id: "states", message: "你好"})}));
      expect(prompted.find(event => event.type === "accepted")?.data.snapshot)
        .toMatchObject({question_states: [{question_id: "q-visible", version: 2, status: "answered"}]});
      expect([...prompted].reverse().find(event => event.type === "snapshot")?.data.question_states)
        .toEqual([{question_id: "q-visible", version: 2, status: "answered"}]);
      expect(states.mock.calls.every(([ids]) => ids.length === 1 && ids[0] === "q-visible")).toBe(true);
    } finally {
      states.mockRestore();
      await host.close(); await store.close();
    }
  });

  it("仅有机构候选的历史在撤权后 GET 与 SSE 一致脱敏且不补问题状态", async () => {
    const config = testConfig(dir), store = new NativeSessionStore(dir), faux = replyModel("好的。");
    const host = new HarnessHost(config, () => faux, store, runtimeTools(), {skills});
    const app = createApp(config, host, store), headers = {Authorization: "Bearer token-1"};
    const question: PendingQuestion = {question_id: "q-org-history", version: 1,
      scope: {task_ref: "plan", target_ref: "target", field: "organizations", item_ref: "item"},
      prompt: "请选择机构", selection_mode: "multiple", status: "open", issued_operation_id: "issued", kind: "choice",
      options: [{option_id: "opt-WX01", no: 1, label: "无锡分行"}, {option_id: "opt-REVOKED", no: 2, label: "失权机构"}]};
    const binding: QuestionBinding = {question_id: question.question_id, version: 1, reason: "candidate_choice",
      planRef: "plan", targetRef: "target", taskRef: "task", item_ref: "item", resolutionBasis: {}, receipts: [],
      options: [{option_id: "opt-WX01", candidateKey: "WX01", candidate: {code: "WX01", value: "无锡分行"}},
        {option_id: "opt-REVOKED", candidateKey: "REVOKED", candidate: {code: "REVOKED", value: "失权机构"}}],
      businessBasis: {field: "organizations", kind: "choice", prompt: question.prompt, selection_mode: "multiple",
        options: [{key: "WX01", label: "无锡分行"}, {key: "REVOKED", label: "失权机构"}]}};
    const feedback = {protocol_version: 2, status: "needs_user",
      state: {task_status: "waiting_input", completion: "unmet", raw_message_retained: true, proposals_retained: true, targets: []},
      issues: [], continuation: {actor: "user", action: "ask_user"}, pending_questions: [question], answer_receipts: []};
    const reader = vi.spyOn(NativeSemanticTaskStore.prototype, "question").mockImplementation(async () => ({question, binding, revision: 0, itemKey: "item"}));
    const states = vi.spyOn(NativeSemanticTaskStore.prototype, "questionStates").mockResolvedValue([]);
    try {
      const hosted = await host.createSession(USER);
      await hosted.lane.appendMessage({role: "user", content: "原问题", timestamp: 1}, BACKGROUND_CONTEXT);
      await hosted.lane.appendMessage({role: "toolResult", toolName: "resolve_business_turn", toolCallId: "resolve",
        content: [{type: "text", text: JSON.stringify(feedback)}], details: feedback, isError: false, timestamp: 2}, BACKGROUND_CONTEXT);
      const detailResponse = await app.request(`/sessions/${hosted.sessionId}`, {headers});
      const detail = await detailResponse.json() as {question_states: unknown[]; messages: Array<{role: string; details?: {history_redacted?: boolean}}>};
      expect(detail.messages.find(message => message.role === "tool")?.details?.history_redacted).toBe(true);
      expect(detail.question_states).toEqual([]);
      const streamed = await readSse(await app.request(`/sessions/${hosted.sessionId}/stream`, {headers}));
      const snapshot = streamed.find(event => event.type === "snapshot")?.data;
      expect(snapshot?.question_states).toEqual([]);
      expect((snapshot?.messages as Array<{role: string; details?: {history_redacted?: boolean}}>).find(message => message.role === "tool")?.details?.history_redacted).toBe(true);
      expect(states).not.toHaveBeenCalled();
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => String(init?.body).includes("REVOKED"))).toBe(true);
    } finally {
      reader.mockRestore(); states.mockRestore();
      await host.close(); await store.close();
    }
  });

});
