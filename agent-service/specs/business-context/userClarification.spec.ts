import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {modelCapabilitySchemas} from "../../src/business-context/modelView.js";
import {renderFrameClarification} from "../../src/business-context/clarificationPresentation.js";
import {toCompactTurnArgs} from "../../src/business-context/turnArgs.js";
import {createExecuteBusinessFrameTool, createResolveBusinessTurnTool} from "../../src/tools/businessContext.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import type {ContextDelta} from "../../src/business-context/types.js";

const question = "查询合成机构甲2026年7月合成指标排名";
const month = {start: "2026-07-01", end: "2026-07-31"};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});

async function fixture(singleDay = false) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "user-clarification-"));
  const sessions = new NativeSessionStore(path);
  const session = await sessions.create("synthetic-clarification-user");
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const backend = {
    resolveBusinessField: vi.fn(async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date"
      ? singleDay ? {start: "2026-07-31", end: "2026-07-31"} : month
      : {codes: [entity === "metric" ? "M1" : "O1"], names}})),
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "synthetic-conversation"})),
    basicQueries: vi.fn(async () => ({result: {status: "succeeded", task_id: "synthetic-task", columns: [], rows: [], row_count: 0}})),
    getTask: vi.fn(async () => ({version: 1, result: {result_id: "synthetic-result"}})),
  };
  const request = testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    sessionId: session.metadata.id, operationId: "initial", requestId: "initial", originalMessage: question, frames: store,
  });
  const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
    fieldIntents: {organizations: {mode: "set", sourceText: "合成机构甲", expectedCount: null}}, fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: "合成指标"},
      {fieldHint: "organizations", operation: "set", rawValue: "合成机构甲"},
      {fieldHint: "time", operation: "set", rawValue: "2026年7月"},
      {fieldHint: "selection", operation: "set", rawValue: {clarify: true, sourceText: "2026年7月"}},
      {fieldHint: "operation", operation: "set", rawValue: {clarify: true, sourceText: "排名"}},
    ]};
  return {path, sessions, session, service, store, request, delta, backend};
}

describe.each([false, true])("声明的业务澄清（compact=%s）", compactTurnArgs => {
  const call = async (f: Awaited<ReturnType<typeof fixture>>, delta = f.delta, request = f.request) => {
    const tool = createResolveBusinessTurnTool({compactTurnArgs});
    const args = compactTurnArgs ? toCompactTurnArgs(delta) : delta;
    expect(() => validateToolArguments(tool, {type: "toolCall", id: "clarification", name: tool.name, arguments: args})).not.toThrow();
    return receiptJson(await runTool(tool, args, request));
  };

  it("空会话保存全部已知条件和服务端问题，待澄清不查询且不能直接执行", async () => {
    const f = await fixture();
    const receipt = await call(f);
    expect(receipt.status).toBe("NEEDS_CLARIFICATION");
    const saved = (await f.store.get(String(receipt.frameId)))!;
    expect(saved.status).toBe("clarifying");
    expect(saved.fields.metrics?.resolvedValue).toEqual({codes: ["M1"], names: ["合成指标"]});
    expect(saved.fields.organizations?.resolvedValue).toEqual({codes: ["O1"], names: ["合成机构甲"]});
    expect(saved.fields.time?.resolvedValue).toEqual(month);
    for (const name of ["selection", "operation"]) {
      const declared = createCapabilities().get("metric_query").fields[name]!.userClarification!.question;
      expect(saved.fields[name]).toMatchObject({resolutionStatus: "ambiguous", metadata: {userInputIssue: true, userClarificationQuestion: declared}});
      expect(saved.issues).toContainEqual({field: name, reason: "ambiguous", message: declared});
      expect(renderFrameClarification(saved)).toContain(declared);
    }
    await expect(f.service.beginExecution(saved.frameId, {sessionId: f.session.metadata.id, turnId: "initial", requestId: "initial"}))
      .rejects.toThrow("FRAME_NOT_EXECUTABLE");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("下一轮补充业务选择继承完整原条件，仅执行一次", async () => {
    const f = await fixture();
    const first = await call(f);
    const pending = (await f.store.get(String(first.frameId)))!;
    const request = {...f.request, originalMessage: "取范围内最后有数据的一天，查看前5名", operationId: "followup", requestId: "followup"};
    const followup: ContextDelta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldIntents: {organizations: {mode: "inherit", sourceText: null, expectedCount: null}}, fieldChanges: [
        {fieldHint: "selection", operation: "set", rawValue: "latest_in_range"},
        {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "top", top_n: 5}},
      ]};
    const ready = await call(f, followup, request);
    expect(ready.status).toBe("READY");
    const saved = (await f.store.get(String(ready.frameId)))!;
    for (const name of ["metrics", "organizations", "time"]) expect(saved.fields[name]?.resolvedValue).toEqual(pending.fields[name]?.resolvedValue);
    await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect((f.backend.basicQueries.mock.calls as unknown[][])[0]![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: month,
      selection: "latest_in_range", operation: {kind: "ranking", position: "top", top_n: 5}});
  });

  it("只补一项或普通继承时未决字段继续阻止执行", async () => {
    const f = await fixture();
    await call(f);
    const followup: ContextDelta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldIntents: {organizations: {mode: "inherit", sourceText: null, expectedCount: null}},
      fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "latest_in_range"}]};
    const partly = await call(f, followup, {...f.request, originalMessage: "取最后有数据的一天", operationId: "partly", requestId: "partly"});
    expect(partly.status).toBe("NEEDS_CLARIFICATION");
    const inherited = await call(f, {...followup, fieldChanges: []}, {...f.request, originalMessage: "继续", operationId: "inherit", requestId: "inherit"});
    expect(inherited.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(inherited.frameId)))?.fields.operation?.resolutionStatus).toBe("ambiguous");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("显式单日澄清不被缺省exact覆盖，普通缺省单日仍兼容", async () => {
    const f = await fixture(true);
    const explicit = await call(f);
    expect(explicit.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(explicit.frameId)))?.fields.selection?.resolutionStatus).toBe("ambiguous");
    const independent = {...f.delta, fieldChanges: f.delta.fieldChanges.filter(change => change.fieldHint !== "selection")};
    const inferred = await call(f, independent, {...f.request, operationId: "single-default", requestId: "single-default"});
    expect((await f.store.get(String(inferred.frameId)))?.fields.selection?.resolvedValue).toBe("exact");
    expect(inferred.status).toBe("NEEDS_CLARIFICATION"); // 排名仍待业务补充。
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
});

it.each([
  {field: "selection", rawValue: {clarify: true, sourceText: "2026年8月"}},
  {field: "selection", rawValue: {clarify: true, sourceText: "   "}},
  {field: "selection", rawValue: {clarify: false, sourceText: "2026年7月"}},
  {field: "selection", rawValue: {clarify: true, sourceText: "2026年7月", question: "模型自写问题"}},
  {field: "selection", rawValue: {clarify: true, sourceText: "2026年7月", candidates: ["模型候选"]}},
  {field: "operation", rawValue: {clarify: true, sourceText: "排名", confirm: true}},
  {field: "organizations", rawValue: {clarify: true, sourceText: "合成机构甲"}},
  {field: "unknown", rawValue: {clarify: true, sourceText: "排名"}},
])("非法澄清请求仍是参数错误且不保存：$field / $rawValue", async ({field, rawValue}) => {
  const f = await fixture();
  const delta = {...f.delta, fieldChanges: [...f.delta.fieldChanges.filter(change => change.fieldHint !== field),
    {fieldHint: field, operation: "set" as const, rawValue}]};
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, f.request));
  expect(result.status).toBe("ARGUMENT_ERROR");
  expect(await f.store.list()).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each(["clear", "invalid"])("确定单日也不覆盖显式selection %s", async mode => {
  const f = await fixture(true);
  const delta: ContextDelta = {...f.delta, fieldChanges: [...f.delta.fieldChanges.filter(change => change.fieldHint !== "selection"),
    mode === "clear" ? {fieldHint: "selection", operation: "clear"} : {fieldHint: "selection", operation: "set", rawValue: "invalid"}]};
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, f.request));
  expect(result.status).toBe("ARGUMENT_ERROR");
  expect(await f.store.list()).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("保存的业务问题在刷新及服务重开后相同", async () => {
  const f = await fixture();
  const receipt = receiptJson(await runTool(createResolveBusinessTurnTool(), f.delta, f.request));
  const frame = (await f.store.get(String(receipt.frameId)))!;
  const expected = renderFrameClarification(frame);
  expect(renderFrameClarification(structuredClone(frame))).toBe(expected);
  await f.sessions.close();
  const restarted = new NativeSessionStore(f.path);
  cleanup.push(async () => {await restarted.close();});
  const session = await restarted.open("synthetic-clarification-user", f.session.metadata);
  const restored = new NativeFrameStore(session);
  expect(renderFrameClarification((await restored.get(frame.frameId))!)).toBe(expected);
  const request = {...f.request, frames: restored, originalMessage: "取最后有数据的一天，查看后2名", operationId: "restarted-followup", requestId: "restarted-followup"};
  const ready = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
    fieldIntents: {organizations: {mode: "inherit", sourceText: null, expectedCount: null}}, fieldChanges: [
      {fieldHint: "selection", operation: "set", rawValue: "latest_in_range"},
      {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "bottom", top_n: 2}},
    ]}, request));
  expect(ready.status).toBe("READY");
  const saved = (await restored.get(String(ready.frameId)))!;
  for (const name of ["metrics", "organizations", "time"]) expect(saved.fields[name]?.resolvedValue).toEqual(frame.fields[name]?.resolvedValue);
  await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect((f.backend.basicQueries.mock.calls as unknown[][])[0]![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: month,
    selection: "latest_in_range", operation: {kind: "ranking", position: "bottom", top_n: 2}});
});

it("模型能力块公开仅声明字段的澄清输入，正常值输入约束仍保留", () => {
  const schemas = modelCapabilitySchemas();
  const query = schemas.find(schema => schema.capability === "metric_query")!;
  for (const name of ["selection", "operation"]) {
    expect(query.fields[name]).toMatchObject({userClarification: {question: expect.any(String)}, inputSchema: {anyOf: expect.arrayContaining([
      {type: "object", required: ["clarify", "sourceText"], properties: {clarify: {const: true}, sourceText: {type: "string", minLength: 1}}, additionalProperties: false},
    ])}});
  }
  expect(query.fields.organizations).not.toHaveProperty("userClarification");
  expect(createCapabilities().get("metric_query").fields.operation?.inputSchema).toHaveProperty("oneOf");
  expect(schemas.find(schema => schema.capability === "data_availability")?.fields.dimension).not.toHaveProperty("userClarification");
});
