import {afterEach, describe, expect, it} from "vitest";
import {BackendApiError, type BasicQuerySpec} from "../../src/backendClient.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool, createSemanticReadTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import {complete, fixture, proposal} from "./fixtures.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function setup() {
  const f = await fixture(); closes.push(f.close);
  async function query(id: string, message: string, operations = complete()) {
    const request = f.request(id, message), result = await new SemanticPlanService(request).resolve(proposal(operations));
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
    return {plan, task: (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!};
  }
  const old = await query("old", "查合成机构甲2025年末的合成指标甲");
  const current = await query("current", "查合成机构乙2024年末的合成指标乙", complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"}
    : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"}));
  f.backend.basicQueries.mockClear();
  return {...f, old, current};
}
const readers = [{name: "read_business_result", tool: createSemanticReadTool}, {name: "execute_business_frame已成功分支", tool: createSemanticExecuteTool}];
describe("历史结果读取与当前业务焦点", () => {
  it.each(readers)("$name回看旧结果不改历史计划或焦点，下一轮current仍沿用原当前目标", async ({tool}) => {
    const f = await setup(), request = f.request("view-old", "查看第一笔已有结果");
    const frames = await request.frames!.state(), planIndex = await request.semanticTasks!.planIndex();
    const viewed = await runTool(tool(), {task_ref: f.old.plan.ref, target_ref: f.old.task.target.ref}, request);
    expect(viewed.details.status).toBe("reused");
    expect(viewed.details.state.evidence.status).toBe("succeeded");
    expect(await request.semanticTasks!.plan(f.old.plan.ref)).toEqual(f.old.plan);
    expect(await request.semanticTasks!.plan(f.current.plan.ref)).toEqual(f.current.plan);
    expect(await request.semanticTasks!.get(f.old.task.ref)).toEqual(f.old.task);
    expect(await request.semanticTasks!.planIndex()).toEqual(planIndex);
    expect(await request.frames!.state()).toEqual(frames);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();

    const nextRequest = f.request("after-view", "日期改成2025年末"), next = await new SemanticPlanService(nextRequest).resolve(proposal([
      {action: "set", field: "time", value: "2025年末"},
    ], {kind: "current"}));
    expect(next.status, JSON.stringify(next.issues)).toBe("ready");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, nextRequest);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.backend.basicQueries.mock.calls[0]![0] as BasicQuerySpec).toMatchObject({metric_codes: ["M2"], org_codes: ["O2"], time: {start: "2025-12-31"}});
    expect(await nextRequest.semanticTasks!.plan(f.old.plan.ref)).toEqual(f.old.plan);
  });
  it.each(readers.flatMap(reader => [
    {...reader, status: 403, code: "PERMISSION_DENIED", expected: "denied"},
    {...reader, status: 503, code: "RESULT_SOURCE_UNAVAILABLE", expected: "failed"},
  ]))("$name历史读取$status失败仅产生本轮反馈，不撤销旧成功状态和许可", async ({tool, status, code, expected}) => {
    const f = await setup(), request = f.request("failed-view", "查看第一笔已有结果");
    const before = await request.semanticTasks!.planIndex(), frames = await request.frames!.state();
    f.backend.getTaskResult.mockRejectedValueOnce(new BackendApiError(status, "合成读取失败", code));
    const result = await runTool(tool(), {task_ref: f.old.plan.ref, target_ref: f.old.task.target.ref}, request);
    expect(result.details.status).toBe(expected);
    expect(result.details.state.task_status).toBe("completed"); expect(result.details.state.completion).toBe("full");
    expect(await request.semanticTasks!.plan(f.old.plan.ref)).toEqual(f.old.plan);
    expect(await request.semanticTasks!.plan(f.current.plan.ref)).toEqual(f.current.plan);
    expect(await request.semanticTasks!.planIndex()).toEqual(before);
    expect(await request.frames!.state()).toEqual(frames); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  // reuse 派生计划的步骤保留来源计划的 taskRef；locate() 按步骤配对与 permit digest 认可该派生绑定，
  // 读取/执行只结算新计划并保留显式焦点。
  it.each(readers)("明确reuse派生计划后，$name只结算新计划并保留显式焦点", async ({tool}) => {
    const f = await setup(), request = f.request("explicit-reuse", "只重显第一笔结果");
    const reused = await new SemanticPlanService(request).resolve(proposal([], {kind: "reference", task_ref: f.old.plan.ref, target_ref: f.old.task.target.ref}, "reuse"));
    expect(reused.status).toBe("reused"); expect(reused.state.task_ref).not.toBe(f.old.plan.ref);
    expect((await request.semanticTasks!.planIndex()).focus).toBe(reused.state.task_ref);
    const result = await runTool(tool(), {task_ref: reused.state.task_ref, target_ref: reused.state.targets[0]!.target_ref}, request);
    expect(result.details.status).toBe("succeeded");
    expect(await request.semanticTasks!.plan(reused.state.task_ref!)).toMatchObject({status: "completed", completion: "full"});
    expect((await request.semanticTasks!.planIndex()).focus).toBe(reused.state.task_ref);
    expect(await request.semanticTasks!.plan(f.old.plan.ref)).toEqual(f.old.plan);
    expect(await request.semanticTasks!.plan(f.current.plan.ref)).toEqual(f.current.plan);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
});
