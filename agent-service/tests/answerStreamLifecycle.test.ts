import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost, type HostedSession } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import type { AskMetricRequestContext } from "../src/requestContext.js";
import { TEST_ACTOR } from "../src/tools/testUtils.js";

const model: Model<"openai-completions"> = {
  id: "isolated",
  name: "isolated",
  api: "openai-completions",
  provider: "isolated",
  baseUrl: "https://unused.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type Scenario = "retry" | "query" | "cancel" | "length";
type Observation = { event: string; stream: AskMetricRequestContext["answerStream"] };

// 运行真实原生宿主；只替换模型服务和工具执行边界，核对传给观察者的生命周期身份。
async function observeLifecycle(scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "answer-stream-lifecycle-"));
  const store = new NativeSessionStore(directory);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let session: HostedSession;
  let request: AskMetricRequestContext | undefined;
  let calls = 0;
  const observed: Observation[] = [];
  const record = (event: string) =>
    observed.push({ event, stream: request?.answerStream && { ...request.answerStream } });
  let waiting!: () => void;
  const modelWaiting = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const stream: ProviderStreams["streamSimple"] = (_model, context, options) => {
    if (++calls > 2) throw new Error("UNEXPECTED_MODEL_CALL");
    const first = calls === 1;
    const failure = scenario === "retry" && first;
    const query = scenario === "query" && first;
    const toolName = query ? "metric_search" : "analysis_answer";
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${calls}`, name: toolName, arguments: {} }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: failure
        ? "error"
        : scenario === "cancel"
          ? "aborted"
          : scenario === "length"
            ? "length"
            : "toolUse",
      ...(failure ? { errorMessage: "503 service unavailable" } : {}),
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    };
    if (scenario === "length") message.content = [{ type: "text", text: "未完整正文" }];
    const events = createAssistantMessageEventStream();
    void (async () => {
      await options?.onPayload?.(
        {
          messages: context.messages,
          tools: context.tools?.map((tool) => ({
            type: "function",
            function: { name: tool.name, parameters: tool.parameters },
          })),
        },
        model,
      );
      request = session.activeRequest;
      record("payload");
      events.push({ type: "start", partial: message });
      if (scenario === "length") {
        events.push({ type: "text_start", contentIndex: 0, partial: message });
        events.push({ type: "text_delta", contentIndex: 0, delta: "未完整正文", partial: message });
      } else {
        events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        events.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message });
      }
      if (scenario === "cancel") {
        const aborted = new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        waiting();
        await aborted;
      }
      if (failure || scenario === "cancel")
        events.push({
          type: "error",
          reason: scenario === "cancel" ? "aborted" : "error",
          error: message,
        });
      else
        events.push({
          type: "done",
          reason: scenario === "length" ? "length" : "toolUse",
          message,
        });
      events.end(message);
    })().catch((error: unknown) =>
      events.end({ ...message, stopReason: "error", errorMessage: String(error) }),
    );
    return events;
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: model.name,
      models: [model],
      auth: {
        apiKey: {
          name: "isolated",
          resolve: () => Promise.resolve({ auth: { apiKey: "unused" } }),
        },
      },
      api: { stream, streamSimple: stream },
    }),
  );
  const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
    {
      name: "metric_search",
      label: "隔离检索",
      description: "隔离工具边界",
      parameters: Type.Object({}),
      execute: () =>
        Promise.resolve({
          content: [],
          details: { kind: "metric_catalog", status: "ok", items: [] },
        }),
    },
    {
      name: "analysis_answer",
      label: "隔离报告",
      description: "隔离工具边界",
      parameters: Type.Object({}),
      execute: () =>
        Promise.resolve({
          content: [],
          details: { kind: "business_report", status: "succeeded", public_answer: "正式回答" },
          terminate: true,
        }),
    },
  ];
  const config = loadConfig({
    AGENT_MODEL_API_KEY: "unused",
    AGENT_MODEL_BASE_URL: model.baseUrl,
    AGENT_MODEL_NAME: model.id,
    AGENT_DATA_DIR: directory,
    AGENT_COMPACTION_ENABLED: "false",
    AGENT_ANSWER_STREAMING: "true",
    AGENT_MODEL_RETRY_ENABLED: "true",
    AGENT_MODEL_MAX_RETRIES: "1",
    AGENT_MODEL_RETRY_BASE_DELAY_MS: "1",
  });
  const host = new HarnessHost(config, () => ({ models, model }), store, tools);
  try {
    session = await host.createSession(TEST_ACTOR);
    session.harness.events.on("retry_start", () => {
      record("retry_start");
    });
    session.harness.events.on("message_update", () => {
      record("message_update");
    });
    session.harness.events.on("message_end", (event) => {
      if (event.message.role === "assistant") record("message_end");
    });
    session.harness.events.on("tool_start", (event) => {
      record(`${event.toolName}:start`);
    });
    session.harness.events.on("tool_end", (event) => {
      record(`${event.toolName}:end`);
    });
    const pending = host.runPrompt(
      session,
      { protocol_version: 3, request_id: scenario, message: "查询存款" },
      { actor: TEST_ACTOR, backend: {} as BackendClient },
    );
    if (scenario === "cancel") {
      await modelWaiting;
      expect(request).toBeDefined();
      await host.abort(session, request?.operationId ?? "");
      record("explicit_abort");
    }
    await pending;
    record("settled");
    return observed;
  } finally {
    await host.close();
    await store.close();
    log.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("正文预览身份的原生生命周期", () => {
  it("模型重试失效旧正文并分配新的调用序号，报告开始期间保持身份", async () => {
    const observed = await observeLifecycle("retry");
    expect(
      observed.filter((item) => item.event === "payload").map((item) => item.stream?.callSeq),
    ).toEqual([1, 2]);
    expect(observed.find((item) => item.event === "retry_start")?.stream?.mode).toBe("none");
    expect(observed.find((item) => item.event === "analysis_answer:start")?.stream).toEqual({
      callSeq: 2,
      mode: "text",
    });
    expect(observed.find((item) => item.event === "analysis_answer:end")?.stream?.mode).toBe(
      "none",
    );
    expect(observed.at(-1)?.stream?.mode).toBe("none");
  });
  it("切回查询工具时撤回正文资格，下一次调用重新取得身份", async () => {
    const observed = await observeLifecycle("query");
    expect(observed.find((item) => item.event === "message_update")?.stream?.mode).toBe("none");
    expect(observed.find((item) => item.event === "metric_search:start")?.stream?.mode).toBe(
      "none",
    );
    expect(observed.find((item) => item.event === "analysis_answer:start")?.stream).toEqual({
      callSeq: 2,
      mode: "text",
    });
  });
  it.each(["cancel", "length"] as const)("%s 不允许重连继续保留已撤回草稿", async (scenario) => {
    const observed = await observeLifecycle(scenario);
    expect(observed.find((item) => item.event === "message_end")?.stream?.mode).toBe("none");
    if (scenario === "cancel")
      expect(observed.find((item) => item.event === "explicit_abort")?.stream?.mode).toBe("none");
    expect(observed.at(-1)?.stream?.mode).toBe("none");
  });
});
