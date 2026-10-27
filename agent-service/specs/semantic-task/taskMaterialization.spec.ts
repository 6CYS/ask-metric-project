import {afterEach, expect, it, vi} from "vitest";
import {fixture, metricNames} from "./fixtures.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {AnalysisPlan} from "../../src/analysis/contracts.js";
import type {SemanticOperation} from "../../src/semantic-task/protocol.js";
import {materializeTaskRequest} from "../../src/semantic-task/taskMaterialization.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {validateFrame} from "../../src/business-context/core.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
const descriptors = Object.entries(metricNames).map(([code, name]) => ({code, name, binding_ref: `signed-${code}`}));
const initialPlan = (): AnalysisPlan => ({objective: "比较两家机构的两个指标", scope_notice: "合成隔离数据",
  requirements: [{id: "q", question: "两家有何差异？"}], steps: [{id: "s", method: "observe",
    metric_refs: ["signed-M1", "signed-M2"], answers: ["q"], rationale: "按正式指标比较"}]});

async function setup(plan = initialPlan()) {
  const f = await fixture(); cleanup.push(f.close);
  const backend = Object.assign(f.backend, {
    analysisValidate: vi.fn(async (value: AnalysisPlan) => ({status: "validated", metric_descriptors:
      descriptors.filter(item => value.steps.some(step => step.metric_refs.includes(item.binding_ref)))})),
    analysisCatalog: vi.fn(async (code: string) => ({items: descriptors.filter(item => item.code === code)})),
    analysisExecute: vi.fn(async (_payload: Record<string, unknown>, _key: string, _options?: unknown) => ({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
      run_ref: "synthetic-run", scope_id: "synthetic-scope", org_codes: ["O1", "O2"], tasks: [], rows: [],
      gaps: [], evidence_items: [], metric_descriptors: descriptors})),
  });
  const request = f.request("full-task-first", "比较合成机构甲和合成机构乙近期的合成指标甲、合成指标乙");
  const first = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "new"},
    operations: [{action: "set", field: "organizations", value: "合成机构甲和合成机构乙"}, {action: "set", field: "time", value: "近期"}],
    analysis: {kind: "business_analysis", plan}}]}, request);
  expect(first.details.status, JSON.stringify(first.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: first.details.state.task_ref, target_ref: first.details.state.targets[0]!.target_ref}, request);
  const original = await request.semanticTasks!.plan(first.details.state.task_ref!);
  return {...f, backend, first, original};
}

it("连续追问先重建完整任务：缩减、追加指标、改日期、恢复最近、改排名均保留两家机构", async () => {
  const f = await setup();
  const turns: Array<{question: string; operations: SemanticOperation[]; refs: string[]; date: string; method?: string; position?: string}> = [
    {question: "那只比较合成指标乙呢？", operations: [{action: "set", field: "metrics", value: "合成指标乙"}], refs: ["signed-M2"], date: "latest_snapshot"},
    {question: "再加上合成指标甲", operations: [{action: "add", field: "metrics", value: "合成指标甲"}], refs: ["signed-M2", "signed-M1"], date: "latest_snapshot"},
    {question: "改看2024年末", operations: [{action: "set", field: "time", value: "2024年末"}], refs: ["signed-M2", "signed-M1"], date: "exact"},
    {question: "再看近期", operations: [{action: "set", field: "time", value: "近期"}], refs: ["signed-M2", "signed-M1"], date: "latest_snapshot"},
    {question: "只比较合成指标乙，取最低一家", operations: [{action: "set", field: "metrics", value: "合成指标乙"},
      {action: "set", field: "operation", queryOperation: {kind: "ranking", position: "bottom", top_n: 1}} as SemanticOperation],
      refs: ["signed-M2"], date: "latest_snapshot", method: "ranking", position: "bottom"},
    {question: "那最高一家呢？", operations: [{action: "set", field: "operation", queryOperation: {kind: "ranking", position: "top", top_n: 1}} as SemanticOperation],
      refs: ["signed-M2"], date: "latest_snapshot", method: "ranking", position: "top"},
  ];
  for (const [index, turn] of turns.entries()) {
    const request = f.request(`full-task-follow-${index}`, turn.question);
    const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: index % 2 ? "query" : "analyze",
      targets: [{source: {kind: "current"}, operations: turn.operations}]}, request);
    expect(ready.details.status, JSON.stringify(ready.details)).toBe("ready");
    const task = await request.semanticTasks!.get((await request.semanticTasks!.plan(ready.details.state.task_ref!))!.steps[0]!.taskRef!);
    expect(task!.capability).toBe("business_analysis");
    expect(Object.keys(task!.target.fields).sort()).toEqual(["organizations", "plan", "time"]);
    await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state.task_ref, target_ref: ready.details.state.targets[0]!.target_ref}, request);
    const payload = f.backend.analysisExecute.mock.calls.at(-1)![0] as Record<string, any>;
    expect(payload.org_codes).toEqual(["O1", "O2"]);
    expect(payload.date_selection).toBe(turn.date);
    expect(payload.plan.steps[0]).toMatchObject({method: turn.method ?? "observe", metric_refs: turn.refs,
      ...(turn.position ? {position: turn.position, top_n: 1} : {})});
    if (turn.date === "exact") expect(payload).toMatchObject({start: "2024-12-31", end: "2024-12-31"});
    else expect(payload).not.toHaveProperty("start");
  }
  expect(await f.request().semanticTasks!.plan(f.first.details.state.task_ref!)).toEqual(f.original);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("新增指标取得正式目录绑定，排除指标保留其余集合", async () => {
  const f = await setup();
  for (const [index, operations, question, expected] of [
    [0, [{action: "add", field: "metrics", value: "合成指标丙"}], "再加合成指标丙", ["signed-M1", "signed-M2", "signed-M3"]],
    [1, [{action: "exclude", field: "metrics", subject: "合成指标甲"}], "去掉合成指标甲", ["signed-M2", "signed-M3"]],
  ] as const) {
    const request = f.request(`new-metric-${index}`, question);
    const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"}, operations}]}, request);
    expect(ready.details.status, JSON.stringify(ready.details)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state.task_ref, target_ref: ready.details.state.targets[0]!.target_ref}, request);
    expect((f.backend.analysisExecute.mock.calls.at(-1)![0] as any).plan.steps[0].metric_refs).toEqual(expected);
  }
  expect(f.backend.analysisCatalog).toHaveBeenCalledWith("M3", 1, 1, expect.anything());
});

it("模型追加指标同时重复附带旧观察动作时，按本轮变化生成完整目标", async () => {
  const plan = initialPlan(); plan.steps[0]!.metric_refs = ["signed-M2"];
  const f = await setup(plan), request = f.request("mixed-follow", "再加合成指标甲");
  const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    operations: [{action: "add", field: "metrics", value: "合成指标甲"}], analysis: {kind: "business_analysis", plan}}]}, request);
  expect(ready.details.status, JSON.stringify(ready.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state.task_ref, target_ref: ready.details.state.targets[0]!.target_ref}, request);
  const payload = f.backend.analysisExecute.mock.calls.at(-1)![0] as any;
  expect(payload.plan.steps[0].metric_refs).toEqual(["signed-M2", "signed-M1"]);
  expect(payload.date_selection).toBe("latest_snapshot");
  expect(payload.org_codes).toEqual(["O1", "O2"]);
});

it("恢复刚移除指标时用同话题已确认的正式身份消解泛称，不选择其他新口径", async () => {
  const f = await setup();
  const narrow = f.request("identity-narrow", "只比较合成指标乙");
  const first = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "query", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "metrics", value: "合成指标乙"}]}]}, narrow);
  await runTool(createSemanticExecuteTool(), {task_ref: first.details.state.task_ref, target_ref: first.details.state.targets[0]!.target_ref}, narrow);
  const resolve = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "metric" && args[1][0] === "合成指标甲"
    ? {status: "ambiguous", candidates: [{code: "M1", value: "合成指标甲"}, {code: "M3", value: "其他口径"}]} : resolve(...args));
  const request = f.request("identity-restore", "再加上合成指标甲");
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "query", targets: [{source: {kind: "current"},
    operations: [{action: "add", field: "metrics", value: "合成指标甲"}]}]}, request);
  expect(result.details.status, JSON.stringify(result.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.details.state.task_ref, target_ref: result.details.state.targets[0]!.target_ref}, request);
  expect((f.backend.analysisExecute.mock.calls.at(-1)![0] as any).plan.steps[0].metric_refs).toEqual(["signed-M2", "signed-M1"]);
});

it("混填分析包含额外依赖或新目标时要求重规划，不能丢弃模型的新分析目标", async () => {
  const f = await setup(), request = f.request("mixed-complex", "加合成指标甲并分析变化");
  const plan = initialPlan(); plan.steps[0]!.method = "compare"; plan.steps[0]!.comparisons = ["yoy"];
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    operations: [{action: "add", field: "metrics", value: "合成指标甲"}], analysis: {kind: "business_analysis", plan}}]}, request);
  expect(result.details.status).toBe("needs_interpretation");
  expect(result.details.issues).toContainEqual(expect.objectContaining({code: "TASK_MATERIALIZATION_REQUIRED", remediation: "pi"}));
  expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
});

it("多个独立观察步骤缩减指标时重新组合目标，不携带已取消的分析义务", async () => {
  const plan = initialPlan();
  plan.requirements = [{id: "q1", question: "看甲"}, {id: "q2", question: "看乙"}];
  plan.steps = [
    {...plan.steps[0]!, metric_refs: ["signed-M1"], answers: ["q1"]},
    {...plan.steps[0]!, id: "s2", metric_refs: ["signed-M2"], answers: ["q2"]},
  ];
  const f = await setup(plan), request = f.request("independent-follow", "只比较合成指标乙");
  const ready = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "query", targets: [{source: {kind: "reference",
    task_ref: f.first.details.state.task_ref, target_ref: f.first.details.state.targets[0]!.target_ref},
  operations: [{action: "set", field: "metrics", value: "合成指标乙"}]}]}, request);
  expect(ready.details.status, JSON.stringify(ready.details)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state.task_ref, target_ref: ready.details.state.targets[0]!.target_ref}, request);
  const executed = (f.backend.analysisExecute.mock.calls.at(-1)![0] as any).plan;
  expect(executed.steps).toHaveLength(1);
  expect(executed.steps[0].metric_refs).toEqual(["signed-M2"]);
  expect(executed.requirements).toEqual([{id: "q1", question: "只比较合成指标乙"}]);
});

it.each([1, 10, 20, 61])("完整任务继承%d家机构集合引用，无需模型展开成员", async count => {
  const f = await setup(), request = f.request(`scope-${count}`, "只比较合成指标乙");
  const task = (await request.semanticTasks!.get(f.original!.steps[0]!.taskRef!))!;
  task.target.fields.organizations!.resolvedValue = {codes: Array.from({length: count}, (_, i) => `SYNTHETIC_${i}`), names: []};
  const before = structuredClone(task);
  const facts = await f.backend.inspectBusinessGoal(request.originalMessage);
  const turn = {operationId: request.operationId, originalMessage: request.originalMessage, businessDate: "2026-10-27", operations: {},
    context: {plan: f.original!, tasks: [task]}};
  const result = await materializeTaskRequest(request, {protocol_version: 2, intent: "query", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "metrics", value: "合成指标乙"}]}]}, turn, f.original!, facts);
  expect(result.targets[0]!.source).toEqual({kind: "current"});
  expect(result.targets[0]!.operations.map(op => op.field)).toEqual(["_analysis"]);
  expect(task).toEqual(before);
});

it("没有日历端点的已解析时间策略不能作为普通查询签发执行", () => {
  const result = validateFrame(createCapabilities().get("metric_query"), {time: {resolutionStatus: "resolved", source: "inherited",
    resolvedValue: {date_selection: "latest_snapshot"}}, selection: {resolutionStatus: "resolved", source: "resolved", resolvedValue: "exact"}});
  expect(result.issues).toContainEqual(expect.objectContaining({field: "time", reason: "invalid"}));
});

it("复杂依赖的指标变化交回模型重新规划，保留来源且不猜测新关系", async () => {
  const plan = initialPlan();
  plan.steps.push({id: "s2", method: "observe", metric_refs: ["signed-M1"], answers: ["q"], depends_on: ["s"], rationale: "依赖补查"});
  const f = await setup(plan), request = f.request("complex-follow", "只比较合成指标乙");
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "metrics", value: "合成指标乙"}]}]}, request);
  expect(result.details.status).toBe("needs_interpretation");
  expect(result.details.issues).toContainEqual(expect.objectContaining({code: "TASK_MATERIALIZATION_REQUIRED", remediation: "pi"}));
  expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
});

it("拒绝模型在追问中夹带未提及的新指标", async () => {
  const f = await setup(), request = f.request("invented-follow", "只比较合成指标乙");
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "metrics", value: "合成指标丙"}]}]}, request);
  expect(result.details.status).toBe("needs_interpretation");
  expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
});

it("重新核验来源指标时撤权直接停止，不以历史身份绕过鉴权", async () => {
  const f = await setup(), request = f.request("revoked-follow", "只比较合成指标乙");
  const {BackendApiError} = await import("../../src/backendClient.js");
  f.backend.analysisValidate.mockRejectedValueOnce(new BackendApiError(403, "permission denied"));
  const result = await runTool(createSemanticResolveTool(), {protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
    operations: [{action: "set", field: "metrics", value: "合成指标乙"}]}]}, request);
  expect(result.details.status).toBe("denied");
  expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
});
