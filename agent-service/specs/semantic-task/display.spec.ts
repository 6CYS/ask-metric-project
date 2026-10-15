import {afterEach, expect, it} from "vitest";
import {fixture, addPlanBackend, complete, proposal} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
it("反馈、入场上下文、历史条件与标签都显示实际集合，动作原文仍可追溯", async () => {
  const f = await fixture(); closes.push(f.close); addPlanBackend(f.backend);
  async function query(id: string, message: string, ops = complete(), kind: "new" | "current" = "new") {
    const request = f.request(id, message), result = await new SemanticPlanService(request).resolve(proposal(ops, {kind}));
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    return {request, result, plan: (await request.semanticTasks!.plan(result.state.task_ref!))!};
  }
  const first = await query("base", "查合成机构甲2025年末的合成指标甲");
  const addition = await query("add", "把合成指标乙也一起查", [{action: "add", field: "metrics", value: "合成指标乙"}], "current");
  expect(addition.result.state.targets[0]!.conditions.find(c => c.field === "metrics")!.display).toBe("合成指标甲、合成指标乙");
  expect(addition.plan.steps[0]!.label).toContain("合成指标甲、合成指标乙");
  const removal = await query("exclude", "不要合成指标甲", [{action: "exclude", field: "metrics", subject: "合成指标甲"}], "current");
  expect(removal.result.state.targets[0]!.conditions.find(c => c.field === "metrics")!.display).toBe("合成指标乙");
  const target = (await removal.request.semanticTasks!.get(removal.plan.steps[0]!.taskRef!))!.target;
  expect(target.fields.metrics!.rawValue).toBe("合成指标甲"); expect(target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M2"]});
  expect(removal.plan.steps[0]!.label).toContain("合成指标乙"); expect(removal.plan.steps[0]!.label).not.toContain("合成指标甲");
  await removal.request.semanticTasks!.admit("next", "合成机构乙呢？");
  expect((await removal.request.semanticTasks!.admissionContext("next"))!.targets[0]!.conditions.metrics).toMatchObject({expression: "合成指标乙", confirmed: ["合成指标乙"]});
  const context = await removal.request.semanticTasks!.planContext();
  expect(context.tasks.find(t => t.task_ref === removal.plan.ref)!.targets[0]!.conditions.metrics!.expression).toBe("合成指标乙");
  expect(await removal.request.semanticTasks!.plan(first.plan.ref)).toEqual(first.plan);
});
