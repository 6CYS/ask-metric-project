import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {modelFields} from "../../src/business-context/modelView.js";
import type {BusinessFrame, ContextDelta, ResolverContext} from "../../src/business-context/types.js";
import {BackendApiError, type BackendClient} from "../../src/backendClient.js";
import {createExecuteBusinessFrameTool} from "../../src/tools/businessContext.js";
import {createResolveTurnShim} from "./resolveTurnShim.js";
import {MemoryCommandBridge, receiptJson, runTool as executeTool, testRequestContext} from "../../src/tools/testUtils.js";
import {BusinessInputError} from "../../src/business-context/inputError.js";
import {toContextDelta} from "../../src/business-context/turnArgs.js";

describe("查询意图V2回归", () => {
const createResolveBusinessTurnTool = () => createResolveTurnShim();

/** 两种Schema均覆盖真实准备顺序；内部Delta缺省语义不补成模型要求的显式来源。 */
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
    // 保留服务层的来源省略与能力继承；内部 Delta 不补成显式模型参数。
    if (params && typeof params === "object"
      && Object.hasOwn(params, "capabilityHint") && Object.hasOwn(params, "baseReference")) {
      const prepared = candidate.prepareArguments?.(params as Record<string, unknown>) ?? params;
      return executeTool(tool, prepared, request, context);
    }
  }
  return executeTool(tool, params, request, context);
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
const scope = {kind: "authorized_cohort" as const, cohort: "rural_commercial_banks" as const};
const scopeInput = {...scope, sourceText: "各家农商行"};
const question = "查询2026年4月末各家农商行信贷客户数量当日数前3名";
async function fixture() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "query-v2-"));
  const sessions = new NativeSessionStore(path); const session = await sessions.create("synthetic-user");
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const identity = {sessionId: session.metadata.id, turnId: "turn-v2", requestId: "request-v2"};
  const backend = {
    resolveBusinessField: vi.fn(async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date"
      ? {start: "2026-04-30", end: "2026-04-30"} : {codes: ["metric-1"], names}})),
    resolveOrganizationScope: vi.fn(async () => ({status: "resolved", value: {codes: ["bank-1", "bank-2", "bank-3", "bank-4"], names: ["甲", "乙", "丙", "丁"], scope, scope_fingerprint: "a".repeat(64)}})),
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "conversation-1"})),
    basicQueries: vi.fn(async () => ({result: {status: "succeeded", task_id: "task-1", columns: [], rows: [], row_count: 0}})),
    getTask: vi.fn(async () => ({version: 1, result: {result_id: "result-1"}})),
  };
  const request = testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    sessionId: identity.sessionId, operationId: identity.turnId, requestId: identity.requestId, originalMessage: question, frames: store,
  });
  const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: "信贷客户数量当日数"},
    {fieldHint: "organizations", operation: "set", rawValue: scopeInput},
    {fieldHint: "time", operation: "set", rawValue: "2026年4月末"},
    {fieldHint: "selection", operation: "set", rawValue: "exact"},
    {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "top", top_n: 3}},
  ]};
  const context: ResolverContext = {originalMessage: question, currentDate: "2026-09-22", turnId: identity.turnId,
    resolveCatalog: backend.resolveBusinessField as ResolverContext["resolveCatalog"],
    resolveOrganizationScope: backend.resolveOrganizationScope as NonNullable<ResolverContext["resolveOrganizationScope"]>};
  return {backend, request, delta, service, store, identity, context};
}
it("指定日和排名正交，集合只传范围与指纹，不二次展开或向模型泄露完整编码", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(receipt.status).toBe("READY");
  expect(JSON.stringify(receipt)).not.toContain("bank-1");
  const frame = (await f.store.get(String(receipt.frameId)))!;
  expect(modelFields(frame.fields).organizations?.resolvedValue).toEqual({scope, count: 4});
  await runTool(createExecuteBusinessFrameTool(), {frameId: receipt.frameId}, f.request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const spec = (f.backend.basicQueries.mock.calls as unknown[][])[0]![0];
  expect(spec).toMatchObject({schema_version: 2, selection: "exact", time: {start: "2026-04-30", end: "2026-04-30"},
    organization_scope: scope, scope_fingerprint: "a".repeat(64), operation: {kind: "ranking", position: "top", top_n: 3}});
  expect(spec).not.toHaveProperty("org_codes"); expect(spec).not.toHaveProperty("top_n");
});
it("多个明确月末按离散日期直接执行，不要求重复确认机构和指标", async () => {
  const f = await fixture();
  const input = "紫金农商行2 月末、3 月末、4月末收单客户数量当日数分别是多少？";
  const time = {start: "2026-02-28", end: "2026-04-30",
    dates: ["2026-02-28", "2026-03-31", "2026-04-30"]};
  f.backend.resolveBusinessField.mockImplementation(async (entity, names) => ({status: "resolved",
    value: entity === "date" ? time : {codes: [entity === "metric" ? "M" : "O"], names}}));
  const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: "收单客户数量当日数"},
      {fieldHint: "organizations", operation: "set", rawValue: "紫金农商行"},
      {fieldHint: "time", operation: "set", rawValue: "2 月末、3 月末、4月末"},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ]};
  const request = {...f.request, originalMessage: input};
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(receipt.status).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: receipt.frameId}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect((f.backend.basicQueries.mock.calls as unknown[][])[0]![0]).toMatchObject({
    time, selection: "exact", metric_codes: ["M"], org_codes: ["O"],
  });
});
it("前次参数错误未建立Frame时，retain不能制造缺项澄清", async () => {
  const f = await fixture();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {
    capabilityHint: "metric_query", executionMode: "execute", fieldChanges: [
      {fieldHint: "time", operation: "retain"},
      {fieldHint: "selection", operation: "set", rawValue: "all_in_range"},
    ],
  }, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "NO_BASE_FOR_RETAIN"});
  expect(await f.store.list()).toHaveLength(0);
});
it.each([
  {selection: "latest_in_range", start: "2026-04-30", expected: "exact", ranking: true},
  {selection: "latest_in_range", start: "2026-04-01", expected: "latest_in_range", ranking: true},
  {selection: "latest_in_range", start: "2026-04-30", expected: "exact", ranking: false},
  {selection: "all_in_range", start: "2026-04-30", expected: "all_in_range", ranking: false},
])("执行边界规范化单日 latest，保留区间及完整序列语义：$selection/$start/$ranking", async ({selection, start, expected, ranking}) => {
  const f = await fixture();
  f.backend.resolveBusinessField.mockImplementation(async (entity, names) => ({status: "resolved", value: entity === "date"
    ? {start, end: "2026-04-30"} : {codes: ["metric-1"], names}}));
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "selection"
    ? {...change, rawValue: selection} : change.fieldHint === "operation" && !ranking
      ? {...change, rawValue: {kind: "value"}} : change)};
  const request = {...f.request, originalMessage: ranking ? question : question.replace("前3名", "")};
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, request));
  expect(receipt.status).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: receipt.frameId}, f.request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const spec = (f.backend.basicQueries.mock.calls as unknown[][])[0]![0];
  expect(spec).toMatchObject({selection: expected, time: {start, end: "2026-04-30"},
    operation: ranking ? {kind: "ranking", position: "top", top_n: 3} : {kind: "value"}});
  expect((await f.store.get(String(receipt.frameId)))!.fields.selection?.resolvedValue).toBe(selection);
});
it("换月份继承集合与排名，取消排名只需value，新问题不继承旧排名", async () => {
  const f = await fixture(); await f.service.resolve(f.delta, f.identity, f.context);
  const next = await f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "5月末"}]},
    {...f.identity, turnId: "t2", requestId: "r2"}, {...f.context, turnId: "t2", originalMessage: "改成5月末"});
  expect(next.fields.operation?.resolvedValue).toEqual({kind: "ranking", position: "top", top_n: 3});
  expect(next.fields.organizations?.source).toBe("inherited");
  const plain = await f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "operation", operation: "set", rawValue: {kind: "value"}}]},
    {...f.identity, turnId: "t3", requestId: "r3"}, {...f.context, turnId: "t3", originalMessage: "不排名全部列出"});
  expect(plain.fields.operation?.resolvedValue).toEqual({kind: "value"});
  const independent = await f.service.resolve({...f.delta, fieldChanges: f.delta.fieldChanges.filter(c => c.fieldHint !== "operation")},
    {...f.identity, turnId: "t4", requestId: "r4"}, {...f.context, originalMessage: question.replace("前3名", "")});
  expect(independent.fields.operation?.resolutionStatus).toBe("missing"); expect(independent.status).toBe("ready");
});
it.each([
  {fieldHint: "organizations", operation: "set" as const, rawValue: {...scopeInput, sourceText: "所有支行"}},
  {fieldHint: "operation", operation: "set" as const, rawValue: {kind: "value", top_n: 3}},
  // 旧契约的数值方向 order 已被 position 取代：名次类指标方向由服务端决定。
  {fieldHint: "operation", operation: "set" as const, rawValue: {kind: "ranking", order: "desc", top_n: 3}},
  {fieldHint: "selection", operation: "set" as const, rawValue: "ranking"},
  {fieldHint: "top_n", operation: "set" as const, rawValue: 3},
])("非法或旧协议参数不覆盖焦点：$fieldHint", async change => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldChanges: [...f.delta.fieldChanges.filter(c => c.fieldHint !== change.fieldHint), change]}, {...f.request, requestId: "invalid"}));
  expect(result.status).toBe("ARGUMENT_ERROR"); expect((await f.store.state()).focusFrameId).toBe(ready.frameId);
});
it("内部参数冲突即使同时缺指标也不变成用户澄清", async () => {
  const f = await fixture();
  f.backend.resolveBusinessField.mockImplementation(async entity => entity === "date"
    ? {status: "resolved", value: {start: "2026-04-01", end: "2026-04-30"}} as never
    : {status: "not_found"} as never);
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_COMBINATION_INVALID"});
  expect((await f.store.state()).focusFrameId).toBeUndefined();
});
it.each(["CONFIGURATION_ERROR", "PERMISSION_DENIED", "EMPTY_AUTHORIZED_SCOPE"])("范围%s不伪装为缺机构", async code => {
  const f = await fixture(); f.backend.resolveOrganizationScope.mockRejectedValue(new BackendApiError(422, "scope unavailable", code));
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(receipt).toMatchObject({status: "error", error_code: code}); expect(await f.store.list()).toHaveLength(0);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("具体未知机构被误填集合时纠正模型参数，不扩大范围或覆盖已有焦点", async () => {
  const f = await fixture();
  const ready = await f.service.resolve(f.delta, f.identity, f.context);
  f.backend.resolveOrganizationScope.mockRejectedValue(new BackendApiError(422, "invalid source", "SCOPE_SOURCE_INVALID"));
  const unknown = "合成不存在农商行";
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(change => change.fieldHint === "organizations"
    ? {...change, rawValue: {...scope, sourceText: unknown}} : change)};
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), delta,
    {...f.request, requestId: "bad-scope", originalMessage: question.replace("各家农商行", unknown)}));
  expect(receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "SCOPE_SOURCE_INVALID", field: "organizations", focus_preserved: true});
  expect((await f.store.state()).focusFrameId).toBe(ready.frameId);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("临时故障保存可重试draft但不抢已确定焦点", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  f.backend.resolveBusinessField.mockRejectedValueOnce(new Error("synthetic unavailable"));
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, {...f.request, requestId: "temporary"}));
  expect(receipt.status).toBe("TEMPORARY_ERROR"); expect((await f.store.state()).focusFrameId).toBe(ready.frameId);
  const next = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: receipt.retry_reference,
    executionMode: "execute", fieldChanges: []}, {...f.request, requestId: "retry", operationId: "retry", originalMessage: "重试"}));
  expect(next.status).toBe("READY");
});
it("能力字段输入Schema公开完整scope/operation约束，覆盖能力不承诺集合支持", () => {
  const capabilities = createCapabilities();
  expect(JSON.stringify(capabilities.get("metric_query"))).toContain("authorized_cohort");
  expect(JSON.stringify(capabilities.get("metric_query").fields.operation)).toContain("top_n");
  expect(JSON.stringify(capabilities.get("data_availability"))).not.toContain("authorized_cohort");
});
it("旧排名Frame不能按新契约续跑，原焦点仍可供只读审计", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  const legacy: BusinessFrame = {...ready, frameId: "legacy", operationFrameId: "legacy", fields: {...ready.fields,
    selection: {resolutionStatus: "resolved", source: "explicit", resolvedValue: "ranking"}}};
  await f.store.save(legacy, (await f.store.state()).version, "legacy");
  await expect(f.service.resolve({executionMode: "execute", fieldChanges: []}, {...f.identity, requestId: "retry"}, f.context)).rejects.toThrow("LEGACY_QUERY_REQUIRES_NEW_TURN");
  await expect(f.service.beginExecution(legacy.frameId, f.identity)).rejects.toThrow("LEGACY_QUERY_REQUIRES_NEW_TURN");
  expect((await f.store.state()).focusFrameId).toBe("legacy");
});
it("父机构同名候选必须下一轮确认，确认后仍解析下级集合而非退化为父机构取值", async () => {
  const f = await fixture();
  const raw = {kind: "children_of" as const, parentName: "样本农商行", sourceText: "样本农商行下属支行"};
  const backendScope = vi.fn().mockResolvedValueOnce({status: "ambiguous", candidates: [{value: "样本农商行", code: "parent-a"}]})
    .mockResolvedValue({status: "resolved", value: {codes: ["child-a"], names: ["样本支行"], scope: {kind: "children_of", parent_code: "parent-a"}, scope_fingerprint: "a".repeat(64)}});
  const context = {...f.context, originalMessage: `查询2026年4月末${raw.sourceText}信贷客户数量当日数前3名`, resolveOrganizationScope: backendScope};
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(c => c.fieldHint === "organizations" ? {...c, rawValue: raw} : c)};
  const first = await f.service.resolve(delta, f.identity, context);
  expect(first.status).toBe("clarifying");
  await expect(f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {candidateIndex: 1}}]},
    {...f.identity, requestId: "same"}, context)).rejects.toThrow("CONFIRMATION_REQUIRES_USER_TURN");
  const next = await f.service.resolve({executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {candidateIndex: 1}}]},
    {...f.identity, turnId: "next", requestId: "next"}, {...context, turnId: "next", originalMessage: "选第一个"});
  expect(backendScope).toHaveBeenLastCalledWith({...raw, parentName: "parent-a"});
  expect(next.fields.organizations?.resolvedValue).toMatchObject({scope: {kind: "children_of", parent_code: "parent-a"}});
  expect(next.status).toBe("ready");
  const inherited = await f.service.resolve({executionMode: "execute", fieldChanges: []},
    {...f.identity, turnId: "again", requestId: "again"}, {...context, turnId: "again", originalMessage: "按原条件重试"});
  expect(inherited.status).toBe("ready");
  expect(backendScope).toHaveBeenLastCalledWith({...raw, parentName: "parent-a"});
});
it("集合不静默流入尚未治理范围指纹的数据覆盖能力", async () => {
  const f = await fixture(); const ready = await f.service.resolve(f.delta, f.identity, f.context);
  await expect(f.service.resolve({capabilityHint: "data_availability", executionMode: "execute", fieldChanges: [{fieldHint: "dimension", operation: "set", rawValue: "metrics"}]},
    {...f.identity, turnId: "coverage", requestId: "coverage"}, {...f.context, turnId: "coverage", originalMessage: "这些机构有哪些数据"})).rejects.toThrow("UNSUPPORTED_ORGANIZATION_SCOPE");
  expect((await f.store.state()).focusFrameId).toBe(ready.frameId);
});

it("用户原文包含无效日期时需要业务澄清，不当作模型字段组合错误", async () => {
  const f = await fixture();
  f.backend.resolveBusinessField.mockImplementation(async entity => entity === "date" ? {status: "invalid"} as never
    : {status: "resolved", value: {codes: ["M"], names: ["信贷客户数量当日数"]}});
  const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.map(c => c.fieldHint === "time" ? {...c, rawValue: "2026年2月30日"} : c)};
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, {...f.request, originalMessage: question.replace("2026年4月末", "2026年2月30日")}));
  expect(result.status).toBe("NEEDS_CLARIFICATION"); expect(result.issues).toContainEqual({field: "time", reason: "invalid"});
});
it("执行前范围失效后重建Frame并刷新指纹，不死循环复用过期范围", async () => {
  const f = await fixture();
  f.backend.basicQueries.mockRejectedValueOnce(new BackendApiError(409, "scope changed", "SCOPE_CHANGED"));
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  const failed = await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
  expect(failed.details.error_code).toBe("SCOPE_CHANGED");
  expect((await f.store.list()).at(-1)).toMatchObject({status: "failed", errorCode: "SCOPE_CHANGED"});
  f.backend.resolveOrganizationScope.mockResolvedValue({status: "resolved", value: {codes: ["bank-1"], names: ["甲"], scope, scope_fingerprint: "b".repeat(64)}});
  const refreshed = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: []},
    {...f.request, requestId: "scope-retry", operationId: "scope-retry", originalMessage: "按原条件重试"}));
  expect(refreshed.status, JSON.stringify(refreshed)).toBe("READY");
  await runTool(createExecuteBusinessFrameTool(), {frameId: refreshed.frameId}, {...f.request, requestId: "scope-retry", operationId: "scope-retry"});
  const specs = (f.backend.basicQueries.mock.calls as unknown[][]).map(call => call[0]);
  expect(specs[0]).toMatchObject({scope_fingerprint: "a".repeat(64)});
  expect(specs[1]).toMatchObject({scope_fingerprint: "b".repeat(64), operation: {kind: "ranking", position: "top", top_n: 3}});
});
it("范围解析器返回无效指纹时拒绝执行且不存伪READY", async () => {
  const f = await fixture();
  f.backend.resolveOrganizationScope.mockResolvedValue({status: "resolved", value: {codes: ["bank-1"], names: ["甲"], scope, scope_fingerprint: "bad"}});
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(receipt).toMatchObject({status: "error", error_code: "INVALID_RESOLVER_RESPONSE"});
  expect(await f.store.list()).toHaveLength(0); expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("同轮相同Delta在SCOPE_CHANGED后重新准备，随后重复调用仍复用新Frame", async () => {
  const f = await fixture();
  f.backend.basicQueries.mockRejectedValueOnce(new BackendApiError(409, "scope changed", "SCOPE_CHANGED"));
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  await runTool(createExecuteBusinessFrameTool(), {frameId: first.frameId}, f.request);
  f.backend.resolveOrganizationScope.mockResolvedValue({status: "resolved", value: {codes: ["bank-1"], names: ["甲"], scope, scope_fingerprint: "b".repeat(64)}});
  const refreshed = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(refreshed.status).toBe("READY"); expect(refreshed.frameId).not.toBe(first.frameId);
  const repeated = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  expect(repeated.frameId).toBe(refreshed.frameId);
  await runTool(createExecuteBusinessFrameTool(), {frameId: refreshed.frameId}, f.request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  expect((f.backend.basicQueries.mock.calls as unknown[][])[1]![0]).toMatchObject({scope_fingerprint: "b".repeat(64)});
});

it.each(["execute", "resolve_more"] as const)("真实日期缺失时暂缓内部selection，保存条件且禁止执行：%s", async executionMode => {
  const f = await fixture();
  const noSelectionOrDate = {...f.delta, executionMode,
    fieldChanges: f.delta.fieldChanges.filter(c => !["selection", "time"].includes(c.fieldHint))};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), noSelectionOrDate,
    {...f.request, originalMessage: "查询各家农商行信贷客户数量当日数前3名"}));
  expect(first).toMatchObject({status: "NEEDS_CLARIFICATION", issues: [{field: "time", reason: "missing"}]});
  const saved = (await f.store.get(String(first.frameId)))!;
  expect(saved.status).toBe("clarifying");
  expect(saved.fields.metrics?.resolvedValue).toMatchObject({codes: ["metric-1"]});
  expect(saved.fields.organizations?.resolvedValue).toMatchObject({scope});
  expect(saved.fields.operation?.resolvedValue).toEqual({kind: "ranking", position: "top", top_n: 3});
  expect(saved.fields.selection?.resolutionStatus).toBe("missing");
  expect((await f.store.state()).focusFrameId).toBe(first.frameId);
  await expect(f.service.beginExecution(String(first.frameId), f.identity)).rejects.toThrow("FRAME_NOT_EXECUTABLE");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();

  const nextRequest = {...f.request, operationId: "date-followup", requestId: "date-followup", originalMessage: "2026年4月末"};
  const withDate: ContextDelta = {executionMode: "execute", fieldChanges: [
    {fieldHint: "time", operation: "set", rawValue: "2026年4月末"},
  ]};
  const complete = receiptJson(await runTool(createResolveBusinessTurnTool(), withDate, nextRequest));
  expect(complete.status).toBe("READY");
  const completed = (await f.store.get(String(complete.frameId)))!;
  expect(completed.fields.selection?.resolvedValue).toBe("exact");
  expect(completed.fields.metrics?.resolvedValue).toEqual(saved.fields.metrics?.resolvedValue);
  expect(completed.fields.organizations?.resolvedValue).toEqual(saved.fields.organizations?.resolvedValue);
  expect(completed.fields.operation?.resolvedValue).toEqual(saved.fields.operation?.resolvedValue);
  expect((await f.store.state()).focusFrameId).toBe(complete.frameId);
  await runTool(createExecuteBusinessFrameTool(), {frameId: complete.frameId}, nextRequest);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("业务日期缺失也不能掩盖显式非法的内部枚举", async () => {
  const f = await fixture();
  const delta = {...f.delta, executionMode: "resolve_more" as const,
    fieldChanges: f.delta.fieldChanges.filter(change => change.fieldHint !== "time").map(change =>
      change.fieldHint === "selection" ? {...change, rawValue: "ranking"} : change)};
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, f.request));
  expect(receipt).toMatchObject({status: "ARGUMENT_ERROR", field: "selection"});
  expect((await f.store.state()).focusFrameId).toBeUndefined();
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
});
