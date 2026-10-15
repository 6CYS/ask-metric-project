import { expect, it } from "vitest";
import { BusinessInputError } from "../../src/business-context/inputError.js";
import { toCompactTurnArgs, toContextDelta, toLegacyTurnArgs } from "../../src/business-context/turnArgs.js";
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

it.each(references)("新旧双向转换保留$name来源、全部操作与原始值", ({base}) => {
  const delta: ContextDelta = {capabilityHint: "metric_query", executionMode: "execute", fieldChanges: structuredClone(changes),
    ...(base === undefined ? {} : {baseReference: base})};
  const compact = toCompactTurnArgs(delta);
  expect(compact).toEqual({capability: "metric_query", mode: "execute", ...(base === undefined ? {} : {base}),
    set: {metrics: {fromQuestion: true, mentionIndexes: [1, 3]}, time: "4月末", operation: {kind: "ranking", position: "top", top_n: 4}},
    remove: {selection: {mentionIndexes: [2]}}, clear: ["organizations"], retain: ["basis"]});
  expect(Object.hasOwn(compact, "base")).toBe(base !== undefined);
  const converted = toContextDelta(compact);
  expect(converted).toEqual(delta);
  expect(toContextDelta(JSON.parse(JSON.stringify(compact)))).toEqual(delta);
  expect(Object.hasOwn(converted, "baseReference")).toBe(base !== undefined);
  expect(toContextDelta(toLegacyTurnArgs(converted))).toEqual(delta);
  expect(toCompactTurnArgs(toContextDelta(toLegacyTurnArgs(delta)))).toEqual(compact);
});

it.each(["execute", "resolve_more", "reuse_result"] as const)("无字段修改的%s保留可选键省略", executionMode => {
  const delta = {executionMode, fieldChanges: []};
  expect(toCompactTurnArgs(delta)).toEqual({mode: executionMode});
  expect(toContextDelta({mode: executionMode})).toEqual(delta);
  expect(toLegacyTurnArgs(delta)).toEqual(delta);
});

it("兼容 ContextDelta 中的可选目标与用途，不添加不存在的可选值", () => {
  const delta: ContextDelta = {executionMode: "resolve_more", fieldChanges: [],
    goal: {capability: "metric_query", sourceText: "查询合成指标"}, purpose: "supporting"};
  const compact = toCompactTurnArgs(delta);
  expect(compact).toEqual({mode: "resolve_more", goal: delta.goal, purpose: "supporting"});
  expect(toContextDelta(compact)).toEqual(delta);
  expect(toLegacyTurnArgs(delta)).toEqual(delta);
});

it("旧格式仍接受所有操作省略原始值，未提供与显式提供 undefined 不互相补写", () => {
  const delta: ContextDelta = {executionMode: "resolve_more", fieldChanges: [
    {fieldHint: "metrics", operation: "set"}, {fieldHint: "organizations", operation: "remove"},
    {fieldHint: "time", operation: "clear"}, {fieldHint: "selection", operation: "retain", rawValue: undefined},
  ]};
  expect(toContextDelta(delta)).toEqual(delta);
  expect(toLegacyTurnArgs(delta)).toEqual(delta);
  expect(Object.hasOwn(toContextDelta(delta).fieldChanges[0]!, "rawValue")).toBe(false);
  expect(Object.hasOwn(toContextDelta(delta).fieldChanges[3]!, "rawValue")).toBe(true);
  expect(() => toCompactTurnArgs(delta)).toThrow(BusinessInputError);
});

it.each([
  {fieldHint: "metrics", operation: "set"},
  {fieldHint: "metrics", operation: "remove"},
  {fieldHint: "metrics", operation: "set", rawValue: undefined},
  {fieldHint: "metrics", operation: "remove", rawValue: undefined},
  {fieldHint: "time", operation: "clear", rawValue: undefined},
  {fieldHint: "time", operation: "retain", rawValue: undefined},
  {fieldHint: "time", operation: "clear", rawValue: "4月末"},
  {fieldHint: "time", operation: "retain", rawValue: null},
] satisfies ContextDelta["fieldChanges"])("非规范旧操作 %j 仍可回读，但精简转换拒绝丢弃原始值", change => {
  const delta: ContextDelta = {executionMode: "execute", fieldChanges: [change]};
  expect(toContextDelta(delta)).toEqual(delta);
  expect(toLegacyTurnArgs(delta)).toEqual(delta);
  try { toCompactTurnArgs(delta); } catch (error) {
    expect(error).toMatchObject({code: "FIELD_CHANGES_INVALID", field: "$fields"});
    return;
  }
  throw new Error("精简转换应拒绝非规范旧操作");
});

it.each([
  {name: "NaN", rawValue: NaN}, {name: "Infinity", rawValue: Infinity}, {name: "-Infinity", rawValue: -Infinity},
  {name: "-0", rawValue: -0}, {name: "BigInt", rawValue: BigInt(1)}, {name: "Symbol", rawValue: Symbol("value")},
  {name: "Date", rawValue: new Date("2026-04-30")}, {name: "嵌套undefined", rawValue: {nested: undefined}},
  {name: "数组undefined", rawValue: [undefined]}, {name: "数组空槽", rawValue: Array(1)},
  {name: "函数", rawValue: () => "value"},
])("无法无损JSON传输的$name原始值不静默转换", ({rawValue}) => {
  const delta: ContextDelta = {executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "set", rawValue}]};
  expect(toContextDelta(delta)).toEqual(delta);
  expect(() => toCompactTurnArgs(delta)).toThrow(BusinessInputError);
});

it("循环值不能成为精简JSON参数，重复引用的正常对象仍可转换", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => toCompactTurnArgs({executionMode: "execute", fieldChanges: [
    {fieldHint: "metrics", operation: "set", rawValue: circular}]})).toThrow(BusinessInputError);
  const repeated = {fromQuestion: true};
  const args = {mode: "execute", set: {a: repeated, b: repeated}};
  expect(toCompactTurnArgs(toContextDelta(args))).toEqual(args);
});

it("set/remove 中原始空值、布尔值、数字和对象都原样保留", () => {
  const args = {mode: "execute", set: {a: null, b: false, c: 0, d: "", e: ["合成值"]}, remove: {f: {mentionIndexes: []}}};
  expect(toCompactTurnArgs(toContextDelta(args))).toEqual(args);
});

it("字段名与能力语义留给现有业务校验，转换不重选能力或来源", () => {
  const args = {mode: "resolve_more", capability: "future_capability", base: {frameId: "selected-history"}, set: {unknownField: "原始值"}};
  expect(toCompactTurnArgs(toContextDelta(args))).toEqual(args);
});

it("冻结的原始参数和历史 Delta 不会被转换修改", () => {
  const raw = Object.freeze({fromQuestion: true, mentionIndexes: Object.freeze([1, 3])});
  const selector = Object.freeze({frameId: "history-frame"});
  const change = Object.freeze({fieldHint: "metrics", operation: "set" as const, rawValue: raw});
  const delta = Object.freeze({executionMode: "execute" as const, baseReference: selector,
    fieldChanges: Object.freeze([change])}) as unknown as ContextDelta;
  const before = structuredClone(delta);
  const compact = toCompactTurnArgs(delta);
  toContextDelta(Object.freeze(compact));
  toLegacyTurnArgs(delta);
  expect(delta).toEqual(before);
});

const invalidArguments: Array<{name: string; args: unknown}> = [
  {name: "null", args: null}, {name: "数组", args: []}, {name: "字符串", args: "execute"}, {name: "空对象", args: {}},
  {name: "未知顶层键", args: {mode: "execute", extra: true}},
  {name: "新旧能力键混合", args: {mode: "execute", capabilityHint: "metric_query"}},
  {name: "新旧来源键混合", args: {mode: "execute", baseReference: null}},
  {name: "新旧修改键混合", args: {mode: "execute", fieldChanges: []}},
  {name: "执行方式缺失", args: {set: {time: "4月末"}}},
  {name: "执行方式无效", args: {mode: "unknown"}},
  {name: "能力非字符串", args: {mode: "execute", capability: 1}},
  {name: "set不是对象", args: {mode: "execute", set: ["time"]}},
  {name: "remove不是对象", args: {mode: "execute", remove: null}},
  {name: "clear不是数组", args: {mode: "execute", clear: "time"}},
  {name: "retain不是数组", args: {mode: "execute", retain: {time: true}}},
  {name: "clear字段非字符串", args: {mode: "execute", clear: [1]}},
  {name: "retain字段为空", args: {mode: "execute", retain: [""]}},
  {name: "set字段为空", args: {mode: "execute", set: {"": "x"}}},
  {name: "单组重复字段", args: {mode: "execute", clear: ["time", "time"]}},
  {name: "跨组重复字段", args: {mode: "execute", set: {time: "4月末"}, retain: ["time"]}},
  {name: "旧修改缺失", args: {executionMode: "execute"}},
  {name: "旧修改非数组", args: {executionMode: "execute", fieldChanges: {time: "4月末"}}},
  {name: "旧修改非对象", args: {executionMode: "execute", fieldChanges: [null]}},
  {name: "旧修改未知键", args: {executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "set", value: "4月末"}]}},
  {name: "旧修改缺字段名", args: {executionMode: "execute", fieldChanges: [{operation: "set"}]}},
  {name: "旧修改操作非法", args: {executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "replace"}]}},
  {name: "旧修改重复字段", args: {executionMode: "execute", fieldChanges: [
    {fieldHint: "time", operation: "set", rawValue: "4月末"}, {fieldHint: "time", operation: "clear"}]}},
  {name: "字段超数量", args: {mode: "execute", clear: Array.from({length: 33}, (_, i) => `field${i}`)}},
  {name: "目标未知键", args: {mode: "execute", goal: {capability: "metric_query", sourceText: "原文", unknown: true}}},
  {name: "目标缺原文", args: {mode: "execute", goal: {capability: "metric_query"}}},
  {name: "业务用途非法", args: {mode: "execute", purpose: "unknown"}},
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
  expect(() => toContextDelta({mode: "execute", base})).toThrow(BusinessInputError);
  try { toContextDelta({mode: "execute", base}); } catch (error) {
    expect(error).toMatchObject({code: "FRAME_SELECTOR_INVALID", field: "$base"});
  }
});

it.each([undefined, false, 0, "history", []])("非法来源 %j 不被解释为省略或新建", base => {
  expect(() => toContextDelta({mode: "execute", base})).toThrow(BusinessInputError);
});

it.each([{frameId: "history"}, {ordinal: 1}, {relativePosition: 0}, {businessConstraints: {time: "4月末"}},
  {capability: "metric_query"}, {resultRequired: true}] satisfies FrameSelector[])("现有来源选择器结构 %j 保持不变", base => {
  expect(toContextDelta({mode: "execute", base}).baseReference).toEqual(base);
});

it("危险对象键也只是字段名，不改变返回对象的原型", () => {
  const set = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const converted = toCompactTurnArgs(toContextDelta({mode: "execute", set}));
  expect(Object.getPrototypeOf(converted.set)).toBe(Object.prototype);
  expect(Object.hasOwn(converted.set!, "__proto__")).toBe(true);
  expect(({} as {polluted?: boolean}).polluted).toBeUndefined();
});
