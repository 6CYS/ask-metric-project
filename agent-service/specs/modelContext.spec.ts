import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {projectTurnArguments} from "../src/modelContext.js";

const legacy = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldChanges: [
  {fieldHint: "organizations", operation: "clear"},
  {fieldHint: "time", operation: "set", rawValue: "4月末"},
  {fieldHint: "metrics", operation: "retain"},
  {fieldHint: "selection", operation: "set", rawValue: "exact"},
]};
const compact = {capability: "metric_query", base: "current", mode: "execute",
  set: {time: "4月末", selection: "exact"}, clear: ["organizations"], retain: ["metrics"]};
const assistant = (args: unknown): AgentMessage => ({role: "assistant", timestamp: 1, content: [
  {type: "text", text: "保留原文 baseReference=用户输入"},
  {type: "toolCall", id: "call", name: "resolve_business_turn", arguments: args},
]}) as AgentMessage;
const result = (toolName: string, value: unknown): AgentMessage => ({role: "toolResult", toolName,
  toolCallId: "call", timestamp: 1, isError: false, content: [{type: "text", text: JSON.stringify(value)}]}) as AgentMessage;

describe("业务参数方言仅作用于模型发送副本", () => {
  it("历史和当前工具调用均按活动格式投影，原生参数及助手文字保持不变", () => {
    const message = assistant(legacy);
    const user = {role: "user", timestamp: 1, content: "fieldChanges 是我的原话"} as AgentMessage;
    const before = JSON.stringify([message, user]);
    const projected = projectTurnArguments([message, user], true);
    const call = projected[0]!.role === "assistant" ? projected[0]!.content[1] : undefined;
    expect(call).toMatchObject({type: "toolCall", arguments: compact});
    expect(projected[0]).not.toBe(message);
    expect(projected[1]).toBe(user);
    expect(JSON.stringify([message, user])).toBe(before);
    expect(projected[0]).toMatchObject({content: [{text: "保留原文 baseReference=用户输入"}, {}]});
  });

  it("回滚时把精简历史恢复为旧格式，其他工具及旧格式内容不改", () => {
    const message = assistant(compact);
    const projected = projectTurnArguments([message], false)[0]!;
    const call = projected.role === "assistant" ? projected.content[1] : undefined;
    expect(call).toMatchObject({arguments: {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldChanges: [
        {fieldHint: "time", operation: "set", rawValue: "4月末"},
        {fieldHint: "selection", operation: "set", rawValue: "exact"},
        {fieldHint: "organizations", operation: "clear"},
        {fieldHint: "metrics", operation: "retain"},
      ]}});
    const other = result("business_context_read", {baseReference: {frameId: "f"}});
    expect(projectTurnArguments([other], false)[0]).toBe(other);
    const old = assistant(legacy);
    expect(projectTurnArguments([old], false)[0]).toBe(old);
    const active = assistant(compact);
    expect(projectTurnArguments([active], true)[0]).toBe(active);
  });

  it.each([
    {fieldChanges: [], executionMode: "wrong"},
    {...legacy, base: null},
    {...legacy, fieldChanges: [{fieldHint: "time", operation: "set"}]},
    {...legacy, fieldChanges: [{fieldHint: "time", operation: "set", rawValue: {optional: undefined}}]},
    {...legacy, fieldChanges: [{fieldHint: "time", operation: "retain", rawValue: "ignored metadata"}]},
  ])("非法或无法无损传输的历史参数原样保留：%j", args => {
    const message = assistant(args);
    expect(projectTurnArguments([message], true)[0]).toBe(message);
  });

  it("受控业务回执改名但用户原话、字段值、执行结果和其他工具数据不改", () => {
    const value = {status: "ARGUMENT_ERROR", field: "baseReference", message: "fieldChanges 必须为空数组，executionMode=reuse_result。",
      reference_hint: "保留此 baseReference", retry_reference: {frameId: "f"},
      current_user_input: "baseReference fieldChanges", fields: {time: {rawValue: "executionMode"}},
      data: {fieldChanges: "保持业务数据"}};
    const message = result("resolve_business_turn", value);
    const projected = projectTurnArguments([message], true)[0]!;
    expect(projected.role).toBe("toolResult");
    const content = projected.role === "toolResult" && projected.content[0]?.type === "text" ? JSON.parse(projected.content[0].text) : null;
    expect(content).toMatchObject({field: "base", current_user_input: value.current_user_input,
      fields: value.fields, data: value.data, retry_reference: value.retry_reference});
    expect(content.message).toBe("set/remove/clear/retain 必须省略或为空，mode=reuse_result。");
    expect(JSON.stringify(message)).toContain("fieldChanges 必须为空数组");
    const other = result("custom_tool", value);
    expect(projectTurnArguments([other], true)[0]).toBe(other);
    const execution = result("execute_business_frame", {status: "succeeded", message: "业务名称：baseReference", data: value.data});
    expect(JSON.stringify(projectTurnArguments([execution], true)[0])).toContain("业务名称：baseReference");
  });
});
