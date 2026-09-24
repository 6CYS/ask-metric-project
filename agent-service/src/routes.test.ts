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
} from "@earendil-works/pi-ai";
import type { AgentServiceConfig } from "./config.js";
import { HarnessHost } from "./harnessHost.js";
import { NativeSessionStore } from "./nativeSessions.js";
import { createAskMetricTools } from "./tools/index.js";
import { createApp } from "./routes.js";
import { loadBusinessSkills, createBusinessSkillReadTool } from "./businessSkills.js";

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
  const respond = (_model: unknown, _context: {messages: unknown[]}): ReturnType<typeof createAssistantMessageEventStream> => {
    calls += 1;
    const message: AssistantMessage =
      calls <= 2
        ? {
            role: "assistant",
            content: [calls === 1
              ? { type: "toolCall", id: "skill-1", name: "business_skill_read", arguments: { name: "metric-query" } }
              : { type: "toolCall", id: "call-1", name: "resolve_business_turn", arguments: {
                capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
                  {fieldHint: "metrics", operation: "set", rawValue: "存款余额"},
                  {fieldHint: "organizations", operation: "set", rawValue: "无锡分行"},
                  {fieldHint: "time", operation: "set", rawValue: "2026年8月"},
                  {fieldHint: "selection", operation: "set", rawValue: "latest_in_range"},
                ],
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
      if (url.endsWith("/metric-mentions")) {
        const payload = JSON.parse(String(init?.body)) as {question: string};
        const start = payload.question.indexOf("存款余额");
        return json({mentions: start < 0 ? [] : [{text: "存款余额", start, end: start + 4,
          resolution: {status: "resolved", value: {codes: ["存款余额"], names: ["存款余额"]}}}]});
      }
      if (url.endsWith("/resolve-field")) {
        const payload = JSON.parse(String(init?.body));
        return json({status: "resolved", value: payload.entity === "date" ? {start: "2026-08-01", end: "2026-08-31"} : {codes: payload.raw_values, names: payload.raw_values}});
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
    maxSessionsPerUser: 20,
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

  function buildApp() {
    const config = testConfig(dir);
    const store = new NativeSessionStore(dir);
    const { model, models } = fauxModel();
    const host = new HarnessHost(config, () => ({ models, model }), store, runtimeTools(), {skills});
    return createApp(config, host, store);
  }

  it("旧业务工具会话只读且不恢复在途执行，新会话仍可提问", async () => {
    const {BackendClient} = await import("./backendClient.js");
    const config = testConfig(dir);
    const firstStore = new NativeSessionStore(dir); const firstModel = fauxModel();
    const first = new HarnessHost(config, () => firstModel, firstStore, [{name: "metric_ask", label: "旧工具", description: "只读迁移测试", parameters: Type.Object({action: Type.String()}),
      execute: async () => {throw new Error("RETIRED_TOOL_MUST_NOT_EXECUTE");}}]);
    const session = await first.createSession(USER);
    const input = {protocol_version: 3 as const, request_id: "old-pending", message: "查询2026年8月无锡分行存款余额"};
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
    const { BackendClient } = await import("./backendClient.js");
    const admitted = await first.admitPrompt(session, {
      protocol_version: 3, request_id: "recovered-request", message: "查询2026年8月无锡分行存款余额",
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

  it("完整提问：accepted → 工具事件 → run_terminal，业务任务带 task_id", async () => {
    const app = buildApp();
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" },
    });
    const { session_id: sessionId } = (await created.json()) as { session_id: string };

    const response = await app.request(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-1" },
      body: JSON.stringify({
        protocol_version: 3,
        request_id: "req-1",
        message: "查询2026年8月无锡分行存款余额",
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
    expect(texts).toContain("查询2026年8月无锡分行存款余额");
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
});
