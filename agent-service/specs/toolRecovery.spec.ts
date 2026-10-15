import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {repeatedToolFailure, repeatedContextRead} from "../src/toolRecovery.js";

const attempt = (id: string, args: unknown, error: string, toolName = "resolve_business_turn"): AgentMessage[] => [
  {role: "assistant", content: [{type: "toolCall", id, name: toolName, arguments: args}]} as AgentMessage,
  {role: "toolResult", toolCallId: id, toolName, isError: false,
    content: [{type: "text", text: error}], details: {status: "ARGUMENT_ERROR", retryable: true}} as AgentMessage,
];
const receipt = (status: string, toolName = "resolve_business_turn"): AgentMessage => ({role: "toolResult",
  toolName, toolCallId: "other", isError: false, content: [{type: "text", text: status}], details: {status}} as AgentMessage);

describe("native tool correction progress", () => {
  it("不同字段和组合错误仍在修正，不以三次或更多累计停止", () => {
    expect(repeatedToolFailure([
      ...attempt("a", {time: "2026年7月"}, "evidence"),
      ...attempt("b", {time: "2026 年 7 月"}, "selection missing"),
      ...attempt("c", {selection: "exact"}, "exact not valid for range"),
      ...attempt("d", {selection: "all_in_range"}, "ranking not valid for series"),
    ])).toBe(false);
  });
  it("相同参数与相同失败重复才判循环，参数键顺序无关", () => {
    expect(repeatedToolFailure([...attempt("a", {x: 1, y: 2}, "invalid"),
      ...attempt("b", {y: 2, x: 1}, "invalid")])).toBe(true);
  });
  it("相同参数出现不同诊断仍允许修复", () => {
    expect(repeatedToolFailure([...attempt("a", {x: 1}, "missing"), ...attempt("b", {x: 1}, "invalid")])).toBe(false);
  });
  it("交错读取和不同失败不能掩盖 A B A 循环", () => {
    expect(repeatedToolFailure([...attempt("a", {x: 1}, "invalid"), receipt("ok", "business_context_read"),
      ...attempt("b", {x: 2}, "different"), ...attempt("c", {x: 1}, "invalid")])).toBe(true);
  });
  it.each(["READY", "REUSE_RESULT", "NEEDS_CLARIFICATION", "succeeded", "failed"])("业务终态 %s 隔开旧失败", status => {
    expect(repeatedToolFailure([...attempt("a", {x: 1}, "invalid"), ...attempt("b", {x: 1}, "invalid"),
      receipt(status), ...attempt("c", {x: 1}, "invalid")])).toBe(false);
  });
  it("没有对应原生提案不能臆测参数相同", () => {
    const [, failure] = attempt("missing", {x: 1}, "invalid");
    expect(repeatedToolFailure([failure!, failure!])).toBe(false);
  });
  it.each(["succeeded", "failed"])("执行工具业务终态 %s 不被旧目录失败污染", status => {
    expect(repeatedToolFailure([...attempt("a", {keyword: "x"}, "invalid", "metric_search"),
      ...attempt("b", {keyword: "x"}, "invalid", "metric_search"), receipt(status, "execute_business_frame")])).toBe(false);
  });
  it("普通读取的同名状态不能清除循环记录", () => {
    expect(repeatedToolFailure([...attempt("a", {x: 1}, "invalid"), ...attempt("b", {x: 1}, "invalid"),
      receipt("succeeded", "business_context_read")])).toBe(true);
  });
  it("通过权限复核的业务结果复用成功清除旧失败，读取错误不能清除", () => {
    const errors = [...attempt("a", {x: 1}, "invalid"), ...attempt("b", {x: 1}, "invalid")];
    expect(repeatedToolFailure([...errors, receipt("succeeded", "read_business_result")])).toBe(false);
    expect(repeatedToolFailure([...errors, receipt("error", "read_business_result")])).toBe(true);
  });
});


it("相同成功历史读取按原生配对计数，不把另一个序号或旁支误判重复",()=>{
 const rows=attempt("r1",{query_number:1},"ok","business_context_read");
 expect(repeatedContextRead(rows,{query_number:1})).toBe(1);
 expect(repeatedContextRead([...rows,...attempt("r2",{query_number:1},"ok","business_context_read")],{query_number:1})).toBe(2);
 expect(repeatedContextRead(rows,{query_number:2})).toBe(0);
});
