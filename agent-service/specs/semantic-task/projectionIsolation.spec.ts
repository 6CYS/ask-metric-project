import {afterEach, expect, it} from "vitest";
import {fixture, addPlanBackend, complete, proposal} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticOperation} from "../../src/semantic-task/protocol.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function setup() {const f = await fixture(); closes.push(f.close); addPlanBackend(f.backend); return f;}

it("首轮未获准草案只在历史中可读，不能成为默认或下一轮入场上下文", async () => {
  const f = await setup(), request = f.request("wrong-first", "查合成机构甲2025年末的合成指标甲和合成指标乙");
  const result = await new SemanticPlanService(request).resolve(proposal(complete()));
  expect(result.status).toBe("needs_interpretation");
  expect((await request.semanticTasks!.planIndex()).focus).toBeUndefined();
  expect(await request.semanticTasks!.runtimeContext()).toEqual({tasks: [], history_available: true});
  expect((await request.semanticTasks!.planContext()).tasks).toHaveLength(1);
  await request.semanticTasks!.admit("next", "接着查询");
  expect((await request.semanticTasks!.admissionContext("next"))!.targets).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([true, false])("比较范围显式或自动清空后Frame delta准确保留clear：%s", async explicit => {
  const f = await setup(), initial = f.request("rank", "合成机构甲2025年末的合成指标甲在合成机构甲和合成机构乙两家中的位次");
  const first = await new SemanticPlanService(initial).resolve(proposal([...complete(),
    {field: "comparison_organizations", action: "set", value: "合成机构甲和合成机构乙"}]));
  expect(first.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: first.state.task_ref, target_ref: first.state.targets[0]!.target_ref}, initial);
  const oldPlan = (await initial.semanticTasks!.plan(first.state.task_ref!))!;
  const oldTask = (await initial.semanticTasks!.get(oldPlan.steps[0]!.taskRef!))!;
  const oldFrame = await initial.frames!.get(oldTask.target.frameId!);
  const next = f.request("value", "改为普通取值"), operations: SemanticOperation[] = [
    {field: "operation", action: "set", value: "普通取值"}, ...(explicit ? [{field: "comparison_organizations" as const, action: "clear" as const}] : [])];
  const result = await new SemanticPlanService(next).resolve(proposal(operations, {kind: "current"}));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  const plan = (await next.semanticTasks!.plan(result.state.task_ref!))!, task = (await next.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  const frame = (await next.frames!.get(task.target.frameId!))!;
  expect(frame.fields.comparison_organizations).toBeUndefined();
  expect(frame.delta.fieldChanges).toContainEqual({fieldHint: "comparison_organizations", operation: "clear"});
  expect(frame.parentFrameId).toBe(oldFrame!.frameId);
  expect(await next.frames!.get(oldFrame!.frameId)).toEqual(oldFrame);
  expect(await next.semanticTasks!.plan(oldPlan.ref)).toEqual(oldPlan);
});
