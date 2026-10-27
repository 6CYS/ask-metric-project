import {afterEach, expect, it, type Mock} from "vitest";
import type {BackendClient} from "../../src/backendClient.js";
import {fixture, metricNames} from "./fixtures.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import {catalogBindingView} from "../../src/analysis/bindings.js";
import {completeExplicitMetricCoverage} from "../../src/analysis/metricCoverage.js";
import type {AnalysisPlan} from "../../src/analysis/contracts.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of clean.splice(0)) await close();});

it("默认指标仍须被分析覆盖，但不把来源已确认的同概念口径替换回默认", async () => {
  const f = await fixture(); clean.push(f.close);
  const match = f.backend.matchMetricQuestion.getMockImplementation()!;
  f.backend.matchMetricQuestion.mockImplementation(async question => ({mentions: (await match(question)).mentions.map(mention =>
    ({...mention, resolution: {...mention.resolution, metadata: {resolution_source: "business_default", context_codes: ["M1", "M2"]}}}))}));
  const request = f.request("default-coverage", "合成指标甲是多少？");
  catalogBindingView(request, Object.entries(metricNames).map(([code, name]) => ({code, name, binding_ref: `signed-${code}`})));
  const plan = (ref: string): AnalysisPlan => ({objective: "读取目标指标", scope_notice: "合成隔离样本",
    requirements: [{id: "q1", question: request.originalMessage}],
    steps: [{id: "read", method: "observe", metric_refs: [ref], answers: ["q1"], rationale: "正式目录绑定"}]});
  const inherited = plan("signed-M2");
  expect(await completeExplicitMetricCoverage(request, inherited)).toEqual(inherited);
  const missing = await completeExplicitMetricCoverage(request, plan("signed-M3"));
  expect(missing.steps).toHaveLength(2);
  expect(missing.steps[1]!.metric_refs).toEqual(["k1"]);
});

it("普通查询追问也优先沿用已确认口径，显式换口径后重新绑定", async () => {
  const f = await fixture(); clean.push(f.close);
  const firstRequest = f.request("metric-default-initial", "查询合成机构甲2025年末的合成指标乙");
  const first = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "query", targets: [{source: {kind: "new"},
    query: {organizations: {kind: "named", names: ["合成机构甲"]}, metrics: ["合成指标乙"],
      time: {expression: "2025年末"}, selection: "exact", operation: {kind: "value"}}}]}, firstRequest);
  expect(first.details.status, JSON.stringify(first.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: first.details.state.task_ref, target_ref: first.details.state.targets[0]!.target_ref}, firstRequest);
  const metadata = {default_value_basis: "当日数", resolution_source: "business_default",
    context_codes: ["M1", "M2"]};
  const defaultValue = {codes: ["M1"], names: [metricNames.M1]};
  const resolveField = f.backend.resolveBusinessField as unknown as Mock<BackendClient["resolveBusinessField"]>;
  const resolve = resolveField.getMockImplementation()!;
  resolveField.mockImplementation(async (...args) => args[0] === "metric" && args[1][0] === "合成指标乙"
    ? {status: "resolved", value: defaultValue, metadata: {metric_defaults: [{...metadata, value: defaultValue}]}} : resolve(...args));
  const match = f.backend.matchMetricQuestion.getMockImplementation()!;
  f.backend.matchMetricQuestion.mockImplementation(async question => {
    const found = await match(question);
    return {mentions: found.mentions.map(mention => mention.text === "合成指标乙"
      ? {...mention, resolution: {status: "resolved", value: defaultValue, metadata}} : mention)};
  });
  const follow = f.request("metric-default-follow", "那只看合成指标乙呢？");
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "query", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "metrics", value: "合成指标乙"}]}]}, follow);
  expect(result.details.status, JSON.stringify(result.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.details.state.task_ref, target_ref: result.details.state.targets[0]!.target_ref}, follow);
  expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M2"],
    org_codes: ["O1"], time: {start: "2025-12-31", end: "2025-12-31"}});
  const explicit = f.request("metric-default-explicit", "改查合成指标甲");
  const changed = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "query", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "metrics", value: "合成指标甲"}]}]}, explicit);
  expect(changed.details.status, JSON.stringify(changed.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: changed.details.state.task_ref, target_ref: changed.details.state.targets[0]!.target_ref}, explicit);
  expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"]});
});
