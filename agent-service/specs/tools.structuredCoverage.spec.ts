import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {BackendClient} from "../src/backendClient.js";
import {createStructuredQueryTool} from "../src/tools/structuredQuery.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

describe("结构化查询规范化契约传输", () => {
  const calls: Array<{url: string; body: unknown}> = [];
  const params = {metric_codes: ["SYNTHETIC_A"], org_codes: ["SYNTHETIC_ORG"],
    start: "2026-04-30", end: "2026-04-30", selection: "exact"};
  const proofFields = ["verify_question_coverage", "source_question", "source_semantic_receipt",
    "source_metric_bindings", "source_metric_exclusions"];
  const context = () => testRequestContext(new BackendClient("http://backend.test", "synthetic-token", 5000),
    new MemoryCommandBridge(), {originalMessage: "查询合成甲和合成乙"});
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({url, body: init?.body ? JSON.parse(String(init.body)) : null});
      if (url.endsWith("/agent-query-contexts")) return Response.json({conversation_id: "synthetic-conversation"});
      if (url.endsWith("/basic-queries")) return Response.json({query: {}, result: {
        task_id: "synthetic-task", status: "succeeded", columns: [], rows: [], row_count: 0,
      }});
      if (url.endsWith("/query-tasks/synthetic-task")) return Response.json({task_id: "synthetic-task", status: "SUCCEEDED",
        version: 1, result: {result_id: "synthetic-result"}});
      throw new Error("UNEXPECTED_SYNTHETIC_REQUEST");
    }));
  });
  afterEach(() => {vi.unstubAllGlobals(); calls.length = 0;});

  it("只提交规范化 BasicQuerySpec，不含旧原句覆盖证明字段", async () => {
    const result = await runTool(createStructuredQueryTool(), params, context());
    expect(result.details?.status).toBe("succeeded");
    const body = calls.find(call => call.url.endsWith("/basic-queries"))?.body as Record<string, unknown>;
    expect(body).toMatchObject({metric_codes: ["SYNTHETIC_A"], org_codes: ["SYNTHETIC_ORG"],
      time: {start: "2026-04-30", end: "2026-04-30"}, selection: "exact", operation: {kind: "value"}});
    for (const field of proofFields) expect(body[field]).toBeUndefined();
  });

  it.each([
    {verify_question_coverage: true, source_question: "查询合成甲和合成乙"},
    {source_semantic_receipt: "legacy-receipt"},
    {source_metric_bindings: [{start: 2, end: 5, text: "合成甲", codes: ["SYNTHETIC_A"]}]},
    {source_metric_exclusions: [{start: 6, end: 9, text: "合成乙"}]},
  ])("旧证明参数不再进入后端请求：%j", async legacy => {
    // 工具 Schema 已删除这些参数（additionalProperties=false 会在协议层拒绝）；
    // 即使绕过 Schema 直接调用，适配器也不得把它们透传到 basic-queries。
    const result = await runTool(createStructuredQueryTool(), {...params, ...legacy}, context());
    expect(result.details?.status).toBe("succeeded");
    const body = calls.find(call => call.url.endsWith("/basic-queries"))?.body as Record<string, unknown>;
    for (const field of proofFields) expect(body[field]).toBeUndefined();
  });
});
