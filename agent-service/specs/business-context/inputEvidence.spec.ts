import {describe, expect, it, vi} from "vitest";
import {hasInputEvidence, normalizeInputEvidence} from "../../src/business-context/inputEvidence.js";
import {FieldResolverRegistry, mergeFields, preflightFieldRecovery, validateFieldIntents} from "../../src/business-context/core.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {resolveHistoryFieldReference, type HistoryReferenceContext} from "../../src/business-context/historyReferences.js";
import {BusinessInputError} from "../../src/business-context/inputError.js";
import type {BusinessFrame, CapabilitySchema, ContextDelta, ResolverContext} from "../../src/business-context/types.js";

describe("本轮原文证据的格式等价", () => {
  it.each([
    ["查询 2026 年 7 月", "2026年7月"],
    ["查询２０２６年７月", "2026年7月"],
    ["  YES,\tplease proceed\n", "yes, please proceed"],
  ])("接受既有格式差异：%s / %s", (original, evidence) => {
    expect(hasInputEvidence(original, evidence)).toBe(true);
  });

  it.each([
    ["不是2026年7月", "不是2026年7月"],
    ["但是2026年7月末", "但是2026年7月末"],
    ["2026年7月最后一个交易日", "2026年7月最后一个交易日"],
  ])("归一化保留否定、转折和日期限定：%s", (text, expected) => {
    expect(normalizeInputEvidence(text)).toBe(expected);
  });

  it.each([
    ["查询2026年7月", " \t\n　"],
    ["查询2026年7月", "2025年7月"],
    ["查询2026年7月", "2026年8月"],
    ["查询2026年7月", "2026年7月末"],
    ["没问题", "上一轮助手的同意文字"],
    ["查询合成机构甲", "SYNTHETIC_ORG_CODE"],
  ])("不把格式归一化用作缺失文字的兜底：%s / %s", (original, evidence) => {
    expect(hasInputEvidence(original, evidence)).toBe(false);
  });
});

const dateSchema: CapabilitySchema = {capability: "synthetic_date", tool: "synthetic", fields: {
  time: {label: "日期", resolver: "date", required: true, inheritable: true, requireTurnIntent: true},
}};
const dateDelta = (sourceText: string): ContextDelta => ({executionMode: "resolve_more",
  fieldIntents: {time: {mode: "set", sourceText, expectedCount: null}},
  fieldChanges: [{fieldHint: "time", operation: "set", rawValue: sourceText}]});

describe("目标声明与字段解析共用本轮来源校验", () => {
  it.each(["2026 年 7 月", "２０２６年７月", "2026\t年\n7 月"])("日期声明和解析都接受%s，不自行换算原值", async date => {
    const resolveCatalog = vi.fn(async () => ({status: "resolved" as const, value: {start: "2026-07-01", end: "2026-07-31"}}));
    const context: ResolverContext = {originalMessage: `查询${date}`, currentDate: "2026-10-13", turnId: "now", requireFieldIntents: true, resolveCatalog};
    const delta = dateDelta("2026年7月");
    expect(() => validateFieldIntents(dateSchema, delta, context)).not.toThrow();
    const result = await mergeFields(dateSchema, undefined, delta, createFieldResolvers(), context);
    expect(result.fields.time).toMatchObject({resolutionStatus: "resolved", rawValue: "2026年7月"});
    expect(resolveCatalog).toHaveBeenCalledWith("date", ["2026年7月"], undefined, undefined);
  });

  it.each(["2025年7月", "2026年8月", "2026年7月末", "上轮助手说的日期"])("不同日期或旧文字%s仍拒绝且不查目录", async evidence => {
    const resolveCatalog = vi.fn();
    const context: ResolverContext = {originalMessage: "查询2026 年 7 月", currentDate: "2026-10-13", turnId: "now", requireFieldIntents: true, resolveCatalog};
    const delta = dateDelta(evidence);
    expect(() => validateFieldIntents(dateSchema, delta, context)).toThrow("FIELD_INTENT_EVIDENCE_INVALID");
    await expect(mergeFields(dateSchema, undefined, delta, createFieldResolvers(), context)).rejects.toMatchObject({code: "FIELD_INPUT_NOT_CURRENT"});
    expect(resolveCatalog).not.toHaveBeenCalled();
  });
});

const organizationSchema: CapabilitySchema = {capability: "synthetic_org", tool: "synthetic", fields: {
  organizations: {label: "机构", resolver: "organization", required: true, inheritable: true},
}};
it.each(["、", ",", "，"])("机构清单按成员校验原文来源，允许模型使用%s分隔", async separator => {
  const resolveCatalog = vi.fn(async () => ({status: "resolved" as const, value: {codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"]}}));
  const schema = organizationSchema.fields.organizations!;
  const result = await createFieldResolvers().getResolver(schema).resolve(`合成机构甲${separator}合成机构乙`, schema,
    {originalMessage: "合成机构甲和合成机构乙最近经营如何？", currentDate: "2026-10-22", turnId: "multi", resolveCatalog});
  expect(result.status).toBe("resolved");
  expect(resolveCatalog).toHaveBeenCalledWith("organization", ["合成机构甲", "合成机构乙"]);
});
it.each(["合成机构甲,合成机构丙", "合成机构甲,,合成机构乙", "合成机构甲,"])("不丢弃缺乏原文依据或空白的机构成员：%s", async value => {
  const resolveCatalog = vi.fn(), schema = organizationSchema.fields.organizations!;
  await expect(createFieldResolvers().getResolver(schema).resolve(value, schema,
    {originalMessage: "合成机构甲和合成机构乙最近经营如何？", currentDate: "2026-10-22", turnId: "invalid-multi", resolveCatalog}))
    .rejects.toMatchObject({code: "FIELD_INPUT_NOT_CURRENT"});
  expect(resolveCatalog).not.toHaveBeenCalled();
});
it("机构清单中的未知成员保留交由目录裁决，不静默缩小到已知机构", async () => {
  const resolveCatalog = vi.fn(async () => ({status: "not_found" as const})), schema = organizationSchema.fields.organizations!;
  const result = await createFieldResolvers().getResolver(schema).resolve("合成机构甲,未知机构", schema,
    {originalMessage: "合成机构甲和未知机构最近经营如何？", currentDate: "2026-10-22", turnId: "unknown-multi", resolveCatalog});
  expect(result.status).toBe("not_found");
  expect(resolveCatalog).toHaveBeenCalledWith("organization", ["合成机构甲", "未知机构"]);
});
it("多机构分隔适配仍执行目录权限校验", async () => {
  const resolveCatalog = vi.fn(async () => {throw new Error("SCOPE_DENIED");}), schema = organizationSchema.fields.organizations!;
  await expect(createFieldResolvers().getResolver(schema).resolve("合成机构甲,合成机构乙", schema,
    {originalMessage: "合成机构甲和合成机构乙最近经营如何？", currentDate: "2026-10-22", turnId: "denied-multi", resolveCatalog}))
    .rejects.toThrow("SCOPE_DENIED");
  expect(resolveCatalog).toHaveBeenCalledWith("organization", ["合成机构甲", "合成机构乙"]);
});
it("不把正式机构名称中的和字拆成机构清单", async () => {
  const resolveCatalog = vi.fn(async () => ({status: "resolved" as const, value: {codes: ["O1"], names: ["合成和美银行"]}}));
  const schema = organizationSchema.fields.organizations!;
  await createFieldResolvers().getResolver(schema).resolve("合成和美银行", schema,
    {originalMessage: "合成和美银行最近经营如何？", currentDate: "2026-10-22", turnId: "literal-name", resolveCatalog});
  expect(resolveCatalog).toHaveBeenCalledWith("organization", ["合成和美银行"]);
});
const proposal = (): BusinessFrame => ({frameId: "proposal", sessionId: "s", turnId: "prior", requestId: "prior",
  operationFrameId: "proposal", capability: "synthetic_org", status: "clarifying", createdAt: "2026-10-13", issues: [],
  delta: {executionMode: "resolve_more", fieldChanges: []}, fields: {organizations: {source: "explicit", rawValue: "合成机构",
    resolutionStatus: "needs_confirmation", candidates: [{code: "O1", value: "合成机构甲"}]}}});
const confirmation = (sourceText: string): ContextDelta => ({executionMode: "resolve_more", fieldChanges: [
  {fieldHint: "organizations", operation: "set", rawValue: {confirm: true, evidence: {decision: "accept", sourceText}}},
]});

describe("确认证据保持同一锚定规则与原有门禁", () => {
  it.each([
    ["没 问 题， 日期改为２０２６年７月末", "没问题，日期改为2026年7月末"],
    ["ＹＥＳ， please proceed", "yes,please proceed"],
  ])("复合确认接受格式等价的完整证据：%s", async (reply, evidence) => {
    const resolveCatalog = vi.fn(async () => ({status: "resolved" as const, value: {codes: ["O1"], names: ["合成机构甲"]}}));
    const context: ResolverContext = {originalMessage: reply, currentDate: "2026-10-13", turnId: "now", resolveCatalog};
    const result = await mergeFields(organizationSchema, proposal(), confirmation(evidence), createFieldResolvers(), context);
    expect(result.fields.organizations).toMatchObject({source: "confirmed", resolvedValue: {codes: ["O1"]}});
    expect(resolveCatalog).toHaveBeenCalledWith("organization", ["O1"]);
  });

  it.each(["是，但 不 是 合成机构甲", "不 要 合成机构甲"])("同句否定%s不会因格式兼容变成确认", async reply => {
    const resolveCatalog = vi.fn();
    const context: ResolverContext = {originalMessage: reply, currentDate: "2026-10-13", turnId: "now", resolveCatalog};
    const result = await mergeFields(organizationSchema, proposal(), confirmation(normalizeInputEvidence(reply)), createFieldResolvers(), context);
    expect(result.fields.organizations).toMatchObject({resolutionStatus: "needs_confirmation", metadata: {confirmationUnclear: true}});
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("旧助手文字依然不能确认候选", async () => {
    const resolveCatalog = vi.fn();
    const context: ResolverContext = {originalMessage: "没问题", currentDate: "2026-10-13", turnId: "now", resolveCatalog};
    await expect(mergeFields(organizationSchema, proposal(), confirmation("上一轮同意"), createFieldResolvers(), context))
      .rejects.toMatchObject({code: "CONFIRMATION_EVIDENCE_INVALID"});
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("格式等价也不能绕过同轮确认门禁", async () => {
    const resolveCatalog = vi.fn();
    const context: ResolverContext = {originalMessage: "ＹＥＳ， please proceed", currentDate: "2026-10-13", turnId: "prior", resolveCatalog};
    await expect(mergeFields(organizationSchema, proposal(), confirmation("yes,please proceed"), createFieldResolvers(), context))
      .rejects.toMatchObject({code: "CONFIRMATION_REQUIRES_USER_TURN"});
    expect(resolveCatalog).not.toHaveBeenCalled();
  });
});

it("历史字段引用的sourceText与新增名称只归一化来源依据，正式编码仍取受控目录", async () => {
  const frame: BusinessFrame = {...proposal(), status: "success", fields: {organizations: {source: "explicit", resolutionStatus: "resolved",
    resolvedValue: {codes: ["O1"], names: ["合成机构甲"]}}}};
  const resolveCatalog = vi.fn(async (_entity: string, raw: string[]) => ({status: "resolved" as const, value: raw[0] === "O1"
    ? {codes: ["O1"], names: ["合成机构甲"]} : {codes: ["O2"], names: ["ABC机构"]}}));
  const context: HistoryReferenceContext = {sessionId: "s", turnId: "now", originalMessage: "前 一 次 的机构和ＡＢＣ 机构一起查询", frames: [frame],
    state: {sessionId: "s", version: 1, focusFrameId: frame.frameId, frameOrder: [frame.frameId], operations: {[frame.frameId]: frame.frameId}}, resolveCatalog};
  const result = await resolveHistoryFieldReference({fromHistory: true, sourceText: "前一次的机构", combine: "union", expectedCount: 2,
    sources: [{frame: {frameId: frame.frameId}, field: "organizations"}], add: ["abc机构"]}, "organizations", context);
  expect(result).toMatchObject({status: "resolved", value: {codes: ["O1", "O2"]}});
  expect(resolveCatalog.mock.calls.map(call => call[1])).toEqual([["O1"], ["abc机构"]]);
});

it.each(["merge", "preflight"])("%s包装字段错误时保留结构化纠错依据", async mode => {
  const corrections = [{field: "organizations", reason: "invalid" as const, message: "合成纠错依据"}];
  const failure = () => {throw new BusinessInputError("SYNTHETIC_INPUT_ERROR", "organization", "合成错误", undefined,
    {action: "ask_user", message: "合成恢复动作"}, corrections);};
  const registry = new FieldResolverRegistry();
  registry.register({name: "organization", supports: () => true, resolve: failure, recoveryPreflight: failure});
  const context: ResolverContext = {originalMessage: "没问题", currentDate: "2026-10-13", turnId: "now", resolveCatalog: vi.fn()};
  const run = async () => mode === "merge" ? mergeFields(organizationSchema, proposal(), confirmation("没问题"), registry, context)
    : preflightFieldRecovery(organizationSchema, proposal(), confirmation("没问题"), registry, context);
  await expect(run()).rejects.toMatchObject({code: "SYNTHETIC_INPUT_ERROR", corrections, recovery: {action: "ask_user"}});
});
