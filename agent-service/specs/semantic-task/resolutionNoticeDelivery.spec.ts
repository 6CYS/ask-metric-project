import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT, type AgentMessage, type LaneSnapshot} from "@earendil-works/pi-agent-core";
import {BackendApiError, type AnswerBlock, type BackendClient} from "../../src/backendClient.js";
import {withOrgResolutionNotices} from "../../src/business-context/resolutionNotice.js";
import {authorizeHistory} from "../../src/routes.js";
import {projectEntries, projectSnapshot, projectWatchEvent} from "../../src/sessionProjection.js";
import {prepareDirectQueryDelivery, readDirectAnswerSnapshot, type DirectAnswerSnapshot} from "../../src/semantic-task/directDelivery.js";
import type {SemanticFeedback} from "../../src/semantic-task/feedback.js";
import {projectSemanticFeedback} from "../../src/semantic-task/modelView.js";
import {createSemanticExecuteTool, createSemanticReadTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";
import {addPlanBackend, complete, fixture, proposal} from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {vi.spyOn(console, "info").mockImplementation(() => {});});
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
const alias = "合成机构加", official = "合成机构甲";
const notice = `已按「${official}」查询（您说的是「${alias}」）`;
const row = {org_code: "O1", org_name: official, metric_code: "M1", metric_name: "合成指标甲", stat_date: "2025-12-31",
  metric_value: "9007199254740993.1200", unit: "元"};
const formalAnswer = "2025-12-31，合成机构甲的合成指标甲为9007199254740993.1200元。";
const formalBlocks: AnswerBlock[] = [{type: "paragraph", segments: [{text: formalAnswer, bold: false}]}];
const batch = (name: string, args: Record<string, unknown>, id = "notice-call"): AgentMessage[] => [{role: "assistant",
  content: [{type: "toolCall", id, name, arguments: args}], api: "openai-completions", provider: "synthetic", model: "synthetic",
  usage: {input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, stopReason: "toolUse", timestamp: 1}];
const delivered = (feedback: SemanticFeedback, snapshot: DirectAnswerSnapshot): SemanticFeedback =>
  ({...feedback, continuation: {actor: "none", action: "deliver_saved_answer"}, direct_answer: snapshot});
const textOf = (blocks: AnswerBlock[]) => blocks.flatMap(block => block.type === "paragraph" ? block.segments.map(segment => segment.text) : []).join("\n");

async function successful(source: "corrected" | "model_inferred") {
  const f = await fixture(); cleanup.push(f.close);
  const planBackend = addPlanBackend(f.backend);
  const resolve = f.backend.resolveBusinessField.getMockImplementation()!;
  // 模拟后端已完成的别名/纠错身份核验，权限来源仍由原有完整语义许可和正式结果检查决定。
  f.backend.resolveBusinessField.mockImplementation(async (entity, raw, options, year, original) => {
    const response = await resolve(entity, raw.map(value => value.replaceAll(alias, official)), options, year,
      original ? {source_question: original.source_question.replaceAll(alias, official)} : undefined);
    return entity === "organization" && response.status === "resolved" ? Object.assign(response, {metadata: {...response.metadata,
      resolution_source: source, rawExcerpt: alias,
      ...(source === "corrected" ? {corrections: [{raw: alias, corrected_name: official}]} : {})}}) : response;
  });
  Object.assign(f.backend, {
    inspectBusinessGoal: vi.fn(async (question: string) => {
      const goal = await planBackend.inspectBusinessGoal(question.replaceAll(alias, official));
      return {...goal, question, fragments: goal.fragments.map(fragment => ({...fragment,
        question: fragment.question.replaceAll(official, alias)}))};
    }),
    searchOrganizations: vi.fn(async () => ({total: 1, items: [{org_code: "O1", org_name: official, aliases: [alias], match_type: "exact"}]})),
  });
  f.backend.basicQueries.mockResolvedValue({result: {status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result",
    rows: [row], columns: Object.keys(row), row_count: 1, truncated: false, message: formalAnswer}} as unknown as Awaited<ReturnType<typeof f.backend.basicQueries>>);
  f.backend.getTaskResult.mockResolvedValue({status: "succeeded", task_id: "synthetic-query", result_id: "synthetic-result",
    rows: [row], columns: Object.keys(row), row_count: 1, truncated: false, offset: 0, has_more: false, next_offset: null,
    message: formalAnswer, answer_blocks: formalBlocks} as unknown as Awaited<ReturnType<typeof f.backend.getTaskResult>>);
  const question = `查询${alias}2025年末的合成指标甲`, request = f.request("notice-query", question);
  await request.semanticTasks!.admit(request.operationId, question, undefined, "on");
  const invocation = {invocationId: "notice-call", operationId: request.operationId, turnId: request.operationId, source: "model" as const,
    getMemo: async () => undefined, setMemo: async () => {}};
  const ready = await createSemanticResolveTool().execute("notice-call",
    proposal(complete().map(operation => operation.field === "organizations" ? {...operation, value: alias} : operation)),
    () => {}, request, invocation, BACKGROUND_CONTEXT);
  const refs = {task_ref: (ready.details as SemanticFeedback).state.task_ref!, target_ref: (ready.details as SemanticFeedback).state.targets[0]!.target_ref};
  expect((ready.details as SemanticFeedback).status).toBe("ready");
  const execution = await createSemanticExecuteTool().execute("notice-call", refs, () => {}, request, invocation, BACKGROUND_CONTEXT);
  const feedback = execution.details as SemanticFeedback;
  expect(feedback.status).toBe("succeeded");
  const qualify = () => prepareDirectQueryDelivery(request, feedback,
    {toolName: "resolve_business_turn", toolCallId: "notice-call", messages: batch("resolve_business_turn", {})});
  return {...f, request, question, feedback, refs, invocation, qualify};
}

describe.each(["corrected", "model_inferred"] as const)("机构明示与普通直出兼容：%s", source => {
  it("首问直接交付保留机构明示与精确正式结果，发送去重不会丢明示", async () => {
    const f = await successful(source), decision = await f.qualify();
    expect(decision.eligible, decision.reason).toBe(true);
    const snapshot = decision.snapshot!;
    expect(snapshot.public_answer).toBe(`${notice}\n${formalAnswer}`);
    expect(textOf(snapshot.answer_blocks)).toContain(notice);
    expect(textOf(snapshot.answer_blocks)).toContain(row.metric_value);
    const receipt = delivered(f.feedback, snapshot);
    expect(readDirectAnswerSnapshot(receipt)).toEqual(snapshot);
    const view = projectSemanticFeedback(receipt) as SemanticFeedback;
    expect(view.state.evidence?.resolution_notice).toEqual([notice]);
    expect(view.state.evidence?.public_answer).toBe(snapshot.public_answer);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });

  it("历史回读的文本与blocks同含明示，原生JSONL关闭重开及投影保持稳定且不重查", async () => {
    const f = await successful(source), firstDecision = await f.qualify();
    expect(firstDecision.eligible, firstDecision.reason).toBe(true);
    const request = {...f.request, operationId: "notice-read", requestId: "notice-read", originalMessage: "再看刚才那份结果"};
    await request.semanticTasks!.admit(request.operationId, request.originalMessage, undefined, "on");
    const result = await createSemanticReadTool().execute("notice-read-call", f.refs, () => {}, request,
      {...f.invocation, invocationId: "notice-read-call", operationId: request.operationId, turnId: request.operationId}, BACKGROUND_CONTEXT);
    const feedback = result.details as SemanticFeedback;
    expect(feedback.status).toBe("reused");
    const decision = await prepareDirectQueryDelivery(request, feedback, {toolName: "read_business_result", toolCallId: "notice-read-call",
      messages: batch("read_business_result", f.refs, "notice-read-call")});
    expect(decision.eligible, decision.reason).toBe(true);
    const snapshot = decision.snapshot!, evidence = feedback.state.evidence!;
    expect(snapshot.public_answer).toBe(`${notice}\n${formalAnswer}`);
    expect(snapshot.answer_blocks).toEqual([{type: "paragraph", segments: [{text: notice, bold: false}]}, ...formalBlocks]);
    const frame = await request.frames!.get(snapshot.sources[0]!.frame_id);
    const twice = withOrgResolutionNotices(frame!, {content: [], details: evidence});
    expect(twice.details.public_answer).toBe(snapshot.public_answer);
    expect(twice.details.public_answer_blocks).toEqual(snapshot.answer_blocks);

    // 真实SDK分支写入正式工具回执，不造助手记录；重开从JSONL重新读取同一快照。
    const branch = await f.session.createBranch("main", null, BACKGROUND_CONTEXT);
    await branch.appendMessage({role: "user", content: request.originalMessage, businessProtocol: "semantic_v2", timestamp: 1} as AgentMessage, BACKGROUND_CONTEXT);
    await branch.appendMessage(batch("read_business_result", f.refs, "notice-read-call")[0]!, BACKGROUND_CONTEXT);
    const receipt = delivered(feedback, snapshot);
    await branch.appendMessage({role: "toolResult", toolName: "read_business_result", toolCallId: "notice-read-call", isError: false,
      content: [{type: "text", text: JSON.stringify(receipt)}], details: receipt, timestamp: 2}, BACKGROUND_CONTEXT);
    const before = await branch.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT), projected = projectEntries(before);
    const count = f.backend.basicQueries.mock.calls.length, reads = f.backend.getTaskResult.mock.calls.length;
    await f.sessions.release(request.actor.id, f.session.metadata.id);
    const metadata = await f.sessions.findMetadata(request.actor.id, f.session.metadata.id);
    const reopened = await f.sessions.open(request.actor.id, metadata!), restored = await reopened.findEntries({order: "asc"}, BACKGROUND_CONTEXT);
    expect(projectEntries(restored)).toEqual(projected);
    expect(projectSnapshot({transcript: restored, operation: null} as LaneSnapshot).messages).toEqual(projected);
    const answers = projected.filter(message => message.role === "assistant" && message.text.trim());
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({text: snapshot.public_answer, entry_id: `direct:${snapshot.answer_id}`});
    expect(projectWatchEvent({type: "tool_end", toolName: "read_business_result", toolCallId: "notice-read-call", result: {details: receipt}}))
      .toMatchObject({answer: {text: snapshot.public_answer, entry_id: `direct:${snapshot.answer_id}`}});
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(count);
    expect(f.backend.getTaskResult).toHaveBeenCalledTimes(reads);
  });

  it("机构明示不能替代当前权限；直出复核403删事实，历史正文同样拒绝", async () => {
    const f = await successful(source), first = await f.qualify();
    expect(first.eligible, first.reason).toBe(true);
    f.backend.getTaskResult.mockRejectedValueOnce(new BackendApiError(403, "PERMISSION_DENIED", "synthetic denial"));
    const denied = await f.qualify();
    expect(denied).toMatchObject({eligible: false, reason: "source_permission_denied", terminalFeedback: {status: "denied"}});
    expect(denied.snapshot).toBeUndefined();
    expect(denied.terminalFeedback?.state.evidence).toBeUndefined();
    expect(readDirectAnswerSnapshot(denied.terminalFeedback)).toBeUndefined();
    const receipt = delivered(f.feedback, first.snapshot!);
    const projected = projectEntries([{type: "message", id: "notice-permission-entry", parentId: null, seq: 1, timestamp: 1,
      message: {role: "toolResult", toolName: "resolve_business_turn", toolCallId: "notice-call", details: receipt, isError: false,
        content: [{type: "text", text: JSON.stringify(receipt)}], timestamp: 1}}]);
    await expect(authorizeHistory(projected, {getTask: vi.fn(async () => {throw new BackendApiError(403, "PERMISSION_DENIED", "synthetic denial");})} as unknown as BackendClient))
      .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });
});
