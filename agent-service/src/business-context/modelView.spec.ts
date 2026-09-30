import {expect, it} from "vitest";
import {displayConditions, modelFrame} from "./modelView.js";
import type {BusinessFrame} from "./types.js";

const ready: BusinessFrame = {frameId: "f", sessionId: "s", turnId: "t", requestId: "r", capability: "metric_query",
  operationFrameId: "f", fields: {}, delta: {fieldChanges: [], executionMode: "execute"}, issues: [], status: "ready", createdAt: "2026-09-22"};

it("本轮可执行焦点仅提供执行动作，不能同时提示重新解析", () => {
  const view = modelFrame(ready, "t");
  expect(view.currentTurn).toBe(true);
  expect(view).not.toHaveProperty("continuation");
  expect(view.nextAction).toEqual({tool: "execute_business_frame", arguments: {frameId: "f"}});
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
