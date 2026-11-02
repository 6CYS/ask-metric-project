import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {repeatedContextRead} from "../src/toolRecovery.js";

const page = {status: "ok", entries: [{entry_id: "e1", seq: 10, type: "message", preview: "历史问题"}], next_before_seq: 10, has_more: false};
const sources = {tasks: [], organizationScopes: []};
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
function read(id: string, args: Record<string, unknown>, body: unknown = page, historySources: unknown = sources,
  name = "read", isError = false): AgentMessage[] {
  return [{role: "assistant", content: [{type: "toolCall", id, name, arguments: args}], api: "openai-completions",
    provider: "test", model: "test", stopReason: "toolUse", timestamp: 0, usage},
  {role: "toolResult", toolCallId: id, toolName: name, content: [{type: "text", text: JSON.stringify(body)}],
    details: {kind: "session_history_read", status: isError ? "error" : "ok", history_sources: historySources}, isError, timestamp: 0}];
}
const completed = (toolName: string, status: string): AgentMessage => ({role: "toolResult", toolCallId: "executed",
  toolName, content: [{type: "text", text: JSON.stringify({status})}], details: {status}, isError: false, timestamp: 0});
function inlineExecution(toolName: string, status: string, evidence?: Record<string, unknown>): AgentMessage {
  const details = {protocol_version: 2, status, state: {task_ref: "t1", task_status: status === "succeeded" ? "completed" : "active",
    completion: status === "succeeded" ? "met" : "unmet", raw_message_retained: true, proposals_retained: true, targets: [],
    ...(evidence ? {evidence} : {})}, issues: [], pending_questions: [], answer_receipts: [],
  continuation: {actor: "pi", action: "continue"}};
  return {role: "toolResult", toolCallId: "executed", toolName,
    content: [{type: "text", text: JSON.stringify(details)}], details, isError: false, timestamp: 0};
}

describe("没有进展的重复历史读取", () => {
  it("识别统一 read 连续读取同一页，未完成的调用不算已读", () => {
    const args = {kind: "list", limit: 20};
    const messages = [...read("first", args), ...read("second", args), read("pending", args)[0]!];
    expect(repeatedContextRead(messages, args, "read")).toBe(2);
  });

  it("默认分页参数和显式默认值属于同一历史来源", () => {
    expect(repeatedContextRead([...read("first", {kind: "list"}), ...read("second", {kind: "list", limit: 10})],
      {kind: "list"}, "read")).toBe(2);
    expect(repeatedContextRead([...read("first", {kind: "entry", entry_id: "e1"}),
      ...read("second", {kind: "entry", entry_id: "e1", offset: 0, length: 4000})],
    {kind: "entry", entry_id: "e1"}, "read")).toBe(2);
  });

  it.each([
    [{kind: "list", limit: 20}, {kind: "list", before_seq: 10, limit: 20}],
    [{kind: "entry", entry_id: "e1"}, {kind: "entry", entry_id: "e2"}],
    [{kind: "entry", entry_id: "e1"}, {kind: "entry", entry_id: "e1", offset: 4000}],
  ])("允许翻页、切换条目和继续读取后续分段：%j", (previous, next) => {
    expect(repeatedContextRead([...read("first", previous), ...read("second", previous)], next, "read")).toBe(0);
  });

  it("相同参数返回新内容或新授权来源时重新计数", () => {
    const args = {kind: "list", limit: 20};
    const messages = [...read("first", args), ...read("second", args)];
    expect(repeatedContextRead([...messages, ...read("third", args, {...page, has_more: true})], args, "read")).toBe(1);
    expect(repeatedContextRead([...messages, ...read("third", args, page, {tasks: [{task_id: "new"}], organizationScopes: []})], args, "read")).toBe(1);
  });

  it.each([["execute_business_frame", "succeeded"], ["execute_business_frame", "failed"], ["read_business_result", "succeeded"]])(
    "%s 的 %s 回执产生新的业务依据，允许重新回读", (tool, status) => {
      const args = {kind: "list", limit: 20};
      const messages = [...read("first", args), ...read("second", args), completed(tool, status)];
      expect(repeatedContextRead(messages, args, "read")).toBe(0);
      expect(repeatedContextRead([...messages, ...read("third", args)], args, "read")).toBe(1);
    });

  it.each([
    ["resolve_business_turn", "succeeded", {kind: "metric_ask", status: "succeeded", task_id: "query1", result_id: "result1"}],
    ["resolve_business_turn", "failed", {kind: "business_context", status: "failed", delivery: "business_evidence_v1"}],
    ["analysis_plan_repair", "succeeded", {kind: "analysis_evidence", status: "succeeded", run_ref: "run1"}],
    ["analysis_plan_repair", "failed", {kind: "semantic_results", status: "partial", results: [
      {kind: "analysis_evidence", status: "succeeded", run_ref: "run1"},
      {kind: "business_context", status: "failed", delivery: "business_evidence_v1"}]}],
    ["resolve_business_turn", "reused", {kind: "metric_read", status: "succeeded", task_id: "query1", result_id: "result1"}],
  ] as const)("识别挂在 %s 上的内联 %s 执行证据", (tool, status, evidence) => {
    const args = {kind: "list", limit: 20};
    const messages = [...read("first", args), ...read("second", args), inlineExecution(tool, status, evidence)];
    expect(repeatedContextRead(messages, args, "read")).toBe(0);
    expect(repeatedContextRead([...messages, ...read("third", args)], args, "read")).toBe(1);
  });

  it.each(["ready", "invalid_input", "failed"])("没有正式执行证据的 %s 不清除重复次数", status => {
    const args = {kind: "list", limit: 20};
    for (const tool of ["resolve_business_turn", "analysis_plan_repair"]) {
      expect(repeatedContextRead([...read("first", args), ...read("second", args), inlineExecution(tool, status)], args, "read")).toBe(2);
    }
  });

  it("无关只读动作不清除重复次数，被拦截后仍重复则可终止", () => {
    const args = {kind: "list", limit: 20};
    const messages = [...read("first", args), completed("business_skill_read", "succeeded"), ...read("second", args),
      ...read("blocked", args, {error: "请使用已有历史，避免重复读取。"}, sources, "read", true)];
    expect(repeatedContextRead(messages, args, "read")).toBe(3);
  });

  it.each(["task", "result"])("不拦截 read kind=%s 的后端任务和结果读取", kind => {
    const args = {kind, task_id: "t1", result_id: "r1"};
    expect(repeatedContextRead([...read("first", args), ...read("second", args)], args, "read")).toBe(0);
  });

  it("保留 business_context_read 默认调用及旧历史工具的保护", () => {
    const args = {query: "存款"};
    expect(repeatedContextRead([...read("first", args, page, sources, "business_context_read"),
      ...read("second", args, page, sources, "business_context_read")], args)).toBe(2);
    expect(repeatedContextRead([...read("first", {kind: "list"}, page, sources, "session_history_read"),
      ...read("second", {kind: "list"}, page, sources, "session_history_read")], {kind: "list"}, "session_history_read")).toBe(2);
  });
});
