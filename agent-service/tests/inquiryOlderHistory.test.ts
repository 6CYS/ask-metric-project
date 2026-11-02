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
import {createInquiryQueryTools} from "../src/inquiry/queryTools.js";
import {createSessionHistoryReadTool} from "../src/tools/readTools.js";
import {CONVERSATION_REPLY, createConversationReplyTool} from "../src/tools/turnContract.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

const model: Model<"openai-completions"> = {id: "isolated", name: "isolated", api: "openai-completions",
  provider: "isolated", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

describe("较早历史的受控恢复", () => {
  it("正式工具集合包含已有历史分页入口", () => {
    expect(createAskMetricTools().filter(tool => tool.name === "session_history_read")).toHaveLength(1);
  });

  it.each([false, true])("六轮会话可按需找回早期来源，撤权后不回传旧事实（撤权=%s）", async revoked => {
    const directory = await mkdtemp(join(tmpdir(), "inquiry-older-history-")), store = new NativeSessionStore(directory);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let round = 0, call = 0, queryCalls = 0, oldOperation = "";
    const recoveryContexts: string[] = [];
    const evidence = () => ({kind: "analysis_evidence", status: "succeeded", run_ref: "analysis:old-run",
      scope_id: oldOperation, execution_turn_id: oldOperation, conversation_id: "conv", org_codes: [TEST_ACTOR.org_code],
      actual_dates: ["2026-07-31"], rows: [], observations: [], gaps: [], limitations: [],
      tasks: [{task_id: "old-task", result_id: "old-result"}], metric_descriptors: [{code: "M1", name: "旧指标", unit: "元"}],
      evidence_items: [{ref: "old.f1", type: "fact", fact_id: "fact:old-task:1", metric_code: "M1",
        metric_name: "旧指标", org_code: TEST_ACTOR.org_code, org_name: TEST_ACTOR.org_name,
        date: "2026-07-31", value: "12", unit: "元", display: "12元"}]});
    const backend = {
      searchBusinessKnowledge: vi.fn(async () => ({revision: "a".repeat(64), entries: []})),
      getTask: vi.fn(async () => {
        if (revoked && round === 5) throw new BackendApiError(403, "已撤权", "FORBIDDEN");
        return {task_id: "old-task", status: "SUCCEEDED", result: {result_id: "old-result"}};
      }),
      resolveBusinessField: vi.fn(async (_kind: string, codes: string[]) => ({status: "resolved", value: {codes}})),
      analysisEvidence: vi.fn(async () => evidence()),
    };
    const stream: ProviderStreams["streamSimple"] = (_model, context) => {
      if (++call > 35) throw new Error("UNEXPECTED_HISTORY_LOOP");
      const active = context.messages.slice(context.messages.map(message => message.role).lastIndexOf("user") + 1);
      const last = [...active].reverse().find(message => message.role === "toolResult");
      let name = CONVERSATION_REPLY, args: Record<string, unknown> = {answer: "已了解。"};
      if (round === 0) {
        name = last ? "analysis_answer" : "metric_query"; args = last ? {body: "旧指标{{e1.v1}}。"} : {};
      } else if (round === 5) {
        recoveryContexts.push(JSON.stringify(context.messages));
        if (!last) {name = "session_history_read"; args = {kind: "list", limit: 20};}
        else if (last.toolName === "session_history_read") {
          const payload = JSON.parse(last.content.filter(block => block.type === "text").map(block => block.text).join(""));
          if (Array.isArray(payload.entries)) {
            const found = payload.entries.find((entry: {preview: string}) => entry.preview.includes('"run_ref":"analysis:old-run"'));
            if (found) {name = "session_history_read"; args = {kind: "entry", entry_id: found.entry_id};}
            else if (payload.has_more) {name = "session_history_read"; args = {kind: "list", limit: 20, before_seq: payload.next_before_seq};}
            else {expect(revoked).toBe(true); args = {answer: "较早来源当前不可访问，无法复述原数值。"};}
          } else {
            expect(payload.text).toContain("analysis:old-run"); name = "analysis_read"; args = {run_ref: "analysis:old-run"};
          }
        } else {expect(last.toolName).toBe("analysis_read"); name = "analysis_answer"; args = {body: "原机构旧指标{{e1.v1}}。"};}
      }
      const message: AssistantMessage = {role: "assistant", content: [{type: "toolCall", id: `call-${call}`, name, arguments: args}],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "toolUse",
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const events = createAssistantMessageEventStream(); events.push({type: "start", partial: message});
      events.push({type: "done", reason: "toolUse", message}); events.end(message); return events;
    };
    const models = createModels();
    models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
      auth: {apiKey: {name: "isolated", resolve: async () => ({auth: {apiKey: "unused"}})}}, api: {stream, streamSimple: stream}}));
    const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
      createSessionHistoryReadTool(), createConversationReplyTool(), ...createInquiryQueryTools().filter(tool => tool.name === "analysis_read"),
      {name: "metric_query", label: "隔离查询", description: "隔离 HTTP", parameters: Type.Object({}),
        execute: async (_id, _args, _update, request) => {
          queryCalls++; oldOperation = request.operationId; await request.commands.setConversationId("conv");
          return {content: [{type: "text", text: JSON.stringify({run_ref: "analysis:old-run", display: "12元"})}], details: evidence()};
        }},
      {name: "analysis_answer", label: "交付", description: "隔离报告 HTTP", parameters: Type.Object({body: Type.String()}),
        execute: async () => ({content: [{type: "text", text: "旧指标12元。"}], terminate: true,
          details: {kind: "business_report", status: "succeeded", public_answer: "旧指标12元。", org_codes: [TEST_ACTOR.org_code],
            tasks: [{task_id: "old-task", result_id: "old-result"}]}})},
    ];
    const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false", AGENT_MODEL_RETRY_ENABLED: "false"});
    const host = new HarnessHost(config, () => ({models, model}), store, tools);
    try {
      const session = await host.createSession(TEST_ACTOR);
      for (round = 0; round < 6; round++) {
        expect(await host.runPrompt(session, {protocol_version: 3, request_id: `r${round}`,
          message: round === 0 ? "看看最早那家机构" : round === 5 ? "回到最早那家机构的数据" : `解释第${round}个一般概念`},
        {actor: TEST_ACTOR, backend: backend as unknown as BackendClient})).toMatchObject({ok: true, outcome: {kind: "settled"}});
      }
      expect(queryCalls).toBe(1);
      expect(recoveryContexts[0]).not.toContain("analysis:old-run");
      expect(backend.analysisEvidence).toHaveBeenCalledTimes(revoked ? 0 : 1);
      const entries = await session.lane.findEntries({type: "message", order: "oldestFirst"}, BACKGROUND_CONTEXT);
      const reads = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolName === "analysis_read" ? [entry.message] : []);
      if (!revoked) expect(reads[0]).toMatchObject({details: {result_reused: true, execution_turn_id: oldOperation}});
      else expect(recoveryContexts.join("")).not.toContain("12元");
    } finally {await host.close(); await store.close(); log.mockRestore(); await rm(directory, {recursive: true, force: true});}
  });
});
