import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {BackendClient} from "../src/backendClient.js";
import {createStructuredQueryTool} from "../src/tools/structuredQuery.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

describe("结构化查询覆盖率契约传输", () => {
  const calls: Array<{url: string; body: unknown}> = [];
  const params = {metric_codes: ["SYNTHETIC_A"], org_codes: ["SYNTHETIC_ORG"],
    start: "2026-04-30", end: "2026-04-30", selection: "exact"};
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

  it("覆盖率复核透传宿主原句和逐目标编码绑定及排除片段", async () => {
    const source = {source_question: "查询合成甲和合成乙",
      source_metric_bindings: [{start: 2, end: 5, text: "合成甲", codes: ["SYNTHETIC_A"]}],
      source_metric_exclusions: [{start: 6, end: 9, text: "合成乙"}]};
    const result = await runTool(createStructuredQueryTool(), {...params, ...source, verify_question_coverage: true}, context());
    expect(result.details?.status).toBe("succeeded");
    expect(calls.find(call => call.url.endsWith("/basic-queries"))?.body).toMatchObject(source);
  });

  it.each([{}, {verify_question_coverage: true}, {source_question: "查询合成甲"}])(
    "绑定必须与覆盖率复核及明确原句同行：%j", async partial => {
      const result = await runTool(createStructuredQueryTool(), {...params, ...partial,
        source_metric_bindings: [{start: 2, end: 5, text: "合成甲", codes: ["SYNTHETIC_A"]}]}, context());
      expect(result.details?.error_code).toBe("QUERY_CONTRACT_INVALID");
      expect(calls).toHaveLength(0);
    },
  );

  it.each([{}, {verify_question_coverage: true, source_question: "合成甲和合成乙"}])(
    "排除片段必须与复核、明确原句及保留项绑定同行：%j", async partial => {
      const result = await runTool(createStructuredQueryTool(), {...params, ...partial,
        source_metric_exclusions: [{start: 0, end: 3, text: "合成甲"}]}, context());
      expect(result.details?.error_code).toBe("QUERY_CONTRACT_INVALID");
      expect(calls).toHaveLength(0);
    },
  );
});
