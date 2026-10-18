import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {applyFieldIntentConstraints, FieldResolverRegistry, mergeFields, validateFieldIntents, validateFrame} from "../../src/business-context/core.js";
import {toContextDelta} from "../../src/business-context/turnArgs.js";
import {createResolveTurnShim as createResolveBusinessTurnTool} from "./resolveTurnShim.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import type {BusinessFrame, CapabilitySchema, ContextDelta, FieldResolution, FieldTurnIntent, ResolverContext} from "../../src/business-context/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
const inherited: FieldTurnIntent = {mode: "inherit", sourceText: null, expectedCount: null};
const explicit = (sourceText: string, expectedCount: number | null = null): FieldTurnIntent => ({mode: "set", sourceText, expectedCount});

async function fixture() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "field-intents-"));
  const sessions = new NativeSessionStore(path);
  const session = await sessions.create("synthetic-field-intents");
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const names = new Map([["A", "合成机构甲"], ["B", "合成机构乙"], ["C", "合成机构丙"], ["D", "合成机构丁"]]);
  const resolveCatalog = vi.fn(async (entity: string, values: string[]): Promise<FieldResolution> => {
    if (entity === "date") return {status: "resolved", value: {start: "2026-04-30", end: "2026-04-30"}};
    if (entity === "metric") return {status: "resolved", value: {codes: ["M"], names: ["合成指标"]}};
    if (values[0] === "近似机构") return {status: "needs_confirmation", candidates: [{code: "D", value: "合成机构丁"}]};
    const codes = values.map(value => names.has(value) ? value : [...names].find(([, name]) => name === value)?.[0]);
    return codes.every((code): code is string => !!code)
      ? {status: "resolved", value: {codes, names: codes.map(code => names.get(code)!)}} : {status: "not_found"};
  });
  const saved: BusinessFrame[] = [];
  for (const [index, organizations] of [["合成机构甲"], ["合成机构乙", "合成机构丙"]].entries()) {
    const id = {sessionId: session.metadata.id, turnId: `seed-${index}`, requestId: `seed-${index}`};
    const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: "合成指标"},
      {fieldHint: "organizations", operation: "set", rawValue: organizations},
      {fieldHint: "time", operation: "set", rawValue: "2026年4月末"},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
    ]};
    const ready = await service.resolve(delta, id, {originalMessage: `合成指标 ${organizations.join(" ")} 2026年4月末`,
      currentDate: "2026-10-13", turnId: id.turnId, resolveCatalog});
    saved.push(await service.finishExecution(await service.beginExecution(ready.frameId, id), {status: "success", resultRef: `query:${index}:result`}));
  }
  const basicQueries = vi.fn();
  const request = testRequestContext({resolveBusinessField: resolveCatalog, basicQueries} as unknown as BackendClient,
    new MemoryCommandBridge(), {sessionId: session.metadata.id, operationId: "current", requestId: "current", frames: store,
      originalMessage: "对以上三家机构进行排名，查看前2名"});
  const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "resolve_more", fieldChanges: []};
  const reference = {fromHistory: true, sourceText: "以上三家机构", combine: "union", sources: saved.map(frame => ({frame: {frameId: frame.frameId}, field: "organizations"}))};
  return {store, service, saved, resolveCatalog, request, delta, reference, basicQueries};
}

it.each([undefined, {}])("工具执行入口也拒绝缺少机构声明，不落盘、不执行：%j", async fieldIntents => {
  const f = await fixture();
  const before = await f.store.state();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, ...(fieldIntents ? {fieldIntents} : {})}, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INTENT_REQUIRED"});
  expect(await f.store.state()).toEqual(before);
  expect(f.basicQueries).not.toHaveBeenCalled();
});

it("声明以上三家发生变化却给空修改，不能误查焦点两家", async () => {
  const f = await fixture();
  const before = await f.store.state();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, executionMode: "execute",
    fieldIntents: {organizations: explicit("以上三家机构", 3)}}, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INTENT_MODE_MISMATCH"});
  expect(await f.store.state()).toEqual(before);
  expect(f.basicQueries).not.toHaveBeenCalled();
});

it("普通续接显式inherit保留焦点全量条件", async () => {
  const f = await fixture();
  const delta = {...f.delta, fieldIntents: {organizations: inherited}};
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), delta,
    {...f.request, originalMessage: "再查一次"}));
  expect(result.status).toBe("READY");
  const frame = (await f.store.get(String(result.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual(f.saved[1]!.fields.organizations?.resolvedValue);
  expect(frame.fields.time?.resolvedValue).toEqual(f.saved[1]!.fields.time?.resolvedValue);
});

it.each([2, 3, 4])("数量声明约束历史完整并集，不截断为%i家且与top_n分离", async expectedCount => {
  const f = await fixture();
  const delta = {...f.delta, fieldIntents: {organizations: explicit("以上三家机构", expectedCount)}, fieldChanges: [
    {fieldHint: "organizations", operation: "set" as const, rawValue: f.reference},
    {fieldHint: "operation", operation: "set" as const, rawValue: {kind: "ranking", position: "top", top_n: 2}},
  ]};
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), delta, f.request));
  const frame = (await f.store.get(String(result.frameId)))!;
  expect(frame.fields.organizations?.resolvedValue).toEqual({codes: ["A", "B", "C"], names: ["合成机构甲", "合成机构乙", "合成机构丙"]});
  expect(frame.fields.operation?.resolvedValue).toEqual({kind: "ranking", position: "top", top_n: 2});
  if (expectedCount === 3) expect(result.status).toBe("READY");
  else {
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(frame.fields.organizations).toMatchObject({resolutionStatus: "not_found", metadata: {referenceIssue: {
      code: "FIELD_INTENT_COUNT_MISMATCH", expectedCount, actualCount: 3}}});
    expect(frame.fields.time?.resolvedValue).toEqual(f.saved[1]!.fields.time?.resolvedValue);
  }
  expect(f.basicQueries).not.toHaveBeenCalled();
});

it("历史raw与目标声明数量冲突是参数错误，不能删掉任一约束绕过", async () => {
  const f = await fixture();
  const before = await f.store.state();
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, fieldIntents: {organizations: explicit("以上三家机构", 3)},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {...f.reference, expectedCount: 2}}]}, f.request));
  expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INTENT_COUNT_CONFLICT"});
  expect(await f.store.state()).toEqual(before);
});

it("确认候选保留初次目标数量，不能把两家目标确认成一家", async () => {
  const f = await fixture();
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, fieldIntents: {organizations: explicit("近似机构", 2)},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "近似机构"}]}, {...f.request, originalMessage: "查询近似机构这两家"}));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const confirmed = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldIntents: {organizations: {mode: "confirm", sourceText: "是", expectedCount: null}},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {confirm: true}}]},
    {...f.request, originalMessage: "是", operationId: "confirm", requestId: "confirm"}));
  expect(confirmed.status).toBe("NEEDS_CLARIFICATION");
  expect((await f.store.get(String(confirmed.frameId)))?.fields.organizations).toMatchObject({resolvedValue: {codes: ["D"]},
    metadata: {turnIntentExpectedCount: 2, referenceIssue: {actualCount: 1}}});
});

it("确认声明不能把保存的两家数量改成一家以绕过校验", async () => {
  const f = await fixture();
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, fieldIntents: {organizations: explicit("近似机构", 2)},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "近似机构"}]}, {...f.request, originalMessage: "查询近似机构这两家"}));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const before = {state: await f.store.state(), frames: await f.store.list()};
  const confirmed = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldIntents: {organizations: {mode: "confirm", sourceText: "是", expectedCount: 1}},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {confirm: true}}]},
    {...f.request, originalMessage: "是", operationId: "confirm-conflicting-count", requestId: "confirm-conflicting-count"}));
  expect(confirmed).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INTENT_COUNT_CONFLICT"});
  expect({state: await f.store.state(), frames: await f.store.list()}).toEqual(before);
  expect(f.basicQueries).not.toHaveBeenCalled();
});

it.each([null, 2])("同一历史组合续补保留原数量，null不清除且冲突%j不落盘", async expectedCount => {
  const f = await fixture();
  const source = {frame: {frameId: f.saved[0]!.frameId}, field: "organizations"};
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldIntents: {organizations: explicit("这家和合成机构乙、未知机构共三家", 3)},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {fromHistory: true, sourceText: "这家", combine: "union",
      sources: [source], expectedCount: 3, add: ["合成机构乙", "未知机构"]}}]},
    {...f.request, originalMessage: "这家和合成机构乙、未知机构共三家"}));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const before = {state: await f.store.state(), frames: await f.store.list()};
  const supplemented = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldIntents: {organizations: explicit("原组合", expectedCount)},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: {fromHistory: true, sourceText: "原组合", combine: "union",
      sources: [source], retainResolvedAdditions: true, replaceAdditions: [{index: 2, value: "合成机构甲"}]}}]},
    {...f.request, originalMessage: "原组合，未知机构改为合成机构甲，其余不变", operationId: "supplement-count", requestId: "supplement-count"}));
  if (expectedCount === null) {
    expect(supplemented.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(supplemented.frameId)))?.fields.organizations).toMatchObject({resolutionStatus: "not_found",
      rawValue: {expectedCount: 3, sources: [source]}, metadata: {turnIntentExpectedCount: 3,
        referenceSourceFrames: [f.saved[0]!.frameId], referenceResolvedAdditions: {codes: expect.arrayContaining(["B"])},
        referenceIssue: {expectedCount: 3, actualCount: 2}}});
  } else {
    expect(supplemented).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INTENT_COUNT_CONFLICT"});
    expect({state: await f.store.state(), frames: await f.store.list()}).toEqual(before);
  }
  expect(f.basicQueries).not.toHaveBeenCalled();
});

it.each([null, 1])("完整新set可明确更换目标，使用新数量%j而不锁住旧目标", async expectedCount => {
  const f = await fixture();
  const first = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, fieldIntents: {organizations: explicit("近似机构", 2)},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "近似机构"}]}, {...f.request, originalMessage: "查询近似机构这两家"}));
  expect(first.status).toBe("NEEDS_CLARIFICATION");
  const replaced = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta,
    fieldIntents: {organizations: explicit("改为合成机构甲", expectedCount)},
    fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成机构甲"}]},
    {...f.request, originalMessage: "改为合成机构甲", operationId: "replace-target", requestId: "replace-target"}));
  expect(replaced.status).toBe("READY");
  const organizations = (await f.store.get(String(replaced.frameId)))?.fields.organizations;
  expect(organizations).toMatchObject({resolvedValue: {codes: ["A"]}});
  if (expectedCount === null) expect(organizations?.metadata).not.toHaveProperty("turnIntentExpectedCount");
  else expect(organizations?.metadata).toMatchObject({turnIntentExpectedCount: 1});
  expect(f.basicQueries).not.toHaveBeenCalled();
});

it.each([
  {mode: "inherit", sourceText: "以上三家机构", expectedCount: null},
  {mode: "inherit", sourceText: null, expectedCount: 3},
  {mode: "set", sourceText: "并非本轮原文", expectedCount: 3},
])("拒绝无原文依据或伪装继承的声明：%j", async intent => {
  const f = await fixture();
  const changes = intent.mode === "set" ? [{fieldHint: "organizations", operation: "set", rawValue: f.reference}] : [];
  const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {...f.delta, fieldIntents: {organizations: intent}, fieldChanges: changes}, f.request));
  expect(result.status).toBe("ARGUMENT_ERROR");
  expect(f.basicQueries).not.toHaveBeenCalled();
});

it("旧内部Delta兼容，提供的新声明在legacy/compact之间无损", async () => {
  const f = await fixture();
  const id = {sessionId: f.request.sessionId, requestId: "internal", turnId: "internal"};
  const context = {originalMessage: "再查一次", turnId: id.turnId, currentDate: "2026-10-13", resolveCatalog: f.resolveCatalog};
  expect((await f.service.resolve(f.delta, id, context)).status).toBe("ready");
  const delta = {...f.delta, fieldIntents: {organizations: inherited}};
  expect(toContextDelta(delta)).toEqual(delta);
});

it("目标字段和集合属性由能力声明，集中校验不硬编码机构名称或字段名", () => {
  const schema: CapabilitySchema = {capability: "synthetic", tool: "synthetic", fields: {targets: {label: "合成目标", resolver: "synthetic",
    required: true, inheritable: true, requireTurnIntent: true, turnIntentCollection: "members"}}};
  const delta: ContextDelta = {executionMode: "resolve_more", fieldChanges: [{fieldHint: "targets", operation: "set", rawValue: "这四项"}],
    fieldIntents: {targets: explicit("这四项", 4)}};
  const context = {originalMessage: "用这四项", requireFieldIntents: true} as ResolverContext;
  expect(() => validateFieldIntents(schema, {...delta, fieldIntents: {}}, context)).toThrow("FIELD_INTENT_REQUIRED");
  expect(() => validateFieldIntents(schema, delta, context)).not.toThrow();
  const fields = {targets: {source: "explicit" as const, resolutionStatus: "resolved" as const, resolvedValue: {members: [1, 2, 3]}}};
  applyFieldIntentConstraints(schema, fields, delta);
  expect(fields.targets).toMatchObject({resolutionStatus: "not_found", resolvedValue: {members: [1, 2, 3]}, metadata: {referenceIssue: {expectedCount: 4, actualCount: 3}}});
});

describe.each([
  {capability: "synthetic_audience", requiredName: "audiences", optionalName: "secondary_scope", collection: "members"},
  {capability: "synthetic_participant", requiredName: "participants", optionalName: "comparison_basis", collection: "entries"},
])("通用字段声明兼容：$capability", ({capability, requiredName, optionalName, collection}) => {
  const schema: CapabilitySchema = {capability, tool: capability, fields: {
    [requiredName]: {label: "必需目标", resolver: "synthetic", required: true, inheritable: true, requireTurnIntent: true,
      turnIntentCollection: collection},
    [optionalName]: {label: "可选目标", resolver: "synthetic", required: false, inheritable: true, clearable: true,
      requireTurnIntent: true, turnIntentCollection: collection},
  }};
  const context: ResolverContext = {originalMessage: "改成这两项；删除后一项；清空；确认第一个", currentDate: "2026-10-14",
    turnId: "current", requireFieldIntents: true, resolveCatalog: async () => ({status: "not_found"})};
  const delta: ContextDelta = {capabilityHint: capability, executionMode: "resolve_more", fieldChanges: [],
    fieldIntents: {[requiredName]: inherited}};

  it.each([false, true])("未改变可选字段可省略声明：retain=%s", retain => {
    const continued = {...delta, fieldChanges: retain ? [{fieldHint: optionalName, operation: "retain" as const}] : []};
    expect(() => validateFieldIntents(schema, continued, context)).not.toThrow();
  });

  it.each([false, true])("必需字段未改变仍不能省略声明：retain=%s", retain => {
    const missing = {...delta, fieldIntents: {[optionalName]: inherited},
      fieldChanges: retain ? [{fieldHint: requiredName, operation: "retain" as const}] : []};
    expect(() => validateFieldIntents(schema, missing, context)).toThrow("FIELD_INTENT_REQUIRED");
  });

  it.each([
    {operation: "set" as const, rawValue: ["甲", "乙"], mode: "set" as const, sourceText: "改成这两项", expectedCount: 2},
    {operation: "remove" as const, rawValue: {index: 2}, mode: "remove" as const, sourceText: "删除后一项", expectedCount: null},
    {operation: "clear" as const, mode: "clear" as const, sourceText: "清空", expectedCount: null},
    {operation: "set" as const, rawValue: {confirm: true}, mode: "confirm" as const, sourceText: "确认第一个", expectedCount: null},
    {operation: "set" as const, rawValue: {candidateIndex: 1}, mode: "confirm" as const, sourceText: "确认第一个", expectedCount: null},
  ])("可选字段实际变化必须声明且保留操作校验：$mode/$rawValue", ({operation, rawValue, mode, sourceText, expectedCount}) => {
    const changed: ContextDelta = {...delta, fieldChanges: [{fieldHint: optionalName, operation, rawValue}]};
    expect(() => validateFieldIntents(schema, changed, context)).toThrow("FIELD_INTENT_REQUIRED");
    expect(() => validateFieldIntents(schema, {...changed, fieldIntents: {...delta.fieldIntents,
      [optionalName]: {mode, sourceText, expectedCount}}}, context)).not.toThrow();
  });

  it.each([
    {intent: {mode: "inherit", sourceText: "改成这两项", expectedCount: null}, error: "FIELD_INTENT_INVALID"},
    {intent: {mode: "inherit", sourceText: null, expectedCount: 2}, error: "FIELD_INTENT_INVALID"},
    {intent: {mode: "set", sourceText: "改成这两项", expectedCount: 2}, error: "FIELD_INTENT_MODE_MISMATCH"},
    {operation: "set", intent: {mode: "set", sourceText: "不在本轮的文字", expectedCount: 2}, error: "FIELD_INTENT_EVIDENCE_INVALID"},
    {operation: "set", intent: {mode: "set", sourceText: "改成这两项", expectedCount: 0}, error: "FIELD_INTENT_INVALID"},
    {operation: "clear", intent: {mode: "clear", sourceText: "清空", expectedCount: 2}, error: "FIELD_INTENT_COUNT_UNSUPPORTED"},
    {operation: "set", rawValue: {fromHistory: true, expectedCount: 1},
      intent: {mode: "set", sourceText: "改成这两项", expectedCount: 2}, error: "FIELD_INTENT_COUNT_CONFLICT"},
  ])("可选字段显式声明仍校验模式、来源与数量：$error/$intent", ({operation, rawValue, intent, error}) => {
    const invalid = {...delta, fieldChanges: operation ? [{fieldHint: optionalName, operation, rawValue}] : [],
      fieldIntents: {...delta.fieldIntents, [optionalName]: intent}} as ContextDelta;
    expect(() => validateFieldIntents(schema, invalid, context)).toThrow(error);
  });

  it("未知字段声明不能被当成可省略字段忽略", () => {
    expect(() => validateFieldIntents(schema, {...delta, fieldIntents: {...delta.fieldIntents,
      undeclared_field: inherited}}, context)).toThrow("FIELD_INTENT_INVALID");
  });

  it.each([true, false])("是否要求声明由requireTurnIntent独立决定：required=%s", required => {
    const noDeclaration: CapabilitySchema = {capability, tool: capability, fields: {
      [optionalName]: {...schema.fields[optionalName]!, required, requireTurnIntent: false},
    }};
    expect(() => validateFieldIntents(noDeclaration, {...delta, fieldIntents: {},
      fieldChanges: [{fieldHint: optionalName, operation: "set", rawValue: ["甲", "乙"]}]}, context)).not.toThrow();
  });

  it.each([
    {retain: false, expectedCount: 2}, {retain: true, expectedCount: 2},
    {retain: false, expectedCount: 3}, {retain: true, expectedCount: 3},
  ])("省略可选声明仍继承实际值和历史数量：retain=$retain/count=$expectedCount", async ({retain, expectedCount}) => {
    const base: BusinessFrame = {frameId: "saved-source", sessionId: "synthetic", turnId: "previous", requestId: "previous",
      capability, operationFrameId: "saved-source", status: "success", issues: [], createdAt: "2026-10-13T00:00:00Z", delta,
      fields: {
        [requiredName]: {source: "explicit", resolutionStatus: "resolved", resolvedValue: {[collection]: ["主目标"]}},
        [optionalName]: {source: "explicit", resolutionStatus: "resolved", rawValue: ["甲", "乙"],
          resolvedValue: {[collection]: ["甲", "乙"]}, metadata: {turnIntentExpectedCount: expectedCount, sourceMarker: "preserved"}},
      }};
    const before = structuredClone(base);
    const registry = new FieldResolverRegistry();
    const resolve = vi.fn(async (): Promise<FieldResolution> => ({status: "not_found"}));
    registry.register({name: "synthetic", supports: () => true, resolve});
    const continued = {...delta, fieldChanges: retain ? [{fieldHint: optionalName, operation: "retain" as const}] : []};
    expect(() => validateFieldIntents(schema, continued, context)).not.toThrow();
    const merged = await mergeFields(schema, base, continued, registry, context);
    applyFieldIntentConstraints(schema, merged.fields, continued, base);
    expect(merged.fields[optionalName]).toMatchObject({source: "inherited", sourceFrameId: base.frameId,
      rawValue: ["甲", "乙"], resolvedValue: {[collection]: ["甲", "乙"]},
      metadata: {turnIntentExpectedCount: expectedCount, sourceMarker: "preserved"}});
    const validation = validateFrame(schema, merged.fields, merged.issues);
    if (expectedCount === 2) expect(validation).toEqual({status: "READY", issues: []});
    else {
      expect(validation).toMatchObject({status: "NEEDS_CLARIFICATION", issues: [{field: optionalName, reason: "not_found"}]});
      expect(merged.fields[optionalName]?.metadata?.referenceIssue).toMatchObject({
        code: "FIELD_INTENT_COUNT_MISMATCH", expectedCount: 3, actualCount: 2});
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(base).toEqual(before);
  });
});
