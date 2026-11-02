import {Type, validateToolArguments, type AssistantMessage} from "@earendil-works/pi-ai";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {describe, expect, it} from "vitest";
import {projectInquiryMessages} from "../src/inquiry/view.js";

function invalidCall() {
  const call = {type: "toolCall" as const, id: "failed-call", name: "example_tool", arguments: {answer: "重复内容".repeat(4000)}};
  let error = "";
  try {validateToolArguments({name: call.name, description: "隔离 schema", parameters: Type.Object({answer: Type.String({maxLength: 4000})})}, call);}
  catch (failure) {error = (failure as Error).message;}
  expect(error).toContain("Received arguments:");
  const assistant: AssistantMessage = {role: "assistant", content: [call,
    {type: "toolCall", id: "successful-call", name: "other_tool", arguments: {metric_ref: "k1"}}],
    api: "openai-completions", provider: "isolated", model: "isolated", stopReason: "toolUse", timestamp: 1,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
  const result: AgentMessage = {role: "toolResult", toolName: call.name, toolCallId: call.id,
    isError: true, timestamp: 2, content: [{type: "text", text: error}]};
  return {call, assistant, result};
}

describe("原生参数错误的模型视图", () => {
  it("只保留失败调用身份与字段约束，不重复发送未执行参数，原记录不变", () => {
    const {assistant, result} = invalidCall();
    const original = structuredClone([assistant, result]);
    const projected = projectInquiryMessages([assistant, result]);
    expect(JSON.stringify(projected)).not.toContain("重复内容");
    expect(projected[0]).toMatchObject({content: [
      {type: "toolCall", id: "failed-call", name: "example_tool", arguments: {}},
      assistant.content[1],
    ]});
    expect(projected[1]).toMatchObject({isError: true, toolCallId: "failed-call"});
    expect(JSON.stringify(projected[1])).toContain("answer: must not have more than 4000 characters");
    expect(JSON.stringify(projected[1])).not.toContain("Received arguments:");
    expect([assistant, result]).toEqual(original);
  });

  it.each(["success", "business-error", "wrong-call", "wrong-tool", "changed-echo"])("不改写成功或非对应的原生参数错误：%s", mode => {
    const {assistant, result} = invalidCall();
    if (result.role !== "toolResult") throw new Error("测试回执类型错误");
    if (mode === "success") result.isError = false;
    if (mode === "business-error") result.details = {code: "FORBIDDEN"};
    if (mode === "wrong-call") result.toolCallId = "missing";
    if (mode === "wrong-tool") result.toolName = "other_tool";
    if (mode === "changed-echo") result.content = [{type: "text", text: result.content[0]!.type === "text"
      ? result.content[0]!.text + "changed" : ""}];
    expect(projectInquiryMessages([assistant, result])).toEqual([assistant, result]);
  });

  it("用户原文即使相同也原样保留，不通过词语清洗内容", () => {
    const {assistant, result, call} = invalidCall();
    const user: AgentMessage = {role: "user", content: call.arguments.answer, timestamp: 0};
    expect(projectInquiryMessages([user, assistant, result])[0]).toEqual(user);
  });
});
