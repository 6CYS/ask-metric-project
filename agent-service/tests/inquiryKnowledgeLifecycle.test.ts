import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BACKGROUND_CONTEXT, type AgentHarnessTool} from "@earendil-works/pi-agent-core";
import {createAssistantMessageEventStream, createModels, createProvider, Type,
  type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {describe, expect, it, vi} from "vitest";
import type {BackendClient} from "../src/backendClient.js";
import {createBusinessSkillReadTool, loadBusinessSkills} from "../src/businessSkills.js";
import {loadConfig} from "../src/config.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import type {AskMetricRequestContext} from "../src/requestContext.js";
import {createInquiryKnowledgeTool} from "../src/inquiry/knowledgeTool.js";
import {createConversationReplyTool} from "../src/tools/turnContract.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

const model: Model<"openai-completions"> = {id: "isolated", name: "isolated", api: "openai-completions",
  provider: "isolated", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

// 隔离模型与业务HTTP，使用真实宿主、知识工具、持久化和历史投影。
describe("知识先于取数的原生调用链", () => {
  it.each([false, true])("省略追问可主动检索，新轮只读取当前启用知识（次轮禁用=%s）", async disabled => {
    const directory = await mkdtemp(join(tmpdir(), "inquiry-knowledge-")), store = new NativeSessionStore(directory);
    const skills = await loadBusinessSkills();
    const analysis = skills.find(skill => skill.name === "inquiry-analysis");
    if (!analysis) throw new Error("缺少已部署的分析方法");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let calls = 0, second = false, queries = 0;
    const contexts: string[] = [];
    const keyword = "盈利变化与机构可比分析";
    const backend = {
      searchBusinessKnowledge: vi.fn((query: string) => Promise.resolve({revision: (second ? "b" : "a").repeat(64),
        entries: query === keyword && !(second && disabled) ? [{id: "profit", title: "盈利方法",
          text: second ? "更新后的分析依据" : "旧版方法原文", role: "方法参考"}] : []})),
      resolveBusinessField: vi.fn(() => Promise.resolve({status: "resolved", value: {codes: [TEST_ACTOR.org_code]}})),
    };
    const stream: ProviderStreams["streamSimple"] = (_model, context) => {
      if (++calls > 8) throw new Error("unexpected retry");
      const step = (calls - 1) % 4;
      const serialized = JSON.stringify(context.messages);
      contexts.push(serialized);
      if (step <= 1) {
        expect(context.tools?.some(tool => tool.name === "business_knowledge_search")).toBe(true);
        expect(serialized).not.toContain("旧版方法原文");
      } else {
        expect(serialized.includes("旧版方法原文")).toBe(!second);
        expect(serialized.includes("更新后的分析依据")).toBe(second && !disabled);
      }
      const method = context.messages.find(message => message.role === "toolResult" && message.toolName === "business_skill_read");
      if (step === 0) expect(method).toBeUndefined();
      else expect(method?.content).toEqual([{type: "text", text: analysis.content}]);
      const name = step === 0 ? "business_skill_read" : step === 1 ? "business_knowledge_search" : step === 2 ? "metric_query" : "analysis_answer";
      const message: AssistantMessage = {role: "assistant", content: [{type: "toolCall", id: `call-${calls}`, name,
        arguments: step === 0 ? {name: "inquiry-analysis"} : step === 1 ? {query: keyword} : step === 2 ? {} : {body: "按可比口径继续分析。"}}],
      api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "toolUse",
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const events = createAssistantMessageEventStream();
      events.push({type: "start", partial: message}); events.push({type: "done", reason: "toolUse", message});
      events.end(message); return events;
    };
    const models = createModels();
    models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
      auth: {apiKey: {name: "isolated", resolve: () => Promise.resolve({auth: {apiKey: "unused"}})}}, api: {stream, streamSimple: stream}}));
    const tools: AgentHarnessTool<AskMetricRequestContext>[] = [createBusinessSkillReadTool(skills), createInquiryKnowledgeTool(),
      {name: "metric_query", label: "查询", description: "隔离查询边界", parameters: Type.Object({}),
        execute: (_id, _input, _update, request) => {
          queries++;
          return Promise.resolve({content: [{type: "text", text: "隔离测试查询回执"}], details: {kind: "analysis_evidence", status: "succeeded",
            run_ref: second ? "analysis:second" : "analysis:first", execution_turn_id: request.operationId,
            org_codes: [TEST_ACTOR.org_code], tasks: [], evidence_items: []}});
        }},
      {name: "analysis_answer", label: "回答", description: "隔离交付边界", parameters: Type.Object({body: Type.String()}),
        execute: () => Promise.resolve({content: [{type: "text", text: "按可比口径继续分析。"}], terminate: true,
          details: {kind: "business_report", status: "succeeded", public_answer: "按可比口径继续分析。",
            org_codes: [TEST_ACTOR.org_code], tasks: []}})}, createConversationReplyTool()];
    const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false", AGENT_MODEL_RETRY_ENABLED: "false"});
    const host = new HarnessHost(config, () => ({models, model}), store, tools, {skills});
    try {
      const session = await host.createSession(TEST_ACTOR), dependencies = {actor: TEST_ACTOR, backend: backend as unknown as BackendClient};
      expect(await host.runPrompt(session, {protocol_version: 3, request_id: "first", message: "盈利情况怎么样"}, dependencies))
        .toMatchObject({ok: true, outcome: {kind: "settled"}});
      second = true;
      expect(await host.runPrompt(session, {protocol_version: 3, request_id: "second", message: "对比另一家呢？"}, dependencies))
        .toMatchObject({ok: true, outcome: {kind: "settled"}});
      expect(calls).toBe(8); expect(queries).toBe(2);
      expect(backend.searchBusinessKnowledge.mock.calls.map(call => call[0]))
        .toEqual(["盈利情况怎么样", keyword, "对比另一家呢？", keyword]);
      expect(contexts[4]).not.toContain("旧版方法原文");
      const entries = await session.lane.findEntries({type: "message", order: "oldestFirst", limit: 60}, BACKGROUND_CONTEXT);
      expect(JSON.stringify(entries)).toContain("旧版方法原文");
    } finally {
      await host.close(); await store.close(); log.mockRestore(); await rm(directory, {recursive: true, force: true});
    }
  });
});
