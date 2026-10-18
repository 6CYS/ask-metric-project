import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {frameClarificationOptions, modelRecovery} from "../../src/business-context/modelView.js";
import {createExecuteBusinessFrameTool} from "../../src/tools/businessContext.js";
import {createResolveTurnShim as createResolveBusinessTurnTool} from "./resolveTurnShim.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import type {BusinessFrame, ContextDelta, FieldResolution, FieldTurnIntent} from "../../src/business-context/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
const inherited: FieldTurnIntent = {mode: "inherit", sourceText: null, expectedCount: null};
const july = {start: "2026-07-01", end: "2026-07-31"};
const august = {start: "2026-08-01", end: "2026-08-31"};

async function fixture(point: boolean, knownScope = false, reply = "合成利润金额") {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "confirmation-continuation-"));
  let sessions = new NativeSessionStore(path);
  const session = await sessions.create("synthetic-confirmation-user");
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  let store = new NativeFrameStore(session);
  const orgText = knownScope ? "合成机构甲和合成机构乙" : "模糊机构";
  const originalMessage = `查询模糊利润 ${orgText} 2026年7月`;
  const backend = {
    resolveBusinessField: vi.fn(async (entity: string, raw: string[]): Promise<FieldResolution> => {
      if (entity === "date") return {status: "resolved", value: raw[0] === "2026年8月" ? august : july};
      if (entity === "metric") return raw[0] === "M1"
        ? {status: "resolved", value: {codes: ["M1"], names: ["合成利润金额当日数"]}}
        : {status: "needs_confirmation", candidates: [{code: "M1", value: "合成利润金额当日数",
          metadata: {kind: "base", source_metric_code: "LOCAL:合成利润金额", base_name: "合成利润金额"}}]};
      if (raw[0] === "模糊机构") return {status: "needs_confirmation", candidates: [{code: "O1", value: "合成机构甲"}]};
      const codes = raw.map(value => value === "合成机构乙" || value === "O2" ? "O2" : "O1");
      return {status: "resolved", value: {codes, names: codes.map(code => code === "O1" ? "合成机构甲" : "合成机构乙")}};
    }),
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "synthetic-conversation"})),
    basicQueries: vi.fn(async () => ({result: {status: "succeeded", task_id: "synthetic-task", columns: [], rows: [], row_count: 0}})),
    getTask: vi.fn(async () => ({version: 1, result: {result_id: "synthetic-result"}})),
  };
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const first = await service.resolve({capabilityHint: "metric_query", baseReference: null, executionMode: "resolve_more",
    ...(knownScope ? {fieldIntents: {organizations: {mode: "set", sourceText: orgText, expectedCount: 2} as FieldTurnIntent}} : {}),
    fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: "模糊利润"},
      {fieldHint: "organizations", operation: "set", rawValue: knownScope ? ["合成机构甲", "合成机构乙"] : "模糊机构"},
      {fieldHint: "time", operation: "set", rawValue: "2026年7月"},
      {fieldHint: "selection", operation: "set", rawValue: knownScope ? "latest_in_range" : {clarify: true, sourceText: "2026年7月"}},
    ]}, {sessionId: session.metadata.id, turnId: "initial", requestId: "initial"},
  {originalMessage, currentDate: "2026-10-14", turnId: "initial", resolveCatalog: backend.resolveBusinessField});
  const option = frameClarificationOptions(first).flatMap(group => group.options).find(item => item.field === "metrics")!;
  const request = () => testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    frames: store, sessionId: session.metadata.id, operationId: "reply", requestId: "reply", originalMessage: reply,
    ...(point ? {clarificationSelection: {frame_id: first.frameId, option_ids: [option.id]}} : {}),
  });
  const tool = createResolveBusinessTurnTool();
  const run = (delta: ContextDelta) => runTool(tool, delta, request());
  const failedDelta: ContextDelta = {capabilityHint: "metric_query", baseReference: {frameId: first.frameId}, executionMode: "execute",
    fieldIntents: {organizations: {mode: "confirm", sourceText: orgText, expectedCount: null}}, fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: {confirm: true}},
      {fieldHint: "organizations", operation: "set", rawValue: {confirm: true, evidence: {decision: "accept", sourceText: orgText}}},
      {fieldHint: "selection", operation: "set", rawValue: {clarify: true, sourceText: "2026年7月"}},
    ]};
  const failed = async (delta = failedDelta) => {
    const receipt = receiptJson(await run(delta));
    const focus = await store.get((await store.state()).focusFrameId!);
    expect(focus?.recovery).toBeDefined();
    return {receipt, recovery: focus!};
  };
  const continued = (recovery: BusinessFrame): ContextDelta => ({capabilityHint: "metric_query", baseReference: {frameId: recovery.frameId},
    executionMode: "execute", fieldChanges: [], fieldIntents: {organizations: inherited, selection: inherited}});
  const reopen = async () => {
    await sessions.close(); sessions = new NativeSessionStore(path);
    store = new NativeFrameStore(await sessions.open("synthetic-confirmation-user", session.metadata));
  };
  return {first, backend, run, request, failed, failedDelta, continued, reopen, get store() {return store;}};
}

describe("确认恢复结构化续接", () => {
  it.each([false, true])("仅指标确认后取消无依据额外动作，保留其它澄清：point=%s", async point => {
    const f = await fixture(point);
    const {receipt, recovery} = await f.failed();
    expect(receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INTENT_EVIDENCE_INVALID",
      retry_reference: {frameId: recovery.frameId}, pending_fields: ["organizations", "selection"], confirmed_fields: ["metrics"],
      pending_changes: [{field: "organizations", operation: "set", may_retain: true}, {field: "selection", operation: "set", may_retain: true}]});
    expect(modelRecovery(recovery)).toMatchObject({retry_reference: {frameId: recovery.frameId},
      pending_fields: ["organizations", "selection"], confirmed_fields: ["metrics"]});
    expect(recovery.operationFrameId).toBe(f.first.operationFrameId);
    expect((await f.store.get(f.first.frameId))?.fields.metrics?.resolutionStatus).toBe("needs_confirmation");
    f.backend.resolveBusinessField.mockClear();
    const result = receiptJson(await f.run(f.continued(recovery)));
    expect(result).toMatchObject({status: "NEEDS_CLARIFICATION", issues: [{field: "organizations"}, {field: "selection"}]});
    const saved = (await f.store.get(String(result.frameId)))!;
    expect(saved).toMatchObject({parentFrameId: recovery.frameId, turnId: "reply",
      fields: {metrics: {resolutionStatus: "resolved", resolvedValue: {codes: ["M1"]}, sourceFrameId: recovery.frameId},
        organizations: {resolutionStatus: "needs_confirmation"}, time: {resolvedValue: july}, selection: {resolutionStatus: "ambiguous"}}});
    expect(saved.recovery).toBeUndefined();
    expect(f.backend.resolveBusinessField).not.toHaveBeenCalled();
    expect((await f.store.state()).focusFrameId).toBe(saved.frameId);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("刷新后仍保留确认、恢复来源与可取消字段", async () => {
    const f = await fixture(true);
    const {recovery} = await f.failed();
    await f.reopen();
    expect((await f.store.get(recovery.frameId))?.recovery).toEqual(recovery.recovery);
    const result = receiptJson(await f.run(f.continued(recovery)));
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(result.frameId)))?.fields.metrics?.resolvedValue).toMatchObject({codes: ["M1"]});
  });

  it("点选仅绑定指标，肯定展示文字不能顺带确认其它机构", async () => {
    const f = await fixture(true, false, "是");
    const {recovery} = await f.failed();
    expect(recovery.fields.organizations?.resolutionStatus).toBe("needs_confirmation");
    const result = receiptJson(await f.run(f.continued(recovery)));
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(result.frameId)))?.fields.organizations?.resolutionStatus).toBe("needs_confirmation");
  });

  it("自然回复不能只凭模型affirmation保存整份候选", async () => {
    const f = await fixture(false, false, "没问题");
    const before = await f.store.state();
    const failed = receiptJson(await f.run({...f.failedDelta, fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: {confirm: true, evidence: {decision: "accept", sourceText: "没问题"}}},
      ...f.failedDelta.fieldChanges.slice(1),
    ]}));
    expect(failed.status).toBe("ARGUMENT_ERROR");
    expect(await f.store.state()).toEqual(before);
    expect((await f.store.get(f.first.frameId))?.fields.metrics?.resolutionStatus).toBe("needs_confirmation");
  });

  it("省略全部pending不能自动放弃其它失败提案", async () => {
    const f = await fixture(true);
    const {recovery} = await f.failed();
    const before = await f.store.state();
    const delta = {...f.continued(recovery), fieldIntents: {organizations: inherited}};
    const result = receiptJson(await f.run(delta));
    expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "TURN_CHANGES_PENDING", field: "selection",
      pending_fields: ["organizations", "selection"]});
    expect(await f.store.state()).toEqual(before);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it.each([false, true])("本轮真实日期变化不能被inherit/retain吞掉：retain=%s", async retain => {
    const f = await fixture(true, false, "合成利润金额，日期改成2026年8月");
    const delta = {...f.failedDelta, fieldChanges: [...f.failedDelta.fieldChanges, {fieldHint: "time", operation: "set" as const, rawValue: "2026年8月"}]};
    const {recovery} = await f.failed(delta);
    const bad = {...f.continued(recovery), fieldIntents: {organizations: inherited, selection: inherited, time: inherited},
      fieldChanges: retain ? [{fieldHint: "time", operation: "retain" as const}] : []};
    const result = receiptJson(await f.run(bad));
    expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: "TURN_CHANGES_PENDING", field: "time",
      pending_changes: expect.arrayContaining([expect.objectContaining({field: "time", operation: "set", source_text: "2026年8月", may_retain: false})])});
    const corrected = {...f.continued(recovery), fieldChanges: [{fieldHint: "time", operation: "set" as const, rawValue: "2026年8月"}]};
    const saved = receiptJson(await f.run(corrected));
    expect(saved.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(saved.frameId)))?.fields.time?.resolvedValue).toEqual(august);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("机构真实变化不能靠合法inherit或retain取消，修正后保留新机构", async () => {
    const f = await fixture(true, false, "合成利润金额，机构改成合成机构乙");
    const delta: ContextDelta = {...f.failedDelta,
      fieldIntents: {organizations: {mode: "set", sourceText: "合成机构乙", expectedCount: 1}}, fieldChanges: [
        {fieldHint: "metrics", operation: "set", rawValue: {confirm: true}},
        {fieldHint: "organizations", operation: "set", rawValue: "合成机构乙"},
        {fieldHint: "time", operation: "set", rawValue: "2026年7月"},
      ]};
    const {recovery} = await f.failed(delta);
    for (const fieldChanges of [[], [{fieldHint: "organizations", operation: "retain" as const}]]) {
      const rejected = receiptJson(await f.run({...f.continued(recovery), fieldIntents: {organizations: inherited, time: inherited}, fieldChanges}));
      expect(rejected).toMatchObject({status: "ARGUMENT_ERROR", error_code: "TURN_CHANGES_PENDING", field: "organizations"});
    }
    const result = receiptJson(await f.run({...f.continued(recovery), fieldIntents: {...delta.fieldIntents, time: inherited},
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成机构乙"}]}));
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(result.frameId)))?.fields.organizations).toMatchObject({resolvedValue: {codes: ["O2"]},
      metadata: {turnIntentExpectedCount: 1}});
  });

  it("失败提案中的本轮数量不能在恢复时用null或新数量删掉", async () => {
    const sourceText = "合成机构甲和合成机构乙共两家";
    const f = await fixture(true, false, `合成利润金额，机构改成${sourceText}`);
    const input: ContextDelta = {...f.failedDelta, fieldIntents: {organizations: {mode: "set", sourceText, expectedCount: 2}},
      fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: {confirm: true}},
        {fieldHint: "organizations", operation: "set", rawValue: ["合成机构甲", "合成机构乙"]},
        {fieldHint: "time", operation: "set", rawValue: "2026年7月"}]};
    const {recovery} = await f.failed(input);
    const corrected: ContextDelta = {...f.continued(recovery), fieldIntents: {
      organizations: {mode: "set", sourceText, expectedCount: null}, time: inherited},
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成机构乙"}]};
    const conflict = receiptJson(await f.run({...corrected, fieldIntents: {...corrected.fieldIntents,
      organizations: {mode: "set", sourceText, expectedCount: 1}}}));
    expect(conflict).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INTENT_COUNT_CONFLICT"});
    const incomplete = receiptJson(await f.run(corrected));
    expect(incomplete.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(incomplete.frameId)))?.fields.organizations).toMatchObject({resolutionStatus: "not_found",
      metadata: {turnIntentExpectedCount: 2, referenceIssue: {expectedCount: 2, actualCount: 1}}});
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it.each([null, 99])("已有全量数量不变，无依据额外数量%j不会锁入恢复，可执行一次", async expectedCount => {
    const f = await fixture(true, true);
    const {recovery} = await f.failed({...f.failedDelta, fieldIntents: {organizations: {
      ...f.failedDelta.fieldIntents!.organizations!, expectedCount}}});
    expect(recovery.recovery?.pendingChanges?.find(item => item.field === "organizations")?.expectedCount).toBeUndefined();
    const result = receiptJson(await f.run(f.continued(recovery)));
    expect(result.status).toBe("READY");
    expect((await f.store.get(String(result.frameId)))?.fields.organizations).toMatchObject({resolvedValue: {codes: ["O1", "O2"]},
      metadata: {turnIntentExpectedCount: 2}});
    await runTool(createExecuteBusinessFrameTool(), {frameId: result.frameId}, f.request());
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect((f.backend.basicQueries.mock.calls as unknown[][])[0]?.[0]).toMatchObject({org_codes: ["O1", "O2"], metric_codes: ["M1"], time: july});
  });

  it("旧无provenance草稿仍要求明确处理，显式retain兼容且不吞省略项", async () => {
    const f = await fixture(true);
    const {recovery} = await f.failed();
    const legacy = structuredClone(recovery);
    legacy.frameId = "legacy-recovery"; legacy.parentFrameId = recovery.frameId;
    delete (legacy.recovery as unknown as Record<string, unknown>).pendingChanges;
    await f.store.save(legacy, (await f.store.state()).version, "legacy-recovery");
    const omitted = receiptJson(await f.run(f.continued(legacy)));
    expect(omitted).toMatchObject({status: "ARGUMENT_ERROR", error_code: "TURN_CHANGES_PENDING",
      pending_fields: ["organizations", "selection"]});
    const explicit = receiptJson(await f.run({...f.continued(legacy), fieldChanges: [
      {fieldHint: "organizations", operation: "retain"}, {fieldHint: "selection", operation: "retain"},
    ]}));
    expect(explicit.status).toBe("NEEDS_CLARIFICATION");
  });

  it("不能切回旧Frame或更换点选来源以绕过待修提案", async () => {
    const f = await fixture(true);
    const {recovery} = await f.failed();
    const before = await f.store.state();
    const old = receiptJson(await f.run({...f.continued(recovery), baseReference: {frameId: f.first.frameId}}));
    expect(old).toMatchObject({status: "ARGUMENT_ERROR", error_code: "TURN_RECOVERY_REFERENCE_REQUIRED",
      retry_reference: {frameId: recovery.frameId}, pending_fields: ["organizations", "selection"]});
    expect(await f.store.state()).toEqual(before);
    const badSelection = {...f.request(), clarificationSelection: {frame_id: "foreign-frame", option_ids: ["metrics:0:code:M1"]}};
    const invalid = receiptJson(await runTool(createResolveBusinessTurnTool(),
      f.continued(recovery), badSelection));
    expect(invalid.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(invalid.frameId)))?.fields.organizations?.resolutionStatus).toBe("needs_confirmation");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it.each(["foreign_session", "old_frame"])("失效点选%s不回退到自然文字匹配其它Frame", async source => {
    const f = await fixture(true);
    const other = await fixture(true);
    const optionId = frameClarificationOptions(other.first).flatMap(group => group.options).find(item => item.field === "metrics")!.id;
    let base = f.first;
    if (source === "old_frame") {
      const keepPending: ContextDelta = {capabilityHint: "metric_query", baseReference: {frameId: f.first.frameId},
        executionMode: "resolve_more", fieldChanges: [], fieldIntents: {organizations: inherited}};
      const latest = receiptJson(await runTool(createResolveBusinessTurnTool(),
        keepPending,
        {...f.request(), clarificationSelection: {frame_id: other.first.frameId, option_ids: [optionId]}}));
      base = (await f.store.get(String(latest.frameId)))!;
    }
    const selection = {frame_id: source === "foreign_session" ? other.first.frameId : f.first.frameId, option_ids: [optionId]};
    const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: {frameId: base.frameId}, executionMode: "execute",
      fieldIntents: {organizations: inherited}, fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: {confirm: true}}]};
    const result = receiptJson(await runTool(createResolveBusinessTurnTool(),
      delta, {...f.request(), originalMessage: "合成利润金额", clarificationSelection: selection}));
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    const saved = (await f.store.get(String(result.frameId)))!;
    expect(saved.fields.metrics?.resolutionStatus).toBe("needs_confirmation");
    expect(saved.fields.organizations?.resolutionStatus).toBe("needs_confirmation");
    expect(saved.fields.time?.resolvedValue).toEqual(july);
    expect(saved.sessionId).not.toBe(other.first.sessionId);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    expect(other.backend.basicQueries).not.toHaveBeenCalled();
  });
});
