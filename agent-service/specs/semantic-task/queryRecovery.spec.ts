import {afterEach, expect, it, vi} from "vitest";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {NativeSemanticTaskStore} from "../../src/semantic-task/store.js";
import {queryRecoveryPhase, assertRecoveryComparisonBasis, parallelMetricAlternatives, normalizeParallelMetricProposal} from "../../src/semantic-task/queryRecovery.js";
import {analysisCandidates, catalogBindingView, restoreAnalysisDiscovery} from "../../src/analysis/bindings.js";
import {createAnalysisCatalogTool} from "../../src/analysis/tools.js";
import {BackendApiError} from "../../src/backendClient.js";
import {runTool} from "../../src/tools/testUtils.js";
import {complete, fixture, proposal} from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
const missing = () => proposal(complete().map(op => op.field === "metrics" ? {...op, value: "存款记录"} : op));
const goal = "查询合成机构甲2025年末的存款记录";
async function setup() {
  const f = await fixture(); cleanup.push(f.close);
  return f;
}
const resolve = (request: ReturnType<Awaited<ReturnType<typeof fixture>>["request"]>, input: unknown = missing()) =>
  runTool(createSemanticResolveTool(), input, request);
const analysis = () => ({protocol_version: 2, intent: "analyze", targets: [{source: {kind: "current"},
  analysis: {kind: "business_analysis", plan: {objective: "原问题的存款记录", scope_notice: "隔离合成测试",
    requirements: [{id: "same-goal", question: "查询原机构原日期的存款记录"}],
    steps: [{id: "observe", method: "observe" as const, metric_refs: ["k1"], answers: ["same-goal"], rationale: "目录证据核对后取值"}]}}}]});

async function parallelSetup() {
  const f = await setup(), request = f.request("parallel", "合成机构甲2025年末合成存款信息");
  const candidates = ["余额当日数", "余额较年初", "余额较年初增幅", "余额较年初增幅排名", "余额较年初排名"]
    .map((suffix, index) => ({code: `P${index}`, value: `合成存款${suffix}`}));
  const original = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "metric" && args[1].includes("合成存款")
    ? {status: "needs_confirmation", candidates} : original(...args));
  const input = proposal(complete().map(op => op.field === "metrics" ? {...op, value: "合成存款"} : op));
  return {f, request, candidates, input};
}

it.each(["complete", "unavailable", "wrong_identity"])("冻结候选按可信编码发现，%s时可执行部分不被其他候选阻塞且回执可重开", async mode => {
  const {f, request, candidates, input} = await parallelSetup();
  await resolve(request, input);
  const catalog = vi.fn(async (code: string) => {
    if (code === "P4" && mode === "unavailable") throw new Error("synthetic unavailable");
    const item = candidates.find(item => item.code === code)!;
    return {items: [{code: mode === "wrong_identity" && code === "P4" ? "UNRELATED" : item.code,
      name: item.value, binding_ref: `signed-${code}`}], has_more: true};
  });
  const execute = vi.fn(async () => ({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
    run_ref: "partial-catalog", scope_id: "synthetic", org_codes: ["O1"], rows: [], evidence_items: [], metric_descriptors: []}));
  Object.assign(f.backend, {analysisMethods: vi.fn(async () => ({methods: []})), analysisCatalog: catalog,
    analysisValidate: vi.fn(async () => ({valid: true})), analysisExecute: execute});
  const found = await runTool(createAnalysisCatalogTool(), {keywords: ["故意无效的模型关键词"], page: 99, page_size: 12}, request);
  expect(found.details).toMatchObject({status: "succeeded", recovery_lookup_codes: candidates.map(item => item.code),
    unresolved_lookup_codes: mode === "complete" ? [] : ["P4"]});
  expect(catalog.mock.calls.map(args => args[0])).toEqual(candidates.map(item => item.code));
  expect(catalog).toHaveBeenCalledWith("P4", 1, 1, expect.anything());
  const reopened = f.request(request.operationId, request.originalMessage);
  restoreAnalysisDiscovery(reopened, [found.details]);
  expect(analysisCandidates(reopened)).toHaveLength(mode === "complete" ? 5 : 4);
  // 重现截图：模型重新建query且只选余额，程序按原始目标保留全部可用候选。
  const retry = {protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, query: {
    organizations: {kind: "named", names: ["合成机构甲"]}, metrics: [candidates[0]!.value],
    time: {expression: "2025年末"}, selection: "exact", operation: {kind: "value"}}}]};
  const ready = await resolve(reopened, retry);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready", answer_receipts: [], pending_questions: []});
  const done = await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state!.task_ref!,
    target_ref: ready.details.state!.targets[0]!.target_ref}, reopened);
  expect(done.details.status, JSON.stringify(done.details)).toBe("succeeded");
  const payload = execute.mock.calls[0] as unknown as [Record<string, unknown>];
  expect(payload[0]).toMatchObject({org_codes: ["O1"], start: "2025-12-31", end: "2025-12-31",
    plan: {steps: [expect.objectContaining({metric_refs: candidates.slice(0, mode === "complete" ? 5 : 4).map(item => `signed-${item.code}`)})]}});
  const requirements = (payload[0].plan as {requirements: Array<{gap_reason?: string}>}).requirements;
  expect(requirements.filter(item => item.gap_reason)).toHaveLength(mode === "complete" ? 0 : 1);
  if (mode !== "complete") expect(requirements.find(item => item.gap_reason)?.gap_reason).toContain(candidates[4]!.value);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([401, 403])("定向发现遇到%s不能登记其他成功项或放宽权限继续执行", async status => {
  const {f, request, input} = await parallelSetup();
  await resolve(request, input);
  Object.assign(f.backend, {analysisMethods: vi.fn(async () => ({methods: []})),
    analysisCatalog: vi.fn(async (code: string) => {
      if (code === "P4") throw new BackendApiError(status, "PERMISSION_DENIED", "synthetic denied");
      return {items: [{code, name: `合成${code}`, binding_ref: `signed-${code}`}]};
    })});
  await expect(runTool(createAnalysisCatalogTool(), {keywords: ["合成存款"]}, request)).rejects.toBeInstanceOf(BackendApiError);
  expect(analysisCandidates(request)).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([false, true])("其他候选全部读取失败时，已有可信候选=%s，仅有可用依据才推进", async cached => {
  const {f, request, candidates, input} = await parallelSetup();
  await resolve(request, input);
  if (cached) catalogBindingView(request, {items: [{code: "P0", name: candidates[0]!.value, binding_ref: "signed-P0"}]});
  Object.assign(f.backend, {analysisMethods: vi.fn(async () => ({methods: []})),
    analysisValidate: vi.fn(async () => ({valid: true})),
    analysisCatalog: vi.fn(async () => {throw new Error("synthetic unavailable");})});
  const result = await runTool(createAnalysisCatalogTool(), {keywords: ["合成存款"]}, request);
  expect(result.details).toMatchObject({status: cached ? "succeeded" : "error"});
  if (cached) {
    const ready = await resolve(request, proposal([], {kind: "current"}));
    expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  }
});

it("相关指标多候选先发现并列查询，保留完整五项候选而不是页面前四项，不要求用户单选", async () => {
  const {f, request, candidates, input} = await parallelSetup();
  const first = await resolve(request, input);
  expect(first.details, JSON.stringify(first.details)).toMatchObject({status: "needs_interpretation",
    query_recovery: {metric_alternatives: [{metric: "合成存款", candidates: candidates.map(item => ({code: item.code, name: item.value}))}]}});
  expect(first.details.pending_questions).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each(["最近", "近期", "近来"])("%s与未绑定指标别名同时出现时，进入真实目录发现并保留最新覆盖策略", async recent => {
  const f = await setup(), request = f.request(`recent-${recent}`, `合成机构甲${recent}存款情况？`);
  const original = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "date" && args[1][0] === recent
    ? {status: "invalid", metadata: {reason: "unsupported_expression"}} : original(...args));
  const first = await resolve(request, {protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, query: {
    organizations: {kind: "named", names: ["合成机构甲"]}, metrics: ["存款余额"], time: {expression: recent},
    selection: "latest_in_range", operation: {kind: "value"}}}]});
  expect(first.details, JSON.stringify(first.details)).toMatchObject({status: "needs_interpretation",
    continuation: {action: "discover_query"}, query_recovery: {original_goal: request.originalMessage}});
  const frozen = (await request.semanticTasks!.turn(request.operationId))!.queryRecovery!.scopes[0]!.fields;
  expect(frozen.organizations?.resolvedValue).toMatchObject({codes: ["O1"]});
  expect(frozen.time).toMatchObject({rawValue: recent, resolvedValue: {date_selection: "latest_snapshot"}});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  catalogBindingView(request, {items: [{code: "M1", name: "合成指标甲", binding_ref: "signed-recent"}]});
  Object.assign(f.backend, {analysisValidate: vi.fn(async () => ({valid: true}))});
  const input = analysis();
  input.targets[0]!.analysis.plan.steps[0]!.metric_refs = ["signed-recent"];
  const ready = await resolve(request, input);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  const plan = (await request.semanticTasks!.plan(ready.details.state!.task_ref!))!;
  const task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  expect(task.target.fields.time?.resolvedValue).toEqual({date_selection: "latest_snapshot"});
});

it.each(["最近三个月", "2025年末"])("%s的日期解析失败不能被恢复为无界最近记录", async period => {
  const f = await setup(), request = f.request("bounded", `合成机构甲${period}存款情况？`);
  const original = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "date"
    ? {status: "invalid", metadata: {reason: "unsupported_expression"}} : original(...args));
  const result = await resolve(request, proposal(complete().map(op => op.field === "time" ? {...op, value: period}
    : op.field === "metrics" ? {...op, value: "存款余额"} : op)));
  expect(result.details).not.toHaveProperty("query_recovery");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("并列分析必须观察全部目录候选，成功转分析后旧单选题被替代而不伪造用户确认", async () => {
  const {f, request, candidates, input} = await parallelSetup();
  const first = await resolve(request, input);
  const oldQuestions = await request.semanticTasks!.questionsForPlan(first.details.state!.task_ref!);
  expect(oldQuestions).toHaveLength(1);
  const execute = vi.fn(async () => ({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
    run_ref: "parallel-synthetic", scope_id: "synthetic", org_codes: ["O1"], rows: [], evidence_items: [], metric_descriptors: []}));
  Object.assign(f.backend, {analysisValidate: vi.fn(async () => ({valid: true})), analysisExecute: execute});
  catalogBindingView(request, {items: [{code: candidates[0]!.code, name: candidates[0]!.value, binding_ref: "signed-0"}]});
  const incomplete = await resolve(request, analysis());
  expect(JSON.stringify(incomplete.details)).toContain("QUERY_RECOVERY_ALTERNATIVES_REQUIRED");
  expect(incomplete.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({category: "catalog", remediation: "pi"})]));
  expect(execute).not.toHaveBeenCalled();
  catalogBindingView(request, {items: candidates.map((item, index) => ({code: item.code, name: item.value, binding_ref: `signed-${index}`}))});
  // 模型只提交余额，程序在全部引用已签发后补齐剩余四项；不依赖模型反复改写清单。
  const ready = await resolve(request, analysis());
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready", pending_questions: []});
  for (const view of oldQuestions) {
    const stored = await request.semanticTasks!.question(view.question.question_id, view.question.version);
    expect(stored?.question.status).toBe("superseded");
    expect(stored?.binding.receipts).toEqual([]);
  }
  const done = await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state!.task_ref!, target_ref: ready.details.state!.targets[0]!.target_ref}, request);
  expect(done.details.status).toBe("succeeded");
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({org_codes: ["O1"], start: "2025-12-31", end: "2025-12-31",
    plan: expect.objectContaining({steps: [expect.objectContaining({method: "observe", metric_refs: candidates.map((_, index) => `signed-${index}`)})]})}), expect.any(String), expect.anything());
});

it("模型同轮自选第一项仍被拒绝，但反馈引导并列分析而非重复自确认错误", async () => {
  const {f, request, input} = await parallelSetup();
  const first = await resolve(request, input);
  const question = (await request.semanticTasks!.questionsForPlan(first.details.state!.task_ref!))[0]!.question;
  const attempt = {...proposal(complete(), {kind: "current"}), answers: [{question_id: question.question_id, version: question.version,
    choice: {type: "select", option_ids: [question.options[0]!.option_id]}, evidence: {excerpt: request.originalMessage}}]};
  const result = await resolve(request, attempt);
  expect(result.details).toMatchObject({status: "needs_interpretation", pending_questions: [], issues: [
    expect.objectContaining({code: "QUERY_RECOVERY_ANALYSIS_REQUIRED", category: "catalog", remediation: "pi"}),
  ]});
  expect((await request.semanticTasks!.question(question.question_id, question.version))?.binding.receipts).toEqual([]);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  Object.assign(f.backend, {analysisValidate: vi.fn(async () => ({valid: true}))});
  const candidates = (await request.semanticTasks!.turn(request.operationId))!.queryRecovery!.scopes[0]!.fields.metrics!.candidates!;
  catalogBindingView(request, {items: candidates.map((item, index) => ({code: item.code, name: item.value, binding_ref: `signed-${index}`}))});
  // 同样的自选提议不被当作确认；目录齐备后直接按原目标展开全部读取，不反复依赖模型纠错。
  const ready = await resolve(request, attempt);
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready", pending_questions: [], answer_receipts: []});
  const savedPlan = (await request.semanticTasks!.plan(ready.details.state!.task_ref!))!;
  const task = (await request.semanticTasks!.get(savedPlan.steps[0]!.taskRef!))!;
  const plan = task.target.fields.plan!.resolvedValue as {steps: Array<{metric_refs: string[]}>};
  expect(plan.steps[0]!.metric_refs).toHaveLength(5);
  expect((await request.semanticTasks!.question(question.question_id, question.version))?.binding.receipts).toEqual([]);
});

it("机构歧义不能通过并列指标绕过，仍只确认实际机构", async () => {
  const {f, request, input} = await parallelSetup();
  request.originalMessage = "未定机构2025年末合成存款信息";
  const original = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "organization"
    ? {status: "needs_confirmation", candidates: [{code: "O1", value: "合成机构甲"}, {code: "O2", value: "合成机构乙"}]}
    : original(...args));
  input.targets[0]!.operations[0] = {action: "set", field: "organizations", value: "未定机构"};
  const result = await resolve(request, input);
  expect(result.details).toMatchObject({status: "needs_user"});
  expect(result.details).not.toHaveProperty("query_recovery");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("自动展开不改写用户真实选择，也不能丢弃重提中的日期变更", async () => {
  const {f, request, candidates, input} = await parallelSetup();
  await resolve(request, input);
  catalogBindingView(request, {items: candidates.map((item, index) => ({code: item.code, name: item.value, binding_ref: `signed-${index}`}))});
  Object.assign(f.backend, {analysisValidate: vi.fn(async () => ({valid: true}))});
  const retry = proposal([{action: "clear", field: "time"}], {kind: "current"});
  request.trustedAnswers = [{question_id: "trusted-user-click", version: 1, choice: {type: "accept"}}];
  expect(await normalizeParallelMetricProposal(request, retry)).toBe(retry);
  request.trustedAnswers = [];
  const result = await resolve(request, retry);
  expect(JSON.stringify(result.details)).toContain("QUERY_RECOVERY_SCOPE_CHANGED");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("基础身份、日期、单一口径要求或超预算候选不被自动当作可并列数值", () => {
  const candidates = [{code: "P1", value: "合成存款余额"}, {code: "P2", value: "合成存款增幅"}];
  const field = {rawValue: "合成存款", resolutionStatus: "needs_confirmation" as const, source: "explicit" as const, candidates};
  expect(parallelMetricAlternatives(field, "合成存款信息")).toHaveLength(2);
  expect(parallelMetricAlternatives({...field, candidates: candidates.map(item => ({...item, metadata: {kind: "base"}}))}, "合成存款信息")).toEqual([]);
  expect(parallelMetricAlternatives({...field, candidates: candidates.map(item => ({...item, metadata: {calendar: {start: "2025-12-31"}}}))}, "合成存款信息")).toEqual([]);
  expect(parallelMetricAlternatives(field, "合成存款信息，只要一个口径")).toEqual([]);
  expect(parallelMetricAlternatives({...field, candidates: Array.from({length: 13}, (_, i) => ({code: `P${i}`, value: `合成存款${i}`}))}, "合成存款信息")).toEqual([]);
});

it("零命中转目录发现，预算保存在原生账本，重复提议和重新建store均不能重置", async () => {
  const f = await setup(), request = f.request("recover", goal);
  const first = await resolve(request);
  expect(first.details).toMatchObject({status: "needs_interpretation", continuation: {actor: "pi", action: "discover_query"},
    query_recovery: {attempt: 1, max_attempts: 2, original_goal: goal, unresolved_metrics: ["存款记录"]}});
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
  request.semanticTasks = new NativeSemanticTaskStore(f.session);
  expect((await resolve(request)).details).toMatchObject({query_recovery: {attempt: 2}});
  const exhausted = await resolve(request);
  expect(exhausted.details).toMatchObject({status: "needs_user", continuation: {actor: "user"}});
  expect(exhausted.details).not.toHaveProperty("query_recovery");
  expect((await request.semanticTasks.turn(request.operationId))?.queryRecovery?.attempts).toBe(2);
});

it("真实口径歧义仍要求确认，完整查询的无记录结果不被当作语义失败", async () => {
  const f = await setup(), request = f.request("ambiguous", "查询合成机构甲2025年末的待定指标");
  const ambiguous = await resolve(request, proposal(complete().map(op => op.field === "metrics" ? {...op, value: "待定指标"} : op)));
  expect(ambiguous.details).toMatchObject({status: "needs_user"});
  expect(ambiguous.details).not.toHaveProperty("query_recovery");
  const exact = f.request("exact");
  const ready = await resolve(exact, proposal(complete()));
  expect(ready.details).toMatchObject({status: "ready"});
  const done = await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state?.task_ref,
    target_ref: ready.details.state?.targets[0]?.target_ref}, exact);
  expect(done.details.status).toBe("succeeded");
  expect(done.details).not.toHaveProperty("query_recovery");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("仅准备条件不转为执行型分析，保留原准备流程", async () => {
  const f = await setup(), request = f.request("prepare-only", `只准备查询条件，不执行：${goal}`);
  const result = await resolve(request, {...missing(), intent: "prepare"});
  expect(result.details).toMatchObject({status: "needs_user"});
  expect(result.details).not.toHaveProperty("query_recovery");
  expect((await request.semanticTasks!.turn(request.operationId))?.queryRecovery).toBeUndefined();
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("时间仍待模型修正时先修正日历，不提前冻结错误范围或消耗目录恢复预算", async () => {
  const f = await setup(), request = f.request("calendar", "合成机构甲模糊时间的存款记录");
  const result = await resolve(request, proposal(missing().targets[0]!.operations.map(op => op.field === "time" ? {...op, value: "模糊时间"} : op)));
  expect(JSON.stringify(result.details)).toContain("TIME_EXPRESSION_UNSUPPORTED");
  expect(result.details).not.toHaveProperty("query_recovery");
  expect((await request.semanticTasks!.turn(request.operationId))?.queryRecovery).toBeUndefined();
});

it("目录证据可升级为同目标通用分析，自动继承已经核验的机构和精确日期", async () => {
  const f = await setup(), request = f.request("upgrade", goal);
  const validate = vi.fn(async () => ({valid: true}));
  const execute = vi.fn(async () => ({kind: "analysis_evidence", status: "succeeded", delivery: "business_evidence_v1",
    run_ref: "synthetic-recovery", scope_id: "synthetic", org_codes: ["O1"], tasks: [], rows: [], gaps: [], evidence_items: [], metric_descriptors: []}));
  Object.assign(f.backend, {analysisValidate: validate, analysisExecute: execute});
  await resolve(request);
  catalogBindingView(request, {items: [{code: "SYNTH_DEPOSIT", binding_ref: "signed-deposit"}]});
  const ready = await resolve(request, analysis());
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  const done = await runTool(createSemanticExecuteTool(), {task_ref: ready.details.state?.task_ref,
    target_ref: ready.details.state?.targets[0]?.target_ref}, request);
  expect(done.details.status, JSON.stringify(done.details)).toBe("succeeded");
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({org_codes: ["O1"],
    start: "2025-12-31", end: "2025-12-31", plan: expect.objectContaining({steps: [expect.objectContaining({metric_refs: ["signed-deposit"]})]})}), expect.any(String), expect.anything());
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("恢复中把候选全名塞回query时返回改用目录引用的精确反馈，不清空为让用户补指标", async () => {
  const f = await setup(), request = f.request("candidate-as-query", goal);
  await resolve(request);
  catalogBindingView(request, {items: [{code: "M1", name: "合成指标甲", binding_ref: "signed-deposit"}]});
  const result = await resolve(request, proposal(complete()));
  expect(result.details).toMatchObject({status: "needs_interpretation", issues: expect.arrayContaining([
    expect.objectContaining({code: "QUERY_RECOVERY_ANALYSIS_REQUIRED", remediation: "pi"}),
  ])});
  expect(JSON.stringify(result.details.issues)).not.toContain("FIELD_REQUIRED");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each(["organizations", "time"])("升级分析不能清除%s后使用默认值", async field => {
  const f = await setup(), request = f.request("clear", goal);
  await resolve(request);
  const input = analysis();
  const result = await resolve(request, {...input, targets: [{...input.targets[0], operations: [{action: "clear", field}]}]});
  expect(JSON.stringify(result.details)).toContain("QUERY_RECOVERY_SCOPE_CHANGED");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it.each([403, 503])("权限或基础设施错误不进入语义恢复：HTTP %s", async status => {
  const f = await setup(), request = f.request(`backend-${status}`, goal);
  const original = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation((...args) => {
    if (args[0] === "organization") throw new BackendApiError(status, "SYNTHETIC_ERROR", "synthetic");
    return original(...args);
  });
  const result = await resolve(request);
  expect(result.details).not.toHaveProperty("query_recovery");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("原问题包含上月末时，升级复用核验后的单日，不被分析解析器重解释成整个月", async () => {
  const f = await setup(), request = f.request("month-end", "查询合成机构甲上月末的存款记录");
  const original = f.backend.resolveBusinessField.getMockImplementation()!;
  f.backend.resolveBusinessField.mockImplementation(async (...args) => args[0] === "date"
    ? {status: "resolved", value: {start: args[1][0] === "上月末" ? "2026-09-30" : "2026-09-01", end: "2026-09-30"},
      metadata: {source_calendar: {ranges: [{start: "2026-09-30", end: "2026-09-30"}], unresolved: []}}}
    : original(...args));
  Object.assign(f.backend, {analysisValidate: vi.fn(async () => ({valid: true}))});
  const input = proposal(missing().targets[0]!.operations.map(op => op.field === "time" ? {...op, value: "上月末"} : op));
  expect((await resolve(request, input)).details).toHaveProperty("query_recovery");
  catalogBindingView(request, {items: [{code: "SYNTH_DEPOSIT", binding_ref: "signed-deposit"}]});
  const ready = await resolve(request, analysis());
  expect(ready.details, JSON.stringify(ready.details)).toMatchObject({status: "ready"});
  const plan = (await request.semanticTasks!.plan(ready.details.state!.task_ref!))!;
  const task = (await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  expect(task.target.fields.time?.resolvedValue).toEqual({start: "2026-09-30", end: "2026-09-30"});
});

it("排名目标不能降级为普通观察，恢复必须修复原查询操作", async () => {
  const f = await setup(), request = f.request("ranking", `${goal}前3名`);
  const input = {protocol_version: 2, intent: "query", targets: [{source: {kind: "new"}, query: {
    organizations: {kind: "named", names: ["合成机构甲"]}, metrics: ["存款记录"],
    time: {expression: "2025年末"}, selection: "exact", operation: {kind: "ranking", position: "top", top_n: 3}}}]};
  const first = await resolve(request, input);
  expect(first.details, JSON.stringify(first.details)).toHaveProperty("query_recovery");
  const result = await resolve(request, analysis());
  expect(JSON.stringify(result.details)).toContain("QUERY_RECOVERY_OPERATION_REQUIRED");
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("发现阶段只允许有限目录尝试，成功后立即重新规划；新正式回执结束恢复", () => {
  const feedback = {protocol_version: 2, status: "needs_interpretation", issues: [], state: {targets: []},
    query_recovery: {attempt: 1, max_attempts: 2, original_goal: goal, unresolved_metrics: ["存款记录"], retained_conditions: [], fallback_answer: "请确认口径"}};
  const tool = (name: string, details: unknown) => ({role: "toolResult" as const, toolName: name,
    toolCallId: "synthetic", content: [], details, isError: false, timestamp: 1});
  const start = tool("resolve_business_turn", feedback);
  expect(queryRecoveryPhase([start])?.tool).toBe("analysis_catalog");
  expect(queryRecoveryPhase([start, tool("analysis_catalog", {status: "succeeded"})])?.tool).toBe("resolve_business_turn");
  expect(queryRecoveryPhase([start, tool("analysis_catalog", {status: "failed"}), tool("analysis_catalog", {status: "failed"})])?.tool).toBe("resolve_business_turn");
  expect(queryRecoveryPhase([start, tool("resolve_business_turn", {...feedback, status: "needs_user"})])).toBeUndefined();
});

it("净增基期未指定时并列已有正式比较，不能只用环比；用户明确基期时仍按其选择", async () => {
  const f = await setup(), request = f.request("basis", `${goal}净增多少？`);
  catalogBindingView(request, {items: ["mom", "yoy", "ytd"].map((comparison, index) => ({
    code: `D${index}`, name: `合成正式差额${index}`, binding_ref: `signed-${index}`,
    analysis_hint: {topic: "isolated", topic_name: "隔离测试", section: "growth", metric_id: "total", comparison,
      comparison_role: "difference", default_sections: ["growth"]},
  }))});
  const fields = {};
  const plan = analysis().targets[0]!.analysis.plan;
  expect(() => assertRecoveryComparisonBasis(request, fields, plan)).toThrow("QUERY_RECOVERY_COMPARISON_BASIS_REQUIRED");
  const all = {...plan, steps: [{...plan.steps[0]!, metric_refs: ["k1", "k2", "k3"]}]};
  expect(() => assertRecoveryComparisonBasis(request, fields, all)).not.toThrow();
  request.originalMessage += "较年初";
  expect(() => assertRecoveryComparisonBasis(request, fields, plan)).not.toThrow();
  // 普通分析不经过基础查询恢复，不引入新的固定必查清单。
  request.originalMessage = `${goal}净增多少？`;
  expect(() => assertRecoveryComparisonBasis(request, undefined, plan)).not.toThrow();
});
