import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import {NativeSessionStore} from "../nativeSessions.js";
import {NativeFrameStore} from "./store.js";
import {BusinessContextService} from "./service.js";
import {createCapabilities} from "./capabilities.js";
import {createFieldResolvers} from "./resolvers.js";
import {modelHistoryIndex} from "./modelView.js";
import {createBusinessContextReadTool, createResolveBusinessTurnTool, createReadBusinessResultTool} from "../tools/businessContext.js";
import {createMetricReadTool, createReadTool} from "../tools/readTools.js";
import {BackendApiError} from "../backendClient.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../tools/testUtils.js";
import type {BackendClient} from "../backendClient.js";
import type {BusinessFrame, ContextDelta, FieldResolution, FrameSelector} from "./types.js";

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
    value: entity === "date" ? {start: raw[0], end: raw[0]} : {codes: raw.map(name => `${entity}:${name}`), names: raw}});
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

it("模型调用必须显式选择来源，省略不能默认继承最新焦点；current 保留普通续接能力", async () => {
  const f = await fixture();
  const tool = createResolveBusinessTurnTool();
  const call = {type: "toolCall" as const, id: "source-required", name: tool.name, arguments: f.change};
  expect(() => validateToolArguments(tool, call)).toThrow();
  const args = {...f.change, baseReference: "current"};
  expect(() => validateToolArguments(tool, {...call, arguments: args})).not.toThrow();
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
  const args = {...f.change, baseReference: "current"};
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
  const index = await modelHistoryIndex(f.store, await f.store.state(), "third");
  expect(index.total).toBe(2);
  const selected = receiptJson(await runTool(createBusinessContextReadTool(), {selector: {ordinal: 2}}, {...f.request, operationId: "third"}));
  expect(selected.baseReference).toEqual({frameId: second.frameId});
  expect(await f.store.get(String(draft.frameId))).toMatchObject({status: "ready"}); // 历史准备快照仍不可变且可回读。
});

it.each([
  {ordinal: 1}, {relativePosition: -2}, {businessConstraints: {time: {start: "2026-01-01"}}},
] satisfies FrameSelector[])("引用方式不同但指向同一Frame时，焦点切换后普通追问统一继承：%j", async selector => {
  const f = await fixture();
  const initial = await f.store.state();
  const inspected = receiptJson(await runTool(createBusinessContextReadTool(), {selector, setFocus: false}, f.request));
  expect(inspected.status).toBe("resolved");
  expect(await f.store.state()).toEqual(initial); // 单纯浏览不抢焦点。
  const selected = receiptJson(await runTool(createBusinessContextReadTool(), {selector}, f.request));
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
  const page = receiptJson(await runTool(createBusinessContextReadTool(), {offset: 0, limit: 2}, f.request));
  expect(page.frames).toHaveLength(2);
  expect(await f.store.state()).toEqual(before);
  const foreign = receiptJson(await runTool(createBusinessContextReadTool(), {frameId: other.saved[0]!.frameId}, f.request));
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
  const index = await modelHistoryIndex(f.store, await f.store.state(), f.request.operationId);
  expect(index).toMatchObject({total: 3, latestOrdinal: 3});
  expect(index.entries.map(entry => entry.ordinal)).toEqual([1, 2, 3]);
  const current = receiptJson(await runTool(createBusinessContextReadTool(), {frameId: first.frameId, setFocus: false}, f.request));
  expect(current.status).toBe("resolved"); // 本轮快照仍可按确切引用读取。
  const read = receiptJson(await runTool(createBusinessContextReadTool(), {selector: {relativePosition: -1}}, f.request));
  expect(read.baseReference).toEqual({frameId: f.saved[1]!.frameId});
  const second = receiptJson(await runTool(createResolveBusinessTurnTool(), {...selected, fieldChanges: []}, f.request));
  expect((await f.store.get(String(second.frameId)))?.parentFrameId).toBe(f.saved[1]!.frameId);
  expect(await modelHistoryIndex(f.store, await f.store.state(), "next-user-turn")).toMatchObject({total: 5, latestOrdinal: 5});
});

it.each([{ordinal: 99}, {capability: "metric_query"}, {ordinal: 1, relativePosition: 0}])("无匹配、歧义或冲突引用均不切焦点：%j", async selector => {
  const f = await fixture();
  const before = await f.store.state();
  const receipt = receiptJson(await runTool(createBusinessContextReadTool(), {selector, setFocus: true}, f.request));
  expect(["not_found", "ambiguous"]).toContain(receipt.status);
  expect(await f.store.state()).toEqual(before);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("历史索引有界、稳定且不含结果，早期来源仍能定位；恢复后焦点与最新操作分离", async () => {
  const f = await fixture(12);
  const state = await f.store.state();
  const index = await modelHistoryIndex(f.store, state, f.request.operationId);
  expect(index).toMatchObject({total: 12, latestOrdinal: 12, focusOrdinal: 12, partial: true});
  expect(index.entries.map(entry => entry.ordinal)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  expect(JSON.stringify(index)).not.toMatch(/resultRef|sample_rows|fact_id/);
  await runTool(createBusinessContextReadTool(), {selector: {ordinal: 2}, setFocus: true}, f.request);
  expect(await modelHistoryIndex(f.store, await f.store.state(), f.request.operationId))
    .toMatchObject({latestOrdinal: 12, focusOrdinal: 2});
  await f.sessions.release("synthetic-history", f.session.metadata.id);
  const reopened = await f.sessions.open("synthetic-history", f.session.metadata);
  const restored = new NativeFrameStore(reopened);
  expect((await restored.state()).focusFrameId).toBe(f.saved[1]!.frameId);
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.change, {...f.request, frames: restored}));
  expect((await restored.get(String(receipt.frameId)))?.parentFrameId).toBe(f.saved[1]!.frameId);
});

it("机构话语指代按会话历史解析为最近讨论的去重机构，其余条件继承焦点", async () => {
  const f = await fixture(); // 合成机构1、2、3（旧→新），焦点为第3笔
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: "上述三家"},
      {fieldHint: "time", operation: "set", rawValue: "2026-04-30"},
    ]}, {...f.request, originalMessage: "上述三家，2026-04-30的数据分别是多少？"}));
  expect(receipt.status).toBe("READY");
  const frame = (await f.store.get(String(receipt.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual({
    codes: ["organization:合成机构3", "organization:合成机构2", "organization:合成机构1"],
    names: ["合成机构3", "合成机构2", "合成机构1"]});
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
});

it("机构指代数量超过历史讨论机构数时不虚构，转入澄清", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "上述五家"}]},
    {...f.request, originalMessage: "上述五家的数据呢？"}));
  expect(receipt.status).toBe("NEEDS_CLARIFICATION");
  expect(receipt.issues).toEqual(expect.arrayContaining([expect.objectContaining({field: "organizations", reason: "not_found"})]));
});

it("无明确数量的机构指代不猜测，转入澄清", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "那几家"}]},
    {...f.request, originalMessage: "那几家的数据呢？"}));
  expect(receipt.status).toBe("NEEDS_CLARIFICATION");
  expect(receipt.issues).toEqual(expect.arrayContaining([expect.objectContaining({field: "organizations", reason: "not_found"})]));
});

it("机构指代与直接名称混合时合并解析", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
    fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: ["上述两家", "合成机构新"]},
      {fieldHint: "time", operation: "set", rawValue: "2026-04-30"},
    ]}, {...f.request, originalMessage: "上述两家和合成机构新，2026-04-30分别是多少？"}));
  expect(receipt.status).toBe("READY");
  const frame = (await f.store.get(String(receipt.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual({
    codes: ["organization:合成机构3", "organization:合成机构2", "organization:合成机构新"],
    names: ["合成机构3", "合成机构2", "合成机构新"]});
});

it("集合表达与普通名称不误判为指代，仍走目录解析", async () => {
  const f = await fixture();
  for (const name of ["各家农商行", "合成机构1", "张家港"]) {
    const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.change, baseReference: "current",
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: name}]},
      {...f.request, requestId: `direct-${name}`, operationId: `direct-${name}`, originalMessage: `${name}的数据呢？`}));
    expect(receipt.status).toBe("READY");
    expect((await f.store.get(String(receipt.frameId)))!.fields.organizations?.resolvedValue)
      .toEqual({codes: [`organization:${name}`], names: [name]});
  }
});

it("历史指代被声明为独立问题时指导模型改用 current 续接，不把缺项抛给用户", async () => {
  const f = await fixture();
  const wrong = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: null,
    executionMode: "execute", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: "上述两家"},
      {fieldHint: "time", operation: "set", rawValue: "2026-05-31"},
    ]}, {...f.request, originalMessage: "上述两家机构，2026-05-31的数据分别是多少？"}));
  expect(wrong).toMatchObject({status: "ARGUMENT_ERROR", error_code: "REFERENCE_IMPLIES_CONTINUATION"});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  // 按指导改用 current 后一次通过：机构来自指代，指标继承焦点。
  const fixed = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current",
    executionMode: "execute", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: "上述两家"},
      {fieldHint: "time", operation: "set", rawValue: "2026-05-31"},
    ]}, {...f.request, originalMessage: "上述两家机构，2026-05-31的数据分别是多少？"}));
  expect(fixed.status).toBe("READY");
  const frame = (await f.store.get(String(fixed.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual({
    codes: ["organization:合成机构3", "organization:合成机构2"], names: ["合成机构3", "合成机构2"]});
  expect(frame.fields.metrics?.resolvedValue).toEqual(f.saved[2]!.fields.metrics?.resolvedValue);
});
