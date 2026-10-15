import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Type, validateToolArguments} from "@earendil-works/pi-ai";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {BusinessInputError} from "../../src/business-context/inputError.js";
import type {ContextDelta, ResolverContext} from "../../src/business-context/types.js";
import type {BackendClient} from "../../src/backendClient.js";
import {createExecuteBusinessFrameTool, createResolveBusinessTurnTool} from "../../src/tools/businessContext.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../../src/tools/testUtils.js";
import {toCompactTurnArgs} from "../../src/business-context/turnArgs.js";
import {fieldClarificationInputSchema} from "../../src/business-context/fieldClarification.js";

const question = "查询合成甲行2026年7月净利润当日数排名前3名";
const month = {start: "2026-07-01", end: "2026-07-31"};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});

async function fixture(time: {start: string; end: string; dates?: string[]} = month) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "argument-corrections-"));
  const sessions = new NativeSessionStore(path);
  const session = await sessions.create("synthetic-user");
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const identity = {sessionId: session.metadata.id, turnId: "correction-turn", requestId: "correction-request"};
  const backend = {
    resolveBusinessField: vi.fn(async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date"
      ? time : {codes: [entity === "metric" ? "M" : "O"], names}})),
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "synthetic-conversation"})),
    basicQueries: vi.fn(async () => ({result: {status: "succeeded", task_id: "synthetic-task", columns: [], rows: [], row_count: 0}})),
    getTask: vi.fn(async () => ({version: 1, result: {result_id: "synthetic-result"}})),
  };
  const context: ResolverContext = {originalMessage: question, currentDate: "2026-10-13", turnId: identity.turnId,
    resolveCatalog: backend.resolveBusinessField as ResolverContext["resolveCatalog"]};
  const request = testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    sessionId: identity.sessionId, operationId: identity.turnId, requestId: identity.requestId, originalMessage: question, frames: store,
  });
  function delta(selection?: string, ranking = true): ContextDelta {
    return {capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
      fieldIntents: {organizations: {mode: "set", sourceText: "合成甲行", expectedCount: null}}, fieldChanges: [
        {fieldHint: "metrics", operation: "set", rawValue: "净利润当日数"},
        {fieldHint: "organizations", operation: "set", rawValue: "合成甲行"},
        {fieldHint: "time", operation: "set", rawValue: "2026年7月"},
        ...(selection === undefined ? [] : [{fieldHint: "selection", operation: "set" as const, rawValue: selection}]),
        {fieldHint: "operation", operation: "set", rawValue: ranking ? {kind: "ranking", position: "top", top_n: 3} : {kind: "value"}},
      ]};
  }
  return {service, store, backend, identity, context, request, delta};
}

const invalidCases = [
  {name: "月范围漏取数方式", selection: undefined, ranking: true, reason: "missing", allowed: ["latest_in_range"]},
  {name: "月范围普通取值漏取数方式", selection: undefined, ranking: false, reason: "missing", allowed: ["latest_in_range", "all_in_range"]},
  {name: "月范围误填指定日", selection: "exact", ranking: true, reason: "invalid", allowed: ["latest_in_range"]},
  {name: "月范围普通取值误填指定日", selection: "exact", ranking: false, reason: "invalid", allowed: ["latest_in_range", "all_in_range"]},
] as const;

describe("参数组合结构化纠错", () => {
  it.each(invalidCases)("服务端报告合法组合且不保存失败Frame：$name", async ({selection, ranking, reason, allowed}) => {
    const f = await fixture();
    const input = f.delta(selection, ranking);
    const original = structuredClone(input);
    let error: unknown;
    try {await f.service.resolve(input, f.identity,
      {...f.context, originalMessage: ranking ? question : question.replace("排名前3名", "")});} catch (caught) {error = caught;}
    expect(error).toBeInstanceOf(BusinessInputError);
    expect(error).toMatchObject({code: "FIELD_COMBINATION_INVALID", field: "selection", corrections: [{
      field: "selection", reason, allowedValues: allowed, inputSchema: {anyOf: [{type: "string", enum: allowed}, fieldClarificationInputSchema]},
      userClarification: {question: createCapabilities().get("metric_query").fields.selection!.userClarification!.question,
        instruction: expect.stringContaining("已有明确依据时修正正常值参数")},
      context: {timeKind: "continuous_range", operationKind: ranking ? "ranking" : "value"},
    }]});
    expect(input).toEqual(original);
    expect(await f.store.list()).toEqual([]);
    expect((await f.store.state()).focusFrameId).toBeUndefined();
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("合法月范围latest保留全范围和排名，不自动换成月末", async () => {
    const f = await fixture();
    const frame = await f.service.resolve(f.delta("latest_in_range"), f.identity, f.context);
    expect(frame.status).toBe("ready");
    expect(frame.fields.time?.resolvedValue).toEqual(month);
    expect(frame.fields.selection?.resolvedValue).toBe("latest_in_range");
    expect(frame.fields.operation?.resolvedValue).toEqual({kind: "ranking", position: "top", top_n: 3});
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("逐日排名仍是业务终态，不能建议取消完整序列来改变用户目标", async () => {
    const f = await fixture();
    await expect(f.service.resolve(f.delta("all_in_range"), f.identity, f.context)).rejects.toThrow("UNSUPPORTED_QUERY_COMBINATION");
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("Resolver尚未完成日期解析时仅交付已知枚举Schema，不推断范围组合", async () => {
    const f = await fixture();
    await expect(f.service.resolve(f.delta("ranking"), f.identity, f.context)).rejects.toMatchObject({
      code: "FIELD_ENUM_INVALID", corrections: [{field: "selection", reason: "invalid",
        allowedValues: ["exact", "latest_in_range", "all_in_range"], inputSchema: {anyOf: [
          {enum: ["exact", "latest_in_range", "all_in_range"]}, fieldClarificationInputSchema]}, userClarification: {question: expect.any(String)}}],
    });
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("同日缺省exact只在日期实际解析后完成", async () => {
    const f = await fixture({start: "2026-07-31", end: "2026-07-31"});
    const frame = await f.service.resolve(f.delta(), f.identity, f.context);
    expect(frame.status).toBe("ready");
    expect(frame.fields.selection?.resolvedValue).toBe("exact");
  });

  it.each(["exact", "latest_in_range"])("离散日期普通取值保留既有合法%s规则", async selection => {
    const time = {start: "2026-06-30", end: "2026-07-31", dates: ["2026-06-30", "2026-07-31"]};
    const f = await fixture(time);
    const frame = await f.service.resolve(f.delta(selection, false), f.identity,
      {...f.context, originalMessage: question.replace("排名前3名", "")});
    expect(frame.status).toBe("ready");
    expect(frame.fields.time?.resolvedValue).toEqual(time);
    expect(frame.fields.selection?.resolvedValue).toBe(selection);
  });

  it.each([{selection: "exact", ranking: true}, {selection: "all_in_range", ranking: false}])(
    "离散日期不支持的组合仍终止，不建议删去用户目标：$selection/$ranking", async ({selection, ranking}) => {
      const f = await fixture({start: "2026-06-30", end: "2026-07-31", dates: ["2026-06-30", "2026-07-31"]});
      await expect(f.service.resolve(f.delta(selection, ranking), f.identity,
        {...f.context, originalMessage: ranking ? question : question.replace("排名前3名", "")})).rejects.toThrow("UNSUPPORTED_QUERY_COMBINATION");
      expect(await f.store.list()).toEqual([]);
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
    });

  it("参数纠错保留原焦点和已保存候选", async () => {
    const f = await fixture();
    const ready = await f.service.resolve(f.delta("latest_in_range"), f.identity, f.context);
    const before = await f.store.state();
    const input: ContextDelta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldChanges: [{fieldHint: "selection", operation: "set", rawValue: "exact"}]};
    await expect(f.service.resolve(input, {...f.identity, requestId: "invalid"}, f.context)).rejects.toMatchObject({
      baseReference: {frameId: ready.frameId}, corrections: [{allowedValues: ["latest_in_range"]}],
    });
    expect(await f.store.state()).toEqual(before);
    expect(await f.store.get(ready.frameId)).toEqual(ready);
  });
});

describe.each([false, true])("工具纠错回执（compact=%s）", compactTurnArgs => {
  it.each([
    {field: "operation", rawValue: {kind: "ranking", position: "top", top_n: null}, error: "FIELD_INPUT_SCHEMA_INVALID"},
    {field: "selection", rawValue: "ranking", error: "FIELD_ENUM_INVALID"},
    {field: "selection", rawValue: "exact", error: "FIELD_COMBINATION_INVALID"},
  ])("$error同时公开正常修复与受控业务澄清，不自动保存或默认业务选择", async ({field, rawValue, error}) => {
    const f = await fixture();
    const delta = f.delta("latest_in_range");
    delta.fieldChanges = delta.fieldChanges.map(change => change.fieldHint === field ? {...change, rawValue} : change);
    const receipt = receiptJson(await runTool(createResolveBusinessTurnTool({compactTurnArgs}), compactTurnArgs ? toCompactTurnArgs(delta) : delta, f.request));
    expect(receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: error, next_action: "correct_arguments", query_executed: false});
    const correction = (receipt.corrections as Array<{field: string; inputSchema: Record<string, unknown>; userClarification: {question: string; instruction: string}}>)[0]!;
    expect(correction.field).toBe(field);
    expect(correction.userClarification).toMatchObject({question: createCapabilities().get("metric_query").fields[field]!.userClarification!.question,
      instruction: expect.stringContaining("已有明确依据时修正正常值参数")});
    expect(correction.userClarification.instruction).toContain("缺少必要业务选择时");
    const tool = {name: "field", description: "输入诊断", parameters: Type.Object({raw: Type.Unsafe(correction.inputSchema)}, {additionalProperties: false})};
    expect(() => validateToolArguments(tool, {type: "toolCall", id: "clarify", name: "field", arguments: {raw: {clarify: true, sourceText: "排名"}}})).not.toThrow();
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("排名缺少业务条数时纠错可显式保存澄清，已有明确条数时正常纠正即可执行", async () => {
    const f = await fixture();
    const tool = createResolveBusinessTurnTool({compactTurnArgs});
    const unknown = f.delta("latest_in_range");
    unknown.fieldChanges = unknown.fieldChanges.map(change => change.fieldHint === "operation"
      ? {...change, rawValue: {kind: "ranking", position: "top", top_n: null}} : change);
    const initialRequest = {...f.request, originalMessage: question.replace("前3名", "")};
    const invalid = receiptJson(await runTool(tool, compactTurnArgs ? toCompactTurnArgs(unknown) : unknown, initialRequest));
    expect(invalid.status).toBe("ARGUMENT_ERROR");
    const clarified = {...unknown, fieldChanges: unknown.fieldChanges.map(change => change.fieldHint === "operation"
      ? {...change, rawValue: {clarify: true, sourceText: "排名"}} : change)};
    const pending = receiptJson(await runTool(tool, compactTurnArgs ? toCompactTurnArgs(clarified) : clarified, initialRequest));
    expect(pending.status).toBe("NEEDS_CLARIFICATION");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const resolved: ContextDelta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldIntents: {organizations: {mode: "inherit", sourceText: null, expectedCount: null}}, fieldChanges: [
        {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "top", top_n: 3}},
      ]};
    const followupRequest = {...f.request, operationId: "explicit-count", requestId: "explicit-count", originalMessage: "前3名"};
    const ready = receiptJson(await runTool(tool, compactTurnArgs ? toCompactTurnArgs(resolved) : resolved, followupRequest));
    expect(ready.status).toBe("READY");
    await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, followupRequest);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);

    const explicit = await fixture();
    const invalidExplicit = receiptJson(await runTool(tool, compactTurnArgs ? toCompactTurnArgs(unknown) : unknown, explicit.request));
    expect(invalidExplicit.status).toBe("ARGUMENT_ERROR");
    const normal = explicit.delta("latest_in_range");
    const known = receiptJson(await runTool(tool, compactTurnArgs ? toCompactTurnArgs(normal) : normal, explicit.request));
    expect(known.status).toBe("READY");
    await runTool(createExecuteBusinessFrameTool(), {frameId: known.frameId}, explicit.request);
    expect(explicit.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect((await explicit.store.list()).some(frame => frame.status === "clarifying")).toBe(false);
  });

  it.each(invalidCases)("只报告允许组合，无业务查询或自动修正：$name", async ({selection, ranking, reason, allowed}) => {
    const f = await fixture();
    const delta = f.delta(selection, ranking);
    const result = await runTool(createResolveBusinessTurnTool({compactTurnArgs}), compactTurnArgs ? toCompactTurnArgs(delta) : delta,
      {...f.request, originalMessage: ranking ? question : question.replace("排名前3名", "")});
    const receipt = receiptJson(result);
    expect(receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_COMBINATION_INVALID", field: "selection",
      scope: "argument_validation", query_executed: false, preserve_user_conditions: true, focus_preserved: true, next_action: "correct_arguments",
      corrections: [{field: "selection", reason, allowedValues: allowed, inputSchema: {anyOf: [{type: "string", enum: allowed}, fieldClarificationInputSchema]},
        userClarification: {question: expect.any(String), instruction: expect.stringContaining("Schema必填不授权默认值")}}],
    });
    expect(JSON.stringify(receipt.corrections)).not.toContain('"codes"');
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("按回执显式修正后仅执行一次，完整月范围和排名不变", async () => {
    const f = await fixture();
    const tool = createResolveBusinessTurnTool({compactTurnArgs});
    const invalid = f.delta("exact");
    const failed = receiptJson(await runTool(tool, compactTurnArgs ? toCompactTurnArgs(invalid) : invalid, f.request));
    expect(failed.status).toBe("ARGUMENT_ERROR");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const corrected = f.delta("latest_in_range");
    const ready = receiptJson(await runTool(tool, compactTurnArgs ? toCompactTurnArgs(corrected) : corrected, f.request));
    expect(ready.status).toBe("READY");
    await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, f.request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect((f.backend.basicQueries.mock.calls as unknown[][])[0]![0]).toMatchObject({time: month,
      selection: "latest_in_range", operation: {kind: "ranking", position: "top", top_n: 3}});
  });

  it("非法枚举保留错误码并给原输入Schema，不伪造已解析组合", async () => {
    const f = await fixture();
    const delta = f.delta("ranking");
    const receipt = receiptJson(await runTool(createResolveBusinessTurnTool({compactTurnArgs}), compactTurnArgs ? toCompactTurnArgs(delta) : delta, f.request));
    expect(receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_ENUM_INVALID", corrections: [{
      field: "selection", reason: "invalid", allowedValues: ["exact", "latest_in_range", "all_in_range"],
    }]});
    expect((receipt.corrections as unknown[])[0]).not.toHaveProperty("context");
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("离散日期排名仍返回不可重试业务终态，不提供取消排名修复", async () => {
    const f = await fixture({start: "2026-06-30", end: "2026-07-31", dates: ["2026-06-30", "2026-07-31"]});
    const delta = f.delta("exact");
    const receipt = receiptJson(await runTool(createResolveBusinessTurnTool({compactTurnArgs}), compactTurnArgs ? toCompactTurnArgs(delta) : delta, f.request));
    expect(receipt).toMatchObject({status: "error", error_code: "UNSUPPORTED_QUERY_COMBINATION", retryable: false});
    expect(receipt).not.toHaveProperty("corrections");
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("完整范围逐日排名仍返回不可重试终态，不提供改目标的纠错建议", async () => {
    const f = await fixture();
    const delta = f.delta("all_in_range");
    const receipt = receiptJson(await runTool(createResolveBusinessTurnTool({compactTurnArgs}), compactTurnArgs ? toCompactTurnArgs(delta) : delta, f.request));
    expect(receipt).toMatchObject({status: "error", error_code: "UNSUPPORTED_QUERY_COMBINATION", retryable: false});
    expect(receipt).not.toHaveProperty("corrections");
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
});
