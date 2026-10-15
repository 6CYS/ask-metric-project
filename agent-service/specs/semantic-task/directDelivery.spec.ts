import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT, type AgentMessage} from "@earendil-works/pi-agent-core";
import {BackendApiError} from "../../src/backendClient.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {prepareDirectQueryDelivery, readDirectAnswerSnapshot, supportedResultOnlyQuestion, verifiedResultOnlyQuestion} from "../../src/semantic-task/directDelivery.js";
import type {SemanticFeedback} from "../../src/semantic-task/feedback.js";
import {semanticPlanDigest} from "../../src/semantic-task/planService.js";
import {complete, fixture, proposal, addPlanBackend} from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {vi.spyOn(console, "info").mockImplementation(() => {});});
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
const batch = (siblings = false): AgentMessage[] => [{role: "assistant", content: [{type: "toolCall", id: "delivery-call", name: "resolve_business_turn", arguments: {}},
  ...(siblings ? [{type: "toolCall" as const, id: "sibling", name: "catalog", arguments: {}}] : [])], api: "openai-completions", provider: "synthetic", model: "synthetic",
  usage: {input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
  stopReason: "toolUse", timestamp: 0}];
async function successful(question = "查询合成机构甲2025年末的合成指标甲", resultRows?: Record<string, unknown>[]) {
  const f = await fixture(); cleanup.push(f.close); addPlanBackend(f.backend);
  if (resultRows) {
    f.backend.basicQueries.mockResolvedValue({result: {status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result",
      columns: ["metric_value"], rows: resultRows, row_count: resultRows.length, truncated: false, message: "查询完成，请查看正式结果。"}} as unknown as Awaited<ReturnType<typeof f.backend.basicQueries>>);
    f.backend.getTaskResult.mockResolvedValue({status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result",
      columns: ["metric_value"], rows: resultRows.slice(0, 1), row_count: resultRows.length, truncated: false, has_more: resultRows.length > 1,
      offset: 0, next_offset: resultRows.length > 1 ? 1 : null} as unknown as Awaited<ReturnType<typeof f.backend.getTaskResult>>);
  }
  const request = f.request("delivery-operation", question);
  const invoke = {invocationId: "delivery-call", operationId: request.operationId, turnId: request.operationId, source: "model" as const,
    getMemo: async () => undefined, setMemo: async () => {}};
  const ready = await createSemanticResolveTool().execute("delivery-call", proposal(complete()), () => {}, request, invoke, BACKGROUND_CONTEXT);
  const feedback = ready.details as SemanticFeedback;
  expect(feedback.status).toBe("ready");
  const result = await createSemanticExecuteTool().execute("delivery-call", {task_ref: feedback.state.task_ref!, target_ref: feedback.state.targets[0]!.target_ref},
    () => {}, request, invoke, BACKGROUND_CONTEXT);
  expect((result.details as SemanticFeedback).status).toBe("succeeded");
  const settled = result.details as SemanticFeedback;
  const qualify = (value = settled, messages = batch()) => prepareDirectQueryDelivery(request, value,
    {toolName: "resolve_business_turn", toolCallId: "delivery-call", messages});
  return {...f, makeRequest: f.request, request, feedback: settled, qualify};
}

it.each([
  ["查询合成机构甲2025年末的合成指标甲", true],
  ["合成机构甲2026-05-31的合成指标甲是多少？", true],
  ["日期改成2024年末", true],
  ["新问题，不沿用之前条件：查询合成机构甲2026年6月30日的合成指标甲", true],
  ["那2026年5月31日呢，机构和指标不变", true],
  ["日期改为2026年6月30日，其他条件不变", true],
  ["机构改成合成机构甲，其余条件保持不变", true],
  ["指标换成合成指标乙，其它条件不变", true],
  ["再看刚才那份结果", true],
  ["重新展示本对话第一次查询的正式结果，不要重新查询", false],
  ["不要显示合成机构甲2025年末的合成指标甲", false],
  ["查询合成机构甲2025年末的合成指标甲，解释为什么下降", false],
  ["查询合成机构甲2025年末的合成指标甲，并给出建议", false],
  ["查询合成机构甲2025年末的合成指标甲，做个对比", false],
  ["查询合成机构甲2025年末的合成指标甲，返回JSON", false],
  ["计算合成指标甲与合成指标乙的差值", false],
  ["查合成机构甲合成指标甲，它表现如何", false],
])("仅正向覆盖语法可以直出：%s", (question, eligible) => {
  expect(supportedResultOnlyQuestion(question, ["合成机构甲", "合成指标甲", "合成指标乙"], [])).toBe(eligible);
});

it("完整正式取值资格与快照解析一致，篡改或残缺记录不能恢复成功", async () => {
  const f = await successful(), decision = await f.qualify();
  expect(decision).toMatchObject({eligible: true, reason: "complete_verified_result_only"});
  const delivered = {...f.feedback, continuation: {actor: "none", action: "deliver_saved_answer"}, direct_answer: decision.snapshot};
  expect(readDirectAnswerSnapshot(delivered)).toEqual(decision.snapshot);
  expect(readDirectAnswerSnapshot({...delivered, direct_answer: {...decision.snapshot, public_answer: "伪造数据"}})).toBeUndefined();
  expect(readDirectAnswerSnapshot({...delivered, state: {...delivered.state, targets: []}})).toBeUndefined();
  expect(readDirectAnswerSnapshot({protocol_version: 2, state: {completion: "full"}, status: "succeeded"})).toBeUndefined();
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it.each(["分析原因", "解释为什么下降", "并给出建议", "相减求差", "返回JSON"])("已成功查询不能消去附加义务：%s", async suffix => {
  const f = await successful(`查询合成机构甲2025年末的合成指标甲，${suffix}`);
  expect(await f.qualify()).toMatchObject({eligible: false, reason: "additional_or_unknown_answer_obligation"});
});

it("分析继续规划、partial、unknown与混合原生批次均不直出", async () => {
  const f = await successful();
  expect(await f.qualify({...f.feedback, continuation: {actor: "pi", action: "continue_analysis"}})).toMatchObject({eligible: false, reason: "analysis_continuation"});
  for (const status of ["unknown", "executing", "ready"]) expect((await f.qualify({...f.feedback, status})).eligible).toBe(false);
  expect((await f.qualify({...f.feedback, state: {...f.feedback.state, completion: "partial"}})).eligible).toBe(false);
  expect(await f.qualify(f.feedback, batch(true))).toMatchObject({eligible: false, reason: "mixed_native_batch"});
});

it("正式证据实际截断或渲染块异常不直出，不能用样本猜完整结果", async () => {
  const f = await successful();
  const evidence = f.feedback.state.evidence!;
  expect(await f.qualify({...f.feedback, state: {...f.feedback.state, evidence: {...evidence, truncated: true}}}))
    .toMatchObject({eligible: false, reason: "formal_evidence_incomplete"});
  expect(await f.qualify({...f.feedback, state: {...f.feedback.state, evidence: {...evidence, public_answer_blocks: [{type: "unknown"}]}}}))
    .toMatchObject({eligible: false, reason: "renderer_invalid_blocks"});
  f.backend.getTaskResult.mockResolvedValueOnce({status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result", rows: [], columns: [], row_count: 0, truncated: true});
  expect(await f.qualify()).toMatchObject({eligible: false, reason: "source_identity_or_completeness_changed", terminalFeedback: {status: "failed"}});
});

it("完整正式artifact可直出而授权probe可分页；正文证据仅页/缺行必须继续Pi", async () => {
  const f = await successful(undefined, [{metric_value: "1"}, {metric_value: "2"}]);
  expect(await f.qualify()).toMatchObject({eligible: true});
  const evidence = f.feedback.state.evidence!;
  expect(await f.qualify({...f.feedback, state: {...f.feedback.state, evidence: {...evidence, rows: [{metric_value: "1"}]}}}))
    .toMatchObject({eligible: false, reason: "formal_result_page_incomplete"});
  for (const page of [
    {rows: [{metric_value: "1"}], row_count: 2, offset: 0, has_more: true, next_offset: 1},
    {rows: [{metric_value: "2"}], row_count: 2, offset: 1, has_more: false, next_offset: null},
  ]) expect(await f.qualify({...f.feedback, state: {...f.feedback.state, evidence: {...evidence, kind: "metric_read", payloads: [page]}}}))
    .toMatchObject({eligible: false, reason: "formal_result_page_incomplete"});
});

it("交付前当前权限拒绝与复核故障均删除全部事实，不把失权数据交给模型", async () => {
  const f = await successful();
  f.backend.getTaskResult.mockRejectedValueOnce(new BackendApiError(403, "FORBIDDEN", "synthetic"));
  const denied = await f.qualify();
  expect(denied).toMatchObject({eligible: false, reason: "source_permission_denied", terminalFeedback: {status: "denied"}});
  expect(denied.terminalFeedback?.state.evidence).toBeUndefined();
  f.backend.getTaskResult.mockRejectedValueOnce(new Error("unavailable"));
  const unknown = await f.qualify();
  expect(unknown.terminalFeedback?.status).toBe("failed");
  expect(unknown.terminalFeedback?.state.evidence).toBeUndefined();
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
});

it("排名operation不能走普通取值交付", async () => {
  const f = await successful();
  const plan = (await f.request.semanticTasks!.plan(f.feedback.state.task_ref!))!;
  const task = (await f.request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  task.target.fields.operation!.resolvedValue = {kind: "ranking", position: "top", top_n: 10};
  await f.request.semanticTasks!.save(task, (await f.request.semanticTasks!.index()).version);
  expect(await f.qualify()).toMatchObject({eligible: false, reason: "unverified_value_contract"});
});

it("已准入revision变化不能直接交付", async () => {
  const f = await successful();
  const plan = (await f.request.semanticTasks!.plan(f.feedback.state.task_ref!))!;
  plan.revision++;
  await f.request.semanticTasks!.savePlan(plan, (await f.request.semanticTasks!.planIndex()).version);
  expect(await f.qualify()).toMatchObject({eligible: false, reason: "plan_not_current_or_admitted"});
});

it("机构简称只有当前目录exact身份与原文机构事实同配对时可消去，模型整句rawValue无效", async () => {
  const f = await successful();
  const plan = (await f.request.semanticTasks!.plan(f.feedback.state.task_ref!))!;
  const task = (await f.request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  const question = "查询合成简称2025年末的合成指标甲";
  const goal = {question, reference_year: null, fragments: [{question, organizations: ["O1"], calendar: {ranges: [], unresolved: []},
    mentions: (await f.backend.matchMetricQuestion(question)).mentions}]};
  const searchOrganizations = vi.fn(async () => ({total: 1, items: [{org_code: "O1", org_name: "合成机构甲", aliases: ["合成简称"], score: 100, match_type: "exact"}]}));
  Object.assign(f.backend, {searchOrganizations});
  expect(await verifiedResultOnlyQuestion(f.request, question, [task], goal)).toBe(true);
  expect(searchOrganizations).toHaveBeenCalledWith("O1", 10, expect.anything());
  expect(await verifiedResultOnlyQuestion(f.request, question + "，并解释原因", [task], goal)).toBe(false);
  task.target.fields.organizations!.rawValue = question + "，并解释原因";
  expect(await verifiedResultOnlyQuestion(f.request, question + "，并解释原因", [task], goal)).toBe(false);
  searchOrganizations.mockResolvedValueOnce({total: 1, items: [{org_code: "O2", org_name: "合成机构甲", aliases: ["合成简称"], score: 100, match_type: "exact"}]});
  expect(await verifiedResultOnlyQuestion(f.request, question, [task], goal)).toBe(false);
  searchOrganizations.mockResolvedValueOnce({total: 1, items: [{org_code: "O1", org_name: "其他机构", aliases: ["合成简称"], score: 100, match_type: "exact"}]});
  expect(await verifiedResultOnlyQuestion(f.request, question, [task], goal)).toBe(false);
  expect(await verifiedResultOnlyQuestion(f.request, question, [task], {...goal, fragments: [{...goal.fragments[0]!, organizations: []}]})).toBe(false);
});

it("目录别名复核不可用不能提供取值资格", async () => {
  const f = await successful(), plan = (await f.request.semanticTasks!.plan(f.feedback.state.task_ref!))!;
  const task = (await f.request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
  const question = "查询合成简称2025年末的合成指标甲";
  Object.assign(f.backend, {searchOrganizations: vi.fn(async () => {throw new Error("catalog unavailable");})});
  const goal = {question, reference_year: null, fragments: [{question, organizations: ["O1"], calendar: {ranges: [], unresolved: []},
    mentions: (await f.backend.matchMetricQuestion(question)).mentions}]};
  await expect(verifiedResultOnlyQuestion(f.request, question, [task], goal)).rejects.toThrow("catalog unavailable");
});

it.each(["historical_read", "current_reuse"] as const)("%s 只有纯回读且本轮明示条件完全对齐才可直出，不能忽略修改或selection义务", async mode => {
  const cases = [
    {question: "再看刚才那份结果", eligible: true},
    {question: "再看刚才那份2025年末的合成指标甲结果", eligible: true},
    {question: "再看刚才那份结果，日期改为2024年末", eligible: false},
    {question: "刚才那份2024年末的结果", eligible: false},
    {question: "再看刚才那份结果，机构改成合成机构乙", eligible: false},
    {question: "刚才那份合成指标乙的结果", eligible: false},
    {question: "刚才那份结果，列出所有日期", eligible: false},
    {question: "刚才那份结果，返回最新有值的日期", eligible: false},
    {question: "只看刚才合成机构甲的结果", eligible: false},
    {question: "不要显示刚才那份结果", eligible: false},
    {question: "不要返回刚才那份结果", eligible: false},
    {question: "不要查询刚才那份结果", eligible: false},
    {question: "再看刚才那份和第一次查询的结果", eligible: false},
    {question: "再看第一次查询和第二次查询的结果", eligible: false},
    {question: "再看第一次和第二次的结果", eligible: false},
    {question: "再看第一个和第二个的结果", eligible: false},
    {question: "再看刚才第1个结果", eligible: false},
    {question: "再看本对话第一次的结果", eligible: false},
    {question: "重新查询刚才那份结果", eligible: false},
  ];
  for (const [index, {question, eligible}] of cases.entries()) {
    const f = await successful();
    const original = (await f.request.semanticTasks!.plan(f.feedback.state.task_ref!))!;
    const request = f.makeRequest(`readonly-current-${index}`, question);
    await request.semanticTasks!.admit(request.operationId, question, undefined, "on");
    let selected = original;
    if (mode === "current_reuse") {
      selected = {...structuredClone(original), ref: `reuse-plan-${index}`, operationId: request.operationId, intent: "reuse", originalMessage: question,
        steps: original.steps.map(step => ({...structuredClone(step), source: {kind: "reference" as const, task_ref: original.ref, target_ref: step.targetRef}}))};
      selected.admitted = {operationId: request.operationId, revision: selected.revision, digest: semanticPlanDigest(selected)};
      await request.semanticTasks!.savePlan(selected, (await request.semanticTasks!.planIndex()).version);
    }
    const feedback: SemanticFeedback = {...f.feedback, state: {...f.feedback.state, task_ref: selected.ref}};
    const messages = batch();
    const assistant = messages[0]!;
    if (assistant.role !== "assistant" || assistant.content[0]?.type !== "toolCall") throw new Error("fixture batch");
    assistant.content[0].name = "read_business_result";
    assistant.content[0].arguments = {task_ref: selected.ref, target_ref: selected.steps[0]!.targetRef};
    const decision = await prepareDirectQueryDelivery(request, feedback, {toolName: "read_business_result", toolCallId: "delivery-call", messages});
    expect(decision.eligible, `${mode}: ${question} (${decision.reason})`).toBe(eligible);
    if (!eligible) {
      expect(decision.snapshot).toBeUndefined();
      expect((await request.semanticTasks!.turn(request.operationId))?.readDelivery).toBeUndefined();
    }
    expect(await request.semanticTasks!.plan(original.ref)).toEqual(original);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  }
});

it.each(["第一次", "第一次查询", "刚才那份"])("当前reuse误选来源不能跳过序号或冻结焦点核验：%s", async ordinal => {
  const f = await successful(), first = (await f.request.semanticTasks!.plan(f.feedback.state.task_ref!))!;
  const store = f.request.semanticTasks!;
  const second = {...structuredClone(first), ref: "second-query-plan", operationId: "second-query-operation"};
  second.admitted = {operationId: second.operationId, revision: second.revision, digest: semanticPlanDigest(second)};
  await store.savePlan(second, (await store.planIndex()).version, true);
  const question = ordinal === "刚才那份" ? "再看刚才那份结果" : `再看本对话${ordinal}的结果`, request = f.makeRequest("wrong-ordinal-reuse", question);
  await store.admit(request.operationId, question, undefined, "on");
  const referenced = ordinal === "刚才那份" ? first : second;
  const selected = {...structuredClone(referenced), ref: "current-wrong-reuse", operationId: request.operationId, intent: "reuse", originalMessage: question,
    steps: referenced.steps.map(step => ({...structuredClone(step), source: {kind: "reference" as const, task_ref: referenced.ref, target_ref: step.targetRef}}))};
  selected.admitted = {operationId: request.operationId, revision: selected.revision, digest: semanticPlanDigest(selected)};
  await store.savePlan(selected, (await store.planIndex()).version);
  const feedback = {...f.feedback, state: {...f.feedback.state, task_ref: selected.ref}};
  const messages = batch(), assistant = messages[0]!;
  if (assistant.role !== "assistant" || assistant.content[0]?.type !== "toolCall") throw new Error("fixture batch");
  assistant.content[0].name = "read_business_result";
  assistant.content[0].arguments = {task_ref: selected.ref, target_ref: selected.steps[0]!.targetRef};
  expect(await prepareDirectQueryDelivery(request, feedback, {toolName: "read_business_result", toolCallId: "delivery-call", messages}))
    .toMatchObject({eligible: false, reason: ordinal === "第一次" ? "read_query_ordinal_unparsed" : ordinal === "刚才那份" ? "history_read_focus_mismatch" : "history_query_ordinal_mismatch"});
});
