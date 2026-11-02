import {describe, expect, it} from "vitest";
import type {AgentMessage, Entry} from "@earendil-works/pi-agent-core";
import type {BackendClient} from "../src/backendClient.js";


import {createConversationReplyTool} from "../src/tools/turnContract.js";

import {projectEntries} from "../src/sessionProjection.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

const definition = {metric_code: "m1", metric_name: "测试余额", metric_explanation: "测试指标说明",
  description: "测试口径：金额低于100万元的记录。"};
const query = {kind: "metric_query_structured", delivery: "business_evidence_v1", status: "succeeded",
  task_id: "task-1", result_id: "result-1", frame_id: "frame-1", rows: [], row_count: 0,
  public_answer: "指定条件下没有数据。", public_answer_blocks: [{type: "paragraph", segments: [{text: "指定条件下没有数据。", bold: false}]}]};
function receipt(details: unknown, id = "query-call"): AgentMessage {
  return {role: "toolResult", toolName: "test", toolCallId: id, timestamp: 0, isError: false, content: [], details};
}
function definitions(items = [definition], status = "succeeded") {
  return receipt({kind: "catalog", action: "search", status, definition_only: true,
    metric_definition_searches: [{keyword: "测试余额", status, has_more: false, items}]}, "catalog-call");
}

describe("纯口径解释的资料缺口", () => {
  it("已读取的正式资料全空时，不交付模型按名称补写的统计规则", async () => {
    const messages = [definitions([{...definition, metric_explanation: "", description: ""}])];
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {turnMessages: async () => messages});
    const result = await runTool(createConversationReplyTool(), {answer: "按名称推断为同一客户的合计余额。"}, request);
    expect(result.details.answer).toContain("尚未维护正式说明和统计口径");
    expect(result.details.answer).not.toContain("同一客户");
    expect(result.content[0].text).toBe(result.details.answer);
  });
  it.each([[], [definitions()], [definitions([], "error")], [definitions(), receipt(query)]])(
    "无读取、已有资料、读取失败或有数值证据时不覆盖原交付", async (...messages) => {
      const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {turnMessages: async () => messages});
      const result = await runTool(createConversationReplyTool(), {answer: "原回答"}, request);
      expect(result.details.answer).toBe("原回答");
    });
  it("空定义不覆盖数值结果或其它已读取的知识", async () => {
    const empty = definitions([{...definition, metric_explanation: "", description: ""}]);
    for (const source of [receipt(query), receipt({kind: "business_skill_read", status: "succeeded"}),
      receipt({kind: "business_context", status: "succeeded"})]) {
      const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {
        turnMessages: async () => [empty, source],
      });
      const result = await runTool(createConversationReplyTool(), {answer: "依据其它已读取资料解释"}, request);
      expect(result.details.answer).toBe("依据其它已读取资料解释");
    }
  });
  it("空定义仍保留本页指标名称与未取完的检索范围", async () => {
    const message = receipt({kind: "catalog", action: "search", status: "succeeded", definition_only: true,
      metric_definition_searches: [{keyword: "贷款", status: "succeeded", has_more: true, items: [
        {...definition, metric_name: "贷款余额", metric_explanation: "", description: ""},
        {...definition, metric_code: "m2", metric_name: "贷款户数", metric_explanation: "", description: ""},
      ]}]});
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {turnMessages: async () => [message]});
    const result = await runTool(createConversationReplyTool(), {answer: "本页有贷款余额、贷款户数，口径为空，还有更多结果。"}, request);
    expect(result.details.answer).toContain("贷款余额");
    expect(result.details.answer).toContain("贷款户数");
    expect(result.details.answer).toContain("仍有更多匹配项");
    expect(result.details.answer).toContain("尚未维护正式说明和统计口径");
  });
  it("纯口径回答不铺开模型未采用的其它检索候选", async () => {
    const message = definitions([
      {...definition, metric_explanation: "", description: ""},
      {...definition, metric_code: "m2", metric_name: "其它检索候选", metric_explanation: "", description: ""},
    ]);
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {turnMessages: async () => [message]});
    const result = await runTool(createConversationReplyTool(), {answer: "测试余额没有正式口径，按名称推断为客户合计。"}, request);
    expect(result.details.answer).toContain("测试余额");
    expect(result.details.answer).not.toContain("其它检索候选");
    expect(result.details.answer).not.toContain("客户合计");
  });
  it.each([false, undefined])("非纯定义目录读取不覆盖已有事实回答（%s）", async definitionOnly => {
    const message = definitions([{...definition, metric_explanation: "", description: ""}]);
    if (message.role === "toolResult") message.details = {...message.details as object, definition_only: definitionOnly};
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {turnMessages: async () => [message]});
    const result = await runTool(createConversationReplyTool(), {answer: "已读取的机构信息和指标名称。"}, request);
    expect(result.details.answer).toBe("已读取的机构信息和指标名称。");
  });
});
describe("旧混合正文的历史投影", () => {
  it("历史投影保留正式正文，旧数值回答块不替换混合正文", () => {
    const publicAnswer = "指定条件下没有数据。\n\n测试余额\n指标说明：测试指标说明\n指标口径：测试口径：金额低于100万元的记录。";
    const delivery = {kind: "runtime_delivery", version: 1, operation_id: "op-1", status: "delivered", outcome: "result",
      source_call_ids: ["query-call"], history_sources: {tasks: [{task_id: "task-1", result_id: "result-1"}], organizationScopes: []},
      public_answer: publicAnswer};
    const messages = [definitions(), receipt(query), receipt(delivery, "finalize-call")];
    const projected = projectEntries([
      {id: "user", type: "message", message: {role: "user", businessProtocol: "semantic_v2", content: [{type: "text", text: "查询并说明口径"}]}},
      ...messages.map((message, index) => ({id: `entry-${index}`, type: "message", message})),
    ] as Entry[]);
    expect(projected.at(-1)).toMatchObject({role: "assistant", text: publicAnswer});
  });
});
