import {afterEach, describe, expect, it, vi} from "vitest";
import type {HarnessEvent} from "@earendil-works/pi-agent-core";
import type {AssistantMessage} from "@earendil-works/pi-ai";
import {AnswerStreamProjector} from "./answerStream.js";
import {CONVERSATION_REPLY} from "./tools/turnContract.js";

function event(content: AssistantMessage["content"], type = "text_delta", end?: string): HarnessEvent {
  const message = {role: "assistant", content, stopReason: end ?? "pending"};
  return (end ? {type: "message_end", message} : {type: "message_update", message,
    event: {type, partial: message, contentIndex: 0}, frame: {type, contentIndex: 0}}) as HarnessEvent;
}
const text = (s: string, end?: string) => event([{type: "thinking", thinking: "隐藏思考"}, {type: "text", text: s}], "text_delta", end);
const call = (name: string, answer?: unknown) => ({type: "toolCall" as const, id: name, name, arguments: {answer}});
const stream = {callSeq: 1, mode: "text" as const};
afterEach(() => vi.useRealTimers());

describe("临时回答投影", () => {
  it("只读原生消息与参数，不改写用于模型和存档的内容", () => {
    const send = vi.fn(); const projector = new AnswerStreamProjector(send, 0);
    const source = event([call(CONVERSATION_REPLY, "原始回答")], "toolcall_delta");
    const original = structuredClone(source);
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      Object.freeze(value); Object.values(value).forEach(freeze);
    };
    freeze(source);
    projector.onWatchEvent(source, {callSeq: 1, mode: "reply"});
    expect(send).toHaveBeenCalledWith("answer_delta", {call_seq: 1, mode: "reply", text: "原始回答"});
    expect(source).toEqual(original); projector.close();
  });
  it("累计文本节流合并，结束时补齐最后一帧，不泄漏隐藏思考", () => {
    vi.useFakeTimers();
    const send = vi.fn(); const projector = new AnswerStreamProjector(send, 80);
    projector.onWatchEvent(text("第"), stream);
    projector.onWatchEvent(text("第一段"), stream);
    projector.onWatchEvent(text("第一段，第二段"), stream);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(80);
    expect(send).toHaveBeenLastCalledWith("answer_delta", {call_seq: 1, mode: "text", text: "第一段，第二段"});
    projector.onWatchEvent(text("第一段，第二段。", "stop"), stream);
    expect(send).toHaveBeenLastCalledWith("answer_delta", {call_seq: 1, mode: "text", text: "第一段，第二段。"});
    expect(JSON.stringify(send.mock.calls)).not.toContain("隐藏思考");
    projector.close();
    vi.runAllTimers(); expect(send).toHaveBeenCalledTimes(3);
  });

  it("正文后的工具调用撤回并停止该次调用，即使后续还有正文", () => {
    const send = vi.fn(); const projector = new AnswerStreamProjector(send);
    projector.onWatchEvent(text("临时计划"), stream);
    projector.onWatchEvent(event([call("catalog")], "toolcall_start"), stream);
    expect(send).toHaveBeenLastCalledWith("answer_reset", {call_seq: 1, reason: "tool_call"});
    projector.onWatchEvent(text("后续文字", "stop"), stream);
    expect(send).toHaveBeenCalledTimes(2); projector.close();
  });

  it("仅普通回答工具的 answer 变长时展示，其他工具不展示", () => {
    const send = vi.fn(); const projector = new AnswerStreamProjector(send, 0);
    const reply = {callSeq: 1, mode: "reply" as const};
    projector.onWatchEvent(event([call("catalog", "目录参数")], "toolcall_delta"), reply);
    expect(send).not.toHaveBeenCalled();
    projector.onWatchEvent(event([call(CONVERSATION_REPLY, "你")], "toolcall_start"), reply);
    projector.onWatchEvent(event([call(CONVERSATION_REPLY, "你好")], "toolcall_delta"), reply);
    projector.onWatchEvent(event([call(CONVERSATION_REPLY, "你好")], "toolcall_delta"), reply);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("answer_delta", {call_seq: 1, mode: "reply", text: "你好"});
    projector.close();
  });

  it("第二个工具调用撤回普通回答，纠错文本等待最终快照", () => {
    const send = vi.fn(); const projector = new AnswerStreamProjector(send);
    const reply = {callSeq: 1, mode: "reply" as const};
    projector.onWatchEvent(event([call(CONVERSATION_REPLY, "你好")], "toolcall_delta"), reply);
    projector.onWatchEvent(event([call(CONVERSATION_REPLY, "你好"), call("catalog")], "toolcall_start"), reply);
    expect(send).toHaveBeenLastCalledWith("answer_reset", {call_seq: 1, reason: "superseded"});
    projector.close();
  });

  it.each(["error", "aborted"])("%s 终态撤回，取消未发送的定时帧", reason => {
    vi.useFakeTimers(); const send = vi.fn(); const projector = new AnswerStreamProjector(send);
    projector.onWatchEvent(text("临时"), stream);
    projector.onWatchEvent(text("临时正文"), stream);
    projector.onWatchEvent(text("临时正文", reason), stream);
    expect(send).toHaveBeenLastCalledWith("answer_reset", {call_seq: 1, reason: "error"});
    vi.runAllTimers(); expect(send).toHaveBeenCalledTimes(2); projector.close();
  });

  it("重试沿用调用号，撤回旧尝试后重新累计", () => {
    const send = vi.fn(); const projector = new AnswerStreamProjector(send);
    projector.onWatchEvent(text("旧尝试"), stream);
    projector.retry(1);
    expect(send).toHaveBeenLastCalledWith("answer_reset", {call_seq: 1, reason: "retry"});
    projector.onWatchEvent(text("新尝试"), stream);
    expect(send).toHaveBeenLastCalledWith("answer_delta", {call_seq: 1, mode: "text", text: "新尝试"});
    projector.close();
  });

  it("普通回答被工具拒绝后进入新调用，先撤回再展示新回答", () => {
    const send = vi.fn(); const projector = new AnswerStreamProjector(send);
    projector.onWatchEvent(event([call(CONVERSATION_REPLY, "旧回答")], "toolcall_delta", "toolUse"), {callSeq: 1, mode: "reply"});
    projector.onWatchEvent(text("新回答"), {callSeq: 2, mode: "text"});
    expect(send.mock.calls.map(item => item[0])).toEqual(["answer_delta", "answer_reset", "answer_delta"]);
    projector.close();
  });

  it("none、无模式与非助手事件不推送，关闭后定时器也不再推送", () => {
    vi.useFakeTimers(); const send = vi.fn(); const projector = new AnswerStreamProjector(send);
    projector.onWatchEvent(text("忽略"), undefined);
    projector.onWatchEvent(text("忽略"), {callSeq: 1, mode: "none"});
    projector.onWatchEvent({type: "message_end", lane: "main", message: {role: "user", content: "用户原文", timestamp: 0}}, {callSeq: 2, mode: "text"});
    expect(send).not.toHaveBeenCalled();
    projector.onWatchEvent(text("首帧"), {callSeq: 2, mode: "text"});
    projector.onWatchEvent(text("最后一帧"), {callSeq: 2, mode: "text"});
    projector.close(); vi.runAllTimers();
    projector.onWatchEvent(text("不再发送", "stop"), {callSeq: 2, mode: "text"});
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("投影或发送异常不抛出，记录脱敏日志并禁用后续推送", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(() => {throw new Error("内部错误");});
    const projector = new AnswerStreamProjector(send);
    expect(() => projector.onWatchEvent(text("正文"), stream)).not.toThrow();
    projector.onWatchEvent(text("新正文"), stream);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("answer_stream_failed"));
    expect(log.mock.calls.join("")).not.toContain("内部错误");
    log.mockRestore(); projector.close();
  });
});
