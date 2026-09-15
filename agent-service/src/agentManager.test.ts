/**
 * 无真实模型与数据库的链路测试：pi-ai faux provider 脚本化模型响应，
 * 后端接口用全局 fetch 桩替代，验证 agent 工具循环与 SSE 事件序列。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentManager, type AgentUiEvent } from "./agentManager.js";
import type { AgentServiceConfig } from "./config.js";
import type { BackendUser } from "./backendClient.js";

const config: AgentServiceConfig = {
  host: "127.0.0.1",
  port: 8020,
  backendBaseUrl: "http://backend.test",
  backendTimeoutMs: 5000,
  model: { baseUrl: "http://model.test/v1", name: "faux-model", apiKey: "", authHeader: "Authorization", authPrefix: "Bearer ", userMessageSuffix: "", extraBody: {}, contextWindow: 128000, maxTokens: 8192 },
  dataDir: ".tmp-test-data",
  maxSessionsPerUser: 5,
};

const user: BackendUser = {
  id: "u1",
  username: "tester",
  display_name: "测试用户",
  org_code: "001",
  org_name: "测试机构",
  role_code: "USER",
};

function stubBackendFetch() {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: (init?.headers as Record<string, string>)?.Authorization ?? null });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
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
        query_shape: "value_query",
        columns: ["机构", "存款余额"],
        rows: [{ 机构: "测试机构", 存款余额: 12345.67 }],
        row_count: 1,
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

describe("AgentManager 工具循环", () => {
  beforeEach(() => stubBackendFetch());
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(".tmp-test-data", { recursive: true, force: true });
  });

  it("模型发起 metric_ask 工具调用并产出文本事件流", async () => {
    const backendCalls = stubBackendFetch();
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("metric_ask", { question: "2026年8月测试机构存款余额" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("2026年8月测试机构存款余额为 12345.67。")]),
    ]);

    const manager = new AgentManager(config, { models, model: faux.getModel() as never });
    const session = manager.createSession(user, "user-token");
    const events: AgentUiEvent[] = [];
    for await (const event of manager.promptStream(session, "查一下存款余额", "user-token")) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("text_delta");
    expect(types[types.length - 1]).toBe("done");

    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd && toolEnd.type === "tool_end" && toolEnd.tool).toBe("metric_ask");
    const details = toolEnd && toolEnd.type === "tool_end" ? (toolEnd.details as { status?: string; row_count?: number }) : {};
    expect(details.status).toBe("succeeded");
    expect(details.row_count).toBe(1);

    const text = events
      .filter((e): e is Extract<AgentUiEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toContain("12345.67");

    // 工具对后端的三步受治理调用全部透传用户 Bearer
    const governedCalls = backendCalls.filter((call) => call.url.includes("/api/v1/"));
    expect(governedCalls.map((call) => call.url)).toEqual([
      "http://backend.test/api/v1/questions",
      "http://backend.test/api/v1/query-tasks/task-1/analyze",
      "http://backend.test/api/v1/query-tasks/task-1/execute",
    ]);
    for (const call of governedCalls) {
      expect(call.authorization).toBe("Bearer user-token");
    }
  });

  it("会话持久化到磁盘，重启（新实例）后恢复消息与工具明细", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("metric_ask", { question: "存款余额" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已完成查询。")]),
    ]);

    const first = new AgentManager(config, { models, model: faux.getModel() as never });
    const session = first.createSession(user, "user-token");
    for await (const _event of first.promptStream(session, "查存款", "user-token")) {
      // 消费事件流直至结束
    }

    // 模拟服务重启：同一数据目录新建管理器
    const restored = new AgentManager(config, { models, model: faux.getModel() as never });
    const recovered = restored.getSession(session.id, user.id);
    expect(recovered).toBeDefined();
    const messages = recovered?.agent.state.messages ?? [];
    expect(messages.some((m) => (m as { role?: string }).role === "user")).toBe(true);
    const toolResults = messages.filter((m) => (m as { role?: string }).role === "toolResult");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as { details?: { status?: string } }).details?.status).toBe("succeeded");
  });
});
