import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {createAssistantMessageEventStream, createModels, createProvider, type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import type {BackendClient} from "../src/backendClient.js";
import type {AgentServiceConfig} from "../src/config.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {projectEntries} from "../src/sessionProjection.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";
import {CONVERSATION_REPLY} from "../src/tools/turnContract.js";
import {complete, proposal, syntheticBackend} from "./semantic-task/fixtures.js";

type Reply = string | Array<{name: string; args: unknown}> | {error: string} | {limit: Array<{name: string; args: unknown}>};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});

async function setup(script: Reply[], modelToolChoicePolicy?: "native" | "auto", retry = false) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "semantic-host-continuation-"));
  let calls = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const model: Model<"openai-completions"> = {id: "continuation-faux", name: "continuation-faux", api: "openai-completions", provider: "continuation-faux",
    baseUrl: "http://faux.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  const respond: ProviderStreams["streamSimple"] = (current, context, options) => {
    const reply = script[Math.min(calls++, script.length - 1)]!;
    const failed = !Array.isArray(reply) && typeof reply === "object" && "error" in reply;
    const limited = !Array.isArray(reply) && typeof reply === "object" && "limit" in reply;
    const callList = Array.isArray(reply) ? reply : limited ? reply.limit : [];
    const message: AssistantMessage = {role: "assistant", content: typeof reply === "string" ? [{type: "text", text: reply}]
      : callList.map((call, index) => ({type: "toolCall", id: `continuation-call-${calls}-${index}`, name: call.name, arguments: call.args as Record<string, unknown>})),
      api: current.api, provider: current.provider, model: current.id, stopReason: failed ? "error" : limited ? "length" : typeof reply === "string" ? "stop" : "toolUse", timestamp: Date.now(),
      ...(failed ? {errorMessage: reply.error} : {}),
      usage: {input: 100, output: 20, totalTokens: 120, cacheRead: 0, cacheWrite: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const payload = {tools: context.tools?.map(tool => ({type: "function", function: tool})) ?? []};
      payloads.push(await options?.onPayload?.(payload, current) as Record<string, unknown> ?? payload);
      stream.push({type: "start", partial: message});
      if (failed) stream.push({type: "error", reason: "error", error: message});
      else stream.push({type: "done", reason: limited ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop", message});
      stream.end(message);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider(createProvider({id: model.provider, name: model.provider, models: [model],
    auth: {apiKey: {name: "synthetic", resolve: async () => ({auth: {}})}}, api: {stream: respond, streamSimple: respond}}));
  const config: AgentServiceConfig = {host: "127.0.0.1", port: 0, backendBaseUrl: "http://faux.invalid", backendTimeoutMs: 1000, dataDir: dir,
    compaction: {enabled: false, reserveTokens: 1000, keepRecentTokens: 1000},
    modelRetry: {enabled: retry, maxRetries: retry ? 1 : 0, baseDelayMs: 1}, model: {baseUrl: "http://faux.invalid", name: model.id, apiKey: "", authHeader: "Authorization", authPrefix: "Bearer",
      userMessageSuffix: "", extraBody: {}, contextWindow: 128000, maxTokens: 8192}};
  const backend = syntheticBackend();
  if (modelToolChoicePolicy) config.modelToolChoicePolicy = modelToolChoicePolicy;
  const tools = createAskMetricTools();
  const read = tools.find(tool => tool.name === "read")!;
  const readExecute = vi.fn(read.execute);
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, () => ({models, model}), store, tools.map(tool => tool.name === "read" ? {...tool, execute: readExecute} : tool));
  cleanup.push(async () => {await host.close(); await store.close(); rmSync(dir, {recursive: true, force: true});});
  const session = await host.createSession(TEST_ACTOR);
  const run = (id: string, message: string) => host.runPrompt(session, {protocol_version: 3, request_id: id, message}, {actor: TEST_ACTOR, backend: backend as unknown as BackendClient});
  const entries = () => session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  return {backend, session, run, entries, payloads, readExecute, calls: () => calls};
}

const overviewArgs = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
  operations: [{action: "set", field: "organizations", value: "合成机构甲"}],
  analysis: {kind: "business_overview", plan: {topic: "loan", goal: "overview", sections: ["scale", "growth", "structure", "quality"]}}}]};
function bindOverview(f: Awaited<ReturnType<typeof setup>>) {
  const overview = vi.fn(async () => ({kind: "business_overview", status: "succeeded", delivery: "business_evidence_v1",
    topic: "loan", public_answer: "隔离合成证据", analysis_date: "2026-08-27", requested_date: "2026-08-27",
    org_codes: ["O1"], org_name: "合成机构甲", basis: "隔离样本", tasks: [], gaps: [], table_columns: [],
    table_rows: [{metric_id: "total", 指标: "各项贷款", 当前值: "120亿元"}],
    evidence_items: [{ref: "total.current", display: "120亿元", label: "各项贷款"}], plan: {questions: ["贷款规模"]}}));
  Object.assign(f.backend, {businessTopic: async () => ({version: "synthetic-v1", method: "business-overview-v1", metrics: []}), businessOverview: overview});
  return overview;
}

it("截断的调用不执行，只允许一次完整重发，原查询成功后正常结束", async () => {
  const args = proposal(complete());
  const f = await setup([{limit: [{name: "resolve_business_turn", args}]}, [{name: "resolve_business_turn", args}], "查询已完成。"]);
  await f.run("length-repair", "查询合成机构甲2025年末的合成指标甲");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(receipts.filter(item => (item.details as {status?: string})?.status === "MODEL_OUTPUT_LIMIT")).toHaveLength(1);
  expect(receipts.filter(item => item.toolName === "resolve_business_turn")).toHaveLength(1);
});

it("连续截断两次有界结束，绝不执行截断调用", async () => {
  const limited = {limit: [{name: "resolve_business_turn", args: proposal(complete())}]};
  const f = await setup([limited, limited]);
  await f.run("length-twice", "查询合成机构甲2025年末的合成指标甲");
  expect(f.calls()).toBe(2);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const answer = projectEntries(await f.entries()).filter(item => item.role === "assistant").at(-1);
  expect(answer?.text).toContain("截断的调用没有执行");
});

it("补查连续失败仍交付此前重新校验的数据，不被终止回执吞掉", async () => {
  const invalid = {...overviewArgs, protocol_version: 99};
  const f = await setup([[{name: "resolve_business_turn", args: overviewArgs}],
    [{name: "resolve_business_turn", args: invalid}], [{name: "resolve_business_turn", args: invalid}], "不能作为最终答案"]);
  const overview = bindOverview(f);
  await f.run("failed-followup", "合成机构甲最近贷款情况怎么样？");
  expect(overview).toHaveBeenCalledTimes(1);
  const reports = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolName === "analysis_partial_present" ? [entry.message.details] : []);
  expect(reports).toMatchObject([{status: "succeeded", partial_analysis: true, fallback_reason: "corrections_exhausted",
    rows: [{current_value: "120亿元"}]}]);
});

it("流停顿只重试未完成的模型生成，不重复已执行取数，恢复后交付正式报告", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: overviewArgs}],
    {error: "MODEL_STREAM_IDLE_EXCEEDED: stream idle timeout"}, [{name: "business_report_present", args: {
      evidence_refs: ["e1"], body: "贷款余额为{{total.current}}。", metric_ids: ["total"],
    }}]], undefined, true);
  const overview = bindOverview(f);
  await f.run("idle-retry", "合成机构甲最近贷款情况怎么样？");
  expect(overview).toHaveBeenCalledTimes(1);
  expect(f.calls()).toBe(3);
  const reports = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    && (entry.message.details as {kind?: string})?.kind === "business_report" ? [entry.message.details] : []);
  expect(reports).toMatchObject([{status: "succeeded", partial_analysis: false}]);
});

it("新会话缺机构和日期时直接交付缺项，不能继续读历史", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal([{action: "set", field: "metrics", value: "合成指标甲"}])}],
    [{name: "read", args: {kind: "list"}}]]);
  await f.run("missing-both", "查询合成指标甲");
  expect(f.calls()).toBe(1);
  expect(f.readExecute).not.toHaveBeenCalled(); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toHaveLength(1); expect(answers[0]).toContain("机构"); expect(answers[0]).toContain("日期范围");
});

it("auto兼容策略不放松业务守卫：忽略工具的模型仍被要求保存并交付缺项", async () => {
  const f = await setup(["我猜是120。", [{name: "resolve_business_turn", args: proposal([{action: "set", field: "metrics", value: "合成指标甲"}])}]], "auto");
  await f.run("auto-policy", "查询合成指标甲");
  expect(f.payloads.every(payload => payload.tool_choice === "auto")).toBe(true);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const answers = projectEntries(await f.entries()).flatMap(item => item.role === "assistant" ? [item.text] : []);
  expect(answers.join("\n")).not.toContain("120");
  expect(answers.join("\n")).toContain("机构");
});

it("空上下文后的纯计划不能交付，继续同轮提案后正式追问机构日期", async () => {
  const f = await setup([[{name: "business_context_read", args: {limit: 10}}], "我将提交查询并在之后确认机构和日期。",
    [{name: "resolve_business_turn", args: proposal([{action: "set", field: "metrics", value: "合成指标甲"}])}]]);
  await f.run("context-plan-missing-both", "查询合成指标甲");
  expect(f.calls()).toBe(3); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(receipts[0]?.details).toMatchObject({context: {tasks: []}});
  expect(receipts[1]?.toolCallId).toBe("semantic-action-required-1");
  expect(receipts[2]?.details).toMatchObject({status: "needs_user"});
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toHaveLength(1); expect(answers[0]).toContain("机构"); expect(answers[0]).toContain("日期范围");
  expect(answers[0]).not.toContain("我将提交");
});

it("独立问候直接交付，模型误读旧上下文时也不进入业务查询", async () => {
  const f = await setup([[{name: "business_context_read", args: {}}], [{name: CONVERSATION_REPLY, args: {answer: "你好，请问有什么需要帮助？"}}]]);
  await f.run("context-ordinary-reply", "你好");
  expect(f.calls()).toBe(1); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toEqual(["你好，请问有什么可以帮助你？"]);
});

it("上下文探索后的正式目录说明可交付，不强迫解析查询条件", async () => {
  const f = await setup([[{name: "business_context_read", args: {}}],
    [{name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "合成指标甲"}]}}], "目录中存在合成指标甲。"]);
  const searchMetrics = vi.fn(async () => ({total: 1, items: [{code: "M1", name: "合成指标甲", match_type: "exact"}], semantic_suggestions: []}));
  Object.assign(f.backend, {searchMetrics});
  await f.run("context-catalog-explanation", "查看合成指标甲的目录说明");
  expect(f.calls()).toBe(3); expect(searchMetrics).toHaveBeenCalledTimes(1); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolName] : []);
  expect(receipts).not.toContain("resolve_business_turn");
});

it.each(["before", "after"])("同批读取在缺项解析%s时，正式澄清结束本轮且没有多余模型往返", async order => {
  const resolution = {name: "resolve_business_turn", args: proposal(complete().filter(operation => operation.field !== "time"))};
  const read = {name: "read", args: {kind: "list"}};
  const f = await setup([order === "before" ? [read, resolution] : [resolution, read], "不应请求模型"]);
  await f.run("clarification-batch", "查询合成机构甲的合成指标甲");
  expect(f.calls()).toBe(1); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect(f.readExecute).toHaveBeenCalledTimes(order === "before" ? 1 : 0);
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers).toHaveLength(1); expect(answers[0]).toContain("日期范围");
});

it("旧在途澄清没有终止标记时，发送禁用工具且忽略网关额外读取", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete().filter(operation => operation.field !== "time"))}],
    [{name: "read", args: {kind: "list"}}]]);
  // 模拟升级前已持久化待用户回执但原生批次尚未结束的接续状态。
  f.session.harness.hooks.on("after_tool", event => event.toolName === "resolve_business_turn" ? {terminate: false} : undefined);
  await f.run("old-pending-clarification", "查询合成机构甲的合成指标甲");
  expect(f.calls()).toBe(2); expect(f.readExecute).not.toHaveBeenCalled(); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect(f.payloads[1]).toMatchObject({tool_choice: "none"}); expect(f.payloads[1]).not.toHaveProperty("tools");
  const answers = projectEntries(await f.entries()).flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);
  expect(answers.every(answer => answer.includes("日期范围"))).toBe(true);
});

it("协议字段动作不合法时按Schema纠正一次，业务条件不重复对账", async () => {
  const wrong = proposal([...complete(), {action: "exclude", field: "time", subject: "2025年末"}]);
  const f = await setup([[{name: "resolve_business_turn", args: wrong}], [{name: "resolve_business_turn", args: proposal(complete())}], "查询已完成。"]);
  await f.run("semantic-repair", "查询合成机构甲2025年末的合成指标甲");
  expect(f.payloads[1]).toMatchObject({tool_choice: {type: "function", function: {name: "resolve_business_turn"}}});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1); expect(f.readExecute).not.toHaveBeenCalled();
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.details] : []);
  expect(receipts[0]).toMatchObject({status: "invalid_input", issues: expect.arrayContaining([expect.objectContaining({code: "INPUT_SHAPE_INVALID"})])});
});

it.each(["read", "business_capability_explain"])("网关忽略协议修正要求而返回%s时仍允许完成参数修正", async tool => {
  const wrong = proposal([...complete(), {action: "exclude", field: "time", subject: "2025年末"}]);
  const f = await setup([[{name: "resolve_business_turn", args: wrong}],
    [{name: tool, args: tool === "read" ? {kind: "list"} : {capability: "comprehensive_analysis"}}],
    [{name: "resolve_business_turn", args: proposal(complete())}], "查询已完成。"]);
  await f.run("ignored-proposal-choice", "查询合成机构甲2025年末的合成指标甲");
  // 修复引导只剩 payload 层 tool_choice 强制；网关忽略时不再拦截旁支或合成 semantic-proposal-repair 回执。
  expect(f.payloads[1]).toMatchObject({tool_choice: {type: "function", function: {name: "resolve_business_turn"}}});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const receipts = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(receipts.some(receipt => receipt.toolCallId.startsWith("semantic-proposal-repair-"))).toBe(false);
});

it("真正引用冲突仍允许历史探索，不用通用修复接续挤掉read", async () => {
  const f = await setup([[{name: "resolve_business_turn", args: proposal(complete(), {kind: "current"})}],
    [{name: "read", args: {kind: "list"}}], [{name: "resolve_business_turn", args: proposal(complete())}], "查询已完成。"]);
  await f.run("reference-exploration", "查询合成机构甲2025年末的合成指标甲");
  expect(f.payloads[1]).not.toHaveProperty("tool_choice");
  expect(f.payloads[1]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({function: expect.objectContaining({name: "read"})})]));
  expect(f.readExecute).toHaveBeenCalledTimes(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("分析确实缺目录证据时允许catalog探索并在同一循环继续", async () => {
  const input = proposal([...complete(), {action: "set", field: "objective", value: "经营规模"}], {kind: "new"}, "analyze");
  const f = await setup([[{name: "resolve_business_turn", args: input}],
    [{name: "catalog", args: {action: "search", queries: [{entity: "metric", keyword: "经营"}]}}],
    [{name: "resolve_business_turn", args: input}], "分析已完成。"]);
  const searchMetrics = vi.fn(async () => ({total: 1, items: [{code: "M1", name: "合成指标甲", match_type: "contains"}], semantic_suggestions: []}));
  Object.assign(f.backend, {searchMetrics});
  await f.run("catalog-exploration", "分析合成机构甲2025年末的经营情况");
  expect(f.payloads[1]).not.toHaveProperty("tool_choice");
  expect(searchMetrics).toHaveBeenCalledTimes(1); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});


it.each(["failure", "unfinished"])("分析取数后%s仍交付已核验部分；下一轮问候不恢复查询", async mode => {
  const args = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
    operations: [{action: "set", field: "organizations", value: "合成机构甲"}],
    analysis: {kind: "business_overview", plan: {topic: "loan", goal: "overview", sections: ["scale", "growth", "structure", "quality"]}}}]};
  const f = await setup([[{name: "resolve_business_turn", args}], mode === "failure" ? {error: "502 upstream connect error"} : "查询完成。",
    ...(mode === "unfinished" ? ["仍然只给文字。", "仍未交付报告。"] : []),
    [{name: "business_context_read", args: {}}]]);
  const overview = vi.fn(async () => ({kind: "business_overview", status: "succeeded", delivery: "business_evidence_v1",
    topic: "loan", public_answer: "隔离合成证据", analysis_date: "2026-08-27", requested_date: "2026-08-27",
    org_codes: ["O1"], org_name: "合成机构甲", basis: "隔离样本", tasks: [], gaps: [], table_columns: [],
    table_rows: [{metric_id: "total", 指标: "各项贷款", 当前值: "120亿元"}],
    evidence_items: [{ref: "total.current", display: "120亿元", label: "各项贷款"}], plan: {questions: ["贷款规模"]}}));
  Object.assign(f.backend, {businessTopic: async () => ({version: "synthetic-v1", method: "business-overview-v1", metrics: []}),
    businessOverview: overview});
  await f.run("first-analysis", "合成机构甲最近贷款情况怎么样？");
  const entries = await f.entries();
  const reports = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolName === "analysis_partial_present" ? [entry.message.details as Record<string, unknown>] : []);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({status: "succeeded", partial_analysis: true,
    fallback_reason: mode === "failure" ? "model_failure" : "action_incomplete"});
  expect(reports[0]!.rows).toMatchObject([{metric_name: "各项贷款", current_value: "120亿元"}]);
  expect(entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolName === "business_action_required")).toHaveLength(mode === "unfinished" ? 2 : 0);
  await f.run("greeting-after-analysis", "你好？");
  expect(overview).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const messages = projectEntries(await f.entries());
  expect(messages.filter(item => item.role === "assistant").at(-1)?.text).toContain("你好");
});

it("取数后漏调用报告工具先纠正，模型完成正式报告后不降为部分结果", async () => {
  const args = {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
    operations: [{action: "set", field: "organizations", value: "合成机构甲"}],
    analysis: {kind: "business_overview", plan: {topic: "loan", goal: "overview", sections: ["scale", "growth", "structure", "quality"]}}}]};
  const f = await setup([[{name: "resolve_business_turn", args}], "已取得结果。", [{name: "business_report_present", args: {
    evidence_refs: ["e1"], body: "贷款余额为{{total.current}}。", metric_ids: ["total"],
  }}]], "auto");
  Object.assign(f.backend, {businessTopic: async () => ({version: "synthetic-v1", method: "business-overview-v1", metrics: []}),
    businessOverview: async () => ({kind: "business_overview", status: "succeeded", delivery: "business_evidence_v1",
      topic: "loan", public_answer: "隔离合成证据", analysis_date: "2026-08-27", requested_date: "2026-08-27",
      org_codes: ["O1"], org_name: "合成机构甲", basis: "隔离样本", tasks: [], gaps: [], table_columns: [],
      table_rows: [{metric_id: "total", 指标: "各项贷款", 当前值: "120亿元"}],
      evidence_items: [{ref: "total.current", display: "120亿元", label: "各项贷款"}], plan: {questions: ["贷款规模"]}})});
  await f.run("report-repair", "合成机构甲最近贷款情况怎么样？");
  const tools = (await f.entries()).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  expect(tools.filter(item => item.toolName === "business_action_required"), JSON.stringify(tools.map(item => ({name: item.toolName, details: item.details})))).toHaveLength(1);
  expect(tools.filter(item => item.toolName === "analysis_partial_present")).toHaveLength(0);
  expect(tools.find(item => item.toolName === "business_report_present")?.details).toMatchObject({kind: "business_report", status: "succeeded", partial_analysis: false});
});
