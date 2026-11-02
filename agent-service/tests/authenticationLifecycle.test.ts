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
import {projectEntries, projectWatchEvent} from "../src/sessionProjection.js";
import {backendErrorResult} from "../src/tools/shared.js";
import {createConversationReplyTool} from "../src/tools/turnContract.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

const model: Model<"openai-completions"> = {id: "isolated", name: "isolated", api: "openai-completions",
  provider: "isolated", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

describe("登录失效后的原生会话生命周期", () => {
  it.each(["handled", "thrown", "batch"] as const)("%s：401停止本轮且失败回执可在页面重放", async mode => {
    const directory = await mkdtemp(join(tmpdir(), "auth-lifecycle-"));
    const store = new NativeSessionStore(directory);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let modelCalls = 0, backendCalls = 0, trailingCalls = 0;
    const stream: ProviderStreams["streamSimple"] = () => {
      modelCalls++;
      if (modelCalls > 2) throw new Error("AUTHENTICATION_RETRY_LOOP");
      const toolCall = (name: string, suffix: string, args = {}) =>
        ({type: "toolCall" as const, id: `call-${modelCalls}-${suffix}`, name, arguments: args});
      const call = toolCall("metric_query", "auth");
      const content: AssistantMessage["content"] = modelCalls === 1
        ? mode === "batch" ? [toolCall("metric_search", "preparation"), call, toolCall("analysis_read", "trailing")]
          : [call]
        : [{type: "text", text: "再次尝试读取业务主题。"}];
      const answer: AssistantMessage = {role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: modelCalls === 1 ? "toolUse" : "stop",
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const result = createAssistantMessageEventStream();
      result.push({type: "start", partial: answer});
      result.push({type: "done", reason: answer.stopReason as "toolUse" | "stop", message: answer});
      result.end(answer);
      return result;
    };
    const models = createModels();
    models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
      auth: {apiKey: {name: "isolated", resolve: () => Promise.resolve({auth: {apiKey: "unused"}})}},
      api: {stream, streamSimple: stream}}));
    const denied = () => {backendCalls++; throw new BackendApiError(401, "账号已在其他位置重新登录，请重新认证", "AUTH_SESSION_REPLACED");};
    const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
      {name: "metric_query", label: "隔离鉴权边界", description: "测试查询鉴权", parameters: Type.Object({}),
        execute: () => {
          if (mode !== "handled") return denied();
          try {return denied();}
          catch (error) {
            const result = backendErrorResult(error, {kind: "inquiry_query_error", status: "error"});
            if (!result) throw error;
            return Promise.resolve(result);
          }
        }},
      {name: "metric_search", label: "读取测试目录", description: "隔离同批前置调用", parameters: Type.Object({}),
        execute: () => Promise.resolve({content: [], details: {kind: "analysis_catalog", status: "succeeded"}})},
      {name: "analysis_read", label: "读取后续数据", description: "隔离同批后置调用", parameters: Type.Object({}),
        execute: () => {trailingCalls++; return Promise.resolve({content: [], details: {kind: "analysis_evidence", status: "succeeded"}});}},
      createConversationReplyTool()];
    const backend = {} as BackendClient;
    const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false", AGENT_MODEL_RETRY_ENABLED: "false"});
    const host = new HarnessHost(config, () => ({models, model}), store, tools);
    try {
      const session = await host.createSession(TEST_ACTOR);
      const result = await host.runPrompt(session, {protocol_version: 3, request_id: "auth-request", message: "贷款质量如何"},
        {actor: TEST_ACTOR, backend});
      expect(result).toMatchObject({ok: true, outcome: {kind: "settled"}});
      expect(await host.isRunning(session.sessionId)).toBe(false);
      expect((await session.lane.inspectExecution(BACKGROUND_CONTEXT)).current).toBeNull();
      expect(modelCalls).toBe(1);
      expect(backendCalls).toBe(1);
      expect(trailingCalls).toBe(0);
      const entries = await session.lane.findEntries({type: "message", order: "oldestFirst", limit: 30}, BACKGROUND_CONTEXT);
      const receipt = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolCallId === "call-1-auth" ? [entry.message] : [])[0];
      expect(receipt).toMatchObject({isError: true});
      expect(receipt?.details).toMatchObject({status: "error", error_code: "AUTH_SESSION_REPLACED", retryable: false});
      if (!receipt) throw new Error("缺少鉴权失败回执");
      const event = projectWatchEvent({type: "tool_end", toolName: receipt.toolName, toolCallId: receipt.toolCallId,
        isError: receipt.isError, result: {details: receipt.details}});
      expect(event).toMatchObject({type: "tool_end", isError: true, answer: {text: "登录状态已失效，请刷新页面重新登录。"}});
      expect(projectEntries(entries).some(message => message.role === "assistant"
        && message.text === "登录状态已失效，请刷新页面重新登录。")).toBe(true);
    } finally {
      await host.close();
      await store.close();
      log.mockRestore();
      await rm(directory, {recursive: true, force: true});
    }
  }, 10000);
});
