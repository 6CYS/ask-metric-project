import {expect, it} from "vitest";
import {Compile} from "typebox/compile";
import {Type} from "@earendil-works/pi-ai";
import type {BackendClient} from "../backendClient.js";
import {MemoryCommandBridge, testRequestContext} from "../tools/testUtils.js";
import {analysisPublicParameters, materializeAnalysisActions} from "./actions.js";
import {catalogBindingView} from "./bindings.js";
import {prepareSemanticArguments, semanticParameters} from "../semantic-task/protocol.js";
import {semanticPublicToolDefinitions} from "../semantic-task/tools.js";

function setup() {
  const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {originalMessage: "比较利润最低机构的收入变化"});
  catalogBindingView(request, [{code: "profit", name: "合成利润", binding_ref: "signed-profit"},
    {code: "income", name: "合成收入", binding_ref: "signed-income"}]);
  return request;
}
const proposal = (actions: unknown[], based_on?: string[]) => ({protocol_version: 2, intent: "analyze", targets: [
  {source: {kind: "new"}, analysis: {kind: "business_analysis", actions, ...(based_on ? {based_on} : {})}},
]});

it("模型只选问题、指标和方法，宿主编译节点、回答关联和排名依赖，原参数不变", async () => {
  const raw = proposal([{question: "哪家利润最低", method: "ranking", metrics: ["k1"], position: "bottom", count: 1},
    {question: "入选机构收入如何变化", metrics: ["k2"], method: "compare", comparisons: ["mom"], from_ranking: 1}]);
  const before = structuredClone(raw);
  const compiled = prepareSemanticArguments(await materializeAnalysisActions(raw, setup()));
  const analysis = compiled.targets[0]!.analysis;
  expect(analysis?.kind).toBe("business_analysis");
  if (analysis?.kind !== "business_analysis") throw new Error("missing plan");
  expect(analysis.plan.requirements).toEqual([{id: "q1", question: "哪家利润最低"}, {id: "q2", question: "入选机构收入如何变化"}]);
  expect(analysis.plan.steps).toMatchObject([
    {id: "s1", method: "ranking", answers: ["q1"], metric_refs: ["signed-profit"], top_n: 1, position: "bottom"},
    {id: "s2", answers: ["q2"], metric_refs: ["signed-income"], depends_on: ["s1"], organization_from_step: "s1"},
  ]);
  expect(raw).toEqual(before);
  expect(compiled.targets[0]?.operations).toEqual([]);
});

it("读取默认observe，具体缺口可以保留，不自动编造指标或步骤", async () => {
  const compiled = prepareSemanticArguments(await materializeAnalysisActions(proposal([
    {question: "利润水平", metrics: ["k1"]}, {question: "费用构成", gap: "已核对目录，未取得费用分项"},
  ]), setup()));
  expect(compiled.targets[0]?.analysis?.plan).toMatchObject({requirements: [
    {id: "q1"}, {id: "q2", gap_reason: "已核对目录，未取得费用分项"},
  ], steps: [{id: "s1", method: "observe"}]});
});

it.each([
  [{question: "利润排名", metrics: ["k1"], method: "ranking"}],
  [{question: "同比", metrics: ["k1"], method: "compare"}],
  [{question: "构成", metrics: ["k1"], method: "structure"}],
  [{question: "未来节点", metrics: ["k1"], from_ranking: 2}],
  [{question: "自引用", metrics: ["k1"], from_ranking: 1}],
  [{question: "含糊参数", metrics: ["k1"], position: "top"}],
  [{question: "虚构候选", metrics: ["k999"]}],
  [{question: "混用缺口", metrics: ["k1"], gap: "尚未查询"}],
])("拒绝不可执行的局部动作，不猜测范围或排序：%j", async action => {
  await expect(materializeAnalysisActions(proposal([action]), setup())).rejects.toBeInstanceOf(Error);
});

it("补查只选择已取得的触发证据，程序补齐inquiry，未来证据拒绝", async () => {
  const request = setup();
  request.answerEvidence = async () => [{ref: "e1", evidence: {kind: "analysis_evidence", status: "succeeded",
    evidence_items: [{ref: "profit-fact", type: "fact", display: "合成值"}]}}];
  const input = proposal([{question: "收入能否解释利润变化", metrics: ["k2"]}], ["e1.v1"]);
  const compiled = prepareSemanticArguments(await materializeAnalysisActions(input, request));
  expect(compiled.targets[0]?.analysis?.plan.inquiry).toMatchObject({question: "收入能否解释利润变化", basis_refs: ["e1.v1"]});
  await expect(materializeAnalysisActions(proposal(input.targets[0]!.analysis.actions, ["e9.v1"]), request)).rejects.toBeInstanceOf(Error);
});

it("模型实际payload暴露轻量动作，内部历史计划契约保持兼容", () => {
  const before = JSON.stringify(semanticParameters);
  const parameters = analysisPublicParameters(semanticParameters);
  const validator = Compile(Type.Unsafe(parameters as Record<string, unknown>));
  expect(validator.Check(proposal([{question: "利润水平", metrics: ["k1"]}]))).toBe(true);
  const schema = (parameters as any).definitions.target.properties.analysis.oneOf[0];
  expect(schema.properties).not.toHaveProperty("plan");
  expect(schema.properties.actions.items.properties).not.toHaveProperty("answers");
  expect(JSON.stringify(schema).length).toBeLessThan(JSON.stringify((semanticParameters as any).definitions.target.properties.analysis.oneOf[0]).length);
  const payload = semanticPublicToolDefinitions({tools: [{type: "function", function: {name: "resolve_business_turn"}}]}) as any;
  expect(payload.tools[0].function.parameters).toEqual(parameters);
  expect(JSON.stringify(semanticParameters)).toBe(before);
});
