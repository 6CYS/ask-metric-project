import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {BackendClient} from "../src/backendClient.js";
import {CONVERSATION_REPLY, createConversationReplyTool} from "../src/tools/turnContract.js";
import {createInquiryAnswerTool, inquiryPayload, inquiryToolAdmission} from "../src/inquiry/runtime.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

describe("目录缺口的正常交付", () => {
  it("实际检索后无适用指标可立即正常交付缺口，不等待调查预算耗尽", async () => {
    const messages: AgentMessage[] = [{ role: "toolResult", toolName: "metric_search", toolCallId: "empty-search",
      timestamp: 0, isError: false, content: [{ type: "text", text: JSON.stringify({ results: [
        { keyword: "现金股利", total: 0, page: 1, page_size: 12, has_more: false, matches: [] },
      ], items: [] }) }], details: { kind: "analysis_catalog", status: "succeeded" } }];
    const answer = "本次检索未找到可用于回答该机构现金股利总额的指标，因此暂时无法给出金额。";
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {turnMessages: () => Promise.resolve(messages)});
    expect(inquiryToolAdmission(messages, CONVERSATION_REPLY, {answer})).toBeUndefined();
    expect(inquiryPayload({tools: [{name: CONVERSATION_REPLY}, {name: "analysis_answer"}, {name: "metric_search"}]}, messages).tools)
      .toEqual([{name: CONVERSATION_REPLY}, {name: "metric_search"}]);
    const result: unknown = await runTool(createConversationReplyTool(), {answer}, request);
    expect(result).toMatchObject({terminate: true, details: {kind: "conversation_reply", status: "answered", answer},
      content: [{type: "text", text: answer}]});
    const fabricated: unknown = await runTool(createInquiryAnswerTool(), {body: "该机构本期现金股利总额为100万元。"}, request);
    expect(fabricated).toMatchObject({details: {error_code: "ANALYSIS_REPORT_EVIDENCE"}});
  });

  it("已取得真实证据时仍须通过报告入口，不能以缺口说明绕过事实交付", () => {
    const messages: AgentMessage[] = [{role: "toolResult", toolName: "metric_query", toolCallId: "empty-query",
      timestamp: 0, isError: false, content: [], details: {kind: "analysis_evidence", status: "succeeded", rows: []}}];
    expect(inquiryToolAdmission(messages, CONVERSATION_REPLY, {answer: "部分指标未找到。"}))
      .toMatchObject({block: {terminate: false}});
    expect(inquiryPayload({tools: [{name: CONVERSATION_REPLY}, {name: "analysis_answer"}]}, messages).tools)
      .toEqual([{name: "analysis_answer"}]);
  });

});
