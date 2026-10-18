import {afterEach, describe, expect, it} from "vitest";
import {fixture, complete, proposal, metricNames} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticSource} from "../../src/semantic-task/protocol.js";
import type {BasicQuerySpec} from "../../src/backendClient.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function setup() {const f = await fixture(); closes.push(f.close); return f;}
async function execute(f: Awaited<ReturnType<typeof setup>>, id: string, message: string, operations = complete(), source: SemanticSource = {kind: "new"}) {
  const request = f.request(id, message), result = await new SemanticPlanService(request).resolve(proposal(operations, source));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
  return {request, result, plan, task: (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!};
}
describe("多轮目标快照、条件变更与Frame来源", () => {
  it.each(["current", "reference"] as const)("成功后由Pi用%s选定来源，只修改机构并保留Frame身份", async kind => {
    const f = await setup(), base = await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const source: SemanticSource = kind === "reference" ? {kind, task_ref: base.plan.ref, target_ref: base.task.target.ref} : {kind};
    const next = await execute(f, "organization", "合成机构乙呢？", [
      {action: "set", field: "organizations", value: "合成机构乙"},
    ], source);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"], time: {start: "2025-12-31"}});
    expect(next.plan.ref).not.toBe(base.plan.ref);
    expect(await next.request.semanticTasks!.plan(base.plan.ref)).toEqual(base.plan);
    expect(await next.request.semanticTasks!.get(base.task.ref)).toEqual(base.task);
    expect(next.task.target.frameId).not.toBe(base.task.target.frameId);
    expect(next.plan.steps[0]!.label).toContain("合成机构乙"); expect(next.plan.steps[0]!.label).not.toContain("合成机构甲");
    expect(await next.request.frames!.get(next.task.target.frameId!)).toMatchObject({parentFrameId: base.task.target.frameId,
      delta: {baseReference: {frameId: base.task.target.frameId}}});
    expect(await next.request.frames!.get(base.task.target.frameId!)).toMatchObject({fields: {metrics: {resolvedValue: {codes: ["M1"]}}}});
  });
  it.each(["待定指标", "合成指标丙"])("只改机构时模型额外填写%s不会改变原指标，也不要求重提", async metric => {
    const f = await setup(), base = await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const request = f.request("restated-metric", "合成机构乙呢？"), service = new SemanticPlanService(request);
    const rejected = await service.resolve(proposal([
      {action: "set", field: "organizations", value: "合成机构乙"}, {action: "set", field: "metrics", value: metric},
    ], {kind: "current"}));
    expect(rejected.status).toBe("ready"); expect(rejected.issues).toEqual([]);
    expect(rejected.state.targets[0]!.conditions.find(condition => condition.field === "metrics")?.display).toBe("合成指标甲");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(await request.frames!.get(base.task.target.frameId!)).toMatchObject({fields: {metrics: {resolvedValue: {codes: ["M1"]}}}});
    const repaired = await service.resolve(proposal([{action: "set", field: "organizations", value: "合成机构乙"}], {kind: "current"}));
    expect(repaired.status, JSON.stringify(repaired.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: repaired.state.task_ref, target_ref: repaired.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"]});
  });
  it("更换指标后继续改日期，规范身份及每一份历史Frame持续保留", async () => {
    const f = await setup();
    const first = await execute(f, "first", "查合成机构甲2025年末的合成指标甲");
    const second = await execute(f, "second", "2024年末", [{action: "set", field: "time", value: "2024年末"}], {kind: "current"});
    const third = await execute(f, "third", "合成机构乙呢？", [{action: "set", field: "organizations", value: "合成机构乙"}], {kind: "current"});
    const fourth = await execute(f, "fourth", "指标改成合成指标乙", [{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"});
    const fifth = await execute(f, "fifth", "日期改回2025年末", [{action: "set", field: "time", value: "2025年末"}], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.map(call => {const spec = call[0] as BasicQuerySpec; return {metrics: spec.metric_codes, orgs: spec.org_codes, day: spec.time.start};})).toEqual([
      {metrics: ["M1"], orgs: ["O1"], day: "2025-12-31"}, {metrics: ["M1"], orgs: ["O1"], day: "2024-12-31"},
      {metrics: ["M1"], orgs: ["O2"], day: "2024-12-31"}, {metrics: ["M2"], orgs: ["O2"], day: "2024-12-31"},
      {metrics: ["M2"], orgs: ["O2"], day: "2025-12-31"},
    ]);
    expect(fifth.task.target.fields.metrics?.resolvedValue).toMatchObject({codes: ["M2"]});
    for (const old of [first, second, third, fourth, fifth]) {
      expect(await fifth.request.semanticTasks!.get(old.task.ref)).toEqual(old.task);
      expect(await fifth.request.frames!.get(old.task.target.frameId!)).toBeDefined();
    }
  });
  it("本轮入场后焦点移动不改变该轮继承来源", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const request = f.request("admitted", "2024年末"); await request.semanticTasks!.admit("admitted", request.originalMessage);
    await execute(f, "other", "查合成机构乙2025年末的合成指标乙", complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : op));
    await execute(f, "admitted", request.originalMessage, [{action: "set", field: "time", value: "2024年末"}], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31"}});
  });
  it("Pi选择current并设置新指标时只替换指标，不混入旧指标", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const next = await execute(f, "new-metric", "查合成指标乙", [{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M2"], org_codes: ["O1"]});
    expect(next.plan.steps[0]!.source).toEqual({kind: "current"});
  });
  it("本轮真实未知指标仍澄清，不用旧指标掩盖错误", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const result = await new SemanticPlanService(f.request("unknown", "改查待定指标")).resolve(proposal([{action: "set", field: "metrics", value: "待定指标"}], {kind: "current"}));
    expect(result.status).toBe("needs_user"); expect(result.issues.some(issue => issue.field === "metrics")).toBe(true);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
  it("Pi用new声明独立新话题时从空条件开始", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const next = await new SemanticPlanService(f.request("reset", "重新开始，查合成机构乙")).resolve(proposal([{action: "set", field: "organizations", value: "合成机构乙"}]));
    expect(next.status).toBe("needs_user"); expect(next.issues.map(issue => issue.field).sort()).toEqual(["metrics", "time"]);
  });
  it("new不会因为存在唯一历史目标而隐式继承机构日期或改成current", async () => {
    const f = await setup(), base = await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const request = f.request("independent", "查合成指标乙"), next = await new SemanticPlanService(request).resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}]));
    expect(next.status).toBe("needs_user"); expect(next.issues.map(issue => issue.field).sort()).toEqual(["organizations", "time"]);
    expect(next.state.targets[0]!.conditions.map(condition => condition.field)).not.toContain("organizations");
    expect(next.state.targets[0]!.conditions.map(condition => condition.field)).not.toContain("time");
    expect((await request.semanticTasks!.plan(next.state.task_ref!))!.steps[0]!.source).toEqual({kind: "new"});
    expect(await request.semanticTasks!.plan(base.plan.ref)).toEqual(base.plan);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
  it("原句引用重置词时不重写Pi根据上下文选择的current", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const next = await execute(f, "quoted-reset", "不要把‘重新开始’当作本轮指令而是继续查合成机构乙", [{action: "set", field: "organizations", value: "合成机构乙"}], {kind: "current"});
    expect(next.plan.steps[0]!.source).toEqual({kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"], time: {start: "2025-12-31"}});
  });
  it("新会话机构续问只追问真正缺项，不构造历史", async () => {
    const f = await setup();
    const result = await new SemanticPlanService(f.request("empty", "合成机构乙呢？")).resolve(proposal([{action: "set", field: "organizations", value: "合成机构乙"}]));
    expect(result.status).toBe("needs_user"); expect(result.issues.map(issue => issue.field).sort()).toEqual(["metrics", "time"]);
  });
  it("多目标续问不任取一个指标，要求Pi选择签发目标", async () => {
    const f = await setup(), request = f.request("multi", "查合成机构甲2025年末的合成指标甲和合成指标乙");
    const input = proposal(complete()); input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "metrics" ? {...op, value: "合成指标乙"} : op)});
    const result = await new SemanticPlanService(request).resolve(input);
    for (const target of result.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
    await expect(new SemanticPlanService(f.request("ambiguous", "合成机构乙呢？")).resolve(proposal([{action: "set", field: "organizations", value: "合成机构乙"}], {kind: "current"})))
      .rejects.toMatchObject({issue: {code: "TARGET_REFERENCE_REQUIRED", remediation: "pi"}});
    const scopedRequest = f.request("scoped", "只把合成指标乙对应的机构改成合成机构乙"), scoped = await new SemanticPlanService(scopedRequest).resolve(proposal([
      {action: "set", field: "organizations", value: "合成机构乙"},
    ], {kind: "reference", task_ref: result.state.task_ref!, target_ref: result.state.targets[1]!.target_ref}));
    expect(scoped.status, JSON.stringify(scoped.issues)).toBe("ready"); expect(scoped.state.targets).toHaveLength(1);
    await runTool(createSemanticExecuteTool(), {task_ref: scoped.state.task_ref, target_ref: scoped.state.targets[0]!.target_ref}, scopedRequest);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M2"], org_codes: ["O2"]});
  });
  it("同轮新提案继续时使用本轮目标，不被入场的多目标数量阻断", async () => {
    const f = await setup(), before = f.request("multi-before", "查合成机构甲2025年末的合成指标甲和合成指标乙");
    const multi = proposal(complete()); multi.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "metrics" ? {...op, value: "合成指标乙"} : op)});
    await new SemanticPlanService(before).resolve(multi);
    const service = new SemanticPlanService(f.request("single-turn", "查合成机构甲2025年末的合成指标甲"));
    const first = await service.resolve(proposal(complete()));
    const next = await service.resolve(proposal([], {kind: "current"}));
    expect(first.status).toBe("ready"); expect(next.status).toBe("ready"); expect(next.state.targets).toHaveLength(1);
  });
  it("集合追加后只改机构，仍完整继承指标集合", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    await execute(f, "add", "再加上合成指标乙", [{action: "add", field: "metrics", value: "合成指标乙"}], {kind: "current"});
    await execute(f, "org", "合成机构乙呢？", [{action: "set", field: "organizations", value: "合成机构乙"}], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1", "M2"], org_codes: ["O2"]});
  });
  it.each([
    {action: "set" as const, message: "只查合成指标乙", operation: {action: "set" as const, field: "metrics" as const, value: "合成指标乙"}, after: ["M2"]},
    {action: "add" as const, message: "另外增加合成指标丙", operation: {action: "add" as const, field: "metrics" as const, value: "合成指标丙"}, after: ["M1", "M2", "M3"]},
    {action: "exclude" as const, message: "不要查合成指标甲", operation: {action: "exclude" as const, field: "metrics" as const, subject: "合成指标甲"}, after: ["M2"]},
    {action: "replace" as const, message: "把合成指标甲换成合成指标丙", operation: {action: "replace" as const, field: "metrics" as const, subject: "合成指标甲", value: "合成指标丙"}, after: ["M2", "M3"]},
  ])("Pi声明$action后规范集合正确展示，原Frame不变", async ({action, message, operation, after}) => {
    const f = await setup(), base = await execute(f, "base", "查合成机构甲2025年末的合成指标甲和合成指标乙",
      complete().map(op => op.field === "metrics" ? {...op, value: "合成指标甲和合成指标乙"} : op));
    const next = await execute(f, "collection-change", message, [operation], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: after, org_codes: ["O1"], time: {start: "2025-12-31"}});
    const display = after.map(code => metricNames[code as keyof typeof metricNames]).join("、");
    expect(next.result.state.targets[0]!.conditions.find(condition => condition.field === "metrics")!.display).toBe(display);
    expect(await next.request.semanticTasks!.runtimeContext()).toMatchObject({tasks: [{targets: [{conditions: {metrics: {expression: display}}}]}]});
    expect(await next.request.semanticTasks!.get(base.task.ref)).toEqual(base.task);
    expect(await next.request.frames!.get(base.task.target.frameId!)).toMatchObject({fields: {metrics: {resolvedValue: {codes: ["M1", "M2"]}}}});
  });
  it("完整新问题覆盖原条件，后续只修改该新问题", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    await execute(f, "new", "查合成机构乙2024年末的合成指标乙", complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"}));
    await execute(f, "new-org", "合成机构甲呢？", [{action: "set", field: "organizations", value: "合成机构甲"}], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M2"], org_codes: ["O1"], time: {start: "2024-12-31"}});
  });
  it("时间replace验证旧范围后与set统一为新的Frame，不需模型重试", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    await execute(f, "replace", "日期改成2024年末", [{action: "replace", field: "time", subject: "2025年末", value: "2024年末"}], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], time: {start: "2024-12-31"}});
  });
  it.each(["organizations", "metrics"] as const)("替换唯一%s旧身份可来自已绑定目标，不要求用户复述旧名称", async field => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    await execute(f, "implicit-subject", field === "organizations" ? "合成机构乙呢？" : "指标换成合成指标乙", [
      {action: "replace", field, subject: field === "organizations" ? "合成机构甲" : "合成指标甲", value: field === "organizations" ? "合成机构乙" : "合成指标乙"},
    ], {kind: "current"});
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: [field === "metrics" ? "M2" : "M1"], org_codes: [field === "organizations" ? "O2" : "O1"]});
  });
  it.each(["current", "reference"] as const)("唯一来源%s上的替换对象直接绑定正式身份，不再重提", async kind => {
    const f = await setup(), base = await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const request = f.request("source-bind", "合成机构乙呢？");
    const source: SemanticSource = kind === "current" ? {kind} : {kind, task_ref: base.plan.ref, target_ref: base.task.target.ref};
    const result = await new SemanticPlanService(request).resolve(proposal([{action: "replace", field: "organizations", subject: "合成机构乙", value: "合成机构乙"}], source));
    expect(result.status).toBe("ready"); expect(result.state.targets).toHaveLength(1); expect(result.issues).toEqual([]);
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"], time: {start: "2025-12-31"}});
    expect(await request.semanticTasks!.plan(base.plan.ref)).toEqual(base.plan);
  });
  it("省略式续问即使模型误选new也绑定唯一当前来源，旧条件不靠模型复述建立", async () => {
    const f = await setup(), base = await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const request = f.request("new-source-bind", "合成机构乙呢？");
    const result = await new SemanticPlanService(request).resolve(proposal([
      {action: "set", field: "organizations", value: "合成机构乙"}, {action: "set", field: "metrics", value: "合成指标甲"}, {action: "set", field: "time", value: "2025年末"},
    ]));
    expect(result.status).toBe("ready"); expect(result.issues).toEqual([]); expect(result.state.targets).toHaveLength(1);
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"], time: {start: "2025-12-31"}});
    expect(await request.semanticTasks!.get(base.task.ref)).toEqual(base.task);
  });
  it("时间replace的旧范围不匹配时交给Pi修正，不能忽略subject执行", async () => {
    const f = await setup(); await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const result = await new SemanticPlanService(f.request("wrong-subject", "日期改成2024年末")).resolve(proposal([
      {action: "replace", field: "time", subject: "2024年末", value: "2024年末"},
    ], {kind: "current"}));
    expect(result.status).toBe("needs_interpretation"); expect(result.issues.some(issue => issue.code === "FIELD_MEMBER_NOT_FOUND" && issue.remediation === "pi")).toBe(true);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
  it.each(["metrics", "organizations", "time"] as const)("已确认%s没有候选时confirm由Pi纠正，不能制造用户待选项", async field => {
    const f = await setup(), base = await execute(f, "base", "查合成机构甲2025年末的合成指标甲");
    const request = f.request("unavailable-confirmation", "日期改成2024年末"), service = new SemanticPlanService(request);
    const wrong = await service.resolve(proposal([
      ...(field === "time" ? [] : [{action: "set" as const, field: "time" as const, value: "2024年末"}]),
      {action: "confirm", field, value: field === "metrics" ? "合成指标甲" : field === "organizations" ? "合成机构甲" : "2025年末"},
    ], {kind: "current"}));
    expect(wrong.status).toBe("needs_interpretation");
    expect(wrong.issues.some(issue => issue.code === "CONFIRMATION_NOT_AVAILABLE" && issue.field === field && issue.remediation === "pi")).toBe(true);
    expect(wrong.continuation).toEqual({actor: "pi", action: "revise_proposal"});
    expect((await request.semanticTasks!.planIndex()).focus).toBe(base.plan.ref); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    const repaired = await service.resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}));
    expect(repaired.status, JSON.stringify(repaired.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: repaired.state.task_ref, target_ref: repaired.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31"}});
    expect(await request.semanticTasks!.plan(base.plan.ref)).toEqual(base.plan);
    expect(await request.semanticTasks!.get(base.task.ref)).toEqual(base.task);
  });
});
