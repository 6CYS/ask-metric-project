import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BACKGROUND_CONTEXT, type AgentHarnessTool} from "@earendil-works/pi-agent-core";
import {createAssistantMessageEventStream, createModels, createProvider, Type,
  type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {describe, expect, it, vi} from "vitest";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {loadConfig} from "../src/config.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import type {AskMetricRequestContext} from "../src/requestContext.js";
import {createPartialAnalysisTool} from "../src/tools/partialAnalysis.js";
import {createConversationReplyTool} from "../src/tools/turnContract.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

const model: Model<"openai-completions"> = {id: "isolated", name: "isolated", api: "openai-completions",
  provider: "isolated", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

describe("部分交付失败后的原生会话生命周期", () => {
  it.each([false, true])("模型失败后恢复证据遇到401只收尾一次（直接抛出异常=%s）", async thrown => {
    const directory = await mkdtemp(join(tmpdir(), "partial-lifecycle-"));
    const store = new NativeSessionStore(directory);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let modelCalls = 0, partialCalls = 0, backendCalls = 0;
    const payloads: Array<Record<string, unknown>> = [];
    const stream: ProviderStreams["streamSimple"] = (_model, context, options) => {
      modelCalls++;
      if (modelCalls > 2) throw new Error("PARTIAL_RECOVERY_LOOP");
      const call = (name: string) => ({type: "toolCall" as const, id: `call-${modelCalls}`, name, arguments: {}});
      const content: AssistantMessage["content"] = modelCalls === 1 ? [call("metric_query")]
        : [{type: "text", text: "未核验的模型草稿999元。"}];
      const answer: AssistantMessage = {role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: modelCalls === 1 ? "toolUse" : "error",
        ...(modelCalls === 2 ? {errorMessage: "upstream unavailable"} : {}),
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const result = createAssistantMessageEventStream();
      void (async () => {
        const payload = {messages: context.messages, tools: context.tools?.map(tool => ({type: "function",
          function: {name: tool.name, parameters: tool.parameters}}))};
        payloads.push((await options?.onPayload?.(payload, model) ?? payload) as Record<string, unknown>);
        result.push({type: "start", partial: answer});
        if (modelCalls === 1) result.push({type: "done", reason: "toolUse", message: answer});
        else result.push({type: "error", reason: "error", error: answer});
        result.end(answer);
      })().catch(error => {
        const failed: AssistantMessage = {...answer, stopReason: "error", errorMessage: String(error)};
        result.push({type: "error", reason: "error", error: failed}); result.end(failed);
      });
      return result;
    };
    const models = createModels();
    models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
      auth: {apiKey: {name: "isolated", resolve: () => Promise.resolve({auth: {apiKey: "unused"}})}},
      api: {stream, streamSimple: stream}}));
    const partial = createPartialAnalysisTool();
    const guardedPartial: typeof partial = {...partial, execute: async (...args) => {
      partialCalls++;
      if (thrown) throw new BackendApiError(401, "账号已在其他位置重新登录，请重新认证", "UNAUTHORIZED");
      return partial.execute(...args);
    }};
    const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
      {name: "metric_query", label: "隔离分析证据", description: "仅供生命周期测试", parameters: Type.Object({}),
        execute: (_id, _input, _update, request) => Promise.resolve({content: [], details: {
          kind: "analysis_evidence", status: "succeeded", execution_turn_id: request.operationId,
          run_ref: "isolated-run", org_codes: [TEST_ACTOR.org_code], tasks: [], evidence_items: [],
        }})},
      guardedPartial,
      createConversationReplyTool(),
    ];
    const backend = {analysisReport: () => {
      backendCalls++;
      throw new BackendApiError(401, "账号已在其他位置重新登录，请重新认证", "UNAUTHORIZED");
    }} as unknown as BackendClient;
    const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false", AGENT_MODEL_RETRY_ENABLED: "false"});
    const host = new HarnessHost(config, () => ({models, model}), store, tools);
    try {
      const session = await host.createSession(TEST_ACTOR);
      const result = await host.runPrompt(session, {protocol_version: 3, request_id: "isolated-request", message: "报告验证"},
        {actor: TEST_ACTOR, backend});
      expect(result).toMatchObject({ok: true, outcome: {kind: "settled"}});
      expect(await host.isRunning(session.sessionId)).toBe(false);
      expect((await session.lane.inspectExecution(BACKGROUND_CONTEXT)).current).toBeNull();
      expect(modelCalls).toBe(2);
      expect(JSON.stringify(payloads)).not.toContain("analysis_partial_present");
      expect(partialCalls).toBe(1);
      expect(backendCalls).toBe(thrown ? 0 : 1);
      const entries = await session.lane.findEntries({type: "message", order: "oldestFirst", limit: 30}, BACKGROUND_CONTEXT);
      const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const receipts = messages.filter(message => message.role === "toolResult" && message.toolName === "analysis_partial_present");
      expect(receipts).toHaveLength(1);
      const partialReceipt = receipts[0];
      if (partialReceipt?.role !== "toolResult") throw new Error("缺少部分交付回执");
      expect(partialReceipt).toMatchObject({isError: true});
      expect(partialReceipt.details).toMatchObject({status: "error", error_code: "UNAUTHORIZED", retryable: false});
    } finally {
      await host.close();
      await store.close();
      log.mockRestore();
      await rm(directory, {recursive: true, force: true});
    }
  }, 10000);
});
