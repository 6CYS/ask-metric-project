import {expect, it} from "vitest";
import {FIELD_CONFIRMATION_DESCRIPTION} from "../../src/business-context/capabilities.js";
import {displayConditions, modelCapabilitySchemas, modelFrame, modelHistoryIndex} from "../../src/business-context/modelView.js";
import type {BusinessFrame, BusinessSessionState, FrameStore} from "../../src/business-context/types.js";

const ready: BusinessFrame = {frameId: "f", sessionId: "s", turnId: "t", requestId: "r", capability: "metric_query",
  operationFrameId: "f", fields: {}, delta: {fieldChanges: [], executionMode: "execute"}, issues: [], status: "ready", createdAt: "2026-09-22"};

function historicalFrame(frameId: string, codes: string[], overrides: Partial<BusinessFrame> = {}): BusinessFrame {
  return {...ready, frameId, operationFrameId: frameId, turnId: `turn-${frameId}`, fields: {
    organizations: {resolvedValue: {codes, names: codes}, resolutionStatus: "resolved", source: "resolved"},
    operation: {resolvedValue: {kind: "ranking", top_n: 3, position: "top"}, resolutionStatus: "resolved", source: "resolved"},
  }, ...overrides};
}

async function historyIndex(frames: BusinessFrame[], compact = false) {
  const store = {list: async () => frames} as unknown as FrameStore;
  const focus = frames.at(-1);
  const state: BusinessSessionState = {sessionId: "s", version: 1, ...(focus ? {focusFrameId: focus.frameId} : {}),
    frameOrder: [...new Set(frames.map(frame => frame.operationFrameId))],
    operations: Object.fromEntries(frames.map(frame => [frame.operationFrameId, frame.frameId]))};
  return modelHistoryIndex(store, state, "current", compact);
}

it("本轮可执行焦点仅提供执行动作，不能同时提示重新解析", () => {
  const view = modelFrame(ready, "t");
  expect(view.currentTurn).toBe(true);
  expect(view).not.toHaveProperty("continuation");
  expect(view.nextAction).toEqual({tool: "execute_business_frame", arguments: {frameId: "f"}});
});
it("机构集合数量与排名条数分别展示，模型视图不修改已保存条件", () => {
  const frame: BusinessFrame = {...ready, fields: {
    organizations: {resolvedValue: {codes: ["A", "B"], names: ["甲行", "乙行"]}, resolutionStatus: "resolved", source: "resolved"},
    operation: {resolvedValue: {kind: "ranking", top_n: 3, position: "top"}, resolutionStatus: "resolved", source: "resolved"},
  }};
  const before = JSON.stringify(frame);
  const view = modelFrame(frame, "next");
  expect(view.fields.organizations).toMatchObject({value: {count: 2, codes: ["A", "B"]}});
  expect(view.fields.operation).toMatchObject({value: {top_n: 3}});
  expect(JSON.stringify(frame)).toBe(before);
});
it("历史可执行或待澄清焦点必须先续接，不提供旧引用执行动作", () => {
  for (const status of ["ready", "clarifying"] as const) {
    const view = modelFrame({...ready, status}, "next");
    expect(view.currentTurn).toBe(false);
    expect(view.continuation).toMatchObject({tool: "resolve_business_turn", baseReference: {frameId: "f"}});
    expect(view).not.toHaveProperty("nextAction");
  }
});
it("只保存条件不会提示执行，成功快照不会再次提示查询", () => {
  expect(modelFrame({...ready, delta: {fieldChanges: [], executionMode: "resolve_more"}}, "t").nextAction).toEqual({action: "conditions_saved"});
  expect(modelFrame({...ready, status: "success"}, "t")).not.toHaveProperty("nextAction");
});
it("执行过程条件只展示已解析的业务名称，多项截断并省略内部字段", () => {
  const resolved = (resolvedValue: unknown) => ({resolvedValue, resolutionStatus: "resolved" as const, source: "resolved" as const});
  const conditions = displayConditions({...ready, fields: {
    metrics: {...resolved({codes: ["M"], names: ["信贷客户数量当日数"]}), metadata: {mentionResolutions: []}},
    organizations: resolved({codes: ["A", "B", "C", "D"], names: ["甲行", "乙行", "丙行", "丁行"]}),
    time: resolved({start: "2026-04-01", end: "2026-04-30"}),
    selection: resolved("latest_in_range"),
    operation: resolved({kind: "ranking", position: "top", top_n: 3}),
  }});
  expect(conditions).toEqual([
    {label: "指标", value: "信贷客户数量当日数"},
    {label: "机构", value: "甲行、乙行 等 4 家"},
    {label: "日期", value: "2026-04-01 至 2026-04-30"},
    {label: "取数方式", value: "范围内最新数据日"},
    {label: "排名", value: "前 3 名"},
  ]);
});
it("机构集合按用户原话和家数展示，不罗列全称", () => {
  const scope = {codes: ["A", "B", "C"], names: ["甲农村商业银行股份有限公司", "乙行", "丙行"], scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}};
  const organizations = (rawValue: unknown) => displayConditions({...ready, fields: {organizations:
    {rawValue, resolvedValue: scope, resolutionStatus: "resolved", source: "inherited"}}});
  expect(organizations({kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "各家农商行"}))
    .toEqual([{label: "机构", value: "各家农商行（3 家）"}]);
  expect(organizations(undefined)).toEqual([{label: "机构", value: "授权范围内农商行（3 家）"}]);
});
it("待确认、单日精确取值和普通取值不进入执行过程条件", () => {
  const conditions = displayConditions({...ready, fields: {
    metrics: {rawValue: "余额", resolutionStatus: "ambiguous", source: "explicit", candidates: [{value: "A"}]},
    time: {resolvedValue: {start: "2026-04-30", end: "2026-04-30", dates: undefined}, resolutionStatus: "resolved", source: "resolved"},
    selection: {resolvedValue: "exact", resolutionStatus: "resolved", source: "resolved"},
    operation: {resolvedValue: {kind: "value"}, resolutionStatus: "resolved", source: "resolved"},
  }});
  expect(conditions).toEqual([{label: "日期", value: "2026-04-30"}]);
  expect(displayConditions({...ready, capability: "unknown_capability", fields: {}})).toEqual([]);
});

it("精简模式焦点仅改变受控参数属性与提示，原始字段及Frame不变", () => {
  const frame = {...ready, issues: [{field: "$base", reason: "invalid" as const, message: "请改用 baseReference=current"}],
    fields: {time: {rawValue: "baseReference 用户原文", resolutionStatus: "resolved" as const, source: "explicit" as const}}};
  const before = JSON.stringify(frame);
  const compact = modelFrame(frame, "next", true);
  expect(compact).toMatchObject({mode: "execute", continuation: {base: {frameId: "f"}},
    issues: [{message: "请改用 base=current"}], fields: {time: {rawValue: "baseReference 用户原文"}}});
  expect(compact).not.toHaveProperty("executionMode");
  expect(compact.continuation).not.toHaveProperty("baseReference");
  expect(JSON.stringify(frame)).toBe(before);
  expect(modelFrame(frame, "next", false)).toEqual(modelFrame(frame, "next"));
});

it("精简模式能力说明与历史索引不含旧参数名，来源序号和字段契约不变", async () => {
  const store = {list: async () => [ready]} as unknown as FrameStore;
  const state: BusinessSessionState = {sessionId: "s", version: 1, focusFrameId: "f", frameOrder: ["f"], operations: {f: "f"}};
  const legacy = await modelHistoryIndex(store, state, "next");
  const compact = await modelHistoryIndex(store, state, "next", true);
  expect(compact.entries).toEqual(legacy.entries);
  expect(compact.fieldSourceFacts).toEqual(legacy.fieldSourceFacts);
  expect(compact.focusOrdinal).toBe(1);
  expect(compact.usage).toMatch(/整笔业务用 base 继承/);
  expect(compact.usage).not.toMatch(/fieldChanges|fieldHint|capabilityHint|baseReference|executionMode/);
  const schemas = modelCapabilitySchemas(true);
  expect(JSON.stringify(schemas)).not.toMatch(/fieldChanges|fieldHint|capabilityHint|baseReference|executionMode|operation=remove/);
  expect(schemas.map(schema => schema.capability)).toEqual(modelCapabilitySchemas().map(schema => schema.capability));
  for (const [index, schema] of schemas.entries()) {
    const original = modelCapabilitySchemas()[index]!;
    for (const [name, field] of Object.entries(schema.fields)) expect(field.inputSchema).toEqual(original.fields[name]?.inputSchema);
  }
});

it("目标字段来源摘要展示一笔一家与一笔两家的静态并集事实，不以排名条数或焦点选目标", async () => {
  const frames = [historicalFrame("one", ["A"]), historicalFrame("two", ["B", "C"])];
  const before = JSON.stringify(frames);
  const index = await historyIndex(frames);
  expect(index.focusOrdinal).toBe(2);
  expect(index.fieldSourceFacts).toMatchObject({factsOnly: true, scope: "visible_history_entries", indexTruncated: false,
    fields: {organizations: {sources: [
      {frame: {frameId: "one"}, field: "organizations", ordinal: 1, count: 1},
      {frame: {frameId: "two"}, field: "organizations", ordinal: 2, count: 2},
    ], staticUnion: {distinctCount: 3, sources: [
      {frame: {frameId: "one"}, field: "organizations"}, {frame: {frameId: "two"}, field: "organizations"},
    ]}}}});
  expect(index.fieldSourceFacts.fields).not.toHaveProperty("operation");
  expect(index.fieldSourceFacts.instruction).toMatch(/不按数量.*选来源/);
  expect(JSON.stringify(frames)).toBe(before);
  const duplicate = await historyIndex([...frames, historicalFrame("overlap", ["A", "C"], {capability: "data_availability"})]);
  expect(duplicate.fieldSourceFacts.fields.organizations?.staticUnion?.distinctCount).toBe(3);
});

it("字段来源只使用历史操作最新且可继承的已解析快照，不能靠旧 READY 绕过状态", async () => {
  const frames = [historicalFrame("keep", ["A"]), historicalFrame("busy", ["B"]), historicalFrame("failed", ["C"]),
    historicalFrame("base", ["D"]), historicalFrame("pending", ["E"]), historicalFrame("this-turn", ["F"]),
    historicalFrame("foreign", ["G"], {sessionId: "another"}),
    historicalFrame("retry", ["H"], {status: "failed", errorCode: "NOT_SUBMITTED"}),
    historicalFrame("other-unresolved", ["I"], {status: "clarifying", issues: [{field: "metrics", reason: "ambiguous"}]}),
    historicalFrame("busy-latest", ["B"], {operationFrameId: "busy", status: "executing"}),
    historicalFrame("failed-latest", ["C"], {operationFrameId: "failed", status: "failed", errorCode: "BUSINESS_ERROR"}),
    historicalFrame("base-latest", ["D"], {operationFrameId: "base", status: "clarifying", issues: [{field: "$base", reason: "invalid"}]}),
    historicalFrame("pending-latest", ["E"], {operationFrameId: "pending", status: "clarifying", fields: {
      organizations: {resolvedValue: {codes: ["E"], names: ["E"]}, resolutionStatus: "needs_confirmation", source: "resolved"},
    }}), historicalFrame("this-turn-latest", ["F"], {operationFrameId: "this-turn", turnId: "current"})];
  const index = await historyIndex(frames);
  expect(index.fieldSourceFacts.fields.organizations?.sources.map(source => source.frame.frameId))
    .toEqual(["keep", "retry", "other-unresolved"]);
  expect(index.fieldSourceFacts.fields.organizations?.staticUnion?.distinctCount).toBe(3);
});

it("动态范围只展示来源和快照数量，不生成与固定机构的扁平并集", async () => {
  const scoped = historicalFrame("scope", ["B", "C"]);
  scoped.fields.organizations!.resolvedValue = {codes: ["B", "C"], names: ["乙行", "丙行"],
    scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}};
  const index = await historyIndex([historicalFrame("static", ["A"]), scoped]);
  expect(index.fieldSourceFacts.fields.organizations?.sources).toMatchObject([
    {frame: {frameId: "static"}, count: 1}, {frame: {frameId: "scope"}, count: 2, dynamicScope: true},
  ]);
  expect(index.fieldSourceFacts.fields.organizations).not.toHaveProperty("staticUnion");
});

it("截断的索引摘要只计算可见来源，并明确不是全部历史", async () => {
  const frames = Array.from({length: 11}, (_, index) => historicalFrame(`f${index}`, [`C${index}`]));
  const index = await historyIndex(frames);
  expect(index).toMatchObject({total: 11, partial: true, fieldSourceFacts: {indexTruncated: true, scope: "visible_history_entries"}});
  expect(index.fieldSourceFacts.fields.organizations?.sources.map(source => source.ordinal)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect(index.fieldSourceFacts.fields.organizations?.staticUnion?.distinctCount).toBe(10);
  expect(index.fieldSourceFacts.instruction).toMatch(/indexTruncated.*可见并集不代表全部历史/);
});

it("模型说明区分整笔基准与字段多源引用，并说明单候选语义同意证据", async () => {
  for (const compact of [false, true]) {
    const index = await historyIndex([historicalFrame("one", ["A"])], compact);
    expect(index.usage).toMatch(/整笔业务用 base(?:Reference)? 继承/);
    expect(index.usage).toMatch(/字段可通过 sources 独立引用/);
    const schema = modelCapabilitySchemas(compact).find(item => item.capability === "metric_query")!;
    const organizationInput = schema.fields.organizations!.inputSchema as {anyOf: Array<{properties?: {sources?: {maxItems?: number}}}>};
    expect(organizationInput.anyOf.find(input => input.properties?.sources)?.properties?.sources?.maxItems).toBeGreaterThan(1);
    for (const name of ["organizations", "metrics"]) {
      const field = schema.fields[name]!;
      expect(field.description).toContain(FIELD_CONFIRMATION_DESCRIPTION);
      expect(field.description).toMatch(/同一项有多个候选.*须(?:用户)?明确选择/);
      expect(field.inputSchema).toMatchObject({anyOf: expect.arrayContaining([
        expect.objectContaining({required: ["confirm"], properties: expect.objectContaining({evidence:
          expect.objectContaining({required: ["decision", "sourceText"], properties: expect.objectContaining({decision: {const: "accept"}})}),
        })}),
      ])});
    }
  }
});

it("历史组合未决新增项展示保存的绝对索引与原文，不暴露候选且两种参数模式一致", () => {
  const reference = {fromHistory: true, sources: [{frame: {frameId: "old"}, field: "organizations"}], combine: "single", sourceText: "那些机构"};
  const frame: BusinessFrame = {...ready, status: "clarifying", fields: {organizations: {
    rawValue: reference, resolutionStatus: "needs_confirmation", source: "explicit",
    candidates: [{value: "隐藏正式候选", code: "SECRET"}], metadata: {historyReference: reference, referenceAdditionIssues: [
      {index: 3, raw: "新增D", status: "needs_confirmation", candidates: [{value: "隐藏嵌套候选"}]},
      {index: 5, raw: "未知E", status: "not_found"},
    ]},
  }}};
  const before = JSON.stringify(frame);
  for (const compact of [false, true]) {
    const view = modelFrame(frame, "next", compact);
    expect(view.fields.organizations?.unresolvedAdditions).toEqual([
      {index: 3, raw: "新增D", status: "needs_confirmation"}, {index: 5, raw: "未知E", status: "not_found"},
    ]);
    expect(JSON.stringify(view)).not.toContain("隐藏");
    expect(JSON.stringify(view)).not.toContain("SECRET");
  }
  expect(JSON.stringify(frame)).toBe(before);
});

it("非历史机构字段、已解析字段或损坏的新增项元数据不生成替换索引", () => {
  const issues = [{index: 2, raw: "未知E", status: "not_found"}];
  const reference = {fromHistory: true};
  const field = {rawValue: reference, resolutionStatus: "not_found" as const, source: "explicit" as const,
    metadata: {referenceAdditionIssues: issues}};
  expect(modelFrame({...ready, fields: {metrics: field}}, "next").fields.metrics).not.toHaveProperty("unresolvedAdditions");
  expect(modelFrame({...ready, fields: {organizations: {...field, rawValue: "普通名称"}}}, "next").fields.organizations)
    .not.toHaveProperty("unresolvedAdditions");
  expect(modelFrame({...ready, fields: {organizations: {...field, resolutionStatus: "resolved"}}}, "next").fields.organizations)
    .not.toHaveProperty("unresolvedAdditions");
  expect(modelFrame({...ready, fields: {organizations: {...field, metadata: {referenceAdditionIssues: [
    ...issues, {index: -1, raw: "负索引", status: "not_found"}, {index: 4, raw: {candidates: ["候选"]}, status: "not_found"},
    {index: 5, raw: "已确认项", status: "resolved"},
  ]}}}}, "next").fields.organizations?.unresolvedAdditions).toEqual(issues);
});
