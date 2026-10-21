import {expect, it} from "vitest";
import {analysisFollowupToolView} from "../../src/semantic-task/analysisToolView.js";
import {semanticParameters, prepareSemanticArguments} from "../../src/semantic-task/protocol.js";

it("补查Schema收窄为单目标并显式必填inquiry，不修改首查或共享Schema", () => {
  const payload = {tools: [{type: "function", function: {name: "resolve_business_turn", parameters: semanticParameters}},
    {type: "function", function: {name: "catalog", parameters: {}}}]};
  const original = JSON.stringify(payload);
  expect(analysisFollowupToolView(payload, false)).toBe(payload);
  const view = analysisFollowupToolView(payload, true) as typeof payload;
  const schema = view.tools[0]!.function.parameters as any;
  expect(schema.properties.targets.maxItems).toBe(1);
  expect(schema.definitions.target.properties.analysis.oneOf.every((branch: any) => branch.properties.plan.required.includes("inquiry"))).toBe(true);
  expect(view.tools[1]).toBe(payload.tools[1]);
  expect(JSON.stringify(payload)).toBe(original);
});

it("多个通用计划在执行前拒绝，保留多主题子问题应在单个计划内提交", () => {
  const target = {source: {kind: "new"}, analysis: {kind: "business_analysis", plan: {
    objective: "隔离测试", scope_notice: "隔离测试", requirements: [{id: "q1", question: "隔离测试", gap_reason: "目录未发现"}], steps: [],
  }}};
  expect(() => prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [target, target]})).toThrow("SHAPE_INVALID");
  expect(prepareSemanticArguments({protocol_version: 2, intent: "analyze", targets: [target]}).targets).toHaveLength(1);
});
