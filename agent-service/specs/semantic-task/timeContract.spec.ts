/**
 * semantic_v2 日期契约桩测试（无真实模型/后端）：
 * 1) 协议 Schema 接受/拒绝 modelCalendar；
 * 2) time set/replace 的 modelCalendar 经 model_value 通道上送，缺省行为不变，alternative 存入字段 metadata；
 * 3) 宿主 timeOverride 短路：跳过 resolve-field 与模型换算，并清除残留 timeAlternative。
 */
import {afterEach, describe, expect, it} from "vitest";
import {prepareSemanticArguments} from "../../src/semantic-task/protocol.js";
import {SemanticTaskService} from "../../src/semantic-task/service.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {completeQuery} from "../../src/semantic-task/querySpec.js";
import {createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
import {complete, fixture, proposal} from "./fixtures.js";

const MODEL_CALENDAR = {start: "2023-10-15", end: "2026-10-15"};
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of clean.splice(0)) await close();});

describe("协议 Schema modelCalendar", () => {
  const wrap = (operation: unknown) => ({protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, operations: [operation]}]});
  it("time set/replace 接受合法 modelCalendar", () => {
    for (const operation of [
      {action: "set", field: "time", value: "近3年", modelCalendar: MODEL_CALENDAR},
      {action: "set", field: "time", value: "各月末", modelCalendar: {...MODEL_CALENDAR, dates: ["2026-03-31", "2026-04-30"]}},
      {action: "replace", field: "time", subject: "2025年末", value: "近3年", modelCalendar: MODEL_CALENDAR},
    ]) {
      const parsed = prepareSemanticArguments(wrap(operation));
      expect(parsed.targets[0]!.operations[0]).toMatchObject({modelCalendar: expect.objectContaining({start: "2023-10-15"})});
    }
  });
  it.each([
    {action: "set", field: "time", value: "近3年", modelCalendar: {start: "2023-10-15"}},                    // 缺 end
    {action: "set", field: "time", value: "近3年", modelCalendar: {start: "20231015", end: "2026-10-15"}},  // 非 YYYY-MM-DD
    {action: "set", field: "time", value: "近3年", modelCalendar: {...MODEL_CALENDAR, label: "x"}},          // 多余键
    {action: "set", field: "time", value: "近3年", modelCalendar: {...MODEL_CALENDAR, dates: ["2026-03-31"]}}, // dates 少于2点
  ])("拒绝畸形 modelCalendar：%j", operation => {
    expect(() => prepareSemanticArguments(wrap(operation))).toThrow();
  });
  it("操作上的未知键仍被拒绝", () => {
    expect(() => prepareSemanticArguments(wrap({action: "set", field: "time", value: "近3年", calendar: MODEL_CALENDAR}))).toThrow();
  });
});

describe("语义解析 modelValue 通道", () => {
  const message = "查询合成机构甲近3年的合成指标甲全部数据";
  const operations = () => [
    ...complete().filter(op => op.field !== "time"),
    {action: "set" as const, field: "time" as const, value: "近3年", modelCalendar: MODEL_CALENDAR},
    {action: "set" as const, field: "selection" as const, value: "全部数据"},
  ];
  it("模型提交 modelCalendar：随原文经第6参上送，alternative 与 resolution_source 存入字段 metadata 并进入 spec", async () => {
    const f = await fixture(); clean.push(f.close);
    const result = await new SemanticTaskService(f.request("model-calendar", message)).resolve(proposal(operations()));
    expect(result.status, JSON.stringify(result.task?.issues)).toBe("ready");
    const dateCalls = f.backend.resolveBusinessField.mock.calls.filter(([entity]) => entity === "date");
    expect(dateCalls).toHaveLength(1);
    const [, rawValues, , , semanticSource, modelValue] = dateCalls[0]!;
    expect(rawValues).toEqual(["近3年"]);
    expect(semanticSource).toMatchObject({source_question: message});
    expect(modelValue).toEqual(MODEL_CALENDAR);
    const time = result.task!.target.fields.time!;
    expect(time.resolvedValue).toEqual(MODEL_CALENDAR);
    expect(time.metadata?.timeAlternative).toEqual({label: "最近3个完整年度", start: "2023-01-01", end: "2025-12-31"});
    expect(time.metadata?.resolution_source).toBe("deterministic");
    expect(completeQuery(result.task!.target)).toMatchObject({time: MODEL_CALENDAR,
      time_alternative: {label: "最近3个完整年度", start: "2023-01-01", end: "2025-12-31"}});
  });
  it("确定性规则不支持的表达：采纳模型换算兜底并标记 resolution_source=model", async () => {
    const f = await fixture(); clean.push(f.close);
    const message = "查询合成机构甲模糊时间的合成指标甲全部数据";
    const result = await new SemanticTaskService(f.request("model-fallback", message)).resolve(proposal([
      ...complete().filter(op => op.field !== "time"),
      {action: "set", field: "time", value: "模糊时间", modelCalendar: MODEL_CALENDAR},
      {action: "set", field: "selection", value: "全部数据"},
    ]));
    expect(result.status, JSON.stringify(result.task?.issues)).toBe("ready");
    const time = result.task!.target.fields.time!;
    expect(time.resolvedValue).toEqual(MODEL_CALENDAR);
    expect(time.metadata?.resolution_source).toBe("model");
    expect(time.metadata?.timeAlternative).toBeUndefined();
  });
  it("模型未给日历时复用本轮确定性日历，来源仍由事实服务标识", async () => {
    const f = await fixture(); clean.push(f.close);
    const result = await new SemanticTaskService(f.request("plain", "查询合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
    expect(result.status).toBe("ready");
    const dateCalls = f.backend.resolveBusinessField.mock.calls.filter(([entity]) => entity === "date");
    expect(dateCalls).toHaveLength(1);
    expect(dateCalls[0]![5]).toEqual({start: "2025-12-31", end: "2025-12-31"});
    expect(result.task!.target.fields.time!.metadata?.timeAlternative).toBeUndefined();
  });
});

describe("已采纳日历跨环节复用", () => {
  it("片段词法扫描不认识该表达时，子步骤解析与执行复用同一份已采纳模型日历", async () => {
    const f = await fixture(); clean.push(f.close);
    const innerInspect = f.backend.inspectBusinessGoal.getMockImplementation()!;
    // 模拟旧词法扫描不认识该表达：fragment 只报 unresolved，不给任何 ranges。
    // 修复前该 fragment 日历会经 step.calendar 覆盖字段入口已采纳结果，TIME_SCOPE_CONFLICT 误拒。
    f.backend.inspectBusinessGoal.mockImplementation((async (question: string, ...rest: unknown[]) => {
      const goal = await (innerInspect as (...args: unknown[]) => Promise<any>)(question, ...rest);
      return {...goal, fragments: goal.fragments.map((fragment: {question: string; calendar: unknown}) => fragment.question.includes("模糊时间")
        ? {...fragment, calendar: {ranges: [], unresolved: ["模糊时间"]}} : fragment)};
    }) as typeof innerInspect);
    const message = "查合成机构甲模糊时间的合成指标甲全部数据";
    const request = f.request("adopted-calendar", message);
    const result = await new SemanticPlanService(request).resolve(proposal([
      {action: "set", field: "organizations", value: "合成机构甲"},
      {action: "set", field: "metrics", value: "合成指标甲"},
      {action: "set", field: "time", value: "模糊时间", modelCalendar: MODEL_CALENDAR},
      {action: "set", field: "selection", value: "全部数据"},
    ]));
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
    const task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
    expect(task.target.fields.time!.resolvedValue).toEqual(MODEL_CALENDAR);
    expect(task.target.fields.time!.metadata?.resolution_source).toBe("model");
    await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect(f.backend.basicQueries.mock.calls[0]?.[0]).toMatchObject({time: MODEL_CALENDAR, selection: "all_in_range"});
  });
});

describe("宿主 timeOverride 短路", () => {
  it("等同用户明确指定：跳过 resolve-field 与模型换算，清除残留 timeAlternative", async () => {
    const f = await fixture(); clean.push(f.close);
    const first = await new SemanticTaskService(f.request("initial", "查询合成机构甲近3年的合成指标甲全部数据")).resolve(proposal([
      ...complete().filter(op => op.field !== "time"),
      {action: "set", field: "time", value: "近3年", modelCalendar: MODEL_CALENDAR},
      {action: "set", field: "selection", value: "全部数据"},
    ]));
    expect(first.status).toBe("ready");
    expect(first.task!.target.fields.time!.metadata?.timeAlternative).toBeDefined();
    f.backend.resolveBusinessField.mockClear();
    // 前端“切换口径”重查：time_override 由宿主绑定，模型只提交时间变化。
    const request = {...f.request("override", "切换到最近3个完整年度"),
      timeOverride: {start: "2022-01-01", end: "2024-12-31"}};
    const switched = await new SemanticTaskService(request).resolve(proposal(
      [{action: "set", field: "time", value: "最近3个完整年度"}], {kind: "current"}));
    expect(switched.status, JSON.stringify(switched.task?.issues)).toBe("ready");
    expect(f.backend.resolveBusinessField.mock.calls.some(([entity]) => entity === "date")).toBe(false);
    const time = switched.task!.target.fields.time!;
    expect(time).toMatchObject({resolvedValue: {start: "2022-01-01", end: "2024-12-31"},
      resolutionStatus: "resolved", source: "explicit", metadata: {timeSource: "user_override"}});
    expect(time.metadata?.timeAlternative).toBeUndefined();
    // 新 spec 不携带旧备选口径
    expect(completeQuery(switched.task!.target)).not.toHaveProperty("time_alternative");
  });
});
