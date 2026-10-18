import {afterEach, expect, it} from "vitest";
import {fixture, complete, proposal} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticOperation} from "../../src/semantic-task/protocol.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function setup() {const f = await fixture(); closes.push(f.close); return f;}

it("首轮唯一日期直接归一并成为下一轮工作状态，不落入无焦点草案", async () => {
  const f = await setup(), request = f.request("wrong-first", "查合成机构甲2025年末的合成指标甲");
  const result = await new SemanticPlanService(request).resolve(proposal(complete().map(op => op.field === "time" ? {...op, value: "2024年末"} : op)));
  expect(result.status).toBe("ready");
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!, task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  expect(task.target.fields.time!.resolvedValue).toEqual({start: "2025-12-31", end: "2025-12-31"});
  expect((await request.semanticTasks!.runtimeContext()).current_task_ref).toBe(plan.ref);
  await request.semanticTasks!.admit("next", "接着查询");
  expect((await request.semanticTasks!.admissionContext("next"))!.targets).toHaveLength(1);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([true, false])("比较范围显式或自动清空后新Frame不再携带比较范围：%s", async explicit => {
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
  // 执行帧不再附变更清单：清空语义由 fields 投影中比较范围缺位表达，基线关联保留。
  expect(frame.fields.comparison_organizations).toBeUndefined();
  expect(frame.delta.fieldChanges).toEqual([]);
  expect(frame.parentFrameId).toBe(oldFrame!.frameId);
  expect(await next.frames!.get(oldFrame!.frameId)).toEqual(oldFrame);
  expect(await next.semanticTasks!.plan(oldPlan.ref)).toEqual(oldPlan);
});
