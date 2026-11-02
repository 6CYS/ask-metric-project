import {describe, expect, it, vi} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {currentTurnEvidence} from "../src/answerEvidence.js";
import {inquiryPayload, inquiryToolAdmission} from "../src/inquiry/runtime.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

const entry = {id: "profit", title: "盈利变化分析", text: "比较利润变化后，再核对同期间收入和成本。", role: "分析方法"};
const tool = () => {
  const found = createAskMetricTools().find(item => item.name === "business_knowledge_search");
  if (!found) throw new Error("缺少取数前的知识检索工具");
  return found;
};
function fixture() {
  const searchBusinessKnowledge = vi.fn(async () => ({revision: "a".repeat(64), entries: [entry]}));
  const request = testRequestContext({searchBusinessKnowledge} as unknown as BackendClient, new MemoryCommandBridge(),
    {originalMessage: "对比另一家呢？"});
  return {searchBusinessKnowledge, request};
}

describe("inquiry 按需知识检索", () => {
  it("取数前按模型明确的业务主题检索，不改写原问或要求已有事实", async () => {
    const f = fixture();
    const result = await runTool(tool(), {query: "  同期间盈利变化与机构对比  "}, f.request);
    expect(f.searchBusinessKnowledge).toHaveBeenCalledWith("同期间盈利变化与机构对比", [], expect.anything());
    expect(f.request.originalMessage).toBe("对比另一家呢？");
    expect(result.terminate).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({status: "ok", entries: [entry]});
    expect(result.details).toMatchObject({kind: "business_knowledge_search", status: "ok"});
    expect(currentTurnEvidence([{role: "toolResult", details: result.details}])).toEqual([]);
  });

  it("知识查询属于调查预算，读取后仍可继续取数", () => {
    expect(inquiryToolAdmission([], tool().name)).toBeUndefined();
    const payload = inquiryPayload({tools: [{name: tool().name}, {name: "metric_query"}]}, []);
    expect(payload.tools).toEqual([{name: "business_knowledge_search"}, {name: "metric_query"}]);
    const receipts = Array.from({length: 16}, (_, index) => ({role: "toolResult" as const,
      toolName: tool().name, toolCallId: `read-${index}`, timestamp: 0, content: [], isError: false}));
    expect(inquiryToolAdmission(receipts, tool().name)).toMatchObject({block: {terminate: false}});
  });

  it.each([{query: "", size: 0}, {query: " ", size: 1}, {query: "字".repeat(2001), size: 2001}])(
    "非法查询在正式参数边界拒绝（长度=$size）", ({query}) => {
    const registered = tool();
    expect(() => validateToolArguments(registered, {type: "toolCall", name: registered.name, id: "invalid", arguments: {query}})).toThrow();
  });

  it("无匹配是正常空结果，不能冒充服务异常或目录不存在", async () => {
    const f = fixture();
    f.searchBusinessKnowledge.mockResolvedValue({revision: "a".repeat(64), entries: []});
    const result = await runTool(tool(), {query: "无匹配主题"}, f.request);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({status: "ok", entries: []});
  });

  it.each([401, 403])("鉴权失败%s继续抛出，不降级成无知识", async status => {
    const f = fixture(), error = new BackendApiError(status, "无权", "FORBIDDEN");
    f.searchBusinessKnowledge.mockRejectedValue(error);
    await expect(runTool(tool(), {query: "盈利"}, f.request)).rejects.toBe(error);
  });

  it("故障和超预算内容不交给模型，且不产生成功证据", async () => {
    for (const value of [new BackendApiError(503, "不可用"), {revision: "a".repeat(64), entries: Array(4).fill(entry)}]) {
      const f = fixture();
      if (value instanceof Error) f.searchBusinessKnowledge.mockRejectedValue(value);
      else f.searchBusinessKnowledge.mockResolvedValue(value);
      const result = await runTool(tool(), {query: "盈利"}, f.request);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({status: "unavailable", entries: []});
    }
  });
});
