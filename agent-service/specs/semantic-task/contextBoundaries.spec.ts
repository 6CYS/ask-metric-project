import {afterEach, describe, expect, it, vi} from "vitest";
import {fixture, addPlanBackend, complete, proposal} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {completeQuery, transitionBasis} from "../../src/semantic-task/transition.js";
import {createSemanticClarifyTool, createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticOperation, SemanticRequest, SemanticSource} from "../../src/semantic-task/protocol.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function setup() {
  const f = await fixture(); closes.push(f.close);
  return {...f, planBackend: addPlanBackend(f.backend)};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function resolveAndExecute(f: Fixture, id: string, message: string,
  operations: SemanticOperation[] = complete(), source: SemanticSource = {kind: "new"}) {
  const request = f.request(id, message), result = await new SemanticPlanService(request).resolve(proposal(operations, source));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  for (const target of result.state.targets) {
    const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
    expect(execution.details.status, JSON.stringify(execution.details.issues)).toBe("succeeded");
  }
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
  return {request, result, plan, task: (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!};
}
async function twoTargets(f: Fixture) {
  const request = f.request("two-base", "查合成机构甲2025年末的合成指标甲；查合成机构乙2025年末的合成指标乙");
  const input = proposal(complete());
  input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "organizations"
    ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : op)});
  const result = await new SemanticPlanService(request).resolve(input);
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  for (const target of result.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
  const alternatives = plan.steps.map((step, i) => ({task_ref: plan.ref, target_ref: step.targetRef, label: i ? "乙项" : "甲项"}));
  return {plan, alternatives};
}

describe("机构范围解析遵守同一集合操作", () => {
  it("排除完整已解析机构集合会留下空集合待修，不能继续查询原全部机构", async () => {
    const f = await setup(), resolveOrganizationScope = vi.fn(async () => ({status: "resolved", value: {
      codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"],
    }}));
    Object.assign(f.backend, {resolveOrganizationScope});
    const base = await resolveAndExecute(f, "cohort-base", "查所有农商行2025年末的合成指标甲",
      complete().map(op => op.field === "organizations" ? {...op, value: "所有农商行"} : op));
    const priorFrame = await base.request.frames!.get(base.task.target.frameId!);
    const request = f.request("exclude-cohort", "排除所有农商行");
    const result = await new SemanticPlanService(request).resolve(proposal([
      {field: "organizations", action: "exclude", subject: "所有农商行"},
    ], {kind: "current"}));
    expect(result.status).not.toBe("ready");
    const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
    const task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
    expect(task.target.fields.organizations?.resolvedValue).toMatchObject({codes: []});
    expect(task.target.pending.organizations).toBeTruthy();
    expect(task.permit).toBeUndefined();
    await runTool(createSemanticExecuteTool(), {task_ref: plan.ref, target_ref: task.target.ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(await request.frames!.get(base.task.target.frameId!)).toEqual(priorFrame);
    expect(resolveOrganizationScope).toHaveBeenCalledTimes(2);
  });

  it("追加已解析机构范围保留原机构，并在规范轨迹中体现合并结果", async () => {
    const f = await setup();
    Object.assign(f.backend, {resolveOrganizationScope: vi.fn(async () => ({status: "resolved", value: {
      codes: ["O2"], names: ["合成机构乙"],
    }}))});
    await resolveAndExecute(f, "single-base", "查合成机构甲2025年末的合成指标甲");
    const next = await resolveAndExecute(f, "cohort-add", "再加上所有农商行",
      [{field: "organizations", action: "add", value: "所有农商行"}], {kind: "current"});
    expect(next.task.target.fields.organizations?.resolvedValue).toMatchObject({codes: ["O1", "O2"]});
    expect(next.task.target.transition?.changes).toContainEqual({field: "organizations", action: "add", before: ["O1"], after: ["O1", "O2"]});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({org_codes: ["O1", "O2"]});
  });
});

describe("完整位次条件与比较总体清空轨迹", () => {
  it("缺失或仍待明确比较总体的位次来源不能生成完整transition基准", async () => {
    const f = await setup(), base = await resolveAndExecute(f, "value-base", "查合成机构甲2025年末的合成指标甲");
    const target = structuredClone(base.task.target);
    target.fields.operation!.resolvedValue = {kind: "rank_position"};
    expect(completeQuery(target)).toBeUndefined();
    expect(transitionBasis(target)).toBeUndefined();
    target.fields.comparison_organizations = {resolutionStatus: "resolved", source: "resolved",
      resolvedValue: {codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"]}};
    target.pending.comparison_organizations = "尚需确认比较总体";
    expect(completeQuery(target)).toBeUndefined();
    delete target.pending.comparison_organizations;
    expect(completeQuery(target)).toMatchObject({operation: {kind: "rank_position"}, comparison_scope: {org_codes: ["O1", "O2"]}});
  });

  it.each([true, false])("位次改为普通取值，explicitClear=%s时比较总体清空和操作变更均进入轨迹", async explicitClear => {
    const f = await setup();
    const base = await resolveAndExecute(f, "position-base", "合成机构甲2025年末的合成指标甲在合成机构甲和合成机构乙两家中的位次",
      [...complete(), {field: "comparison_organizations", action: "set", value: "合成机构甲和合成机构乙"}]);
    const priorFrame = await base.request.frames!.get(base.task.target.frameId!);
    const operations: SemanticOperation[] = [{field: "operation", action: "set", value: "普通取值"},
      ...(explicitClear ? [{field: "comparison_organizations" as const, action: "clear" as const}] : [])];
    const next = await resolveAndExecute(f, "position-to-value", "改为普通取值", operations, {kind: "current"});
    expect(next.task.target.transition?.changes).toEqual(expect.arrayContaining([
      {field: "operation", action: "set", before: {kind: "rank_position"}, after: {kind: "value"}},
      {field: "comparison_organizations", action: "clear", before: ["O1", "O2"], after: []},
    ]));
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({operation: {kind: "value"}});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).not.toHaveProperty("comparison_scope");
    expect(await next.request.frames!.get(base.task.target.frameId!)).toEqual(priorFrame);
  });
});

describe("Pi明确选择澄清续接、暂缓和放弃", () => {
  it("第二次澄清resume保留第一条未完成修改，最终选择目标时日期仍然生效", async () => {
    const f = await setup(), {alternatives} = await twoTargets(f);
    await runTool(createSemanticClarifyTool(), {question: "改甲项还是乙项？", alternatives}, f.request("ask-one", "把一项日期改为2024年末"));
    await runTool(createSemanticClarifyTool(), {context_action: "resume", question: "这两项中具体哪项？", alternatives}, f.request("ask-two", "我说的是前面那两项中的一项"));
    const selection = f.request("choose-one", "选择甲项"), input = proposal([
      {field: "time", action: "set", value: "2024年末"},
    ], {kind: "reference", task_ref: alternatives[0]!.task_ref, target_ref: alternatives[0]!.target_ref});
    input.context_action = "resume";
    const result = await new SemanticPlanService(selection).resolve(input);
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, selection);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31"}});
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(3);
  });

  it("选择旧目标并独立新增查询时，resume修改与新问题分别绑定各自日期指标", async () => {
    const f = await setup(), {alternatives} = await twoTargets(f);
    await runTool(createSemanticClarifyTool(), {question: "要改哪项？", alternatives}, f.request("mixed-wait", "把一项日期改为2024年末"));
    const request = f.request("mixed-answer", "选择合成机构甲那项；另查合成机构乙2025年末的合成指标丙");
    const input: SemanticRequest = {protocol_version: 2, context_action: "resume", intent: "query", targets: [
      {source: {kind: "reference", task_ref: alternatives[0]!.task_ref, target_ref: alternatives[0]!.target_ref}, operations: [{field: "time", action: "set", value: "2024年末"}]},
      {source: {kind: "new"}, operations: complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标丙"} : op)},
    ]};
    const result = await new SemanticPlanService(request).resolve(input);
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    for (const target of result.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.slice(-2).map(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31", end: "2024-12-31"}}),
      expect.objectContaining({metric_codes: ["M3"], org_codes: ["O2"], time: {start: "2025-12-31", end: "2025-12-31"}}),
    ]));
  });

  it("暂缓修改并重显原结果不携带旧修改，随后仍能resume完成旧日期请求", async () => {
    const f = await setup(), {alternatives} = await twoTargets(f);
    await runTool(createSemanticClarifyTool(), {question: "要改哪项？", alternatives}, f.request("defer-wait", "把一项日期改为2024年末"));
    const source: SemanticSource = {kind: "reference", task_ref: alternatives[0]!.task_ref, target_ref: alternatives[0]!.target_ref};
    const show = proposal([], source, "reuse"); show.context_action = "defer";
    const result = await new SemanticPlanService(f.request("defer-show", "先显示合成机构甲那项原结果")).resolve(show);
    expect(result.status, JSON.stringify(result.issues)).toBe("reused");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
    const resume = proposal([{field: "time", action: "set", value: "2024年末"}], source); resume.context_action = "resume";
    const request = f.request("after-defer", "现在就改甲项"), continued = await new SemanticPlanService(request).resolve(resume);
    expect(continued.status, JSON.stringify(continued.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: continued.state.task_ref, target_ref: continued.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({time: {start: "2024-12-31"}});
  });

  it("reuse不能声明resume未完成修改，也不能执行新查询", async () => {
    const f = await setup(), {alternatives} = await twoTargets(f);
    await runTool(createSemanticClarifyTool(), {question: "要改哪项？", alternatives}, f.request("reuse-wait", "把一项日期改为2024年末"));
    const input = proposal([], {kind: "reference", task_ref: alternatives[0]!.task_ref, target_ref: alternatives[0]!.target_ref}, "reuse"); input.context_action = "resume";
    await expect(new SemanticPlanService(f.request("invalid-reuse", "先显示甲项")).resolve(input)).rejects.toMatchObject({issue: {code: "CLARIFICATION_SOURCE_REQUIRED"}});
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  });

  it("Pi声明abandon后独立新问题使用新日期指标，并清除待明确旧修改", async () => {
    const f = await setup(), {alternatives} = await twoTargets(f);
    await runTool(createSemanticClarifyTool(), {question: "要改哪项？", alternatives}, f.request("abandon-wait", "把一项日期改为2024年末"));
    const request = f.request("abandon-new", "放弃修改并查合成机构甲2025年末的合成指标丙");
    const input = proposal(complete().map(op => op.field === "metrics" ? {...op, value: "合成指标丙"} : op)); input.context_action = "abandon";
    const result = await new SemanticPlanService(request).resolve(input);
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M3"], org_codes: ["O1"], time: {start: "2025-12-31"}});
    await request.semanticTasks!.admit("after-abandon", "后续问题");
    expect((await request.semanticTasks!.admissionContext("after-abandon"))?.pending_clarification).toBeUndefined();
  });
});
