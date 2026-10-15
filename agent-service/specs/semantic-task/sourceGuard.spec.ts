import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {fixture, addPlanBackend, complete, proposal} from "./fixtures.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticOperation, SemanticSource} from "../../src/semantic-task/protocol.js";
import {pendingCompletionSource} from "../../src/semantic-task/sourceGuard.js";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {vi.spyOn(console, "info").mockImplementation(() => {});});
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
async function setup(completed = false) {
  const f = await fixture(); cleanup.push(f.close);
  const backend = addPlanBackend(f.backend), inspect = backend.inspectBusinessGoal.getMockImplementation()!;
  // 对齐真实inspect_goal：同一句互补的机构与日期字段属于同一目标，不把逗号当独立查询义务。
  backend.inspectBusinessGoal.mockImplementation(async question => {
    const goal = await inspect(question);
    if (goal.fragments.length > 1 && !goal.fragments.some(fragment => fragment.mentions.length)
      && goal.fragments.filter(fragment => fragment.organizations.length).length === 1
      && goal.fragments.filter(fragment => fragment.calendar.ranges.length).length === 1) return {...goal, fragments: [{question,
        organizations: goal.fragments.flatMap(fragment => fragment.organizations),
        calendar: {ranges: goal.fragments.flatMap(fragment => fragment.calendar.ranges), unresolved: []}, mentions: []}]};
    return goal;
  });
  const request = f.request("known", completed ? "查合成机构甲2025年末的合成指标甲" : "帮我查合成指标甲");
  const first = await runTool(createSemanticResolveTool(), proposal(completed ? complete() : [{action: "set", field: "metrics", value: "合成指标甲"}]), request);
  if (completed) await runTool(createSemanticExecuteTool(), {task_ref: first.details.state.task_ref, target_ref: first.details.state.targets[0].target_ref}, request);
  const plan = (await request.semanticTasks!.plan(first.details.state.task_ref))!, task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  return {...f, plan, task};
}
const supplied = (): SemanticOperation[] => [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2025年末"}];

it.each(["不是", "清空", "不沿用", "非", "除", "除了"])("机构字段含%s表达时，即使目录可匹配也不推断续补来源", async prefix => {
  const f = await setup(), request = f.request("negative", `机构${prefix}合成机构甲，日期是2025年末`);
  const turn = await request.semanticTasks!.admit(request.operationId, request.originalMessage);
  expect(turn.context?.plan?.ref).toBe(f.plan.ref);
  const facts = await request.backend.inspectBusinessGoal(request.originalMessage, turn.businessDate);
  const value = `${prefix}合成机构甲`;
  // 桩故意重现目录从含否定/清空的原值中仍命中正式机构的情况。
  expect(await request.backend.resolveBusinessField("organization", [value])).toMatchObject({status: "resolved", value: {codes: ["O1"]}});
  f.backend.resolveBusinessField.mockClear();
  expect(await pendingCompletionSource(request, proposal(supplied()), turn, facts)).toBeUndefined();
  expect(f.backend.resolveBusinessField).not.toHaveBeenCalled();
  expect((await request.semanticTasks!.planIndex()).operations[request.operationId]).toBeUndefined();
  expect(await request.semanticTasks!.plan(f.plan.ref)).toEqual(f.plan);
});

it.each(["current", "reference"] as const)("缺项续补误用new复述/删指标均在准入前拒绝，Pi显式%s重提后完整执行", async kind => {
  const f = await setup(), request = f.request("complete", "机构是合成机构甲，日期是2025年末，继续查询");
  for (const operations of [[...supplied(), {action: "set" as const, field: "metrics" as const, value: "合成指标甲"}], supplied()]) {
    const result = await runTool(createSemanticResolveTool(), proposal(operations), request);
    expect(result.details.status).toBe("conflict");
    expect(result.details.issues).toContainEqual(expect.objectContaining({code: "CONFIRMED_CONTEXT_SOURCE_REQUIRED", remediation: "pi",
      source_options: [{task_ref: f.plan.ref, target_ref: f.plan.steps[0]!.targetRef}]}));
    expect(result.details.continuation).toEqual({actor: "pi", action: "revise_proposal"});
    expect((await request.semanticTasks!.planIndex()).operations[request.operationId]).toBeUndefined();
    expect((await request.semanticTasks!.planIndex()).focus).toBe(f.plan.ref);
    expect(await request.semanticTasks!.plan(f.plan.ref)).toEqual(f.plan); expect(await request.semanticTasks!.get(f.task.ref)).toEqual(f.task);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  }
  const source: SemanticSource = kind === "current" ? {kind} : {kind, task_ref: f.plan.ref, target_ref: f.plan.steps[0]!.targetRef};
  const corrected = await runTool(createSemanticResolveTool(), proposal(supplied(), source), request);
  expect(corrected.details.status, JSON.stringify(corrected.details.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.details.state.task_ref, target_ref: corrected.details.state.targets[0].target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2025-12-31", end: "2025-12-31"}});
});

it("已完成目标明确其他条件不变时，new漏指标也必须交给Pi修正来源", async () => {
  const f = await setup(true), request = f.request("retain", "机构改为合成机构乙，其他条件不变");
  const operations: SemanticOperation[] = [{action: "set", field: "organizations", value: "合成机构乙"}];
  const rejected = await runTool(createSemanticResolveTool(), proposal(operations), request);
  expect(rejected.details.status).toBe("conflict");
  expect(rejected.details.issues[0]).toMatchObject({code: "CONFIRMED_CONTEXT_SOURCE_REQUIRED", source_options: [{task_ref: f.plan.ref, target_ref: f.plan.steps[0]!.targetRef}]});
  expect(await request.semanticTasks!.plan(f.plan.ref)).toEqual(f.plan); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const corrected = await runTool(createSemanticResolveTool(), proposal(operations, {kind: "current"}), request);
  expect(corrected.details.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.details.state.task_ref, target_ref: corrected.details.state.targets[0].target_ref}, request);
  expect(f.backend.basicQueries.mock.calls.at(-1)?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"], time: {start: "2025-12-31"}});
});

it("已完成目标明确今天和其他条件不变时，已解析单日也必须保留原指标来源", async () => {
  const f = await setup(true), request = f.request("retain-today", "日期改为今天，其他条件不变");
  const turn = await request.semanticTasks!.admit(request.operationId, request.originalMessage);
  const inspected = await request.backend.inspectBusinessGoal("日期改为2025年末，其他条件不变", turn.businessDate);
  vi.mocked(request.backend.inspectBusinessGoal).mockResolvedValue({...inspected, question: request.originalMessage});
  const rejected = await runTool(createSemanticResolveTool(), proposal([{action: "set", field: "time", value: "今天"}]), request);
  expect(rejected.details.status).toBe("conflict");
  expect(rejected.details.issues[0]).toMatchObject({code: "CONFIRMED_CONTEXT_SOURCE_REQUIRED", source_options: [{task_ref: f.plan.ref, target_ref: f.plan.steps[0]!.targetRef}]});
  expect((await request.semanticTasks!.planIndex()).operations[request.operationId]).toBeUndefined();
  expect(await request.semanticTasks!.plan(f.plan.ref)).toEqual(f.plan);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it.each([
  {message: "重新开始，查合成机构乙", operations: [{action: "set", field: "organizations", value: "合成机构乙"}]},
  {message: "不沿用之前条件，机构是合成机构甲日期是2025年末", operations: supplied()},
  {message: "清空指标，不沿用之前条件，机构是合成机构乙", operations: [{action: "clear", field: "metrics"}, {action: "set", field: "organizations", value: "合成机构乙"}]},
  {message: "查合成指标乙", operations: [{action: "set", field: "metrics", value: "合成指标乙"}]},
])("独立新问题或明确清空不被自动继承或来源守卫改写：$message", async ({message, operations}) => {
  const f = await setup(), request = f.request("independent", message);
  const result = await runTool(createSemanticResolveTool(), proposal(operations as SemanticOperation[]), request);
  expect(result.details.status).toBe("needs_user");
  expect(result.details.issues.some((issue: {code: string}) => issue.code === "CONFIRMED_CONTEXT_SOURCE_REQUIRED")).toBe(false);
  const next = (await request.semanticTasks!.plan(result.details.state.task_ref))!;
  expect(next.steps[0]?.source).toEqual({kind: "new"});
  expect(await request.semanticTasks!.plan(f.plan.ref)).toEqual(f.plan);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
