import {expect, it, vi} from "vitest";
import type {Entry} from "@earendil-works/pi-agent-core";
import {projectEntries, projectQuestionStates, projectWatchEvent, type ProjectedMessage} from "../src/sessionProjection.js";
import {semanticFeedback} from "../src/semantic-task/feedback.js";
import type {PendingQuestion} from "../src/semantic-task/questions.js";

const question = (id: string): PendingQuestion => ({question_id: id, version: 1,
  scope: {task_ref: "plan", target_ref: "target", field: "metrics", item_ref: "item"},
  prompt: "请选择指标", selection_mode: "single", options: [{option_id: `${id}-opt`, no: 1, label: "合成指标"}],
  status: "open", issued_operation_id: "issued", kind: "choice"});
const toolMessage = (id: string, details: unknown): ProjectedMessage => ({role: "tool", tool: "resolve_business_turn",
  tool_call_id: id, details, is_error: false, timestamp: 1, entry_id: id});

it("纯点击原生 content 保持为空，页面用户消息只读宿主展示文字", () => {
  const entry = {id: "click", parentId: null, seq: 1, timestamp: 1, type: "message", message: {
    role: "user", content: "", timestamp: 1, businessProtocol: "semantic_v2",
    clickAnswers: [{question_id: "q1", version: 1, choice: {type: "select", option_ids: ["opt-1"]}}],
    displayText: "选择第 1 项「合成指标」",
  }} as Entry;
  expect(projectEntries([entry])).toEqual([{role: "user", text: "选择第 1 项「合成指标」", timestamp: 1, entry_id: "click"}]);
});

it("question_states 同时读取直接与 semantic_task 包装回执，且实时包装保留原字段", async () => {
  const direct = semanticFeedback(undefined, "needs_user");
  direct.pending_questions = [question("q-direct")];
  const wrapped = semanticFeedback(undefined, "succeeded");
  wrapped.answer_receipts = [{question_id: "q-wrapped", version: 1, outcome: "applied", notice: "已确认"}];
  const states = vi.fn(async (ids: readonly string[]) => ids.map((id, index) => ({question_id: id, version: index + 2, status: "answered" as const})));
  const result = await projectQuestionStates([
    toolMessage("direct", direct), toolMessage("wrapped", {kind: "catalog", semantic_task: wrapped}),
  ], {questionStates: states});
  expect(states).toHaveBeenCalledWith(["q-direct", "q-wrapped"]);
  expect(result).toEqual([
    {question_id: "q-direct", version: 2, status: "answered"},
    {question_id: "q-wrapped", version: 3, status: "answered"},
  ]);

  const native = {...wrapped, state: {...wrapped.state, evidence: {kind: "catalog", status: "catalog"}}};
  expect(projectWatchEvent({type: "tool_end", toolName: "resolve_business_turn", toolCallId: "wrapped",
    result: {details: native}})).toMatchObject({details: {kind: "catalog", semantic_task: {
      answer_receipts: [{question_id: "q-wrapped"}], pending_questions: [],
    }}});
  expect(projectWatchEvent({type: "tool_end", toolName: "resolve_business_turn", toolCallId: "direct",
    result: {details: direct}})).toMatchObject({details: {pending_questions: [{question_id: "q-direct"}]}});
});

it("question_states 最多定向读取 100 个最近可见问题，脱敏后不读取也不补状态", async () => {
  const messages = Array.from({length: 101}, (_, index) => {
    const feedback = semanticFeedback(undefined, "needs_user");
    feedback.pending_questions = [question(`q-${index}`)];
    return toolMessage(`tool-${index}`, feedback);
  });
  const states = vi.fn(async (ids: readonly string[]) => ids.map(id => ({question_id: id, version: 1, status: "open" as const})));
  const projected = await projectQuestionStates(messages, {questionStates: states});
  expect(states.mock.calls[0]?.[0]).toHaveLength(100);
  expect(states.mock.calls[0]?.[0][0]).toBe("q-1");
  expect(projected).toHaveLength(100);

  states.mockClear();
  await expect(projectQuestionStates([toolMessage("redacted", {status: "denied", history_redacted: true})], {questionStates: states}))
    .resolves.toEqual([]);
  expect(states).not.toHaveBeenCalled();
});
