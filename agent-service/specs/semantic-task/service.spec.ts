import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {runTool} from "../../src/tools/testUtils.js";
import {SemanticTaskService} from "../../src/semantic-task/service.js";
import {prepareSemanticArguments, semanticParameters} from "../../src/semantic-task/protocol.js";
import {createSemanticExecuteTool, createSemanticReadTool} from "../../src/semantic-task/tools.js";
import {complete, fixture, proposal} from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
async function setup() {const f = await fixture(); cleanup.push(f.close); return f;}
describe("统一语义任务及执行许可", () => {
  it("部署内嵌Schema与已评审文档唯一契约一致", () => {
    expect(JSON.parse(JSON.stringify(semanticParameters))).toEqual(JSON.parse(readFileSync(new URL("../../../docs/pi-semantic-task/request.schema.json", import.meta.url), "utf8")));
  });
  it("原始严格校验拒绝SDK可转换的版本和内部指标索引", () => {
    expect(() => prepareSemanticArguments({...proposal(complete()), protocol_version: "2"})).toThrow("SHAPE_INVALID");
    expect(() => prepareSemanticArguments(proposal([{action: "set", field: "metrics", value: {mentionIndexes: [1]}} as never]))).toThrow("SHAPE_INVALID");
  });
  it("精确查询编译Frame、消费许可一次，正式成功和零行结果可重显", async () => {
    const f = await setup(), request = f.request();
    const result = await new SemanticTaskService(request).resolve(proposal(complete()));
    expect(result.status).toBe("ready");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const refs = {task_ref: result.task!.ref, target_ref: result.task!.target.ref};
    const executed = await runTool(createSemanticExecuteTool(), refs, request);
    expect(executed.details.status).toBe("succeeded");
    expect(executed.details.state.completion).toBe("full");
    expect(executed.details.state.evidence.kind).toBe("metric_query_structured");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    await runTool(createSemanticReadTool(), refs, request);
    await runTool(createSemanticExecuteTool(), refs, request);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
  it("缺项保存普通成功字段；仅补日期沿用正式指标身份", async () => {
    const f = await setup();
    const initial = f.request("initial", "查询合成机构甲的合成指标甲");
    const first = await new SemanticTaskService(initial).resolve(proposal(complete().filter(op => op.field !== "time")));
    expect(first.status).toBe("needs_user");
    expect(first.task!.target.fields.metrics!.resolvedValue).toEqual({codes: ["M1"], names: ["合成指标甲"]});
    f.backend.resolveBusinessField.mockClear();
    const followup = f.request("date", "日期用2024年末");
    const next = await new SemanticTaskService(followup).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}));
    expect(next.status).toBe("ready");
    expect(next.task!.target.fields.metrics!.resolvedValue).toEqual(first.task!.target.fields.metrics!.resolvedValue);
    expect(f.backend.resolveBusinessField.mock.calls.some(([entity]) => entity === "metric")).toBe(false);
  });
  it("未决时间修改不会因纠错调用省略而回退旧日期", async () => {
    const f = await setup(), request = f.request();
    await new SemanticTaskService(request).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const nextRequest = f.request("modify", "日期改成近5年");
    const service = new SemanticTaskService(nextRequest);
    const first = await service.resolve(proposal([{action: "set", field: "time", value: "近5年"}], {kind: "current"}));
    expect(first.status).toBe("needs_user");
    const repeated = await service.resolve(proposal([], {kind: "current"}));
    expect(repeated.task!.target.pending.time).toBe("近5年");
    expect(repeated.task!.permit).toBeUndefined();
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  it("原句甲乙而Pi仅提交甲，完整义务对账拦截半份查询", async () => {
    const f = await setup(), request = f.request("omit", "查询合成机构甲2025年末的合成指标甲和合成指标乙");
    const result = await new SemanticTaskService(request).resolve(proposal(complete()));
    expect(result.status).toBe("needs_interpretation");
    expect(result.task!.issues.some(issue => issue.code === "GOAL_OBLIGATION_UNCOVERED")).toBe(true);
    expect(result.task!.permit).toBeUndefined();
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  it("泛指标首次与续补未匹配均保留机构日期并正常澄清", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "metrics" ? {...op, value: "存款记录"} : op);
    const first = await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的存款记录")).resolve(proposal(ops));
    const second = await new SemanticTaskService(f.request("supplement", "就是存款记录")).resolve(proposal([{action: "set", field: "metrics", value: "存款记录"}], {kind: "current"}));
    expect(first.status).toBe("needs_user"); expect(second.status).toBe("needs_user");
    expect(second.task!.target.fields.organizations!.resolutionStatus).toBe("resolved");
    expect(second.task!.target.fields.time!.resolutionStatus).toBe("resolved");
  });
  it("只改日期3号不会确认第三个指标候选", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "metrics" ? {...op, value: "待定指标"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的待定指标")).resolve(proposal(ops));
    const result = await new SemanticTaskService(f.request("date", "日期改成2026年4月3号")).resolve(proposal([{action: "set", field: "time", value: "2026年4月3号"}], {kind: "current"}));
    expect(result.status).toBe("needs_user");
    expect(result.task!.target.fields.metrics!.resolutionStatus).toBe("needs_confirmation");
    expect(result.task!.permit).toBeUndefined();
  });
  it("集合外排除对象不能变成可信排除或执行许可", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "metrics" ? {...op, value: "合成指标甲和合成指标乙"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的合成指标甲和合成指标乙")).resolve(proposal(ops, {kind: "new"}, "prepare"));
    const result = await new SemanticTaskService(f.request("exclude", "不要合成指标丙，只保留其它指标")).resolve(proposal([{action: "exclude", field: "metrics", subject: "合成指标丙"}], {kind: "current"}));
    expect(result.status).toBe("needs_interpretation");
    expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1", "M2"]});
    expect(result.task!.permit).toBeUndefined();
  });
  it("合法替换保留其它指标，并编译完整原句和排除证据", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "metrics" ? {...op, value: "合成指标甲和合成指标丙"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的合成指标甲和合成指标丙")).resolve(proposal(ops, {kind: "new"}, "prepare"));
    const request = f.request("replace", "把合成指标甲换成合成指标乙，其它条件不变");
    const result = await new SemanticTaskService(request).resolve(proposal([{action: "replace", field: "metrics", subject: "合成指标甲", value: "合成指标乙"}], {kind: "current"}));
    expect(result.status).toBe("ready");
    expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M3", "M2"]});
    expect(result.task!.target.coverage!.removed.every(item => item.text === "合成指标甲")).toBe(true);
    await runTool(createSemanticExecuteTool(), {task_ref: result.task!.ref, target_ref: result.task!.target.ref}, request);
    const spec = f.backend.basicQueries.mock.calls[0]?.[0] as unknown as {metric_codes: string[]; source_metric_exclusions: unknown[]};
    expect(spec.metric_codes).toEqual(["M3", "M2"]);
    expect(spec.source_metric_exclusions).toHaveLength(2);
  });
  it("篡改规范字段后许可不能消费，伪造引用不能执行", async () => {
    const f = await setup(), request = f.request();
    const ready = await new SemanticTaskService(request).resolve(proposal(complete()));
    const task = ready.task!;
    task.target.fields.time!.resolvedValue = {start: "2000-01-01", end: "2000-01-01"};
    await request.semanticTasks!.save(task, (await request.semanticTasks!.index()).version);
    const result = await runTool(createSemanticExecuteTool(), {task_ref: task.ref, target_ref: task.target.ref}, request);
    expect(result.details.status).toBe("conflict");
    expect(result.details.issues[0].code).toBe("EXECUTION_PERMIT_INVALID");
    const fake = await runTool(createSemanticExecuteTool(), {task_ref: "unissued", target_ref: "unissued"}, request);
    expect(fake.details.status).toBe("conflict");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });
  it("复合和分析未启用时保留原始目标，零部分执行", async () => {
    const f = await setup(), request = f.request();
    const input = proposal(complete()); input.targets.push(input.targets[0]!);
    const result = await new SemanticTaskService(request).resolve(input);
    expect(result.status).toBe("unsupported");
    expect((await request.semanticTasks!.turn(request.operationId))!.originalMessage).toBe(request.originalMessage);
    expect(await request.frames!.list()).toEqual([]);
  });
  it("否定候选不能确认；其它字段否定不干扰明确指标选择", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "metrics" ? {...op, value: "待定指标"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的待定指标")).resolve(proposal(ops));
    const denied = await new SemanticTaskService(f.request("negative", "不需要合成指标乙")).resolve(proposal([{action: "confirm", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
    expect(denied.status).toBe("needs_user"); expect(denied.task!.permit).toBeUndefined();
    const accepted = await new SemanticTaskService(f.request("accept", "指标用合成指标乙，但日期不要改")).resolve(proposal([{action: "confirm", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
    expect(accepted.status).toBe("ready");
    expect(accepted.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M2"]});
  });
  it("明确选择第二个候选由宿主绑定，日期数字和模型候选名称都不能改选择", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "metrics" ? {...op, value: "待定指标"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的待定指标")).resolve(proposal(ops));
    const result = await new SemanticTaskService(f.request("second", "用第二个")).resolve(proposal([{action: "confirm", field: "metrics", value: "选择第二个候选"}], {kind: "current"}));
    expect(result.status).toBe("ready");
    expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M2"]});
  });
  it("未决替换跨轮确认后保留未替换成员和原替换角色", async () => {
    const f = await setup();
    const initialOps = complete().map(op => op.field === "metrics" ? {...op, value: "合成指标甲和合成指标丙"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的合成指标甲和合成指标丙")).resolve(proposal(initialOps, {kind: "new"}, "prepare"));
    const pending = await new SemanticTaskService(f.request("pending", "把合成指标甲换成待定指标")).resolve(proposal([{action: "replace", field: "metrics", subject: "合成指标甲", value: "待定指标"}], {kind: "current"}));
    expect(pending.status).toBe("needs_user");
    const confirmed = await new SemanticTaskService(f.request("confirm", "用第二个")).resolve(proposal([{action: "confirm", field: "metrics", value: "第二个"}], {kind: "current"}));
    expect(confirmed.status).toBe("ready");
    expect(confirmed.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M3", "M2"]});
  });
  it("明确三家与继承两家冲突时不能执行", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "organizations" ? {...op, value: "合成机构甲和合成机构乙"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲和合成机构乙2025年末的合成指标甲")).resolve(proposal(ops, {kind: "new"}, "prepare"));
    const result = await new SemanticTaskService(f.request("three", "查询以上三家机构，条件不变")).resolve(proposal([], {kind: "current"}));
    expect(result.status).toBe("needs_user");
    expect(result.task!.issues.some(issue => issue.code === "ORGANIZATION_COUNT_CONFLICT")).toBe(true);
    expect(result.task!.permit).toBeUndefined();
  });
  it("提议缩短原日期和替换非来源成员不能得到许可", async () => {
    const f = await setup();
    const wrongDate = await new SemanticTaskService(f.request("time", "查合成机构甲2024年末的合成指标甲")).resolve(proposal(complete()));
    expect(wrongDate.status).toBe("needs_interpretation");
    expect(wrongDate.task!.issues.some(issue => issue.code === "TIME_SCOPE_CONFLICT")).toBe(true);
    const initialOps = complete().map(op => op.field === "metrics" ? {...op, value: "合成指标甲和合成指标乙"} : op);
    await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的合成指标甲和合成指标乙")).resolve(proposal(initialOps, {kind: "new"}, "prepare"));
    const reversed = await new SemanticTaskService(f.request("reverse", "把合成指标丙换成合成指标乙")).resolve(proposal([{action: "replace", field: "metrics", subject: "合成指标丙", value: "合成指标乙"}], {kind: "current"}));
    expect(reversed.status).toBe("needs_interpretation"); expect(reversed.task!.permit).toBeUndefined();
  });
  it("近N年保存两种日历口径，跨轮确认绑定原候选范围", async () => {
    const f = await setup();
    const ops = complete().map(op => op.field === "time" ? {...op, value: "近5年"} : op);
    const pending = await new SemanticTaskService(f.request("years", "查合成机构甲近5年的合成指标甲全部数据")).resolve(proposal([
      ...ops, {action: "set", field: "selection", value: "全部数据"},
    ]));
    expect(pending.status).toBe("needs_user");
    expect(pending.task!.target.fields.time!.candidates).toHaveLength(2);
    const confirmed = await new SemanticTaskService(f.request("date-choice", "日期用第二项")).resolve(proposal([
      {action: "confirm", field: "time", value: "第一个"},
    ], {kind: "current"}));
    expect(confirmed.status).toBe("ready");
    expect(confirmed.task!.target.fields.time!.resolvedValue).toEqual({start: "2021-01-01", end: "2025-12-31"});
    expect(confirmed.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1"]});
  });
  it("原始指标有歧义时模型直接填正式名称仍保存候选供用户确认", async () => {
    const f = await setup();
    const first = await new SemanticTaskService(f.request("original-ambiguous", "查合成机构甲2025年末的待定指标")).resolve(proposal(complete()));
    expect(first.status).toBe("needs_user");
    expect(first.task!.target.fields.metrics!.candidates).toHaveLength(3);
    const next = await new SemanticTaskService(f.request("confirm-original", "用第二个")).resolve(proposal([
      {action: "confirm", field: "metrics", value: "第二个"},
    ], {kind: "current"}));
    expect(next.status).toBe("ready");
    expect(next.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M2"]});
  });
  it("成功查询后新一轮只改日期可新建许可，不复用上一轮已消费许可", async () => {
    const f = await setup(), request = f.request();
    const first = await new SemanticTaskService(request).resolve(proposal(complete()));
    await runTool(createSemanticExecuteTool(), {task_ref: first.task!.ref, target_ref: first.task!.target.ref}, request);
    const nextRequest = f.request("after-success", "日期改成2024年末");
    const next = await new SemanticTaskService(nextRequest).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}));
    expect(next.status).toBe("ready");
    await runTool(createSemanticExecuteTool(), {task_ref: next.task!.ref, target_ref: next.task!.target.ref}, nextRequest);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
    expect((f.backend.basicQueries.mock.calls[1]![0] as {time: {start: string}}).time.start).toBe("2024-12-31");
  });
  it("日期候选回复即使模型用set也绑定用户原选择，不能反选", async () => {
    const f = await setup();
    await new SemanticTaskService(f.request("years", "查合成机构甲近5年的合成指标甲全部数据")).resolve(proposal([
      ...complete().filter(op => op.field !== "time"), {action: "set", field: "time", value: "近5年"}, {action: "set", field: "selection", value: "全部数据"},
    ]));
    const next = await new SemanticTaskService(f.request("choose", "日期用第二项")).resolve(proposal([
      {action: "set", field: "time", value: "滚动5年，截至今天"},
    ], {kind: "current"}));
    expect(next.status).toBe("ready");
    expect(next.task!.target.fields.time!.resolvedValue).toEqual({start: "2021-01-01", end: "2025-12-31"});
  });
  it("目标修订后的旧引用拒绝继续，历史分页不改焦点", async () => {
    const f = await setup();
    const initial = await new SemanticTaskService(f.request()).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    await new SemanticTaskService(f.request("change", "日期改成2024年末")).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}, "prepare"));
    const stale = await new SemanticTaskService(f.request("stale", "继续这个目标")).resolve(proposal([], {kind: "reference", task_ref: initial.task!.ref, target_ref: initial.task!.target.ref}));
    expect(stale.status).toBe("conflict");
    expect(stale.issues?.[0]?.code).toBe("REFERENCE_REVISION_CONFLICT");
    const second = await new SemanticTaskService(f.request("other", "查合成机构甲2025年末的合成指标甲")).resolve(proposal(complete(), {kind: "new"}, "prepare"));
    const store = f.request().semanticTasks!;
    const latest = await store.context(1), previous = await store.context(1, latest.next_cursor!);
    expect(latest.tasks[0]!.task_ref).toBe(second.task!.ref);
    expect(previous.tasks[0]!.task_ref).toBe(initial.task!.ref);
    expect((await store.index()).focus).toBe(second.task!.ref);
  });
  it("单日业务含义由日历确定，不因模型操作描述或指标口径误填而拒绝完整查询", async () => {
    const f = await setup();
    const result = await new SemanticTaskService(f.request()).resolve(proposal([
      ...complete(), {action: "set", field: "selection", value: "当日数"}, {action: "set", field: "operation", value: "查询当日值"},
    ]));
    expect(result.status).toBe("ready");
    expect(result.task!.target.fields.selection!.resolvedValue).toBe("exact");
    expect(result.task!.target.fields.operation!.resolvedValue).toEqual({kind: "value"});
    const unsupported = await new SemanticTaskService(f.request("compare", "比较合成机构甲2025年末的合成指标甲并分析差值")).resolve(proposal(complete()));
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.task!.permit).toBeUndefined();
  });
  it("已明确指标与待确认指标分别绑定原句片段，确认不扩大到所有已选编码", async () => {
    const f = await setup();
    const first = await new SemanticTaskService(f.request("mixed", "查合成机构甲2025年末的合成指标甲和待定指标")).resolve(proposal(complete()));
    expect(first.status).toBe("needs_user");
    const next = await new SemanticTaskService(f.request("mixed-choice", "指标用第二项")).resolve(proposal([{action: "confirm", field: "metrics", value: "第二项"}], {kind: "current"}));
    expect(next.status).toBe("ready");
    expect(next.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1", "M2"]});
    expect(next.task!.target.coverage!.mentions.find(mention => mention.text === "待定指标")!.value?.codes).toEqual(["M2"]);
  });
  it("多个候选组可分轮确认，每轮保留进度，全部完成前零许可", async () => {
    const f = await setup();
    f.backend.matchMetricQuestion.mockImplementation(async question => ({mentions: ["待定指标甲", "待定指标乙"].flatMap(text => {
      const start = question.indexOf(text);
      return start < 0 ? [] : [{text, start, end: start + text.length, resolution: {status: "needs_confirmation" as const,
        candidates: [{code: "M1", value: "合成指标甲"}, {code: "M2", value: "合成指标乙"}, {code: "M3", value: "合成指标丙"}]}}];
    })}));
    await new SemanticTaskService(f.request("groups", "查合成机构甲2025年末的待定指标甲和待定指标乙")).resolve(proposal(complete()));
    const partial = await new SemanticTaskService(f.request("partial", "用第二项")).resolve(proposal([{action: "confirm", field: "metrics", value: "第二项"}], {kind: "current"}));
    expect(partial.status).toBe("needs_user");
    expect(partial.task!.permit).toBeUndefined();
    expect(partial.task!.target.fields.metrics!.metadata?.partialMembers).toMatchObject({codes: ["M2"]});
    expect(partial.task!.target.fields.metrics!.candidates).toHaveLength(3);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const final = await new SemanticTaskService(f.request("remaining", "用第三项")).resolve(proposal([{action: "confirm", field: "metrics", value: "第三项"}], {kind: "current"}));
    expect(final.status).toBe("ready");
    expect(final.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M2", "M3"]});
    expect(final.task!.target.coverage!.mentions.map(mention => mention.value?.codes)).toEqual([["M2"], ["M3"]]);
  });
});

it("日期候选可按唯一业务名称选择，展示附注无需复述且模型不能反选",async()=>{
 const f=await setup();
 await new SemanticTaskService(f.request("named-date-base","查合成机构甲近5年的合成指标甲全部数据")).resolve(proposal([...complete().filter(op=>op.field!=="time"),{action:"set",field:"time",value:"近5年"},{action:"set",field:"selection",value:"全部数据"}]));
 const request=f.request("named-date-choice","日期用最近5个完整年度，取全部已有数据点");
 const ready=await new SemanticTaskService(request).resolve(proposal([{action:"set",field:"time",value:"向前滚动5年"}],{kind:"current"}));
 expect(ready.status).toBe("ready");expect(ready.task!.target.fields.time!.resolvedValue).toEqual({start:"2021-01-01",end:"2025-12-31"});
});

it("日期名称出现在否定或其它字段选择中不能确认日期候选",async()=>{
 const f=await setup();
 await new SemanticTaskService(f.request("named-date-no-base","查合成机构甲近5年的合成指标甲全部数据")).resolve(proposal([...complete().filter(op=>op.field!=="time"),{action:"set",field:"time",value:"近5年"},{action:"set",field:"selection",value:"全部数据"}]));
 for(const [id,message]of [["negated","日期不要最近5个完整年度"],["metric-label","指标用最近5个完整年度"]]){
  const next=await new SemanticTaskService(f.request(id!,message!)).resolve(proposal([{action:"confirm",field:"time",value:"最近5个完整年度"}],{kind:"current"}));
  expect(next.status).toBe("needs_user");expect(next.task!.permit).toBeUndefined();
 }
});
