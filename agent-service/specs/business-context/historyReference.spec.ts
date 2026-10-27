import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {createReadBusinessResultTool} from "../../src/tools/businessContext.js";
import {createResolveTurnShim as createResolveBusinessTurnTool} from "./resolveTurnShim.js";
import {createMetricReadTool, createReadTool} from "../../src/tools/readTools.js";
import {BackendApiError} from "../../src/backendClient.js";
import {MemoryCommandBridge, receiptJson, runTool as executeTool, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import type {BusinessFrame, BusinessSessionState, ContextDelta, FieldResolution, FrameSelector, HistoryFieldReferenceInput} from "../../src/business-context/types.js";
import type {AskMetricRequestContext} from "../../src/requestContext.js";
import {historicalOperations, inheritableFrame, resolveFrame} from "../../src/business-context/core.js";
import {modelFields} from "../../src/business-context/modelView.js";
import {toContextDelta} from "../../src/business-context/turnArgs.js";

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
  const candidate = tool as ReturnType<typeof createResolveBusinessTurnTool>;
  return executeTool(tool, candidate.name === "resolve_business_turn" ? await fixtureFieldIntents(params, request) : params, request, context);
}


/** 已退役读取工具的测试替身：同一 resolveFrame/焦点门禁/分页语义，直接驱动公共函数。 */
async function readContext(request: AskMetricRequestContext, params: {frameId?: string; selector?: FrameSelector; setFocus?: boolean; offset?: number; limit?: number}) {
  const store = request.frames!;
  const state = await store.state();
  const allFrames = await store.list();
  const operationIds = historicalOperations(state, allFrames, request.operationId);
  if (params.selector || params.frameId || params.setFocus) {
    if (params.selector && params.frameId || params.setFocus && !params.selector && !params.frameId) {
      return {status: "ARGUMENT_ERROR", error_code: "FRAME_SELECTOR_REQUIRED"};
    }
    const resolution = resolveFrame(params.selector ?? {frameId: params.frameId!}, state, allFrames, request.operationId);
    if (resolution.status !== "resolved") return {...resolution, frame: null, focusFrameId: state.focusFrameId};
    const frame = (await store.get(resolution.frameId!))!;
    const setFocus = params.setFocus !== false;
    if (setFocus) {
      if (!inheritableFrame(frame) || frame.status === "executing" || frame.issues.some(issue => issue.field === "$base")) {
        return {status: "ARGUMENT_ERROR", error_code: "INVALID_FOCUS_FRAME"};
      }
      await store.setFocus(frame.frameId, state.version);
    }
    return {status: "resolved", frame,
      ordinal: operationIds.indexOf(state.operations[frame.operationFrameId]!) + 1 || null, latestOrdinal: operationIds.length,
      focusFrameId: setFocus ? frame.frameId : state.focusFrameId, baseReference: {frameId: frame.frameId}};
  }
  const offset = params.offset ?? Math.max(0, operationIds.length - 10);
  const ids = operationIds.slice(offset, offset + (params.limit ?? 10));
  const frames = await Promise.all(ids.map(async (id, index) => ({ordinal: offset + index + 1, frame: await store.get(id)})));
  return {version: state.version, focusFrameId: state.focusFrameId, frames,
    next_offset: offset + ids.length < operationIds.length ? offset + ids.length : null};
}

/** 已退役历史索引投影的测试替身：与历史操作同一来源，只保留序号、引用与条件字段。 */
async function historyIndex(store: NativeFrameStore, state: BusinessSessionState, currentTurnId: string) {
  const frames = await store.list();
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  const operations = historicalOperations(state, frames, currentTurnId);
  const offset = Math.max(0, operations.length - 10);
  const indexes = operations.slice(offset).map((_, index) => offset + index);
  const entries = indexes.map(index => {
    const frame = byId.get(operations[index]!);
    return frame ? {ordinal: index + 1, frameId: frame.frameId, capability: frame.capability, status: frame.status,
      fields: modelFields(frame.fields)} : {ordinal: index + 1, unavailable: true};
  });
  const focus = state.focusFrameId ? byId.get(state.focusFrameId) : undefined;
  const focusIndex = focus ? operations.indexOf(state.operations[focus.operationFrameId]!) : -1;
  return {total: operations.length, latestOrdinal: operations.length || null, focusOrdinal: focusIndex < 0 ? null : focusIndex + 1,
    entries, partial: entries.length < operations.length, currentTurnExcluded: true};
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});

async function fixture(count = 3) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "frame-history-"));
  const sessions = new NativeSessionStore(dir);
  const session = await sessions.create("synthetic-history");
  cleanup.push(async () => {await sessions.close(); rmSync(dir, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const resolveCatalog = async (entity: string, raw: string[]): Promise<FieldResolution> => ({status: "resolved",
    value: entity === "date" ? {start: raw[0], end: raw[0]} : {codes: raw.map(name => name.startsWith(`${entity}:`) ? name : `${entity}:${name}`), names: raw.map(name => name.startsWith(`${entity}:`) ? name.slice(entity.length + 1) : name)}});
  const saved: BusinessFrame[] = [];
  for (let i = 1; i <= count; i++) {
    const identity = {sessionId: session.metadata.id, requestId: `seed-${i}`, turnId: `seed-${i}`};
    const metrics = i === 1 ? ["合成指标甲", "合成指标乙"] : [`合成指标${i}`];
    const date = `2026-${String(i).padStart(2, "0")}-01`;
    const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: metrics},
      {fieldHint: "organizations", operation: "set", rawValue: `合成机构${i}`},
      {fieldHint: "time", operation: "set", rawValue: date},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ]};
    const ready = await service.resolve(delta, identity, {originalMessage: `${metrics.join(" ")} 合成机构${i} ${date}`,
      turnId: identity.turnId, currentDate: "2026-09-28", resolveCatalog});
    const executing = await service.beginExecution(ready.frameId, identity);
    saved.push(await service.finishExecution(executing, {status: "success", resultRef: `query:t${i}:r${i}`}));
  }
  const backend = {resolveBusinessField: resolveCatalog, basicQueries: vi.fn()} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {frames: store,
    sessionId: session.metadata.id, operationId: "modify", requestId: "modify", originalMessage: "更换为合成机构新"});
  const change: ContextDelta = {capabilityHint: "metric_query", executionMode: "execute",
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成机构新"}]};
  return {sessions, session, store, service, saved, backend, request, change};
}

it.each([1, 2, 3])("任意历史序号 %i 均可替换字段，保留该来源的全部指标和日期", async ordinal => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: {ordinal}}, f.request));
  expect(receipt.status).toBe("READY");
  const frame = (await f.store.get(String(receipt.frameId)))!;
  const source = f.saved[ordinal - 1]!;
  expect(frame.parentFrameId).toBe(source.frameId);
  for (const name of ["metrics", "time", "selection"]) {
    expect(frame.fields[name]?.resolvedValue).toEqual(source.fields[name]?.resolvedValue);
    expect(frame.fields[name]?.sourceFrameId).toBe(source.frameId);
  }
  expect(frame.fields.organizations?.resolvedValue).toEqual({codes: ["organization:合成机构新"], names: ["合成机构新"]});
  expect(await f.store.get(source.frameId)).toEqual(source);
});

it("模型调用必须显式选择来源；current 保留普通续接能力", async () => {
  const f = await fixture();
  const tool = createResolveBusinessTurnTool();
  const args = await fixtureFieldIntents({...f.change, baseReference: "current"}, f.request) as Record<string, unknown>;
  const result = receiptJson(await runTool(tool, args, f.request));
  const frame = (await f.store.get(String(result.frameId)))!;
  expect(frame.parentFrameId).toBe(f.saved[2]!.frameId);
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[2]!.fields.time?.resolvedValue);
});

it("current 选定后参数错误保留确切引用，空会话不能伪造当前来源", async () => {
  const f = await fixture();
  const before = await f.store.state();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [{fieldHint: "unknown", operation: "set", rawValue: "x"}]}, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", retry_reference: {frameId: f.saved[2]!.frameId}});
  expect(await f.store.state()).toEqual(before);
  const empty = await fixture(0);
  const missing = receiptJson(await runTool(createResolveBusinessTurnTool(), {...empty.change, baseReference: "current"}, empty.request));
  expect(missing).toMatchObject({status: "ARGUMENT_ERROR", error_code: "CURRENT_FOCUS_MISSING"});
  expect(await empty.store.list()).toEqual([]);
});

it("同一回合 current 调用在焦点推进到成功快照后重试仍复用原操作", async () => {
  const f = await fixture();
  const args = await fixtureFieldIntents({...f.change, baseReference: "current"}, f.request);
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), args, f.request));
  const id = {sessionId: f.request.sessionId, turnId: f.request.operationId, requestId: f.request.requestId};
  await f.service.finishExecution(await f.service.beginExecution(String(first.frameId), id),
    {status: "success", resultRef: "query:new:result"});
  const before = await f.store.state();
  const repeated = receiptJson(await runTool(createResolveBusinessTurnTool(), args, f.request));
  expect(repeated.frameId).toBe(first.frameId);
  expect(await f.store.state()).toEqual(before);
});

it.each(["resolve_more", "execute"] as const)("同一次提问准备阶段 %s 到执行不占两笔序号，后续第二笔仍指第二次查询", async mode => {
  const f = await fixture(0);
  const make = (turnId: string, executionMode: "resolve_more" | "execute") => ({
    capabilityHint: "metric_query", baseReference: null, executionMode, fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: turnId === "first" ? ["合成指标甲", "合成指标乙"] : "合成指标丙"},
      {fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
      {fieldHint: "time", operation: "set", rawValue: "2026-04-30"},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ],
  }) as ContextDelta;
  const firstRequest = {...f.request, operationId: "first", requestId: "first", originalMessage: "合成指标甲 合成指标乙 合成机构 2026-04-30"};
  const draft = receiptJson(await runTool(createResolveBusinessTurnTool(), make("first", mode), firstRequest));
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query",
    baseReference: "current", fieldChanges: [], executionMode: "execute"}, firstRequest));
  expect((await f.store.get(String(ready.frameId)))?.operationFrameId).toBe(draft.frameId);
  const id = {sessionId: f.request.sessionId, turnId: "first", requestId: "first"};
  await f.service.finishExecution(await f.service.beginExecution(String(ready.frameId), id), {status: "success", resultRef: "query:first:r"});
  const second = receiptJson(await runTool(createResolveBusinessTurnTool(), make("second", "execute"),
    {...firstRequest, operationId: "second", requestId: "second", originalMessage: "合成指标丙 合成机构 2026-04-30"}));
  const index = await historyIndex(f.store, await f.store.state(), "third");
  expect(index.total).toBe(2);
  const selected = await readContext({...f.request, operationId: "third"}, {selector: {ordinal: 2}});
  expect(selected.baseReference).toEqual({frameId: second.frameId});
  expect(await f.store.get(String(draft.frameId))).toMatchObject({status: "ready"}); // 历史准备快照仍不可变且可回读。
});

it.each([
  {ordinal: 1}, {relativePosition: -2}, {businessConstraints: {time: {start: "2026-01-01"}}},
] satisfies FrameSelector[])("引用方式不同但指向同一Frame时，焦点切换后普通追问统一继承：%j", async selector => {
  const f = await fixture();
  const initial = await f.store.state();
  const inspected = await readContext(f.request, {selector, setFocus: false});
  expect(inspected.status).toBe("resolved");
  expect(await f.store.state()).toEqual(initial); // 单纯浏览不抢焦点。
  const selected = await readContext(f.request, {selector});
  expect(selected).toMatchObject({ordinal: 1, latestOrdinal: 3});
  expect(selected.focusFrameId).toBe(f.saved[0]!.frameId);
  expect((await f.store.state()).frameOrder).toEqual(initial.frameOrder); // 切焦点不占操作序号。
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.change, f.request));
  const frame = (await f.store.get(String(receipt.frameId)))!;
  expect(frame.parentFrameId).toBe(f.saved[0]!.frameId);
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[0]!.fields.metrics?.resolvedValue);
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[0]!.fields.time?.resolvedValue);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("历史来源字段报错后返回固定引用，纠错无需重填历史条件或改用最近操作", async () => {
  const f = await fixture();
  const before = await f.store.state();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: {ordinal: 1},
    fieldChanges: [...f.change.fieldChanges, {fieldHint: "time", operation: "set", rawValue: "2026-01-01"}]}, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", retry_reference: {frameId: f.saved[0]!.frameId}});
  expect(await f.store.state()).toEqual(before);
  const fixed = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: result.retry_reference}, f.request));
  const frame = (await f.store.get(String(fixed.frameId)))!;
  expect(frame.parentFrameId).toBe(f.saved[0]!.frameId);
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[0]!.fields.metrics?.resolvedValue);
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[0]!.fields.time?.resolvedValue);
});

it("省略来源的错误不把当前焦点包装成用户已选择的历史引用", async () => {
  const f = await fixture();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change,
    fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "2026-01-01"}]}, f.request));
  expect(result.status).toBe("ARGUMENT_ERROR");
  expect(result).not.toHaveProperty("retry_reference");
  expect(result.reference_hint).toContain("不代表它就是用户所指来源");
});

it.each([
  {code: "FIELD_CHANGES_INVALID", changes: [{fieldHint: "unknown", operation: "set", rawValue: "x"}]},
  {code: "FIELD_COMBINATION_INVALID", changes: [{fieldHint: "selection", operation: "clear"}]},
] satisfies Array<{code: string; changes: ContextDelta["fieldChanges"]}>)("字段结构或组合错误也保留历史来源：$code", async ({code, changes}) => {
  const f = await fixture();
  const before = await f.store.state();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: {ordinal: 1},
    fieldChanges: [...f.change.fieldChanges, ...changes]}, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: code, retry_reference: {frameId: f.saved[0]!.frameId}});
  expect(await f.store.state()).toEqual(before);
  const fixed = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: result.retry_reference}, f.request));
  expect((await f.store.get(String(fixed.frameId)))?.parentFrameId).toBe(f.saved[0]!.frameId);
});

it("分页浏览保留焦点，其他会话的引用不能被选中或继承", async () => {
  const f = await fixture();
  const other = await fixture();
  const before = await f.store.state();
  const page = await readContext(f.request, {offset: 0, limit: 2});
  expect(page.frames).toHaveLength(2);
  expect(await f.store.state()).toEqual(before);
  const foreign = await readContext(f.request, {frameId: other.saved[0]!.frameId});
  expect(foreign.status).toBe("not_found");
  expect(await f.store.state()).toEqual(before);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([createReadTool, createMetricReadTool])("结果读取入口回到同一历史焦点，下一轮只改机构保留其全部条件：%s", async createTool => {
  const f = await fixture();
  Object.assign(f.backend, {getTaskResult: vi.fn(async () => ({status: "succeeded", task_id: "t1", result_id: "r1",
    rows: [], columns: [], row_count: 0, has_more: false}))});
  const result = await runTool(createTool(), {kind: "result", task_id: "t1", result_id: "r1"}, f.request);
  expect(result.details.status).toBe("succeeded");
  expect((await f.store.state()).focusFrameId).toBe(f.saved[0]!.frameId);
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.change,
    {...f.request, operationId: "after-read", requestId: "after-read"}));
  const frame = (await f.store.get(String(receipt.frameId)))!;
  expect(frame.parentFrameId).toBe(f.saved[0]!.frameId);
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[0]!.fields.metrics?.resolvedValue);
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[0]!.fields.time?.resolvedValue);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each(["inspect", "denied", "mismatch", "unknown"])("结果只检查、权限失败、引用不符或无关联时不抢焦点：%s", async mode => {
  const f = await fixture();
  Object.assign(f.backend, {getTaskResult: vi.fn(async (task_id: string) => {
    if (mode === "denied") throw new BackendApiError(403, "synthetic forbidden");
    return {status: "succeeded", task_id, result_id: mode === "mismatch" ? "other" : "r1", rows: [], columns: [], row_count: 0, has_more: false};
  })});
  const before = await f.store.state();
  await runTool(createReadTool(), {kind: "result", task_id: mode === "unknown" ? "unknown" : "t1", result_id: "r1",
    ...(mode === "inspect" ? {setFocus: false} : {})}, f.request);
  expect(await f.store.state()).toEqual(before);
});

it.each(["read", "read_business_result"])("%s 的慢读取不能覆盖较新的焦点", async name => {
  const f = await fixture();
  Object.assign(f.backend, {getTaskResult: vi.fn(async () => {
    await f.store.setFocus(f.saved[1]!.frameId, (await f.store.state()).version);
    return {status: "succeeded", task_id: "t1", result_id: "r1", rows: [], columns: [], row_count: 0, has_more: false};
  })});
  const result = name === "read"
    ? await runTool(createReadTool(), {kind: "result", task_id: "t1", result_id: "r1"}, f.request)
    : await runTool(createReadBusinessResultTool(), {frameId: f.saved[0]!.frameId}, f.request);
  expect(result.details).toMatchObject({status: "error", error_code: "BUSINESS_CONTEXT_CONFLICT"});
  expect((await f.store.state()).focusFrameId).toBe(f.saved[1]!.frameId);
});

it("专用历史结果只检查时不切焦点，任务状态读取也不切焦点", async () => {
  const f = await fixture();
  Object.assign(f.backend, {
    getTaskResult: vi.fn(async () => ({status: "succeeded", task_id: "t1", result_id: "r1", rows: [], columns: [], row_count: 0, has_more: false})),
    getTask: vi.fn(async () => ({task_id: "t1", status: "SUCCEEDED", version: 1})),
  });
  const before = await f.store.state();
  await runTool(createReadBusinessResultTool(), {frameId: f.saved[0]!.frameId, setFocus: false}, f.request);
  await runTool(createReadTool(), {kind: "task", task_id: "t1"}, f.request);
  expect(await f.store.state()).toEqual(before);
});

it("同轮产生新操作后，历史索引和相对来源仍以本轮开始前为准", async () => {
  const f = await fixture();
  const selected = {...f.change, baseReference: {relativePosition: -1}, executionMode: "resolve_more"};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), selected, f.request));
  expect((await f.store.get(String(first.frameId)))?.parentFrameId).toBe(f.saved[1]!.frameId);
  const index = await historyIndex(f.store, await f.store.state(), f.request.operationId);
  expect(index).toMatchObject({total: 3, latestOrdinal: 3});
  expect(index.entries.map(entry => entry.ordinal)).toEqual([1, 2, 3]);
  const current = await readContext(f.request, {frameId: String(first.frameId), setFocus: false});
  expect(current.status).toBe("resolved"); // 本轮快照仍可按确切引用读取。
  const read = await readContext(f.request, {selector: {relativePosition: -1}});
  expect(read.baseReference).toEqual({frameId: f.saved[1]!.frameId});
  const second = receiptJson(await runTool(createResolveBusinessTurnTool(), {...selected, fieldChanges: []}, f.request));
  expect((await f.store.get(String(second.frameId)))?.parentFrameId).toBe(f.saved[1]!.frameId);
  expect(await historyIndex(f.store, await f.store.state(), "next-user-turn")).toMatchObject({total: 5, latestOrdinal: 5});
});

it.each([{ordinal: 99}, {capability: "metric_query"}, {ordinal: 1, relativePosition: 0}])("无匹配、歧义或冲突引用均不切焦点：%j", async selector => {
  const f = await fixture();
  const before = await f.store.state();
  const receipt = await readContext(f.request, {selector, setFocus: true});
  expect(["not_found", "ambiguous"]).toContain(receipt.status);
  expect(await f.store.state()).toEqual(before);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("历史索引有界、稳定且不含结果，早期来源仍能定位；恢复后焦点与最新操作分离", async () => {
  const f = await fixture(12);
  const state = await f.store.state();
  const index = await historyIndex(f.store, state, f.request.operationId);
  expect(index).toMatchObject({total: 12, latestOrdinal: 12, focusOrdinal: 12, partial: true});
  expect(index.entries.map(entry => entry.ordinal)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  expect(JSON.stringify(index)).not.toMatch(/resultRef|sample_rows|fact_id/);
  await readContext(f.request, {selector: {ordinal: 2}, setFocus: true});
  expect(await historyIndex(f.store, await f.store.state(), f.request.operationId))
    .toMatchObject({latestOrdinal: 12, focusOrdinal: 2});
  await f.sessions.release("synthetic-history", f.session.metadata.id);
  const reopened = await f.sessions.open("synthetic-history", f.session.metadata);
  const restored = new NativeFrameStore(reopened);
  expect((await restored.state()).focusFrameId).toBe(f.saved[1]!.frameId);
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.change, {...f.request, frames: restored}));
  expect((await restored.get(String(receipt.frameId)))?.parentFrameId).toBe(f.saved[1]!.frameId);
});

const historyInput = (ordinals: number[], sourceText: string, expectedCount?: number): HistoryFieldReferenceInput => ({
  fromHistory: true, sourceText, sources: ordinals.map(ordinal => ({frame: {ordinal}, field: "organizations"})),
  combine: ordinals.length === 1 ? "single" : "union", ...(expectedCount === undefined ? {} : {expectedCount}),
});

it("机构指代由模型明确多源并集，保留来源和焦点其它条件", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: historyInput([1, 2, 3], "以上三家", 3)},
      {fieldHint: "time", operation: "set", rawValue: "2026-04-30"},
    ]}, {...f.request, originalMessage: "以上三家，2026-04-30的数据分别是多少？"}));
  expect(receipt.status).toBe("READY");
  const frame = (await f.store.get(String(receipt.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual({
    codes: ["organization:合成机构1", "organization:合成机构2", "organization:合成机构3"],
    names: ["合成机构1", "合成机构2", "合成机构3"]});
  expect(frame.fields.organizations?.metadata?.referenceSourceFrames).toEqual(f.saved.map(source => source.frameId));
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
});

it("机构指代数量不符合所选来源时保存未解析条件，不能截取或虚构", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: historyInput([1, 2, 3], "上述五家", 5)}]},
    {...f.request, originalMessage: "上述五家的数据呢？"}));
  expect(receipt.status).toBe("NEEDS_CLARIFICATION");
  expect(receipt.issues).toEqual(expect.arrayContaining([expect.objectContaining({field: "organizations", reason: "not_found"})]));
  expect((await f.store.get(String(receipt.frameId)))?.fields.organizations?.metadata?.referenceIssue)
    .toMatchObject({code: "HISTORY_REFERENCE_COUNT_MISMATCH", expectedCount: 5, actualCount: 3});
});

it("未声明数量仍可使用明确历史来源，而不靠词语规则推断", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: historyInput([1, 2], "它们")}]},
    {...f.request, originalMessage: "把它们一起排名"}));
  expect(receipt.status).toBe("NEEDS_CLARIFICATION");
  expect((await f.store.get(String(receipt.frameId)))?.fields.operation?.resolutionStatus).toBe("ambiguous");
  expect((await f.store.get(String(receipt.frameId)))?.fields.organizations?.resolvedValue).toEqual({
    codes: ["organization:合成机构1", "organization:合成机构2"], names: ["合成机构1", "合成机构2"]});
});

it("历史单源范围引用保留动态语义，后续普通续接仍通过既有路径刷新授权", async () => {
  const f = await fixture(0);
  const scope = {kind: "authorized_cohort" as const, cohort: "rural_commercial_banks" as const};
  let call = 0;
  Object.assign(f.backend, {resolveOrganizationScope: vi.fn(async () => {
    call++;
    return {status: "resolved", value: {codes: Array.from({length: call}, (_, index) => `C${index}`),
      names: Array.from({length: call}, (_, index) => `合成机构${index}`), scope, scope_fingerprint: String(call).repeat(64)}};
  })});
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: null,
    executionMode: "resolve_more", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: "合成指标"},
      {fieldHint: "organizations", operation: "set", rawValue: {...scope, sourceText: "账号权限内农商行"}},
      {fieldHint: "time", operation: "set", rawValue: "2026-04-30"},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ]}, {...f.request, requestId: "scope-first", operationId: "scope-first", originalMessage: "账号权限内农商行 合成指标 2026-04-30"}));
  expect(first.status).toBe("READY");
  const reference = historyInput([1], "那批机构");
  const second = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: reference}]},
    {...f.request, requestId: "scope-second", operationId: "scope-second", originalMessage: "那批机构继续"}));
  expect(second.status).toBe("READY");
  expect((await f.store.get(String(second.frameId)))?.fields.organizations).toMatchObject({
    source: "explicit", rawValue: {...scope, sourceText: "账号权限内农商行"}, resolvedValue: {codes: ["C0", "C1"], scope},
    metadata: {historyReference: reference, referenceSourceFrames: [first.frameId], refreshOnInherit: true}});
  const third = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: []}, {...f.request, requestId: "scope-third", operationId: "scope-third", originalMessage: "再查一次"}));
  expect(third.status).toBe("READY");
  expect((await f.store.get(String(third.frameId)))?.fields.organizations).toMatchObject({source: "inherited",
    resolvedValue: {codes: ["C0", "C1", "C2"], scope}, metadata: {refreshOnInherit: true}});
  expect(call).toBe(3);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([3, 2])("历史机构和新增候选跨轮确认继续复核完整集合，最终数量必须为%i", async expectedCount => {
  const f = await fixture();
  Object.assign(f.backend, {resolveBusinessField: vi.fn(async (_entity: string, values: string[]): Promise<FieldResolution> => {
    if (values[0] === "合成机构近似") return {status: "needs_confirmation", candidates: [{value: "合成机构新",
      code: "organization:合成机构新", metadata: {rawValueIndex: 0}}]};
    return {status: "resolved", value: {codes: values, names: values.map(value => value.replace("organization:", ""))}};
  })});
  const reference = {...historyInput([1, 2], "那两家", expectedCount), add: ["合成机构近似"]};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: reference}]},
    {...f.request, originalMessage: "那两家和合成机构近似一起"}));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const pending = (await f.store.get(String(first.frameId)))!;
  expect(pending.fields.organizations).toMatchObject({candidates: [{code: "organization:合成机构新", metadata: {rawValueIndex: 2}}], metadata: {
    referenceHistoryCodes: ["organization:合成机构1", "organization:合成机构2"],
    pendingRawValues: ["organization:合成机构1", "organization:合成机构2", "合成机构近似"]}});
  const confirmed = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {confirm: true}}]},
    {...f.request, requestId: "confirm-added", operationId: "confirm-added", originalMessage: "是"}));
  const frame = (await f.store.get(String(confirmed.frameId)))!;
  if (expectedCount === 3) {
    expect(confirmed.status).toBe("READY");
    expect(frame.fields.organizations).toMatchObject({source: "confirmed", resolvedValue: {
      codes: ["organization:合成机构1", "organization:合成机构2", "organization:合成机构新"]}, metadata: {
      referenceSourceFrames: [f.saved[0]!.frameId, f.saved[1]!.frameId]}});
  } else {
    expect(confirmed.status).toBe("NEEDS_CLARIFICATION");
    expect(frame.fields.organizations?.metadata?.referenceIssue).toMatchObject({code: "HISTORY_REFERENCE_COUNT_MISMATCH", actualCount: 3});
  }
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[2]!.fields.time?.resolvedValue);
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("历史指代目录临时失败跨轮重试保留精确来源、指标日期，无需重述原句", async () => {
  const f = await fixture();
  const original = f.backend.resolveBusinessField;
  let fail = true;
  Object.assign(f.backend, {resolveBusinessField: vi.fn(async (entity: string, values: string[]): Promise<FieldResolution> => {
    if (entity === "organization" && fail) {fail = false; return {status: "temporary_error"};}
    return original(entity, values);
  })});
  const reference = {fromHistory: true as const, sourceText: "它们", combine: "single" as const,
    sources: [{frame: {relativePosition: 0}, field: "organizations"}]};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: reference}]},
    {...f.request, originalMessage: "它们再查一次"}));
  expect(first.status).toBe("TEMPORARY_ERROR");
  expect((await f.store.get(String(first.frameId)))?.fields.organizations?.rawValue).toMatchObject({
    sources: [{frame: {frameId: f.saved[2]!.frameId}, field: "organizations"}]});
  const retry = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: first.retry_reference,
    executionMode: "resolve_more", fieldChanges: []}, {...f.request, requestId: "retry-history", operationId: "retry-history", originalMessage: "重试"}));
  expect(retry.status).toBe("READY");
  const frame = (await f.store.get(String(retry.frameId)))!;
  expect(frame.fields.organizations).toMatchObject({source: "inherited", resolvedValue: {codes: ["organization:合成机构3"]},
    metadata: {referenceSourceFrames: [f.saved[2]!.frameId]}});
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[2]!.fields.time?.resolvedValue);
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
});

it("新增候选与未知项一起保留，确认后仅补未知项可显式保留已确认新增机构", async () => {
  const f = await fixture();
  Object.assign(f.backend, {resolveBusinessField: vi.fn(async (_entity: string, values: string[]): Promise<FieldResolution> => {
    const name = values[0]!;
    if (name === "合成机构近似") return {status: "needs_confirmation", candidates: [{code: "organization:合成机构新", value: "合成机构新"}]};
    if (name === "未知机构") return {status: "not_found"};
    const code = name.startsWith("organization:") ? name : `organization:${name}`;
    return {status: "resolved", value: {codes: [code], names: [code.replace("organization:", "")]}};
  })});
  const reference = {...historyInput([1], "这家", 3), combine: "union" as const, add: ["合成机构近似", "未知机构"]};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: reference}]},
    {...f.request, originalMessage: "这家和合成机构近似、未知机构一起"}));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const pending = (await f.store.get(String(first.frameId)))!;
  expect(pending.fields.organizations).toMatchObject({resolutionStatus: "needs_confirmation", candidates: [{metadata: {rawValueIndex: 1}}],
    metadata: {referenceAdditionIssues: [{index: 1, raw: "合成机构近似", status: "needs_confirmation"}, {index: 2, raw: "未知机构", status: "not_found"}]}});
  const second = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {confirm: true}}]},
    {...f.request, requestId: "mixed-confirm", operationId: "mixed-confirm", originalMessage: "是"}));
  expect(second.status).toBe("NEEDS_CLARIFICATION");
  const confirmed = (await f.store.get(String(second.frameId)))!;
  expect(confirmed.fields.organizations).toMatchObject({resolutionStatus: "not_found", metadata: {
    referenceResolvedAdditions: {codes: ["organization:合成机构新"], names: ["合成机构新"]},
    referenceAdditionIssues: [{index: 2, raw: "未知机构", status: "not_found"}]}});
  const third = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "resolve_more", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {
      ...reference, sourceText: "原组合", add: undefined, replaceAdditions: [{index: 2, value: "合成机构丙"}], retainResolvedAdditions: true}}]},
    {...f.request, requestId: "mixed-supplement", operationId: "mixed-supplement", originalMessage: "原组合，未知机构补为合成机构丙"}));
  expect(third.status).toBe("READY");
  const frame = (await f.store.get(String(third.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual({codes: ["organization:合成机构1", "organization:合成机构新", "organization:合成机构丙"],
    names: ["合成机构1", "合成机构新", "合成机构丙"]});
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[2]!.fields.time?.resolvedValue);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("集合表达与普通名称不误判为历史指代，分别走授权集合与名称目录解析", async () => {
  const f = await fixture();
  const scopeValue = {codes: ["cohort:1", "cohort:2"], names: ["集合机构一", "集合机构二"],
    scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}, scope_fingerprint: "a".repeat(64)};
  const resolveScope = vi.fn(async () => ({status: "resolved", value: scopeValue}));
  Object.assign(f.backend, {resolveOrganizationScope: resolveScope});
  for (const name of ["各家农商行", "合成机构1", "张家港"]) {
    const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: name}]},
      {...f.request, requestId: `direct-${name}`, operationId: `direct-${name}`, originalMessage: `${name}的数据呢？`}));
    expect(receipt.status).toBe("READY");
    expect((await f.store.get(String(receipt.frameId)))!.fields.organizations?.resolvedValue)
      .toEqual(name === "各家农商行" ? scopeValue : {codes: [`organization:${name}`], names: [name]});
  }
  expect(resolveScope).toHaveBeenCalledTimes(1);
});

it("历史指代被声明为独立问题时指导模型改用 current 续接，不把缺项抛给用户", async () => {
  const f = await fixture();
  const wrong = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: historyInput([2, 3], "上述两家", 2)},
      {fieldHint: "time", operation: "set", rawValue: "2026-05-31"},
    ]}, {...f.request, originalMessage: "上述两家机构，2026-05-31的数据分别是多少？"}));
  expect(wrong).toMatchObject({status: "ARGUMENT_ERROR", error_code: "REFERENCE_IMPLIES_CONTINUATION"});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  // 按指导改用 current 后一次通过：机构来自指代，指标继承焦点。
  const fixed = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "execute", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: historyInput([2, 3], "上述两家", 2)},
      {fieldHint: "time", operation: "set", rawValue: "2026-05-31"},
    ]}, {...f.request, originalMessage: "上述两家机构，2026-05-31的数据分别是多少？"}));
  expect(fixed.status).toBe("READY");
  const frame = (await f.store.get(String(fixed.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual({
    codes: ["organization:合成机构2", "organization:合成机构3"], names: ["合成机构2", "合成机构3"]});
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
});
