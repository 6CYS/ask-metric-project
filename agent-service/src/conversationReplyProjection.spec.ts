/**
 * 普通对话回执即结束本轮后的页面投影：新会话由回执投影回答，旧会话（回执后另有替换正文）不重复展示，
 * 两种记录对用户呈现一致；旧协议回合仍按原规则核验无证据数值。
 */
import {describe, expect, it} from "vitest";
import type {Entry} from "@earendil-works/pi-agent-core";
import {projectEntries} from "./sessionProjection.js";
import {EVIDENCE_BLOCKED_ANSWER} from "./replyGuard.js";
import {CONVERSATION_REPLY} from "./tools/turnContract.js";

let seq = 0;
const entry = (message: Record<string, unknown>): Entry =>
  ({type: "message", id: `e${++seq}`, seq, timestamp: 1_000 + seq, message: {timestamp: 1_000 + seq, ...message}}) as unknown as Entry;
const user = (text: string, frame = true) => entry({role: "user", content: text, ...(frame ? {businessProtocol: "frame_v1"} : {})});
const replyCall = (answer: string) => entry({role: "assistant", stopReason: "toolUse",
  content: [{type: "toolCall", id: "reply-1", name: CONVERSATION_REPLY, arguments: {answer}}]});
const replyReceipt = (answer: string, isError = false) => entry({role: "toolResult", toolName: CONVERSATION_REPLY,
  toolCallId: "reply-1", isError, content: [{type: "text", text: answer}],
  details: isError ? {kind: "turn_contract"} : {kind: "conversation_reply", status: "answered", answer}});
const finalText = (text: string, extra: Record<string, unknown> = {}) =>
  entry({role: "assistant", stopReason: "stop", content: [{type: "text", text}], ...extra});

const answers = (entries: Entry[]) => projectEntries(entries)
  .flatMap(message => message.role === "assistant" && message.text ? [message.text] : []);

describe("普通对话回答的页面投影", () => {
  const answer = "你好，我可以帮你查询经营指标、查看历史结果和解释指标口径。";

  it("新记录：回执之后没有助手消息，仍投影出一条完整回答", () => {
    const projected = projectEntries([user("你好"), replyCall(answer), replyReceipt(answer)]);
    expect(projected.at(-1)).toMatchObject({role: "assistant", text: answer, business_protocol: "frame_v1", tools: []});
    expect(answers([user("你好"), replyCall(answer), replyReceipt(answer)])).toHaveLength(1);
  });

  it("旧记录：回执后另有替换正文，只展示一次，与新记录呈现一致", () => {
    const legacy = [user("你好"), replyCall(answer), replyReceipt(answer), finalText(answer)];
    const current = [user("你好"), replyCall(answer), replyReceipt(answer)];
    expect(answers(legacy)).toEqual([answer]);
    expect(answers(legacy)).toEqual(answers(current));
  });

  it("旧记录第二次往返失败时沿用原失败展示，不被回执掩盖", () => {
    const projected = projectEntries([user("你好"), replyCall(answer), replyReceipt(answer),
      finalText("", {stopReason: "error", errorMessage: "MODEL_STREAM_FAILED: 模型响应流未完成。"})]);
    expect(projected.at(-1)).toMatchObject({role: "assistant"});
    expect((projected.at(-1) as {error?: string}).error).toBeTruthy();
    expect(projected.filter(message => message.role === "assistant" && message.text === answer)).toHaveLength(0);
  });

  it("被拦截的普通回答（错误回执）不投影为回答", () => {
    const projected = projectEntries([user("你好"), replyCall(answer), replyReceipt("本轮已有业务动作", true)]);
    expect(projected.filter(message => message.role === "assistant" && message.text)).toEqual([]);
  });

  it("旧协议回合按普通助手正文同一规则核验：无证据数值仍被拦截", () => {
    const numeric = "上月存款余额为 15147420074 元。";
    const projected = projectEntries([user("上月存款余额是多少", false), replyCall(numeric), replyReceipt(numeric)]);
    const legacy = projectEntries([user("上月存款余额是多少", false), replyCall(numeric), replyReceipt(numeric), finalText(numeric)]);
    expect(projected.at(-1)).toMatchObject({role: "assistant", text: EVIDENCE_BLOCKED_ANSWER});
    expect(legacy.at(-1)).toMatchObject({role: "assistant", text: EVIDENCE_BLOCKED_ANSWER});
  });

  it("下一轮用户消息后重新计数，不跨轮替换上一轮回答", () => {
    const next = "请问要查询哪个机构？";
    const projected = projectEntries([user("你好"), replyCall(answer), replyReceipt(answer),
      user("查一下余额"), finalText(next)]);
    expect(answers([user("你好"), replyCall(answer), replyReceipt(answer), user("查一下余额"), finalText(next)]))
      .toEqual([answer, next]);
    expect(projected.filter(message => message.role === "user")).toHaveLength(2);
  });
});
