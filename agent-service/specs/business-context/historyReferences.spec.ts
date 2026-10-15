import {expect, it, vi} from "vitest";
import {resolveHistoryFieldReference} from "../../src/business-context/historyReferences.js";
import type {HistoryReferenceContext} from "../../src/business-context/historyReferences.js";
import {toCompactTurnArgs, toContextDelta} from "../../src/business-context/turnArgs.js";
import type {BusinessFrame, FieldResolution, HistoryFieldReferenceInput, ResolvedOrganizations} from "../../src/business-context/types.js";

function fixture(values: ResolvedOrganizations[] = [{codes: ["A", "B"], names: ["机构甲", "机构乙"]},
  {codes: ["B", "C"], names: ["机构乙", "机构丙"]}]) {
  const frames: BusinessFrame[] = values.map((value, index) => ({frameId: `f${index}`, sessionId: "s", turnId: `t${index}`,
    requestId: `r${index}`, operationFrameId: `f${index}`, capability: "metric_query", status: "success", createdAt: "2026-10-13",
    fields: {organizations: {source: "explicit", resolutionStatus: "resolved", resolvedValue: value}}, issues: [],
    delta: {executionMode: "execute", fieldChanges: []}}));
  const names = new Map(values.flatMap(value => value.codes.map((code, index) => [code, value.names[index]!] as const)));
  const context: HistoryReferenceContext = {sessionId: "s", turnId: "now", originalMessage: "请将以上三家机构一起排名", frames,
    state: {sessionId: "s", version: 2, focusFrameId: "f1", frameOrder: frames.map(frame => frame.frameId),
      operations: Object.fromEntries(frames.map(frame => [frame.frameId, frame.frameId]))},
    resolveCatalog: vi.fn(async (_entity: string, codes: string[]): Promise<FieldResolution> => ({status: "resolved", value: {codes, names: codes.map(code => names.get(code)!)}}))};
  const input: HistoryFieldReferenceInput = {fromHistory: true, sourceText: "以上三家机构", combine: "union", expectedCount: 3,
    sources: frames.map(frame => ({frame: {frameId: frame.frameId}, field: "organizations"}))};
  return {frames, input, context};
}

it("明确来源并集稳定按编码去重，经当前目录逐项复核且不改变焦点", async () => {
  const f = fixture();
  const before = structuredClone(f.context.state);
  const result = await resolveHistoryFieldReference(f.input, "organizations", f.context);
  expect(result).toMatchObject({status: "resolved", value: {codes: ["A", "B", "C"], names: ["机构甲", "机构乙", "机构丙"]},
    metadata: {referenceSource: "session_history", referenceSourceFrames: ["f0", "f1"]}});
  expect(vi.mocked(f.context.resolveCatalog).mock.calls.map(call => call[1])).toEqual([["A"], ["B"], ["C"]]);
  expect(f.context.state).toEqual(before);
});

it("single 保留来源完整集合，数量不是选择最近N家或截断名单的指令", async () => {
  const f = fixture();
  const input = {...f.input, combine: "single" as const, sources: [f.input.sources[0]!], expectedCount: 1};
  const result = await resolveHistoryFieldReference(input, "organizations", f.context);
  expect(result).toMatchObject({status: "not_found", metadata: {referenceIssue: {code: "HISTORY_REFERENCE_COUNT_MISMATCH",
    expectedCount: 1, actualCount: 2}}});
  expect(result.value).toBeUndefined();
  expect(result.candidates).toBeUndefined();
});

it("来源选择歧义保持未解析，不自动挑最近记录或伪造确认候选", async () => {
  const f = fixture();
  const result = await resolveHistoryFieldReference({...f.input, combine: "single", sources: [{frame: {capability: "metric_query"}, field: "organizations"}]}, "organizations", f.context);
  expect(result).toMatchObject({status: "ambiguous", metadata: {referenceIssue: {code: "HISTORY_SOURCE_NOT_UNIQUE"}}});
  expect(result.candidates).toBeUndefined();
  expect(f.context.resolveCatalog).not.toHaveBeenCalled();
});

it.each(["foreign", "current", "cross-field", "duplicate", "unknown-key", "not-current", "bad-selector"])("拒绝协议或来源越界：%s", async mode => {
  const f = fixture();
  if (mode === "foreign") f.frames[0]!.sessionId = "other";
  if (mode === "current") f.frames[0]!.turnId = "now";
  if (mode === "cross-field") f.input.sources[0]!.field = "metrics";
  if (mode === "duplicate") f.input.sources[1]!.frame = {ordinal: 1};
  if (mode === "unknown-key") Object.assign(f.input, {names: ["任意名称"]});
  if (mode === "not-current") f.input.sourceText = "未出现在原文的指代";
  if (mode === "bad-selector") f.input.sources[0]!.frame.ordinal = 0;
  await expect(resolveHistoryFieldReference(f.input, "organizations", f.context)).rejects.toMatchObject({code: "HISTORY_REFERENCE_INVALID"});
});

it("引用未存在的确切Frame不退回本会话其它来源", async () => {
  const f = fixture();
  f.input.sources[0]!.frame = {frameId: "foreign-or-missing"};
  await expect(resolveHistoryFieldReference(f.input, "organizations", f.context)).rejects.toMatchObject({code: "HISTORY_REFERENCE_INVALID"});
  expect(f.context.resolveCatalog).not.toHaveBeenCalled();
});

it.each(["executing", "failed"] as const)("指定旧快照不能绕过最新操作的%s状态", async status => {
  const f = fixture();
  const latest = {...structuredClone(f.frames[0]!), frameId: "latest", status, errorCode: "QUERY_FAILED"};
  f.context.frames.push(latest);
  f.context.state.operations.f0 = latest.frameId;
  const result = await resolveHistoryFieldReference(f.input, "organizations", f.context);
  expect(result).toMatchObject({status: "not_found", metadata: {referenceIssue: {code: "HISTORY_SOURCE_UNAVAILABLE"}}});
  expect(f.context.resolveCatalog).not.toHaveBeenCalled();
});

it.each(["unresolved", "incomplete"])("不从%s字段获取正式编码", async mode => {
  const f = fixture();
  if (mode === "unresolved") f.frames[0]!.fields.organizations!.resolutionStatus = "ambiguous";
  else (f.frames[0]!.fields.organizations!.resolvedValue as ResolvedOrganizations).names = [];
  expect(await resolveHistoryFieldReference(f.input, "organizations", f.context)).toMatchObject({status: "not_found",
    metadata: {referenceIssue: {code: "HISTORY_FIELD_UNRESOLVED"}}});
});

it.each(["revoked", "substituted"])("当前目录%s不得沿用旧授权或替换编码", async mode => {
  const f = fixture();
  f.context.resolveCatalog = vi.fn(async (): Promise<FieldResolution> => mode === "revoked" ? {status: "not_found"}
    : {status: "resolved", value: {codes: ["OTHER"], names: ["其它机构"]}});
  expect(await resolveHistoryFieldReference(f.input, "organizations", f.context)).toMatchObject({status: "not_found",
    metadata: {referenceIssue: {code: "HISTORY_AUTHORIZATION_CHANGED"}}});
});

it("无固定20家阈值，具体机构完整集合由明确来源和现有授权约束", async () => {
  const f = fixture([{codes: Array.from({length: 25}, (_, index) => `C${index}`), names: Array.from({length: 25}, (_, index) => `机构${index}`)}]);
  f.input.combine = "single";
  f.input.expectedCount = 25;
  expect(await resolveHistoryFieldReference(f.input, "organizations", f.context)).toMatchObject({status: "resolved",
    value: {codes: f.frames[0]!.fields.organizations!.resolvedValue && (f.frames[0]!.fields.organizations!.resolvedValue as ResolvedOrganizations).codes}});
});

it("动态scope不能混并成固定名单；单源刷新原范围且按刷新结果核对数量", async () => {
  const scope = {kind: "authorized_cohort" as const, cohort: "rural_commercial_banks" as const};
  const f = fixture([{codes: ["A"], names: ["机构甲"], scope, scope_fingerprint: "a".repeat(64)}, {codes: ["C"], names: ["机构丙"]}]);
  f.frames[0]!.fields.organizations!.rawValue = {...scope, sourceText: "账号权限内农商行"};
  f.context.resolveOrganizationScope = vi.fn(async (): Promise<FieldResolution> => ({status: "resolved", value: {codes: ["A", "B"], names: ["机构甲", "机构乙"], scope, scope_fingerprint: "b".repeat(64)}}));
  expect(await resolveHistoryFieldReference(f.input, "organizations", f.context)).toMatchObject({status: "not_found",
    metadata: {referenceIssue: {code: "HISTORY_SCOPE_COMBINATION_UNSUPPORTED"}}});
  const input = {...f.input, combine: "single" as const, sources: [f.input.sources[0]!], expectedCount: 1};
  expect(await resolveHistoryFieldReference(input, "organizations", f.context)).toMatchObject({status: "not_found",
    metadata: {referenceIssue: {code: "HISTORY_REFERENCE_COUNT_MISMATCH", actualCount: 2}}});
  const result = await resolveHistoryFieldReference({...input, expectedCount: 2}, "organizations", f.context);
  expect(result).toMatchObject({status: "resolved", value: {scope, scope_fingerprint: "b".repeat(64)}, metadata: {
    refreshOnInherit: true, historyReference: {...input, expectedCount: 2}, confirmedRawValues: {...scope, sourceText: "账号权限内农商行"}}});
  expect(result.metadata).not.toHaveProperty("confirmed");
  expect(f.context.resolveOrganizationScope).toHaveBeenCalledWith({...scope, sourceText: "账号权限内农商行"});
});

it("结构化引用在legacy与compact格式间保持无损且不改变来源契约", () => {
  const f = fixture();
  const delta = {capabilityHint: "metric_query", baseReference: "current" as const, executionMode: "execute" as const,
    fieldChanges: [{fieldHint: "organizations", operation: "set" as const, rawValue: f.input}]};
  expect(toContextDelta(toCompactTurnArgs(delta))).toEqual(delta);
  expect(toContextDelta(delta)).toEqual(delta);
});

it("历史并集与本轮新增名称整体去重，数量按最终完整集合校验", async () => {
  const f = fixture();
  f.context.originalMessage += "和新增机构、机构乙";
  const original = f.context.resolveCatalog;
  f.context.resolveCatalog = vi.fn(async (entity, values): Promise<FieldResolution> => values[0] === "新增机构"
    ? {status: "resolved", value: {codes: ["D"], names: ["新增机构"]}}
    : values[0] === "机构乙" ? {status: "resolved", value: {codes: ["B"], names: ["机构乙"]}} : original(entity, values));
  const input = {...f.input, add: ["新增机构", "机构乙"], expectedCount: 4};
  expect(await resolveHistoryFieldReference(input, "organizations", f.context)).toMatchObject({status: "resolved",
    value: {codes: ["A", "B", "C", "D"], names: ["机构甲", "机构乙", "机构丙", "新增机构"]}});
  expect(await resolveHistoryFieldReference({...input, expectedCount: 5}, "organizations", f.context)).toMatchObject({status: "not_found",
    metadata: {referenceIssue: {code: "HISTORY_REFERENCE_COUNT_MISMATCH", actualCount: 4}}});
});

it.each(["not-current", "single", "empty"])("拒绝新增名称协议越界：%s", async mode => {
  const f = fixture();
  const input = {...f.input, add: mode === "empty" ? [] : ["虚构新增名称"]};
  if (mode === "single") {input.combine = "single"; input.sources = [input.sources[0]!]; f.context.originalMessage += "虚构新增名称";}
  await expect(resolveHistoryFieldReference(input, "organizations", f.context)).rejects.toMatchObject({code: "HISTORY_REFERENCE_INVALID"});
  expect(f.context.resolveCatalog).not.toHaveBeenCalled();
});

it("新增未解析候选保存完整历史集合及稳定项索引，不把部分解析当成功", async () => {
  const f = fixture();
  f.context.originalMessage += "和新增机构";
  const original = f.context.resolveCatalog;
  f.context.resolveCatalog = vi.fn(async (entity, values): Promise<FieldResolution> => values[0] === "新增机构"
    ? {status: "needs_confirmation", candidates: [{code: "D", value: "新增机构正式名", metadata: {rawValueIndex: 0}}]}
    : original(entity, values));
  const result = await resolveHistoryFieldReference({...f.input, add: ["新增机构"], expectedCount: 4}, "organizations", f.context);
  expect(result).toMatchObject({status: "needs_confirmation", candidates: [{code: "D", metadata: {rawValueIndex: 3}}], metadata: {
    pendingRawValues: ["A", "B", "C", "新增机构"], referenceHistoryCodes: ["A", "B", "C"], referenceExpectedCount: 4,
    confirmedRawValues: {sources: [{frame: {frameId: "f0"}, field: "organizations"}, {frame: {frameId: "f1"}, field: "organizations"}]}}});
  expect(result.value).toBeUndefined();
});

it("目录临时失败仍固定精确来源，继承重试无需原句也不重新按相对位置选来源", async () => {
  const f = fixture();
  f.input = {...f.input, combine: "single", sources: [{frame: {relativePosition: 0}, field: "organizations"}], expectedCount: 2};
  f.context.resolveCatalog = vi.fn(async (): Promise<FieldResolution> => ({status: "temporary_error"}));
  const first = await resolveHistoryFieldReference(f.input, "organizations", f.context);
  expect(first).toMatchObject({status: "temporary_error", metadata: {
    confirmedRawValues: {sources: [{frame: {frameId: "f1"}, field: "organizations"}]}, historyReference: f.input}});
  const draft = {...structuredClone(f.frames[0]!), frameId: "draft", operationFrameId: "draft", turnId: "previous-turn", status: "draft" as const};
  f.context.frames.push(draft);
  f.context.state.frameOrder.push("draft");
  f.context.state.operations.draft = "draft";
  f.context.originalMessage = "重试";
  f.context.inputSource = "inherited";
  f.context.resolveCatalog = vi.fn(async (_entity: string, values: string[]): Promise<FieldResolution> => ({status: "resolved", value: {
    codes: values, names: values.map(code => code === "B" ? "机构乙" : "机构丙")}}));
  expect(await resolveHistoryFieldReference(first.metadata!.confirmedRawValues as HistoryFieldReferenceInput, "organizations", f.context))
    .toMatchObject({status: "resolved", value: {codes: ["B", "C"]}, metadata: {referenceSourceFrames: ["f1"]}});
});

it("混合新增候选与未知项保持候选可确认，并记录无候选项的独立问题", async () => {
  const f = fixture();
  f.context.originalMessage += "和新增D、未知E";
  const original = f.context.resolveCatalog;
  f.context.resolveCatalog = vi.fn(async (entity: string, names: string[]): Promise<FieldResolution> => names[0] === "新增D"
    ? {status: "needs_confirmation", candidates: [{value: "正式D", code: "D"}]}
    : names[0] === "未知E" ? {status: "not_found"} : original(entity, names));
  const result = await resolveHistoryFieldReference({...f.input, expectedCount: 5, add: ["新增D", "未知E"]}, "organizations", f.context);
  expect(result).toMatchObject({status: "needs_confirmation", candidates: [{metadata: {rawValueIndex: 3}}], metadata: {
    referenceAdditionIssues: [{index: 3, raw: "新增D", status: "needs_confirmation"}, {index: 4, raw: "未知E", status: "not_found"}]}});
  expect(result.value).toBeUndefined();
});

it.each(["missing", "unresolved", "other-session", "other-source", "other-field"])("显式保留新增项拒绝无可信同组合依据：%s", async mode => {
  const f = fixture();
  const previous = {source: "explicit" as const, resolutionStatus: "not_found" as const,
    rawValue: f.input, metadata: {referenceSessionId: "s", referenceField: "organizations", referenceSourceOperations: ["f0", "f1"],
      referenceResolvedAdditions: {codes: ["D"], names: ["正式D"]}}};
  if (mode !== "missing") f.context.previous = previous;
  if (mode === "unresolved") previous.metadata.referenceResolvedAdditions = {codes: [], names: []};
  if (mode === "other-session") previous.metadata.referenceSessionId = "foreign";
  if (mode === "other-source") previous.metadata.referenceSourceOperations = ["f0"];
  if (mode === "other-field") previous.metadata.referenceField = "metrics";
  await expect(resolveHistoryFieldReference({...f.input, retainResolvedAdditions: true}, "organizations", f.context))
    .rejects.toMatchObject({code: "HISTORY_REFERENCE_INVALID"});
});

it("保留可信新增项仍重新校验权限，临时失败草稿保留可再次复核的事实", async () => {
  const f = fixture();
  f.context.previous = {source: "explicit", resolutionStatus: "not_found", rawValue: {...f.input, expectedCount: 4},
    metadata: {referenceSessionId: "s", referenceField: "organizations", referenceSourceOperations: ["f0", "f1"],
      referenceResolvedAdditions: {codes: ["D"], names: ["正式D"]}}};
  const original = f.context.resolveCatalog;
  f.context.resolveCatalog = vi.fn(async (entity: string, names: string[]): Promise<FieldResolution> => names[0] === "D"
    ? {status: "temporary_error"} : original(entity, names));
  expect(await resolveHistoryFieldReference({...f.input, expectedCount: 4, retainResolvedAdditions: true}, "organizations", f.context))
    .toMatchObject({status: "temporary_error", metadata: {referenceResolvedAdditions: {codes: ["D"], names: ["正式D"]}}});
  f.context.resolveCatalog = vi.fn(async (entity: string, names: string[]): Promise<FieldResolution> => names[0] === "D"
    ? {status: "not_found"} : original(entity, names));
  expect(await resolveHistoryFieldReference({...f.input, expectedCount: 4, retainResolvedAdditions: true}, "organizations", f.context))
    .toMatchObject({status: "not_found", metadata: {referenceIssue: {code: "HISTORY_AUTHORIZATION_CHANGED"}}});
});

it("保留组合会继续保存未决项，未传flag的完整替换不会自动保留旧新增项", async () => {
  const f = fixture();
  f.context.previous = {source: "explicit", resolutionStatus: "not_found", rawValue: f.input,
    metadata: {referenceSessionId: "s", referenceField: "organizations", referenceSourceOperations: ["f0", "f1"],
      referenceResolvedAdditions: {codes: ["D"], names: ["正式D"]},
      referenceAdditionIssues: [{index: 4, raw: "未知E", status: "not_found"}]}};
  const original = f.context.resolveCatalog;
  f.context.resolveCatalog = vi.fn(async (entity: string, names: string[]): Promise<FieldResolution> => names[0] === "D" ? {status: "resolved", value: {codes: ["D"], names: ["正式D"]}}
    : names[0] === "未知E" ? {status: "not_found"} : original(entity, names));
  expect(await resolveHistoryFieldReference({...f.input, retainResolvedAdditions: true}, "organizations", f.context))
    .toMatchObject({status: "not_found", metadata: {referenceAdditionIssues: [{index: 4, raw: "未知E", status: "not_found"}]}});
  expect(await resolveHistoryFieldReference(f.input, "organizations", f.context)).toMatchObject({status: "resolved", value: {codes: ["A", "B", "C"]}});
});

it("多个未决新增项按保存索引逐项修正，未提及项阻断执行且普通追加不能覆盖", async () => {
  const f = fixture();
  f.context.originalMessage = "原组合，未知E改为正式E，再增加正式G";
  const input = {...f.input, sourceText: "原组合", expectedCount: 6, retainResolvedAdditions: true as const};
  f.context.previous = {source: "explicit", resolutionStatus: "not_found", rawValue: input,
    metadata: {referenceSessionId: "s", referenceField: "organizations", referenceSourceOperations: ["f0", "f1"],
      referenceResolvedAdditions: {codes: ["D"], names: ["正式D"]}, referenceAdditionIssues: [
        {index: 4, raw: "未知E", status: "not_found"}, {index: 5, raw: "未知F", status: "not_found"}]}};
  const original = f.context.resolveCatalog;
  f.context.resolveCatalog = vi.fn(async (entity: string, names: string[]): Promise<FieldResolution> => names[0]!.startsWith("未知") ? {status: "not_found"}
    : ["D", "E", "F", "G", "正式E", "正式F", "正式G"].includes(names[0]!)
      ? {status: "resolved", value: {codes: [names[0]!.replace("正式", "")], names: [`正式${names[0]!.replace("正式", "")}`]}}
      : original(entity, names));
  const appended = await resolveHistoryFieldReference({...input, add: ["正式G"]}, "organizations", f.context);
  expect(appended).toMatchObject({status: "not_found", metadata: {referenceAdditionIssues: [
    {raw: "未知E"}, {raw: "未知F"}], referenceResolvedAdditions: {codes: ["D", "G"]}}});
  const replaced = await resolveHistoryFieldReference({...input, replaceAdditions: [{index: 4, value: "正式E"}]}, "organizations", f.context);
  expect(replaced).toMatchObject({status: "not_found", metadata: {referenceAdditionIssues: [{index: 5, raw: "未知F"}],
    referenceResolvedAdditions: {codes: ["D", "E"]}, confirmedRawValues: {add: ["E", "未知F"]}}});
  expect(replaced.metadata!.confirmedRawValues).not.toHaveProperty("replaceAdditions");
  f.context.previous = {source: "explicit", resolutionStatus: replaced.status, rawValue: replaced.metadata!.confirmedRawValues, metadata: replaced.metadata!};
  f.context.inputSource = "inherited";
  expect(await resolveHistoryFieldReference(replaced.metadata!.confirmedRawValues as HistoryFieldReferenceInput, "organizations", f.context))
    .toMatchObject({status: "not_found", metadata: {referenceAdditionIssues: [{index: 5, raw: "未知F"}], referenceResolvedAdditions: {codes: ["D", "E"]}}});
  f.context.inputSource = "explicit";
  f.context.originalMessage = "原组合，未知F改为正式F";
  expect(await resolveHistoryFieldReference({...input, replaceAdditions: [{index: 5, value: "正式F"}]}, "organizations", f.context))
    .toMatchObject({status: "resolved", value: {codes: ["A", "B", "C", "D", "E", "F"]}});
});

it("尚无确定新增项时也能精确补充未决项，不需要伪造保留编码", async () => {
  const f = fixture();
  f.context.originalMessage = "原组合，未知D改为正式D";
  f.context.previous = {source: "explicit", resolutionStatus: "not_found", rawValue: {...f.input, expectedCount: 4},
    metadata: {referenceSessionId: "s", referenceField: "organizations", referenceSourceOperations: ["f0", "f1"],
      referenceAdditionIssues: [{index: 3, raw: "未知D", status: "not_found"}]}};
  const original = f.context.resolveCatalog;
  f.context.resolveCatalog = vi.fn(async (entity: string, names: string[]): Promise<FieldResolution> => names[0] === "正式D"
    ? {status: "resolved", value: {codes: ["D"], names: ["正式D"]}} : original(entity, names));
  const input = {...f.input, sourceText: "原组合", expectedCount: 4, retainResolvedAdditions: true as const, replaceAdditions: [{index: 3, value: "正式D"}]};
  expect(await resolveHistoryFieldReference(input, "organizations", f.context)).toMatchObject({status: "resolved", value: {codes: ["A", "B", "C", "D"]}});
  await expect(resolveHistoryFieldReference({...input, replaceAdditions: [{index: 2, value: "正式D"}]}, "organizations", f.context))
    .rejects.toMatchObject({code: "HISTORY_REFERENCE_INVALID"});
});

it.each(["missing-retain", "duplicate", "not-current", "unknown-key"])("拒绝未决项替换越界：%s", async mode => {
  const f = fixture();
  const input: HistoryFieldReferenceInput = {...f.input, retainResolvedAdditions: true, replaceAdditions: [{index: 4, value: "机构"}]};
  if (mode === "missing-retain") delete input.retainResolvedAdditions;
  if (mode === "duplicate") input.replaceAdditions!.push({...input.replaceAdditions![0]!});
  if (mode === "not-current") input.replaceAdditions![0]!.value = "虚构名称";
  if (mode === "unknown-key") Object.assign(input.replaceAdditions![0]!, {code: "D"});
  await expect(resolveHistoryFieldReference(input, "organizations", f.context)).rejects.toMatchObject({code: "HISTORY_REFERENCE_INVALID"});
  expect(f.context.resolveCatalog).not.toHaveBeenCalled();
});

it("保留组合授权暂时失败后直接追加新项，原未决项仍保留且不能被等数量新项替换", async () => {
  const f = fixture();
  const input: HistoryFieldReferenceInput = {...f.input, sourceText: "原组合", expectedCount: 5, retainResolvedAdditions: true};
  f.context.originalMessage = "原组合继续";
  f.context.previous = {source: "explicit", resolutionStatus: "not_found", rawValue: {...input, add: ["D", "未知F"]},
    metadata: {referenceSessionId: "s", referenceField: "organizations", referenceSourceOperations: ["f0", "f1"],
      referenceResolvedAdditions: {codes: ["D"], names: ["正式D"]},
      referenceAdditionIssues: [{index: 4, raw: "未知F", status: "not_found"}],
      pendingRawValues: ["A", "B", "C", ["D"], "未知F"]}};
  f.context.resolveCatalog = vi.fn(async (): Promise<FieldResolution> => ({status: "temporary_error"}));
  const first = await resolveHistoryFieldReference(input, "organizations", f.context);
  expect(first.status).toBe("temporary_error");
  expect(first.metadata!.referenceAdditionIssues).toEqual(expect.arrayContaining([{index: 4, raw: "未知F", status: "not_found"}]));
  f.context.previous = {source: "explicit", resolutionStatus: first.status, rawValue: first.metadata!.confirmedRawValues, metadata: first.metadata!};
  f.context.originalMessage = "原组合再增加正式G";
  f.context.resolveCatalog = vi.fn(async (_entity: string, values: string[]): Promise<FieldResolution> => values[0] === "未知F"
    ? {status: "not_found"} : {status: "resolved", value: {codes: [values[0] === "正式G" ? "G" : values[0]!], names: [values[0]!]}});
  const appended = await resolveHistoryFieldReference({...input, add: ["正式G"]}, "organizations", f.context);
  expect(appended.status).toBe("not_found");
  expect(appended.value).toBeUndefined();
  expect(appended.metadata).toMatchObject({referenceAdditionIssues: [{raw: "未知F"}], referenceResolvedAdditions: {codes: ["D", "G"]}});
  expect(vi.mocked(f.context.resolveCatalog).mock.calls.some(call => call[1][0] === "未知F")).toBe(true);
});

it("保留组合的最新来源不可用时要求用户处理并保留原字段，不保存缺失新增项的缩小提案", async () => {
  const f = fixture();
  const input: HistoryFieldReferenceInput = {...f.input, sourceText: "原组合", expectedCount: 5, retainResolvedAdditions: true, add: ["正式G"]};
  f.context.originalMessage = "原组合再增加正式G";
  f.context.previous = {source: "explicit", resolutionStatus: "not_found", rawValue: {...f.input, expectedCount: 5, add: ["D", "未知F"]},
    metadata: {referenceSessionId: "s", referenceField: "organizations", referenceSourceOperations: ["f0", "f1"],
      referenceResolvedAdditions: {codes: ["D"], names: ["正式D"]},
      referenceAdditionIssues: [{index: 4, raw: "未知F", status: "not_found"}],
      pendingRawValues: ["A", "B", "C", ["D"], "未知F"]}};
  const latest = {...structuredClone(f.frames[1]!), frameId: "f1-executing", status: "executing" as const};
  f.frames.push(latest);
  f.context.state.operations.f1 = latest.frameId;
  const before = JSON.stringify({previous: f.context.previous, state: f.context.state, frames: f.frames});
  await expect(resolveHistoryFieldReference(input, "organizations", f.context)).rejects.toMatchObject({recovery: {action: "ask_user"}});
  expect(JSON.stringify({previous: f.context.previous, state: f.context.state, frames: f.frames})).toBe(before);
  expect(f.context.resolveCatalog).not.toHaveBeenCalled();
});

it.each(["retry", "confirmation"])("没有retain标志的%s也必须锁定已确定新增编码，不能由目录替换成别的机构", async mode => {
  const f = fixture([{codes: ["A"], names: ["机构甲"]}]);
  f.context.originalMessage = "以上机构和新D、未知F";
  const input: HistoryFieldReferenceInput = {...f.input, sourceText: "以上机构", expectedCount: 3, add: ["新D", "未知F"]};
  f.context.resolveCatalog = vi.fn(async (_entity: string, values: string[]): Promise<FieldResolution> => values[0] === "新D"
    ? {status: "resolved", value: {codes: ["D"], names: ["正式D"]}} : values[0] === "未知F" ? {status: "temporary_error"}
      : {status: "resolved", value: {codes: ["A"], names: ["机构甲"]}});
  const first = await resolveHistoryFieldReference(input, "organizations", f.context);
  expect(first).toMatchObject({status: "temporary_error", metadata: {confirmedRawValues: {add: ["D", "未知F"]},
    referenceResolvedAdditions: {codes: ["D"]}}});
  const canonical = first.metadata!.confirmedRawValues as HistoryFieldReferenceInput;
  expect(canonical).not.toHaveProperty("retainResolvedAdditions");
  f.context.previous = {source: "explicit", resolutionStatus: first.status, rawValue: canonical, metadata: first.metadata!};
  f.context.inputSource = "inherited";
  f.context.originalMessage = mode === "retry" ? "重试" : "是";
  f.context.resolveCatalog = vi.fn(async (_entity: string, values: string[]): Promise<FieldResolution> => values[0] === "D"
    ? {status: "resolved", value: {codes: ["X"], names: ["另一机构"]}} : values[0] === "未知F"
      ? {status: "resolved", value: {codes: ["F"], names: ["正式F"]}}
      : {status: "resolved", value: {codes: ["A"], names: ["机构甲"]}});
  const result = await resolveHistoryFieldReference(canonical, "organizations", f.context);
  expect(result).toMatchObject({status: "not_found", metadata: {referenceIssue: {code: "HISTORY_AUTHORIZATION_CHANGED"},
    referenceResolvedAdditions: {codes: ["D"]}}});
  expect(result.value).toBeUndefined();
  expect(vi.mocked(f.context.resolveCatalog).mock.calls.map(call => call[1])).toEqual([["A"], ["D"]]);
});
