import {expect, it} from "vitest";
import {modelFrame} from "./modelView.js";
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
