import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {BusinessInputError} from "../../src/business-context/inputError.js";
import {createResolveBusinessTurnTool} from "../../src/tools/businessContext.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import type {ContextDelta, FieldResolution, ResolverContext} from "../../src/business-context/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});

async function fixture(organization: FieldResolution = {status: "needs_confirmation", candidates: [{value: "合成机构甲全称", code: "O1"}]}) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "confirmation-recovery-"));
  const sessions = new NativeSessionStore(path);
  const session = await sessions.create("synthetic-user");
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
  const identity = {sessionId: session.metadata.id, turnId: "initial", requestId: "initial"};
  const resolveCatalog = vi.fn<ResolverContext["resolveCatalog"]>(async (entity, raw) => {
    if (entity === "organization") return raw[0] === "O1" ? {status: "resolved", value: {codes: ["O1"], names: ["合成机构甲全称"]}} : organization;
    return {status: "resolved", value: entity === "date" ? (raw[0] === "2026年4月末" ? {start: "2026-04-30", end: "2026-04-30"} : {start: "2026-02-28", end: "2026-02-28"}) : {codes: ["M1"], names: raw}};
  });
  const context: ResolverContext = {originalMessage: "合成指标 合成机构 2026年2月28日", currentDate: "2026-10-13", turnId: identity.turnId, resolveCatalog};
  const initial: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: "合成指标"},
    {fieldHint: "organizations", operation: "set", rawValue: "合成机构"},
    {fieldHint: "time", operation: "set", rawValue: "2026年2月28日"},
    {fieldHint: "selection", operation: "set", rawValue: "exact"},
  ]};
  const first = await service.resolve(initial, identity, context);
  const confirm = (reply: string, rawValue: unknown = {confirm: true}, extra: Partial<ResolverContext> = {}) => service.resolve({
    executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue}],
  }, {...identity, turnId: `reply:${reply}`, requestId: `reply:${reply}`}, {...context, originalMessage: reply, turnId: `reply:${reply}`, ...extra});
  return {service, store, first, identity, context, confirm, resolveCatalog};
}

describe("已保存候选的跨轮确认", () => {
  it.each(["是", "是的", "可以", "没错", "就是这个"])("单候选仅在用户明确肯定“%s”时确定，保留原条件", async reply => {
    const f = await fixture();
    const confirmed = await f.confirm(reply);
    expect(confirmed.status).toBe("ready");
    expect(confirmed.fields.organizations).toMatchObject({resolutionStatus: "resolved", source: "confirmed", resolvedValue: {codes: ["O1"]}});
    expect(confirmed.fields.metrics?.sourceFrameId).toBe(f.first.frameId);
    expect(confirmed.fields.time?.resolvedValue).toEqual({start: "2026-02-28", end: "2026-02-28"});
    expect(f.resolveCatalog).toHaveBeenCalledWith("organization", ["O1"]);
  });

  it.each(["不是", "不是合成机构甲全称", "不要第一个", "把日期改为2026年4月末", "是，但不是合成机构甲全称", "日期改为4月末，不是合成机构甲全称", "先等等"])("单候选不能因模型 confirm 或 candidateIndex 把“%s”当确认", async reply => {
    const f = await fixture();
    f.resolveCatalog.mockClear();
    const pending = await f.confirm(reply, {candidateIndex: 1});
    expect(pending.status).toBe("clarifying");
    expect(pending.fields.organizations).toMatchObject({resolutionStatus: "needs_confirmation", candidates: [{code: "O1"}], metadata: {confirmationUnclear: true}});
    expect(f.resolveCatalog).not.toHaveBeenCalled();
  });

  it("纯肯定不能替多个候选作选择；前端绑定当前 Frame 的点选仍有效", async () => {
    const f = await fixture({status: "ambiguous", candidates: [{value: "合成机构甲", code: "O1"}, {value: "合成机构乙", code: "O2"}]});
    const pending = await f.confirm("是", {candidateIndex: 1});
    expect(pending.fields.organizations?.resolutionStatus).toBe("ambiguous");
    const selected = await f.confirm("这个", {confirm: true}, {replyEvidence: async frameId => ({reply: "这个",
      optionIds: frameId === pending.frameId ? ["organizations:0:code:O1"] : []})});
    expect(selected.fields.organizations).toMatchObject({resolutionStatus: "resolved", resolvedValue: {codes: ["O1"]}});
  });

  it.each(["没问题，日期改为2026年4月末", "Yes, move the date to 2026年4月末"])("语义证据支持复合肯定及同轮日期修改：%s", async reply => {
    const f = await fixture();
    const confirmed = await f.service.resolve({executionMode: "execute", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: {confirm: true, evidence: {decision: "accept", sourceText: reply}}},
      {fieldHint: "time", operation: "set", rawValue: "2026年4月末"},
    ]}, {...f.identity, turnId: "compound", requestId: "compound"}, {...f.context, originalMessage: reply, turnId: "compound"});
    expect(confirmed.status).toBe("ready");
    expect(confirmed.fields.organizations).toMatchObject({source: "confirmed", resolvedValue: {codes: ["O1"]}});
    expect(confirmed.fields.time?.resolvedValue).toEqual({start: "2026-04-30", end: "2026-04-30"});
    expect(confirmed.fields.metrics?.sourceFrameId).toBe(f.first.frameId);
  });

  it("语义证据不能覆盖同句否定，也不能替多个候选选择", async () => {
    const f = await fixture();
    const reply = "不是合成机构甲全称，换一个";
    const rejected = await f.confirm(reply, {confirm: true, evidence: {decision: "accept", sourceText: reply}});
    expect(rejected.fields.organizations).toMatchObject({resolutionStatus: "needs_confirmation", metadata: {confirmationUnclear: true}});
    const multiple = await fixture({status: "ambiguous", candidates: [{value: "合成机构甲", code: "O1"}, {value: "合成机构乙", code: "O2"}]});
    const unclear = await multiple.confirm("没问题", {confirm: true, evidence: {decision: "accept", sourceText: "没问题"}});
    expect(unclear.fields.organizations?.resolutionStatus).toBe("ambiguous");
  });

  it.each([
    {decision: "accept", sourceText: "上一轮同意"},
    {decision: "accept", sourceText: "  "},
    {decision: "choose", sourceText: "没问题"},
    {decision: "accept", sourceText: "没问题", candidateCode: "O1"},
  ])("无效或不在本轮的语义证据是可修复参数错误且不落盘：%j", async evidence => {
    const f = await fixture();
    const state = await f.store.state();
    await expect(f.confirm("没问题", {confirm: true, evidence})).rejects.toMatchObject({code: "CONFIRMATION_EVIDENCE_INVALID"});
    expect(await f.store.state()).toEqual(state);
  });

  it("同轮伪确认要求询问用户且不保存新 Frame", async () => {
    const f = await fixture();
    const state = await f.store.state();
    await expect(f.service.resolve({executionMode: "execute", fieldChanges: [
      {fieldHint: "organizations", operation: "set", rawValue: {confirm: true}},
    ]}, f.identity, f.context)).rejects.toMatchObject({code: "CONFIRMATION_REQUIRES_USER_TURN", recovery: {action: "ask_user"}});
    expect(await f.store.state()).toEqual(state);
  });
});

describe("未决字段的恢复依据", () => {
  it.each([
    {entry: "service", mode: "set", sourceText: "更早的机构组合", reply: "是", shape: "history", code: "HISTORY_REFERENCE_EVIDENCE_MISSING", recovery: true},
    {entry: "tool", mode: "set", sourceText: "更早的机构组合", reply: "是", shape: "history", code: "HISTORY_REFERENCE_EVIDENCE_MISSING", recovery: true},
    {entry: "service", mode: "confirm", sourceText: "是", reply: "是", shape: "history", code: "FIELD_INTENT_MODE_MISMATCH", recovery: false},
    {entry: "tool", mode: "confirm", sourceText: "是", reply: "是", shape: "history", code: "FIELD_INTENT_MODE_MISMATCH", recovery: false},
    {entry: "service", mode: "confirm", sourceText: "前面两次的机构", reply: "用前面两次的机构合并排名", shape: "history", code: "FIELD_INTENT_MODE_MISMATCH", recovery: false},
    {entry: "tool", mode: "confirm", sourceText: "前面两次的机构", reply: "用前面两次的机构合并排名", shape: "history", code: "FIELD_INTENT_MODE_MISMATCH", recovery: false},
    {entry: "service", mode: "confirm", sourceText: "是", reply: "是", shape: "confirm", code: "INVALID_CANDIDATE_REFERENCE", recovery: true},
    {entry: "tool", mode: "confirm", sourceText: "是", reply: "是", shape: "candidateIndex", code: "INVALID_CANDIDATE_REFERENCE", recovery: true},
  ] as const)("$entry：无候选时 $shape / $mode / $sourceText 返回 $code，目录及保存状态不变", async ({entry, mode, sourceText, reply, shape, code, recovery}) => {
    const f = await fixture({status: "not_found", candidates: []});
    const sources = [];
    for (const [index, codes] of [["H1"], ["H2", "H3"]].entries()) {
      const frameId = `trusted-history-${index}`;
      const source = await f.store.save({...f.first, frameId, operationFrameId: frameId, turnId: frameId, requestId: frameId,
        status: "ready", fields: {...f.first.fields, organizations: {resolutionStatus: "resolved", source: "resolved",
          resolvedValue: {codes, names: codes.map(code => `合成${code}`)}}}, issues: []}, (await f.store.state()).version, frameId, false);
      sources.push({frame: {frameId: source.frameId}, field: "organizations"});
    }
    const rawValue = shape === "history" ? {fromHistory: true, sourceText, sources, combine: "union", expectedCount: 3}
      : shape === "confirm" ? {confirm: true} : {candidateIndex: 1};
    const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: entry === "tool" ? "current" : {frameId: f.first.frameId},
      executionMode: "execute", fieldIntents: {organizations: {mode, sourceText, expectedCount: 3}},
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue}]};
    const before = {state: await f.store.state(), frames: await f.store.list()};
    const resolveFieldReference = vi.fn<NonNullable<ResolverContext["resolveFieldReference"]>>();
    const basicQueries = vi.fn();
    f.resolveCatalog.mockClear();
    if (entry === "service") {
      await expect(f.service.resolve(delta, {...f.identity, turnId: "recovery-preflight", requestId: "recovery-preflight"},
        {...f.context, originalMessage: reply, turnId: "recovery-preflight", requireFieldIntents: true, resolveFieldReference}))
        .rejects.toMatchObject({code, ...(recovery ? {baseReference: {frameId: f.first.frameId}, recovery: {action: "ask_user"}} : {recovery: undefined})});
    } else {
      const result = await runTool(createResolveBusinessTurnTool(), delta,
        testRequestContext({resolveBusinessField: f.resolveCatalog, basicQueries} as unknown as BackendClient, new MemoryCommandBridge(),
          {frames: f.store, sessionId: f.identity.sessionId, operationId: "recovery-preflight", requestId: "recovery-preflight", originalMessage: reply}));
      if (recovery) {
        expect(receiptJson(result)).toMatchObject({status: "NEEDS_CLARIFICATION", error_code: code, frameId: f.first.frameId,
          retryable: false, next_action: "ask_user", focus_preserved: true});
        expect(result.details).toMatchObject({status: "NEEDS_CLARIFICATION", frame_id: f.first.frameId, retryable: false});
      } else expect(receiptJson(result)).toMatchObject({status: "ARGUMENT_ERROR", error_code: code});
    }
    expect(resolveFieldReference).not.toHaveBeenCalled();
    expect(f.resolveCatalog).not.toHaveBeenCalled(); expect(basicQueries).not.toHaveBeenCalled();
    expect({state: await f.store.state(), frames: await f.store.list()}).toEqual(before);
  });

  it.each([
    {raw: "合成机构甲全称", mode: "set", sourceText: "旧声明原文", code: "FIELD_INTENT_EVIDENCE_INVALID"},
    {raw: "合成机构甲全称", mode: "confirm", sourceText: "合成机构甲全称", code: "FIELD_INTENT_MODE_MISMATCH"},
  ] as const)("真实新名称的声明错误仍可纠正参数：$code", async ({raw, mode, sourceText, code}) => {
    const f = await fixture({status: "not_found", candidates: []});
    const before = {state: await f.store.state(), frames: await f.store.list()};
    f.resolveCatalog.mockClear();
    const result = receiptJson(await runTool(createResolveBusinessTurnTool(), {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldIntents: {organizations: {mode, sourceText, expectedCount: null}},
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: raw}]},
    testRequestContext({resolveBusinessField: f.resolveCatalog} as unknown as BackendClient, new MemoryCommandBridge(),
      {frames: f.store, sessionId: f.identity.sessionId, operationId: "new-name", requestId: "new-name", originalMessage: "合成机构甲全称"})));
    expect(result).toMatchObject({status: "ARGUMENT_ERROR", error_code: code});
    expect(f.resolveCatalog).not.toHaveBeenCalled();
    expect({state: await f.store.state(), frames: await f.store.list()}).toEqual(before);
  });

  it("恢复预检不替模型补缺失的必填声明，有效本轮历史原文的声明错误仍可修复", async () => {
    const f = await fixture({status: "not_found", candidates: []});
    const reference = {fromHistory: true, sourceText: "本轮历史指代", sources: [{frame: {frameId: f.first.frameId}, field: "organizations"}], combine: "single"};
    const resolveFieldReference = vi.fn<NonNullable<ResolverContext["resolveFieldReference"]>>();
    const before = await f.store.state();
    const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: reference}]};
    const context = {...f.context, originalMessage: reference.sourceText, turnId: "valid-reference", requireFieldIntents: true, resolveFieldReference};
    await expect(f.service.resolve(delta, {...f.identity, turnId: context.turnId}, context)).rejects.toMatchObject({code: "FIELD_INTENT_REQUIRED", recovery: undefined});
    await expect(f.service.resolve({...delta, fieldIntents: {organizations: {mode: "set", sourceText: "旧声明原文", expectedCount: null}}},
      {...f.identity, turnId: context.turnId}, context)).rejects.toMatchObject({code: "FIELD_INTENT_EVIDENCE_INVALID", recovery: undefined});
    expect(resolveFieldReference).not.toHaveBeenCalled(); expect(await f.store.state()).toEqual(before);
  });

  it("没有候选的口头同意要求补充条件，不落盘、不误用历史名称", async () => {
    const f = await fixture({status: "not_found"});
    const state = await f.store.state();
    await expect(f.confirm("是", {confirm: true})).rejects.toMatchObject({recovery: {action: "ask_user", message: expect.stringContaining("具体机构名称")}});
    expect(await f.store.state()).toEqual(state);
    // 原文错误仍可由模型改为有来源的结构化引用，不能提前强迫用户重述。
    const wrongName = await f.confirm("前面两次用过的机构", "合成机构甲全称").catch(error => error);
    expect(wrongName).toMatchObject({code: "FIELD_INPUT_NOT_CURRENT", recovery: undefined});
    expect(wrongName.correction).toContain("结构化字段引用");
    expect(await f.store.state()).toEqual(state);
    expect((await f.store.get(f.first.frameId))?.fields.organizations).toMatchObject({rawValue: "合成机构", resolutionStatus: "not_found"});
  });

  it("无候选时旧指代原文不能修复本轮口头同意，当前有效引用仍可继续解析", async () => {
    const f = await fixture({status: "not_found"});
    const state = await f.store.state();
    const resolveFieldReference = vi.fn<NonNullable<ResolverContext["resolveFieldReference"]>>(async () => ({status: "resolved", value: {codes: ["O1"], names: ["合成机构甲全称"]}}));
    const reference = {fromHistory: true, sourceText: "前一次使用的机构", sources: [{frame: {frameId: f.first.frameId}, field: "organizations"}], combine: "single"};
    await expect(f.confirm("是", reference, {resolveFieldReference})).rejects.toMatchObject({code: "HISTORY_REFERENCE_EVIDENCE_MISSING", recovery: {action: "ask_user"}});
    expect(resolveFieldReference).not.toHaveBeenCalled();
    expect(await f.store.state()).toEqual(state);
    const repaired = await f.confirm(reference.sourceText, reference, {resolveFieldReference});
    expect(resolveFieldReference).toHaveBeenCalledWith(reference, "organizations", "explicit", f.first.fields.organizations);
    expect(repaired.fields.organizations?.resolvedValue).toEqual({codes: ["O1"], names: ["合成机构甲全称"]});
  });

  it("没有保存候选时，带语义同意证据仍须询问用户且不落盘", async () => {
    const f = await fixture({status: "not_found"});
    const state = await f.store.state();
    await expect(f.confirm("没问题", {confirm: true, evidence: {decision: "accept", sourceText: "没问题"}}))
      .rejects.toMatchObject({code: "INVALID_CANDIDATE_REFERENCE", recovery: {action: "ask_user"}});
    expect(await f.store.state()).toEqual(state);
  });

  it("已确定字段收到 confirm 时要求修正调用，不能伪装成用户澄清", async () => {
    const f = await fixture({status: "resolved", value: {codes: ["O1"], names: ["合成机构甲全称"]}});
    const error = await f.confirm("是").catch(error => error);
    expect(error).toBeInstanceOf(BusinessInputError);
    expect(error).toMatchObject({code: "INVALID_CANDIDATE_REFERENCE", recovery: undefined});
    expect(error.correction).toContain("retain");
  });

  it("原文错误的修复提示仅在存在有效候选时建议 confirm", async () => {
    const f = await fixture();
    const error = await f.confirm("是", "合成机构甲全称").catch(error => error);
    expect(error).toMatchObject({code: "FIELD_INPUT_NOT_CURRENT", recovery: undefined});
    expect(error.correction).toContain("{confirm:true}");
  });
});
