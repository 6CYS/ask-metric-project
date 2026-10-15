/**
 * 日期契约桩测试（无真实模型/后端）：
 * a) date resolver 携带与缺省 model_value 两种路径，及宿主 timeOverride 短路；
 * b) 路由白名单放行/拒绝 time_override；
 * c) “近N年” alternative 进入 BasicQuerySpec 与 SSE tool_end details，并随会话快照还原可读。
 */
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {BACKGROUND_CONTEXT, type Entry} from "@earendil-works/pi-agent-core";
import {BackendClient} from "../../src/backendClient.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createBusinessTools} from "../../src/business-context/adapters.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import type {BusinessFrame, ContextDelta, FieldResolution, ResolverContext} from "../../src/business-context/types.js";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {parsePromptInput} from "../../src/routes.js";
import {projectEntries} from "../../src/sessionProjection.js";
import {createStructuredQueryTool} from "../../src/tools/structuredQuery.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../../src/tools/testUtils.js";

const timeSchema = createCapabilities().get("metric_query").fields.time!;
const dateResolver = createFieldResolvers().getResolver(timeSchema);
const ALTERNATIVE = {label: "最近 3 个完整年度", start: "2023-01-01", end: "2025-12-31"};

const resolverContext = (overrides: Partial<ResolverContext> = {}): ResolverContext => ({
  originalMessage: "查询合成机构甲近三年合成指标", currentDate: "2026-10-15", turnId: "t1",
  resolveCatalog: async () => ({status: "resolved", value: {start: "2023-10-15", end: "2026-10-15"}}),
  ...overrides,
});

describe("date resolver 模型换算通道", () => {
  it("携带 modelValue：随原文发给 resolve-field，alternative 与 resolution_source 存入字段 metadata", async () => {
    const resolveCatalog = vi.fn(async (): Promise<FieldResolution> => ({status: "resolved",
      value: {start: "2023-10-15", end: "2026-10-15"}, alternative: ALTERNATIVE, metadata: {resolution_source: "model"}}));
    const resolution = await dateResolver.resolve({rawValue: "近三年", modelValue: {start: "2023-10-15", end: "2026-10-15"}},
      timeSchema, resolverContext({resolveCatalog}));
    expect(resolveCatalog).toHaveBeenCalledWith("date", ["近三年"], undefined, {start: "2023-10-15", end: "2026-10-15"});
    expect(resolution.status).toBe("resolved");
    expect(resolution.metadata?.timeAlternative).toEqual(ALTERNATIVE);
    expect(resolution.metadata?.resolution_source).toBe("model");
  });

  it("缺省 modelValue（纯原文串旧路径）：不带 model_value 调用", async () => {
    const resolveCatalog = vi.fn(async (): Promise<FieldResolution> =>
      ({status: "resolved", value: {start: "2026-04-30", end: "2026-04-30"}}));
    const resolution = await dateResolver.resolve("2026年4月末", timeSchema,
      resolverContext({originalMessage: "2026年4月末合成指标", resolveCatalog}));
    expect(resolveCatalog).toHaveBeenCalledWith("date", ["2026年4月末"], undefined, undefined);
    expect(resolution.status).toBe("resolved");
    expect(resolution.metadata?.timeAlternative).toBeUndefined();
  });

  it("畸形 modelValue 宽松丢弃，按未提交处理（严格校验在服务端）", async () => {
    const resolveCatalog = vi.fn(async (): Promise<FieldResolution> =>
      ({status: "resolved", value: {start: "2023-10-15", end: "2026-10-15"}}));
    await dateResolver.resolve({rawValue: "近三年", modelValue: {start: "10-15", end: "2026-10-15"}},
      timeSchema, resolverContext({resolveCatalog}));
    expect(resolveCatalog).toHaveBeenCalledWith("date", ["近三年"], undefined, undefined);
  });

  it("宿主 timeOverride：跳过原文解析与模型换算，不调用后端", async () => {
    const resolveCatalog = vi.fn(async (): Promise<FieldResolution> => {throw new Error("不应调用后端");});
    const resolution = await dateResolver.resolve({rawValue: "近三年", modelValue: {start: "2023-10-15", end: "2026-10-15"}},
      timeSchema, resolverContext({resolveCatalog, timeOverride: {start: "2023-01-01", end: "2025-12-31"}}));
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({status: "resolved", value: {start: "2023-01-01", end: "2025-12-31"},
      metadata: {timeSource: "user_override"}});
  });
});

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

describe("Frame 解析与时间覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "time-contract-"));
  afterEach(async () => undefined);
  it("override 等同用户明确指定：覆盖继承时间且不再解析日期", async () => {
    const sessions = new NativeSessionStore(dir);
    try {
      const session = await sessions.create("user-1");
      const store = new NativeFrameStore(session);
      const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
      const resolveCatalog = vi.fn(async (entity: string): Promise<FieldResolution> => entity === "date"
        ? {status: "resolved", value: {start: "2023-10-15", end: "2026-10-15"}, alternative: ALTERNATIVE,
          metadata: {resolution_source: "deterministic"}}
        : {status: "resolved", value: {codes: [entity === "metric" ? "M" : "O1"], names: [entity === "metric" ? "合成指标" : "合成机构甲"]}});
      const message = "查询合成机构甲近三年合成指标";
      const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
        {fieldHint: "metrics", operation: "set", rawValue: "合成指标"},
        {fieldHint: "organizations", operation: "set", rawValue: "合成机构甲"},
        {fieldHint: "time", operation: "set", rawValue: {rawValue: "近三年", modelValue: {start: "2023-10-15", end: "2026-10-15"}}},
        {fieldHint: "selection", operation: "set", rawValue: "latest_in_range"},
      ]};
      const ready = await service.resolve(delta, {sessionId: session.metadata.id, requestId: "r1", turnId: "t1"},
        resolverContext({resolveCatalog, originalMessage: message}));
      expect(ready.status).toBe("ready");
      expect(ready.fields.time?.metadata?.timeAlternative).toEqual(ALTERNATIVE);
      expect(resolveCatalog).toHaveBeenCalledWith("date", ["近三年"], undefined, {start: "2023-10-15", end: "2026-10-15"});

      resolveCatalog.mockClear();
      const switched = await service.resolve(
        {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldChanges: []},
        {sessionId: session.metadata.id, requestId: "r2", turnId: "t2"},
        resolverContext({originalMessage: "切换口径", turnId: "t2", resolveCatalog,
          timeOverride: {start: "2023-01-01", end: "2025-12-31"}}));
      expect(switched.status).toBe("ready");
      expect(switched.fields.time).toMatchObject({resolvedValue: {start: "2023-01-01", end: "2025-12-31"},
        source: "explicit", resolutionStatus: "resolved", metadata: {timeSource: "user_override"}});
      // 切换后不再携带旧备选口径；继承字段不再重新解析
      expect(switched.fields.time?.metadata?.timeAlternative).toBeUndefined();
      expect(resolveCatalog).not.toHaveBeenCalled();
    } finally {
      await sessions.close();
      rmSync(dir, {recursive: true, force: true});
    }
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
