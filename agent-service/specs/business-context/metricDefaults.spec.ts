import {expect, it} from "vitest";
import {applyMetricDefaultContext} from "../../src/business-context/metricDefaults.js";
import type {FieldResolution} from "../../src/business-context/types.js";

const value = (codes: string[]) => ({codes, names: codes.map(code => `合成指标${code}`)});
const defaults = (): FieldResolution => ({status: "resolved", value: value(["P"]), metadata: {
  metric_defaults: [{value: value(["P"]), default_value_basis: "当日数",
    context_codes: ["P", "A", "PY"]}],
}});

it("首问采用服务端业务默认，追问优先保留已确认的同指标口径", () => {
  const found = defaults();
  expect(applyMetricDefaultContext(found)).toBe(found);
  expect(applyMetricDefaultContext(found, value(["A", "INCOME"])).value).toEqual(value(["A"]));
  expect(applyMetricDefaultContext(found, value(["PY"])).value).toEqual(value(["PY"]));
  expect(applyMetricDefaultContext(found, value(["INCOME"]))).toBe(found);
  expect(found.value).toEqual(value(["P"]));
});

it("显式完整名称和口径始终覆盖已确认口径", () => {
  const explicit: FieldResolution = {status: "resolved", value: value(["P"])};
  expect(applyMetricDefaultContext(explicit, value(["A"]))).toBe(explicit);
});

it("当前任务存在同指标多个已确认口径时保留歧义，不任取一个", () => {
  const result = applyMetricDefaultContext(defaults(), value(["A", "PY"]));
  expect(result.status).toBe("needs_confirmation");
  expect(result.candidates?.map(item => item.code)).toEqual(["A", "PY"]);
});

it("原问片段与字段解析两种回执使用同一上下文规则", () => {
  const mention: FieldResolution = {status: "resolved", value: value(["P"]), metadata: {
    default_value_basis: "当日数", context_codes: ["A"],
  }};
  const result = applyMetricDefaultContext(mention, value(["A"]));
  expect(result.value).toEqual(value(["A"]));
  expect(result.metadata?.default_context_applied).toBe(true);
});

it("混合指标中的泛称只修改对应成员，其余显式指标保持", () => {
  const result = applyMetricDefaultContext({...defaults(), value: value(["P", "INCOME"])}, value(["A"]));
  expect((result.value as {codes: string[]}).codes).toEqual(["INCOME", "A"]);
});
