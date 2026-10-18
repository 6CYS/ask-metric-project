/**
 * 日期契约中性管道桩测试（无真实模型/后端）：
 * a) 路由白名单放行/拒绝 time_override；
 * b) “近N年” alternative 经 Frame metadata 进入 BasicQuerySpec.time_alternative 与 SSE tool_end details（time_variants），并随会话快照还原可读。
 * 语义链路的 modelCalendar/覆盖行为见 specs/semantic-task/timeContract.spec.ts。
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT, type Entry} from "@earendil-works/pi-agent-core";
import {BackendClient} from "../../src/backendClient.js";
import {createBusinessTools} from "../../src/business-context/adapters.js";
import type {BusinessFrame} from "../../src/business-context/types.js";
import {parsePromptInput} from "../../src/routes.js";
import {projectEntries} from "../../src/sessionProjection.js";
import {createStructuredQueryTool} from "../../src/tools/structuredQuery.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../../src/tools/testUtils.js";

const ALTERNATIVE = {label: "最近 3 个完整年度", start: "2023-01-01", end: "2025-12-31"};

describe("路由协议白名单 time_override", () => {
  const base = {protocol_version: 3, request_id: "r1", message: "切换口径"};
  it("放行合法 time_override", () => {
    expect(parsePromptInput({...base, time_override: {start: "2023-01-01", end: "2025-12-31"}}))
      .toMatchObject({time_override: {start: "2023-01-01", end: "2025-12-31"}});
  });
  it.each([
    {start: "2025-12-31", end: "2023-01-01"}, // start 晚于 end
    {start: "2023-02-30", end: "2023-03-01"}, // 非真实日历日期
    {start: "20230101", end: "2025-12-31"},   // 非 YYYY-MM-DD
    {start: "2023-01-01", end: "2025-12-31", label: "x"}, // 多余键
    "2023-01-01",                              // 非对象
  ])("拒绝非法 time_override：%j", override => {
    expect(parsePromptInput({...base, time_override: override})).toBeNull();
  });
  it("未知顶层字段仍整体拒绝", () => {
    expect(parsePromptInput({...base, time_filter: {start: "2023-01-01", end: "2025-12-31"}})).toBeNull();
  });
});

describe("alternative 透传到查询与回执明细", () => {
  const calls: Array<{url: string; body: unknown}> = [];
  const backend = () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({url, body: init?.body ? JSON.parse(String(init.body)) : null});
      if (url.endsWith("/agent-query-contexts")) return Response.json({conversation_id: "synthetic-conversation"});
      if (url.endsWith("/basic-queries")) return Response.json({query: {}, result: {
        task_id: "synthetic-task", status: "succeeded", columns: [], rows: [], row_count: 0}});
      if (url.endsWith("/query-tasks/synthetic-task")) return Response.json({task_id: "synthetic-task", status: "SUCCEEDED",
        version: 1, result: {result_id: "synthetic-result"}});
      throw new Error("UNEXPECTED_SYNTHETIC_REQUEST");
    }));
    return new BackendClient("http://backend.test", "synthetic-token", 5000);
  };
  afterEach(() => {vi.unstubAllGlobals(); calls.length = 0;});

  const frame = (timeMetadata?: Record<string, unknown>): BusinessFrame => ({
    frameId: "f1", sessionId: "session-1", turnId: "t1", requestId: "r1", capability: "metric_query",
    operationFrameId: "f1", issues: [], status: "executing", createdAt: new Date().toISOString(),
    delta: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: []},
    fields: {
      metrics: {resolvedValue: {codes: ["M"], names: ["合成指标"]}, resolutionStatus: "resolved", source: "explicit"},
      organizations: {resolvedValue: {codes: ["O1"], names: ["合成机构甲"]}, resolutionStatus: "resolved", source: "explicit"},
      time: {resolvedValue: {start: "2023-10-15", end: "2026-10-15"}, resolutionStatus: "resolved", source: "explicit",
        ...(timeMetadata ? {metadata: timeMetadata} : {})},
      selection: {resolvedValue: "latest_in_range", resolutionStatus: "resolved", source: "explicit"},
    },
  });
  const executeFrame = (target: BusinessFrame) => createBusinessTools().execute("metric_query_structured", target,
    ["tc-1", {}, () => {}, testRequestContext(backend(), new MemoryCommandBridge()),
      {invocationId: "inv-1", operationId: "op-1", turnId: "t1",
        getMemo: async () => undefined, setMemo: async () => undefined},
      // 与宿主执行路径一致的后台上下文
      BACKGROUND_CONTEXT]);

  it("Frame time metadata 含 alternative：spec 带 time_alternative，details 带 time_variants，快照还原可读", async () => {
    const result = await executeFrame(frame({timeAlternative: ALTERNATIVE, timeSource: "model"}));
    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("succeeded");
    expect(details.time_variants).toEqual([ALTERNATIVE]);
    expect(calls.find(call => call.url.endsWith("/basic-queries"))?.body).toMatchObject({
      time: {start: "2023-10-15", end: "2026-10-15"}, time_alternative: ALTERNATIVE});
    // details 原样写入会话投影，历史还原可读到切换口径
    const entry = {type: "message", id: "e1", timestamp: 1,
      message: {role: "toolResult", toolName: "metric_query_structured", details}} as Entry;
    const projected = projectEntries([entry]);
    expect(projected.find(message => message.role === "tool")?.details).toMatchObject({time_variants: [ALTERNATIVE]});
  });

  it("无 alternative 或畸形值：不注入 time_alternative/time_variants", async () => {
    const plain = await executeFrame(frame());
    expect((plain.details as Record<string, unknown>).time_variants).toBeUndefined();
    const malformed = await runTool(createStructuredQueryTool(), {
      metric_codes: ["M"], org_codes: ["O1"], start: "2023-10-15", end: "2026-10-15", selection: "latest_in_range",
      time_alternative: {label: "反向区间", start: "2025-12-31", end: "2023-01-01"}},
    testRequestContext(backend(), new MemoryCommandBridge()));
    expect((malformed.details as Record<string, unknown>).status).toBe("succeeded");
    expect((malformed.details as Record<string, unknown>).time_variants).toBeUndefined();
    for (const call of calls.filter(item => item.url.endsWith("/basic-queries"))) {
      expect(call.body).not.toHaveProperty("time_alternative");
    }
  });
});
