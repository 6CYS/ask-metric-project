import {afterEach, expect, it} from "vitest";
import {fixture, complete, proposal} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticOperation} from "../../src/semantic-task/protocol.js";
import {coalesceOrganizationAssignments} from "../../src/semantic-task/actionBinding.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
async function setup() {const f = await fixture(); cleanup.push(f.close); return f;}

it.each(["合成机构甲和合成机构乙，只看合成机构甲", "合成机构甲，不查合成机构乙", "合成机构甲换成合成机构乙"])
  ("含集合限定时不把多次set合并成正向全集：%s", question => {
    const operations: SemanticOperation[] = ["合成机构甲", "合成机构乙"].map(value => ({action: "set", field: "organizations", value}));
    expect(coalesceOrganizationAssignments(operations, question)).toBe(operations);
  });
it.each<SemanticOperation[]>([
  [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "organizations", value: "无来源机构"}],
  [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "exclude", field: "organizations", subject: "合成机构乙"}],
  [{action: "set", field: "organizations", value: "合成机构甲", structured: true, values: ["合成机构甲"]}, {action: "set", field: "organizations", value: "合成机构乙"}],
  [{action: "set", field: "organizations", value: "合成机构甲,"}, {action: "set", field: "organizations", value: "合成机构乙"}],
])("保留无法安全归一的机构动作，不静默丢弃无效项：%j", (...operations) => {
  expect(coalesceOrganizationAssignments(operations, "合成机构甲和合成机构乙最近情况？")).toBe(operations);
});
it("其他字段的重复赋值仍由协议拒绝", async () => {
  const f = await setup(), request = f.request("duplicate-time", "合成机构甲和合成机构乙2024年末和2025年末的合成指标甲");
  const operations = [...complete(), {action: "set" as const, field: "organizations" as const, value: "合成机构乙"},
    {action: "set" as const, field: "time" as const, value: "2024年末"}];
  await expect(new SemanticPlanService(request).resolve(proposal(operations))).rejects.toMatchObject({issue: {code: "FIELD_MULTIPLE_ASSIGNMENTS"}});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});
it("历史目标的重复机构set仍拒绝，不自动改写历史范围", async () => {
  const f = await setup(), request = f.request("duplicate-current", "合成机构甲和合成机构乙最近情况？");
  await expect(new SemanticPlanService(request).resolve(proposal([
    {action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "organizations", value: "合成机构乙"},
  ], {kind: "current"}))).rejects.toMatchObject({issue: {code: "FIELD_MULTIPLE_ASSIGNMENTS"}});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([
  {field: "metrics", question: "查合成机构甲2025年末的数据", answer: "指标是合成指标甲", value: "合成指标甲"},
  {field: "organizations", question: "查2025年末的合成指标甲", answer: "机构是合成机构甲", value: "合成机构甲"},
  {field: "time", question: "查合成机构甲的合成指标甲", answer: "日期是2025年末", value: "2025年末"},
] as const)("缺$field → 补齐 → 查询 → 再续问只改日期，条件与SQL一致", async ({field, question, answer, value}) => {
  const f = await setup(), initial = f.request("missing", question);
  const first = await new SemanticPlanService(initial).resolve(proposal(complete().filter(op => op.field !== field)));
  expect(first.status).toBe("needs_user"); expect(first.issues.map(issue => issue.field)).toEqual([field]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const request = f.request("supply", answer), service = new SemanticPlanService(request);
  // 故意使用new：唯一待补来源直接绑定，不再让模型证明来源再重提一次。
  const ready = await service.resolve(proposal([{action: "set", field, value}]));
  expect(ready.status, JSON.stringify(ready.issues)).toBe("ready"); expect(ready.issues).toEqual([]);
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, request);
  const nextRequest = f.request("followup", "日期改为2024年末");
  const next = await new SemanticPlanService(nextRequest).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}));
  expect(next.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, nextRequest);
  expect(f.backend.basicQueries.mock.calls.map(call => call[0])).toMatchObject([
    {org_codes: ["O1"], metric_codes: ["M1"], time: {start: "2025-12-31", end: "2025-12-31"}},
    {org_codes: ["O1"], metric_codes: ["M1"], time: {start: "2024-12-31", end: "2024-12-31"}},
  ]);
  expect(await request.semanticTasks!.plan(first.state.task_ref!)).toMatchObject({status: "waiting_input"});
});

it("排除、重复排除、追加和仅改日期统一更新当前集合，旧动作原文不能冒充整个集合", async () => {
  const f = await setup();
  const steps: Array<{message: string; operations: SemanticOperation[]; expected: string[]; queries: number}> = [
    {message: "查合成机构甲和合成机构乙2025年末的合成指标甲", operations: complete().map(op => op.field === "organizations" ? {...op, value: "合成机构甲、合成机构乙"} : op), expected: ["O1", "O2"], queries: 1},
    {message: "排除合成机构乙", operations: [{action: "exclude", field: "organizations", subject: "合成机构乙"}], expected: ["O1"], queries: 2},
    {message: "再排除一次合成机构乙", operations: [{action: "exclude", field: "organizations", subject: "合成机构乙"}], expected: ["O1"], queries: 2},
    {message: "加上合成机构乙", operations: [{action: "add", field: "organizations", value: "合成机构乙"}], expected: ["O1", "O2"], queries: 3},
    {message: "日期改为2024年末", operations: [{action: "set", field: "time", value: "2024年末"}], expected: ["O1", "O2"], queries: 4},
  ];
  for (const [number, step] of steps.entries()) {
    const request = f.request(`collection-${number}`, step.message), service = new SemanticPlanService(request);
    const result = await service.resolve(proposal(step.operations, {kind: number ? "current" : "new"}));
    expect(["ready", "reused"], JSON.stringify(result.issues)).toContain(result.status);
    const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!, task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
    expect(task.target.fields.organizations!.resolvedValue).toMatchObject({codes: step.expected});
    expect(task.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1"]});
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(step.queries);
  }
});

it("同轮重提复用相同事实与字段绑定，执行前权限复核独立进行", async () => {
  const f = await setup(), request = f.request(), service = new SemanticPlanService(request);
  const ready = await service.resolve(proposal(complete()));
  const inspected = f.backend.inspectBusinessGoal.mock.calls.length, resolved = f.backend.resolveBusinessField.mock.calls.length;
  const same = await service.resolve(proposal(complete()));
  expect(same.status).toBe("ready"); expect(f.backend.inspectBusinessGoal).toHaveBeenCalledTimes(inspected);
  expect(f.backend.resolveBusinessField).toHaveBeenCalledTimes(resolved);
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: same.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.resolveBusinessField.mock.calls.length).toBeGreaterThan(resolved);
});

it("两个历史目标交换日期时复制各自来源字段，不重新解释历史日期", async () => {
  const f = await setup(), firstRequest = f.request("pair", "查合成机构甲2025年末的合成指标甲；合成机构乙2024年末的合成指标乙");
  const input = proposal(complete()); input.targets.push({source: {kind: "new"}, operations: complete().map(op =>
    op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"})});
  const first = await new SemanticPlanService(firstRequest).resolve(input);
  for (const target of first.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: first.state.task_ref, target_ref: target.target_ref}, firstRequest);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const saved = await firstRequest.semanticTasks!.plan(first.state.task_ref!);
  const nextRequest = f.request("swap", "把合成机构甲和合成机构乙的日期交换一下");
  const swapped = await new SemanticPlanService(nextRequest).resolve({protocol_version: 2, intent: "query", targets: first.state.targets.map(target => ({
    source: {kind: "reference", task_ref: first.state.task_ref!, target_ref: target.target_ref},
    operations: [{action: "set", field: "time", value: "2025年末"}],
  }))});
  expect(swapped.status, JSON.stringify(swapped.issues)).toBe("ready");
  const swapPlan = (await nextRequest.semanticTasks!.plan(swapped.state.task_ref!))!;
  expect(swapPlan.steps.map(step => step.operations)).toEqual(first.state.targets.map((_, index) => [{action: "copy", field: "time", reference: {task_ref: first.state.task_ref!, target_ref: first.state.targets[1-index]!.target_ref}}]));
  const swapTasks = await Promise.all(swapPlan.steps.map(step => nextRequest.semanticTasks!.get(step.taskRef!)));
  expect(swapTasks.map(task => task!.target.fields.time!.resolvedValue)).toEqual([{start: "2024-12-31", end: "2024-12-31"}, {start: "2025-12-31", end: "2025-12-31"}]);
  for (const target of swapped.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: swapped.state.task_ref, target_ref: target.target_ref}, nextRequest);
  expect(f.backend.basicQueries.mock.calls.slice(2).map(call => call[0])).toMatchObject([
    {org_codes: ["O1"], metric_codes: ["M1"], time: {start: "2024-12-31"}},
    {org_codes: ["O2"], metric_codes: ["M2"], time: {start: "2025-12-31"}},
  ]);
  expect(await nextRequest.semanticTasks!.plan(first.state.task_ref!)).toEqual(saved);
});

it("跨两笔历史的那一笔须明确来源，追问保存原日期修改且不查询", async () => {
  const f = await setup();
  for (const [id, question, operations] of [["old", "查合成机构甲2025年末的合成指标甲", complete()],
    ["new", "查合成机构乙2024年末的合成指标乙", complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : {...op, value: "2024年末"})]] as const) {
    const request = f.request(id, question), result = await new SemanticPlanService(request).resolve(proposal(operations));
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
  }
  const request = f.request("which", "把那一笔的日期改成2025年末");
  await expect(new SemanticPlanService(request).resolve(proposal([{action: "set", field: "time", value: "2025年末"}], {kind: "current"})))
    .rejects.toMatchObject({issue: {code: "TARGET_SELECTION_AMBIGUOUS", remediation: "user"}});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const saved = (await request.semanticTasks!.admit("resume", "合成机构甲那一笔")).context?.clarification;
  expect(saved).toMatchObject({originalMessage: request.originalMessage}); expect(saved?.alternatives).toHaveLength(2);
});


it("否定和只看是动作范围，提到的旧指标不会被自动补回最终集合", async () => {
  const f = await setup(), firstRequest = f.request("all", "查合成机构甲2025年末的合成指标甲和合成指标乙");
  const first = await new SemanticPlanService(firstRequest).resolve(proposal(complete().map(op => op.field === "metrics" ? {...op, value: "合成指标甲、合成指标乙"} : op)));
  await runTool(createSemanticExecuteTool(), {task_ref: first.state.task_ref, target_ref: first.state.targets[0]!.target_ref}, firstRequest);
  const request = f.request("only", "不要合成指标甲，只查合成指标乙");
  const next = await new SemanticPlanService(request).resolve(proposal([{action: "set", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
  expect(next.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({org_codes: ["O1"], metric_codes: ["M2"], time: {start: "2025-12-31"}});
});

it.each([
  {field: "metrics", label: "指标", first: "查合成机构甲2025年末的数据", unknown: "存款记录", known: "合成指标甲"},
  {field: "organizations", label: "机构", first: "查2025年末的合成指标甲", unknown: "未知机构", known: "合成机构甲"},
] as const)("补充未知$field也绑定原待补目标，只追问该项且不丢其它条件", async ({field, label, first, unknown, known}) => {
  const f = await setup();
  const initial = await new SemanticPlanService(f.request("missing", first)).resolve(proposal(complete().filter(op => op.field !== field)));
  expect(initial.status).toBe("needs_user");
  const pendingRequest = f.request("unknown", `${label}是${unknown}`);
  const pending = await new SemanticPlanService(pendingRequest).resolve(proposal([{action: "set", field, value: unknown}]));
  expect(pending.status, JSON.stringify(pending.issues)).toBe("needs_user");
  expect(pending.issues.map(issue => issue.field)).toEqual([field]); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const request = f.request("known", `${label}是${known}`);
  const ready = await new SemanticPlanService(request).resolve(proposal([{action: "set", field, value: known}]));
  expect(ready.status, JSON.stringify(ready.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({org_codes: ["O1"], metric_codes: ["M1"], time: {start: "2025-12-31"}});
});
