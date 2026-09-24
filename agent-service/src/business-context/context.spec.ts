import {mkdtempSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {NativeSessionStore} from "../nativeSessions.js";
import {NativeBusinessResultStore, NativeFrameStore} from "./store.js";
import {BusinessContextService} from "./service.js";
import {createCapabilities} from "./capabilities.js";
import {createFieldResolvers} from "./resolvers.js";
import {CapabilityRegistry, FieldResolverRegistry, mergeFields, resolveFrame, validateFrame} from "./core.js";
import type {BusinessFrame, ContextDelta, ResolverContext} from "./types.js";
import {createExecuteBusinessFrameTool, createResolveBusinessTurnTool, createReadBusinessResultTool} from "../tools/businessContext.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../tools/testUtils.js";
import type {BackendClient} from "../backendClient.js";
import {BackendApiError} from "../backendClient.js";
import {createAskMetricTools} from "../tools/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
async function fixture() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "business-frames-"));
  const sessions = new NativeSessionStore(path);
  const session = await sessions.create("synthetic-user");
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const identity = {sessionId: session.metadata.id, turnId: "turn-a", requestId: "request-a"};
  const context: ResolverContext = {originalMessage: "样本指标甲 样本机构甲 2026年2月28日", currentDate: "2026-09-21", turnId: identity.turnId,
    resolveCatalog: async (entity, raw) => ({status: "resolved", value: entity === "date" ? {start: "2026-02-28", end: "2026-02-28"} : {codes: raw.map(text => `${entity}:${text}`), names: raw}})};
  const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: "样本指标甲"},
    {fieldHint: "organizations", operation: "set", rawValue: "样本机构甲"},
    {fieldHint: "time", operation: "set", rawValue: "2026年2月28日"},
    {fieldHint: "selection", operation: "set", rawValue: "exact"},
  ]};
  return {path, sessions, session, store, service, identity, context, delta};
}
it("新查询、缺项澄清、补充、继承、清除、任意历史分支不覆盖旧 Frame", async () => {
  const f = await fixture();
  const first = await f.service.resolve({...f.delta, fieldChanges: f.delta.fieldChanges.filter(c => c.fieldHint !== "time")}, f.identity, f.context);
  expect(first.status).toBe("clarifying"); expect(first.issues).toEqual([{field: "time", reason: "missing"}]);
  const nextId = {...f.identity, turnId: "turn-b", requestId: "request-b"};
  const second = await f.service.resolve({fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "2026年2月28日"}], executionMode: "execute"}, nextId, {...f.context, turnId: nextId.turnId});
  expect(second.status).toBe("ready"); expect(second.fields.metrics?.sourceFrameId).toBe(first.frameId);
  const cleared = await f.service.resolve({fieldChanges: [{fieldHint: "metrics", operation: "clear"}], executionMode: "execute"}, {...nextId, requestId: "clear"}, f.context);
  expect(cleared.issues).toEqual([{field: "metrics", reason: "missing"}]);
  const branch = await f.service.resolve({baseReference: {ordinal: 2}, fieldChanges: [], executionMode: "resolve_more"}, {...nextId, requestId: "branch"}, f.context);
  expect(branch.parentFrameId).toBe(second.frameId); expect(branch.fields.metrics?.resolutionStatus).toBe("resolved");
  expect(await f.store.get(first.frameId)).toEqual(first);
});
it("Selector 多匹配/无匹配不选最近，执行快照不改变操作序号", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  const success = await f.service.finishExecution(executing, {status: "success", resultRef: "query:t:r"});
  await f.service.resolve(f.delta, {...f.identity, requestId: "b", turnId: "b"}, f.context);
  const state = await f.store.state(); const frames = await f.store.list();
  expect(resolveFrame({ordinal: 1}, state, frames)).toEqual({status: "resolved", frameId: success.frameId});
  expect(resolveFrame({capability: "metric_query"}, state, frames).status).toBe("ambiguous");
  expect(resolveFrame({ordinal: 999}, state, frames).status).toBe("not_found");
  const missing = await f.service.resolve({baseReference: {ordinal: 999}, capabilityHint: "metric_query", fieldChanges: [], executionMode: "execute"}, {...f.identity, requestId: "missing"}, f.context);
  expect(missing.issues).toContainEqual({field: "$base", reason: "not_found"});
});
it("失败不成为自动继承源，也不静默回退到失败之前", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  await f.service.finishExecution(executing, {status: "failed", errorCode: "SYNTHETIC_FAILURE"});
  const next = await f.service.resolve({fieldChanges: [], executionMode: "execute"}, {...f.identity, requestId: "next"}, f.context);
  expect(next.status).toBe("clarifying"); expect(next.issues.some(issue => issue.field === "$base")).toBe(true);
});
it("上游执行失败后，澄清必须给出可继承祖先候选，用户显式指认即可推进", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  await f.service.finishExecution(executing, {status: "failed", errorCode: "SYNTHETIC_FAILURE"});
  // 首次受阻：仍拒绝自动继承，但必须给出候选，否则澄清无法回答（$base 自锁且无出口）。
  const blocked = await f.service.resolve({fieldChanges: [], executionMode: "execute"}, {...f.identity, requestId: "blocked"}, f.context);
  expect(blocked.status).toBe("clarifying");
  const issue = blocked.issues.find(entry => entry.field === "$base");
  expect(issue?.reason).toBe("invalid");
  expect(issue?.message).toBeDefined();
  const {candidates} = JSON.parse(issue!.message!) as {candidates: string[]};
  // 候选是最近的可继承祖先（READY 的准备帧），不是失败帧本身。
  expect(candidates).toEqual([ready.frameId]);
  expect(candidates).not.toContain(executing.frameId);
  // 显式指认该候选即可绕过失败链推进，且继承到已确认条件。
  const recovered = await f.service.resolve({baseReference: {frameId: candidates[0]!}, fieldChanges: [], executionMode: "execute"},
    {...f.identity, requestId: "recovered"}, f.context);
  expect(recovered.status).toBe("ready");
  expect(recovered.issues.some(entry => entry.field === "$base")).toBe(false);
  expect(recovered.fields.organizations?.resolvedValue).toBeDefined();
});
it("Frame/焦点/幂等记录事务保存，重启恢复；过期 CAS 与覆写被拒绝", async () => {
  const f = await fixture(); const first = await f.service.resolve(f.delta, f.identity, f.context);
  expect((await f.service.resolve(f.delta, f.identity, f.context)).frameId).toBe(first.frameId);
  expect(await f.store.list()).toHaveLength(1);
  await expect(f.store.setFocus(first.frameId, 0)).rejects.toThrow("BUSINESS_CONTEXT_CONFLICT");
  await expect(f.store.save(first, 1, "another-key")).rejects.toThrow("FRAME_IMMUTABLE");
  await f.sessions.release("synthetic-user", f.session.metadata.id);
  const session = await f.sessions.open("synthetic-user", f.session.metadata);
  const store = new NativeFrameStore(session);
  expect(await store.get(first.frameId)).toEqual(first); expect((await store.state()).focusFrameId).toBe(first.frameId);
});
it("两个同版本并发写入只有一个成功，不覆盖焦点", async () => {
  const f = await fixture(); const first = await f.service.resolve(f.delta, f.identity, f.context);
  const frames = ["a", "b"].map(id => ({...first, frameId: id, operationFrameId: id}));
  const results = await Promise.allSettled(frames.map(frame => f.store.save(frame, 1, frame.frameId)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await f.store.state()).version).toBe(2);
});
it("新增合成字段/能力只注册 Schema 与 Resolver；可选错误字段同样阻止执行", async () => {
  const f = await fixture(); const capabilities = new CapabilityRegistry(); const registry = new FieldResolverRegistry();
  registry.register({name: "synthetic", supports: () => true, resolve: async raw => ({status: raw === "uncertain" ? "ambiguous" : "resolved", value: raw})});
  capabilities.register({capability: "synthetic", tool: "test", fields: {newDimension: {label: "新维度", required: false, resolver: "synthetic", inheritable: false, clearable: false}}});
  const service = new BusinessContextService(f.store, capabilities, registry);
  const frame = await service.resolve({capabilityHint: "synthetic", baseReference: null, fieldChanges: [{fieldHint: "newDimension", operation: "set", rawValue: "uncertain"}], executionMode: "execute"}, f.identity, f.context);
  expect(frame.issues).toEqual([{field: "newDimension", reason: "ambiguous"}]);
  const cleared = await mergeFields(capabilities.get("synthetic"), frame, {fieldChanges: [{fieldHint: "newDimension", operation: "clear"}], executionMode: "execute"}, registry, f.context);
  expect(validateFrame(capabilities.get("synthetic"), cleared.fields).status).toBe("NEEDS_CLARIFICATION");
});
it("重复字段/未知字段、禁止继承与同轮伪确认均不能绕过 Validator", async () => {
  const f = await fixture();
  const schema = createCapabilities().get("metric_query"); schema.fields.metrics!.confirmationRequired = true;
  const registry = createFieldResolvers();
  const merged = await mergeFields(schema, undefined, {...f.delta, fieldChanges: [...f.delta.fieldChanges,
    {fieldHint: "unknown", operation: "set", rawValue: "x"}, f.delta.fieldChanges[0]!] }, registry, f.context);
  expect(merged.issues).toHaveLength(2); expect(merged.fields.metrics?.resolutionStatus).toBe("needs_confirmation");
  const base = {...await f.service.resolve(f.delta, f.identity, f.context), fields: merged.fields};
  const same = await mergeFields(schema, base, f.delta, registry, f.context);
  expect(same.fields.metrics?.resolutionStatus).toBe("needs_confirmation");
  const next = await mergeFields(schema, base, f.delta, registry, {...f.context, turnId: "new-turn"});
  expect(next.fields.metrics?.source).toBe("confirmed");
});
it("覆盖到取值只继承 Schema 许可字段，新增指标不改主流程", async () => {
  const f = await fixture();
  const cover = await f.service.resolve({capabilityHint: "data_availability", baseReference: null, executionMode: "execute", fieldChanges: [
    ...f.delta.fieldChanges.filter(c => ["organizations", "time"].includes(c.fieldHint)), {fieldHint: "dimension", operation: "set", rawValue: "metrics"},
  ]}, f.identity, f.context);
  const query = await f.service.resolve({capabilityHint: "metric_query", fieldChanges: [f.delta.fieldChanges[0]!, f.delta.fieldChanges[3]!], executionMode: "execute"}, {...f.identity, requestId: "query"}, f.context);
  expect(query.status).toBe("ready"); expect(query.fields.time?.sourceFrameId).toBe(cover.frameId); expect(query.fields.dimension).toBeUndefined();
});
it("Resolver 不接受模型从原文之外编出的名称或日期", async () => {
  const f = await fixture();
  await expect(f.service.resolve({...f.delta, fieldChanges: f.delta.fieldChanges.map(c => c.fieldHint === "metrics" ? {...c, rawValue: "invented-code"} : c)}, f.identity, f.context)).rejects.toThrow("FIELD_INPUT_NOT_CURRENT");
  expect(await f.store.list()).toHaveLength(0);
});

async function toolFixture() {
  const f = await fixture();
  const basicQueries = vi.fn(async () => ({result: {status: "succeeded", task_id: "task-synthetic", rows: [], columns: [], row_count: 0}}));
  const getTaskResult = vi.fn(async () => ({status: "succeeded", task_id: "task-synthetic", result_id: "result:task-synthetic", rows: [], columns: [], row_count: 0, offset: 0, limit: 20, has_more: false}));
  const backend = {resolveBusinessField: vi.fn(f.context.resolveCatalog), basicQueries,
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "conversation-synthetic"})),
    getTask: vi.fn(async () => ({status: "SUCCEEDED", task_id: "task-synthetic", version: 1, result: {result_id: "result:task-synthetic"}})), getTaskResult};
  const request = testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    frames: f.store, businessResults: new NativeBusinessResultStore(f.session), sessionId: f.identity.sessionId,
    operationId: f.identity.turnId, requestId: f.identity.requestId, originalMessage: f.context.originalMessage,
  });
  return {...f, backend, request};
}
it.each([false, true])("非法枚举属于调用错误，保留焦点且同轮修正只执行一次（已有焦点=%s）", async seeded => {
  const f = await toolFixture();
  if (seeded) await f.service.resolve(f.delta, {...f.identity, requestId: "seed"}, f.context);
  const before = await f.store.state();
  const frames = await f.store.list();
  const wrong = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "selection" ? {...change, rawValue: "当日数"} : change),
  }, f.request));
  expect(wrong).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_ENUM_INVALID", field: "selection", focus_preserved: true});
  expect(wrong.message).toContain("exact");
  expect(await f.store.state()).toEqual(before);
  expect(await f.store.list()).toEqual(frames);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const corrected = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(corrected.status).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: corrected.frameId}, f.request);
  await runTool(createExecuteBusinessFrameTool(), {frameId: corrected.frameId}, f.request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});
it("正式指标解析只读取完整用户原文，忽略旧模型截短的名称并缓存本轮算法结果", async () => {
  const f = await toolFixture();
  const originalMessage = "查询合成余额本期数 样本机构甲 2026年2月28日";
  const matchMetricQuestion = vi.fn(async () => ({mentions: [{text: "合成余额本期数", start: 2, end: 9,
    resolution: {status: "resolved", value: {codes: ["FULL"], names: ["合成余额本期数"]}}}]}));
  const request = {...f.request, originalMessage, backend: {...f.backend, matchMetricQuestion} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: "合成余额"} : change)};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(first.status).toBe("READY");
  expect((await f.store.get(String(first.frameId)))?.fields.metrics).toMatchObject({
    rawValue: ["合成余额本期数"], resolvedValue: {codes: ["FULL"]},
  });
  await runTool(createResolveBusinessTurnTool(), {...delta, fieldChanges: delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)}, request);
  expect(matchMetricQuestion).toHaveBeenCalledTimes(1);
  expect(matchMetricQuestion).toHaveBeenCalledWith(originalMessage);
  expect(f.backend.resolveBusinessField.mock.calls.some(call => call[0] === "metric")).toBe(false);
});
it("低分候选下一轮确认保留其他条件且只查询一次", async () => {
  const f = await toolFixture();
  const matchMetricQuestion = vi.fn(async () => ({mentions: [{text: "合成指彪", start: 0, end: 4,
    resolution: {status: "needs_confirmation", candidates: [{value: "合成指标", code: "M", score: 0.9}]}}]}));
  const request = {...f.request, originalMessage: "合成指彪 样本机构甲 2026年2月28日",
    backend: {...f.backend, matchMetricQuestion} as unknown as BackendClient};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, fieldChanges: f.delta.fieldChanges.map(change =>
    change.fieldHint === "metrics" ? {...change, rawValue: {fromQuestion: true}} : change)}, request));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const next = {...request, originalMessage: "第一个", operationId: "confirm", requestId: "confirm"};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 1}},
  ]}, next));
  expect(ready.status).toBe("READY");
  // 确认直接拼装逐条 mention 快照取候选编码，不再对已确定项重跑目录复核。
  expect(f.backend.resolveBusinessField.mock.calls.some(call => call[0] === "metric")).toBe(false);
  expect((await f.store.get(String(ready.frameId)))?.fields.metrics?.resolvedValue).toEqual({codes: ["M"], names: ["合成指标"]});
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});
it("四指标中末项确认后按逐条 mention 快照合并全部指标并执行一次", async () => {
  const f = await toolFixture();
  const names = ["合成收入金额当日数", "较上月增幅", "较同期增幅", "净利润本年累"];
  const codes = ["A", "B", "C", "D"];
  const question = `样本机构甲 2026年2月28日 ${names.join("、")}`;
  const matchMetricQuestion = vi.fn(async () => ({mentions: names.map((text, index) => ({
    text, start: question.indexOf(text), end: question.indexOf(text) + text.length,
    resolution: index < 3
      ? {status: "resolved" as const, value: {codes: [codes[index]!], names: [text]}}
      : {status: "needs_confirmation" as const, candidates: [{value: "净利润本年累计", code: "D"}]},
  }))}));
  const request = {...f.request, originalMessage: question,
    backend: {...f.backend, matchMetricQuestion} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true, mentionIndexes: [1, 2, 3]}} : change)};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const next = {...request, originalMessage: "第一个，就是净利润本年累计", requestId: "confirmed", operationId: "confirmed"};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 1}},
  ]}, next));
  expect(ready.status).toBe("READY");
  // 已 resolved 的 mention 不再重跑目录复核；确认项直接取候选编码合并。
  expect(f.backend.resolveBusinessField.mock.calls.some(call => call[0] === "metric")).toBe(false);
  expect((await f.store.get(String(ready.frameId)))?.fields.metrics?.resolvedValue)
    .toEqual({codes, names: [...names.slice(0, 3), "净利润本年累计"]});
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(query.metric_codes).toEqual(codes);
  // 续查轮也做覆盖率复核：source_question 一旦传给后端即触发 409 复核；归一化原句把确认项替换为最终名称。
  expect(query.source_question).toBe(`样本机构甲 2026年2月28日 ${[...names.slice(0, 3), "净利润本年累计"].join("、")}`);
});
it("多 mention 部分澄清→跨轮确认→续查一次执行双指标", async () => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 合成余额当日数、100万以下贷款余额当日数";
  const mention = (text: string) => ({text, start: question.indexOf(text), end: question.indexOf(text) + text.length});
  const matchMetricQuestion = vi.fn(async () => ({mentions: [
    {...mention("合成余额当日数"),
      resolution: {status: "resolved" as const, value: {codes: ["A"], names: ["合成余额当日数"]}}},
    {...mention("100万以下贷款余额当日数"),
      resolution: {status: "needs_confirmation" as const, candidates: [{value: "百万以下贷款余额当日数", code: "B", score: 0.8}]}},
  ]}));
  const request = {...f.request, originalMessage: question,
    backend: {...f.backend, matchMetricQuestion} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const firstFrame = await f.store.get(String(first.frameId));
  expect(firstFrame?.fields.metrics?.metadata?.questionText).toBe(question);
  expect(firstFrame?.fields.metrics?.metadata?.mentionResolutions).toMatchObject([
    {text: "合成余额当日数", status: "resolved"}, {text: "100万以下贷款余额当日数", status: "needs_confirmation"}]);
  // 确认轮原文只是确认话语，本轮算法不再识别指标。
  const next = {...request, originalMessage: "第二个就是百万以下贷款余额当日数", requestId: "confirmed", operationId: "confirmed",
    backend: {...request.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 1}},
  ]}, next));
  expect(ready.status).toBe("READY");
  const readyFrame = await f.store.get(String(ready.frameId));
  expect(readyFrame?.fields.metrics?.resolvedValue)
    .toEqual({codes: ["A", "B"], names: ["合成余额当日数", "百万以下贷款余额当日数"]});
  expect(readyFrame?.fields.metrics?.metadata?.mentionResolutions).toMatchObject([{status: "resolved"}, {status: "resolved"}]);
  // 已 resolved 的第一项不丢也不再重跑目录复核。
  expect(f.backend.resolveBusinessField.mock.calls.some(call => call[0] === "metric")).toBe(false);
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(query.metric_codes).toEqual(["A", "B"]);
  // 续查轮覆盖率复核：source_question 传给后端即触发复核；归一化原句把确认项替换为最终名称。
  expect(query.source_question).toBe("样本机构甲 2026年2月28日 合成余额当日数、百万以下贷款余额当日数");
});
it("用户明确放弃一项指标后执行剩余项，归一化原句删除对应片段", async () => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 合成余额当日数、贷款余额当日数";
  const mention = (text: string, code: string) => ({text, start: question.indexOf(text), end: question.indexOf(text) + text.length,
    resolution: {status: "resolved" as const, value: {codes: [code], names: [text]}}});
  const matchMetricQuestion = vi.fn(async () => ({mentions: [mention("合成余额当日数", "A"), mention("贷款余额当日数", "B")]}));
  const request = {...f.request, originalMessage: question,
    backend: {...f.backend, matchMetricQuestion} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(first.status).toBe("READY");
  const next = {...request, originalMessage: "不要贷款余额当日数了", requestId: "remove", operationId: "remove",
    backend: {...request.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
  const removed = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "remove", rawValue: {mentionIndexes: [2]}},
  ]}, next));
  expect(removed.status).toBe("READY");
  const frame = await f.store.get(String(removed.frameId));
  expect(frame?.fields.metrics?.resolvedValue).toEqual({codes: ["A"], names: ["合成余额当日数"]});
  expect(frame?.fields.metrics?.metadata?.removedMentions).toMatchObject([{text: "贷款余额当日数", status: "removed"}]);
  // 非指标字段不支持 remove，报参数错误且不污染焦点。
  const wrong = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "organizations", operation: "remove", rawValue: {mentionIndexes: [1]}},
  ]}, {...next, requestId: "remove-org", operationId: "remove-org"}));
  expect(wrong).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_REMOVE_NOT_SUPPORTED", focus_preserved: true});
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(removed.frameId)}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(query.metric_codes).toEqual(["A"]);
  // source_question 传给后端即触发覆盖率复核；归一化原句删除被放弃片段。
  expect(query.source_question).toBe("样本机构甲 2026年2月28日 合成余额当日数、");
});
it("续查轮静默丢项正常发出但带覆盖率复核，source_question 含被丢项", async () => {
  const f = await toolFixture();
  const firstQuestion = "样本机构甲 2026年2月28日 合成余额当日数";
  const firstMentions = vi.fn(async () => ({mentions: [{text: "合成余额当日数", start: 17, end: 24,
    resolution: {status: "resolved" as const, value: {codes: ["A"], names: ["合成余额当日数"]}}}]}));
  const request = {...f.request, originalMessage: firstQuestion,
    backend: {...f.backend, matchMetricQuestion: firstMentions} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  expect(receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request)).status).toBe("READY");
  // 续查轮：算法识别两项，模型只选第一项（静默丢项在解析层仍合法，执行期由后端覆盖率复核拦截）。
  const followUpQuestion = "合成余额当日数和贷款余额当日数";
  const followUpMentions = vi.fn(async () => ({mentions: [
    {text: "合成余额当日数", start: 0, end: 7,
      resolution: {status: "resolved" as const, value: {codes: ["A"], names: ["合成余额当日数"]}}},
    {text: "贷款余额当日数", start: 8, end: 15,
      resolution: {status: "resolved" as const, value: {codes: ["B"], names: ["贷款余额当日数"]}}},
  ]}));
  const next = {...request, originalMessage: followUpQuestion, requestId: "follow-up", operationId: "follow-up",
    backend: {...f.backend, matchMetricQuestion: followUpMentions} as unknown as BackendClient};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true, mentionIndexes: [1]}},
  ]}, next));
  expect(ready.status).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  // agent 侧必须正常发出：source_question 一旦传给后端即触发覆盖率复核；归一化原句保留被丢项，后端据此 409 拦截。
  expect(query.source_question).toBe(followUpQuestion);
  expect(query.metric_codes).toEqual(["A"]);
  expect(String(query.source_question)).toContain("贷款余额当日数");
});
it.each([false, true])("95%指标直接采用，只澄清仍未确定的机构（机构待确认=%s）", async unresolvedOrg => {
  const f = await toolFixture();
  const request = {...f.request, backend: {...f.backend,
    matchMetricQuestion: async () => ({mentions: [{text: "样本指标甲", start: 0, end: 5,
      resolution: {status: "resolved", value: {codes: ["M"], names: ["样本指标甲"]},
        metadata: {match: "high_confidence", score: 0.95, autoSelectThreshold: 0.95}}}]}),
    resolveBusinessField: async (entity: string, raw: string[]) => entity === "organization" && unresolvedOrg
      ? {status: "needs_confirmation", candidates: [{value: "样本机构甲", code: "O", score: 0.76}]}
      : f.context.resolveCatalog!(entity as "metric" | "organization" | "date", raw),
  } as unknown as BackendClient};
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, request));
  const frame = await f.store.get(String(result.frameId));
  expect(frame?.fields.metrics).toMatchObject({resolutionStatus: "resolved", resolvedValue: {codes: ["M"]}});
  expect(frame?.issues).toEqual(unresolvedOrg ? [{field: "organizations", reason: "needs_confirmation"}] : []);
  if (unresolvedOrg) {
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  } else {
    expect(result.status).toBe("READY");
    await runTool(createExecuteBusinessFrameTool(), {frameId: result.frameId}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  }
});
it("多指标由模型引用算法片段选择范围，非法引用不污染焦点", async () => {
  const f = await toolFixture();
  const request = {...f.request, originalMessage: "合成甲换成合成乙 样本机构甲 2026年2月28日", backend: {...f.backend,
    matchMetricQuestion: async () => ({mentions: [
      {text: "合成甲", start: 0, end: 3, resolution: {status: "resolved", value: {codes: ["A"], names: ["合成甲"]}}},
      {text: "合成乙", start: 5, end: 8, resolution: {status: "resolved", value: {codes: ["B"], names: ["合成乙"]}}},
    ]}),
  } as unknown as BackendClient};
  const delta = (index: number) => ({...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true, mentionIndexes: [index]}} : change)});
  expect(receiptJson(await runTool(createResolveBusinessTurnTool(), delta(3), request)).status).toBe("ARGUMENT_ERROR");
  expect(await f.store.list()).toHaveLength(0);
  const partial = receiptJson(await runTool(createResolveBusinessTurnTool(), delta(2), request));
  expect(partial).toMatchObject({status: "ARGUMENT_ERROR", error_code: "PARTIAL_METRIC_SELECTION"});
  expect(await f.store.list()).toHaveLength(0);
  await runTool(createResolveBusinessTurnTool(), f.delta, f.request);
  const followUp = {...request, operationId: "replace-turn", requestId: "replace-request"};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {
    capabilityHint: "metric_query", executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true, mentionIndexes: [2]}},
    ],
  }, followUp));
  expect((await f.store.get(String(ready.frameId)))?.fields.metrics?.resolvedValue).toEqual({codes: ["B"], names: ["合成乙"]});
});
it("独立四指标问题完整提交目录编码及宿主原句，不能只执行前一项", async () => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 合成余额当日数、较上月增幅、贷款余额当日数、净利润本年累计";
  const names = ["合成余额当日数", "较上月增幅", "贷款余额当日数", "净利润本年累计"];
  const codes = ["A1", "A2", "B", "C"];
  const request = {...f.request, originalMessage: question, backend: {...f.backend,
    matchMetricQuestion: async () => ({mentions: names.map((name, index) => ({
      text: name, start: question.indexOf(name), end: question.indexOf(name) + name.length,
      resolution: {status: "resolved" as const, value: {codes: [codes[index]!], names: [name]}},
    }))}),
  } as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(ready.status).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries).toHaveBeenCalledWith(
    expect.objectContaining({metric_codes: codes, source_question: question}),
    expect.any(String), expect.any(Object),
  );
});
it("新增枚举字段沿用协议错误规则，不按字段名或业务词特判", async () => {
  const f = await fixture();
  const schema = {capability: "synthetic", tool: "synthetic", fields: {
    arbitraryMode: {label: "测试模式", required: true, inheritable: false, resolver: "enum", validation: {enum: ["alpha", "beta"]}},
  }};
  await expect(mergeFields(schema, undefined, {executionMode: "execute", fieldChanges: [
    {fieldHint: "arbitraryMode", operation: "set", rawValue: "自然语言"},
  ]}, createFieldResolvers(), f.context)).rejects.toMatchObject({code: "FIELD_ENUM_INVALID", field: "arbitraryMode"});
  const missing = await mergeFields(schema, undefined, {executionMode: "execute", fieldChanges: []}, createFieldResolvers(), f.context);
  expect(validateFrame(schema, missing.fields)).toMatchObject({status: "NEEDS_CLARIFICATION", issues: [{field: "arbitraryMode", reason: "missing"}]});
});
it("实际工具闭环只接受 READY 引用；重复执行与历史复用不再次查询", async () => {
  const f = await toolFixture();
  const resolved = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(resolved.status).toBe("READY");
  const execute = createExecuteBusinessFrameTool();
  const result = await runTool(execute, {frameId: resolved.frameId}, f.request);
  expect(result.details.status).toBe("succeeded");
  await runTool(execute, {frameId: resolved.frameId}, f.request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1); expect(f.backend.getTaskResult).toHaveBeenCalledTimes(1);
  const success = (await f.store.list()).find(frame => frame.status === "success")!;
  expect(success.resultRef).toContain("result%3Atask-synthetic");
  const reuse = receiptJson(await runTool(createResolveBusinessTurnTool(), {baseReference: {frameId: success.frameId}, fieldChanges: [], executionMode: "reuse_result"}, {...f.request, requestId: "reuse", operationId: "reuse"}));
  expect(reuse.status).toBe("REUSE_RESULT");
  await runTool(createReadBusinessResultTool(), {frameId: reuse.frameId}, f.request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1); expect(f.backend.getTaskResult).toHaveBeenCalledTimes(2);
  const call = f.backend.getTaskResult.mock.calls[1] as unknown[];
  expect(call[0]).toBe("task-synthetic");
});
it("历史复用夹带字段修改是参数错误，保留焦点并允许同轮纠正", async () => {
  const f = await toolFixture();
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
  const before = await f.store.state();
  const request = {...f.request, originalMessage: "回读刚才的结果", requestId: "reuse", operationId: "reuse"};
  const wrong = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query",
    executionMode: "reuse_result", fieldChanges: [{fieldHint: "metrics", operation: "clear"}]}, request));
  expect(wrong).toMatchObject({status: "ARGUMENT_ERROR", error_code: "RESULT_REUSE_HAS_CHANGES"});
  expect(await f.store.state()).toEqual(before);
  const corrected = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query",
    executionMode: "reuse_result", fieldChanges: []}, request));
  expect(corrected.status).toBe("REUSE_RESULT");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});
it("澄清、resolve_more、其他会话与其他回合的 Frame 禁止查询", async () => {
  const f = await toolFixture();
  const clarify = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, fieldChanges: []}, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: clarify.frameId}, f.request);
  const more = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, executionMode: "resolve_more"}, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: more.frameId}, f.request);
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, {...f.request, operationId: "another"});
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, {...f.request, sessionId: "another"});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("目录源异常和未知状态阻止执行，不降级猜测", async () => {
  const f = await toolFixture();
  f.backend.resolveBusinessField.mockRejectedValue(new Error("synthetic unavailable"));
  const response = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(response.status).toBe("TEMPORARY_ERROR");
  expect((response.fields as BusinessFrame["fields"]).metrics?.resolutionStatus).toBe("temporary_error");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("历史结果撤权后不能复用，后端拒绝不被 Frame 绕过", async () => {
  const f = await toolFixture(); const resolved = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  const result = await runTool(createExecuteBusinessFrameTool(), {frameId: resolved.frameId}, f.request);
  f.backend.getTaskResult.mockRejectedValue(new BackendApiError(403, "synthetic forbidden"));
  const read = await runTool(createReadBusinessResultTool(), {frameId: result.details.frame_id}, f.request);
  expect(read.details.status).toBe("error"); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});
it("原生工具集没有旧自然语言查询/直接编码查询旁路", () => {
  const names = createAskMetricTools().map(tool => tool.name);
  for (const name of ["resolve_business_turn", "execute_business_frame", "business_context_read", "read_business_result"]) expect(names).toContain(name);
  for (const name of ["metric_ask", "metric_query_structured", "data_availability", "metric_calculate"]) expect(names).not.toContain(name);
});
it("生产核心没有测试表达、具体字段分支和自然语言历史路由", () => {
  for (const file of ["core.ts", "service.ts", "store.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(text).not.toContain("样本指标甲"); expect(text).not.toContain("样本机构甲");
    expect(text).not.toMatch(/fieldName\s*===\s*["'](?:metric|organization|date)/);
    expect(text).not.toMatch(/(?:message|question)\.(?:includes|match)\(/);
  }
});
it("上轮候选确认重新查询事实源，同轮自报确认和候选外编码被拒绝", async () => {
  const f = await fixture();
  const context = {...f.context, resolveCatalog: vi.fn(async () => ({status: "ambiguous" as const, candidates: [
    {value: "样本指标甲", code: "a", metadata: {rawValueIndex: 0}}, {value: "样本指标乙", code: "b", metadata: {rawValueIndex: 0}},
  ]}))};
  const first = await f.service.resolve(f.delta, f.identity, context);
  expect(first.status).toBe("clarifying");
  const delta: ContextDelta = {executionMode: "execute", fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 2, sourceText: "第二个"}}]};
  const next = {...f.identity, turnId: "confirm", requestId: "confirm"};
  const resolved = await f.service.resolve(delta, next, {...f.context, turnId: "confirm", originalMessage: "第二个"});
  expect(resolved.fields.metrics?.source).toBe("confirmed");
  expect(resolved.fields.metrics?.resolvedValue).toEqual({codes: ["metric:b"], names: ["b"]});
  expect(resolved.fields.organizations?.sourceFrameId).toBe(first.frameId);
});
it("同名候选按保存的可信编码确认，目录撤销候选后仍不能执行", async () => {
  const f = await fixture();
  const resolveCatalog: ResolverContext["resolveCatalog"] = async (entity, raw) => {
    if (entity !== "metric") return f.context.resolveCatalog(entity, raw);
    if (raw[0] === "trusted-b") return {status: "resolved", value: {codes: ["trusted-b"], names: ["样本指标甲"]}};
    return {status: "ambiguous", candidates: [
      {value: "样本指标甲", code: "trusted-a"}, {value: "样本指标甲", code: "trusted-b"},
    ]};
  };
  const first = await f.service.resolve(f.delta, f.identity, {...f.context, resolveCatalog});
  const confirmation: ContextDelta = {baseReference: {frameId: first.frameId}, executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 2, sourceText: "第二项"}},
  ]};
  const context = {...f.context, turnId: "confirmed", originalMessage: "第二项", resolveCatalog};
  const confirmed = await f.service.resolve(confirmation, {...f.identity, turnId: "confirmed", requestId: "confirmed"}, context);
  expect(confirmed.status).toBe("ready");
  expect(confirmed.fields.metrics?.resolvedValue).toEqual({codes: ["trusted-b"], names: ["样本指标甲"]});
  const revoked = await f.service.resolve(confirmation, {...f.identity, turnId: "revoked", requestId: "revoked"},
    {...context, turnId: "revoked", resolveCatalog: async () => ({status: "not_found"})});
  expect(revoked.status).toBe("clarifying");
  expect(revoked.fields.metrics?.resolutionStatus).toBe("not_found");
});
it("错误确认参数不丢焦点，纠正候选后继承完整条件且只查询一次", async () => {
  const f = await toolFixture();
  const lookup = f.context.resolveCatalog;
  f.backend.resolveBusinessField.mockImplementation(async (entity, raw) => entity !== "organization" ? lookup(entity, raw)
    : raw[0] === "trusted-org" ? {status: "resolved", value: {codes: ["trusted-org"], names: ["合成机构全称"]}}
    : {status: "needs_confirmation", candidates: [{value: "合成机构全称", code: "trusted-org"}]} as never);
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  const originalState = await f.store.state();
  // 同轮即使候选有效也不能代替用户确认。
  const confirmation = {executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {candidateIndex: 1}}]};
  const selfConfirmed = receiptJson(await runTool(createResolveBusinessTurnTool(), confirmation, f.request));
  expect(selfConfirmed.error_code).toBe("CONFIRMATION_REQUIRES_USER_TURN");
  const next = {...f.request, originalMessage: "可以", requestId: "confirm", operationId: "confirm"};
  const wrong = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "organizations", operation: "set", rawValue: "合成机构全称"},
  ]}, next));
  expect(wrong.status).toBe("ARGUMENT_ERROR"); expect(wrong.focus_preserved).toBe(true);
  expect(await f.store.state()).toEqual(originalState);
  // 兼容旧模型填错 sourceText：其内容不再覆盖宿主绑定的本轮原文。
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {...confirmation, fieldChanges: [
    {fieldHint: "organizations", operation: "set", rawValue: {candidateIndex: 1, sourceText: "旧机构简称"}},
  ]}, next));
  expect(ready.status).toBe("READY");
  const frame = await f.store.get(String(ready.frameId));
  expect(frame?.parentFrameId).toBe(first.frameId);
  expect(frame?.fields.time?.sourceFrameId).toBe(first.frameId);
  const executed = await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, next);
  expect(executed.details.status).toBe("succeeded");
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});
it("缺少首次 capability 属于调用错误，不生成空能力焦点", async () => {
  const f = await toolFixture();
  const {capabilityHint: _capability, ...delta} = f.delta;
  const response = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, f.request));
  expect(response.status).toBe("ARGUMENT_ERROR");
  expect(response.error_code).toBe("CAPABILITY_REQUIRED");
  expect((await f.store.state()).focusFrameId).toBeUndefined();
});
it("后端响应丢失保留 executing，同一 Frame 重试保持相同幂等键", async () => {
  const f = await toolFixture();
  f.backend.basicQueries.mockRejectedValueOnce(new BackendApiError(503, "synthetic timeout"));
  const resolved = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  const tool = createExecuteBusinessFrameTool();
  const first = await runTool(tool, {frameId: resolved.frameId}, f.request);
  expect(first.details.status).toBe("error");
  expect((await f.store.list()).at(-1)?.status).toBe("executing");
  const retry = await runTool(tool, {frameId: resolved.frameId}, f.request);
  expect(retry.details.status).toBe("succeeded");
  const calls = f.backend.basicQueries.mock.calls as unknown[][];
  expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
});
it("执行期间新焦点已建立，旧请求完成不能夺回焦点", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  const newer = await f.service.resolve(f.delta, {...f.identity, requestId: "new", turnId: "new"}, f.context);
  await f.service.finishExecution(executing, {status: "success", resultRef: "query:old:result"});
  expect((await f.store.state()).focusFrameId).toBe(newer.frameId);
});
it("历史新工具大结果无须 DSL 也从模型副本移除，原生存储保持不变", async () => {
  const {projectHistoricalResults} = await import("../modelContext.js");
  const messages = [{role: "user", content: "first", timestamp: 1}, {role: "toolResult", toolName: "execute_business_frame", toolCallId: "one", isError: false, timestamp: 2,
    content: [{type: "text", text: JSON.stringify({status: "succeeded", frame_id: "f", result_ref: "snapshot:r", items: ["sensitive-row"]})}],
    details: {kind: "data_availability", items: ["sensitive-row"]}}, {role: "user", content: "next", timestamp: 3}];
  const before = JSON.stringify(messages);
  const projected = projectHistoricalResults(messages as import("@earendil-works/pi-agent-core").AgentMessage[]);
  expect(JSON.stringify(projected)).not.toContain("sensitive-row"); expect(JSON.stringify(projected)).toContain("snapshot:r");
  expect(JSON.stringify(messages)).toBe(before);
});
it("等价 Delta 的字段顺序变化同轮去重；不同指标机构随机替换仍走相同规则", async () => {
  const f = await fixture();
  for (let index = 1; index <= 12; index++) {
    const names = [`合成维度${index * 7919}`, `合成组织${index * 104729}`];
    const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => ({...change,
      rawValue: change.fieldHint === "metrics" ? names[0] : change.fieldHint === "organizations" ? names[1] : change.rawValue}))};
    const identity = {...f.identity, requestId: `variation-${index}`, turnId: `variation-${index}`};
    const context = {...f.context, originalMessage: `${names.join(" ")} 2026年2月28日`};
    const frame = await f.service.resolve(delta, identity, context);
    const replay = await f.service.resolve({...delta, fieldChanges: [...delta.fieldChanges].reverse()}, identity, context);
    expect(frame.status).toBe("ready"); expect(replay.frameId).toBe(frame.frameId);
  }
  expect(await f.store.list()).toHaveLength(12);
});
it("覆盖执行结果重启后复用只读快照、复查权限，不再访问数据源", async () => {
  const f = await toolFixture();
  const availability = vi.fn(async (request: unknown) => ({status: "succeeded", request, mode: "metrics", org_names: ["样本机构甲"], items: [], groups: [], metric_count: 0, page: 1, page_size: 20, has_more: false, notice: "合成测试"}));
  Object.assign(f.backend, {dataAvailability: availability});
  const response = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "data_availability", baseReference: null, executionMode: "execute", fieldChanges: [f.delta.fieldChanges[1], {fieldHint: "dimension", operation: "set", rawValue: "metrics"}]}, f.request));
  const executed = await runTool(createExecuteBusinessFrameTool(), {frameId: response.frameId}, f.request);
  expect(executed.details.status).toBe("succeeded");
  // 用同一正式编码复核，模拟目录 API 返回 canonical 编码。
  f.backend.resolveBusinessField.mockImplementation(async (_entity, raw) => ({status: "resolved", value: {codes: raw, names: raw}}));
  await f.sessions.release("synthetic-user", f.session.metadata.id);
  const session = await f.sessions.open("synthetic-user", f.session.metadata);
  const read = await runTool(createReadBusinessResultTool(), {frameId: executed.details.frame_id}, {...f.request,
    frames: new NativeFrameStore(session), businessResults: new NativeBusinessResultStore(session)});
  expect(read.details.status).toBe("succeeded"); expect(availability).toHaveBeenCalledTimes(1);
  f.backend.resolveBusinessField.mockResolvedValue({status: "not_found"} as never);
  expect((await runTool(createReadBusinessResultTool(), {frameId: executed.details.frame_id}, f.request)).details.status).toBe("error");
});
it("计算引用 Resolver 拒绝模型捏造及历史 fact_id", async () => {
  const f = await toolFixture();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_calculate", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "expressions", operation: "set", rawValue: [{name: "sum", label: "合计", expression: "x"}]},
      {fieldHint: "bindings", operation: "set", rawValue: {x: {fact_id: "fact:unknown:0:metric_value"}}},
    ]}, f.request));
  expect(result.status).toBe("ARGUMENT_ERROR");
  expect(result.field).toContain("bindings");
});
it("query resultRef 使用只读 GET 与真实分页，不发送空 original_question", async () => {
  const f = await toolFixture();
  const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  const success = await f.service.finishExecution(executing, {status: "success", resultRef: "query:task-synthetic:result%3Atask-synthetic"});
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({status: "succeeded", task_id: "task-synthetic", result_id: "result:task-synthetic", columns: [], rows: [], row_count: 0, offset: 5, limit: 10, has_more: false})));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const {BackendClient} = await import("../backendClient.js");
    const result = await runTool(createReadBusinessResultTool(), {frameId: success.frameId, offset: 5, limit: 10},
      {...f.request, backend: new BackendClient("http://synthetic.invalid", "test-only", 1000)});
    expect(result.details.status).toBe("succeeded");
    const calls = fetchMock.mock.calls as unknown[][];
    expect(String(calls[0]?.[0])).toContain("/result?offset=5&limit=10");
    expect((calls[0]?.[1] as RequestInit).method).not.toBe("POST");
  } finally {vi.unstubAllGlobals();}
});
it("计算 Frame 先验证本轮快照事实，执行与复用不重算，撤权拒绝快照", async () => {
  const f = await toolFixture();
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
  const factId = "fact:task-synthetic:0:metric_value";
  f.backend.getTaskResult.mockResolvedValue({status: "succeeded", task_id: "task-synthetic", result_id: "result:task-synthetic", rows: [], columns: [], row_count: 1, offset: 0, limit: 1, has_more: false,
    calculation_scope_id: f.request.operationId, facts: [{fact_id: factId}], truncated: false} as never);
  const calculate = vi.fn(async () => ({status: "succeeded", calculation_id: "calculation-synthetic", task_id: "task-synthetic", results: [], inputs: {x: {task_id: "task-synthetic"}}, public_answer: "合成计算结果"}));
  Object.assign(f.backend, {calculate});
  const resolved = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_calculate", baseReference: null, executionMode: "execute", fieldChanges: [
    {fieldHint: "expressions", operation: "set", rawValue: [{name: "copy", label: "取值", expression: "x"}]},
    {fieldHint: "bindings", operation: "set", rawValue: {x: {fact_id: factId}}},
  ]}, f.request));
  expect(resolved.status).toBe("READY");
  const result = await runTool(createExecuteBusinessFrameTool(), {frameId: resolved.frameId}, f.request);
  expect(result.details.status).toBe("succeeded");
  expect((await runTool(createReadBusinessResultTool(), {frameId: result.details.frame_id}, f.request)).details.status).toBe("succeeded");
  expect(calculate).toHaveBeenCalledTimes(1);
  f.backend.getTaskResult.mockRejectedValue(new BackendApiError(403, "synthetic forbidden"));
  expect((await runTool(createReadBusinessResultTool(), {frameId: result.details.frame_id}, f.request)).details.status).toBe("error");
});
it("数据源暂时失败后重试继承原输入并重新解析，不要求用户重述名称", async () => {
  const f = await toolFixture();
  f.backend.resolveBusinessField.mockRejectedValueOnce(new Error("synthetic unavailable"));
  const initial = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(initial.status).toBe("TEMPORARY_ERROR");
  const next = receiptJson(await runTool(createResolveBusinessTurnTool(), {fieldChanges: [], executionMode: "execute"},
    {...f.request, originalMessage: "重试", requestId: "retry", operationId: "retry"}));
  expect(next.status).toBe("READY");
  expect((next.fields as BusinessFrame["fields"]).metrics?.sourceFrameId).toBe(initial.frameId);
});
it("快照已保存但 success Frame 未提交的崩溃恢复不重复覆盖查询", async () => {
  const f = await toolFixture();
  const availability = vi.fn(); Object.assign(f.backend, {dataAvailability: availability});
  const resolved = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "data_availability", baseReference: null, executionMode: "execute", fieldChanges: [f.delta.fieldChanges[1], {fieldHint: "dimension", operation: "set", rawValue: "metrics"}]}, f.request));
  const executing = await f.service.beginExecution(String(resolved.frameId), f.identity);
  const {businessKey} = await import("./service.js");
  const ref = `snapshot:${businessKey({frameId: executing.frameId})}`;
  await f.request.businessResults!.save(ref, {content: [{type: "text", text: JSON.stringify({status: "succeeded"})}], details: {kind: "data_availability", status: "succeeded", public_answer: "合成快照"}});
  f.backend.resolveBusinessField.mockImplementation(async (_entity, names) => ({status: "resolved", value: {codes: names, names}}));
  const replay = await runTool(createExecuteBusinessFrameTool(), {frameId: resolved.frameId}, f.request);
  expect(replay.details.status).toBe("succeeded"); expect(availability).not.toHaveBeenCalled();
  expect((await f.store.list()).at(-1)?.resultRef).toBe(ref);
});

it("机构修改后省略年份的日期仍使用历史标准年份，原文保持不变", async () => {
  const f = await fixture();
  const resolver = vi.fn(async (entity: string, raw: string[], referenceYear?: number) => ({status: "resolved" as const,
    value: entity === "date" ? {start: `${referenceYear ?? 2024}-04-01`, end: `${referenceYear ?? 2024}-04-30`}
      : {codes: raw, names: raw}}));
  const context = {...f.context, resolveCatalog: resolver};
  const initialDelta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change =>
    change.fieldHint === "selection" ? {...change, rawValue: "all_in_range"} : change)};
  await f.service.resolve(initialDelta, f.identity, context);
  const second = await f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "样本机构乙"}]},
    {...f.identity, turnId: "b", requestId: "b"}, {...context, turnId: "b", originalMessage: "样本机构乙呢？"});
  const third = await f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "4 月份"},
    {fieldHint: "selection", operation: "set", rawValue: "all_in_range"}]}, {...f.identity, turnId: "c", requestId: "c"},
    {...context, turnId: "c", originalMessage: "4 月份的呢？"});
  expect(resolver).toHaveBeenLastCalledWith("date", ["4 月份"], 2024);
  expect(third.fields.organizations?.resolvedValue).toEqual(second.fields.organizations?.resolvedValue);
  expect(third.fields.time?.rawValue).toBe("4 月份"); expect(third.status).toBe("ready");
  expect(third.fields.time?.resolvedValue).toEqual({start: "2024-04-01", end: "2024-04-30"});
});

it("历史 Selector 支持标准名称、编码和部分日期约束，多匹配仍澄清", async () => {
  const f = await fixture(); const first = await f.service.resolve(f.delta, f.identity, f.context);
  const state = await f.store.state(); const frames = await f.store.list();
  for (const businessConstraints of [{organizations: "样本机构甲"}, {organizations: "organization:样本机构甲"}, {time: {start: "2026-02-28"}}]) {
    expect(resolveFrame({businessConstraints}, state, frames)).toEqual({status: "resolved", frameId: first.frameId});
  }
  expect(resolveFrame({businessConstraints: {time: {start: "2025-02-28"}}}, state, frames).status).toBe("not_found");
  await f.service.resolve(f.delta, {...f.identity, turnId: "b", requestId: "b"}, f.context);
  expect(resolveFrame({businessConstraints: {organizations: "样本机构甲"}}, await f.store.state(), await f.store.list()).status).toBe("ambiguous");
});

it("先补日期再确认继承候选时仍追溯最初候选回合，不能同轮自造确认", async () => {
  const f = await fixture();
  const context = {...f.context, resolveCatalog: async (entity: string, raw: string[]) => entity === "organization" && raw[0] !== "O1"
    ? {status: "needs_confirmation" as const, candidates: [{code: "O1", value: "样本机构全称"}]}
    : f.context.resolveCatalog(entity, raw)};
  const first = await f.service.resolve(f.delta, f.identity, context);
  const secondIdentity = {...f.identity, turnId: "second", requestId: "second"};
  const secondContext = {...context, turnId: "second", originalMessage: "是，日期仍用2026年2月28日"};
  await f.service.resolve({executionMode: "resolve_more", fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "2026年2月28日"}]}, secondIdentity, secondContext);
  const confirmed = await f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {candidateIndex: 1}}]}, secondIdentity, secondContext);
  expect(confirmed.status).toBe("ready"); expect(confirmed.fields.organizations?.source).toBe("confirmed");
  expect(confirmed.fields.organizations?.rawValue).toEqual(first.fields.organizations?.rawValue);
  expect(confirmed.fields.organizations?.sourceFrameId).toBeTruthy();
});

it("用解析阶段 READY 引用复用同一操作完成结果，不触发查询或改写旧帧", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  const success = await f.service.finishExecution(executing, {status: "success", resultRef: "query:t:r"});
  const reused = await f.service.resolve({capabilityHint: "metric_query", baseReference: {frameId: ready.frameId, resultRequired: true}, executionMode: "reuse_result", fieldChanges: []},
    {...f.identity, turnId: "reuse", requestId: "reuse"}, {...f.context, originalMessage: "查看已有结果"});
  expect(reused.status).toBe("success"); expect(reused.resultRef).toBe("query:t:r");
  expect(reused.parentFrameId).toBe(success.frameId);
  expect(await f.store.get(ready.frameId)).toEqual(ready);
});

it("Delta 一次报告所有非本轮原文字段，不逐次失败污染焦点", async () => {
  const f = await fixture(); const initial = await f.service.resolve(f.delta, f.identity, f.context);
  const next: ContextDelta = {executionMode: "execute", fieldChanges: [
    {fieldHint: "organizations", operation: "set" as const, rawValue: "样本机构甲"},
    {fieldHint: "time", operation: "set" as const, rawValue: "2026年4月份"},
  ]};
  await expect(f.service.resolve(next, {...f.identity, requestId: "next", turnId: "next"}, {...f.context, originalMessage: "4月份呢"}))
    .rejects.toMatchObject({code: "FIELD_INPUT_NOT_CURRENT", field: "organizations,time"});
  expect((await f.store.state()).focusFrameId).toBe(initial.frameId);
  expect(await f.store.list()).toHaveLength(1);
});

it("历史回读接受同一操作的 READY 引用并切回成功焦点，不重新查询", async () => {
  const f = await toolFixture();
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
  const read = await runTool(createReadBusinessResultTool(), {frameId: ready.frameId}, f.request);
  expect(read.details.status).toBe("succeeded"); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.getTaskResult).toHaveBeenCalledTimes(1);
  const state = await f.store.state(); expect((await f.store.get(state.focusFrameId!))?.status).toBe("success");
});

it("跨轮错误执行和空指标替换不改变焦点，纠正后继承全部条件并只执行一次", async () => {
  const f = await toolFixture();
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  const state = await f.store.state();
  const frames = await f.store.list();
  const next = {...f.request, originalMessage: "是要查询这个", operationId: "continue", requestId: "continue",
    backend: {...f.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
  const wrongExecution = receiptJson(await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, next));
  expect(wrongExecution).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FRAME_NOT_CURRENT_TURN", focus_preserved: true});
  for (const rawValue of [{fromQuestion: true}, "样本指标甲"]) {
    const wrongSet = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", executionMode: "execute",
      fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue}]}, next));
    expect(wrongSet).toMatchObject({status: "ARGUMENT_ERROR", focus_preserved: true});
    expect(await f.store.state()).toEqual(state);
    expect(await f.store.list()).toEqual(frames);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  }
  const resumed = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: []}, next));
  expect(resumed.status).toBe("READY");
  const restored = await f.store.get(String(resumed.frameId));
  for (const field of ["metrics", "organizations", "time"]) {
    expect(restored?.fields[field]?.resolvedValue).toEqual(frames[0]?.fields[field]?.resolvedValue);
    expect(restored?.fields[field]?.source).toBe("inherited");
  }
  await runTool(createExecuteBusinessFrameTool(), {frameId: resumed.frameId}, next);
  await runTool(createExecuteBusinessFrameTool(), {frameId: resumed.frameId}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("明确更换但没有匹配的新指标不能自动查询旧值，独立新问题仍记录未匹配", async () => {
  const f = await toolFixture();
  await runTool(createResolveBusinessTurnTool(), f.delta, f.request);
  const state = await f.store.state();
  const request = {...f.request, originalMessage: "改查未登记的新指标xyz", operationId: "unknown", requestId: "unknown",
    backend: {...f.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
  const delta = {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}},
  ]};
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "METRIC_MENTION_NOT_FOUND"});
  expect(await f.store.state()).toEqual(state);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const independent = receiptJson(await runTool(createResolveBusinessTurnTool(), {...delta, baseReference: null, fieldChanges: [...delta.fieldChanges, {fieldHint: "selection", operation: "set", rawValue: "exact"}]}, request));
  expect(independent.status).toBe("NEEDS_CLARIFICATION");
  const frame = await f.store.get(String(independent.frameId));
  expect(frame?.fields.metrics?.resolutionStatus).toBe("not_found");
  expect(frame?.fields.organizations?.resolutionStatus).toBe("missing");
});

it("新指标待确认保留候选，错误的再次提取不能抹掉它", async () => {
  const f = await toolFixture();
  await runTool(createResolveBusinessTurnTool(), f.delta, f.request);
  const request = {...f.request, originalMessage: "查合成近似指标", operationId: "replacement", requestId: "replacement",
    backend: {...f.backend, matchMetricQuestion: async () => ({mentions: [{text: "合成近似指标", start: 1, end: 7,
      resolution: {status: "needs_confirmation", candidates: [{code: "NEW", value: "合成新指标", score: 0.9}]}}]})} as unknown as BackendClient};
  const delta = {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}},
  ]};
  const pending = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(pending.status).toBe("NEEDS_CLARIFICATION");
  const before = await f.store.state();
  const next = {...f.request, originalMessage: "就是这个", operationId: "accept", requestId: "accept",
    backend: {...f.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
  expect(receiptJson(await runTool(createResolveBusinessTurnTool(), delta, next)).status).toBe("ARGUMENT_ERROR");
  expect(await f.store.state()).toEqual(before);
  const accepted = receiptJson(await runTool(createResolveBusinessTurnTool(), {...delta, fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 1}},
  ]}, next));
  expect(accepted.status).toBe("READY");
  // 确认按逐条 mention 快照直接取候选编码，不再对候选编码重跑目录复核（首轮建帧的名称解析不受影响）。
  expect(f.backend.resolveBusinessField.mock.calls.some(call => call[0] === "metric" && call[1].includes("NEW"))).toBe(false);
  expect((await f.store.get(String(accepted.frameId)))?.fields.metrics?.resolvedValue).toEqual({codes: ["NEW"], names: ["合成新指标"]});
});
