import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {afterEach, expect, it} from "vitest";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {SemanticTaskService} from "../../src/semantic-task/service.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {semanticFeedback, semanticPublicAnswer} from "../../src/semantic-task/feedback.js";
import {pendingCompletionSource} from "../../src/semantic-task/sourceGuard.js";
import {runTool} from "../../src/tools/testUtils.js";
import {BackendApiError, type BackendClient} from "../../src/backendClient.js";
import {createSyntheticBackend} from "../../scripts/phase4-synthetic-backend.js";
import {fixture, proposal} from "./fixtures.js";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of clean.splice(0)) await close();});
const cache = new Map<string, any>();
function python(payload: unknown, script = "semantic-task-fixture.py"): any {
  const input = JSON.stringify(payload), key = script + input;
  if (cache.has(key)) return structuredClone(cache.get(key));
  const output = JSON.parse(execFileSync(resolve("../backend-next/.venv/bin/python"), [resolve("scripts", script)],
    {input, encoding: "utf8", timeout: 30000, env: {PATH: "/usr/bin:/bin:/opt/homebrew/bin"}}));
  if (!output.ok) throw new BackendApiError(422, output.message, output.error);
  cache.set(key, output.value); return output.value;
}
async function setup(script?: string) {
  const f = await fixture(); clean.push(f.close);
  const invoke = (payload: unknown) => python(payload, script);
  const request = (id: string, message: string) => ({...f.request(id, message), backend: {
    ...f.backend,
    inspectBusinessGoal: async (question: string, business_date: string, _options?: unknown, reference_year?: number) => invoke({action: "inspect", question, business_date, reference_year}),
    resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, year?: number, source?: unknown, modelValue?: unknown) => invoke({action: "resolve", entity, raw, year, source, model_value: modelValue}),
    matchMetricQuestion: async (question: string) => invoke({action: "mentions", question}),
  } as unknown as BackendClient});
  return {...f, request, invoke};
}
const base = [
  {action: "set", field: "organizations", value: "合成机构甲"},
  {action: "set", field: "metrics", value: "经营收益金额当日数"},
  {action: "set", field: "time", value: "2026年5月31日"},
] as const;
it("不同历史字段按签发来源复制，保留接收目标机构日期且不重写旧任务",async()=>{
 const f=await setup();
 const a=await new SemanticPlanService(f.request("copy-a","查询合成机构甲2026年5月31日的经营收益金额当日数")).resolve(proposal([...base]));
 const b=await new SemanticPlanService(f.request("copy-b","查询合成机构乙2026年6月30日的经营收益金额较同期")).resolve(proposal([{action:"set",field:"organizations",value:"合成机构乙"},{action:"set",field:"time",value:"2026年6月30日"},{action:"set",field:"metrics",value:"经营收益金额较同期"}]));
 expect(a.status).toBe("ready");expect(b.status).toBe("ready");
 const request=f.request("copy-c","机构日期沿用当前，指标使用第一次查询的指标");
 const result=await new SemanticPlanService(request).resolve(proposal([{action:"copy",field:"metrics",reference:{task_ref:a.state.task_ref!,target_ref:a.state.targets[0]!.target_ref}}],{kind:"reference",task_ref:b.state.task_ref!,target_ref:b.state.targets[0]!.target_ref}));
 expect(result.status,JSON.stringify(result.issues)).toBe("ready");
 const plan=await request.semanticTasks!.plan(result.state.task_ref!);const task=await request.semanticTasks!.get(plan!.steps[0]!.taskRef!);
 expect(task!.target.fields.metrics!.resolvedValue).toMatchObject({codes:["SYNTH_M:D"]});expect(task!.target.fields.organizations!.resolvedValue).toMatchObject({codes:["SYNTH_O2"]});
 expect(task!.target.fields.time!.resolvedValue).toEqual({start:"2026-06-30",end:"2026-06-30"});
 expect(task!.target.fields.metrics!.metadata?.fieldSource).toMatchObject({field: "metrics"});
 expect(f.backend.basicQueries).not.toHaveBeenCalled();
},30000);
it("合成后端不能把不存在的任务或结果当成功",async()=>{
 const b=createSyntheticBackend();
 await expect(b.client.getTask("unobserved")).rejects.toMatchObject({status:404});
 await expect(b.client.getTaskResult("unobserved")).rejects.toMatchObject({status:404});
});
it("真实目录下缺项续补直接绑定唯一来源，保留已确认口径并执行", async () => {
  const f = await setup(), initialRequest = f.request("missing-source", "帮我查经营收益金额当日数");
  const first = await new SemanticPlanService(initialRequest).resolve(proposal([{action: "set", field: "metrics", value: "经营收益金额当日数"}]));
  expect(first.status).toBe("needs_user");
  const previous = (await initialRequest.semanticTasks!.plan(first.state.task_ref!))!;
  const previousTask = (await initialRequest.semanticTasks!.get(previous.steps[0]!.taskRef!))!;
  const request = f.request("complete-source", "机构是合成机构甲，日期是2026年5月31日");
  const fields = [{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2026年5月31日"}] as const;
  for (const operations of [[...fields, {action: "set" as const, field: "metrics" as const, value: "经营收益金额"}], [...fields]]) {
    const wrong = await runTool(createSemanticResolveTool(), proposal(operations), request);
    expect(wrong.details.status, JSON.stringify(wrong.details.issues)).toBe("ready");
    expect(wrong.details.issues).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  }
  const corrected = await runTool(createSemanticResolveTool(), proposal([...fields], {kind: "reference", task_ref: previous.ref, target_ref: previous.steps[0]!.targetRef}), request);
  expect(corrected.details.status, JSON.stringify(corrected.details.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.details.state.task_ref, target_ref: corrected.details.state.targets[0].target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["SYNTH_M:D"], org_codes: ["SYNTH_O1"], time: {start: "2026-05-31", end: "2026-05-31"}});
  expect(python({action: "query", spec: f.backend.basicQueries.mock.calls[0]?.[0]}).rows).toHaveLength(1);
  expect(await request.semanticTasks!.plan(previous.ref)).toEqual(previous);
  expect(await request.semanticTasks!.get(previousTask.ref)).toEqual(previousTask);
}, 30000);
it("真实Python把非机构名纠正为正式机构时，来源守卫仍保守拒绝推断续补", async () => {
  const f = await setup(), initial = f.request("negative-source-initial", "帮我查经营收益金额当日数");
  const first = await new SemanticPlanService(initial).resolve(proposal([{action: "set", field: "metrics", value: "经营收益金额当日数"}]));
  expect(first.status).toBe("needs_user");
  const previous = (await initial.semanticTasks!.plan(first.state.task_ref!))!;
  const request = f.request("negative-source", "机构非合成机构甲，日期是2025年末");
  const turn = await request.semanticTasks!.admit(request.operationId, request.originalMessage);
  const facts = await request.backend.inspectBusinessGoal(request.originalMessage, turn.businessDate);
  const resolution = await request.backend.resolveBusinessField("organization", ["非合成机构甲"]);
  expect(resolution).toMatchObject({status: "resolved", value: {codes: ["SYNTH_O1"]}, metadata: {resolution_source: "corrected"}});
  expect(facts.fragments.flatMap(fragment => fragment.organizations)).toContain("SYNTH_O1");
  const input = proposal([{action: "set", field: "organizations", value: "合成机构甲"}, {action: "set", field: "time", value: "2025年末"}]);
  const before = structuredClone({input, turn});
  expect(await pendingCompletionSource(request, input, turn, facts)).toBeUndefined();
  expect({input, turn}).toEqual(before);
  expect((await request.semanticTasks!.planIndex()).operations[request.operationId]).toBeUndefined();
  expect(await request.semanticTasks!.plan(previous.ref)).toEqual(previous);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
}, 15000);
it("真实目录解析补全模型遗漏的已明确指标口径，编译请求通过后端来源校验和SQL", async () => {
  const f = await setup(), request = f.request("exact", "查询合成机构甲2026年5月31日的经营收益金额当日数");
  const result = await new SemanticTaskService(request).resolve(proposal(base.map(operation => operation.field === "metrics" ? {...operation, value: "经营收益金额"} : operation)));
  expect(result.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.task!.ref, target_ref: result.task!.target.ref}, request);
  expect(python({action: "query", spec: f.backend.basicQueries.mock.calls[0]![0]}).rows).toHaveLength(1);
}, 15000);
it("多成员名称通过一对一目录身份对齐，保留原句完整口径且不新增指标", async () => {
  const f = await setup(), request = f.request("multiple-basis", "查询合成机构甲2026年5月31日的经营收益金额当日数和经营收益金额较同期");
  const result = await new SemanticTaskService(request).resolve(proposal(base.map(op => op.field === "metrics" ? {...op, value: "经营收益金额，经营收益金额较同期"} : op)));
  expect({status:result.status,issues:result.task?.issues}).toEqual({status:"ready",issues:[]});
  expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes:["SYNTH_M:D","SYNTH_M:Y"]});
}, 15000);
it("唯一待补任务由Pi明确选择current续补日期，沿用正式指标身份", async () => {
  const f = await setup(), source = f.request("without-date", "查询合成机构甲的经营收益金额当日数");
  const first = await new SemanticPlanService(source).resolve(proposal(base.filter(op=>op.field!=="time")));
  expect(first.status).toBe("needs_user");
  const previous = (await source.semanticTasks!.plan(first.state.task_ref!))!;
  const previousTask = await source.semanticTasks!.get(previous.steps[0]!.taskRef!);
  const request = f.request("date-only", "2026年5月31日"),service = new SemanticPlanService(request);
  const next = await service.resolve(proposal([{action: "set", field: "time", value: "2026年5月31日"}], {kind: "current"}));
  expect(next.status, JSON.stringify(next.issues)).toBe("ready"); expect(next.state.task_ref).not.toBe(first.state.task_ref);
  expect((await request.semanticTasks!.planIndex()).focus).toBe(next.state.task_ref);
  expect(await request.semanticTasks!.plan(first.state.task_ref!)).toEqual(previous);
  expect(await request.semanticTasks!.get(previous.steps[0]!.taskRef!)).toEqual(previousTask);
  const nextPlan = (await request.semanticTasks!.plan(next.state.task_ref!))!, nextTask = (await request.semanticTasks!.get(nextPlan.steps[0]!.taskRef!))!;
  expect(nextPlan.steps[0]!.source).toEqual({kind: "current"});
  expect(nextTask.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["SYNTH_M:D"]});
  expect(nextTask.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["SYNTH_O1"]});
  await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const spec = f.backend.basicQueries.mock.calls[0]![0];
  expect(spec).toMatchObject({metric_codes: ["SYNTH_M:D"], org_codes: ["SYNTH_O1"], time: {start: "2026-05-31", end: "2026-05-31"}});
  expect(f.invoke({action: "query", spec}).rows).toHaveLength(1);
}, 20000);
it("真实目录的连续current续补保留已确认指标口径，机构日期齐备后执行", async () => {
  const f = await setup(), initial = f.request("metric-only", "查询经营收益金额当日数");
  const first = await new SemanticPlanService(initial).resolve(proposal([
    {action: "set", field: "metrics", value: "经营收益金额当日数"},
  ]));
  expect(first.status).toBe("needs_user");
  const previous = (await initial.semanticTasks!.plan(first.state.task_ref!))!;
  const previousTask = await initial.semanticTasks!.get(previous.steps[0]!.taskRef!);
  const organization = await new SemanticPlanService(f.request("organization-only", "机构用合成机构甲")).resolve(proposal([
    {action: "set", field: "organizations", value: "合成机构甲"},
  ], {kind: "current"}));
  expect(organization.status).toBe("needs_user"); expect(organization.state.task_ref).not.toBe(first.state.task_ref);
  expect(organization.issues.map(issue => issue.field)).toEqual(["time"]);
  const withOrganization = (await initial.semanticTasks!.plan(organization.state.task_ref!))!;
  const organizationTask = await initial.semanticTasks!.get(withOrganization.steps[0]!.taskRef!);
  const request = f.request("calendar-only", "日期用2026年5月31日"), next = await new SemanticPlanService(request).resolve(proposal([
    {action: "set", field: "time", value: "2026年5月31日"},
  ], {kind: "current"}));
  expect({status: next.status, issues: next.issues}, JSON.stringify(next.issues)).toEqual({status: "ready", issues: []});
  expect(next.state.task_ref).not.toBe(organization.state.task_ref);
  expect(next.state.task_ref).not.toBe(first.state.task_ref);
  expect(await request.semanticTasks!.plan(first.state.task_ref!)).toEqual(previous);
  expect(await request.semanticTasks!.get(previous.steps[0]!.taskRef!)).toEqual(previousTask);
  expect(await request.semanticTasks!.plan(organization.state.task_ref!)).toEqual(withOrganization);
  expect(await request.semanticTasks!.get(withOrganization.steps[0]!.taskRef!)).toEqual(organizationTask);
  expect((await request.semanticTasks!.planIndex()).focus).toBe(next.state.task_ref);
  await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
  const spec = f.backend.basicQueries.mock.calls[0]![0];
  expect(spec).toMatchObject({metric_codes: ["SYNTH_M:D"], org_codes: ["SYNTH_O1"], time: {start: "2026-05-31"}});
  expect(python({action: "query", spec}).rows).toHaveLength(1);
}, 30000);
it.each(["prepared", "succeeded"])("旧目标%s时，Pi明确引用同一来源派生两个新指标，旧计划和Frame保留", async previousStatus => {
  const f = await setup("missing-conditions-fixture.py"), original = f.request("previous-metric", "查询合成机构乙2026年6月30日的经营收益金额当日数");
  const previous = await new SemanticPlanService(original).resolve(proposal(base.map(op => op.field === "organizations" ? {...op, value: "合成机构乙"}
    : op.field === "time" ? {...op, value: "2026年6月30日"} : op), {kind: "new"}, previousStatus === "prepared" ? "prepare" : "query"));
  if (previousStatus === "succeeded") await runTool(createSemanticExecuteTool(), {task_ref: previous.state.task_ref, target_ref: previous.state.targets[0]!.target_ref}, original);
  const before = await original.semanticTasks!.plan(previous.state.task_ref!), frames = await original.frames!.state();
  const snapshots = await Promise.all(frames.frameOrder.map(id => original.frames!.get(id)));
  f.backend.basicQueries.mockClear();
  const request = f.request("multiple-after-context", "分别查询对公协定存款余额当日数和经营收益金额较同期"), service = new SemanticPlanService(request);
  const source = {kind: "reference" as const, task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref};
  const corrected = proposal([{action: "set", field: "metrics", value: "对公协定存款余额当日数"}], source);
  corrected.targets.push({source, operations: [{action: "set", field: "metrics", value: "经营收益金额较同期"}]});
  const next = await service.resolve(corrected);
  expect({status: next.status, issues: next.issues}).toEqual({status: "ready", issues: []});
  expect(next.state.targets).toHaveLength(2);
  for (const target of next.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: target.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  const specs = f.backend.basicQueries.mock.calls.map(call => call[0]) as Array<{metric_codes: string[]; org_codes: string[]; time: {start: string; end: string}}>;
  expect(specs.map(spec => spec.metric_codes)).toEqual([["SYNTH_DEPOSIT:D"], ["SYNTH_M:Y"]]);
  for (const spec of specs) {
    expect(spec).toMatchObject({org_codes: ["SYNTH_O2"], time: {start: "2026-06-30", end: "2026-06-30"}});
    f.invoke({action: "query", spec});
  }
  expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(before);
  expect(await Promise.all(frames.frameOrder.map(id => request.frames!.get(id)))).toEqual(snapshots);
}, 40000);
// 统一入口对照本轮原句并拦截义务遗漏或错绑。
it("原句两项指标而提案一项时构造完整状态，不产生修复轮次", async () => {
  const f = await setup("missing-conditions-fixture.py"), original = f.request("context-start", "准备合成机构乙2026年6月30日的经营收益金额当日数查询条件");
  const previous = await new SemanticPlanService(original).resolve(proposal(base.map(op => op.field === "organizations" ? {...op, value: "合成机构乙"}
    : op.field === "time" ? {...op, value: "2026年6月30日"} : op), {kind: "new"}, "prepare"));
  const source = {kind: "reference" as const, task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref};
  const request = f.request("repair-half", "分别查询对公协定存款余额当日数和经营收益金额较同期"), service = new SemanticPlanService(request);
  const incomplete = await service.resolve(proposal([{action: "set", field: "metrics", value: "对公协定存款余额当日数"}], source));
  expect(incomplete.status).toBe("ready"); expect(incomplete.issues).toEqual([]); expect(f.backend.basicQueries).not.toHaveBeenCalled();
}, 30000);
it("同轮修复始终使用Pi明确引用的起始来源，焦点移动不能补隐式默认值", async () => {
  const f = await setup("missing-conditions-fixture.py"), original = f.request("context-start", "准备合成机构乙2026年6月30日的经营收益金额当日数查询条件");
  const previous = await new SemanticPlanService(original).resolve(proposal(base.map(op => op.field === "organizations" ? {...op, value: "合成机构乙"}
    : op.field === "time" ? {...op, value: "2026年6月30日"} : op), {kind: "new"}, "prepare"));
  const source = {kind: "reference" as const, task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref};
  const request = f.request("repair-with-snapshot", "分别查询对公协定存款余额当日数和经营收益金额较同期"), service = new SemanticPlanService(request);
  const incomplete = await service.resolve(proposal([{action: "set", field: "metrics", value: "对公协定存款余额当日数"}], source));
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect((await request.semanticTasks!.turn(request.operationId))!.context!.plan!.ref).toBe(previous.state.task_ref);
  const unrelated = await new SemanticPlanService(f.request("other-draft", "另起一个查询，查经营收益金额较同期")).resolve(proposal([{action: "set", field: "metrics", value: "经营收益金额较同期"}]));
  expect(unrelated.status).toBe("needs_user");
  expect(unrelated.issues.map(issue => issue.field).sort()).toEqual(["organizations", "time"]);
  const corrected = proposal([{action: "set", field: "metrics", value: "对公协定存款余额当日数"}], source);
  corrected.targets.push({source, operations: [{action: "set", field: "metrics", value: "经营收益金额较同期"}]});
  const next = await service.resolve(corrected);
  expect({status: next.status, issues: next.issues}).toEqual({status: "ready", issues: []});
  for (const target of next.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: target.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  for (const [spec] of f.backend.basicQueries.mock.calls) {expect(spec).toMatchObject({org_codes: ["SYNTH_O2"], time: {start: "2026-06-30"}}); f.invoke({action: "query", spec});}
}, 40000);
// 统一入口对照本轮原句并拦截义务遗漏或错绑。
it("原句明确新机构日期时，空提案自动应用本轮条件", async () => {
  const f = await setup(), previousRequest = f.request("old-succeeded-scope", "查询合成机构甲2026年5月31日的经营收益金额当日数");
  const previous = await new SemanticPlanService(previousRequest).resolve(proposal([...base]));
  await runTool(createSemanticExecuteTool(), {task_ref: previous.state.task_ref, target_ref: previous.state.targets[0]!.target_ref}, previousRequest);
  f.backend.basicQueries.mockClear();
  const source = {kind: "reference" as const, task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref};
  const request = f.request("changed-scope", "查询合成机构乙2026年6月30日的经营收益金额当日数"), service = new SemanticPlanService(request);
  const incomplete = await service.resolve(proposal([], source));
  expect(incomplete.status).toBe("ready"); expect(incomplete.issues).toEqual([]); expect(f.backend.basicQueries).not.toHaveBeenCalled();
}, 30000);
it("同指标旧成功目标按本轮机构日期修正提案后执行新范围，旧计划不变", async () => {
  const f = await setup(), previousRequest = f.request("old-succeeded-scope", "查询合成机构甲2026年5月31日的经营收益金额当日数");
  const previous = await new SemanticPlanService(previousRequest).resolve(proposal([...base]));
  await runTool(createSemanticExecuteTool(), {task_ref: previous.state.task_ref, target_ref: previous.state.targets[0]!.target_ref}, previousRequest);
  const before = await previousRequest.semanticTasks!.plan(previous.state.task_ref!);
  f.backend.basicQueries.mockClear();
  const source = {kind: "reference" as const, task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref};
  const request = f.request("changed-scope", "查询合成机构乙2026年6月30日的经营收益金额当日数"), service = new SemanticPlanService(request);
  await service.resolve(proposal([], source));
  expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(before);
  const next = await service.resolve(proposal([
    {action: "set", field: "organizations", value: "合成机构乙"}, {action: "set", field: "time", value: "2026年6月30日"},
  ], source));
  expect({status: next.status, issues: next.issues}).toEqual({status: "ready", issues: []});
  await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: next.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["SYNTH_M:D"], org_codes: ["SYNTH_O2"], time: {start: "2026-06-30"}});
  f.invoke({action: "query", spec: f.backend.basicQueries.mock.calls[0]![0]});
}, 30000);
it("真实目录允许Pi为不同目标明确选择current与new，新目标自行提供完整条件且不污染旧查询", async () => {
  const f = await setup("missing-conditions-fixture.py"), original = f.request("before-current-new", "准备合成机构乙2026年6月30日的经营收益金额当日数查询条件");
  const previous = await new SemanticPlanService(original).resolve(proposal(base.map(op => op.field === "organizations" ? {...op, value: "合成机构乙"}
    : op.field === "time" ? {...op, value: "2026年6月30日"} : op), {kind: "new"}, "prepare"));
  const before = await original.semanticTasks!.plan(previous.state.task_ref!);
  const request = f.request("mixed-current-new", "以刚才的查询为基础改查对公协定存款余额当日数；另外查询合成机构乙2026年6月30日的经营收益金额较同期");
  const first = proposal([{action: "set", field: "metrics", value: "对公协定存款余额当日数"}], {kind: "current"});
  first.targets.push({source: {kind: "new"}, operations: [
    {action: "set", field: "organizations", value: "合成机构乙"}, {action: "set", field: "metrics", value: "经营收益金额较同期"},
    {action: "set", field: "time", value: "2026年6月30日"},
  ]});
  const next = await new SemanticPlanService(request).resolve(first);
  expect({status: next.status, issues: next.issues}, JSON.stringify(next.issues)).toEqual({status: "ready", issues: []}); expect(next.state.targets).toHaveLength(2);
  expect(next.state.task_ref).not.toBe(previous.state.task_ref);
  for (const target of next.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: next.state.task_ref, target_ref: target.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  expect(f.backend.basicQueries.mock.calls.map(call => (call[0] as {metric_codes: string[]}).metric_codes)).toEqual([["SYNTH_DEPOSIT:D"], ["SYNTH_M:Y"]]);
  for (const [spec] of f.backend.basicQueries.mock.calls) {expect(spec).toMatchObject({org_codes: ["SYNTH_O2"], time: {start: "2026-06-30"}}); f.invoke({action: "query", spec});}
  expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(before);
}, 40000);
// 统一入口对照本轮原句并拦截义务遗漏或错绑。
it("current空操作自动绑定本轮明确的新指标，历史条件保持不变", async () => {
  const f = await setup("missing-conditions-fixture.py"), original = f.request("before-missing-metric", "准备合成机构甲2026年5月31日的经营收益金额当日数查询条件");
  const previous = await new SemanticPlanService(original).resolve(proposal([...base], {kind: "new"}, "prepare"));
  const before = await original.semanticTasks!.plan(previous.state.task_ref!);
  const frameState = await original.frames!.state(), frames = await Promise.all(frameState.frameOrder.map(id => original.frames!.get(id)));
  const request = f.request("missing-new-metric", "改查对公协定存款余额当日数"), result = await new SemanticPlanService(request).resolve(proposal([], {kind: "current"}));
  expect(result.status).toBe("ready"); expect(result.issues).toEqual([]); expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const nextPlan = (await request.semanticTasks!.plan(result.state.task_ref!))!, nextTask = (await request.semanticTasks!.get(nextPlan.steps[0]!.taskRef!))!;
  expect(nextTask.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["SYNTH_DEPOSIT:D"]});
  const after = (await request.semanticTasks!.plan(previous.state.task_ref!))!;
  expect((await request.semanticTasks!.get(after.steps[0]!.taskRef!))!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["SYNTH_M:D"]});
  expect(await Promise.all(frameState.frameOrder.map(id => request.frames!.get(id)))).toEqual(frames);
  expect(after.steps).toHaveLength(before!.steps.length);
}, 20000);
it("真实目录按既有高置信纠错确定身份并编译正式查询条件", async () => {
  const f = await setup();
  const first = await new SemanticTaskService(f.request("typo", "查询合成机构甲2026年5月31日的经营收益金融当日数")).resolve(proposal(base.map(operation =>
    operation.field === "metrics" ? {...operation, value: "经营收益金额"} : operation)));
  expect(first.status).toBe("ready");
  // 完整基础名称精确且唯一命中、仅省略口径时默认该基础唯一的“当日数”成员，不再追问口径（修复①默认口径）。
  const request = f.request("explicit", "查询合成机构甲2026年5月31日的经营收益金额");
  const resolvedDefault = await new SemanticTaskService(request).resolve(proposal([...base]));
  expect(resolvedDefault.status, JSON.stringify(resolvedDefault.issues)).toBe("ready");
  expect(resolvedDefault.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["SYNTH_M:D"]});
  await runTool(createSemanticExecuteTool(), {task_ref: resolvedDefault.task!.ref, target_ref: resolvedDefault.task!.target.ref}, request);
  expect(python({action: "query", spec: f.backend.basicQueries.mock.calls[0]![0]}).rows).toHaveLength(1);
}, 15000);
it("真实相对年遵循当前默认滚动口径，保留完整年度备选及全部数据点方式", async () => {
  const f = await setup();
  const first = await new SemanticTaskService(f.request("years", "查询合成机构甲近5年的经营收益金额当日数全部数据")).resolve(proposal([
    ...base.filter(operation => operation.field !== "time"), {action: "set", field: "time", value: "近5年"}, {action: "set", field: "selection", value: "全部数据"},
  ]));
  expect(first.status).toBe("ready");
  const businessDate=String(first.task!.target.fields.time!.metadata?.businessDate);
  expect(first.task!.target.fields.time!.resolvedValue).toEqual({start:`${Number(businessDate.slice(0,4))-5}${businessDate.slice(4)}`,end:businessDate});
  expect(first.task!.target.fields.time!.metadata?.timeAlternative).toEqual({label:"最近5个完整年度",start:"2021-01-01",end:"2025-12-31"});
  expect(first.task!.target.fields.selection!.resolvedValue).toBe("all_in_range");
}, 15000);
it("指标片段误填日期直接澄清真正缺少的日期，不进入日期修复循环", async () => {
  const f = await setup();
  const first = await new SemanticTaskService(f.request("missing", "查询合成机构甲的经营收益金额当日数")).resolve(proposal(base.map(operation =>
    operation.field === "time" ? {...operation, value: "当日数"} : operation)));
  expect(first.status).toBe("needs_user");
  expect(first.task!.issues.map(issue => issue.code)).toEqual(["FIELD_REQUIRED"]);
  expect(first.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["SYNTH_M:D"]});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
}, 15000);

it("待修提案改为双查询时按步骤类型绑定，保留两笔日期及算式", async () => {
  const f = await setup(), request = f.request("split-repair", "查询合成机构甲2026年5月31日与2026年6月30日的经营收益金额当日数，计算六月减五月的差额");
  const service = new SemanticPlanService(request);
  const first = proposal([...base.filter(op => op.field !== "time"), {action: "set", field: "time", value: "2026年5月31日与2026年6月30日"}, {action: "set", field: "selection", value: "当日数"}], {kind: "new"}, "calculate");
  first.targets.push({source: {kind: "new"}, operations: [{action: "set", field: "calculation", value: '`2026年6月30日经营收益金额当日数` - `2026年5月31日经营收益金额当日数`'}]});
  const pending = await service.resolve(first); expect(pending.status).toBe("needs_interpretation");
  const next = proposal(base.map(op => op.field === "metrics" ? {...op, value: "经营收益"} : op), {kind: "new"}, "calculate");
  next.targets.push({source: {kind: "new"}, operations: base.map(op => op.field === "time" ? {...op, value: "2026年6月30日"} : op)}, first.targets[1]!);
  const ready = await service.resolve(next);
  expect({status: ready.status, issues: ready.issues}).toEqual({status: "ready", issues: []});
  const plan = (await request.semanticTasks!.plan(ready.state.task_ref!))!;
  expect(plan.steps.filter(step => step.kind === "query")).toHaveLength(2);
  expect(plan.steps.filter(step => step.kind === "calculation")).toHaveLength(1);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  for (const target of ready.state.targets.filter(target => target.kind === "query")) await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: target.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
  for (const [spec] of f.backend.basicQueries.mock.calls) expect(python({action: "query", spec}).rows).toHaveLength(1);
}, 25000);
it("历史来源可派生两个独立日期目标，原任务不被覆盖", async () => {
  const f = await setup(), original = f.request("history-base", "查询合成机构甲2026年5月31日的经营收益金额当日数");
  const first = await new SemanticPlanService(original).resolve(proposal([...base], {kind: "new"}, "prepare"));
  expect(first.status).toBe("prepared");
  const source = {kind: "reference" as const, task_ref: first.state.task_ref!, target_ref: first.state.targets[0]!.target_ref};
  const request = f.request("history-split", "查询2026年5月31日与2026年6月30日的原指标");
  const input = proposal([{action: "set", field: "time", value: "2026年5月31日"}], source);
  input.targets.push({source, operations: [{action: "set", field: "time", value: "2026年6月30日"}]});
  const result = await new SemanticPlanService(request).resolve(input);
  expect({status: result.status, issues: result.issues}).toEqual({status: "ready", issues: []});
  expect(new Set((await request.semanticTasks!.plan(result.state.task_ref!))!.steps.map(step => step.id)).size).toBe(2);
  expect((await request.semanticTasks!.plan(first.state.task_ref!))!.steps[0]!.targetRef).toBe(source.target_ref);
}, 25000);
it("年份省略的历史追问沿用已绑定来源年份", async () => {
  const f = await setup(), request = f.request("year-base", "查询合成机构甲2025年5月31日的经营收益金额当日数");
  const first = await new SemanticPlanService(request).resolve(proposal(base.map(op => op.field === "time" ? {...op, value: "2025年5月31日"} : op), {kind: "new"}, "prepare"));
  expect(first.status).toBe("prepared");
  const followup = f.request("year-followup", "日期换成6月30日");
  const result = await new SemanticPlanService(followup).resolve(proposal([{action: "set", field: "time", value: "6月30日"}], {kind: "current"}));
  expect({status: result.status, issues: result.issues}).toEqual({status: "ready", issues: []});
  const plan = (await followup.semanticTasks!.plan(result.state.task_ref!))!, task = (await followup.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  expect(task.target.fields.time!.resolvedValue).toEqual({start: "2025-06-30", end: "2025-06-30"});
}, 15000);
it("指标口径缩写误放selection时由同一目录解析器重建身份，不能向用户追问已明确口径", async () => {
  const f = await setup(), request = f.request("basis-placement", "分析合成机构甲2026年5月31日的经营收益金额当日数与经营收益金额较同期，先查询当日数，拿到结果后继续较同期");
  const input = proposal(base.map(op => op.field === "metrics" ? {...op, value: "经营收益金额"} : op), {kind: "new"}, "analyze");
  input.targets[0]!.operations.push({action: "set", field: "selection", value: "当日"});
  const result = await new SemanticPlanService(request).resolve(input);
  expect({status: result.status, issues: result.issues}).toEqual({status: "ready", issues: []});
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!, task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  expect(task.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["SYNTH_M:D"]});
}, 15000);


// 排名总体校验：拆分同一榜单为逐机构目标的提案被拦截，未执行的草案可被完整新提案重组。
it("模型拆错同一榜单可重组未执行草案，旧草案保留且不可单独执行", async () => {
  const f = await setup(), request = f.request("rank-regroup", "合成机构甲和合成机构乙2026年5月31日的经营收益金额当日数，前1名");
  const service = new SemanticPlanService(request), wrong = proposal([...base]);
  wrong.targets.push({source: {kind: "new"}, operations: base.map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op)});
  const blocked = await service.resolve(wrong);
  expect(blocked.status).toBe("needs_interpretation");
  const old = blocked.state.targets[1]!.target_ref;
  const merged = await service.resolve(proposal(base.map(op => op.field === "organizations" ? {...op, value: "合成机构甲和合成机构乙"} : op)));
  expect({status: merged.status, issues: merged.issues}).toEqual({status: "ready", issues: []});
  const plan = (await request.semanticTasks!.plan(merged.state.task_ref!))!;
  expect(plan.steps).toHaveLength(1); expect(plan.supersededSteps).toHaveLength(1);
  await expect(service.locate(plan.ref, old)).rejects.toMatchObject({issue: {code: "REFERENCE_INVALID"}});
  await runTool(createSemanticExecuteTool(), {task_ref: plan.ref, target_ref: merged.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({org_codes: ["SYNTH_O1", "SYNTH_O2"], operation: {kind: "ranking", top_n: 1}});
}, 20000);

it("离散日期的分析按各步骤执行结果完成，不要求单个来源包含全部日期", async () => {
  const f = await setup(), request = f.request("analysis-dates", "分析合成机构甲2026年5月31日与2026年6月30日的经营收益金额当日数");
  const service = new SemanticPlanService(request), input = proposal([...base], {kind: "new"}, "analyze");
  input.targets.push({source: {kind: "new"}, operations: base.map(op => op.field === "time" ? {...op, value: "2026年6月30日"} : op)});
  const ready = await service.resolve(input); expect(ready.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, request);
  const partial = (await request.semanticTasks!.plan(ready.state.task_ref!))!;
  expect(partial.completion).toBe("partial"); expect(partial.issues).toEqual([]);
  expect(partial.steps.filter(step => step.status !== "succeeded")).toHaveLength(1);
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[1]!.target_ref}, request);
  const full = (await request.semanticTasks!.plan(ready.state.task_ref!))!;
  expect(full.completion).toBe("full"); expect(full.issues).toEqual([]);
}, 20000);

it("完整原句已经确定机构身份，模型缩写不制造新的用户确认", async () => {
  const f=await setup(),request=f.request("org-abbreviation","查询合成机构丙2026年5月30日的经营收益金额当日数");
  const input=proposal(base.map(op=>op.field==="organizations"?{...op,value:"丙"}:op.field==="time"?{...op,value:"2026年5月30日"}:op));
  const ready=await new SemanticPlanService(request).resolve(input);
  expect({status:ready.status,issues:ready.issues}).toEqual({status:"ready",issues:[]});
  await runTool(createSemanticExecuteTool(),{task_ref:ready.state.task_ref,target_ref:ready.state.targets[0]!.target_ref},request);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({org_codes:["SYNTH_O3"]});
  expect(python({action:"query",spec:f.backend.basicQueries.mock.calls[0]![0]}).rows[0].metric_value).toBe(40);
},15000);

it("仅修改日期时，模型重复陈述相同的已绑定机构不会要求用户重述机构", async () => {
  const f=await setup(),firstRequest=f.request("same-org-base","查询合成机构甲2026年5月31日的经营收益金额当日数");
  await new SemanticPlanService(firstRequest).resolve(proposal([...base],{kind:"new"},"prepare"));
  const request=f.request("same-org-date","日期改成2026年6月30日，其他条件不变");
  const ready=await new SemanticPlanService(request).resolve(proposal([{action:"set",field:"organizations",value:"合成机构甲"},{action:"set",field:"time",value:"2026年6月30日"}],{kind:"current"}));
  expect({status:ready.status,issues:ready.issues}).toEqual({status:"ready",issues:[]});
},15000);


it("跨机构计算分别绑定标量来源，最终结果使用两笔正式查询事实",async()=>{
 const f=await setup(),b=createSyntheticBackend(),request={...f.request("cross-org-calculation","查询合成机构甲和合成机构丙2026年5月30日的经营收益金额当日数，计算丙减甲的差额"),backend:b.client};
 const source=(org:string,label:string)=>[...base.map(op=>op.field==="organizations"?{...op,value:org}:op.field==="time"?{...op,value:"2026年5月30日"}:op),{action:"set" as const,field:"objective" as const,value:label}];
 const input=proposal(source("合成机构甲","甲项"),{kind:"new"},"calculate");
 input.targets.push({source:{kind:"new"},operations:source("合成机构丙","丙项")},{source:{kind:"new"},operations:[{action:"set",field:"calculation",value:"`丙项` - `甲项`"}]});
 const ready=await new SemanticPlanService(request).resolve(input);expect({status:ready.status,issues:ready.issues}).toEqual({status:"ready",issues:[]});
 let final:any;for(const target of ready.state.targets)final=await runTool(createSemanticExecuteTool(),{task_ref:ready.state.task_ref,target_ref:target.target_ref},request);
 expect(b.queries).toHaveLength(2);expect(final.details.status).toBe("succeeded");
 expect(final.details.state.evidence.results[0].value).toBe("10");
},25000);
it("多目标签发的正式来源跨轮计算仍有效且不重查",async()=>{
 const f=await setup(),b=createSyntheticBackend(),request={...f.request("signed-queries","分别查询合成机构甲2026年5月31日与合成机构丙2026年6月30日的经营收益金额当日数"),backend:b.client};
 const input=proposal([...base]);
 input.targets.push({source:{kind:"new"},operations:base.map(op=>op.field==="organizations"?{...op,value:"合成机构丙"}:op.field==="time"?{...op,value:"2026年6月30日"}:op)});
 const ready=await new SemanticPlanService(request).resolve(input);expect(ready.status).toBe("ready");
 for(const target of ready.state.targets)await runTool(createSemanticExecuteTool(),{task_ref:ready.state.task_ref,target_ref:target.target_ref},request);
 const next={...f.request("signed-calc","用刚才的正式结果计算丙减甲，不重新查询"),backend:b.client};
 const calc=proposal([{action:"set",field:"objective",value:"甲项"}],{kind:"reference",task_ref:ready.state.task_ref!,target_ref:ready.state.targets[0]!.target_ref},"calculate");
 calc.targets.push({source:{kind:"reference",task_ref:ready.state.task_ref!,target_ref:ready.state.targets[1]!.target_ref},operations:[{action:"set",field:"objective",value:"丙项"}]},
 {source:{kind:"new"},operations:[{action:"set",field:"calculation",value:"`丙项` - `甲项`"}]});
 const permitted=await new SemanticPlanService(next).resolve(calc);expect({status:permitted.status,issues:permitted.issues}).toEqual({status:"ready",issues:[]});
 const target=permitted.state.targets.find(x=>x.kind==="calculation")!;
 const result=await runTool(createSemanticExecuteTool(),{task_ref:permitted.state.task_ref,target_ref:target.target_ref},next);
 expect(result.details.status).toBe("succeeded");expect(b.queries).toHaveLength(2);
 const oldSource={kind:"reference" as const,task_ref:ready.state.task_ref!,target_ref:ready.state.targets[0]!.target_ref};
 const again=await new SemanticPlanService({...f.request("original-ref-reuse","重显合成机构甲的原始结果"),backend:b.client}).resolve(proposal([],oldSource,"reuse"));
 expect(again.status).toBe("reused");expect(b.queries).toHaveLength(2);
},40000);

it("真实Python贯通集合增删改及机构日期续问，每轮执行范围正确且历史Frame和结果不变", async () => {
  const f = await setup("missing-conditions-fixture.py");
  const history = new Map<string, unknown>();
  const plans = new Map<string, unknown>();
  const names: Record<string, string> = {"SYNTH_M:D": "经营收益金额当日数", "SYNTH_DEPOSIT:D": "对公协定存款余额当日数", "SYNTH_M:Y": "经营收益金额较同期"};
  const initial = {message: "查询合成机构甲2026年5月31日的经营收益金额当日数", operations: [...base], metrics: ["SYNTH_M:D"], org: "SYNTH_O1", day: "2026-05-31"};
  const turns = [
    {message: "保留经营收益金额当日数，另外加上对公协定存款余额当日数", operations: [{action: "add", field: "metrics", value: "对公协定存款余额当日数"}], metrics: ["SYNTH_M:D", "SYNTH_DEPOSIT:D"], org: "SYNTH_O1", day: "2026-05-31"},
    {message: "不再查询经营收益金额当日数，只保留对公协定存款余额当日数", operations: [{action: "exclude", field: "metrics", subject: "经营收益金额当日数"}], metrics: ["SYNTH_DEPOSIT:D"], org: "SYNTH_O1", day: "2026-05-31"},
    {message: "把对公协定存款余额当日数换成经营收益金额较同期", operations: [{action: "replace", field: "metrics", subject: "对公协定存款余额当日数", value: "经营收益金额较同期"}], metrics: ["SYNTH_M:Y"], org: "SYNTH_O1", day: "2026-05-31"},
    {message: "合成机构乙呢？", operations: [{action: "set", field: "organizations", value: "合成机构乙"}], metrics: ["SYNTH_M:Y"], org: "SYNTH_O2", day: "2026-05-31"},
    {message: "日期移到2026年6月30日，其他条件不变", operations: [{action: "set", field: "time", value: "2026年6月30日"}], metrics: ["SYNTH_M:Y"], org: "SYNTH_O2", day: "2026-06-30"},
  ] as const;
  for (const [index, turn] of [initial, ...turns].entries()) {
    const request = f.request(`continuous-transition-${index}`, turn.message);
    const result = await new SemanticPlanService(request).resolve(proposal([...turn.operations], {kind: index ? "current" : "new"}));
    expect({status: result.status, issues: result.issues}).toEqual({status: "ready", issues: []});
    expect(result.state.targets).toHaveLength(1);
    const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
    const task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
    expect(plan.steps[0]!.source).toEqual({kind: index ? "current" : "new"});
    expect(result.state.targets[0]!.conditions.find(condition => condition.field === "metrics")!.display).toBe(turn.metrics.map(code => names[code]).join("、"));
    const runtime = await request.semanticTasks!.runtimeContext();
    expect(runtime.tasks).toHaveLength(1); expect(runtime.current_task_ref).toBe(plan.ref);
    expect(runtime.tasks[0]).toMatchObject({targets: [{conditions: {metrics: {expression: turn.metrics.map(code => names[code]).join("、")}}}]});
    if (index) {
      // 变更轨迹改为工作状态字段来源与原文：本轮修改字段来自当前轮次，其余字段为继承。
      const changedField = turn.operations[0]!.field;
      expect(task.target.fields[changedField]?.metadata?.semanticTurn).toBe(`${request.operationId}:${plan.steps[0]!.id}`);
    }
    const before = f.backend.basicQueries.mock.calls.length;
    const executed = await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(executed.details).toMatchObject({status: "succeeded"});
    expect(f.backend.basicQueries.mock.calls.length - before).toBe(1);
    const spec = f.backend.basicQueries.mock.calls.at(-1)![0];
    expect(spec).toMatchObject({metric_codes: [...turn.metrics], org_codes: [turn.org], time: {start: turn.day, end: turn.day}});
    expect((spec as Record<string, unknown>).source_semantic_receipt).toBeUndefined();
    expect(f.invoke({action: "query", spec}).rows).toHaveLength(turn.metrics.length);
    for (const [id, snapshot] of history) expect(await request.frames!.get(id)).toEqual(snapshot);
    for (const [ref, snapshot] of plans) expect(await request.semanticTasks!.plan(ref)).toEqual(snapshot);
    const state = await request.frames!.state();
    for (const id of state.frameOrder) history.set(id, await request.frames!.get(id));
    const settled = (await request.semanticTasks!.plan(result.state.task_ref!))!.steps[0]!.evidence;
    expect(settled?.resultRef).toEqual(expect.any(String));
    expect((await request.frames!.get(settled!.frameId))!.resultRef).toBe(settled!.resultRef);
    plans.set(plan.ref, await request.semanticTasks!.plan(plan.ref));
    expect((await request.semanticTasks!.planContext()).tasks.map(item => item.task_ref)).toEqual(expect.arrayContaining([...plans.keys()]));
  }
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(6);
}, 60000);

it("明确改查时直接续接已确认范围，原计划不被改写", async () => {
  const f = await setup("missing-conditions-fixture.py"), original = f.request("unbound-new-base", "准备合成机构甲2026年5月31日的经营收益金额当日数查询条件");
  const previous = await new SemanticPlanService(original).resolve(proposal([...base], {kind: "new"}, "prepare"));
  const previousPlan = await original.semanticTasks!.plan(previous.state.task_ref!);
  const request = f.request("unbound-new-followup", "改查对公协定存款余额当日数"), service = new SemanticPlanService(request);
  const normalized = await service.resolve(proposal(base.map(op => op.field === "metrics" ? {...op, value: "对公协定存款余额当日数"} : op)));
  expect(normalized.status).toBe("ready"); expect(normalized.issues).toEqual([]);
  expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(previousPlan);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const corrected = await service.resolve(proposal([{action: "set", field: "metrics", value: "对公协定存款余额当日数"}],
    {kind: "reference", task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref}));
  expect({status: corrected.status, issues: corrected.issues}).toEqual({status: "ready", issues: []});
  expect(corrected.state.task_ref).not.toBe(previous.state.task_ref);
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.state.task_ref, target_ref: corrected.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const spec = f.backend.basicQueries.mock.calls[0]![0];
  expect(spec).toMatchObject({metric_codes: ["SYNTH_DEPOSIT:D"], org_codes: ["SYNTH_O1"], time: {start: "2026-05-31", end: "2026-05-31"}});
  expect(f.invoke({action: "query", spec}).rows).toHaveLength(1);
  expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(previousPlan);
}, 30000);

it("无候选confirm由Pi修正且不污染focus，修正后完整双指标及历史Frame仍有效", async () => {
  const f = await setup("missing-conditions-fixture.py"), original = f.request("confirm-without-options-base", "查询合成机构甲2026年5月31日的经营收益金额当日数和对公协定存款余额当日数");
  const previous = await new SemanticPlanService(original).resolve(proposal(base.map(op => op.field === "metrics" ? {...op, value: "经营收益金额当日数、对公协定存款余额当日数"} : op)));
  expect(previous.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: previous.state.task_ref, target_ref: previous.state.targets[0]!.target_ref}, original);
  const previousPlan = await original.semanticTasks!.plan(previous.state.task_ref!);
  const state = await original.frames!.state(), snapshots = await Promise.all(state.frameOrder.map(id => original.frames!.get(id)));
  f.backend.basicQueries.mockClear();
  const request = f.request("confirm-without-options-followup", "不是让你去掉对公协定存款余额当日数，我要这两项继续一起查询"), service = new SemanticPlanService(request);
  const wrong = await service.resolve(proposal([{action: "confirm", field: "metrics", value: "对公协定存款余额当日数"}], {kind: "current"}));
  expect(wrong.status).toBe("needs_interpretation");
  expect(wrong.continuation.actor).toBe("pi");
  expect(wrong.issues).toEqual(expect.arrayContaining([expect.objectContaining({code: "CONFIRMATION_NOT_AVAILABLE", remediation: "pi"})]));
  expect(wrong.issues.some(issue => issue.remediation === "user")).toBe(false);
  expect((await request.semanticTasks!.planIndex()).focus).toBe(previous.state.task_ref);
  expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(previousPlan);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const corrected = await service.resolve(proposal([], {kind: "reference", task_ref: previous.state.task_ref!, target_ref: previous.state.targets[0]!.target_ref}));
  expect({status: corrected.status, issues: corrected.issues}).toEqual({status: "ready", issues: []});
  expect(corrected.state.targets[0]!.conditions.find(condition => condition.field === "metrics")!.display).toBe("经营收益金额当日数、对公协定存款余额当日数");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.state.task_ref, target_ref: corrected.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const spec = f.backend.basicQueries.mock.calls[0]![0];
  expect(spec).toMatchObject({metric_codes: ["SYNTH_M:D", "SYNTH_DEPOSIT:D"], org_codes: ["SYNTH_O1"], time: {start: "2026-05-31", end: "2026-05-31"}});
  expect(f.invoke({action: "query", spec}).rows).toHaveLength(2);
  expect(await request.semanticTasks!.plan(previous.state.task_ref!)).toEqual(previousPlan);
  expect(await Promise.all(state.frameOrder.map(id => request.frames!.get(id)))).toEqual(snapshots);
}, 40000);

it("连续机构追加的未决确认经真实Python解析保留已定成员与完整集合",async()=>{
 const f=await setup(),first=f.request('org-ledger-origin','查询合成机构甲2026年5月31日的经营收益金额当日数');
 const origin=await new SemanticPlanService(first).resolve(proposal([...base]));
 expect(origin.status,JSON.stringify(origin.issues)).toBe('ready');
 const oldPlan=await first.semanticTasks!.plan(origin.state.task_ref!);
 const pending=await new SemanticPlanService(f.request('org-ledger-pending','再追加合成机构乙和合成机构，其他条件不变')).resolve(proposal([
  {action:'add',field:'organizations',value:'合成机构乙'},{action:'add',field:'organizations',value:'合成机构'}],{kind:'current'}));
 expect(pending.status,JSON.stringify(pending.issues)).toBe('needs_user');
 const request=f.request('org-ledger-confirm','待确认那家用合成机构丙');
 const confirmed=await new SemanticPlanService(request).resolve(proposal([{action:'confirm',field:'organizations',value:'合成机构丙'}],{kind:'current'}));
 expect(confirmed.status,JSON.stringify(confirmed.issues)).toBe('ready');
 const plan=(await request.semanticTasks!.plan(confirmed.state.task_ref!))!,task=(await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
 expect((task.target.fields.organizations!.resolvedValue as {codes:string[]}).codes).toEqual(['SYNTH_O1','SYNTH_O2','SYNTH_O3']);
 // 变更轨迹改为工作状态：两家追加成员都在最终集合中，原目标计划不被改写。
 expect(task.target.fields.organizations!.rawValue).toBeTruthy();
 expect(await first.semanticTasks!.plan(origin.state.task_ref!)).toEqual(oldPlan);
 await runTool(createSemanticExecuteTool(),{task_ref:plan.ref,target_ref:plan.steps[0]!.targetRef},request);
 expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
 expect(python({action:'query',spec:f.backend.basicQueries.mock.calls[0]![0]}).rows).toHaveLength(3);
},30000);

it("首问多机构部分未决，确认后保留已定机构与完整结果",async()=>{
 const f=await setup();
 const pending=await new SemanticPlanService(f.request('org-partial-origin','查询合成机构甲和合成机构2026年5月31日的经营收益金额当日数')).resolve(proposal(base.map(op=>op.field==='organizations'?{...op,value:'合成机构甲、合成机构'}:op)));
 expect(pending.status,JSON.stringify(pending.issues)).toBe('needs_user');
 const request=f.request('org-partial-confirm','后一家用合成机构乙');
 const ready=await new SemanticPlanService(request).resolve(proposal([{action:'confirm',field:'organizations',value:'模型复述不作选择'}],{kind:'current'}));
 expect(ready.status,JSON.stringify(ready.issues)).toBe('ready');
 const plan=(await request.semanticTasks!.plan(ready.state.task_ref!))!,task=(await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
 expect((task.target.fields.organizations!.resolvedValue as {codes:string[]}).codes).toEqual(['SYNTH_O1','SYNTH_O2']);
 await runTool(createSemanticExecuteTool(),{task_ref:plan.ref,target_ref:plan.steps[0]!.targetRef},request);
 expect(python({action:'query',spec:f.backend.basicQueries.mock.calls[0]![0]}).rows).toHaveLength(2);
},30000);

// reference 续接派生新计划后，未重新解析的步骤仍引用 parentPlan 为源计划的 task；
// locate()/consume() 按步骤配对（taskRef+targetRef）与 permit digest 认可这种派生绑定。
it("多目标中只确认未决机构仍保留未执行的正确目标，整批签发后各执行一次",async()=>{
 const f=await setup(),original=f.request('org-group-pending','查询合成机构甲和合成机构2026年5月31日的经营收益金额当日数');
 const pending=await new SemanticPlanService(original).resolve({protocol_version:2,intent:'query',targets:[{source:{kind:'new'},operations:[...base]},
  {source:{kind:'new'},operations:base.map(op=>op.field==='organizations'?{...op,value:'合成机构'}:op)}]});
 expect(pending.status,JSON.stringify(pending.issues)).toBe('needs_user');
 const before=(await original.semanticTasks!.plan(pending.state.task_ref!))!;
 const request=f.request('org-group-confirm','待确认那家用合成机构乙');
 const ready=await new SemanticPlanService(request).resolve(proposal([{action:'confirm',field:'organizations',value:'合成机构乙'}],{kind:'reference',task_ref:before.ref,target_ref:before.steps[1]!.targetRef}));
 expect(ready.status,JSON.stringify(ready.issues)).toBe('ready');
 const plan=(await request.semanticTasks!.plan(ready.state.task_ref!))!;
 expect(plan.steps).toHaveLength(2);
 for(const step of plan.steps)await runTool(createSemanticExecuteTool(),{task_ref:plan.ref,target_ref:step.targetRef},request);
 expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
 expect(f.backend.basicQueries.mock.calls.map(call=>(call[0] as {org_codes:string[]}).org_codes)).toEqual([['SYNTH_O1'],['SYNTH_O2']]);
},30000);

it("模型只抄到区间起点时直接使用已绑定的完整日历，不缩短范围也不打回重提", async () => {
  const f = await setup(), request = f.request("range-prefix", "查询合成机构甲2026-05-01至2026-05-31的经营收益金额当日数全部已有记录");
  const ready = await new SemanticPlanService(request).resolve(proposal([
    ...base.filter(op => op.field !== "time"), {action: "set", field: "time", value: "2026-05-01"},
    {action: "set", field: "selection", value: "全部已有记录"},
  ]));
  expect(ready.status, JSON.stringify(ready.issues)).toBe("ready"); expect(ready.issues).toEqual([]);
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["SYNTH_M:D"], org_codes: ["SYNTH_O1"],
    time: {start: "2026-05-01", end: "2026-05-31"}, selection: "all_in_range"});
}, 15000);

it("尚未换算的完整区间不能缩为端点，沿用模型日历通道补齐后只执行完整范围", async () => {
  const f = await setup(), expression = "2026年5月1日至2026年5月31日";
  const request = f.request("unresolved-range-prefix", `查询合成机构甲${expression}的经营收益金额当日数全部已有记录`);
  const service = new SemanticPlanService(request), fields = [...base.filter(op => op.field !== "time"),
    {action: "set" as const, field: "selection" as const, value: "全部已有记录"}];
  const pending = await service.resolve(proposal([...fields, {action: "set", field: "time", value: "2026年5月1日"}]));
  expect(pending.status).toBe("needs_interpretation");
  expect(pending.issues).toContainEqual(expect.objectContaining({code: "TIME_EXPRESSION_UNSUPPORTED", field: "time"}));
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const ready = await service.resolve(proposal([...fields, {action: "set", field: "time", value: expression,
    modelCalendar: {start: "2026-05-01", end: "2026-05-31"}}]));
  expect(ready.status, JSON.stringify(ready.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["SYNTH_M:D"], org_codes: ["SYNTH_O1"],
    time: {start: "2026-05-01", end: "2026-05-31"}, selection: "all_in_range"});
}, 20000);

it("结构化日期误取指标中的当日口径时保留真实缺项，补齐后继承时间，明确换日期则重新待补", async () => {
  const f = await setup(), initialRequest = f.request("structured-missing-time", "查询合成机构甲的经营收益金额当日数");
  const input = proposal([]);
  input.targets[0]!.query = {organizations: {kind: "named", names: ["合成机构甲"]}, metrics: ["经营收益金额当日数"],
    time: {expression: "当日", calendar: {start: "2026-10-18", end: "2026-10-18"}}, selection: "exact", operation: {kind: "value"}};
  const pending = await new SemanticPlanService(initialRequest).resolve(input);
  expect(pending.status).toBe("needs_user");
  expect(pending.issues.map(issue => issue.field)).toEqual(["time"]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();

  const suppliedRequest = f.request("structured-supplied-time", "日期是2026年5月31日");
  const supplied = await new SemanticPlanService(suppliedRequest).resolve(proposal([{action: "set", field: "time", value: "2026年5月31日"}], {kind: "current"}));
  expect(supplied.status, JSON.stringify(supplied.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: supplied.state.task_ref, target_ref: supplied.state.targets[0]!.target_ref}, suppliedRequest);

  const inheritedRequest = f.request("structured-inherited-time", "指标改为经营收益金额较同期，其他条件不变");
  const inheritedInput = structuredClone(input); inheritedInput.targets[0]!.source = {kind: "current"};
  inheritedInput.targets[0]!.query!.metrics = ["经营收益金额较同期"];
  const inherited = await new SemanticPlanService(inheritedRequest).resolve(inheritedInput);
  expect(inherited.status, JSON.stringify(inherited.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: inherited.state.task_ref, target_ref: inherited.state.targets[0]!.target_ref}, inheritedRequest);
  expect(f.backend.basicQueries.mock.calls.map(call => call[0])).toMatchObject([
    {metric_codes: ["SYNTH_M:D"], time: {start: "2026-05-31", end: "2026-05-31"}},
    {metric_codes: ["SYNTH_M:Y"], time: {start: "2026-05-31", end: "2026-05-31"}},
  ]);
  const changedRequest = f.request("structured-change-missing-time", "换个日期");
  const changedInput = proposal([] , {kind: "current"});
  changedInput.targets[0]!.query = {...inheritedInput.targets[0]!.query!, organizations: null, metrics: null};
  const changed = await new SemanticPlanService(changedRequest).resolve(changedInput);
  expect(changed.status).toBe("needs_user");
  expect(changed.issues.map(issue => issue.field)).toEqual(["time"]);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
}, 30000);
