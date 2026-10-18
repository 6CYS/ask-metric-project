/**
 * semantic_v2 机构自主匹配合成验收：编排模型 + 桩后端，不接真实模型和真实后端。
 * 覆盖：① 机构清单注入 semantic_v2 轮状态；② 追问「沐阳的呢？」replace subject 取上一轮机构身份不被拦；
 * ③ suggestion 直达 + 错字纠正明示端到端；④ 零候选澄清话术引导改写；⑤ 首推确认话术与“是”确认。
 * 运行：npx tsx scripts/check-org-suggestion-semantic.ts
 */
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createAssistantMessageEventStream, createModels, createProvider,
  type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import type {AgentServiceConfig} from "../src/config.js";
import {type BackendClient, type FieldSuggestion} from "../src/backendClient.js";
import type {FieldResolution} from "../src/business-context/types.js";
import type {SemanticFeedback} from "../src/semantic-task/feedback.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";

/** 目录只认编码与别名，不认全称：供 replace subject 身份回退用例覆盖。 */
const ORGS = [
  {code: "O-WX", name: "无锡农商银行", aliases: ["无锡"]},
  {code: "O-SY", name: "沭阳农商银行", aliases: ["沭阳"]},
  {code: "O-XY", name: "锡银农商银行", aliases: ["锡银"]},
  {code: "O-XS", name: "锡山农商银行", aliases: ["锡山"]},
];
const METRIC = {code: "M1", name: "贷款余额"};
const DATE = {start: "2026-03-31", end: "2026-03-31"};
const DATE_TEXT = "2026年3月末";

type Reply = {text: string} | {args: Record<string, unknown>};
/** 动态剧本：依赖上一轮已发布问题的 question_id/option_id 时，按模型上下文现取。 */
type ScriptedReply = Reply | ((context: {messages: Array<{role: string; toolName?: string; details?: unknown;
  content?: unknown}>}) => Reply);

/** 编排模型：只按剧本返回原生事件，不发起任何 HTTP 模型请求；同时捕获每轮发送的用户消息副本。 */
function scriptedModel(script: ScriptedReply[], captured: string[][]) {
  const model: Model<"openai-completions"> = {id: "offline-semantic-org", name: "offline-semantic-org",
    api: "openai-completions", provider: "offline", baseUrl: "http://offline.invalid", reasoning: false, input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128_000, maxTokens: 8192};
  let calls = 0;
  const respond: ProviderStreams["streamSimple"] = (_model, context) => {
    const entry = script[calls++];
    if (!entry) throw new Error("OFFLINE_SCRIPT_EXHAUSTED");
    const next = typeof entry === "function" ? entry(context as never) : entry;
    captured.push(context.messages.filter(message => message.role === "user")
      .map(message => typeof message.content === "string" ? message.content
        : message.content.filter(block => block.type === "text").map(block => block.text).join("")));
    const message: AssistantMessage = {role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: "text" in next ? [{type: "text", text: next.text}]
        : [{type: "toolCall", id: `script-${calls}`, name: "resolve_business_turn", arguments: next.args}],
      stopReason: "text" in next ? "stop" : "toolUse", timestamp: Date.now(),
      usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({type: "start", partial: message});
      stream.push({type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message});
      stream.end(message);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider(createProvider({id: "offline", name: "offline",
    auth: {apiKey: {name: "offline", resolve: async () => ({auth: {}})}},
    models: [model], api: {stream: respond, streamSimple: respond}}));
  return {models, model};
}

function mention(question: string) {
  const start = question.indexOf(METRIC.name);
  return start < 0 ? [] : [{text: METRIC.name, start, end: start + METRIC.name.length,
    resolution: {status: "resolved" as const, value: {codes: [METRIC.code], names: [METRIC.name]}}}];
}

/** 桩后端：语义链路所需的目录/目标检查/执行全部为合成数据；suggestCalls 记录建议通道负载。
 *  统一语义入口后不再有后端整批准入，机构来源由宿主 suggestion 通道与来源确认题裁定。 */
function stubBackend(options: {
  suggest: (suggested: FieldSuggestion[], rawValues?: string[]) => Promise<FieldResolution>;
  resolveFullNames?: boolean;
}) {
  const suggestCalls: FieldSuggestion[][] = [];
  const queries: Array<{org_codes?: string[]} > = [];
  const backend = {
    orgCatalog: async () => ({items: ORGS.map(org => ({code: org.code, name: org.name, aliases: org.aliases}))}),
    matchMetricQuestion: async (question: string) => ({mentions: mention(question)}),
    inspectBusinessGoal: async (question: string) => ({
      question, reference_year: null, requires_calculation: false,
      fragments: [{question,
        organizations: ORGS.filter(org => org.aliases.some(alias => question.includes(alias))).map(org => org.code),
        calendar: question.includes("3月末") ? {ranges: [{...DATE}], unresolved: []} : {ranges: [], unresolved: []},
        mentions: mention(question)}],
    }),
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, _year?: number,
      source?: {source_question: string}): Promise<FieldResolution> => {
      if (entity === "date") return raw[0]?.includes("3月末")
        ? {status: "resolved", value: {...DATE}, metadata: {source_calendar: {ranges: [{...DATE}], unresolved: []}}}
        : {status: "invalid", metadata: {reason: "unsupported_expression"}};
      if (entity === "metric") return raw.length && raw.every(value => value === METRIC.code || value === METRIC.name)
        ? {status: "resolved", value: {codes: raw.map(() => METRIC.code), names: raw.map(() => METRIC.name)}} : {status: "not_found"};
      const codes = raw.map(text => ORGS.some(org => org.code === text) ? text
        : (options.resolveFullNames ? ORGS.find(org => org.name === text) : undefined)?.code
        ?? ORGS.find(org => org.aliases.includes(text))?.code);
      if (codes.some(code => !code)) return {status: "not_found"};
      const question = source?.source_question ?? "";
      return {status: "resolved",
        value: {codes, names: codes.map(code => ORGS.find(org => org.code === code)!.name)},
        metadata: {source_codes: codes.filter((code, index) => question.includes(raw[index]!))}};
    },
    resolveBusinessFieldSuggestion: async (_entity: string, suggested: FieldSuggestion[], _options?: unknown,
      _sourceQuestion?: string, rawValues?: string[]): Promise<FieldResolution> => {
      suggestCalls.push(suggested);
      return options.suggest(suggested, rawValues);
    },
    createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}),
    basicQueries: async (spec: {org_codes?: string[]}) => {
      queries.push(spec);
      return {result: {task_id: `synthetic-task-${queries.length}`, status: "succeeded",
        columns: [], rows: [], row_count: 0, truncated: false, message: "合成查询无记录。"}};
    },
    getTask: async (taskId: string) => ({task_id: taskId, status: "SUCCEEDED", version: 1,
      result: {result_id: `result:${taskId}`}}),
    getTaskResult: async () => { throw new Error("本场景不读取历史结果"); },
  } as unknown as BackendClient;
  return {backend, suggestCalls, queries};
}

function config(dir: string): AgentServiceConfig {
  return {host: "127.0.0.1", port: 0, backendBaseUrl: "http://127.0.0.1:1", backendTimeoutMs: 1000, dataDir: dir,
    businessProtocol: "semantic_v2",
    model: {baseUrl: "http://offline.invalid", name: "offline-semantic-org", apiKey: "", authHeader: "Authorization",
      authPrefix: "Bearer", userMessageSuffix: "", extraBody: {}, contextWindow: 128_000, maxTokens: 8192},
    compaction: {enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000},
    modelRetry: {enabled: false, maxRetries: 0, baseDelayMs: 1}} as AgentServiceConfig;
}

/** 版本2语义提议参数。 */
function resolveArgs(operations: Array<Record<string, unknown>>, source: Record<string, unknown> = {kind: "new"}) {
  return {protocol_version: 2, intent: "query", targets: [{source, operations}]};
}
const setOrg = (value: string, suggestion?: Record<string, string>) =>
  ({action: "set", field: "organizations", value, ...(suggestion ? {suggestion} : {})});
const fullOps = (org: Record<string, unknown>) => [org,
  {action: "set", field: "metrics", value: METRIC.name}, {action: "set", field: "time", value: DATE_TEXT}];

async function receipts(hosted: Awaited<ReturnType<HarnessHost["createSession"]>>) {
  const entries = await hosted.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT);
  return entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult").map(entry => entry.message);
}
const succeededFeedback = (messages: Array<{toolName?: string; details?: unknown}>) =>
  [...messages].reverse().find(message => message.toolName === "resolve_business_turn"
    && (message.details as SemanticFeedback | undefined)?.status === "succeeded")?.details as SemanticFeedback | undefined;

interface ScenarioResult {scenario: string; passed: boolean}
const results: ScenarioResult[] = [];
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    results.push({scenario: name, passed: true});
    console.log(JSON.stringify({scenario: name, passed: true}));
  } catch (error) {
    results.push({scenario: name, passed: false});
    console.log(JSON.stringify({scenario: name, passed: false,
      reason: error instanceof Error ? error.message : String(error)}));
  }
}

/** ①③ 清单注入 + suggestion 直达 + 错字纠正明示端到端。 */
async function directSuggestion(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "semantic-org-direct-"));
  const {backend, suggestCalls, queries} = stubBackend({
    suggest: async suggested => {
      assert.deepEqual(suggested, [{name: "沭阳农商银行", excerpt: "沐阳"}]);
      return {status: "resolved", value: {codes: ["O-SY"], names: ["沭阳农商银行"]},
        metadata: {resolution_source: "corrected", source_codes: ["O-SY"],
          corrections: [{raw: "沐阳", corrected_name: "沭阳农商银行", corrected_code: "O-SY"}]}};
    },
  });
  const captured: string[][] = [];
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: resolveArgs(fullOps(setOrg("沐阳", {name: "沭阳农商银行", excerpt: "沐阳"})))},
    {text: "已按回执告知用户查询结果。"},
  ], captured), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "direct-1",
      message: `查沐阳${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 1, "模型建议通道应被调用一次");
    // ① semantic_v2 轮状态已注入有权机构清单。
    assert(captured.some(messages => messages.some(text => text.includes("有权机构清单")
      && text.includes("O-SY|沭阳农商银行|沭阳"))), "semantic_v2 轮状态应包含有权机构清单");
    assert.equal(queries.length, 1, "应执行一次查询");
    assert.deepEqual(queries[0]!.org_codes, ["O-SY"]);
    const feedback = succeededFeedback(await receipts(hosted));
    const evidence = feedback?.state.evidence as {public_answer?: string; resolution_notice?: string[]} | undefined;
    assert(evidence?.resolution_notice?.includes("已按「沭阳农商银行」查询（您说的是「沐阳」）"),
      "执行证据应含固定明示 resolution_notice");
    assert(evidence?.public_answer?.startsWith("已按「沭阳农商银行」查询（您说的是「沐阳」）"),
      "public_answer 应前置错字纠正明示");
    const frames = await new NativeFrameStore(hosted.session).list();
    const success = frames.find(frame => frame.status === "success");
    assert(success, "应存在成功执行的 Frame");
    assert.equal(success!.fields.organizations?.metadata?.resolution_source, "corrected");
    assert.equal(success!.fields.organizations?.metadata?.rawExcerpt, "沐阳");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** ② 追问「沐阳的呢？」：replace subject 取上一轮机构身份（目录不认全称）不再被拦，suggestion 换机构成功。 */
async function replaceSubjectIdentity(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "semantic-org-replace-"));
  const {backend, suggestCalls, queries} = stubBackend({
    suggest: async suggested => {
      assert.deepEqual(suggested, [{name: "沭阳农商银行", excerpt: "沐阳"}]);
      return {status: "resolved", value: {codes: ["O-SY"], names: ["沭阳农商银行"]},
        metadata: {resolution_source: "model_inferred", source_codes: ["O-SY"]}};
    },
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: resolveArgs(fullOps(setOrg("无锡")))},
    {text: "已告知无锡的查询结果。"},
    {args: resolveArgs([{action: "replace", field: "organizations", subject: "无锡农商银行",
      value: "沐阳", suggestion: {name: "沭阳农商银行", excerpt: "沐阳"}}], {kind: "current"})},
    {text: "已告知沭阳的查询结果。"},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "replace-1",
      message: `查无锡${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "replace-2",
      message: "沐阳的呢？"}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 1, "追问应走模型建议通道");
    assert.equal(queries.length, 2, "两轮都应执行查询");
    assert.deepEqual(queries[1]!.org_codes, ["O-SY"], "replace 应把机构换成沭阳");
    const messages = await receipts(hosted);
    const blocked = messages.some(message => message.toolName === "resolve_business_turn"
      && ((message.details as SemanticFeedback | undefined)?.issues ?? [])
        .some(issue => issue.code === "SUBJECT_NOT_IN_TARGET"));
    assert(!blocked, "subject 取被修改对象身份不得再被 SUBJECT_NOT_IN_TARGET 拦下");
    const feedback = succeededFeedback(messages);
    const evidence = feedback?.state.evidence as {public_answer?: string} | undefined;
    assert(evidence?.public_answer?.includes("已按「沭阳农商银行」查询（您说的是「沐阳」）"),
      "追问替换后仍应带模型推断明示");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** ④ 零候选 not_found：澄清话术必须引导用户改写，不能原样复读错名。 */
async function notFoundGuidance(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "semantic-org-notfound-"));
  const {backend, suggestCalls} = stubBackend({
    suggest: async () => { throw new Error("本场景不应进入建议通道"); },
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: resolveArgs(fullOps(setOrg("某未知机构")))},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "notfound-1",
      message: `查某未知机构${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 0);
    const messages = await receipts(hosted);
    const clarification = messages.find(message => message.toolName === "resolve_business_turn"
      && (message.details as SemanticFeedback | undefined)?.status === "needs_user");
    assert(clarification, "零候选应交付 needs_user 澄清");
    const text = clarification!.content.filter(block => block.type === "text").map(block => block.text).join("");
    assert(text.includes("未找到名为「某未知机构」的机构，请换个说法或回复机构全称"),
      "零候选话术必须引导用户改写，实际：" + text.slice(0, 200));
    assert(!text.includes("请确定机构名称：某未知机构"), "不能再原样复读错名");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** ⑤ 首推确认：建议值在候选中标记 preferred，话术确认式；用户回复“是”直接确认首选。 */
async function preferredConfirmation(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "semantic-org-preferred-"));
  const {backend, suggestCalls, queries} = stubBackend({
    suggest: async () => ({status: "needs_confirmation", candidates: [
      // 首推标记由后端解析签发；桩忠实复刻该契约。
      {value: "锡银农商银行", code: "O-XY", preferred: true},
      {value: "锡山农商银行", code: "O-XS"},
    ]}),
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: resolveArgs(fullOps(setOrg("锡银", {name: "锡银农商银行", excerpt: "锡银"})))},
    // 已发布问题只用结构化 answers 回答（新契约）；kind=confirm 的问题 accept 即确认首推。
    context => {
      const receipt = [...context.messages].reverse().find(message => message.toolName === "resolve_business_turn"
        && (message.details as SemanticFeedback | undefined)?.status === "needs_user");
      const question = (receipt?.details as SemanticFeedback | undefined)?.pending_questions
        ?.find(item => item.scope.field === "organizations");
      assert(question?.kind === "confirm", "剧本依赖已发布的 confirm 问题");
      return {args: {...resolveArgs([], {kind: "current"}), answers: [{question_id: question!.question_id,
        version: question!.version, choice: {type: "accept"}, evidence: {excerpt: "是"}}]}};
    },
    {text: "已告知锡银农商银行的查询结果。"},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "preferred-1",
      message: `查锡银${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 1);
    const first = (await receipts(hosted)).find(message => message.toolName === "resolve_business_turn"
      && (message.details as SemanticFeedback | undefined)?.status === "needs_user");
    const answer = first?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "";
    // 确认式话术 + kind=confirm 机器契约：确认对象必须是首推候选。
    assert(answer.includes("您是指「锡银农商银行」吗？"), "首推候选应使用确认式话术");
    assert(answer.indexOf("1. 锡银农商银行") < answer.indexOf("2. 锡山农商银行"), "首推候选应置顶");
    const question = (first?.details as SemanticFeedback | undefined)?.pending_questions
      ?.find(item => item.scope.field === "organizations");
    assert.equal(question?.kind, "confirm", "首推问题应签发 confirm 类型");
    const confirmation = question?.options.find(option => option.option_id === question.confirmation_option_id);
    assert.equal(confirmation?.label, "锡银农商银行", "确认对象应指向首推候选");
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "preferred-2",
      message: "是"}, {actor: TEST_ACTOR, backend});
    assert.equal(queries.length, 1, "确认后应执行一次查询");
    assert.deepEqual(queries[0]!.org_codes, ["O-XY"], "“是”应确认首推候选而非其他机构");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** ⑥ 旧整批准入对账已删除：追问「沐阳呢？」replace+suggestion 在统一入口一次落地执行，
 *  不再出现 TRANSITION_SOURCE_UNGROUNDED 拒绝、pi 循环与熔断；模型推断来源仍向用户明示。 */
async function suggestionGroundingRecovery(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "semantic-org-grounding-"));
  const {backend, suggestCalls, queries} = stubBackend({
    resolveFullNames: true,
    suggest: async suggested => {
      assert.deepEqual(suggested, [{name: "沭阳农商银行", excerpt: "沐阳"}]);
      return {status: "resolved", value: {codes: ["O-SY"], names: ["沭阳农商银行"]},
        metadata: {resolution_source: "model_inferred", source_codes: ["O-SY"]}};
    },
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: resolveArgs(fullOps(setOrg("无锡")))},
    {text: "已告知无锡的查询结果。"},
    {args: resolveArgs([{action: "replace", field: "organizations", subject: "无锡农商银行",
      value: "沐阳", suggestion: {name: "沭阳农商银行", excerpt: "沐阳"}}], {kind: "current"})},
    {text: "已告知沭阳农商银行的查询结果。"},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "grounding-1",
      message: `查无锡${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(queries.length, 1);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "grounding-2",
      message: "沐阳呢？"}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 1, "追问应走模型建议通道");
    const messages = await receipts(hosted);
    const feedback = succeededFeedback(messages);
    // 关键断言：统一入口直接落地，无旧准入拒绝与模型重试循环。
    assert(feedback, "追问应一次解析成功");
    assert(!messages.some(message => message.toolName === "resolve_business_turn"
      && ((message.details as SemanticFeedback | undefined)?.issues ?? [])
        .some(issue => issue.remediation === "pi")), "不应残留驱动模型重试的 pi 级 issue");
    assert(!JSON.stringify(messages).includes("TRANSITION_SOURCE_UNGROUNDED"), "旧准入错误码不得再出现");
    assert.equal(queries.length, 2, "追问应直接执行一次查询");
    assert.deepEqual(queries[1]!.org_codes, ["O-SY"]);
    const evidence = feedback?.state.evidence as {public_answer?: string} | undefined;
    assert(evidence?.public_answer?.includes("已按「沭阳农商银行」查询（您说的是「沐阳」）"),
      "模型推断来源仍应向用户明示");
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

/** ⑦ 提示词纪律：清单中没有与用户措辞相符的机构时，模型走 value 旧路径，不得换成不相干机构。 */
/** ⑧ 多机构一次 set + 单条 suggestion：value 全部成员必须保留并进入查询（忠实模拟后端 raw_values+suggested 合并）。 */
async function multiOrgSingleSuggestion(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "semantic-org-multi-"));
  const {backend, queries} = stubBackend({
    suggest: async (suggested, rawValues) => {
      assert.deepEqual(suggested, [{name: "无锡农商银行", excerpt: "无锡"}]);
      // 与后端 resolve-field 合并语义一致：raw_values 逐条阶梯解析，suggested 并入；
      // 全部成员须保留，不能只留建议项。
      const codes = (rawValues ?? []).map(text => ORGS.find(org => org.name === text
        || org.aliases.includes(text))?.code).filter((code): code is string => !!code);
      for (const entry of suggested) {
        const hit = ORGS.find(org => org.code === entry.code || org.name === entry.name);
        if (hit && !codes.includes(hit.code)) codes.push(hit.code);
      }
      return {status: "resolved",
        value: {codes, names: codes.map(code => ORGS.find(org => org.code === code)!.name)},
        metadata: {resolution_source: "model_inferred", source_codes: codes}};
    },
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    {args: resolveArgs(fullOps(setOrg("无锡、锡山", {name: "无锡农商银行", excerpt: "无锡"})))},
    {text: "已按回执告知用户查询结果。"},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "multi-1",
      message: `查无锡、锡山${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(queries.length, 1, "多机构提案应执行一次查询，实际：" + queries.length);
    assert.deepEqual([...(queries[0]?.org_codes ?? [])].sort(), ["O-WX", "O-XS"],
      "value 全部成员必须进入查询，实际：" + JSON.stringify(queries[0]?.org_codes));
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

async function noMatchDiscipline(): Promise<void> {
  const {buildSemanticSystemPrompt, buildCompactSemanticSystemPrompt} = await import("../src/semantic-task/prompt.js");
  for (const prompt of [buildSemanticSystemPrompt("2026-10-15"), buildCompactSemanticSystemPrompt("2026-10-15")]) {
    assert(prompt.includes("不得换成不相干机构"), "系统提示词应禁止无依据换机构");
    assert(prompt.includes("无共同词根"), "系统提示词应标记无共同词根的高风险选择");
  }
  const dir = await mkdtemp(join(tmpdir(), "semantic-org-discipline-"));
  const {backend, suggestCalls} = stubBackend({
    suggest: async () => { throw new Error("清单无相符机构时不应使用 suggestion"); },
  });
  const host = new HarnessHost(config(dir), () => scriptedModel([
    // 编排模型按新提示词规则：清单无“黑马”相符机构，走 value 旧路径。
    {args: resolveArgs(fullOps(setOrg("黑马银行")))},
  ], []), new NativeSessionStore(dir), createAskMetricTools());
  try {
    const hosted = await host.createSession(TEST_ACTOR);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "discipline-1",
      message: `查黑马银行${DATE_TEXT}贷款余额`}, {actor: TEST_ACTOR, backend});
    assert.equal(suggestCalls.length, 0, "清单无相符机构时不得提交 suggestion");
    const clarification = (await receipts(hosted)).find(message => message.toolName === "resolve_business_turn"
      && (message.details as SemanticFeedback | undefined)?.status === "needs_user");
    const text = clarification?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "";
    assert(text.includes("未找到名为「黑马银行」的机构，请换个说法或回复机构全称"),
      "value 路径零候选应引导改写，实际：" + text.slice(0, 200));
  } finally { await host.close(); await rm(dir, {recursive: true, force: true}); }
}

await scenario("semantic_org_catalog_injected_and_suggestion_direct", directSuggestion);
await scenario("semantic_replace_subject_identity", replaceSubjectIdentity);
await scenario("semantic_org_not_found_guidance", notFoundGuidance);
await scenario("semantic_preferred_confirmation", preferredConfirmation);
await scenario("semantic_suggestion_grounding_recovery", suggestionGroundingRecovery);
await scenario("semantic_no_match_discipline", noMatchDiscipline);
await scenario("semantic_multi_org_single_suggestion", multiOrgSingleSuggestion);
const passed = results.every(result => result.passed);
console.log(JSON.stringify({passed, environment: "offline_scripted_model_stub_backend", scenarios: results.length}));
if (!passed) process.exitCode = 1;
