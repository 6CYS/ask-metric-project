import {describe, expect, it} from "vitest";
import type {Entry, LaneSnapshot, OperationResultRecord} from "@earendil-works/pi-agent-core";
import type {AssistantMessage} from "@earendil-works/pi-ai";
import {MODEL_FIRST_RESPONSE_TIMEOUT} from "../src/models.js";
import {projectEntries, projectSnapshot} from "../src/sessionProjection.js";

const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
function user(id = "user", parentId: string | null = null): Entry {
  const message = {role: "user" as const, content: [{type: "text" as const, text: "查看机构变化"}],
    timestamp: 0, businessProtocol: "semantic_v2"};
  return {id, parentId, seq: 1, timestamp: 0, type: "message", message};
}
function assistant(id: string, parentId: string, patch: Partial<AssistantMessage> = {}): Entry {
  return {id, parentId, seq: 2, timestamp: 0, type: "message", message: {
    role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test",
    timestamp: 0, usage, stopReason: "stop", ...patch,
  }};
}
const failure = (id = "failed", parentId = "user") => assistant(id, parentId, {
  stopReason: "error", errorMessage: `${MODEL_FIRST_RESPONSE_TIMEOUT}: test timeout`,
});

const recovered = (parentId = "failed", stopReason: "stop" | "toolUse" = "stop") => assistant("recovered", parentId, {
  stopReason, content: [{type: "toolCall", id: "report-call", name: "analysis_report_present", arguments: {body: "已核验事实"}}],
});
function delivery(parentId = "recovered"): Entry {
  return {id: "report", parentId, seq: 3, timestamp: 0, type: "message", message: {
    role: "toolResult", toolCallId: "report-call", toolName: "analysis_report_present", isError: false,
    timestamp: 0, content: [{type: "text", text: "正式报告正文"}],
    details: {kind: "business_report", status: "succeeded", delivery: "business_evidence_v1",
      answer_policy: "verified_report_v1", public_answer: "正式报告正文"},
  }};
}

describe("同轮模型重试的历史投影", () => {
  it.each(["stop", "toolUse"] as const)("%s 的合法重试响应覆盖中间失败，保留正式报告及原生记录", stopReason => {
    const entries = [user(), failure(), recovered("failed", stopReason), delivery()];
    const original = structuredClone(entries);
    const messages = projectEntries(entries);
    expect(messages.some(message => message.entry_id === "failed")).toBe(false);
    expect(messages.filter(message => message.role === "assistant" && message.text.trim()))
      .toMatchObject([{role: "assistant", text: "正式报告正文"}]);
    expect(entries).toEqual(original);
  });

  it("连续失败后恢复，只隐藏被同一父子链成功覆盖的失败", () => {
    const messages = projectEntries([user(), failure(), failure("failed-again", "failed"),
      recovered("failed-again"), delivery()]);
    expect(messages.some(message => message.role === "assistant" && message.error)).toBe(false);
    expect(messages.at(-1)).toMatchObject({text: "正式报告正文"});
  });

  it("有实际文本的正常重试也能覆盖失败", () => {
    const messages = projectEntries([user(), failure(), assistant("text-retry", "failed", {
      content: [{type: "text", text: "已经完成响应。"}],
    })]);
    expect(messages.some(message => message.entry_id === "failed")).toBe(false);
    expect(messages.some(message => message.entry_id === "text-retry")).toBe(true);
  });

  it.each([
    [failure()],
    [failure(), failure("exhausted", "failed")],
    [failure(), assistant("cancelled", "failed", {stopReason: "aborted"})],
    [failure(), assistant("empty", "failed")],
    [failure(), assistant("truncated", "failed", {stopReason: "length", content: [{type: "text", text: "未完成"}]})],
    [failure(), delivery("failed")],
    [failure(), recovered("unrelated")],
  ])("终态失败、取消或没有关联的进展不隐藏错误：%j", (...tail) => {
    expect(projectEntries([user(), ...tail]).some(message => message.entry_id === "failed")).toBe(true);
  });

  it("用户取消仍显示停止，之后成功不把取消当成中间错误", () => {
    const messages = projectEntries([user(), assistant("cancelled", "user", {
      stopReason: "aborted", errorMessage: "cancelled",
    }), recovered("cancelled"), delivery()]);
    expect(messages.find(message => message.entry_id === "cancelled"))
      .toMatchObject({role: "assistant", text: "已停止生成。"});
  });

  it("较早响应恢复后发生新的终态错误，仍显示最后失败", () => {
    const messages = projectEntries([user(), failure(), recovered(), delivery(), failure("terminal", "report")]);
    expect(messages.some(message => message.entry_id === "failed")).toBe(false);
    expect(messages.find(message => message.entry_id === "terminal"))
      .toMatchObject({role: "assistant", error: expect.stringContaining("响应超时")});
  });

  it("新用户回合成功不会覆盖上一回合的错误", () => {
    const messages = projectEntries([user(), failure(), user("next-user", "failed"), recovered("next-user"), delivery()]);
    expect(messages.some(message => message.entry_id === "failed")).toBe(true);
    expect(messages.at(-1)).toMatchObject({text: "正式报告正文"});
  });

  it("GET 使用的条目投影和重连快照保留相同的最终消息", () => {
    const entries = [user(), failure(), recovered(), delivery()];
    const snapshot = {transcript: entries, operation: null} as LaneSnapshot;
    const projected = projectSnapshot(snapshot);
    expect(projected.messages).toEqual(projectEntries(entries));
    expect(projected.messages.some(message => message.entry_id === "failed")).toBe(false);
    expect(projected).toMatchObject({running: false, operation_id: null});
  });
});

describe("原生取消终态的历史投影", () => {
  function stopped(tipId: string, patch: Partial<OperationResultRecord> = {}): OperationResultRecord {
    return {operationId: "cancelled-operation", kind: "run", status: "aborted", fromTipId: null,
      tipId, startedAt: 1, endedAt: 20, ...patch};
  }
  const toolStart = assistant("search-start", "user", {stopReason: "toolUse", content: [
    {type: "toolCall", id: "search-call", name: "metric_search", arguments: {keywords: ["存款"]}},
  ]});
  const toolAbort: Entry = {id: "search-abort", parentId: "search-start", seq: 3, timestamp: 19,
    type: "message", message: {role: "toolResult", toolCallId: "search-call", toolName: "metric_search",
      isError: true, timestamp: 19, content: [{type: "text", text: "Abort requested"}]}};

  it.each([
    ["模型尚未产生消息", [user()], "user"],
    ["工具执行中", [user(), toolStart, toolAbort], "search-abort"],
  ] as const)("%s停止后，刷新从原生结果恢复停止提示且不改写记录", (_phase, entries, tip) => {
    const transcript = [...entries];
    const original = structuredClone(transcript);
    const messages = projectEntries(transcript, [stopped(tip)]);
    expect(messages.at(-1)).toMatchObject({role: "assistant", text: "已停止生成。", timestamp: 20});
    expect(messages.filter(item => item.role === "assistant" && item.text.trim())).toHaveLength(1);
    expect(transcript).toEqual(original);
  });

  it("停止后继续追问，旧停止提示仍在原轮次且不覆盖新回答", () => {
    const entries = [user(), toolStart, toolAbort, user("next-user", "search-abort"),
      recovered("next-user"), delivery()];
    const messages = projectEntries(entries, [stopped("search-abort")]);
    const nextUser = messages.findIndex(item => item.entry_id === "next-user");
    expect(messages[nextUser - 1]).toMatchObject({role: "assistant", text: "已停止生成。"});
    expect(messages.at(-1)).toMatchObject({text: "正式报告正文"});
  });

  it("模型已有取消消息时不补第二份停止，正式回答也不被取消记录覆盖", () => {
    const cancelled = [user(), assistant("cancelled", "user", {stopReason: "aborted"})];
    expect(projectEntries(cancelled, [stopped("cancelled")])
      .filter(item => item.role === "assistant" && item.text.trim())).toHaveLength(1);
    expect(projectEntries([user(), recovered("user"), delivery()], [stopped("report")])
      .filter(item => item.role === "assistant" && item.text.trim()))
      .toMatchObject([{text: "正式报告正文"}]);
  });

  it.each([
    {status: "failed"}, {status: "completed"}, {kind: "compaction"}, {tipId: "other-branch"},
    {fromTipId: "search-abort"},
  ] satisfies Partial<OperationResultRecord>[])("不把服务失败、其他分支或无新输入操作伪造成停止：%j", patch => {
    const entries = [user(), toolStart, toolAbort];
    expect(projectEntries(entries, [stopped("search-abort", patch)]))
      .toEqual(projectEntries(entries));
  });

  it("重连快照使用同一取消投影，后续活动回合不清除历史停止提示", () => {
    const entries = [user(), toolStart, toolAbort, user("next-user", "search-abort")];
    const snapshot = {transcript: entries, operation: {id: "next-operation"}} as LaneSnapshot;
    const results = [stopped("search-abort")];
    expect(projectSnapshot(snapshot, results).messages).toEqual(projectEntries(entries, results));
    expect(projectSnapshot(snapshot, results).messages.at(-2)).toMatchObject({text: "已停止生成。"});
  });
});
