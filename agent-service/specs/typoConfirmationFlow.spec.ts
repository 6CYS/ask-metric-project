import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createAssistantMessageEventStream, createModels, createProvider,
  type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import type {AgentServiceConfig} from "../src/config.js";
import type {BackendClient} from "../src/backendClient.js";
import type {FixedTurnArgs} from "../src/business-context/fixedTurnArgs.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {NativeFrameStore} from "../src/business-context/store.js";
import {clarificationOptions} from "../src/business-context/clarificationOptions.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";
import {projectEntries} from "../src/sessionProjection.js";

type Reply = {text: string} | {args: Record<string, unknown>};
type Script = Array<Reply | ((messages: unknown[]) => Reply)>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks();});
const inherit = {action: "inherit" as const};
const rawMetric = "客户存款余款当日数";
const formalMetric = "客户存款余额当日数";
const correction = {match: "fuzzy_correction", understood_as: "客户存款余额",
  correction: {original: "客户存款余款", canonical: "客户存款余额", value_basis: "当日数", score: 0.8333}};

/** 只返回编排好的原生模型事件，任何阶段都不会创建 HTTP 模型请求。 */
async function setup(compact: boolean, pending: boolean) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "typo-confirmation-host-"));
  const script: Script = [];
  let calls = 0;
  const model: Model<"openai-completions"> = {id: "offline-script", name: "offline-script", api: "openai-completions",
    provider: "offline", baseUrl: "http://offline.invalid", reasoning: false, input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128_000, maxTokens: 8192};
  const respond: ProviderStreams["streamSimple"] = (_model, context) => {
    const next = script[calls++];
    if (!next) throw new Error("OFFLINE_SCRIPT_EXHAUSTED");
    const reply = typeof next === "function" ? next(context.messages) : next;
    const message: AssistantMessage = {role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: "text" in reply ? [{type: "text", text: reply.text}]
        : [{type: "toolCall", id: `script-${calls}`, name: "resolve_business_turn", arguments: reply.args}],
      stopReason: "text" in reply ? "stop" : "toolUse", timestamp: Date.now(),
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
  models.setProvider(createProvider({id: "offline", name: "offline", auth: {apiKey: {name: "offline", resolve: async () => ({auth: {}})}},
    models: [model], api: {stream: respond, streamSimple: respond}}));
  const config = {host: "127.0.0.1", port: 0, backendBaseUrl: "http://127.0.0.1:1", backendTimeoutMs: 1000, dataDir: dir,
    compactTurnArgs: compact, model: {baseUrl: "http://offline.invalid", name: model.id, apiKey: "", authHeader: "Authorization",
      authPrefix: "Bearer", userMessageSuffix: "", extraBody: {}, contextWindow: 128_000, maxTokens: 8192},
    compaction: {enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000},
    modelRetry: {enabled: false, maxRetries: 0, baseDelayMs: 1}} as AgentServiceConfig;
  const store = new NativeSessionStore(dir);
  const host = new HarnessHost(config, () => ({models, model}), store, createAskMetricTools({compactTurnArgs: compact}));
  cleanup.push(async () => {await host.close(); await store.close(); rmSync(dir, {recursive: true, force: true});});
  const session = await host.createSession(TEST_ACTOR);
  const frames = new NativeFrameStore(session.session);
  let queryCount = 0;
  const basicQueries = vi.fn(async (_query: unknown) => ({result: {status: "succeeded", task_id: `synthetic-query-${++queryCount}`,
    columns: [], rows: [], row_count: 0}}));
  const backend = {
    matchMetricQuestion: vi.fn(async (question: string) => {
      const start = question.indexOf(rawMetric);
      if (start < 0) return {mentions: []};
      return {mentions: [{text: rawMetric, start, end: start + rawMetric.length, group: {id: "g1"}, resolution: pending
        ? {status: "needs_confirmation", candidates: [{code: "M", value: formalMetric,
          metadata: {kind: "base", source_metric_code: "SRC", base_name: "客户存款余额", group: "g1"}}]}
        : {status: "resolved", value: {codes: ["M"], names: [formalMetric]}, metadata: correction}}]};
    }),
    resolveBusinessField: vi.fn(async (entity: string, names: string[]) => entity === "date"
      ? {status: "resolved", value: names[0]?.includes("9月") ? {start: "2026-09-30", end: "2026-09-30"}
        : names[0]?.includes("8月") ? {start: "2026-08-31", end: "2026-08-31"}
        : names[0]?.includes("31日") ? {start: "2026-07-31", end: "2026-07-31"}
        : {start: "2026-07-01", end: "2026-07-31"}}
      : entity === "organization" && pending
        ? {status: "needs_confirmation", candidates: [{code: "O", value: "合成甲银行（本级）"}]}
        : {status: "resolved", value: {codes: ["O"], names: ["合成甲银行（本级）"]}}),
    createAgentQueryContext: async () => ({conversation_id: "synthetic-conversation"}), basicQueries,
    getTask: async (taskId: string) => ({task_id: taskId, status: "SUCCEEDED", version: 1, result: {result_id: `result-${taskId}`}}),
  } as unknown as BackendClient;
  const call = (args: FixedTurnArgs): Reply => ({args: args as unknown as Record<string, unknown>});
  const ask = (requestId: string, message: string, selection?: {frame_id: string; option_ids: string[]}, target = session) => host.runPrompt(target,
    {protocol_version: 3, request_id: requestId, message, ...(selection ? {clarification_selection: selection} : {})}, {actor: TEST_ACTOR, backend});
  const latest = async () => {
    const state = await frames.state();
    return (await frames.get(state.focusFrameId!))!;
  };
  const projected = async () => projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
  return {script, host, session, frames, call, ask, latest, projected, basicQueries, calls: () => calls};
}

describe.each([false, true])("纠错、确认与宿主落地闭环（compact=%s）", compact => {
  it("新模型旧格式提案在入口拒绝，按固定协议修正后只执行一次", async () => {
    const f = await setup(compact, false);
    const original = `查询合成甲行2026年7月31日${rawMetric}`;
    f.script.push({args: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
      fieldIntents: {organizations: {mode: "set", sourceText: "合成甲行", expectedCount: null}}, fieldChanges: [
        {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}},
        {fieldHint: "organizations", operation: "set", rawValue: "合成甲行"},
        {fieldHint: "time", operation: "set", rawValue: "2026年7月31日"},
      ]}}, messages => {
      expect(f.basicQueries).not.toHaveBeenCalled();
      const failed = [...messages].reverse().find(raw => (raw as {role?: string}).role === "toolResult") as {isError?: boolean};
      expect(failed.isError).toBe(true);
      return f.call({protocol_version: 1, capability: "metric_query", base: null, mode: "execute", changes: {
        organizations: {action: "set", source_text: "合成甲行", expected_count: null, value: {kind: "name", name: "合成甲行"}},
        metrics: {action: "set", value: {fromQuestion: true}}, time: {action: "set", value: "2026年7月31日"},
      }});
    }, {text: "查询完成，当前没有匹配记录。"});
    expect(await f.ask("fixed-after-invalid", original))
      .toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
    expect(f.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.calls()).toBe(3);
    expect((await f.latest()).fields.metrics?.resolvedValue).toEqual({codes: ["M"], names: [formalMetric]});
  });

  it("后端已核验纠错直接查询，日期追问及重开保留原文绑定和纠错依据", async () => {
    const f = await setup(compact, false);
    const original = `查询合成甲行2026年7月31日${rawMetric}`;
    const binding = {text: rawMetric, start: original.indexOf(rawMetric), end: original.indexOf(rawMetric) + rawMetric.length, codes: ["M"]};
    const mention = {...binding, status: "resolved", value: {codes: ["M"], names: [formalMetric]}, metadata: correction};
    const {codes: _codes, ...mentionResolution} = mention;
    f.script.push(f.call({protocol_version: 1, capability: "metric_query", base: null, mode: "execute", changes: {
      metrics: {action: "set", value: {fromQuestion: true}},
      organizations: {action: "set", source_text: "合成甲行", expected_count: null, value: {kind: "name", name: "合成甲行"}},
      time: {action: "set", value: "2026年7月31日"},
    }}), {text: "查询完成，当前没有匹配记录。"});
    expect(await f.ask("initial", original)).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
    expect(f.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M"], org_codes: ["O"],
      time: {start: "2026-07-31", end: "2026-07-31"}, source_question: original,
      source_metric_bindings: [binding]});
    expect((await f.latest()).fields.metrics?.metadata?.mentionResolutions).toMatchObject([mentionResolution]);
    f.script.push(f.call({protocol_version: 1, capability: "metric_query", base: "current", mode: "execute",
      changes: {organizations: inherit, time: {action: "set", value: "2026年8月31日"}}}),
    {text: "日期已更新，当前没有匹配记录。"});
    expect(await f.ask("date-followup", "日期改为2026年8月31日")).toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
    expect(f.basicQueries).toHaveBeenCalledTimes(2);
    expect(f.basicQueries.mock.calls[1]?.[0]).toMatchObject({metric_codes: ["M"], org_codes: ["O"],
      time: {start: "2026-08-31", end: "2026-08-31"}, source_question: original, source_metric_bindings: [binding]});
    const saved = await f.latest();
    expect(saved.fields.metrics?.metadata?.mentionResolutions).toMatchObject([mentionResolution]);
    const answer = (await f.projected()).at(-1);
    expect(answer?.role === "assistant" ? answer.text : "").not.toContain("请确认");
    await f.host.closeSession(f.session.sessionId);
    const reopened = (await f.host.openSession(TEST_ACTOR, f.session.sessionId))!;
    const reopenedFields = (await new NativeFrameStore(reopened.session).get(saved.frameId))?.fields;
    expect(reopenedFields).toEqual(saved.fields);
    expect(reopenedFields?.metrics?.metadata?.mentionResolutions).toMatchObject([mentionResolution]);
    f.script.push(f.call({protocol_version: 1, capability: "metric_query", base: "current", mode: "execute",
      changes: {organizations: inherit, time: {action: "set", value: "2026年9月30日"}}}),
    {text: "日期已更新，当前没有匹配记录。"});
    expect(await f.ask("reopened-followup", "日期改为2026年9月30日", undefined, reopened))
      .toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
    expect(f.basicQueries).toHaveBeenCalledTimes(3);
    expect(f.basicQueries.mock.calls[2]?.[0]).toMatchObject({metric_codes: ["M"], org_codes: ["O"],
      time: {start: "2026-09-30", end: "2026-09-30"}, source_question: original, source_metric_bindings: [binding]});
  });

  it("仅点选指标后的额外错误动作可纠正，宿主交付剩余歧义且不循环或默认Top10", async () => {
    const f = await setup(compact, true);
    f.script.push(f.call({protocol_version: 1, capability: "metric_query", base: null, mode: "resolve_more", changes: {
      metrics: {action: "set", value: {fromQuestion: true}},
      organizations: {action: "set", source_text: "合成甲行", expected_count: null, value: {kind: "name", name: "合成甲行"}},
      time: {action: "set", value: "2026年7月"}, selection: {action: "clarify", source_text: "2026年7月"},
      operation: {action: "set", value: {kind: "ranking", position: "top", top_n: 10}},
    }}));
    expect(await f.ask("initial", `查询合成甲行2026年7月${rawMetric}排名`))
      .toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
    const pending = await f.latest();
    expect(pending.fields.operation?.resolutionStatus).toBe("ambiguous");
    expect(pending.fields.operation?.resolvedValue).not.toMatchObject({kind: "ranking", top_n: 10});
    const metric = clarificationOptions(pending, {metrics: "指标", organizations: "机构"})
      .flatMap(group => group.options).find(option => option.field === "metrics")!;
    expect(metric).toBeDefined();
    f.script.push(f.call({protocol_version: 1, capability: "metric_query", base: {frameId: pending.frameId}, mode: "execute", changes: {
      metrics: {action: "confirm", source_text: "客户存款余额", decision: "select"},
      organizations: {action: "confirm", source_text: "合成甲行", expected_count: null, decision: "select"},
      selection: {action: "clarify", source_text: "2026年7月"},
    }}), messages => {
      const receipt = [...messages].reverse().find(raw => (raw as {role?: string}).role === "toolResult") as
        {content: Array<{text?: string}>};
      const recovery = JSON.parse(receipt.content.find(block => block.text)?.text ?? "{}");
      expect(recovery.pending_fields).toEqual(expect.arrayContaining(["organizations", "selection"]));
      return f.call({protocol_version: 1, capability: "metric_query", base: recovery.retry_reference, mode: "execute",
        changes: {organizations: inherit, selection: inherit}});
    });
    expect(await f.ask("metric-confirmation", "客户存款余额", {frame_id: pending.frameId, option_ids: [metric.id]}))
      .toMatchObject({ok: true, outcome: {kind: "settled", outcome: {status: "completed"}}});
    const saved = await f.latest();
    expect(saved.status).toBe("clarifying");
    expect(saved.fields.metrics?.resolvedValue).toEqual({codes: ["M"], names: [formalMetric]});
    expect(saved.fields.organizations?.resolutionStatus).toBe("needs_confirmation");
    expect(saved.fields.selection?.resolutionStatus).toBe("ambiguous");
    expect(saved.fields.operation?.resolutionStatus).toBe("ambiguous");
    expect(saved.recovery).toBeUndefined();
    expect(f.calls()).toBe(3);
    expect(f.basicQueries).not.toHaveBeenCalled();
    const answer = (await f.projected()).at(-1);
    const reply = answer?.role === "assistant" ? answer.text ?? "" : "";
    expect(reply).toContain("合成甲银行");
    expect(reply).not.toContain("相同参数重复");
    expect(reply).not.toContain("您说的「客户存款");
    expect(reply).not.toContain("前 10");
  });
});
