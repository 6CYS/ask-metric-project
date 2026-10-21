import {mkdtempSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeBusinessResultStore, NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {CapabilityRegistry, FieldResolverRegistry, mergeFields, resolveFrame, validateFrame} from "../../src/business-context/core.js";
import type {BusinessFrame, ContextDelta, ResolverContext} from "../../src/business-context/types.js";
import {createExecuteBusinessFrameTool, createReadBusinessResultTool} from "../../src/tools/businessContext.js";
import {createResolveTurnShim} from "./resolveTurnShim.js";
import {MemoryCommandBridge, receiptJson, runTool as executeTool, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import {BackendApiError} from "../../src/backendClient.js";
import {createAskMetricTools} from "../../src/tools/index.js";
import {BusinessInputError} from "../../src/business-context/inputError.js";
import {toContextDelta} from "../../src/business-context/turnArgs.js";

describe("业务上下文回归", () => {
const createResolveBusinessTurnTool = () => createResolveTurnShim();

/** 完整模型参数经过原生准备和Schema校验；内部省略型Delta仍测试原服务语义。 */
/** 仅测试夹具显式声明既定字段意图；生产工具不会替模型补此契约，缺参另有专项测试。 */
async function fixtureFieldIntents(params: unknown, request: Parameters<typeof executeTool>[2]): Promise<unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.hasOwn(params, "fieldIntents")) return params;
  let delta: ContextDelta;
  try { delta = toContextDelta(params); } catch { return params; } // 非法参数仍由原契约测试校验。
  const focus = !delta.capabilityHint && request.frames ? (await request.frames.state()).focusFrameId : undefined;
  const capability = delta.capabilityHint ?? (focus ? (await request.frames!.get(focus))?.capability : undefined);
  const change = delta.fieldChanges.find(item => item.fieldHint === "organizations");
  const raw = change?.rawValue;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const mode = !change || change.operation === "retain" ? "inherit"
    : change.operation === "set" && value && ("confirm" in value || "candidateIndex" in value) ? "confirm" : change.operation;
  const expected = mode === "set" && value?.fromHistory === true && Number.isInteger(value.expectedCount)
    && typeof value.expectedCount === "number" && value.expectedCount > 0 ? value.expectedCount : null;
  return {...params, fieldIntents: capability === "metric_calculate" ? {} : {organizations: {
    mode, sourceText: mode === "inherit" ? null : request.originalMessage, expectedCount: expected}}};
}

async function runTool(...[tool, params, request, context]: Parameters<typeof executeTool>) {
  const candidate = tool as ReturnType<typeof createResolveTurnShim>;
  if (candidate.name === "resolve_business_turn") {
    params = await fixtureFieldIntents(params, request);
    // 内部调用可省略能力和来源；仅改表达，不补字段，也不套用模型Schema。
    if (params && typeof params === "object"
      && Object.hasOwn(params, "capabilityHint") && Object.hasOwn(params, "baseReference")) {
      const prepared = candidate.prepareArguments?.(params as Record<string, unknown>) ?? params;
      return executeTool(tool, prepared, request, context);
    }
  }
  return executeTool(tool, params, request, context);
}

const cleanup: Array<() => Promise<void>> = [];
it("同轮分析补查错用历史相对位置时只纠正调用，保留成功焦点和机构日期", async () => {
  const f = await fixture();
  const context = {...f.context, originalMessage: "样本机构甲2026年2月28日贷款情况怎么样？"};
  const plan = {topic: "loan", goal: "overview", sections: ["scale", "growth", "structure", "quality"]};
  const ready = await f.service.resolve({capabilityHint: "business_overview", baseReference: null, executionMode: "execute",
    fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: plan},
      {fieldHint: "organizations", operation: "set", rawValue: "样本机构甲"}]}, f.identity, context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  const success = await f.service.finishExecution(executing, {status: "success", resultRef: "snapshot:isolated"});
  const before = await f.store.state();
  const count = (await f.store.list()).length;
  const delta: ContextDelta = {capabilityHint: "business_overview", baseReference: {relativePosition: 0}, executionMode: "execute",
    fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: {...plan, metric_ids: ["total", "personal"]}}]};
  await expect(f.service.resolve(delta, f.identity, context)).rejects.toMatchObject({
    code: "ANALYSIS_REFINEMENT_REFERENCE_INVALID", baseReference: {frameId: success.frameId}});
  expect(await f.store.state()).toEqual(before);
  expect(await f.store.list()).toHaveLength(count);
  const corrected = await f.service.resolve({...delta, baseReference: {frameId: success.frameId}}, f.identity, context);
  expect(corrected.status).toBe("ready");
  expect(corrected.fields.organizations?.resolvedValue).toEqual(success.fields.organizations?.resolvedValue);
  expect(corrected.fields.time?.resolvedValue).toEqual(success.fields.time?.resolvedValue);
  expect(corrected.parentFrameId).toBe(success.frameId);
});
it("相同的冗余执行模式可规范化，冲突模式仍拒绝且不保存", async () => {
  const f = await fixture();
  const frame = await f.service.resolve({...f.delta, fieldChanges: [...f.delta.fieldChanges,
    {fieldHint: "executionMode", operation: "set", rawValue: "execute"}]}, f.identity, f.context);
  expect(frame.status).toBe("ready");
  expect(frame.delta.fieldChanges.some(change => change.fieldHint === "executionMode")).toBe(false);
  for (const change of [{operation: "set" as const, rawValue: "resolve_more"}, {operation: "clear" as const, rawValue: "execute"}]) {
    await expect(f.service.resolve({...f.delta, fieldChanges: [...f.delta.fieldChanges, {fieldHint: "executionMode", ...change}]},
      {...f.identity, requestId: change.operation}, f.context)).rejects.toThrow("EXECUTION_MODE_CONFLICT");
  }
  expect((await f.store.state()).focusFrameId).toBe(frame.frameId);
});
it.each(["存贷款", "存贷", "存 贷款", "存款和贷款", "贷款和存款"])("组合主题不能缩成专项概览，已有贷款焦点也不能绕过：%s", async wording => {
  const f = await fixture();
  const delta: ContextDelta = {capabilityHint: "business_overview", baseReference: null, executionMode: "execute",
    fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: {topic: "loan", goal: "overview", sections: ["scale", "growth", "structure", "quality"]}}]};
  await expect(f.service.resolve(delta, f.identity, {...f.context, originalMessage: `紫金最近${wording}情况怎么样？`})).rejects.toThrow("ANALYSIS_SCOPE_UNSUPPORTED");
  expect(await f.store.list()).toHaveLength(0);
  const first = await f.service.resolve(delta, f.identity, {...f.context, originalMessage: "最近贷款情况"});
  await expect(f.service.resolve({...delta, baseReference: "current"}, {...f.identity, requestId: "both", turnId: "both"},
    {...f.context, originalMessage: `最近${wording}情况`, turnId: "both"})).rejects.toThrow("ANALYSIS_SCOPE_UNSUPPORTED");
  expect((await f.store.state()).focusFrameId).toBe(first.frameId);
});

it("Schema先拒绝的空步骤和顶层缺口也给出可操作诊断，不保存无效计划", async () => {
  const f = await fixture();
  const plan = {objective: "合成经营分析", scope_notice: "隔离样本", requirements: [{id: "q1", question: "规模"}],
    steps: [{id: "s1", method: "observe", metric_refs: [], answers: ["q1"], rationale: "先查事实"}]};
  for (const raw of [plan, {...plan, gap_reason: "没有结构指标"}]) {
    await expect(f.service.resolve({capabilityHint: "business_analysis", baseReference: null, executionMode: "execute",
      fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: raw}]}, f.identity,
    {...f.context, originalMessage: "最近经营情况"})).rejects.toMatchObject({code: "FIELD_INPUT_SCHEMA_INVALID", correction: expect.stringContaining("gap_reason")});
  }
  expect(await f.store.list()).toHaveLength(0);
});
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
it("概览日期由原文完整解析，忽略查数控制枚举，独立问题可默认日期", async () => {
  const f = await fixture();
  const plan = {goal: "overview", sections: ["scale", "growth", "structure", "quality"]};
  const originalMessage = "紫金农商行今年五月份到十月份期间贷款情况";
  const dateValues: string[][] = [];
  const context = {...f.context, originalMessage, resolveCatalog: async (_entity: string, values: string[]) => {
    dateValues.push(values); return {status: "resolved" as const, value: {start: "2026-05-01", end: "2026-10-31"}};
  }};
  const frame = await f.service.resolve({capabilityHint: "business_overview", baseReference: null,
    executionMode: "execute", fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: plan},
      {fieldHint: "selection", operation: "set", rawValue: "all_in_range"}]}, f.identity, context);
  expect(frame.status).toBe("ready");
  expect(dateValues).toEqual([["今年五月份到十月份"]]);
  expect(frame.fields.time?.resolvedValue).toEqual({start: "2026-05-01", end: "2026-10-31"});
  const inherited = await f.service.resolve({capabilityHint: "business_overview", baseReference: "current",
    executionMode: "execute", fieldChanges: []}, {...f.identity, turnId: "followup", requestId: "followup"},
    {...context, originalMessage: "这个期间的贷款情况", turnId: "followup"});
  expect(inherited.status).toBe("ready");
  expect(inherited.fields.time?.resolvedValue).toEqual(frame.fields.time?.resolvedValue);
  const fresh = await f.service.resolve({capabilityHint: "business_overview", baseReference: null,
    executionMode: "execute", fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: plan},
      {fieldHint: "time", operation: "retain"}]}, {...f.identity, turnId: "fresh", requestId: "fresh"},
    {...context, originalMessage: "紫金农商行贷款情况", turnId: "fresh"});
  expect(fresh.status).toBe("ready");
  expect(fresh.fields.time?.resolutionStatus).toBe("missing");
});

it("无界最近的查询错误转入实际覆盖规划，不保存无效日期澄清", async () => {
  const f = await fixture();
  await expect(f.service.resolve(f.delta, f.identity, {...f.context, originalMessage: "样本机构甲最近样本指标甲表现如何"}))
    .rejects.toThrow("ANALYSIS_LATEST_PLAN_REQUIRED");
  expect((await f.store.list()).length).toBe(0);
  await expect(f.service.resolve(f.delta, f.identity, {...f.context, originalMessage: "最近手续费收入表现，和上个月相比如何"}))
    .rejects.toThrow("ANALYSIS_LATEST_PLAN_REQUIRED");
  const exact = await f.service.resolve(f.delta, f.identity, {...f.context, originalMessage: "最近一次讨论后，请查样本机构甲2026年2月28日样本指标甲"});
  expect(exact.status).toBe("ready");
});

it("比较基期追问忽略模型误填的目标月份，继承已确认观测日期", async () => {
  const f = await fixture();
  const plan = {goal: "overview", sections: ["scale", "growth", "structure", "quality"]};
  const first = await f.service.resolve({capabilityHint: "business_overview", baseReference: null, executionMode: "execute",
    fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: plan}]}, f.identity,
    {...f.context, originalMessage: "2026年2月28日贷款情况"});
  const resolveCatalog = vi.fn(f.context.resolveCatalog);
  const followup = await f.service.resolve({capabilityHint: "business_overview", baseReference: "current", executionMode: "execute",
    fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "上个月"}]},
    {...f.identity, turnId: "comparison", requestId: "comparison"},
    {...f.context, turnId: "comparison", originalMessage: "那只看贷款质量，和上个月、去年同期相比怎么样？", resolveCatalog});
  expect(followup.fields.time?.resolvedValue).toEqual(first.fields.time?.resolvedValue);
  expect(followup.fields.time?.source).toBe("inherited");
  expect(resolveCatalog).not.toHaveBeenCalledWith("date", ["上个月"], expect.anything());
});

it("具备通用底座时基础指标未命中先发现正式目录，旧客户端保留原行为", async () => {
  const f = await fixture();
  const context = {...f.context, analysisFallbackAvailable: true,
    resolveMetricMentions: async () => ({mentions: [{text: "合成盈利", start: 0, end: 4, resolution: {status: "not_found" as const}}]})};
  const delta: ContextDelta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  await expect(f.service.resolve(delta, f.identity, context)).rejects.toThrow("ANALYSIS_METRIC_DISCOVERY_REQUIRED");
  expect(await f.store.list()).toHaveLength(0);
});
it("概览原文中的机构不会因模型漏填或clear而误用默认机构，追问仍继承", async () => {
  const f = await fixture();
  const context = {...f.context, originalMessage: "紫金农商行贷款情况", organizationMentions: async () => ["紫金"]};
  const frame = await f.service.resolve({capabilityHint: "business_overview", baseReference: null,
    executionMode: "execute", fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: {
      goal: "overview", sections: ["scale", "growth", "structure", "quality"]}},
      {fieldHint: "organizations", operation: "clear"}]}, f.identity, context);
  expect(frame.status).toBe("ready");
  expect(frame.fields.organizations?.resolvedValue).toEqual({codes: ["organization:紫金"], names: ["紫金"]});
  const followup = await f.service.resolve({capabilityHint: "business_overview", baseReference: "current",
    executionMode: "execute", fieldChanges: []}, {...f.identity, turnId: "followup", requestId: "followup"},
    {...context, originalMessage: "这个期间的贷款情况", turnId: "followup", organizationMentions: async () => []});
  expect(followup.fields.organizations?.resolvedValue).toEqual(frame.fields.organizations?.resolvedValue);
  const explicit = await f.service.resolve({capabilityHint: "business_overview", baseReference: null,
    executionMode: "execute", fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: {
      goal: "overview", sections: ["scale", "growth", "structure", "quality"]}},
      {fieldHint: "organizations", operation: "set", rawValue: "江阴"}]},
    {...f.identity, turnId: "explicit", requestId: "explicit"},
    {...context, originalMessage: "不要紫金，只看江阴的贷款情况", turnId: "explicit", organizationMentions: async () => ["紫金", "江阴"]});
  expect(explicit.fields.organizations?.resolvedValue).toEqual({codes: ["organization:江阴"], names: ["江阴"]});
});
it("概览请求结果时纠正模型resolve_more；用户明确只规划时不执行", async () => {
  const f = await fixture();
  const delta: ContextDelta = {capabilityHint: "business_overview", baseReference: null, executionMode: "resolve_more",
    fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: {goal: "overview", sections: ["scale", "growth", "structure", "quality"]}}]};
  const result = await f.service.resolve(delta, f.identity, {...f.context, originalMessage: "这个期间的贷款情况"});
  expect(result.delta.executionMode).toBe("execute");
  const planning = await f.service.resolve(delta, {...f.identity, turnId: "plan", requestId: "plan"},
    {...f.context, originalMessage: "只做贷款分析规划，不用查询", turnId: "plan"});
  expect(planning.delta.executionMode).toBe("resolve_more");
});
it("新查询、缺项澄清、补充、继承、清除、任意历史分支不覆盖旧 Frame", async () => {
  const f = await fixture();
  const first = await f.service.resolve({...f.delta, fieldChanges: f.delta.fieldChanges.filter(c => c.fieldHint !== "time")}, f.identity, f.context);
  expect(first.status).toBe("clarifying"); expect(first.issues).toEqual([{field: "time", reason: "missing"}]);
  const nextId = {...f.identity, turnId: "turn-b", requestId: "request-b"};
  const second = await f.service.resolve({fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "2026年2月28日"}], executionMode: "execute"}, nextId, {...f.context, turnId: nextId.turnId});
  expect(second.status).toBe("ready"); expect(second.fields.metrics?.sourceFrameId).toBe(first.frameId);
  // 清除与历史分支分别是新用户回合，不能复用补充条件那一轮的 turnId。
  const cleared = await f.service.resolve({fieldChanges: [{fieldHint: "metrics", operation: "clear"}], executionMode: "execute"}, {...nextId, turnId: "turn-c", requestId: "clear"}, {...f.context, turnId: "turn-c"});
  expect(cleared.issues).toEqual([{field: "metrics", reason: "missing"}]);
  const branch = await f.service.resolve({baseReference: {ordinal: 2}, fieldChanges: [], executionMode: "resolve_more"}, {...nextId, turnId: "turn-d", requestId: "branch"}, {...f.context, turnId: "turn-d"});
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

async function historicalToolFixture() {
  const f = await toolFixture();
  const seed = (turnId: string) => f.service.resolve(f.delta, {...f.identity, turnId, requestId: turnId}, {...f.context, turnId});
  const first = await seed("history-first");
  const second = await seed("history-second");
  return {...f, first, second};
}

it.each(["ordinal", "frameId", "current"])(
  "字段冲突保留%s明确来源，不写Frame或移动焦点，纠正后继承该来源", async source => {
  const f = await historicalToolFixture();
  const base = source === "ordinal" ? {ordinal: 1} : source === "frameId" ? {frameId: f.first.frameId} : "current";
  const expected = source === "current" ? f.second : f.first;
  const before = await f.store.state();
  const frames = await f.store.list();
  const args = {capabilityHint: "metric_query", baseReference: base, executionMode: "resolve_more", fieldChanges: [
    {fieldHint: "time", operation: "retain"}, {fieldHint: "time", operation: "retain"}]};
  const error = receiptJson(await runTool(createResolveBusinessTurnTool(), args, f.request));
  expect(error).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_CHANGES_INVALID", focus_preserved: true,
    retry_reference: {frameId: expected.frameId}});
  expect(await f.store.state()).toEqual(before);
  expect(await f.store.list()).toEqual(frames);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const corrected = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query",
    baseReference: error.retry_reference, executionMode: "resolve_more", fieldChanges: []}, f.request));
  expect(corrected.status).toBe("READY");
  expect((await f.store.get(String(corrected.frameId)))?.parentFrameId).toBe(expected.frameId);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each(["null", "omitted", "ambiguous", "missing"])(
  "字段冲突的%s来源不补猜当前焦点", async source => {
  const f = await historicalToolFixture();
  const base = source === "null" ? null : source === "ambiguous" ? {capability: "metric_query"} : {ordinal: 999};
  const before = await f.store.state();
  const frames = await f.store.list();
  const args = {capabilityHint: "metric_query", ...(source === "omitted" ? {} : {baseReference: base}),
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "time", operation: "retain"}, {fieldHint: "time", operation: "retain"}]};
  const error = receiptJson(await runTool(createResolveBusinessTurnTool(), args, f.request));
  expect(error).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_CHANGES_INVALID", focus_preserved: true});
  expect(error).not.toHaveProperty("retry_reference");
  expect(await f.store.state()).toEqual(before);
  expect(await f.store.list()).toEqual(frames);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("混入已废弃格式的专属键不能被当成已确认来源", async () => {
  const f = await historicalToolFixture();
  const before = await f.store.state();
  const frames = await f.store.list();
  const args = {capabilityHint: "metric_query", baseReference: {ordinal: 1}, executionMode: "resolve_more", fieldChanges: [], set: {time: "2026年2月28日"}};
  const error = receiptJson(await runTool(createResolveBusinessTurnTool(), args, f.request));
  expect(error).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_CHANGES_INVALID"});
  expect(error).not.toHaveProperty("retry_reference");
  expect(await f.store.state()).toEqual(before);
  expect(await f.store.list()).toEqual(frames);
});

it.each(["executing", "failed", "invalid_reference"])("当前焦点指向旧READY但最新操作为%s时，字段冲突不能补旧来源绕过状态", async latestState => {
  const f = await historicalToolFixture();
  const execution = await f.service.beginExecution(f.first.frameId, {...f.identity, turnId: f.first.turnId});
  if (latestState === "failed") await f.service.finishExecution(execution, {status: "failed", errorCode: "SYNTHETIC_FAILURE"});
  if (latestState === "invalid_reference") {
    const state = await f.store.state();
    await f.store.save({...execution, frameId: "invalid-reference-snapshot", status: "clarifying", issues: [{field: "$base", reason: "invalid"}]},
      state.version, "invalid-reference-command");
  }
  // 历史浏览可以切回准备快照；current仍须服从同一操作的最新执行状态。
  await f.store.setFocus(f.first.frameId, (await f.store.state()).version);
  const before = await f.store.state();
  const frames = await f.store.list();
  const error = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "time", operation: "retain"}, {fieldHint: "time", operation: "retain"}]}, f.request));
  expect(error).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_CHANGES_INVALID", focus_preserved: true});
  expect(error).not.toHaveProperty("retry_reference");
  expect(await f.store.state()).toEqual(before);
  expect(await f.store.list()).toEqual(frames);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("当前焦点指向旧READY但最新操作为可继承瞬时失败时，字段冲突引用最新失败快照", async () => {
  const f = await historicalToolFixture();
  const execution = await f.service.beginExecution(f.first.frameId, {...f.identity, turnId: f.first.turnId});
  const failure = await f.service.finishExecution(execution, {status: "failed", errorCode: "SCOPE_CHANGED"});
  await f.store.setFocus(f.first.frameId, (await f.store.state()).version);
  const before = await f.store.state();
  const frames = await f.store.list();
  const error = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "time", operation: "retain"}, {fieldHint: "time", operation: "retain"}]}, f.request));
  expect(error).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_CHANGES_INVALID", focus_preserved: true,
    retry_reference: {frameId: failure.frameId}});
  expect(await f.store.state()).toEqual(before);
  expect(await f.store.list()).toEqual(frames);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

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
  // 旧原句覆盖证明通道已删除：执行只提交规范化编码，不附 source_question/逐目标绑定。
  for (const proof of ["source_question", "source_metric_bindings", "source_metric_exclusions", "verify_question_coverage"]) {
    expect(query[proof]).toBeUndefined();
  }
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
  for (const proof of ["source_question", "source_metric_bindings"]) expect(query[proof]).toBeUndefined();
});
it("同一基础指标下的多个口径共用一组候选，确认一次全部确定并只执行一次", async () => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 对公日均存钱余额当日数和较同期增幅";
  const mention = (text: string) => ({text, start: question.indexOf(text), end: question.indexOf(text) + text.length});
  const base = (source: string, basis: string, name: string) => ({value: `${name}${basis}`, code: `${source}:${basis}`,
    metadata: {kind: "base", source_metric_code: source, base_name: name, group: "g1"}});
  const member = (text: string, basis: string) => ({...mention(text), group: {id: "g1"}, resolution: {
    status: "needs_confirmation" as const, metadata: {issue: "base_uncertain"},
    candidates: [base("CORP", basis, "对公日均存款余额"), base("TOTAL", basis, "各项存款余额")]}});
  const request = {...f.request, originalMessage: question, backend: {...f.backend, matchMetricQuestion: vi.fn(async () => ({
    mentions: [member("对公日均存钱余额当日数", "当日数"), member("较同期增幅", "较同期增幅")]}))} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const firstFrame = await f.store.get(String(first.frameId));
  // 同组只展示一次基础指标候选，不让用户对每个口径重复选择。
  expect(firstFrame?.fields.metrics?.candidates?.map(candidate => candidate.code)).toEqual(["CORP:当日数", "TOTAL:当日数"]);
  const next = {...request, originalMessage: "是对公日均存款余额", requestId: "confirmed", operationId: "confirmed",
    backend: {...request.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 1}},
  ]}, next));
  expect(ready.status).toBe("READY");
  const readyFrame = await f.store.get(String(ready.frameId));
  expect(readyFrame?.fields.metrics?.resolvedValue).toEqual({codes: ["CORP:当日数", "CORP:较同期增幅"],
    names: ["对公日均存款余额当日数", "对公日均存款余额较同期增幅"]});
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(query.metric_codes).toEqual(["CORP:当日数", "CORP:较同期增幅"]);
  for (const proof of ["source_question", "source_metric_bindings"]) expect(query[proof]).toBeUndefined();
});
it("只确认了基础指标、原文没有口径时继续按目录追问口径，不替用户默认", async () => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 手机银行客户数是多少";
  const text = "手机银行客户数";
  const request = {...f.request, originalMessage: question, backend: {...f.backend, matchMetricQuestion: vi.fn(async () => ({
    mentions: [{text, start: question.indexOf(text), end: question.indexOf(text) + text.length, resolution: {
      status: "needs_confirmation" as const, metadata: {issue: "base_uncertain"},
      candidates: [{value: "手机银行客户数量", score: 0.9, metadata: {kind: "base_only", source_metric_code: "MOB"}}]}}]}))} as unknown as BackendClient};
  f.backend.resolveBusinessField.mockImplementation(async (entity, raw) => entity === "metric"
    ? {status: "needs_confirmation", candidates: [{value: "手机银行客户数量当日数", code: "MOB:当日数", metadata: {rawValueIndex: 0, value_basis: "当日数"}},
      {value: "手机银行客户数量较上月", code: "MOB:较上月", metadata: {rawValueIndex: 0, value_basis: "较上月"}}]}
    : f.context.resolveCatalog(entity, raw));
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const baseTurn = {...request, originalMessage: "是手机银行客户数量", requestId: "base", operationId: "base",
    backend: {...request.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
  const basisAsked = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 1}},
  ]}, baseTurn));
  expect(basisAsked.status).toBe("NEEDS_CLARIFICATION");
  expect(f.backend.resolveBusinessField.mock.calls.some(call => call[0] === "metric"
    && JSON.stringify(call[1]) === JSON.stringify(["手机银行客户数量"]))).toBe(true);
  const askedFrame = await f.store.get(String(basisAsked.frameId));
  expect(askedFrame?.fields.metrics?.candidates?.map(candidate => candidate.code)).toEqual(["MOB:当日数", "MOB:较上月"]);
  const basisTurn = {...baseTurn, originalMessage: "较上月", requestId: "basis", operationId: "basis"};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 2}},
  ]}, basisTurn));
  expect(ready.status).toBe("READY");
  expect((await f.store.get(String(ready.frameId)))?.fields.metrics?.resolvedValue)
    .toEqual({codes: ["MOB:较上月"], names: ["手机银行客户数量较上月"]});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it.each([
  // 复现：用户原文点名第2个候选，模型却提交序号1；以用户原文为准。
  {reply: "对公日均存款余额当日数", modelIndex: 1, expected: "ORG:当日数"},
  {reply: "当日数", modelIndex: 1, expected: "ORG:当日数"},
  {reply: "当日数排名", modelIndex: 2, expected: "ORG:当日数排名"},
  // 序号指系统展示清单的编号，与模型给出的序号无关。
  {reply: "第一个", modelIndex: 3, expected: "ORG:全省均值"},
  {reply: "3", modelIndex: 1, expected: "ORG:当日数排名"},
])("缺口径确认以用户回复在系统清单中对应的候选为准：$reply", async ({reply, modelIndex, expected}) => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 对公日均存款余额是多少";
  const text = "对公日均存款余额";
  const candidate = (basis: string) => ({value: `对公日均存款余额${basis}`, code: `ORG:${basis}`, metadata: {value_basis: basis}});
  const request = {...f.request, originalMessage: question, backend: {...f.backend, matchMetricQuestion: vi.fn(async () => ({
    mentions: [{text, start: question.indexOf(text), end: question.indexOf(text) + text.length, resolution: {
      status: "needs_confirmation" as const, metadata: {issue: "missing_value_basis"},
      // 候选按名称排序：“全省均值”排在“当日数”之前。
      candidates: [candidate("全省均值"), candidate("当日数"), candidate("当日数排名")]}}]}))} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  expect(receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request)).status).toBe("NEEDS_CLARIFICATION");
  const replyMentions = reply === "对公日均存款余额当日数"
    ? [{text: reply, start: 0, end: reply.length, resolution: {status: "resolved" as const, value: {codes: ["ORG:当日数"], names: [reply]}}}]
    : [];
  const next = {...request, originalMessage: reply, requestId: "confirm", operationId: "confirm",
    backend: {...request.backend, matchMetricQuestion: async () => ({mentions: replyMentions})} as unknown as BackendClient};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: modelIndex}},
  ]}, next));
  expect(ready.status).toBe("READY");
  const metrics = (await f.store.get(String(ready.frameId)))?.fields.metrics;
  expect((metrics?.resolvedValue as {codes: string[]}).codes).toEqual([expected]);
  expect(metrics?.metadata?.confirmationSource).toBe("user_reply");
});
async function missingBasisFixture() {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 对公日均存款余额是多少";
  const text = "对公日均存款余额";
  const candidate = (basis: string) => ({value: `对公日均存款余额${basis}`, code: `ORG:${basis}`, metadata: {value_basis: basis}});
  const request = {...f.request, originalMessage: question, backend: {...f.backend, matchMetricQuestion: vi.fn(async () => ({
    mentions: [{text, start: question.indexOf(text), end: question.indexOf(text) + text.length, resolution: {
      status: "needs_confirmation" as const, candidates: [candidate("全省均值"), candidate("当日数"), candidate("当日数排名")]}}]}))} as unknown as BackendClient};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
    ? {...change, rawValue: {fromQuestion: true}} : change)};
  const first = await runTool(createResolveBusinessTurnTool(), delta, request);
  const turn = (reply: string, extra: Record<string, unknown> = {}) => ({...request, originalMessage: reply, requestId: reply, operationId: reply,
    backend: {...request.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient, ...extra});
  return {...f, first, turn};
}
it("待确认时回执携带系统规范清单，模型视图只有候选数量", async () => {
  const f = await missingBasisFixture();
  const details = f.first.details as {status: string; options: Array<{title: string; options: Array<{no: number; label: string}>}>};
  expect(details.status).toBe("NEEDS_CLARIFICATION");
  expect(details.options[0]!.options.map(option => `${option.no}.${option.label}`))
    .toEqual(["1.对公日均存款余额全省均值", "2.对公日均存款余额当日数", "3.对公日均存款余额当日数排名"]);
  expect((f.first.details as {listing: string}).listing).toBe(
    "请回复下列序号或名称：\n请选择「对公日均存款余额」的口径：\n1. 对公日均存款余额全省均值\n2. 对公日均存款余额当日数\n3. 对公日均存款余额当日数排名");
  const receipt = receiptJson(f.first);
  expect(JSON.stringify(receipt)).not.toContain("对公日均存款余额全省均值");
  expect((receipt.fields as Record<string, {pendingChoices?: {count: number}}>).metrics?.pendingChoices?.count).toBe(3);
});
it("模型漏传指标字段时，用户回复已明确的候选仍被确认", async () => {
  const f = await missingBasisFixture();
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: []}, f.turn("当日数")));
  expect(ready.status).toBe("READY");
  const metrics = (await f.store.get(String(ready.frameId)))?.fields.metrics;
  expect((metrics?.resolvedValue as {codes: string[]}).codes).toEqual(["ORG:当日数"]);
});
it("回复对应不上时保持待确认并重新展示清单，不按模型序号取数", async () => {
  const f = await missingBasisFixture();
  const unclear = await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {candidateIndex: 1}},
  ]}, f.turn("好的"));
  expect(receiptJson(unclear).status).toBe("NEEDS_CLARIFICATION");
  expect((unclear.details as {confirmation_unclear?: boolean}).confirmation_unclear).toBe(true);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  // 下一轮仍可按同一份清单回复。
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {confirm: true}},
  ]}, f.turn("第2个")));
  expect(ready.status).toBe("READY");
  expect(((await f.store.get(String(ready.frameId)))?.fields.metrics?.resolvedValue as {codes: string[]}).codes).toEqual(["ORG:当日数"]);
});
it("点选只对当前待确认 Frame 生效，回复文字无法识别时由点选确定", async () => {
  const f = await missingBasisFixture();
  const confirm = {executionMode: "execute", fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: {confirm: true}}]};
  const optionId = (f.first.details as {options: Array<{options: Array<{id: string}>}>}).options[0]!.options[2]!.id;
  // 点选指向别的 Frame：不生效，重新展示清单（产生新的待确认 Frame）。
  const stale = await runTool(createResolveBusinessTurnTool(), confirm,
    f.turn("这个", {clarificationSelection: {frame_id: "other-frame", option_ids: [optionId]}}));
  expect(receiptJson(stale).status).toBe("NEEDS_CLARIFICATION");
  const latest = (stale.details as {frame_id: string}).frame_id;
  const clicked = receiptJson(await runTool(createResolveBusinessTurnTool(), confirm,
    f.turn("就这个", {clarificationSelection: {frame_id: latest, option_ids: [optionId]}})));
  expect(clicked.status).toBe("READY");
  expect(((await f.store.get(String(clicked.frameId)))?.fields.metrics?.resolvedValue as {codes: string[]}).codes).toEqual(["ORG:当日数排名"]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("用户明确放弃一项指标后执行剩余项，执行只提交保留指标编码", async () => {
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
  // 排除证据不再以证明字段上送；放弃行为由工作状态 removedMentions（上方断言）承担。
  for (const proof of ["source_question", "source_metric_exclusions"]) expect(query[proof]).toBeUndefined();
});
it("续查轮静默丢项仍只按选中项执行，不再附覆盖率复核证明", async () => {
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
  // 每个真实请求都会创建独立缓存；测试跨轮复制上下文时也必须清掉首轮解析 Promise。
  delete next.metricMentions;
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true, mentionIndexes: [1]}},
  ]}, next));
  expect(ready.status).toBe("READY");
  expect((await f.store.get(String(ready.frameId)))?.fields.metrics?.metadata?.questionText).toBe(followUpQuestion);
  expect((await f.store.get(String(ready.frameId)))?.fields.metrics?.metadata?.mentionResolutions)
    .toEqual([{text: "合成余额当日数", start: 0, end: 7, status: "resolved", value: {codes: ["A"], names: ["合成余额当日数"]}}]);
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, next);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  // 覆盖率复核通道已删除：执行只提交实际选中的规范化编码，不附原句或逐目标绑定。
  expect(query.metric_codes).toEqual(["A"]);
  for (const proof of ["source_question", "source_metric_bindings", "verify_question_coverage"]) {
    expect(query[proof]).toBeUndefined();
  }
});
it("同名双码的指标别名跨轮补条件后沿用已定编码，不改写为同名名称", async () => {
  const f = await toolFixture();
  const question = "那我需要查资产总额";
  const request = {...f.request, originalMessage: question, backend: {...f.backend,
    matchMetricQuestion: vi.fn(async () => ({mentions: [{text: "资产总额", start: 5, end: 9,
      resolution: {status: "resolved", value: {codes: ["TEST_ASSET"], names: ["资产总额当日数"]}}}]})),
  } as unknown as BackendClient};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: null,
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}}]}, request));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const next = {...request, originalMessage: "样本机构甲，2026年2月28日", requestId: "supplement", operationId: "supplement"};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute",
    fieldChanges: f.delta.fieldChanges.filter(change => change.fieldHint !== "metrics")}, next));
  expect(ready.status).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, next);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  // 沿用已定编码，不改写为同名名称；旧证明字段不再上送。
  expect(query).toMatchObject({metric_codes: ["TEST_ASSET"]});
  for (const proof of ["source_question", "source_metric_bindings"]) expect(query[proof]).toBeUndefined();
});
it("连续放弃后确认余项仍累计排除快照，执行只提交保留项", async () => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 合成甲、合成乙、合成丙";
  const names = ["合成甲", "合成乙", "合成丙"];
  const request = {...f.request, originalMessage: question, backend: {...f.backend,
    matchMetricQuestion: vi.fn(async () => ({mentions: names.map((text, index) => ({
      text, start: question.indexOf(text), end: question.indexOf(text) + text.length,
      resolution: index < 2 ? {status: "resolved", value: {codes: [index === 0 ? "A" : "B"], names: [text]}}
        : {status: "needs_confirmation", candidates: [{value: "合成丙当日数", code: "C"}]},
    }))})),
  } as unknown as BackendClient};
  const initial = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics" ? {...change, rawValue: {fromQuestion: true}} : change)}, request));
  expect(initial.status).toBe("NEEDS_CLARIFICATION");
  const turn = (originalMessage: string) => ({...request, originalMessage, operationId: originalMessage, requestId: originalMessage});
  const remove = (originalMessage: string) => runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "remove", rawValue: {mentionIndexes: [1]}},
  ]}, turn(originalMessage));
  expect(receiptJson(await remove("不要合成甲了")).status).toBe("NEEDS_CLARIFICATION");
  expect(receiptJson(await remove("不要合成乙了")).status).toBe("NEEDS_CLARIFICATION");
  const confirmedRequest = turn("就是合成丙当日数");
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: {confirm: true}},
  ]}, confirmedRequest));
  expect(ready.status).toBe("READY");
  const frame = await f.store.get(String(ready.frameId));
  expect(frame?.fields.metrics?.metadata?.removedMentions).toEqual([
    {text: "合成甲", start: 17, end: 20, status: "removed"},
    {text: "合成乙", start: 21, end: 24, status: "removed"},
  ]);
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, confirmedRequest);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(query).toMatchObject({metric_codes: ["C"]});
  for (const proof of ["source_question", "source_metric_bindings", "source_metric_exclusions"]) {
    expect(query[proof]).toBeUndefined();
  }
});
it("放弃首项保留共享基础名，执行只提交剩余口径编码", async () => {
  const f = await toolFixture();
  const question = "样本机构甲 2026年2月28日 贷款余额当日数和较上月增幅";
  const request = {...f.request, originalMessage: question, backend: {...f.backend,
    matchMetricQuestion: vi.fn(async () => ({mentions: [
      {text: "贷款余额当日数", start: 17, end: 24, group: {id: "g1"},
        resolution: {status: "resolved", value: {codes: ["LOAN:CURRENT"], names: ["贷款余额当日数"]}}},
      {text: "较上月增幅", start: 25, end: 30, group: {id: "g1"},
        resolution: {status: "resolved", value: {codes: ["LOAN:GROWTH"], names: ["贷款余额较上月增幅"]}}},
    ]})),
  } as unknown as BackendClient};
  const initial = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics" ? {...change, rawValue: {fromQuestion: true}} : change)}, request));
  expect(initial.status).toBe("READY");
  const next = {...request, originalMessage: "不要当日数，只要较上月增幅", operationId: "remove-first", requestId: "remove-first"};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "remove", rawValue: {mentionIndexes: [1]}},
  ]}, next));
  expect(ready.status).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: String(ready.frameId)}, next);
  const query = (f.backend.basicQueries.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(query).toMatchObject({metric_codes: ["LOAN:GROWTH"]});
  for (const proof of ["source_question", "source_metric_bindings", "source_metric_exclusions"]) {
    expect(query[proof]).toBeUndefined();
  }
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
it("独立四指标问题完整提交目录编码，不能只执行前一项", async () => {
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
    expect.objectContaining({metric_codes: codes}),
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
    // 测试文件位于 specs/，被检查的生产源码仍在 src/business-context/ 下
    const text = readFileSync(new URL(`../../src/business-context/${file}`, import.meta.url), "utf8");
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
  const {projectHistoricalResults} = await import("../../src/modelContext.js");
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
it("计算表达式的额外包装被明确拒绝，不猜测展开或修改原焦点", async () => {
  const f = await toolFixture();
  const before = await f.store.state();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_calculate", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "expressions", operation: "set", rawValue: {expressions: [{name: "difference", label: "差额", expression: "a-b"}]}},
    ]}, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INPUT_SCHEMA_INVALID", field: "expressions"});
  expect(await f.store.state()).toEqual(before);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("计算引用 Resolver 拒绝没有本会话成功查询来源的 fact_id", async () => {
  const f = await toolFixture();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_calculate", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "expressions", operation: "set", rawValue: [{name: "sum", label: "合计", expression: "x"}]},
      {fieldHint: "bindings", operation: "set", rawValue: {x: {fact_id: "fact:unknown:0:metric_value"}}},
    ]}, f.request));
  expect(result.status).toBe("ARGUMENT_ERROR");
  expect(result.field).toContain("bindings");
});
it.each(["missing_fact", "truncated", "not_ready", "revoked"])("历史计算输入%s被明确拒绝且不偷偷重新取数", async kind => {
  const f = await toolFixture();
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
  const before = await f.store.state();
  f.backend.getTaskResult.mockResolvedValue({status: kind === "not_ready" ? "failed" : "succeeded",
    task_id: "task-synthetic", result_id: "result:task-synthetic", rows: [], columns: [], row_count: 1,
    offset: 0, limit: 1, has_more: false, truncated: kind === "truncated", calculation_scope_id: "old-turn",
    facts: kind === "missing_fact" ? [] : [{fact_id: "fact:task-synthetic:0:metric_value"}]} as never);
  if (kind === "revoked") f.backend.getTaskResult.mockRejectedValue(new BackendApiError(403, "synthetic forbidden"));
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_calculate", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "expressions", operation: "set", rawValue: [{name: "copy", label: "取值", expression: "x"}]},
      {fieldHint: "bindings", operation: "set", rawValue: {x: {fact_id: "fact:task-synthetic:0:metric_value"}}},
    ]}, {...f.request, operationId: "later", requestId: "later", originalMessage: "使用之前的原值计算"}));
  expect(result.status).not.toBe("READY");
  expect(result.error_code).toBe({missing_fact: "CALCULATION_FACT_UNAVAILABLE", truncated: "CALCULATION_SOURCE_INCOMPLETE",
    not_ready: "CALCULATION_SOURCE_NOT_READY", revoked: "BACKEND_403"}[kind]);
  expect(await f.store.state()).toEqual(before);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});
it("query resultRef 使用只读 GET 与真实分页，不发送空 original_question", async () => {
  const f = await toolFixture();
  const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const executing = await f.service.beginExecution(ready.frameId, f.identity);
  const success = await f.service.finishExecution(executing, {status: "success", resultRef: "query:task-synthetic:result%3Atask-synthetic"});
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({status: "succeeded", task_id: "task-synthetic", result_id: "result:task-synthetic", columns: [], rows: [], row_count: 0, offset: 5, limit: 10, has_more: false})));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const {BackendClient} = await import("../../src/backendClient.js");
    const result = await runTool(createReadBusinessResultTool(), {frameId: success.frameId, offset: 5, limit: 10},
      {...f.request, backend: new BackendClient("http://synthetic.invalid", "test-only", 1000)});
    expect(result.details.status).toBe("succeeded");
    const calls = fetchMock.mock.calls as unknown[][];
    expect(String(calls[0]?.[0])).toContain("/result?offset=5&limit=10");
    expect((calls[0]?.[1] as RequestInit).method).not.toBe("POST");
  } finally {vi.unstubAllGlobals();}
});
it.each([false, true])("计算 Frame 支持历史快照=%s，保留本轮身份、幂等和撤权保护", async historical => {
  const f = await toolFixture();
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
  const calculationRequest = {...f.request, operationId: historical ? "new-calculation" : f.request.operationId,
    requestId: historical ? "new-calculation" : f.request.requestId, originalMessage: "使用刚才的原值乘以3"};
  const factId = "fact:task-synthetic:0:metric_value";
  f.backend.getTaskResult.mockResolvedValue({status: "succeeded", task_id: "task-synthetic", result_id: "result:task-synthetic", rows: [], columns: [], row_count: 1, offset: 0, limit: 1, has_more: false,
    calculation_scope_id: f.request.operationId, facts: [{fact_id: factId}], truncated: false} as never);
  const calculate = vi.fn(async () => ({status: "succeeded", calculation_id: "calculation-synthetic", task_id: "task-synthetic", results: [], inputs: {x: {task_id: "task-synthetic"}, factor: {kind: "user_constant", value: "3", source_text: "3"}}, public_answer: "合成计算结果"}));
  Object.assign(f.backend, {calculate});
  const resolved = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_calculate", baseReference: null, executionMode: "execute", fieldChanges: [
    {fieldHint: "expressions", operation: "set", rawValue: [{name: "copy", label: "取值", expression: "x*factor"}]},
    {fieldHint: "bindings", operation: "set", rawValue: {x: {fact_id: factId}}},
    {fieldHint: "constants", operation: "set", rawValue: {factor: {value: "3", source_text: "3"}}},
  ]}, calculationRequest));
  expect(resolved.status).toBe("READY");
  const result = await runTool(createExecuteBusinessFrameTool(), {frameId: resolved.frameId}, calculationRequest);
  expect(result.details.status).toBe("succeeded");
  expect((await runTool(createReadBusinessResultTool(), {frameId: result.details.frame_id}, calculationRequest)).details.status).toBe("succeeded");
  await runTool(createExecuteBusinessFrameTool(), {frameId: resolved.frameId}, calculationRequest);
  expect(calculate).toHaveBeenCalledTimes(1);
  expect(calculate).toHaveBeenCalledWith(expect.objectContaining({scope_id: calculationRequest.operationId,
    source_policy: "conversation_snapshots", user_question: calculationRequest.originalMessage}), expect.any(String), expect.any(Object));
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  f.backend.getTaskResult.mockRejectedValue(new BackendApiError(403, "synthetic forbidden"));
  expect((await runTool(createReadBusinessResultTool(), {frameId: result.details.frame_id}, calculationRequest)).details.status).toBe("error");
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
  const {businessKey} = await import("../../src/business-context/service.js");
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
  expect(resolver).toHaveBeenLastCalledWith("date", ["4 月份"], 2024, undefined);
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
  const updated = await f.service.resolve({executionMode: "resolve_more", fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "2026年2月28日"}]}, secondIdentity, secondContext);
  expect(updated.fields.organizations?.resolutionStatus).toBe("needs_confirmation");
  // 混合话语不默认为同意；由当前 Frame 的实际点选提供确认依据，仍追溯候选最初产生的回合。
  const confirmed = await f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {candidateIndex: 1}}]}, secondIdentity,
    {...secondContext, replyEvidence: async frameId => ({reply: secondContext.originalMessage,
      optionIds: frameId === updated.frameId ? ["organizations:0:code:O1"] : []})});
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

describe("指标匹配临时失败的恢复", () => {
  const question = "查询合成余额本期数 样本机构甲 2026年2月28日";
  const mentions = {mentions: [{text: "合成余额本期数", start: 2, end: 9,
    resolution: {status: "resolved", value: {codes: ["FULL"], names: ["合成余额本期数"]}}}]};
  async function failingOnce() {
    const f = await toolFixture();
    const matchMetricQuestion = vi.fn().mockRejectedValueOnce(new Error("synthetic timeout")).mockResolvedValue(mentions);
    const request = {...f.request, originalMessage: question, backend: {...f.backend, matchMetricQuestion} as unknown as BackendClient};
    const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "metrics"
      ? {...change, rawValue: "合成余额本期数"} : change)};
    const first = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
    expect(first.status).toBe("TEMPORARY_ERROR");
    return {f, request, delta, first, matchMetricQuestion};
  }

  it("同轮再次解析会重新匹配，临时失败不被缓存", async () => {
    const {request, delta, matchMetricQuestion} = await failingOnce();
    const again = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
    expect(again.status).toBe("READY");
    expect(matchMetricQuestion).toHaveBeenCalledTimes(2);
  });

  it.each([
    {label: "沿用焦点", baseReference: undefined},
    {label: "按回执引用", baseReference: "retry_reference"},
  ])("下一轮继承重试按当时原句重新匹配，用户无需重述（$label）", async ({baseReference}) => {
    const {f, request, first, matchMetricQuestion} = await failingOnce();
    const retry = {...request, originalMessage: "再试一次", requestId: "retry", operationId: "retry"};
    delete (retry as {metricMentions?: unknown}).metricMentions;
    const next = receiptJson(await runTool(createResolveBusinessTurnTool(), {fieldChanges: [], executionMode: "execute",
      ...(baseReference ? {baseReference: first.retry_reference as {frameId: string}} : {})}, retry));
    expect(next.status).toBe("READY");
    expect((await f.store.get(String(next.frameId)))?.fields.metrics).toMatchObject({resolvedValue: {codes: ["FULL"]}});
    expect(matchMetricQuestion).toHaveBeenLastCalledWith(question);
  });
});

describe("执行结果丢失后的对账", () => {
  afterEach(() => { vi.useRealTimers(); });
  const nextTurn = (request: Awaited<ReturnType<typeof toolFixture>>["request"]) =>
    ({...request, originalMessage: "刚才的结果呢", requestId: "turn-2", operationId: "turn-2"});
  const followUp = {fieldChanges: [], executionMode: "execute" as const};

  /** 首轮执行在后端响应前中断，Frame 停在 executing；随后时钟越过宽限期。 */
  async function interrupted(error: unknown = new BackendApiError(503, "synthetic unavailable")) {
    const f = await toolFixture();
    const getBasicQueryStatus = vi.fn();
    Object.assign(f.backend, {getBasicQueryStatus});
    f.backend.basicQueries.mockRejectedValueOnce(error);
    const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
    const receipt = await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(Date.now() + 5 * 60_000);
    return {f, ready, receipt, getBasicQueryStatus};
  }
  const latest = async (f: Awaited<ReturnType<typeof toolFixture>>) => (await f.store.list()).at(-1)!;
  const sentKey = (f: Awaited<ReturnType<typeof toolFixture>>) => (f.backend.basicQueries.mock.calls[0] as unknown[])[1];

  it("结果未知时保持 executing，回执带 frameId 供同轮重试，并已登记幂等键", async () => {
    const {f, ready, receipt} = await interrupted();
    expect(receipt.details).toMatchObject({status: "error", retryable: true, frame_id: ready.frameId});
    const executing = await latest(f);
    expect(executing.status).toBe("executing");
    expect(await f.request.businessResults!.executionLink(executing.frameId)).toMatchObject({
      tool: "metric_query_structured", conversationId: "conversation-synthetic",
      idempotencyKey: sentKey(f),
    });
  });

  it("查询成功后读取任务遇到令牌过期，不把已成功的查询记成失败", async () => {
    const f = await toolFixture();
    f.backend.getTask.mockRejectedValueOnce(new BackendApiError(401, "expired"));
    const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
    const receipt = await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
    expect(receipt.details).toMatchObject({status: "error", retryable: false, error_code: "BACKEND_401"});
    expect((await latest(f)).status).toBe("executing");
  });

  it("下一轮回查到成功：补写结果引用，可直接复用结果，不重发查询", async () => {
    const {f, getBasicQueryStatus} = await interrupted();
    getBasicQueryStatus.mockResolvedValue({task_id: "task-9", version: 2, status: "succeeded", result_id: "result-9"});
    const reuse = receiptJson(await runTool(createResolveBusinessTurnTool(), {fieldChanges: [], executionMode: "reuse_result"}, nextTurn(f.request)));
    expect(reuse.status).toBe("REUSE_RESULT");
    expect(reuse.resultRef).toBe("query:task-9:result-9");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    const [key, conversation] = getBasicQueryStatus.mock.calls[0]!;
    expect([key, conversation]).toEqual([sentKey(f), "conversation-synthetic"]);
  });

  it.each([
    {label: "后端从未收到", lookup: () => Promise.reject(new BackendApiError(404, "missing", "BASIC_QUERY_NOT_FOUND")), code: "NOT_SUBMITTED"},
    {label: "后端已中断", lookup: async () => ({task_id: "t", version: 2, status: "interrupted", error_code: "QUERY_EXECUTION_INTERRUPTED"}), code: "QUERY_EXECUTION_INTERRUPTED"},
  ])("下一轮回查到未执行成功（$label）：记为失败，条件可直接继承重跑", async ({lookup, code}) => {
    const {f, getBasicQueryStatus} = await interrupted();
    getBasicQueryStatus.mockImplementation(lookup);
    const next = receiptJson(await runTool(createResolveBusinessTurnTool(), followUp, nextTurn(f.request)));
    expect((await f.store.list()).some(frame => frame.status === "failed" && frame.errorCode === code)).toBe(true);
    expect(next.status).toBe("READY");
  });

  it("后端确认业务失败：记为失败并按原规则要求用户确认后重跑", async () => {
    const {f, getBasicQueryStatus} = await interrupted();
    getBasicQueryStatus.mockResolvedValue({task_id: "t", version: 2, status: "failed", error_code: "QUERY_PLAN_INVALID"});
    const next = receiptJson(await runTool(createResolveBusinessTurnTool(), followUp, nextTurn(f.request)));
    expect((await f.store.list()).some(frame => frame.errorCode === "QUERY_PLAN_INVALID")).toBe(true);
    expect(next.status).toBe("NEEDS_CLARIFICATION");
  });

  it.each([
    {label: "仍在执行", lookup: async () => ({task_id: "t", version: 1, status: "running"})},
    {label: "回查暂不可用", lookup: () => Promise.reject(new BackendApiError(503, "unavailable"))},
    {label: "后端尚未提供回查接口", lookup: () => Promise.reject(new BackendApiError(404, "Not Found"))},
  ])("下一轮仍无法确认（$label）：保持 executing，并明确提示上一次查询仍在执行", async ({lookup}) => {
    const {f, getBasicQueryStatus} = await interrupted();
    getBasicQueryStatus.mockImplementation(lookup);
    const next = receiptJson(await runTool(createResolveBusinessTurnTool(), followUp, nextTurn(f.request)));
    expect(next.status).toBe("NEEDS_CLARIFICATION");
    expect(JSON.stringify(next.issues)).toContain("pending_execution");
    expect((await f.store.list()).filter(frame => frame.status === "executing")).toHaveLength(1);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });

  it("宽限期内不回查：请求可能仍在途，不据 404 判定未提交", async () => {
    const {f, getBasicQueryStatus} = await interrupted();
    vi.useRealTimers();
    await runTool(createResolveBusinessTurnTool(), followUp, nextTurn(f.request));
    expect(getBasicQueryStatus).not.toHaveBeenCalled();
    expect((await f.store.list()).filter(frame => frame.status === "executing")).toHaveLength(1);
  });

  it("没有幂等键登记的遗留执行（请求未发出或升级前记录）记为中断，可继承重跑", async () => {
    const f = await toolFixture();
    Object.assign(f.backend, {getBasicQueryStatus: vi.fn()});
    const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
    await f.service.beginExecution(String(ready.frameId), f.identity);
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const next = receiptJson(await runTool(createResolveBusinessTurnTool(), followUp, nextTurn(f.request)));
    expect((await f.store.list()).some(frame => frame.errorCode === "EXECUTION_INTERRUPTED")).toBe(true);
    expect(next.status).toBe("READY");
  });
});

it("主题切换重新规划但保留机构日期，不能继承贷款指标当存款", async () => {
  const f = await fixture();
  const first = await f.service.resolve({capabilityHint: "business_overview", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "plan", operation: "set", rawValue: {topic: "loan", goal: "overview", sections: ["scale", "growth", "structure", "quality"], metric_ids: ["total", "discount"]}},
      {fieldHint: "organizations", operation: "set", rawValue: "样本机构甲"},
      {fieldHint: "time", operation: "set", rawValue: "2026年2月28日"}]}, f.identity,
    {...f.context, originalMessage: "样本机构甲2026年2月28日贷款情况"});
  expect(first.status).toBe("ready");
  const identity = {...f.identity, turnId: "switch", requestId: "switch"};
  const context = {...f.context, originalMessage: "存款呢？", turnId: "switch"};
  await expect(f.service.resolve({capabilityHint: "business_overview", baseReference: null, executionMode: "execute", fieldChanges: [
    {fieldHint: "plan", operation: "set", rawValue: {topic: "deposit", goal: "overview", sections: ["scale", "growth", "structure"], metric_ids: ["total"]}}]}, identity, context)).rejects.toThrow("OVERVIEW_CONTINUATION_REQUIRES_BASE");
  expect((await f.store.state()).focusFrameId).toBe(first.frameId);
  await expect(f.service.resolve({baseReference: "current", executionMode: "execute", fieldChanges: []}, identity, context)).rejects.toThrow("ANALYSIS_TOPIC_CHANGED");
  const next = await f.service.resolve({baseReference: "current", executionMode: "execute", fieldChanges: [
    {fieldHint: "plan", operation: "set", rawValue: {goal: "overview", sections: ["scale", "growth", "structure"], metric_ids: ["total", "personal"]}}]}, identity, context);
  expect(next.status).toBe("ready");
  expect(next.fields.plan?.resolvedValue).toMatchObject({topic: "deposit", metric_ids: ["total", "personal"]});
  expect(next.fields.time?.resolvedValue).toEqual(first.fields.time?.resolvedValue);
  expect(next.fields.organizations?.resolvedValue).toEqual(first.fields.organizations?.resolvedValue);
});

it("补查引用不存在指标在保存前退回纠错，成功焦点保持可继承", async () => {
  const f = await fixture();
  const context = {...f.context, originalMessage: "最近存款怎么样？", validateOverviewPlan: async (plan: {metric_ids?: string[]}) => {
    if (plan.metric_ids?.includes("company_ytd")) {
      const {BusinessInputError} = await import("../../src/business-context/inputError.js");
      throw new BusinessInputError("ANALYSIS_METRIC_INVALID", "plan", "不存在的主题指标ID");
    }
  }};
  const plan = {topic: "deposit", goal: "overview", sections: ["scale", "growth", "structure"], metric_ids: ["total", "company"]};
  const first = await f.service.resolve({capabilityHint: "business_overview", baseReference: null, executionMode: "execute",
    fieldChanges: [{fieldHint: "plan", operation: "set", rawValue: plan}]}, f.identity, context);
  const before = await f.store.state();
  await expect(f.service.resolve({baseReference: "current", executionMode: "execute", fieldChanges: [
    {fieldHint: "plan", operation: "set", rawValue: {...plan, metric_ids: ["company_ytd"]}}]},
    {...f.identity, turnId: "followup", requestId: "bad"}, context)).rejects.toThrow("ANALYSIS_METRIC_INVALID");
  expect((await f.store.state()).focusFrameId).toBe(before.focusFrameId);
  const corrected = await f.service.resolve({baseReference: "current", executionMode: "execute", fieldChanges: [
    {fieldHint: "plan", operation: "set", rawValue: {...plan, metric_ids: ["company"]}}]},
    {...f.identity, turnId: "followup", requestId: "corrected"}, context);
  expect(corrected.status).toBe("ready");
  expect(corrected.parentFrameId).toBe(first.frameId);
});
});
