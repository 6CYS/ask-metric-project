import {createHash} from "node:crypto";
import {describe, expect, it} from "vitest";
import type {Entry, LaneSnapshot} from "@earendil-works/pi-agent-core";
import {projectBusinessTasks, projectEntries, projectSnapshot, projectWatchEvent} from "../src/sessionProjection.js";
import type {DirectAnswerSnapshot} from "../src/semantic-task/directDelivery.js";

let seq = 0;
const entry = (message: Record<string, unknown>): Entry => ({type: "message", id: `direct-entry-${++seq}`, seq,
  timestamp: seq, message: {timestamp: seq, ...message}}) as unknown as Entry;
const user = () => entry({role: "user", businessProtocol: "semantic_v2", content: "查询合成机构的指标"});
const tool = (details: unknown, isError = false) => entry({role: "toolResult", toolName: "resolve_business_turn", toolCallId: "call",
  isError, details, content: [{type: "text", text: JSON.stringify(details)}]});
function feedback(count = 1) {
  const sources = Array.from({length: count}, (_, i) => ({target_ref: `target-${i}`, frame_id: `frame-${i}`,
    task_id: `task-${i}`, result_id: `result-${i}`, result_ref: `query:task-${i}:result-${i}`, row_count: 1, truncated: false as const}));
  const body: Omit<DirectAnswerSnapshot, "answer_id"> = {version: 1, renderer_version: "query_result_v1", delivery_path: "direct_query",
    operation_id: "op", plan_ref: "plan", plan_revision: 1, public_answer: count === 1 ? "合成指标为 0 元。" : "目标甲为 0 元；目标乙暂无可用值。",
    answer_blocks: [{type: "paragraph", segments: [{text: "正式回答", bold: false}]}], sources};
  const snapshot = {answer_id: "direct-answer-" + createHash("sha256").update(JSON.stringify(body)).digest("hex"), ...body};
  const evidence = sources.map(source => ({kind: "metric_query_structured", status: "succeeded", task_id: source.task_id,
    result_id: source.result_id, row_count: 1, rows: [{metric_value: "0"}], public_answer: body.public_answer}));
  return {protocol_version: 2, status: "succeeded", issues: [], continuation: {actor: "none", action: "deliver_saved_answer"},
    state: {task_ref: "plan", task_status: "completed", completion: "full", raw_message_retained: true, proposals_retained: true,
      targets: sources.map(source => ({target_ref: source.target_ref, status: "succeeded", pending: [], conditions: []})),
      evidence: count === 1 ? evidence[0] : {kind: "semantic_results", status: "succeeded", delivery: "business_evidence_v1", results: evidence}},
    direct_answer: snapshot};
}

describe("版本化普通问数直接交付投影", () => {
  it.each([1, 2])("单结果/多结果：历史、终态、重连和实时使用同一正文与稳定身份：%s", count => {
    const details = feedback(count), receipt = tool(details), entries = [user(), receipt];
    const projected = projectEntries(entries);
    const answer = projected.find(message => message.role === "assistant");
    expect(answer).toMatchObject({text: details.direct_answer.public_answer, entry_id: `direct:${details.direct_answer.answer_id}`, tools: []});
    expect(projectSnapshot({transcript: entries, operation: null} as LaneSnapshot).messages).toEqual(projected);
    expect(projectEntries(JSON.parse(JSON.stringify(entries)) as Entry[])).toEqual(projected);
    const live = projectWatchEvent({type: "tool_end", toolName: "resolve_business_turn", toolCallId: "call", result: {details}});
    expect(live).toMatchObject({type: "tool_end", answer: {...answer, timestamp: null}});
    expect(projectBusinessTasks(projected)).toHaveLength(count);
    expect(entries.filter(item => item.type === "message" && item.message.role === "assistant")).toHaveLength(0);
  });

  it("同一交付回执非相邻重放仍只显示一次，不依赖消息位置", () => {
    const details = feedback(2);
    const entries = [user(), tool(details), entry({role: "toolResult", toolName: "business_context_read", toolCallId: "side",
      details: {protocol_version: 2, context: {}}, content: []}), tool(structuredClone(details)),
      entry({role: "assistant", stopReason: "stop", content: [{type: "text", text: details.direct_answer.public_answer}]})];
    const answers = projectEntries(entries).filter(message => message.role === "assistant" && message.text);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.entry_id).toBe(`direct:${details.direct_answer.answer_id}`);
  });

  it("下一轮仍保留独立交付身份，不能误去重上一轮正式答案", () => {
    const first = feedback(), second = feedback();
    const {answer_id: _id, ...body} = second.direct_answer;
    body.operation_id = "next-operation";
    second.direct_answer = {...body, answer_id: "direct-answer-" + createHash("sha256").update(JSON.stringify(body)).digest("hex")};
    const answers = projectEntries([user(), tool(first), user(), tool(second)]).filter(message => message.role === "assistant" && message.text);
    expect(answers).toHaveLength(2); expect(new Set(answers.map(message => message.entry_id)).size).toBe(2);
  });

  it.each(["error", "aborted"])("交付后真实运行失败/取消仍暴露终态：%s", stopReason => {
    const projected = projectEntries([user(), tool(feedback()), entry({role: "toolResult", toolName: "business_context_read", content: [], details: {}}),
      entry({role: "assistant", stopReason, errorMessage: "MODEL_STREAM_FAILED", content: []})]);
    const answers = projected.filter(message => message.role === "assistant" && message.text);
    expect(answers).toHaveLength(1); expect(answers[0]?.entry_id.startsWith("direct:")).toBe(false);
    if (stopReason === "error") expect(answers[0]).toHaveProperty("error");
    else expect(answers[0]).toMatchObject({text: "已停止生成。"});
  });

  it.each(["hash", "source", "version", "continuation", "partial", "error"])("无效快照不能投影为成功回答：%s", field => {
    const details = feedback();
    if (field === "hash") details.direct_answer.public_answer = "未经正式快照确认的数值";
    if (field === "source") details.direct_answer.sources[0]!.result_ref = "query:other:result";
    if (field === "version") Object.assign(details.direct_answer, {version: 2});
    if (field === "continuation") details.continuation.action = "answer";
    if (field === "partial") details.state.completion = "partial";
    expect(projectEntries([user(), tool(details, field === "error")]).filter(message => message.role === "assistant")).toEqual([]);
    const live = projectWatchEvent({type: "tool_end", toolName: "resolve_business_turn", result: {details}, isError: field === "error"});
    expect(live).not.toHaveProperty("answer");
  });
});
