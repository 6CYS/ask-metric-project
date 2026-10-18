import {afterEach, expect, it, vi} from "vitest";
import {fixture} from "./fixtures.js";
import {prepareSemanticArguments, type StructuredQuery} from "../../src/semantic-task/protocol.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {semanticPublicAnswer} from "../../src/semantic-task/feedback.js";
import {backendIssue} from "../../src/semantic-task/backendIssue.js";
import {BackendApiError} from "../../src/backendClient.js";
import {runTool} from "../../src/tools/testUtils.js";
import {normalizeQueryOperation} from "../../src/business-context/rankingEvidence.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of clean.splice(0)) await close();});
const query = (changes: Partial<StructuredQuery> = {}): StructuredQuery => ({
  organizations: {kind: "named", names: ["合成机构甲", "合成机构乙"]}, metrics: ["合成指标甲"],
  time: {expression: "2025年末", calendar: {start: "2025-12-31", end: "2025-12-31"}},
  selection: "exact", operation: {kind: "value"}, ...changes,
});
const input = (value: StructuredQuery) => prepareSemanticArguments({protocol_version: 2, intent: "query",
  targets: [{source: {kind: "new"}, query: value}]});
async function setup() {const f = await fixture(); clean.push(f.close); return f;}

it("结构化查询的objective进入步骤标签和字段状态，供计算来源引用", async () => {
  const f = await setup(), request = f.request("label", "查合成机构甲和合成机构乙2025年末的合成指标甲");
  const result = await new SemanticPlanService(request).resolve(input(query({objective: "本期"})));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  const plan = await request.semanticTasks!.plan(result.state.task_ref!);
  const task = await request.semanticTasks!.get(plan!.steps[0]!.taskRef!);
  expect(plan!.steps[0]!.label).toBe("本期");
  expect(task!.target.fields.objective!.resolvedValue).toBe("本期");
});

it.each([
  {kind: "value"}, {kind: "ranking", position: "top", top_n: 1},
  {kind: "ranking", position: "bottom", top_n: 2}, {kind: "sort", direction: "ascending"},
  {kind: "rank_position"},
] as const)("结构化$kind完整条件绑定到执行spec，不再解析排序描述", async operation => {
  const f = await setup(), request = f.request("structured", "查询合成机构甲和合成机构乙2025年末的合成指标甲");
  const value = query({operation, ...(operation.kind === "rank_position"
    ? {organizations: {kind: "named", names: ["合成机构甲"]}, comparison_organizations: {kind: "named", names: ["合成机构甲", "合成机构乙"]}} : {})});
  const result = await new SemanticPlanService(request).resolve(input(value));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
  const expected = operation.kind === "sort" ? {kind: "ranking", position: "bottom", top_n: 2} : operation;
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({metric_codes: ["M1"],
    org_codes: operation.kind === "rank_position" ? ["O1"] : ["O1", "O2"],
    time: {start: "2025-12-31", end: "2025-12-31"}, selection: "exact", operation: expected});
});

it.each([
  {kind: "authorized_cohort", cohort: "rural_commercial_banks", source_text: "全省法人行"},
  {kind: "children_of", parent_name: "合成机构甲", source_text: "合成机构甲的下属机构"},
] as const)("结构化$kind传递范围短语和类型，完整句子不再当范围值", async organizations => {
  const f = await setup();
  const resolveScope = vi.fn(async (_scope: unknown, _options?: unknown) => ({status: "resolved", value: {codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"]}}));
  Object.assign(f.backend, {resolveOrganizationScope: resolveScope});
  const request = f.request("scope", `查询${organizations.source_text}2025年末的合成指标甲`);
  const result = await new SemanticPlanService(request).resolve(input(query({organizations})));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  expect(resolveScope.mock.calls[0]![0]).toEqual(organizations.kind === "authorized_cohort"
    ? {kind: organizations.kind, cohort: organizations.cohort, sourceText: organizations.source_text}
    : {kind: organizations.kind, parentName: organizations.parent_name, sourceText: organizations.source_text});
  await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, request);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({org_codes: ["O1", "O2"]});
});

it("真实缺项和不完整排名只追问缺少条件，不执行SQL", async () => {
  const f = await setup(), request = f.request("missing", "查询2025年末合成指标甲的前几名");
  const result = await new SemanticPlanService(request).resolve(input(query({organizations: null,
    operation: {kind: "ranking", position: "top", top_n: null}})));
  expect(result.status).toBe("needs_user");
  expect(result.issues.filter(issue => issue.field === "operation")).toMatchObject([{code: "RANKING_NOT_DETERMINED", message: "请补充需要几名。"}]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("结构化提案不能把用户未提供的日期填成查询条件", async () => {
  const f = await setup(), request = f.request("fabricated-date", "查询合成机构甲和合成机构乙的合成指标甲");
  const result = await new SemanticPlanService(request).resolve(input(query()));
  expect(result.status, JSON.stringify(result.issues)).toBe("needs_user");
  expect(result.issues).toContainEqual(expect.objectContaining({code: "FIELD_REQUIRED", field: "time"}));
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("排序和日期的跨轮修改继承原机构指标，结构化操作不被文字规则覆盖", async () => {
  const f = await setup(), first = f.request("first", "查合成机构甲和合成机构乙2025年末合成指标甲前1名");
  const ready = await new SemanticPlanService(first).resolve(input(query({operation: {kind: "ranking", position: "top", top_n: 1}})));
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, first);
  const next = f.request("change", "换成2024年末的末尾两家");
  const result = await new SemanticPlanService(next).resolve(prepareSemanticArguments({protocol_version: 2, intent: "query", targets: [{
    source: {kind: "current"}, operations: [{action: "set", field: "time", value: "2024年末", modelCalendar: {start: "2024-12-31", end: "2024-12-31"}},
      {action: "set", field: "operation", queryOperation: {kind: "ranking", position: "bottom", top_n: 2}}],
  }]}));
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, next);
  expect(f.backend.basicQueries.mock.calls[1]![0]).toMatchObject({org_codes: ["O1", "O2"], metric_codes: ["M1"],
    time: {start: "2024-12-31", end: "2024-12-31"}, operation: {kind: "ranking", position: "bottom", top_n: 2}});
});

it("后端422保留真实拒绝码交模型修正，服务诊断与用户提示分离", async () => {
  const f = await setup(), code = "SCOPE_SOURCE_INVALID";
  Object.assign(f.backend, {resolveOrganizationScope: vi.fn(async () => {throw new BackendApiError(422, "范围参数不匹配", code);})});
  const request = f.request("rejected", "查询全省法人行2025年末的合成指标甲");
  const result = await new SemanticPlanService(request).resolve(input(query({organizations: {
    kind: "authorized_cohort", cohort: "rural_commercial_banks", source_text: "全省法人行"}})));
  expect(result.status).toBe("needs_interpretation");
  expect(result.issues).toContainEqual({code, field: "organizations", category: "input_shape", remediation: "pi", message: "范围参数不匹配"});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  expect(semanticPublicAnswer({...result, status: "failed"})).toBe("没能完成这次查询。");
  expect(backendIssue(new BackendApiError(503, "内部连接错误"))).toMatchObject({category: "infrastructure", remediation: "stop"});
  expect(backendIssue(new BackendApiError(403, "权限不足"))).toMatchObject({category: "permission", remediation: "stop"});
});

it("结构化契约拒绝非数字条数及同时提交两套查询条件", () => {
  expect(() => input(query({operation: {kind: "ranking", position: "top", top_n: "3"} as never}))).toThrow("SHAPE_INVALID");
  expect(() => prepareSemanticArguments({protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, query: query(), operations: []}]})).toThrow("SHAPE_INVALID");
});

it("历史文字解析只使用当前待解析文本的指标位置", async () => {
  const raw = "按合成指标甲从高到低取前3名";
  const mentions = vi.fn(async (text?: string) => {expect(text).toBe(raw); const start = text!.indexOf("合成指标甲");
    return {mentions: [{text: "合成指标甲", start, end: start + 5, resolution: {status: "resolved" as const, value: {codes: ["M1"], names: ["合成指标甲"]}}}]};});
  expect(await normalizeQueryOperation({originalMessage: raw, currentDate: "2026-10-18", turnId: "legacy", resolveCatalog: async () => ({status: "invalid"}),
    resolveMetricMentions: mentions})).toMatchObject({status: "resolved", value: {kind: "ranking", position: "top", top_n: 3}});
});
