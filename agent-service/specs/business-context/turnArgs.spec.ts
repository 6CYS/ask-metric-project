import { expect, it } from "vitest";
import { BusinessInputError } from "../../src/business-context/inputError.js";
import { toContextDelta } from "../../src/business-context/turnArgs.js";
import type { ContextDelta, FrameSelector } from "../../src/business-context/types.js";

const changes: ContextDelta["fieldChanges"] = [
  {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true, mentionIndexes: [1, 3]}},
  {fieldHint: "time", operation: "set", rawValue: "4月末"},
  {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "top", top_n: 4}},
  {fieldHint: "selection", operation: "remove", rawValue: {mentionIndexes: [2]}},
  {fieldHint: "organizations", operation: "clear"},
  {fieldHint: "basis", operation: "retain"},
];

const references: Array<{name: string; base?: ContextDelta["baseReference"]}> = [
  {name: "省略"}, {name: "独立问题", base: null}, {name: "当前焦点", base: "current"},
  {name: "历史选择器", base: {ordinal: 2, relativePosition: -1, capability: "metric_query",
    businessConstraints: {metrics: {codes: ["synthetic-M1"]}}, resultRequired: false}},
];

it.each(references)("内部 Delta 解析保留$name来源、全部操作与原始值", ({base}) => {
  const delta: ContextDelta = {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: structuredClone(changes),
    ...(base === undefined ? {} : {baseReference: base})};
  const converted = toContextDelta(delta);
  expect(converted).toEqual(delta);
  expect(Object.hasOwn(converted, "baseReference")).toBe(base !== undefined);
});

it("兼容 ContextDelta 中的可选目标与用途，不添加不存在的可选值", () => {
  const delta: ContextDelta = {executionMode: "resolve_more", fieldChanges: [],
    goal: {capability: "metric_query", sourceText: "查询合成指标"}, purpose: "supporting"};
  expect(toContextDelta(delta)).toEqual(delta);
});

it("旧格式仍接受所有操作省略原始值，未提供与显式提供 undefined 不互相补写", () => {
  const delta: ContextDelta = {executionMode: "resolve_more", fieldChanges: [
    {fieldHint: "metrics", operation: "set"}, {fieldHint: "organizations", operation: "remove"},
    {fieldHint: "time", operation: "clear"}, {fieldHint: "selection", operation: "retain", rawValue: undefined},
  ]};
  expect(toContextDelta(delta)).toEqual(delta);
  expect(Object.hasOwn(toContextDelta(delta).fieldChanges[0]!, "rawValue")).toBe(false);
  expect(Object.hasOwn(toContextDelta(delta).fieldChanges[3]!, "rawValue")).toBe(true);
});

it("字段名与能力语义留给现有业务校验，解析不重选能力或来源", () => {
  const delta: ContextDelta = {executionMode: "resolve_more", capabilityHint: "future_capability",
    baseReference: {frameId: "selected-history"}, fieldChanges: [{fieldHint: "unknownField", operation: "set", rawValue: "原始值"}]};
  expect(toContextDelta(delta)).toEqual(delta);
});

it("冻结的原始参数和历史 Delta 不会被解析修改", () => {
  const raw = Object.freeze({fromQuestion: true, mentionIndexes: Object.freeze([1, 3])});
  const selector = Object.freeze({frameId: "history-frame"});
  const change = Object.freeze({fieldHint: "metrics", operation: "set" as const, rawValue: raw});
  const delta = Object.freeze({executionMode: "execute" as const, baseReference: selector,
    fieldChanges: Object.freeze([change])}) as unknown as ContextDelta;
  const before = structuredClone(delta);
  toContextDelta(delta);
  expect(delta).toEqual(before);
});

const invalidArguments: Array<{name: string; args: unknown}> = [
  {name: "null", args: null}, {name: "数组", args: []}, {name: "字符串", args: "execute"}, {name: "空对象", args: {}},
  {name: "未知顶层键", args: {executionMode: "execute", extra: true}},
  {name: "旧格式混入未知键", args: {executionMode: "execute", mode: "execute"}},
  {name: "执行方式缺失", args: {capabilityHint: "metric_query"}},
  {name: "执行方式无效", args: {executionMode: "unknown"}},
  {name: "能力非字符串", args: {executionMode: "execute", capabilityHint: 1}},
  {name: "旧修改缺失", args: {executionMode: "execute"}},
  {name: "旧修改非数组", args: {executionMode: "execute", fieldChanges: {time: "4月末"}}},
  {name: "旧修改非对象", args: {executionMode: "execute", fieldChanges: [null]}},
  {name: "旧修改未知键", args: {executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "set", value: "4月末"}]}},
  {name: "旧修改缺字段名", args: {executionMode: "execute", fieldChanges: [{operation: "set"}]}},
  {name: "旧修改操作非法", args: {executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "replace"}]}},
  {name: "旧修改重复字段", args: {executionMode: "execute", fieldChanges: [
    {fieldHint: "time", operation: "set", rawValue: "4月末"}, {fieldHint: "time", operation: "clear"}]}},
  {name: "字段超数量", args: {executionMode: "execute", fieldChanges: Array.from({length: 33}, (_, i) => ({fieldHint: `field${i}`, operation: "clear"}))}},
  {name: "目标未知键", args: {executionMode: "execute", goal: {capability: "metric_query", sourceText: "原文", unknown: true}}},
  {name: "目标缺原文", args: {executionMode: "execute", goal: {capability: "metric_query"}}},
  {name: "业务用途非法", args: {executionMode: "execute", purpose: "unknown"}},
];

it.each(invalidArguments)("$name 返回可识别参数错误，不改写输入", ({args}) => {
  const before = structuredClone(args);
  let error: unknown;
  try { toContextDelta(args); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(BusinessInputError);
  expect(error).toMatchObject({code: "FIELD_CHANGES_INVALID", correction: expect.stringContaining("原焦点未改变")});
  expect(args).toEqual(before);
});

it.each([{}, {ordinal: 0}, {ordinal: 1.5}, {relativePosition: 1}, {relativePosition: -0.5},
  {frameId: ""}, {frameId: 3}, {unknown: 1}, {businessConstraints: []}, {resultRequired: "true"},
  {capability: null}] satisfies unknown[])("非法历史选择器 %j 不降级到当前焦点", base => {
  expect(() => toContextDelta({executionMode: "execute", fieldChanges: [], baseReference: base})).toThrow(BusinessInputError);
  try { toContextDelta({executionMode: "execute", fieldChanges: [], baseReference: base}); } catch (error) {
    expect(error).toMatchObject({code: "FRAME_SELECTOR_INVALID", field: "$base"});
  }
});

it.each([undefined, false, 0, "history", []])("非法来源 %j 不被解释为省略或新建", base => {
  expect(() => toContextDelta({executionMode: "execute", fieldChanges: [], baseReference: base})).toThrow(BusinessInputError);
});

it.each([{frameId: "history"}, {ordinal: 1}, {relativePosition: 0}, {businessConstraints: {time: "4月末"}},
  {capability: "metric_query"}, {resultRequired: true}] satisfies FrameSelector[])("现有来源选择器结构 %j 保持不变", base => {
  expect(toContextDelta({executionMode: "execute", fieldChanges: [], baseReference: base}).baseReference).toEqual(base);
});

it("危险对象键也只是字段名，不改变返回对象的原型", () => {
  const rawValue = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const converted = toContextDelta({executionMode: "execute", fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue}]});
  expect(({} as {polluted?: boolean}).polluted).toBeUndefined();
  expect(converted.fieldChanges[0]!.rawValue).toEqual(rawValue);
});
