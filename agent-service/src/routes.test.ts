/**
 * 路由级集成测试：协议 V3 校验、原生 SSE 事件序列、历史投影与旧会话只读。
 * 模型用 faux provider 脚本，后端用全局 fetch 桩；不连真实服务。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  const respond = (): ReturnType<typeof createAssistantMessageEventStream> => {
    calls += 1;
    const message: AssistantMessage =
      calls === 1
        ? {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "metric_ask", arguments: { action: "new" } }],
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
      if (url.endsWith("/api/v1/questions")) {
        return json({ task_id: "task-1", conversation_id: "conv-1", version: 0, status: "RUNNING" });
      }
      if (url.endsWith("/analyze")) {
        return json({ task_id: "task-1", conversation_id: "conv-1", version: 1, status: "RUNNING" });
      }
      if (url.endsWith("/execute")) {
        return json({
          task_id: "task-1",
          status: "succeeded",
          query_shape: "metric_value",
          columns: ["org_name", "metric_value"],
          rows: [{ org_name: "无锡分行", metric_value: "15147420074.00" }],
          row_count: 1,
        });
      }
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
    const host = new HarnessHost(config, () => ({ models, model }), store, createAskMetricTools());
    return createApp(config, host, store);
  }

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
    expect(types).toContain("message_done");
    expect(types[types.length - 1]).toBe("run_terminal");

    const terminal = events[events.length - 1]!.data;
    expect(terminal.run_status).toBe("completed");
    expect(terminal.answer_status).toBe("ok");
    expect(terminal.business_tasks).toEqual([{ task_id: "task-1", result_id: "result:task-1" }]);
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
