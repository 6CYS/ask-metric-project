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
import {projectEntries} from "../src/sessionProjection.js";
import {createPartialAnalysisTool, PARTIAL_ANALYSIS} from "../src/tools/partialAnalysis.js";
import {createConversationReplyTool} from "../src/tools/turnContract.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

const model: Model<"openai-completions"> = {id: "isolated", name: "isolated", api: "openai-completions",
  provider: "isolated", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const confirmed = "2026-07-31甲行存款余额12元。";
type Scenario = "fresh" | "mixed" | "no-source" | "historical" | "cancelled" | "reference-error"
  | "denied" | "unauthenticated" | "unavailable" | "retry-exhausted";

// 真实宿主、原生错误事件和既有部分交付工具；只隔离模型服务与业务 HTTP。
async function runScenario(scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "inquiry-model-failure-"));
  const store = new NativeSessionStore(directory);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let modelCalls = 0, queryCalls = 0;
  let operationId = "";
  let waitingForModel!: () => void;
  const modelWaiting = new Promise<void>(resolve => {waitingForModel = resolve;});
  const payloads: Record<string, unknown>[] = [];
  const stream: ProviderStreams["streamSimple"] = (_model, context, options) => {
    if (++modelCalls > 3) throw new Error("UNEXPECTED_RECOVERY_LOOP");
    const query = modelCalls === 1 && scenario !== "no-source";
    const report = scenario === "reference-error" && modelCalls === 2;
    const failed = !query && !report;
    const message: AssistantMessage = {role: "assistant",
      content: query ? [{type: "toolCall", id: "query", name: "metric_query", arguments: {}}]
        : report ? [{type: "toolCall", id: "bad-report", name: "analysis_answer", arguments: {}}]
          : [{type: "text", text: "未核验的模型草稿987654元。"}],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: failed ? scenario === "cancelled" ? "aborted" : "error" : "toolUse",
      ...(failed ? {errorMessage: scenario === "retry-exhausted" ? "503 service unavailable" : "upstream unavailable"} : {}),
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const events = createAssistantMessageEventStream();
    void (async () => {
      const payload = {messages: context.messages, tools: context.tools?.map(tool => ({type: "function",
        function: {name: tool.name, parameters: tool.parameters}}))};
      payloads.push((await options?.onPayload?.(payload, model) ?? payload) as Record<string, unknown>);
      events.push({type: "start", partial: message});
      if (failed && scenario === "cancelled") {
        const aborted = new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), {once: true}));
        waitingForModel(); await aborted;
      }
      if (failed) events.push({type: "error", reason: scenario === "cancelled" ? "aborted" : "error", error: message});
      else events.push({type: "done", reason: "toolUse", message});
      events.end(message);
    })().catch(error => events.end({...message, stopReason: "error", errorMessage: String(error)}));
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
    auth: {apiKey: {name: "isolated", resolve: async () => ({auth: {apiKey: "unused"}})}}, api: {stream, streamSimple: stream}}));
  const evidence = (operation: string, historical: boolean) => ({kind: "analysis_evidence", status: "succeeded",
    run_ref: historical ? "old-run" : "current-run", scope_id: historical ? "old-operation" : operation,
    execution_turn_id: historical ? "old-operation" : operation, result_reused: historical,
    org_codes: [TEST_ACTOR.org_code], tasks: [], metric_descriptors: [], evidence_items: []});
  const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
    {name: "metric_query", label: "隔离取数", description: "隔离业务 HTTP", parameters: Type.Object({}),
      execute: async (_id, _args, _update, request) => {
        queryCalls++;
        operationId = request.operationId;
        return {content: [], details: scenario === "mixed"
          ? {kind: "semantic_results", results: [evidence(request.operationId, true), evidence(request.operationId, false)]}
          : evidence(request.operationId, scenario === "historical")};
      }},
    {name: "analysis_answer", label: "隔离引用错误", description: "隔离报告 HTTP", parameters: Type.Object({}),
      execute: async () => ({content: [], details: {kind: "analysis_answer", status: "ARGUMENT_ERROR",
        retryable: true, error_code: "ANALYSIS_REPORT_REFERENCE"}})},
    createPartialAnalysisTool(), createConversationReplyTool(),
  ];
  const analysisReport = vi.fn(async (payload: Record<string, unknown>) => {
    expect(payload).toMatchObject({run_refs: ["current-run"], summary: "", sections: [], fallback: true});
    if (scenario === "denied") throw new BackendApiError(403, "internal O_SECRET", "ORG_SCOPE_FORBIDDEN");
    if (scenario === "unauthenticated") throw new BackendApiError(401, "internal O_SECRET", "AUTH_TOKEN_EXPIRED");
    if (scenario === "unavailable") throw new BackendApiError(503, "internal upstream", "BACKEND_UNAVAILABLE");
    return {kind: "business_report", status: "succeeded", answer_policy: "verified_report_v1", public_answer: confirmed,
      columns: [], rows: [], org_codes: [TEST_ACTOR.org_code], tasks: [], gaps: [],
      report: {summary: confirmed, sections: [], presentation: {scope: "甲行 · 2026-07-31"}}};
  });
  const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
    AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false",
    AGENT_MODEL_RETRY_ENABLED: scenario === "retry-exhausted" ? "true" : "false",
    AGENT_MODEL_MAX_RETRIES: "1", AGENT_MODEL_RETRY_BASE_DELAY_MS: "1"});
  const host = new HarnessHost(config, () => ({models, model}), store, tools);
  try {
    const session = await host.createSession(TEST_ACTOR);
    const pending = host.runPrompt(session, {protocol_version: 3, request_id: scenario, message: "看看存款情况和原因"},
      {actor: TEST_ACTOR, backend: {analysisReport} as unknown as BackendClient});
    if (scenario === "cancelled") {await modelWaiting; await host.abort(session, operationId);}
    const result = await pending;
    expect(await host.isRunning(session.sessionId)).toBe(false);
    const entries = await session.lane.findEntries({type: "message", order: "oldestFirst"}, BACKGROUND_CONTEXT);
    const receipts = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    const answers = projectEntries(entries).filter(message => message.role === "assistant").map(message => message.text).join("\n");
    expect(answers).not.toMatch(/987654|O_SECRET|internal upstream/);
    for (const payload of payloads) expect(JSON.stringify(payload.tools)).not.toContain(PARTIAL_ANALYSIS);
    return {result, modelCalls, queryCalls, reports: analysisReport.mock.calls, receipts, answers};
  } finally {await host.close(); await store.close(); log.mockRestore(); await rm(directory, {recursive: true, force: true});}
}

describe("问数中途模型异常的有界交付", () => {
  it.each(["fresh", "mixed", "retry-exhausted"] as const)("%s只重验本轮新查询，交付事实并明确分析未完成", async scenario => {
    const result = await runScenario(scenario);
    expect(result.modelCalls).toBe(scenario === "retry-exhausted" ? 3 : 2);
    expect(result.queryCalls).toBe(1);
    expect(result.reports).toHaveLength(1);
    expect(result.receipts.filter(item => item.toolName === PARTIAL_ANALYSIS)).toHaveLength(1);
    expect(result.receipts.at(-1)?.details).toMatchObject({kind: "business_report", status: "succeeded",
      partial_analysis: true, fallback_reason: "model_failure"});
    expect(result.answers).toContain(confirmed);
    expect(result.answers).toContain("未能完成分析");
    expect(result.result).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
  });
  it.each(["no-source", "historical", "cancelled", "reference-error"] as const)("%s不能自动铺开历史或越过失败边界", async scenario => {
    const result = await runScenario(scenario);
    expect(result.reports).toHaveLength(0);
    expect(result.receipts.some(item => item.toolName === PARTIAL_ANALYSIS)).toBe(false);
    expect(result.answers).not.toContain(confirmed);
  });
  it.each(["denied", "unauthenticated", "unavailable"] as const)("恢复核验%s时停止，不采用旧缓存值或再调模型", async scenario => {
    const result = await runScenario(scenario);
    expect(result.modelCalls).toBe(2);
    expect(result.reports).toHaveLength(1);
    expect(result.answers).not.toContain(confirmed);
    expect(result.receipts.filter(item => item.toolName === PARTIAL_ANALYSIS)).toHaveLength(1);
    if (scenario === "unavailable") expect(result.receipts.at(-1)?.details)
      .toMatchObject({status: "failed", error_code: "BACKEND_UNAVAILABLE", retryable: false});
  });
});
