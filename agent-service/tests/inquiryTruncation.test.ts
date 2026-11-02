import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  isRetryableAssistantError,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost } from "../src/harnessHost.js";
import { inquiryResponse } from "../src/inquiry/runtime.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { projectEntries } from "../src/sessionProjection.js";
import { PARTIAL_ANALYSIS } from "../src/tools/partialAnalysis.js";
import { MemoryCommandBridge, TEST_ACTOR, testRequestContext } from "../src/tools/testUtils.js";

const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
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

function truncated(text = "未完整生成的分析987654元"): Parameters<typeof inquiryResponse>[0] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 0,
    stopReason: "length",
    usage: {
      input: 0,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function evidence(operationId = request.operationId): AgentMessage {
  return {
    role: "toolResult",
    toolName: "metric_query",
    toolCallId: "query",
    timestamp: 0,
    content: [],
    isError: false,
    details: {
      kind: "analysis_evidence",
      status: "succeeded",
      run_ref: "current-run",
      scope_id: operationId,
      execution_turn_id: operationId,
    },
  };
}

describe("模型输出截断的交付边界", () => {
  it.each(["未完整生成的分析987654元", ""])(
    "无本轮证据时显式失败，不把截断正文封成报告或静默完成：%s",
    (text) => {
      const result = inquiryResponse(truncated(text), request, []);
      expect(result).toMatchObject({ stopReason: "error", content: [] });
      expect(result.errorMessage).toContain("MODEL_OUTPUT_TRUNCATED");
      expect(isRetryableAssistantError(result)).toBe(false);
    },
  );

  it("有本轮证据时只走既有部分交付，不保留截断草稿", () => {
    const result = inquiryResponse(truncated(), request, [evidence()]);
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: `inquiry-recovery-${request.operationId}`,
          name: PARTIAL_ANALYSIS,
          arguments: { reason: "model_failure" },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("987654");
  });

  it("历史证据不能将截断恢复成本轮成功回答", () => {
    expect(inquiryResponse(truncated(), request, [evidence("old-operation")])).toMatchObject({
      stopReason: "error",
      content: [],
    });
  });

  it("预算内的截断工具调用保留原生 length 状态", () => {
    const message = truncated();
    message.content.push({
      type: "toolCall",
      id: "cut",
      name: "analysis_answer",
      arguments: { body: "草稿" },
    });
    expect(inquiryResponse(message, request, [evidence()])).toBe(message);
  });

  it.each([true, false])("预算耗尽后不再循环截断工具；存在当前来源=%s", (current) => {
    const message = truncated();
    message.content.push({
      type: "toolCall",
      id: "cut",
      name: "analysis_answer",
      arguments: { body: "草稿" },
    });
    const messages = Array.from({ length: 18 }, () =>
      evidence(current ? request.operationId : "old-operation"),
    );
    const result = inquiryResponse(message, request, messages);
    expect(JSON.stringify(result.content)).not.toContain("草稿");
    if (current)
      expect(result.content).toEqual([
        {
          type: "toolCall",
          id: `inquiry-recovery-${request.operationId}`,
          name: PARTIAL_ANALYSIS,
          arguments: { reason: "model_failure" },
        },
      ]);
    else expect(result).toMatchObject({ stopReason: "error", content: [] });
  });

  it("原生宿主将无来源的截断正文结束为失败，历史也不展示草稿", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inquiry-truncation-"));
    const store = new NativeSessionStore(directory);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let calls = 0;
    const stream: ProviderStreams["streamSimple"] = (_model, context, options) => {
      if (++calls > 1) throw new Error("不应重试截断回答");
      const events = createAssistantMessageEventStream();
      const message = truncated();
      void (async () => {
        await options?.onPayload?.({ messages: context.messages, tools: [] }, model);
        events.push({ type: "start", partial: message });
        events.push({ type: "done", reason: "length", message });
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
    const config = loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id,
      AGENT_DATA_DIR: directory,
      AGENT_COMPACTION_ENABLED: "false",
    });
    const host = new HarnessHost(config, () => ({ models, model }), store, []);
    try {
      const session = await host.createSession(TEST_ACTOR);
      const result = await host.runPrompt(
        session,
        {
          protocol_version: 3,
          request_id: "truncated",
          message: "说明当前存款情况",
        },
        { actor: TEST_ACTOR, backend: {} as BackendClient },
      );
      expect(result).toMatchObject({
        ok: true,
        outcome: { kind: "settled", outcome: { status: "failed" } },
      });
      expect(calls).toBe(1);
      const entries = await session.lane.findEntries(
        { type: "message", order: "oldestFirst" },
        BACKGROUND_CONTEXT,
      );
      const answers = projectEntries(entries).filter((item) => item.role === "assistant");
      expect(answers).toHaveLength(1);
      expect(answers[0]?.text).not.toBe("");
      expect(JSON.stringify(answers)).not.toContain("987654");
      const responseLogs = log.mock.calls.flatMap(([line]) =>
        typeof line === "string" && line.includes('"event":"model_response"')
          ? [JSON.parse(line) as Record<string, unknown>]
          : [],
      );
      expect(responseLogs).toHaveLength(1);
      expect(responseLogs[0]).toMatchObject({
        request_id: "truncated",
        session_id: session.sessionId,
        call_seq: 1,
        stop_reason: "length",
        content_block_count: 1,
        content_blocks: [{ type: "text", bytes: Buffer.byteLength("未完整生成的分析987654元") }],
      });
      expect(JSON.stringify(responseLogs)).not.toContain("987654");
    } finally {
      await host.close();
      await store.close();
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
