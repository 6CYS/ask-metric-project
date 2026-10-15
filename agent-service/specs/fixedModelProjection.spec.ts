import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {projectFixedTurnArguments} from "../src/modelContext.js";
import {modelFixedCapabilitySchemas, modelFixedFrame, projectFixedBusinessReceipt} from "../src/business-context/modelView.js";
import {fixedTurnParameters, fromFixedTurnArgs} from "../src/business-context/fixedTurnArgs.js";
import {fixedPublicToolDefinitions} from "../src/fixedTurnCompatibility.js";
import type {BusinessFrame} from "../src/business-context/types.js";

const delta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldIntents: {
  organizations: {mode: "inherit", sourceText: null, expectedCount: null}},
fieldChanges: [{fieldHint: "time", operation: "set", rawValue: "4月末"}]};
const assistant = (args: unknown, id = "call"): AgentMessage => ({role: "assistant", timestamp: 1,
  content: [{type: "toolCall", id, name: "resolve_business_turn", arguments: args}]} as AgentMessage);
const result = (receipt: unknown, id = "call"): AgentMessage => ({role: "toolResult", timestamp: 2,
  toolCallId: id, toolName: "resolve_business_turn", isError: false, content: [{type: "text", text: JSON.stringify(receipt)}]});

describe("固定协议模型发送副本", () => {
  it("无损旧调用投影为固定协议，原消息与原 Delta 保持原样", () => {
    const messages = [assistant(delta), result({status: "READY", executionMode: "execute"})];
    const saved = JSON.stringify(messages);
    const projected = projectFixedTurnArguments(messages);
    const block = projected[0]?.role === "assistant" ? projected[0].content[0] : undefined;
    expect(block).toMatchObject({type: "toolCall", arguments: {protocol_version: 1, capability: "metric_query", base: "current",
      mode: "execute", changes: {organizations: {action: "inherit"}, time: {action: "set", value: "4月末"}}}});
    if (block?.type !== "toolCall") throw new Error("missing call");
    expect(fromFixedTurnArgs(block.arguments)).toEqual(delta);
    expect(JSON.stringify(messages)).toBe(saved);
    expect(JSON.stringify(projected)).not.toMatch(/fieldChanges|capabilityHint|baseReference|executionMode/);
  });

  it.each([
    {...delta, fieldIntents: {}},
    {...delta, fieldChanges: [{fieldHint: "metrics", operation: "set", rawValue: "旧模型改写指标"}]},
    {...delta, fieldChanges: [{fieldHint: "time", operation: "retain", rawValue: "忽略的旧元数据"}]},
  ])("不可无损转换时成对改为历史数据，参数不泄漏或补造：%j", args => {
    const messages = [assistant(args), result({status: "ARGUMENT_ERROR", field: "time", query_executed: false}),
      {role: "user", timestamp: 3, content: "继续"} as AgentMessage];
    const saved = JSON.stringify(messages);
    const projected = projectFixedTurnArguments(messages);
    expect(projected[0]?.role === "assistant" && projected[0].content.every(block => block.type !== "toolCall")).toBe(true);
    expect(projected[1]?.role).toBe("assistant");
    expect(JSON.stringify(projected)).not.toContain("旧模型改写指标");
    expect(JSON.stringify(projected)).not.toContain("忽略的旧元数据");
    expect(JSON.stringify(projected)).toContain("历史业务回执");
    expect(JSON.stringify(messages)).toBe(saved);
  });

  it("混合批次只移除坏调用和其回执，不拆散合法 call/result", () => {
    const good = assistant(delta, "good");
    const bad = assistant({bad: true}, "bad");
    if (good.role !== "assistant" || bad.role !== "assistant") throw new Error("fixture");
    const output = projectFixedTurnArguments([{...good, content: [...good.content, ...bad.content]},
      result({status: "READY"}, "good"), result({status: "ARGUMENT_ERROR"}, "bad")]);
    const calls = output.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : []);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({id: "good"});
    expect(output[1]).toMatchObject({role: "toolResult", toolCallId: "good"});
    expect(output[2]?.role).toBe("assistant");
  });

  it("当前坏调用保留结构校验失败事实，不冒充已执行或历史成功", () => {
    const error = {...result({}), isError: true, content: [{type: "text" as const,
      text: "FIXED_TURN_ARGUMENTS_REQUIRED: 请使用唯一固定业务入口Schema。"}]};
    const output = projectFixedTurnArguments([{role: "user", content: "查询", timestamp: 0}, assistant({bad: true}), error]);
    expect(JSON.stringify(output)).toContain("未执行");
    expect(JSON.stringify(output)).toContain("FIXED_TURN_ARGUMENTS_REQUIRED");
    expect(JSON.stringify(output)).not.toContain("历史业务回执");
  });

  it("Frame、错误与恢复数据统一固定术语且投影幂等，不改业务原文和证据", () => {
    const raw = "baseReference retain 是用户原话";
    const frame: BusinessFrame = {frameId: "f", operationFrameId: "f", sessionId: "s", requestId: "r", turnId: "old",
      capability: "metric_query", status: "clarifying", createdAt: "2026-01-01", fields: {time: {rawValue: raw, source: "explicit", resolutionStatus: "missing"}},
      issues: [{field: "time", reason: "missing", message: "保留 baseReference，未变化字段 retain"}], delta: {...delta, executionMode: "execute"} as BusinessFrame["delta"],
      recovery: {turnId: "new", selectionFrameId: "f", optionIds: [], pendingFields: ["time"],
        pendingChanges: [{field: "time", operation: "inherit", mayRetain: true}]}};
    const saved = JSON.stringify(frame);
    expect(modelFixedFrame(frame, "new")).toMatchObject({mode: "execute", continuation: {base: {frameId: "f"}},
      pending_changes: [{field: "time", action: "inherit", inherit_allowed: true}]});
    const receipt = {status: "ARGUMENT_ERROR", capability: "metric_query", frame, current_user_input: raw,
      corrections: [{field: "selection", message: "rawValue 不合法", inputSchema: {type: "string"}}],
      data: {fieldChanges: raw}, query_evidence: {source_question: raw}};
    const projected = projectFixedBusinessReceipt(receipt) as Record<string, unknown>;
    expect(projected.current_user_input).toBe(raw); expect(projected.data).toEqual(receipt.data);
    expect(projected.query_evidence).toEqual(receipt.query_evidence);
    expect(projected.frame).not.toHaveProperty("delta"); expect(projected.frame).not.toHaveProperty("recovery");
    expect(projected.corrections).toMatchObject([{inputSchema: {oneOf: expect.any(Array)}}]);
    expect(projectFixedBusinessReceipt(projected)).toEqual(projected);
    expect(JSON.stringify(frame)).toBe(saved);
  });

  it("能力上下文不再重复参数Schema；provider公开定义强制唯一固定Schema", () => {
    const capabilities = JSON.stringify(modelFixedCapabilitySchemas());
    expect(capabilities).not.toContain("inputSchema"); expect(capabilities).not.toMatch(/fieldChanges|rawValue|retain/);
    const privateSchema = {anyOf: [{old: "legacy"}, fixedTurnParameters]};
    const payload = {tools: [{type: "function", function: {name: "resolve_business_turn", parameters: privateSchema}},
      {name: "resolve_business_turn", parameters: privateSchema}, {name: "unrelated", parameters: privateSchema}]};
    const projected = fixedPublicToolDefinitions(payload) as typeof payload;
    expect(projected.tools[0]?.function?.parameters).toBe(fixedTurnParameters);
    expect(projected.tools[1]?.parameters).toBe(fixedTurnParameters);
    expect(projected.tools[2]).toBe(payload.tools[2]);
    expect(payload.tools[0]?.function?.parameters).toBe(privateSchema);
  });
});
