/**
 * metric_query_structured 工具测试：参数透传、selection 校验、错误处理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStructuredQueryTool } from "./tools/structuredQuery.js";
import { BackendClient } from "./backendClient.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "./tools/testUtils.js";

function stubFetch(calls: Array<{ url: string; body: unknown; idempotency: string | null }>) {
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      idempotency: (init?.headers as Record<string, string>)?.["Idempotency-Key"] ?? null,
    });
    return new Response(
      JSON.stringify({
        query: {},
        result: {
          task_id: "task-b1",
          status: "succeeded",
          columns: ["org_name", "metric_value", "stat_date"],
          rows: [{ org_name: "启东农商行", metric_value: 4392486393.134524, stat_date: "2026-04-30" }],
          row_count: 1,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", stub);
}

describe("metric_query_structured 工具", () => {
  const CTX = () => testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge());
  const calls: Array<{ url: string; body: unknown; idempotency: string | null }> = [];
  beforeEach(() => stubFetch(calls));
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  it("按契约透传编码、日期与 selection，并去重编码", async () => {
    const tool = createStructuredQueryTool();
    const result = await runTool(tool, {
      metric_codes: ["M1", "M1"],
      org_codes: ["320626000"],
      start: "2026-04-01",
      end: "2026-04-30",
      selection: "latest_in_range",
    }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(calls[0]?.url).toBe("http://backend.test/api/v1/basic-queries");
    expect(calls[0]?.body).toEqual({
      metric_codes: ["M1"],
      org_codes: ["320626000"],
      time: { start: "2026-04-01", end: "2026-04-30" },
      selection: "latest_in_range",
    });
    expect(calls[0]?.idempotency).toBeTruthy();
    expect(result.details?.status).toBe("succeeded");
    expect(result.details?.task_id).toBe("task-b1");
    // 模型侧只给样例行，全量明细在 details
    const content = JSON.parse((result.content[0] as { text: string }).text);
    expect(content.sample_rows).toHaveLength(1);
    expect(result.details?.rows).toHaveLength(1);
  });

  it("selection=exact 但起止不同日时拒绝", async () => {
    const tool = createStructuredQueryTool();
    const result = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: ["O1"],
      start: "2026-04-01",
      end: "2026-04-30",
      selection: "exact",
    }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(result.details?.status).toBe("error");
    expect(calls).toHaveLength(0);
  });

  it("start 晚于 end 时拒绝", async () => {
    const tool = createStructuredQueryTool();
    const result = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: ["O1"],
      start: "2026-05-01",
      end: "2026-04-30",
      selection: "latest_in_range",
    }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(result.details?.status).toBe("error");
    expect(calls).toHaveLength(0);
  });

  it("selection=ranking 透传 order/top_n，org_codes 可空（范围缺省为全省汇总下级）", async () => {
    const tool = createStructuredQueryTool();
    const result = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: [],
      start: "2026-03-01",
      end: "2026-03-31",
      selection: "ranking",
      order: "desc",
      top_n: 1,
    }, CTX());
    expect(calls[0]?.body).toEqual({
      metric_codes: ["M1"],
      org_codes: [],
      time: { start: "2026-03-01", end: "2026-03-31" },
      selection: "ranking",
      order: "desc",
      top_n: 1,
    });
    expect(result.details?.status).toBe("succeeded");
  });

  it("selection=ranking 未指定 order/top_n 时按 desc/5 缺省", async () => {
    const tool = createStructuredQueryTool();
    await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: ["320000000"],
      start: "2026-03-31",
      end: "2026-03-31",
      selection: "ranking",
    }, CTX());
    expect(calls[0]?.body).toMatchObject({ selection: "ranking", order: "desc", top_n: 5 });
  });

  it("selection=ranking 传多个范围机构时拒绝且不发请求", async () => {
    const tool = createStructuredQueryTool();
    const result = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: ["320000000", "321322000"],
      start: "2026-03-31",
      end: "2026-03-31",
      selection: "ranking",
    }, CTX());
    expect(result.details?.status).toBe("error");
    expect(calls).toHaveLength(0);
  });

  it("非 ranking 的 selection 不允许空 org_codes", async () => {
    const tool = createStructuredQueryTool();
    const result = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: [],
      start: "2026-03-31",
      end: "2026-03-31",
      selection: "exact",
    }, CTX());
    expect(result.details?.status).toBe("error");
    expect(calls).toHaveLength(0);
  });

  function stubResultFetch(result: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ query: {}, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  it("unsupported 且 message 为空时，按 error_code 映射可读原因并带 error_code", async () => {
    stubResultFetch({
      task_id: "task-b2",
      status: "unsupported",
      columns: [],
      rows: [],
      row_count: 0,
      error_code: "QUERY_UNSUPPORTED",
      error_message: null,
      message: null,
    });
    const tool = createStructuredQueryTool();
    const result = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: ["32130000001"],
      start: "2026-04-30",
      end: "2026-04-30",
      selection: "exact",
    }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    const content = JSON.parse((result.content[0] as { text: string }).text);
    expect(content.status).toBe("unsupported");
    expect(content.error_code).toBe("QUERY_UNSUPPORTED");
    expect(content.message).toBe("查询条件不受支持或机构编码不在目录中，机构编码必须先经 org_catalog_search 确认。");
  });

  it("ORG_SCOPE_FORBIDDEN 映射为无权原因，error_message 非空时优先后端文案", async () => {
    stubResultFetch({
      task_id: "task-b3",
      status: "failed",
      columns: [],
      rows: [],
      row_count: 0,
      error_code: "ORG_SCOPE_FORBIDDEN",
      error_message: null,
    });
    const tool = createStructuredQueryTool();
    const forbidden = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: ["O1"],
      start: "2026-04-30",
      end: "2026-04-30",
      selection: "exact",
    }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(JSON.parse((forbidden.content[0] as { text: string }).text).message).toBe("无权查询该机构，请确认机构范围。");

    stubResultFetch({
      task_id: "task-b4",
      status: "unsupported",
      columns: [],
      rows: [],
      row_count: 0,
      error_code: "QUERY_UNSUPPORTED",
      error_message: "该指标为不可加口径。",
    });
    const withBackendMessage = await runTool(tool, {
      metric_codes: ["M1"],
      org_codes: ["O1"],
      start: "2026-04-30",
      end: "2026-04-30",
      selection: "exact",
    }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(JSON.parse((withBackendMessage.content[0] as { text: string }).text).message).toBe("该指标为不可加口径。");
  });
});
