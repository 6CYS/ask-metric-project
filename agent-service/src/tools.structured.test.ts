/**
 * metric_query_structured 工具测试：参数透传、selection 校验、错误处理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStructuredQueryTool } from "./tools.js";
import { BackendClient } from "./backendClient.js";

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
  const calls: Array<{ url: string; body: unknown; idempotency: string | null }> = [];
  beforeEach(() => stubFetch(calls));
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  it("按契约透传编码、日期与 selection，并去重编码", async () => {
    const tool = createStructuredQueryTool(new BackendClient("http://backend.test", "user-token", 5000));
    const result = await tool.execute("tc1", {
      metric_codes: ["M1", "M1"],
      org_codes: ["320626000"],
      start: "2026-04-01",
      end: "2026-04-30",
      selection: "latest_in_range",
    });
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
    const tool = createStructuredQueryTool(new BackendClient("http://backend.test", "user-token", 5000));
    const result = await tool.execute("tc2", {
      metric_codes: ["M1"],
      org_codes: ["O1"],
      start: "2026-04-01",
      end: "2026-04-30",
      selection: "exact",
    });
    expect(result.details?.status).toBe("error");
    expect(calls).toHaveLength(0);
  });

  it("start 晚于 end 时拒绝", async () => {
    const tool = createStructuredQueryTool(new BackendClient("http://backend.test", "user-token", 5000));
    const result = await tool.execute("tc3", {
      metric_codes: ["M1"],
      org_codes: ["O1"],
      start: "2026-05-01",
      end: "2026-04-30",
      selection: "latest_in_range",
    });
    expect(result.details?.status).toBe("error");
    expect(calls).toHaveLength(0);
  });
});
