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
import {createInquiryCalculationTool} from "../src/inquiry/calculationTool.js";
import {createInquiryAnswerTool} from "../src/inquiry/runtime.js";
import {createPartialAnalysisTool, PARTIAL_ANALYSIS} from "../src/tools/partialAnalysis.js";
import {projectEntries, projectWatchEvent} from "../src/sessionProjection.js";
import {CONVERSATION_REPLY, createConversationReplyTool} from "../src/tools/turnContract.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

const model: Model<"openai-completions"> = {id: "isolated", name: "isolated", api: "openai-completions",
  provider: "isolated", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const confirmed = "本期存款余额为10元。";
const clarification = "请确认截至2026年8月27日需要查询个人有效贷款客户数，还是商户有效收单客户数？";
const invalidReply = "<analysis>这段内部规划不能作为回答交付。</analysis>";
type Scenario = "forbidden" | "delivered" | "batched-delivery" | "clarification" | "cancelled"
  | "clarification-invalid" | "clarification-schema-invalid" | "clarification-corrected" | "report-fallback"
  | "clarification-schema-corrected" | "query-schema-invalid" | "query-schema-corrected"
  | "schema-evidence-progress" | "schema-batched-corrected"
  | "query-schema-varying" | "query-schema-stalled-evidence"
  | "calculation-stalled-answer" | "calculation-stalled-query";

// 使用真实Harness、交付工具和投影，仅隔离外部模型与业务HTTP边界。
async function runScenario(scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "inquiry-safety-"));
  const store = new NativeSessionStore(directory);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let modelCalls = 0, reportCalls = 0;
  let queryStarted!: (operationId: string) => void;
  const queryReady = new Promise<string>(resolve => { queryStarted = resolve; });
  const queryPhases: string[] = [];
  const call = (name: string, id: string, args: Record<string, unknown>) =>
    ({type: "toolCall" as const, id, name, arguments: args});
  const stream: ProviderStreams["streamSimple"] = () => {
    modelCalls++;
    const maxCalls = scenario === "forbidden" ? 1 : scenario === "schema-evidence-progress" ? 5
      : scenario === "query-schema-varying" ? 18 : scenario === "query-schema-stalled-evidence" ? 4
      : scenario === "calculation-stalled-query" ? 5
      : scenario.startsWith("calculation-stalled-") ? 4
      : ["clarification-schema-invalid", "report-fallback", "query-schema-invalid", "query-schema-corrected", "schema-batched-corrected"].includes(scenario) ? 3 : 2;
    if (modelCalls > maxCalls)
      throw new Error("UNEXPECTED_INQUIRY_CONTINUATION");
    const content: AssistantMessage["content"] = scenario === "batched-delivery"
      ? [call("metric_query", "initial-query", {phase: "initial"}),
        call("analysis_answer", "answer", {body: "本期存款余额为{{e1.v1}}。"}),
        call("metric_query", "trailing-query", {phase: "trailing"})]
      : scenario.startsWith("calculation-stalled-")
      ? modelCalls === 1
        ? [call("metric_query", "initial-query", {phase: "initial"})]
        : modelCalls <= 3
        ? [call("analysis_calculate", `calculation-${modelCalls}`, {current_ref: "e1.v1", base_ref: "unknown.fact"})]
        : scenario === "calculation-stalled-answer" || modelCalls === 5
        ? [call("analysis_answer", "answer", {body: "本期存款余额为{{e1.v1}}。"}),
          call("metric_query", "trailing-query", {phase: "trailing"})]
        : [call("metric_query", "supplemental-query", {phase: "supplemental"})]
      : scenario === "clarification-schema-invalid" || scenario === "clarification-schema-corrected"
      ? [call(CONVERSATION_REPLY, `invalid-${modelCalls}`,
        {answer: scenario === "clarification-schema-corrected" && modelCalls === 2 ? clarification : ""})]
      : scenario === "query-schema-varying"
      ? [call("metric_query", `varying-query-${modelCalls}`, {unknown: modelCalls})]
      : scenario === "query-schema-stalled-evidence"
      ? [call("metric_query", `invalid-query-${modelCalls}`, modelCalls === 1 ? {phase: "initial"} : {})]
      : scenario === "query-schema-invalid"
      ? [call("metric_query", `invalid-query-${modelCalls}`, {})]
      : ["query-schema-corrected", "schema-batched-corrected", "schema-evidence-progress"].includes(scenario)
      ? modelCalls === 1
        ? Array.from({length: scenario === "schema-batched-corrected" ? 3 : 1}, (_, index) =>
          call("metric_query", `invalid-query-${index}`, {}))
        : modelCalls === 2
        ? [call("metric_query", "initial-query", {phase: "initial"})]
        : scenario === "schema-evidence-progress" && modelCalls <= 4
        ? [call("metric_query", `supplemental-${modelCalls}`, modelCalls === 3 ? {} : {phase: "supplemental"})]
        : [call("analysis_answer", `answer-${modelCalls}`, {body: "本期存款余额为{{e1.v1}}。"})]
      : scenario === "clarification-invalid" || scenario === "clarification-corrected"
      ? [call(CONVERSATION_REPLY, `reply-${modelCalls}`,
          {answer: scenario === "clarification-corrected" && modelCalls === 2 ? clarification : invalidReply})]
      : scenario === "clarification"
      ? [call(CONVERSATION_REPLY, "clarification", {answer: clarification})]
      : scenario === "report-fallback" && modelCalls > 1
      ? [{type: "text", text: "本期存款余额为{{e1.v1}}。"}]
      : modelCalls === 1
        ? [call("metric_query", "initial-query", {phase: "initial"}),
          ...(scenario === "forbidden" ? [call("metric_query", "trailing-query", {phase: "trailing"})] : [])]
        : [call("analysis_answer", "answer", {body: "本期存款余额为{{e1.v1}}。", evidence_refs: ["e1"]}),
          call("metric_query", "trailing-query", {phase: "trailing"})];
    const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
    const message: AssistantMessage = {role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason, usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const events = createAssistantMessageEventStream();
    events.push({type: "start", partial: message});
    events.push({type: "done", reason: stopReason, message});
    events.end(message);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
    auth: {apiKey: {name: "isolated", resolve: () => Promise.resolve({auth: {apiKey: "unused"}})}},
    api: {stream, streamSimple: stream}}));
  const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
    {name: "metric_query", label: "查询指标", description: "隔离后端查询边界", parameters: Type.Object({phase: Type.String()}),
      execute: async (_id, input, _update, request, _invocation, context) => {
        const phase = (input as {phase: string}).phase;
        queryPhases.push(phase);
        if (phase === "trailing") throw new Error("TRAILING_QUERY_EXECUTED");
        if (scenario === "cancelled") {
          queryStarted(request.operationId);
          await new Promise<void>(resolve => context.abortSignal?.addEventListener("abort", () => resolve(), {once: true}));
          throw new Error("用户已停止本轮查询");
        }
        if (scenario === "forbidden") throw new BackendApiError(403, "内部范围O_SECRET，字段branch_id不可见", "ORG_SCOPE_FORBIDDEN");
        return {content: [{type: "text", text: "隔离测试引用e1.v1"}], details: {
          kind: "analysis_evidence", status: "succeeded", run_ref: "run", scope_id: request.operationId,
          execution_turn_id: request.operationId, org_codes: [TEST_ACTOR.org_code], tasks: [],
          metric_descriptors: [{binding_ref: "k1", code: "M1", name: "存款余额", unit: "元"}],
          evidence_items: [{ref: "run.f1", type: "fact", metric_code: "M1", metric_name: "存款余额",
            org_code: TEST_ACTOR.org_code, org_name: TEST_ACTOR.org_name, date: "2026-08-27", unit: "元", value: "10", display: "10元"}],
        }};
      }},
    createInquiryAnswerTool(), createConversationReplyTool(), createInquiryCalculationTool(), createPartialAnalysisTool(),
  ];
  const backend = {analysisReport: (payload: Record<string, unknown>) => {
    reportCalls++;
    if (scenario === "report-fallback" && reportCalls <= 2)
      throw new BackendApiError(422, "草稿数字无依据", "ANALYSIS_REPORT_NUMBER");
    expect(payload).toMatchObject({run_refs: ["run"], ...(["report-fallback", "query-schema-stalled-evidence"].includes(scenario)
      ? {summary: "", sections: [], fallback: true} : {summary: "本期存款余额为{{run.f1}}。"})});
    return Promise.resolve({kind: "business_report", status: "succeeded", answer_policy: "verified_report_v1", public_answer: confirmed,
      org_codes: [TEST_ACTOR.org_code], tasks: [], gaps: [],
      report: {summary: confirmed, sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["run.f1"]}]}});
  }} as unknown as BackendClient;
  const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
    AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false", AGENT_MODEL_RETRY_ENABLED: "false"});
  const host = new HarnessHost(config, () => ({models, model}), store, tools);
  try {
    const session = await host.createSession(TEST_ACTOR);
    const pending = host.runPrompt(session, {protocol_version: 3, request_id: scenario, message: "存款余额多少"},
      {actor: TEST_ACTOR, backend});
    if (scenario === "cancelled") await host.abort(session, await queryReady);
    const result = await pending;
    expect(result).toMatchObject({ok: true, outcome: {kind: "settled"}});
    expect(await host.isRunning(session.sessionId)).toBe(false);
    const entries = await session.lane.findEntries({type: "message", order: "oldestFirst", limit: 60}, BACKGROUND_CONTEXT);
    const receipts = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    const answers = projectEntries(entries).filter(message => message.role === "assistant").map(message => message.text);
    const operationStatus = result.ok && result.outcome.kind === "settled" ? result.outcome.outcome.status : undefined;
    return {modelCalls, reportCalls, queryPhases, receipts, answers, operationStatus};
  } finally {
    await host.close(); await store.close(); log.mockRestore();
    await rm(directory, {recursive: true, force: true});
  }
}

describe("普通调查终态与无证据回答的实际链路", () => {
  it("403保留公开权限说明并停止同批后续查询", async () => {
    const result = await runScenario("forbidden");
    expect(result.modelCalls).toBe(1);
    expect(result.reportCalls).toBe(0);
    expect(result.queryPhases).toEqual(["initial"]);
    const denied = result.receipts.find(item => item.toolCallId === "initial-query");
    expect(denied).toMatchObject({isError: false, details: {kind: "runtime_delivery", error_code: "INQUIRY_FORBIDDEN"}});
    expect(result.answers).toContain("当前账号无权访问本次所需的数据，请联系管理员确认权限。");
    expect(JSON.stringify(result.answers)).not.toMatch(/O_SECRET|branch_id|ORG_SCOPE_FORBIDDEN/);
    if (!denied) throw new Error("缺少权限终态回执");
    expect(projectWatchEvent({type: "tool_end", toolName: denied.toolName, toolCallId: denied.toolCallId,
      isError: denied.isError, result: {details: denied.details}})).toMatchObject({isError: false, details: {
      public_answer: "当前账号无权访问本次所需的数据，请联系管理员确认权限。"}});
  });

  it("正式回答成功后不执行同批尾随查询，也不增加模型往返", async () => {
    const result = await runScenario("delivered");
    expect(result.operationStatus).toBe("completed");
    expect(result.modelCalls).toBe(2);
    expect(result.reportCalls).toBe(1);
    expect(result.queryPhases).toEqual(["initial"]);
    expect(result.answers).toContain(confirmed);
    expect(result.receipts.some(item => item.toolCallId === "answer" &&
      (item.details as {kind?: string})?.kind === "business_report")).toBe(true);
  });

  it("正文两次数字校验失败后直接交付核验事实，不再追加模型调用或查询", async () => {
    const result = await runScenario("report-fallback");
    expect(result.operationStatus).toBe("completed");
    expect(result.modelCalls).toBe(3);
    expect(result.reportCalls).toBe(3);
    expect(result.queryPhases).toEqual(["initial"]);
    expect(result.receipts.filter(item => item.toolName === "analysis_answer")).toHaveLength(2);
    expect(result.receipts.at(-1)?.details).toMatchObject({kind: "business_report", status: "succeeded"});
    expect(result.answers.at(-1)).toContain(confirmed);
    expect(result.answers.at(-1)).toContain("本轮未能完成分析回答");
    expect(result.answers).not.toContain("本次未能完成回答，请稍后重试。");
  });

  it("尚未取数时带用户日期的口径澄清一次交付，不反复重试或强制报告", async () => {
    const result = await runScenario("clarification");
    expect(result.operationStatus).toBe("completed");
    expect(result.modelCalls).toBe(1);
    expect(result.reportCalls).toBe(0);
    expect(result.queryPhases).toEqual([]);
    expect(result.answers).toContain(clarification);
    expect(result.receipts.some(item => item.isError)).toBe(false);
    expect(result.receipts.some(item => (item.details as {kind?: string; status?: string})?.kind === "conversation_reply"
      && (item.details as {status?: string})?.status === "answered")).toBe(true);
  });

  it.each(["clarification-invalid", "clarification-schema-invalid"] as const)(
    "普通回复%s连续两次失败后固定结束，不转交无来源报告", async scenario => {
      const result = await runScenario(scenario);
      const calls = scenario === "clarification-schema-invalid" ? 3 : 2;
      expect(result.operationStatus).toBe("completed");
      expect(result.modelCalls).toBe(calls);
      expect(result.reportCalls).toBe(0);
      expect(result.queryPhases).toEqual([]);
      expect(result.receipts.filter(item => item.toolName === CONVERSATION_REPLY)).toHaveLength(calls);
      expect(result.receipts.at(-1)?.details).toMatchObject({kind: "runtime_delivery", status: "delivered", outcome: "incomplete"});
      expect(result.answers).toContain("本次未能完成回答，请稍后重试。");
      expect(JSON.stringify(result.answers)).not.toContain(invalidReply);
    });

  it("普通回复首次失败后保留一次修正，修正成功正常结束", async () => {
    const result = await runScenario("clarification-corrected");
    expect(result.operationStatus).toBe("completed");
    expect(result.modelCalls).toBe(2);
    expect(result.reportCalls).toBe(0);
    expect(result.queryPhases).toEqual([]);
    expect(result.answers).toContain(clarification);
    expect(result.receipts.at(-1)?.details).toMatchObject({kind: "conversation_reply", status: "answered"});
  });

  it("空查询参数连续失败后及时结束，不耗尽全部调查预算", async () => {
    const result = await runScenario("query-schema-invalid");
    expect(result).toMatchObject({operationStatus: "completed", modelCalls: 3, reportCalls: 0, queryPhases: []});
    expect(result.receipts.at(-1)?.details).toMatchObject({kind: "runtime_delivery", outcome: "incomplete"});
    expect(result.answers).toContain("本次未能完成回答，请稍后重试。");
  });

  it("不断变换无效查询参数仍受调查预算约束，不依赖执行前钩子", async () => {
    const result = await runScenario("query-schema-varying");
    expect(result).toMatchObject({operationStatus: "completed", modelCalls: 17, reportCalls: 0, queryPhases: []});
    expect(result.receipts.filter(item => item.toolName === "metric_query")).toHaveLength(16);
    expect(result.receipts.at(-1)?.details).toMatchObject({kind: "runtime_delivery", outcome: "incomplete"});
  });

  it("重复无效参数停滞后仅交付重新核验的当前事实并明确未完成", async () => {
    const result = await runScenario("query-schema-stalled-evidence");
    expect(result).toMatchObject({operationStatus: "completed", modelCalls: 4, reportCalls: 1, queryPhases: ["initial"]});
    const partial = result.receipts.find(item => item.toolName === PARTIAL_ANALYSIS);
    expect(partial?.details).toMatchObject({kind: "business_report", partial_analysis: true,
      fallback_reason: "action_incomplete"});
    expect(result.answers.at(-1)).toContain(confirmed);
    expect(result.answers.at(-1)).toContain("原问题尚未完整分析");
  });

  it("已有事实时两次计算参数失败只收敛调查，仍交付可靠结果并阻止尾随查询", async () => {
    const result = await runScenario("calculation-stalled-answer");
    expect(result).toMatchObject({operationStatus: "completed", modelCalls: 4, reportCalls: 1, queryPhases: ["initial"]});
    expect(result.answers).toContain(confirmed);
    expect(result.receipts.find(item => item.toolCallId === "answer")?.details)
      .toMatchObject({kind: "business_report", status: "succeeded"});
    expect(result.receipts.find(item => item.toolCallId === "trailing-query")?.isError).toBe(true);
  });

  it("局部计算失败仍允许新条件补查，交付后不执行尾随查询", async () => {
    const result = await runScenario("calculation-stalled-query");
    expect(result).toMatchObject({operationStatus: "completed", modelCalls: 5, reportCalls: 1,
      queryPhases: ["initial", "supplemental"]});
    expect(result.answers).toContain(confirmed);
    expect(result.receipts.find(item => item.toolCallId === "answer")?.details)
      .toMatchObject({kind: "business_report", status: "succeeded"});
    expect(result.receipts.find(item => item.toolCallId === "trailing-query")?.isError).toBe(true);
  });

  it("普通回复空参数修正后仍正常交付", async () => {
    const result = await runScenario("clarification-schema-corrected");
    expect(result).toMatchObject({operationStatus: "completed", modelCalls: 2, reportCalls: 0});
    expect(result.answers).toContain(clarification);
    expect(result.receipts.at(-1)?.details).toMatchObject({kind: "conversation_reply", status: "answered"});
  });

  it.each(["query-schema-corrected", "schema-evidence-progress", "schema-batched-corrected"] as const)(
    "%s 参数修正或补到证据后继续，同批多个失败只算一次修正机会", async scenario => {
      const result = await runScenario(scenario);
      expect(result).toMatchObject({operationStatus: "completed", modelCalls: scenario === "schema-evidence-progress" ? 5 : 3,
        reportCalls: 1, queryPhases: scenario === "schema-evidence-progress" ? ["initial", "supplemental"] : ["initial"]});
      expect(result.answers).toContain(confirmed);
      expect(result.receipts.at(-1)?.details).toMatchObject({kind: "business_report", status: "succeeded"});
    });

  it("同批先查询再交付也以完成结束，不追加模型调用或尾随查询", async () => {
    const result = await runScenario("batched-delivery");
    expect(result.operationStatus).toBe("completed");
    expect(result.modelCalls).toBe(1);
    expect(result.reportCalls).toBe(1);
    expect(result.queryPhases).toEqual(["initial"]);
    expect(result.answers).toContain(confirmed);
  });

  it("用户主动停止仍保留取消状态，不能由正常交付处理改成成功", async () => {
    const result = await runScenario("cancelled");
    expect(result.operationStatus).toBe("aborted");
    expect(result.modelCalls).toBe(1);
    expect(result.reportCalls).toBe(0);
    expect(result.answers).not.toContain(confirmed);
  });
});
