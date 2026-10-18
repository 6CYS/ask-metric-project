import {afterEach, describe, expect, it, vi} from "vitest";
import {fixture, proposal, complete} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {createAskMetricTools} from "../../src/tools/index.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticRequest} from "../../src/semantic-task/protocol.js";
import {semanticFeedback, semanticPublicAnswer} from "../../src/semantic-task/feedback.js";
import {parseFormula} from "../../src/semantic-task/calculation.js";
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function setup() {const f = await fixture(); closes.push(f.close); return f;}
const second = () => complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"});
describe("完整任务获准与结果驱动规划", () => {
  it.each([
    {missing: ["organizations", "time"], message: "查合成指标甲"},
    {missing: ["organizations"], message: "查2025年末的合成指标甲"},
    {missing: ["time"], message: "查合成机构甲的合成指标甲"},
  ])("新会话缺少 $missing 时一次返回真实缺项，不读取历史补造条件", async ({missing, message}) => {
    const f = await setup(), request = f.request("missing", message);
    const result = await new SemanticPlanService(request).resolve(proposal(complete().filter(op => !missing.includes(op.field))));
    expect(result.status).toBe("needs_user");
    expect(result.continuation).toEqual({actor: "user", action: "ask_user"});
    expect(result.issues.map(issue => issue.field).sort()).toEqual([...missing].sort());
    expect(result.issues.every(issue => issue.remediation === "user")).toBe(true);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  it("模型补造机构日期并误把指标口径当取数方式，仍只追问真实缺项", async () => {
    const f = await setup(), request = f.request("placeholder", "查合成指标甲");
    const result = await new SemanticPlanService(request).resolve(proposal([
      {action: "set", field: "metrics", value: "合成指标甲"},
      {action: "set", field: "time", value: "2026-10-15"},
      {action: "set", field: "selection", value: "当日取值"},
      {action: "set", field: "organizations", value: "待确认机构"},
    ]));
    expect(result.status).toBe("needs_user");
    expect(result.continuation).toEqual({actor: "user", action: "ask_user"});
    expect(result.issues.map(issue => [issue.code, issue.field, issue.remediation]).sort()).toEqual([
      ["FIELD_REQUIRED", "organizations", "user"], ["FIELD_REQUIRED", "time", "user"],
    ]);
    expect(semanticPublicAnswer(result)).not.toMatch(/待确认机构|取数方式|提议|Pi/u);
    expect(result.state.targets[0]!.conditions.some(condition => condition.field === "metrics" && condition.display === "合成指标甲")).toBe(true);
    const nextRequest = f.request("supplement", "合成机构甲2024年末");
    const next = await new SemanticPlanService(nextRequest).resolve(proposal(complete().filter(op => op.field !== "metrics").map(op => op.field === "time" ? {...op, value: "2024年末"} : op), {kind: "current"}));
    expect(next.status).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, nextRequest);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31"}});
  });
  it("原句已给机构日期时一次补齐模型漏填，不要求重提", async () => {
    const f = await setup(), request = f.request("omitted-known", "查合成机构甲2025年末的合成指标甲"), service = new SemanticPlanService(request);
    const result = await service.resolve(proposal([{action: "set", field: "metrics", value: "合成指标甲"}]));
    expect(result.status).toBe("ready"); expect(result.issues).toEqual([]);
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({org_codes: ["O1"], metric_codes: ["M1"], time: {start: "2025-12-31"}});
  });
  it("原句正式规范化查询操作后清理过期动作错误，保持字段与问题一致", async () => {
    const f = await setup(), request = f.request();
    const next = await new SemanticPlanService(request).resolve(proposal([...complete(), {action: "confirm", field: "operation", value: "查询原值"}]));
    expect({status: next.status, issues: next.issues}).toEqual({status: "ready", issues: []});
    const plan = (await request.semanticTasks!.plan(next.state.task_ref!))!, task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
    expect(task.target.fields.operation!.resolvedValue).toEqual({kind: "value"});
    expect(task.target.pending.operation).toBeUndefined(); expect(task.target.pendingChanges?.operation).toBeUndefined();
    await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
  it("有效目录机构也不能由模型补造；只补日期仍须确认机构后才执行", async () => {
    const f = await setup();
    const service = new SemanticPlanService(f.request("invented-valid", "查合成指标甲"));
    const invented = await service.resolve(proposal(complete().filter(op => op.field !== "time")));
    expect(invented.status).toBe("needs_user");
    expect(invented.issues.some(issue => issue.field === "organizations" && issue.code === "FIELD_REQUIRED")).toBe(true);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const first = await service.resolve(proposal([{action: "set", field: "metrics", value: "合成指标甲"}]));
    expect(first.status, JSON.stringify(first.issues)).toBe("needs_user");
    expect(first.issues.map(issue => [issue.code, issue.field]).sort()).toEqual([["FIELD_REQUIRED", "organizations"], ["FIELD_REQUIRED", "time"]]);
    const request = f.request("only-date", "日期用2024年末");
    const next = await new SemanticPlanService(request).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}));
    expect(next.status).toBe("needs_user"); expect(next.issues.map(issue => issue.field)).toEqual(["organizations"]);
    await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  it("原句已有唯一机构时直接归一模型错填", async () => {
    const f = await setup();
    const next = await new SemanticPlanService(f.request()).resolve(proposal(complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op)));
    expect(next.status).toBe("ready"); expect(next.issues).toEqual([]);
    expect(next.state.targets[0]!.conditions.find(condition => condition.field === "organizations")?.display).toBe("合成机构甲");
  });
  it("日期修改归一后更新焦点，历史快照仍可分页定位且不被改写", async () => {
    const f = await setup(), originalRequest = f.request("focused", "查合成机构甲2025年末的合成指标甲");
    const original = await new SemanticPlanService(originalRequest).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const originalPlan = await originalRequest.semanticTasks!.plan(original.state.task_ref!);
    const request = f.request("date-change", "日期改成2024年末"), service = new SemanticPlanService(request);
    const next = await service.resolve(proposal([{action: "set", field: "time", value: "2024年末"}, {action: "set", field: "metrics", value: "合成指标丙"}], {kind: "current"}));
    expect(next.status).toBe("ready"); expect(next.state.task_ref).not.toBe(original.state.task_ref);
    const plan = (await request.semanticTasks!.plan(next.state.task_ref!))!, task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
    expect(task.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1"]});
    expect(task.target.fields.time!.resolvedValue).toMatchObject({start: "2024-12-31"});
    const runtime = await request.semanticTasks!.runtimeContext();
    expect(runtime.current_task_ref).toBe(next.state.task_ref); expect(runtime.tasks.map(task => task.task_ref)).toEqual([next.state.task_ref]);
    const recent = await request.semanticTasks!.planContext(1), older = await request.semanticTasks!.planContext(1, recent.next_cursor!);
    expect(older.tasks.map(task => task.task_ref)).toEqual([original.state.task_ref]);
    expect(await request.semanticTasks!.plan(original.state.task_ref!)).toEqual(originalPlan);
  });
  it("Pi以current连续补充缺项，保存已确认口径和原始来源", async () => {
    const f = await setup();
    const original = await new SemanticPlanService(f.request("supplement-base", "查合成指标甲")).resolve(proposal([{action: "set", field: "metrics", value: "合成指标甲"}]));
    const originalPlan = await f.request().semanticTasks!.plan(original.state.task_ref!);
    const organization = await new SemanticPlanService(f.request("supplement-org", "机构用合成机构甲")).resolve(proposal([
      {action: "set", field: "organizations", value: "合成机构甲"},
    ], {kind: "current"}));
    expect(organization.state.task_ref).not.toBe(original.state.task_ref);
    expect(await f.request().semanticTasks!.plan(original.state.task_ref!)).toEqual(originalPlan);
    expect(organization.status).toBe("needs_user"); expect(organization.issues.map(issue => issue.field)).toEqual(["time"]);
    expect(organization.state.targets[0]!.conditions.some(condition => condition.field === "metrics" && condition.display === "合成指标甲" && condition.origin === "history")).toBe(true);
    const organizationPlan = await f.request().semanticTasks!.plan(organization.state.task_ref!);
    const request = f.request("supplement-date", "日期用2024年末"), next = await new SemanticPlanService(request).resolve(proposal([
      {action: "set", field: "time", value: "2024年末"},
    ], {kind: "current"}));
    expect(next.state.task_ref).not.toBe(original.state.task_ref); expect(next.state.task_ref).not.toBe(organization.state.task_ref); expect(next.status).toBe("ready");
    expect(await request.semanticTasks!.plan(original.state.task_ref!)).toEqual(originalPlan);
    expect(await request.semanticTasks!.plan(organization.state.task_ref!)).toEqual(organizationPlan);
    await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2024-12-31"}});
  });
  it.each(["prepare", "reset"])("待补期间%s仍可独立新建条件，不自动复用旧指标", async intent => {
    const f = await setup();
    const previous = await new SemanticPlanService(f.request("pending-base", "查合成指标甲")).resolve(proposal([{action: "set", field: "metrics", value: "合成指标甲"}]));
    const message = intent === "prepare" ? "先准备合成机构甲的查询条件" : "重新开始只用合成机构甲";
    const next = await new SemanticPlanService(f.request("independent-conditions", message)).resolve(proposal([{action: "set", field: "organizations", value: "合成机构甲"}], {kind: "new"}, intent === "prepare" ? "prepare" : "query"));
    expect(next.state.task_ref).not.toBe(previous.state.task_ref);
    expect(next.status).toBe("needs_user"); expect(next.issues.map(issue => issue.field).sort()).toEqual(["metrics", "time"]);
    expect(next.state.targets[0]!.conditions.some(condition => condition.field === "metrics")).toBe(false);
  });
  it("新指标以current沿用已确认范围，旧Frame继续保留", async () => {
    const f = await setup();
    const baseRequest = f.request(), base = await new SemanticPlanService(baseRequest).resolve(proposal(complete()));
    await runTool(createSemanticExecuteTool(), {task_ref: base.state.task_ref, target_ref: base.state.targets[0]!.target_ref}, baseRequest);
    const request = f.request("new-metric", "查合成指标乙");
    const before = (await request.semanticTasks!.plan(base.state.task_ref!))!, beforeTask = (await request.semanticTasks!.get(before.steps[0]!.taskRef!))!;
    const next = await new SemanticPlanService(request).resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
    expect(next.status).toBe("ready");
    const inherited = next.state.targets[0]!.conditions.filter(condition => ["organizations", "time"].includes(condition.field));
    expect(inherited).toHaveLength(2); expect(inherited.every(condition => condition.origin === "history")).toBe(true);
    await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M2"], org_codes: ["O1"], time: {start: "2025-12-31"}, operation: {kind: "value"}});
    expect(await request.frames!.get(beforeTask.target.frameId!)).toMatchObject({fields: {metrics: {resolvedValue: {codes: ["M1"]}}}});
  });
  it.each(["日期清空", "重新开始，不沿用之前条件"])("显式%s时不回退旧日期", async message => {
    const f = await setup();
    await new SemanticPlanService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const next = await new SemanticPlanService(f.request("reset", `查合成指标乙${message.replace("，", "")}`)).resolve(proposal([
      {action: "set", field: "metrics", value: "合成指标乙"}, ...(message === "日期清空" ? [{action: "clear", field: "time"} as const] : []),
    ], message === "日期清空" ? {kind: "current"} : {kind: "new"}));
    expect(next.status).toBe("needs_user");
    expect(next.state.targets[0]!.conditions.some(condition => condition.field === "time")).toBe(false);
    if (message === "日期清空") expect(next.issues.map(issue => issue.field)).toEqual(["time"]);
    else expect(next.issues.map(issue => issue.field).sort()).toEqual(["organizations", "time"]);
  });
  it("当前多目标的机构日期不唯一时不任取历史条件", async () => {
    const f = await setup(), request = f.request("multiple-base", "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
    const input = proposal(complete(), {kind: "new"}, "prepare"); input.targets.push({source: {kind: "new"}, operations: second()});
    await new SemanticPlanService(request).resolve(input);
    const next = await new SemanticPlanService(f.request("ambiguous-context", "查合成指标丙")).resolve(proposal([{action: "set", field: "metrics", value: "合成指标丙"}]));
    expect(next.status).toBe("needs_user");
    expect(next.issues.map(issue => issue.field).sort()).toEqual(["organizations", "time"]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  it.each(["organizations", "time"])("仅确认部分会话条件时继承已确认项，仍追问缺少的%s", async missing => {
    const f = await setup(), message = missing === "organizations" ? "查2025年末的合成指标甲" : "查合成机构甲的合成指标甲";
    await new SemanticPlanService(f.request("partial-base", message)).resolve(proposal(complete().filter(op => op.field !== missing), {kind: "new"}, "prepare"));
    const next = await new SemanticPlanService(f.request("partial-next", "查合成指标乙")).resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
    expect(next.status).toBe("needs_user"); expect(next.issues.map(issue => issue.field)).toEqual([missing]);
    expect(next.state.targets[0]!.conditions.some(condition => condition.field === (missing === "time" ? "organizations" : "time") && condition.origin === "history")).toBe(true);
  });
  it("Pi为两个新指标引用同一范围来源，绑定后分别执行", async () => {
    const f = await setup();
    const base = await new SemanticPlanService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const source = {kind: "reference" as const, task_ref: base.state.task_ref!, target_ref: base.state.targets[0]!.target_ref};
    const input = proposal([{action: "set", field: "metrics", value: "合成指标乙"}], source);
    input.targets.push({source, operations: [{action: "set", field: "metrics", value: "合成指标丙"}]});
    const request = f.request("two-new-metrics", "查合成指标乙；合成指标丙"), next = await new SemanticPlanService(request).resolve(input);
    expect(next.status, JSON.stringify(next.issues)).toBe("ready"); expect(next.state.targets).toHaveLength(2);
    for (const target of next.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: target.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({metric_codes: ["M2"], org_codes: ["O1"], time: {start: "2025-12-31", end: "2025-12-31"}}),
      expect.objectContaining({metric_codes: ["M3"], org_codes: ["O1"], time: {start: "2025-12-31", end: "2025-12-31"}}),
    ]);
  });
  it("Pi明确引用旧目标并新建完整目标，宿主不要求重复旧指标原文", async () => {
    const f = await setup();
    const previous = await new SemanticPlanService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const before = await f.request().semanticTasks!.plan(previous.state.task_ref!);
    const input = proposal([], {kind: "reference", task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref});
    input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "metrics" ? {...op, value: "合成指标乙"} : op)});
    const request = f.request("selected-history-and-new", "继续刚才那个目标并查询合成机构甲2025年末的合成指标乙"), next = await new SemanticPlanService(request).resolve(input);
    expect(next.status, JSON.stringify(next.issues)).toBe("ready"); expect(next.state.targets).toHaveLength(2);
    for (const target of next.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: target.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.map(call => (call[0] as {metric_codes: string[]}).metric_codes)).toEqual([["M1"], ["M2"]]);
    expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(before);
  });
  it("Pi在reference上显式set保留部分指标，不能把旧集合额外成员带入新目标", async () => {
    const f = await setup(), originalRequest = f.request("overlap-base", "查合成机构甲2025年末的合成指标甲和合成指标乙");
    const previous = await new SemanticPlanService(originalRequest).resolve(proposal(complete().map(op => op.field === "metrics" ? {...op, value: "合成指标甲和合成指标乙"} : op), {kind: "new"}, "prepare"));
    expect(previous.status).toBe("prepared");
    const before = await originalRequest.semanticTasks!.plan(previous.state.task_ref!);
    const input = proposal([{action: "set", field: "metrics", value: "合成指标甲"}], {kind: "reference", task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref});
    input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "metrics" ? {...op, value: "合成指标丙"} : op)});
    const request = f.request("partial-overlap", "原目标只保留合成指标甲并查合成机构甲2025年末的合成指标丙"), next = await new SemanticPlanService(request).resolve(input);
    expect(next.status, JSON.stringify(next.issues)).toBe("ready"); expect(next.state.targets).toHaveLength(2);
    for (const target of next.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: target.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls.map(call => (call[0] as {metric_codes: string[]}).metric_codes)).toEqual([["M1"], ["M3"]]);
    expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(before);
    const source = (await request.semanticTasks!.get(before!.steps[0]!.taskRef!))!;
    expect(source.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1", "M2"]});
  });
  it.each(["query", "prepare"])("%s明确新指标但current提案漏指标时直接补齐，不查询旧指标", async intent => {
    const f = await setup(), previous = await new SemanticPlanService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const before = await f.request().semanticTasks!.plan(previous.state.task_ref!);
    const request = f.request("new-goal-omitted", "查合成指标乙"), service = new SemanticPlanService(request);
    const omitted = await service.resolve(proposal([], {kind: "current"}, intent as "query" | "prepare"));
    expect(omitted.status).toBe(intent === "query" ? "ready" : "prepared");
    expect(omitted.issues).toEqual([]);
    const baselineTask = (await request.semanticTasks!.get(before!.steps[0]!.taskRef!))!;
    expect(baselineTask.target.fields.metrics?.resolvedValue).toMatchObject({codes: ["M1"]});
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const next = await service.resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"}, intent as "query" | "prepare"));
    expect(next.status).toBe(intent === "query" ? "ready" : "prepared");
    expect(next.state.targets[0]!.conditions.some(condition => condition.field === "metrics" && condition.display === "合成指标乙")).toBe(true);
  });
  it("机构修改未决后current续问保留未决状态，不回退原机构", async () => {
    const f = await setup();
    await new SemanticPlanService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const pending = await new SemanticPlanService(f.request("pending-org", "机构改成未知机构")).resolve(proposal([{action: "set", field: "organizations", value: "未知机构"}], {kind: "current"}));
    expect(pending.status).toBe("needs_user");
    const next = await new SemanticPlanService(f.request("new-pending-org", "查合成指标乙")).resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
    expect(next.status).toBe("needs_user"); expect(next.issues.map(issue => issue.field)).toEqual(["organizations"]);
    expect(next.state.targets[0]!.conditions.some(condition => condition.field === "organizations")).toBe(false);
  });
  it("继承后的机构撤权仍在消费许可前拒绝，不能执行新指标", async () => {
    const f = await setup();
    await new SemanticPlanService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const request = f.request("revoked-context", "查合成指标乙"), next = await new SemanticPlanService(request).resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
    expect(next.status).toBe("ready");
    f.backend.resolveBusinessField.mockImplementationOnce(async () => ({status: "not_found"}));
    const result = await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
    expect(result.details.status).toBe("denied"); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  it("机构日期继承不吞掉用户未决的新日期，也不回退已确认旧日期", async () => {
    const f = await setup();
    await new SemanticPlanService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const ambiguous = await new SemanticPlanService(f.request("ambiguous-date", "合成指标乙日期改成近5年")).resolve(proposal([
      {action: "set", field: "metrics", value: "合成指标乙"}, {action: "set", field: "time", value: "近5年"},
      {action: "set", field: "selection", value: "当日取值"},
    ], {kind: "current"}));
    expect(ambiguous.status).toBe("needs_user");
    expect(ambiguous.state.targets[0]!.conditions.some(condition => condition.field === "time")).toBe(false);
    expect(ambiguous.issues.map(issue => issue.field)).toEqual(["time"]);
    const previousPlan = (await f.request().semanticTasks!.plan(ambiguous.state.task_ref!))!, previousTask = (await f.request().semanticTasks!.get(previousPlan.steps[0]!.taskRef!))!;
    const next = await new SemanticPlanService(f.request("pending-date", "查合成指标丙")).resolve(proposal([{action: "set", field: "metrics", value: "合成指标丙"}], {kind: "current"}));
    expect(next.status, JSON.stringify({issues: next.issues, before: {metrics: previousTask.target.fields.metrics?.resolvedValue, timeStatus: previousTask.target.fields.time?.resolutionStatus,
      metricSource: previousTask.target.metricSource}})).toBe("needs_user"); expect(next.issues.map(issue => issue.field)).toEqual(["time"]);
    expect(next.state.targets[0]!.conditions.some(condition => condition.field === "time")).toBe(false);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const fixedRequest = f.request("pending-date-fixed", "日期改成2024年末"), fixed = await new SemanticPlanService(fixedRequest).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}));
    expect(fixed.status, JSON.stringify(fixed.issues)).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: fixed.state.task_ref, target_ref: fixed.state.targets[0]!.target_ref}, fixedRequest);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["M3"], org_codes: ["O1"], time: {start: "2024-12-31"}});
  });
  it("复合机构日期指标保持独立绑定，各步骤执行后完成", async () => {
    const f = await setup(), request = f.request("composite", "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
    const input = proposal(complete()); input.targets.push({source: {kind: "new"}, operations: second()});
    const result = await new SemanticPlanService(request).resolve(input);
    expect(result.status).toBe("ready"); expect(f.backend.basicQueries).not.toHaveBeenCalled();
    for (const target of result.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
    const specs = f.backend.basicQueries.mock.calls.map(call => call[0]) as Array<{org_codes: string[]; metric_codes: string[]; time: {start: string}}>;
    expect(specs.map(spec => [spec.org_codes, spec.metric_codes, spec.time.start])).toEqual([[["O1"], ["M1"], "2025-12-31"], [["O2"], ["M2"], "2024-12-31"]]);
    expect((await request.semanticTasks!.plan(result.state.task_ref!))!.completion).toBe("full");
    const reuseRequest = f.request("reuse-one", "只重显合成机构甲的那个结果");
    const view = await new SemanticPlanService(reuseRequest).resolve(proposal([], {kind: "reference", task_ref: result.state.task_ref!, target_ref: result.state.targets[0]!.target_ref}, "reuse"));
    expect(view.status).toBe("reused"); expect(view.state.targets).toHaveLength(1);
    await runTool(createSemanticExecuteTool(), {task_ref: view.state.task_ref, target_ref: view.state.targets[0]!.target_ref}, reuseRequest);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
    expect((await request.semanticTasks!.plan(result.state.task_ref!))!.steps).toHaveLength(2);

  });
  it("第二个目标缺字段时不发该目标许可；条件完整的第一项按自身许可执行", async () => {
    // 旧整批准入（一项不完整即整批零许可）已删除；执行授权按各任务 permit 独立签发。
    const f = await setup(), request = f.request("bad", "查合成机构甲2025年末的合成指标甲；再查合成机构乙2024年末");
    const input = proposal(complete()); input.targets.push({source: {kind: "new"}, operations: second().filter(op => op.field !== "metrics")});
    const result = await new SemanticPlanService(request).resolve(input);
    expect(result.status).not.toBe("ready");
    const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
    const blocked = (await request.semanticTasks!.get(plan.steps[1]!.taskRef!))!;
    expect(blocked.permit).toBeUndefined(); expect(blocked.target.status).toBe("blocked");
    // 旁路用内部子任务引用执行仍被拒绝（PLAN_REFERENCE_REQUIRED）。
    await runTool(createSemanticExecuteTool(), {task_ref: plan.steps[0]!.taskRef!, target_ref: plan.steps[0]!.targetRef}, request);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const executed = await runTool(createSemanticExecuteTool(), {task_ref: plan.ref, target_ref: plan.steps[0]!.targetRef}, request);
    expect(executed.details.state.targets[0]!.status).toBe("succeeded");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2025-12-31"}});
    await runTool(createSemanticExecuteTool(), {task_ref: plan.ref, target_ref: plan.steps[1]!.targetRef}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
  it("独立并列片段在构造时补齐，并归一交叉配错的日期", async () => {
    const f = await setup();
    for (const [id, operations] of [["omit", complete()], ["cross", complete().map(op => op.field === "time" ? {...op, value: "2024年末"} : op)]] as const) {
      const request = f.request(id, "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
      const result = await new SemanticPlanService(request).resolve(proposal(operations));
      expect(result.status).toBe("ready"); expect(result.state.targets).toHaveLength(2);
      for (const target of result.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
    }
    expect(f.backend.basicQueries.mock.calls.map(call => call[0])).toMatchObject([
      {org_codes: ["O1"], metric_codes: ["M1"], time: {start: "2025-12-31"}},
      {org_codes: ["O2"], metric_codes: ["M2"], time: {start: "2024-12-31"}},
      {org_codes: ["O1"], metric_codes: ["M1"], time: {start: "2025-12-31"}},
      {org_codes: ["O2"], metric_codes: ["M2"], time: {start: "2024-12-31"}},
    ]);
  });
  it("共享机构日期的两个指标可分别作为步骤，省略一项仍阻断", async () => {
    const f = await setup(), request = f.request("shared", "查合成机构甲2025年末的合成指标甲和合成指标乙");
    const input = proposal(complete()); input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "metrics" ? {...op, value: "合成指标乙"} : op)});
    const result = await new SemanticPlanService(request).resolve(input);
    expect(result.status).toBe("ready");
    expect(result.state.targets).toHaveLength(2);
  });
  it("分析目标取得结果后可追加另一个步骤", async () => {
    const f = await setup(), request = f.request("analysis", "分析合成机构甲2025年末的经营情况");
    const service = new SemanticPlanService(request), input = proposal([...complete(), {action: "set", field: "objective", value: "经营规模"}], {kind: "new"}, "analyze");
    const ready = await service.resolve(input); expect({status: ready.status, issues: ready.issues}).toEqual({status: "ready", issues: []});
    await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, request);
    const followup = proposal([...complete().map(op => op.field === "metrics" ? {...op, value: "合成指标乙"} : op), {action: "set", field: "objective", value: "经营质量"}], {kind: "new"}, "analyze");
    const next = await service.resolve(followup); expect(next.status).toBe("ready"); expect(next.state.targets).toHaveLength(2);
    await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[1]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  });
  it("多目标current不猜选，必须引用明确目标", async () => {
    const f = await setup(), request = f.request("start", "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
    const input = proposal(complete()); input.targets.push({source: {kind: "new"}, operations: second()});
    await new SemanticPlanService(request).resolve(input);
    await expect(new SemanticPlanService(f.request("change", "日期改成2024年末")).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}))).rejects.toMatchObject({issue: {code: "TARGET_REFERENCE_REQUIRED"}});
  });
  it("无效计算或未知来源在计算执行前被拦截，完整查询目标按自身许可执行", async () => {
    const f = await setup(), request = f.request();
    const input = proposal([...complete(), {action: "set", field: "objective", value: "余额"}], {kind: "new"}, "calculate");
    input.targets.push({source: {kind: "new"}, operations: [{action: "set", field: "calculation", value: '`不存在` + 1'}]});
    const result = await new SemanticPlanService(request).resolve(input); expect(result.status).toBe("needs_interpretation");
    const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
    expect(plan.steps.find(step => step.kind === "calculation")!.status).toBe("blocked");
    const executed = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(executed.details.state.targets[0]!.status).toBe("succeeded");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[1]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
  it("唯一公开入口使用完整任务服务", async () => {
    const f = await setup(), result = await runTool(createSemanticResolveTool(), proposal(complete()), f.request());
    expect(result.details.status).toBe("ready"); expect(await f.request().semanticTasks!.plan(result.details.state.task_ref)).toBeDefined();
  });
  it("待补计划续接重述时间表达时沿用本轮采纳日历，执行提交同一日历", async () => {
    const f = await setup(), backend = f.backend;
    const originalInspect = backend.inspectBusinessGoal.getMockImplementation()!;
    backend.inspectBusinessGoal.mockImplementation((async (question: string) => {
      if (!question.includes("2021年末到2026年9月末")) return originalInspect(question);
      return {question, reference_year: null, fragments: [{question,
        organizations: ["O1"], calendar: {ranges: [], unresolved: ["2021年末到2026年9月末"]},
        mentions: [{text: "合成指标甲", start: 0, end: 5,
          resolution: {status: "resolved" as const, value: {codes: ["M1"], names: ["合成指标甲"]}}}]}]};
    }) as never);
    const originalResolve = backend.resolveBusinessField.getMockImplementation()!;
    backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "date" && raw[0] === "2021年末到2026年9月末") return {status: "resolved",
        value: {start: "2021-12-31", end: "2026-09-30"},
        metadata: {resolution_source: "model", businessDate: "2026-10-17",
          source_calendar: {ranges: [{start: "2021-12-31", end: "2026-09-30"}], unresolved: []}}} as never;
      return originalResolve(entity, raw, ...rest as []);
    });
    const first = await new SemanticPlanService(f.request("a6-first", "查合成机构甲2025年末的数据")).resolve(proposal([
      {action: "set", field: "organizations", value: "合成机构甲"},
      {action: "set", field: "time", value: "2025年末"},
    ]));
    expect(first.status).toBe("needs_user");
    const second = await new SemanticPlanService(f.request("a6-second",
      "指标用合成指标甲，查询全部已有记录，范围改为2021年末到2026年9月末。")).resolve(proposal([
      {action: "set", field: "metrics", value: "合成指标甲"},
      {action: "set", field: "time", value: "2021年末到2026年9月末", modelCalendar: {start: "2021-12-31", end: "2026-09-30"}},
      {action: "set", field: "selection", value: "全部已有记录"},
    ], {kind: "current"}));
    expect(second.status, JSON.stringify(second.issues)).toBe("ready");
    const plan = (await f.request().semanticTasks!.plan(second.state.task_ref!))!;
    const task = (await f.request().semanticTasks!.get(plan.steps[0]!.taskRef!))!;
    expect(task.target.fields.time!.resolvedValue).toEqual({start: "2021-12-31", end: "2026-09-30"});
    expect(task.target.fields.time!.metadata?.resolution_source).toBe("model");
    const request = f.request("a6-execute", "执行");
    await runTool(createSemanticExecuteTool(), {task_ref: second.state.task_ref, target_ref: second.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({time: {start: "2021-12-31", end: "2026-09-30"}, selection: "all_in_range"});
  });
  it("待补计划澄清后改用其它日期，需求检查同步为实际确认条件并正常完成", async () => {
    const f = await setup(), request = f.request("pending-date-origin", "查合成机构甲2025年末的合成指标甲");
    const ready = await new SemanticPlanService(request).resolve(proposal(complete()));
    expect(ready.status, JSON.stringify(ready.issues)).toBe("ready");
    // 模拟单目标澄清后续接：旧需求步骤绑定落空且仍保留最初占位条件（旧日期/另一机构）。
    const store = request.semanticTasks!, plan = (await store.plan(ready.state.task_ref!))!;
    // 旧会话遗留的覆盖证明仅为历史数据，执行完成度不再读取它。
    Object.assign(plan, {requirements: [{stepIds: [], checks: [{metric: "M1", name: "合成指标甲", orgs: ["O2"],
      ranges: [{start: "2020-01-01", end: "2020-01-01"}]}]}]});
    await store.savePlan(plan, (await store.planIndex()).version, true);
    const executed = await runTool(createSemanticExecuteTool(),
      {task_ref: plan.ref, target_ref: plan.steps[0]!.targetRef}, request);
    expect(executed.details.status).toBe("succeeded");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2025-12-31"}});
  });
});
describe("公式结构与来源", () => {
  it("支持完整标签和聚合，禁止模型填数、内部ID和任意代码", () => {
    expect(parseFormula('avg(`六月`, `五月`) - abs(`五月`)', ["六月", "五月"]).labels).toEqual(["六月", "五月"]);
    for (const expression of ['`六月` + 999', 'process.exit()', 'fact_id', '`六月` +', 'sum()', '`六月`(`五月`)']) expect(() => parseFormula(expression, ["六月", "五月"])).toThrow();
    expect(() => parseFormula('`余额` + 1', ["余额", "余额"])).toThrow();
    expect(parseFormula('percent(`六月` / `五月` - 1)', ["六月", "五月"]).display).toBe("percent");
    expect(parseFormula('`六月` * 0.5', ["六月"], "将六月结果乘以0.5").constants).toEqual({c0: {value: "0.5", source_text: "0.5"}});
  });
});

describe("既有能力执行依赖", () => {
  it("排名条数不充当机构数量，关注位次使用完整比较总体", async () => {
    const f = await setup();
    const operations = complete().map(op => op.field === "organizations" ? {...op, value: "合成机构甲和合成机构乙"} : op);
    const rank = await new SemanticPlanService(f.request("rank", "查合成机构甲和合成机构乙2025年末的合成指标甲前1名")).resolve(proposal(operations));
    expect({status: rank.status, issues: rank.issues}).toEqual({status: "ready", issues: []});
    await runTool(createSemanticExecuteTool(), {task_ref: rank.state.task_ref, target_ref: rank.state.targets[0]!.target_ref}, f.request("rank", "查合成机构甲和合成机构乙2025年末的合成指标甲前1名"));
    expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({org_codes: ["O1", "O2"], operation: {kind: "ranking", position: "top", top_n: 1}});
    const position = await new SemanticPlanService(f.request("position", "合成机构甲2025年末的合成指标甲在合成机构甲和合成机构乙两家中的位次")).resolve(proposal([...complete(), {action: "set", field: "comparison_organizations", value: "合成机构乙"}]));
    expect({status: position.status, issues: position.issues}, JSON.stringify(position.issues)).toEqual({status: "ready", issues: []});
  });
  it("查询事实实际成功后由宿主绑定计算，模型不输入事实ID", async () => {
    const f = await setup(), request = f.request("calc", "合成机构甲2025年末合成指标甲和合成指标乙相减");
    let executions = 0;
    f.backend.basicQueries.mockImplementation(async () => {const id = `query-${++executions}`; return {result: {status: "succeeded", task_id: id, result_id: `result-${id}`, columns: [], rows: [], row_count: 1, truncated: false, message: "合成查询"}};});
    f.backend.getTaskResult.mockImplementation(async (...args: unknown[]) => ({status: "succeeded", task_id: String(args[0]), result_id: "result", columns: [], rows: [], row_count: 1, truncated: false,
      facts: [{fact_id: `fact-${args[0]}`, task_id: String(args[0]), field: "metric_value", value: "20", unit: "元", metric_code: "M1", metric_name: "合成指标甲", org_code: "O1", org_name: "合成机构甲", date: "2025-12-31"}]}));
    const calculate = vi.fn(async (_payload: unknown) => ({status: "succeeded", task_id: "calculation-task", calculation_id: "calculation", results: [], public_answer: "合成计算完成"})); Object.assign(f.backend, {calculate});
    const input = proposal([...complete(), {action: "set", field: "objective", value: "甲项"}], {kind: "new"}, "calculate");
    input.targets.push({source: {kind: "new"}, operations: [...complete().map(op => op.field === "metrics" ? {...op, value: "合成指标乙"} : op), {action: "set", field: "objective", value: "乙项"}]},
      {source: {kind: "new"}, operations: [{action: "set", field: "calculation", value: '`甲项` - `乙项`'}, {action: "set", field: "objective", value: "差额"}]});
    const result = await new SemanticPlanService(request).resolve(input); expect(result.status).toBe("ready");
    expect(calculate).not.toHaveBeenCalled();
    for (const target of result.state.targets) {
      const execution = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
      expect(execution.details.status).not.toBe("failed"); expect(execution.details.status).not.toBe("conflict");
    }
    expect(calculate).toHaveBeenCalledTimes(1);
    const payload = calculate.mock.calls[0]![0] as unknown as {bindings: unknown; expressions: unknown};
    expect(payload.bindings).toEqual({v0_0: {fact_id: "fact-query-1"}, v1_0: {fact_id: "fact-query-2"}});
    expect((await request.semanticTasks!.plan(result.state.task_ref!))!.completion).toBe("full");
  });
  it("覆盖发现保持范围和页码，不触发指标SQL", async () => {
    const f = await setup(), request = f.request("coverage", "查合成机构甲2025年末有记录的指标，第2页");
    const dataAvailability = vi.fn(async (spec: unknown) => ({status: "succeeded", mode: "metrics", org_names: ["合成机构甲"], request: spec, page: 2, items: [{metric_code: "M2", metric_name: "合成指标乙"}], metric_count: 1, has_more: false, notice: "合成覆盖"})); Object.assign(f.backend, {dataAvailability});
    const result = await new SemanticPlanService(request).resolve(proposal([{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2025年末"}, {action: "set", field: "availability", value: "有记录的指标，第2页"}], {kind: "new"}, "availability"));
    expect(result.status).toBe("ready");
    const executed = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(executed.details.status).toBe("succeeded"); expect(dataAvailability).toHaveBeenCalledTimes(1);
    expect(dataAvailability.mock.calls[0]![0]).toMatchObject({org_codes: ["O1"], start: "2025-12-31", end: "2025-12-31", page: 2, dimension: "metrics"});
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const followup = f.request("coverage-analysis", "分析这些指标的表现");
    const analysis = await new SemanticPlanService(followup).resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"}, "analyze"));
    expect({status: analysis.status, issues: analysis.issues}).toEqual({status: "ready", issues: []});
    await runTool(createSemanticExecuteTool(), {task_ref: analysis.state.task_ref, target_ref: analysis.state.targets[0]!.target_ref}, followup);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(dataAvailability).toHaveBeenCalledTimes(1);
    expect((await request.semanticTasks!.plan(result.state.task_ref!))!.steps[0]!.kind).toBe("availability");
  });
});
it("其它能力的参数边界仍校验：非法覆盖页码不发放该目标许可，完整查询目标按自身许可执行", async () => {
  const f = await setup(), request = f.request("bad-page", "查合成机构甲2025年末的合成指标甲并查看有记录指标第0页");
  const input = proposal(complete()); input.targets.push({source: {kind: "new"}, operations: [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "availability", value: "有记录的指标第0页"}]});
  const result = await new SemanticPlanService(request).resolve(input);
  expect(result.issues.some(issue => issue.field === "page")).toBe(true);
  expect(result.status).not.toBe("ready");
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
  const blocked = (await request.semanticTasks!.get(plan.steps[1]!.taskRef!))!;
  expect(blocked.permit).toBeUndefined();
  const executed = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
  expect(executed.details.state.targets[0]!.status).toBe("succeeded");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[1]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("纠正榜单总体误放comparison字段时，clear可选字段不会留下永久待决", async () => {
  const f = await setup(), request = f.request("ranking-clear", "合成机构甲和合成机构乙2025年末的合成指标甲前1名");
  const service = new SemanticPlanService(request);
  const incorrect = proposal([...complete(), {action: "set", field: "comparison_organizations", value: "合成机构乙"}]);
  expect((await service.resolve(incorrect)).status).toBe("ready");
  const corrected = proposal([...complete().map(op => op.field === "organizations" ? {...op, value: "合成机构甲和合成机构乙"} : op), {action: "clear", field: "comparison_organizations"}]);
  const result = await service.resolve(corrected);
  expect({status: result.status, issues: result.issues}).toEqual({status: "ready", issues: []});
  expect(result.state.targets[0]!.pending).toEqual([]);
  await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]![0]).not.toHaveProperty("comparison_scope");
});

it("版本2能力说明不再把现有综合分析笼统拒绝，预测边界仍保留", async () => {
  const f = await setup(), tool = createAskMetricTools().find(tool => tool.name === "business_capability_explain")!;
  const supported = await runTool(tool, {capability: "comprehensive_analysis"}, f.request());
  expect(supported.details.status).toBe("needs_interpretation");
  expect(supported.details.issues[0].code).toBe("ANALYSIS_AVAILABLE");
  const unsupported = await runTool(tool, {capability: "forecast"}, f.request());
  expect(unsupported.details.status).toBe("unsupported");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("步骤失败正文保留受控执行器的真实公开原因，不能只显示已保存条件", () => {
  const feedback = semanticFeedback(undefined, "failed");
  feedback.state.evidence = {kind: "semantic_results", results: [{status: "succeeded", public_answer: "查询成功"}, {status: "error", public_answer: "分母为零，无法计算。"}]};
  expect(semanticPublicAnswer(feedback)).toContain("分母为零");
  expect(semanticPublicAnswer(feedback)).not.toContain("查询成功");
});

it("澄清正文不重复展示已保存条件，条件仍随结构化回执提供", () => {
  const feedback = semanticFeedback(undefined, "needs_user");
  feedback.issues = [{code: "FIELD_REQUIRED", field: "time", message: "请补充查询日期范围。", remediation: "user", category: "calendar"}];
  feedback.state.targets = [{target_ref: "target", status: "blocked", pending: [],
    conditions: [{field: "organizations", display: "合成机构甲", origin: "user_explicit"}]}];
  const answer = semanticPublicAnswer(feedback);
  expect(answer).toContain("请补充查询日期范围");
  expect(answer).not.toContain("已保存条件");
  expect(answer).not.toContain("合成机构甲");
  expect(feedback.state.targets[0]!.conditions).toHaveLength(1);
});


it("新建集合的add统一按空集合追加，不要求重提已明确条件", async () => {
  const f = await setup(), request = f.request("fresh-add", "查询合成机构甲2025年末的合成指标甲");
  const service = new SemanticPlanService(request);
  const blocked = await service.resolve(proposal(complete().map(op => op.field === "time" ? op : ({action: "add", field: op.field, value: "value" in op ? op.value : ""}))));
  expect(blocked.status).toBe("ready");
  expect(blocked.issues).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const ready = await service.resolve(proposal(complete()));
  expect(ready.status).toBe("ready");
});

it("覆盖提案修复日期时复用完整规范结果，维度与分页不能被字段缓存丢弃",async()=>{
 const f=await setup(),request=f.request("coverage-repair","查合成机构甲2025年末有哪些指标有记录");
 const dataAvailability=vi.fn(async()=>({status:"succeeded",mode:"metrics",org_names:["合成机构甲"],request:{org_codes:["O1"]},page:1,items:[],metric_count:0,has_more:false,notice:"合成覆盖"}));Object.assign(f.backend,{dataAvailability});
 const service=new SemanticPlanService(request);
 const first=await service.resolve(proposal([{action:"set",field:"organizations",value:"合成机构甲"},{action:"set",field:"time",value:"无效日期"},{action:"set",field:"availability",value:"有记录的指标"}],{kind:"new"},"availability"));
 expect(first.status).toBe("ready");
 const next=await service.resolve(proposal([{action:"set",field:"time",value:"2025年末"}],{kind:"new"},"availability"));
 expect({status:next.status,issues:next.issues}).toEqual({status:"ready",issues:[]});
 await runTool(createSemanticExecuteTool(),{task_ref:next.state.task_ref,target_ref:next.state.targets[0]!.target_ref},request);
 expect(dataAvailability).toHaveBeenCalledTimes(1);expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

describe("澄清来源边界", () => {
  it("没有待明确备选时，字段问题回答附带的 resume 按普通续接处理", async () => {
    const f = await setup();
    const input = proposal(complete(), {kind: "new"});
    input.context_action = "resume";
    const result = await new SemanticPlanService(f.request("resume-without-pending", "查合成机构甲2025年末的合成指标甲")).resolve(input);
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  });
});
