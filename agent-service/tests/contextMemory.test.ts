import {describe, expect, it, vi} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {safeWorkingHistory, workingMessages} from "../src/semantic-task/contextMemory.js";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {MemoryCommandBridge, testRequestContext} from "../src/tools/testUtils.js";

const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const user = (content: string): AgentMessage => ({role: "user", content, timestamp: 0});
function failedAttempt(id: string, details: unknown): AgentMessage[] {
  return [{role: "assistant", content: [{type: "toolCall", id, name: "resolve_business_turn",
    arguments: {intent: "analysis", metric_ids: []}}], api: "openai-completions", provider: "test", model: "test",
    stopReason: "toolUse", timestamp: 0, usage},
  {role: "toolResult", toolCallId: id, toolName: "resolve_business_turn", isError: true,
    content: [{type: "text", text: "metric_ids 至少需要一个指标"}], details, timestamp: 0}];
}

describe("历史发送预算", () => {
  it("内部元数据膨胀不挤掉上一轮原问及配对失败回执，也不修改原生记录", () => {
    const turn = (details: unknown) => [user("我们行存款怎么少了？"),
      ...failedAttempt("first", details), ...failedAttempt("second", details), ...failedAttempt("third", details),
      user("能看出是哪些机构拖下来的吗？")];
    const small = turn({status: "invalid_input"});
    const large = turn({status: "invalid_input", state: "内部账本".repeat(3000)});
    const before = structuredClone(large);
    expect(workingMessages(small)).toEqual(small);
    expect(workingMessages(large)).toEqual(large);
    expect(workingMessages(large)[2]).toBe(large[2]);
    expect(large).toEqual(before);
  });

  it("工具参数及回执正文仍占预算，超限整轮裁剪，不留下孤立调用或回执", () => {
    const current = user("继续看机构");
    for (const field of ["arguments", "content"] as const) {
      const pair = failedAttempt("large", {});
      const assistant = pair[0]!, receipt = pair[1]!;
      if (field === "arguments" && assistant.role === "assistant" && assistant.content[0]?.type === "toolCall") {
        assistant.content[0].arguments = {query: "业务条件".repeat(2000)};
      }
      if (field === "content" && receipt.role === "toolResult") receipt.content = [{type: "text", text: "历史正文".repeat(2000)}];
      expect(workingMessages([user("更早的问题"), user("上一轮问题"), ...pair, current])).toEqual([current]);
    }
  });

  it("最多保留紧邻三轮，本轮不受历史预算裁剪", () => {
    const messages = [user("一"), user("二"), user("三"), user("四"), user("当前正文".repeat(2000))];
    expect(workingMessages(messages)).toEqual(messages.slice(1));
    expect(workingMessages(messages, 0)).toEqual(messages.slice(-1));
  });

  it("保留的权限来源仍交给后续复核，撤权历史正文不可作为证据", async () => {
    const calls: string[][] = [];
    const backend = {resolveBusinessField: async (_kind: string, codes: string[]) => {
      calls.push(codes); return {status: "not_found"};
    }} as unknown as BackendClient;
    const request = testRequestContext(backend, new MemoryCommandBridge());
    const receipt: AgentMessage = {role: "toolResult", toolCallId: "previous", toolName: "resolve_business_turn",
      content: [{type: "text", text: "历史结果正文"}], isError: false, timestamp: 0,
      details: {kind: "business_overview", status: "succeeded", org_codes: ["O1"], tasks: [], diagnostic: "内部数据".repeat(3000)}};
    const messages = [user("原问题"), failedAttempt("previous", {})[0]!, receipt, user("追问")];
    const selected = workingMessages(messages);
    expect(selected).toHaveLength(messages.length);
    const safe = await safeWorkingHistory(request, selected);
    expect(calls).toEqual([["O1"]]);
    expect(safe[2]).toMatchObject({content: [{type: "text", text: "历史来源当前不可访问。"}]});
    expect(receipt.content).toEqual([{type: "text", text: "历史结果正文"}]);
  });
});

describe("历史任务权限复核", () => {
  const history = (resultId: string): AgentMessage[] => [user("原问题"), {
    role: "toolResult", toolCallId: "previous", toolName: "metric_read", isError: false,
    timestamp: 0, content: [{type: "text", text: "历史结果正文"}],
    details: {kind: "metric_read", status: "succeeded", task_id: "task-1", result_id: resultId},
  }, user("追问")];
  const task = {task_id: "task-1", status: "SUCCEEDED", result: {result_id: "result-1"}};

  it("同轮并发与后续调用复用任务查询，仍分别核对各回执的结果身份", async () => {
    const getTask = vi.fn(async () => task);
    const backend = {getTask} as unknown as BackendClient;
    const request = testRequestContext(backend, new MemoryCommandBridge());
    const correct = history("result-1");
    const stale = history("result-old");
    const [unavailable, available] = await Promise.all([
      safeWorkingHistory(request, stale), safeWorkingHistory(request, correct),
    ]);
    expect(unavailable[1]).toMatchObject({content: [{type: "text", text: "历史来源当前不可访问。"}]});
    expect(available).toEqual(correct);
    expect(await safeWorkingHistory(request, correct)).toEqual(correct);
    expect(getTask).toHaveBeenCalledExactlyOnceWith("task-1");

    getTask.mockRejectedValueOnce(new BackendApiError(403, "历史任务访问已撤销"));
    const next = testRequestContext(backend, new MemoryCommandBridge(), {requestId: "req-2", operationId: "op-2"});
    const revoked = await safeWorkingHistory(next, correct);
    expect(revoked[1]).toMatchObject({content: [{type: "text", text: "历史来源当前不可访问。"}]});
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it("传播暂时性后端异常，并允许本轮下一次复核重新查询", async () => {
    const unavailable = new BackendApiError(503, "复核服务暂不可用");
    const getTask = vi.fn(async () => task).mockRejectedValueOnce(unavailable);
    const request = testRequestContext({getTask} as unknown as BackendClient, new MemoryCommandBridge());
    const messages = history("result-1");
    await expect(safeWorkingHistory(request, messages)).rejects.toBe(unavailable);
    expect(await safeWorkingHistory(request, messages)).toEqual(messages);
    expect(getTask).toHaveBeenCalledTimes(2);
  });
});
