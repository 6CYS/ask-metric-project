import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {fixture, complete, proposal} from "./fixtures.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import type {SemanticOperation, SemanticSource} from "../../src/semantic-task/protocol.js";
import {pendingCompletionSource} from "../../src/semantic-task/sourceGuard.js";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {vi.spyOn(console, "info").mockImplementation(() => {});});
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
async function setup(completed = false) {
  const f = await fixture(); cleanup.push(f.close);
  const backend = f.backend, inspect = backend.inspectBusinessGoal.getMockImplementation()!;
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
  expect(await request.semanticTasks!.plan(f.plan.ref)).toEqual(f.plan);
});

it.each(["current", "reference"] as const)("唯一待补来源直接绑定，重复%s表达仍保存同一完整条件", async kind => {
  const f = await setup(), request = f.request("complete", "机构是合成机构甲，日期是2025年末，继续查询");
  for (const operations of [[...supplied(), {action: "set" as const, field: "metrics" as const, value: "合成指标甲"}], supplied()]) {
    const result = await runTool(createSemanticResolveTool(), proposal(operations), request);
    expect(result.details.status).toBe("ready");
    expect(result.details.issues).toEqual([]);
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

it("已完成目标明确其他条件不变时，直接绑定来源保留指标", async () => {
  const f = await setup(true), request = f.request("retain", "机构改为合成机构乙，其他条件不变");
  const operations: SemanticOperation[] = [{action: "set", field: "organizations", value: "合成机构乙"}];
  const rejected = await runTool(createSemanticResolveTool(), proposal(operations), request);
  expect(rejected.details.status).toBe("ready");
  expect(rejected.details.issues).toEqual([]);
  expect(await request.semanticTasks!.plan(f.plan.ref)).toEqual(f.plan); expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  const corrected = await runTool(createSemanticResolveTool(), proposal(operations, {kind: "current"}), request);
  expect(corrected.details.status).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.details.state.task_ref, target_ref: corrected.details.state.targets[0].target_ref}, request);
  expect(f.backend.basicQueries.mock.calls.at(-1)?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"], time: {start: "2025-12-31"}});
});

it("已完成目标明确今天和其他条件不变时，直接绑定已确认指标来源", async () => {
  const f = await setup(true), request = f.request("retain-today", "日期改为今天，其他条件不变");
  const turn = await request.semanticTasks!.admit(request.operationId, request.originalMessage);
  const inspected = await request.backend.inspectBusinessGoal("日期改为2025年末，其他条件不变", turn.businessDate);
  vi.mocked(request.backend.inspectBusinessGoal).mockResolvedValue({...inspected, question: request.originalMessage});
  const rejected = await runTool(createSemanticResolveTool(), proposal([{action: "set", field: "time", value: "今天"}]), request);
  expect(rejected.details.status).toBe("ready");
  expect(rejected.details.issues).toEqual([]);
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

it("指标未定的待补任务可由“指标是…”续接，已确定的机构日期来源保留（A4）", async () => {
  const f = await fixture(); cleanup.push(f.close);
  // 首轮零命中先允许同轮目录恢复，持久化计划仍保留待补指标和已定机构日期。
  const first = await runTool(createSemanticResolveTool(), proposal([
    {action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "metrics", value: "大聪明"},
    {action: "set", field: "time", value: "2025年末"},
  ]), f.request("a4-initial", "查合成机构甲2025年末的大聪明"));
  expect(first.details.status, JSON.stringify(first.details.issues)).toBe("needs_interpretation");
  expect(first.details).toHaveProperty("query_recovery");
  const plan = (await f.request().semanticTasks!.plan(first.details.state.task_ref))!;
  expect(plan.status).toBe("waiting_input");
  // 模型误用 new 重建：直接绑定唯一待补来源，保留旧机构与日期。
  const request = f.request("a4-metric", "指标是合成指标甲");
  for (const operations of [[{action: "set" as const, field: "metrics" as const, value: "合成指标甲"},
    {action: "set" as const, field: "organizations" as const, value: "合成机构甲"}, {action: "set" as const, field: "time" as const, value: "2025年末"}],
    [{action: "set" as const, field: "metrics" as const, value: "合成指标甲"}]]) {
    const wrong = await runTool(createSemanticResolveTool(), proposal(operations), request);
    expect(wrong.details.status).toBe("ready");
    expect(wrong.details.issues).toEqual([]);
    expect(await request.semanticTasks!.plan(plan.ref)).toEqual(plan);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  }
  // 指标值不在本轮目录识别内时不推断续补，交回正常澄清路径。
  const unknownRequest = f.request("a4-unknown", "指标是别的指标");
  const unknownTurn = await unknownRequest.semanticTasks!.admit(unknownRequest.operationId, unknownRequest.originalMessage);
  const unknownFacts = await unknownRequest.backend.inspectBusinessGoal(unknownRequest.originalMessage, unknownTurn.businessDate);
  expect(await pendingCompletionSource(unknownRequest, proposal([{action: "set", field: "metrics", value: "别的指标"}]), unknownTurn, unknownFacts)).toBeUndefined();
  // 显式续接：指标补齐，首轮机构与日期保留并执行。
  const corrected = await runTool(createSemanticResolveTool(), proposal([{action: "set", field: "metrics", value: "合成指标甲"}], {kind: "current"}), request);
  expect(corrected.details.status, JSON.stringify(corrected.details.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.details.state.task_ref, target_ref: corrected.details.state.targets[0].target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"], time: {start: "2025-12-31", end: "2025-12-31"}});
});

it("取数方式待补任务可由“取数方式是…”续接，区间与机构保留", async () => {
  const f = await fixture(); cleanup.push(f.close);
  // 首轮：区间为滚动三年（模型换算通道），取数方式未确定。
  const first = await runTool(createSemanticResolveTool(), proposal([
    {action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "metrics", value: "合成指标甲"},
    {action: "set", field: "time", value: "近3年", modelCalendar: {start: "2023-10-15", end: "2026-10-15"}},
  ]), f.request("sel-initial", "查合成机构甲近3年的合成指标甲"));
  expect(first.details.status, JSON.stringify(first.details.issues)).toBe("needs_user");
  expect(first.details.issues.some((issue: {code: string}) => issue.code === "TIME_SELECTION_REQUIRED")).toBe(true);
  const plan = (await f.request().semanticTasks!.plan(first.details.state.task_ref))!;
  const request = f.request("sel-answer", "取数方式是全部已有记录");
  const wrong = await runTool(createSemanticResolveTool(), proposal([{action: "set", field: "selection", value: "全部已有记录"}]), request);
  expect(wrong.details.status).toBe("ready");
  expect(wrong.details.issues).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  const corrected = await runTool(createSemanticResolveTool(), proposal([{action: "set", field: "selection", value: "全部已有记录"}], {kind: "current"}), request);
  expect(corrected.details.status, JSON.stringify(corrected.details.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.details.state.task_ref, target_ref: corrected.details.state.targets[0].target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"],
    time: {start: "2023-10-15", end: "2026-10-15"}, selection: "all_in_range"});
});

it("原句无取数方式锚词时，即使模型提议全量也不默认采纳，只转成待补追问", async () => {
  const f = await fixture(); cleanup.push(f.close);
  // “记录”不在取数方式锚词表中；模型提议“全部已有记录”缺少原句依据，不能默认全量或最新。
  const first = await runTool(createSemanticResolveTool(), proposal([
    {action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "metrics", value: "合成指标甲"},
    {action: "set", field: "time", value: "近3年", modelCalendar: {start: "2023-10-15", end: "2026-10-15"}},
    {action: "set", field: "selection", value: "全部已有记录"},
  ]), f.request("records-no-anchor", "查合成机构甲近3年的合成指标甲记录"));
  expect(first.details.status, JSON.stringify(first.details.issues)).toBe("needs_user");
  expect(first.details.issues).toContainEqual(expect.objectContaining({code: "SELECTION_SOURCE_NOT_ESTABLISHED", remediation: "user"}));
  expect(first.details.state.targets[0]!.pending).toContain("需要确定取数方式：区间内全部已有记录，还是最新一期？");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("“记录”不默认全量：无法解读的取数提案转成可回答待补问题，补齐后保留范围执行", async () => {
  const f = await fixture(); cleanup.push(f.close);
  // 首轮：区间明确但“记录”不含取数方式锚词；提案只写“记录”也无法解读。
  // 应转为可向用户回答的待补问题（只问全部已有记录还是最新一期），而不是内部错误终止。
  const first = await runTool(createSemanticResolveTool(), proposal([
    {action: "set", field: "organizations", value: "合成机构甲"},
    {action: "set", field: "metrics", value: "合成指标甲"},
    {action: "set", field: "time", value: "近3年", modelCalendar: {start: "2023-10-15", end: "2026-10-15"}},
    {action: "set", field: "selection", value: "记录"},
  ]), f.request("records-initial", "查合成机构甲近3年的合成指标甲记录"));
  expect(first.details.status, JSON.stringify(first.details.issues)).toBe("needs_user");
  expect(first.details.issues).toContainEqual(expect.objectContaining({code: "SELECTION_NOT_INTERPRETED", remediation: "user"}));
  expect(first.details.state.targets[0]!.pending).toContain("需要确定取数方式：区间内全部已有记录，还是最新一期？");
  // 范围、机构与指标全部保留，未取数。
  expect(first.details.state.targets[0]!.conditions).toEqual(expect.arrayContaining([
    expect.objectContaining({field: "organizations"}), expect.objectContaining({field: "metrics"}), expect.objectContaining({field: "time"})]));
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  // 一次补齐取数方式后执行：保留机构与原区间，不默认最新、不改月末采样。
  const request = f.request("records-answer", "取数方式是区间内全部已有记录");
  const corrected = await runTool(createSemanticResolveTool(), proposal([{action: "set", field: "selection", value: "全部已有记录"}], {kind: "current"}), request);
  expect(corrected.details.status, JSON.stringify(corrected.details.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: corrected.details.state.task_ref, target_ref: corrected.details.state.targets[0].target_ref}, request);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M1"], org_codes: ["O1"],
    time: {start: "2023-10-15", end: "2026-10-15"}, selection: "all_in_range"});
});
