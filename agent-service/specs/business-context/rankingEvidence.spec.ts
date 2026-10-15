import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {toCompactTurnArgs} from "../../src/business-context/turnArgs.js";
import {createExecuteBusinessFrameTool, createResolveBusinessTurnTool} from "../../src/tools/businessContext.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
import type {ContextDelta, FieldResolution, ResolvedField, ResolverContext} from "../../src/business-context/types.js";

const schema = createCapabilities().get("metric_query").fields.operation!;
const resolver = createFieldResolvers().getResolver(schema);
const ranking = (position: "top" | "bottom", top_n: number) => ({kind: "ranking", position, top_n});
const previous = (value: unknown): ResolvedField => ({source: "resolved", resolutionStatus: "resolved", resolvedValue: value});
const resolve = (raw: unknown, originalMessage: string, prior?: ResolvedField, extra: Partial<ResolverContext> = {}): Promise<FieldResolution> =>
  resolver.resolve(raw, schema, {originalMessage, currentDate: "2026-10-14", turnId: "current", inputSource: "explicit",
    resolveCatalog: async () => ({status: "not_found"}), ...(prior ? {previous: prior} : {}), ...extra});

describe("排名业务依据独立于参数形状", () => {
  it.each([3, 10, 37])("只说排名不能默认前%d名", async count => {
    const result = await resolve(ranking("top", count), "查询这些机构的存款排名");
    expect(result).toMatchObject({status: "ambiguous", metadata: {userInputIssue: true}});
    expect(result.value).not.toHaveProperty("top_n");
  });

  it.each([
    ["查看前3名", "top", 3], ["查看后十二名", "bottom", 12], ["查看 TOP 7", "top", 7],
    ["查看 bottom 二十", "bottom", 20], ["查看最高的五家", "top", 5], ["查看前一百名", "top", 100],
    ["查看后2位", "bottom", 2], ["看最多的两家", "top", 2],
  ] as const)("明确榜单依据 %s", async (text, position, count) => {
    expect(await resolve(ranking(position, count), text)).toMatchObject({status: "resolved", value: ranking(position, count)});
  });

  it.each(["2026年7月31日这十家机构的排名", "查看前三个月的机构排名", "十家机构排名"])("日期、范围数量不能变成榜单条数：%s", async text => {
    expect(await resolve(ranking("top", 10), text)).toMatchObject({status: "ambiguous"});
  });

  it.each(["前5名改成前3名", "不是前10名而是前3名", "不要前10名，改为前3名"])("更正必须绑定最终目标：%s", async text => {
    expect(await resolve(ranking("top", 3), text)).toMatchObject({status: "resolved", value: ranking("top", 3)});
    await expect(resolve(ranking("top", 10), text)).rejects.toMatchObject({code: "QUERY_OPERATION_EVIDENCE_MISMATCH"});
  });

  it("相互竞争的榜单目标不能选择其中一项执行", async () => {
    expect(await resolve(ranking("top", 5), "看前5名和后3名")).toMatchObject({status: "ambiguous"});
    expect(await resolve(ranking("top", 3), "取消排名，同时看前3名")).toMatchObject({status: "ambiguous"});
    expect(await resolve(ranking("top", 5), "前5名改成3")).toMatchObject({status: "ambiguous"});
  });

  it("已选历史操作可以保留未改变的数量和方向，不能借日期数字换条数", async () => {
    const prior = previous(ranking("top", 4));
    expect(await resolve(ranking("top", 4), "日期换成5月31日", prior)).toMatchObject({status: "resolved"});
    expect(await resolve(ranking("top", 4), "前4名，日期改成5月31日", prior)).toMatchObject({status: "resolved"});
    expect(await resolve(ranking("bottom", 4), "改看后面", prior)).toMatchObject({status: "resolved"});
    await expect(resolve(ranking("top", 5), "日期换成5月31日", prior)).rejects.toMatchObject({code: "QUERY_OPERATION_EVIDENCE_MISMATCH"});
  });

  it.each(["改前101名", "改前0名", "不要前4名", "取消前4名"])("显式无效或否定榜单不回退旧排名：%s", async text => {
    expect(await resolve(ranking("top", 4), text, previous(ranking("top", 4)))).toMatchObject({status: "ambiguous"});
  });

  it("否定仅识别操作语法，机构或指标文本不改变榜单方向和条数", async () => {
    expect(await resolve(ranking("top", 4), "不良贷款余额前4名")).toMatchObject({status: "resolved"});
    expect(await resolve(ranking("top", 4), "查看前4名，机构改成前3路支行")).toMatchObject({status: "resolved"});
    expect(await resolve({kind: "value"}, "返回3家机构的数据")).toMatchObject({status: "resolved"});
    expect(await resolve(ranking("top", 4), "机构改为3家", previous(ranking("top", 4)))).toMatchObject({status: "resolved"});
    await expect(resolve(ranking("top", 3), "机构改为3家", previous(ranking("top", 4))))
      .rejects.toMatchObject({code: "QUERY_OPERATION_EVIDENCE_MISMATCH"});
  });

  it("未知方向时保留用户明确数量，下一轮只补方向可继续", async () => {
    const first = await resolve(ranking("top", 10), "排名只取五名");
    expect(first).toMatchObject({status: "ambiguous", value: {kind: "ranking", top_n: 5}});
    expect(first.value).not.toHaveProperty("position");
    expect(await resolve(ranking("bottom", 5), "看后面", {source: "explicit", resolutionStatus: first.status,
      resolvedValue: first.value, ...(first.metadata ? {metadata: first.metadata} : {})})).toMatchObject({status: "resolved", value: ranking("bottom", 5)});
    const saved: ResolvedField = {source: "explicit", resolutionStatus: first.status,
      resolvedValue: first.value, ...(first.metadata ? {metadata: first.metadata} : {})};
    for (const wrong of [{kind: "value"}, {kind: "rank_position"}]) {
      await expect(resolve(wrong, "看后面", saved)).rejects.toMatchObject({code: "QUERY_OPERATION_EVIDENCE_MISMATCH"});
    }
    expect(await resolve({kind: "rank_position"}, "继续", saved)).toMatchObject({status: "ambiguous", value: {kind: "ranking", top_n: 5}});
  });

  it("位次、普通取值和取消排名不能偷换用户目标", async () => {
    expect(await resolve({kind: "rank_position"}, "这家机构排第几名？")).toMatchObject({status: "resolved"});
    expect(await resolve({kind: "rank_position"}, "看机构排名")).toMatchObject({status: "ambiguous"});
    expect(await resolve({kind: "value"}, "看机构排名")).toMatchObject({status: "ambiguous"});
    expect(await resolve({kind: "value"}, "查询存款余额")).toMatchObject({status: "resolved"});
    expect(await resolve({kind: "value"}, "取消排名，只查数值", previous(ranking("top", 4)))).toMatchObject({status: "resolved"});
    expect(await resolve({kind: "value"}, "不排名全部列出", previous(ranking("top", 4)))).toMatchObject({status: "resolved"});
    await expect(resolve({kind: "value"}, "继续", previous(ranking("top", 4)))).rejects.toMatchObject({code: "QUERY_OPERATION_EVIDENCE_MISMATCH"});
    expect(await resolve({kind: "rank_position"}, "日期改为上月末", previous({kind: "rank_position"}))).toMatchObject({status: "resolved"});
  });

  it("正式指标名称中的排名和数字不构成查询操作", async () => {
    const text = "查询机构甲信贷客户数量排名当日数", metric = "信贷客户数量排名当日数";
    const start = text.indexOf(metric);
    expect(await resolve({kind: "value"}, text, undefined, {resolveMetricMentions: async () => ({mentions: [{text: metric,
      start, end: start + metric.length, resolution: {status: "resolved", value: {codes: ["M"], names: [metric]}}}]})}))
      .toMatchObject({status: "resolved", value: {kind: "value"}});
    const pending = {resolveMetricMentions: async () => ({mentions: [{text: metric, start, end: start + metric.length,
      resolution: {status: "needs_confirmation" as const, candidates: [{code: "M1", value: metric}, {code: "M2", value: `${metric}乙`}]}}]})};
    expect(await resolve({kind: "value"}, text, undefined, pending)).toMatchObject({status: "resolved"});
    expect(await resolve(ranking("top", 5), `${text}前5名`, undefined, pending)).toMatchObject({status: "resolved"});
  });
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});

async function fixture(text = "查询合成甲行2026年7月31日合成余额当日数排名") {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const path = mkdtempSync(join(tmpdir(), "ranking-evidence-"));
  const sessions = new NativeSessionStore(path), owner = "synthetic-ranking-user";
  const session = await sessions.create(owner);
  cleanup.push(async () => {await sessions.close(); rmSync(path, {recursive: true, force: true});});
  const store = new NativeFrameStore(session);
  const backend = {
    resolveBusinessField: vi.fn(async (entity: string, names: string[]) => ({status: "resolved", value: entity === "date"
      ? {start: "2026-07-31", end: "2026-07-31"} : {codes: [entity === "metric" ? "M" : "O"], names}})),
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "synthetic-conversation"})),
    basicQueries: vi.fn(async () => ({result: {status: "succeeded", task_id: "synthetic-task", columns: [], rows: [], row_count: 0}})),
    getTask: vi.fn(async () => ({version: 1, result: {result_id: "synthetic-result"}})),
  };
  const request = testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    sessionId: session.metadata.id, operationId: "initial", requestId: "initial", originalMessage: text, frames: store,
  });
  const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
    fieldIntents: {organizations: {mode: "set", sourceText: "合成甲行", expectedCount: null}}, fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: "合成余额当日数"},
      {fieldHint: "organizations", operation: "set", rawValue: "合成甲行"},
      {fieldHint: "time", operation: "set", rawValue: "2026年7月31日"},
      {fieldHint: "operation", operation: "set", rawValue: ranking("top", 10)},
    ]};
  return {path, sessions, session, owner, store, backend, request, delta};
}

describe.each([false, true])("排名依据通过真实字段入口（compact=%s）", compactTurnArgs => {
  const tool = () => createResolveBusinessTurnTool({compactTurnArgs});
  const call = async (delta: ContextDelta, request: ReturnType<typeof testRequestContext>) =>
    receiptJson(await runTool(tool(), compactTurnArgs ? toCompactTurnArgs(delta) : delta, request));
  const followup = (fieldChanges: ContextDelta["fieldChanges"]): ContextDelta => ({capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
    fieldIntents: {organizations: {mode: "inherit", sourceText: null, expectedCount: null}}, fieldChanges});

  it.each(["排名", "排名只取五名"])("合法形状的猜测保存已知条件，服务重开仅补缺失项：%s", async suffix => {
    const f = await fixture(`查询合成甲行2026年7月31日合成余额当日数${suffix}`);
    const first = await call(f.delta, f.request);
    expect(first.status).toBe("NEEDS_CLARIFICATION");
    const pending = (await f.store.get(String(first.frameId)))!;
    expect(pending.fields.metrics?.resolvedValue).toEqual({codes: ["M"], names: ["合成余额当日数"]});
    expect(pending.fields.organizations?.resolvedValue).toEqual({codes: ["O"], names: ["合成甲行"]});
    expect(pending.fields.time?.resolvedValue).toEqual({start: "2026-07-31", end: "2026-07-31"});
    expect(pending.fields.operation?.resolvedValue).toEqual(suffix === "排名" ? {} : {kind: "ranking", top_n: 5});
    await runTool(createExecuteBusinessFrameTool(), {frameId: first.frameId}, f.request);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    await f.sessions.close();
    const restarted = new NativeSessionStore(f.path);
    cleanup.unshift(async () => {await restarted.close();});
    const restored = new NativeFrameStore(await restarted.open(f.owner, f.session.metadata));
    expect((await restored.get(pending.frameId))?.fields.operation).toEqual(pending.fields.operation);
    const next = {...f.request, frames: restored, originalMessage: suffix === "排名" ? "查看前3名" : "查看后面", operationId: "followup", requestId: "followup"};
    const expected = suffix === "排名" ? ranking("top", 3) : ranking("bottom", 5);
    const ready = await call(followup([{fieldHint: "operation", operation: "set", rawValue: expected}]), next);
    expect(ready.status).toBe("READY");
    const saved = (await restored.get(String(ready.frameId)))!;
    for (const field of ["metrics", "organizations", "time"]) expect(saved.fields[field]?.resolvedValue).toEqual(pending.fields[field]?.resolvedValue);
    await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, next);
    await runTool(createExecuteBusinessFrameTool(), {frameId: ready.frameId}, next);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect((f.backend.basicQueries.mock.calls as unknown[][])[0]![0]).toMatchObject({metric_codes: ["M"], org_codes: ["O"], operation: expected});
  });

  it.each(["omit", "clear", "value"])("未确定排名不能通过%s取消目标", async mode => {
    const f = await fixture();
    const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.filter(item => item.fieldHint !== "operation")};
    if (mode !== "omit") delta.fieldChanges.push(mode === "clear" ? {fieldHint: "operation", operation: "clear"}
      : {fieldHint: "operation", operation: "set", rawValue: {kind: "value"}});
    const result = await call(delta, f.request);
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect((await f.store.get(String(result.frameId)))?.fields.operation?.resolutionStatus).toBe("ambiguous");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it.each(["omit", "value"])("已明确前N被%s吞掉时纠正参数，不重复询问用户", async mode => {
    const f = await fixture("查询合成甲行2026年7月31日合成余额当日数前3名");
    const delta = {...f.delta, fieldChanges: f.delta.fieldChanges.filter(item => item.fieldHint !== "operation")};
    if (mode === "value") delta.fieldChanges.push({fieldHint: "operation", operation: "set", rawValue: {kind: "value"}});
    expect(await call(delta, f.request)).toMatchObject({status: "ARGUMENT_ERROR", error_code: "QUERY_OPERATION_EVIDENCE_MISMATCH",
      corrections: [{field: "operation", reason: "invalid", inputSchema: expect.any(Object)}]});
    expect(await f.store.list()).toEqual([]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("已选历史排名只在有依据时改变，retain或clear不抹去新目标，明确取消可执行", async () => {
    const f = await fixture("查询合成甲行2026年7月31日合成余额当日数前4名");
    const first = await call({...f.delta, fieldChanges: f.delta.fieldChanges.map(item => item.fieldHint === "operation" ? {...item, rawValue: ranking("top", 4)} : item)}, f.request);
    expect(first.status).toBe("READY");
    const date = {...f.request, originalMessage: "日期改成2026年7月31日", operationId: "date", requestId: "date"};
    const inherited = await call(followup([]), date);
    expect(inherited.status).toBe("READY");
    expect((await f.store.get(String(inherited.frameId)))?.fields.operation?.resolvedValue).toEqual(ranking("top", 4));
    for (const mode of ["retain", "clear"] as const) {
      const next = {...f.request, originalMessage: "改看后面", operationId: mode, requestId: mode};
      const result = await call(followup([{fieldHint: "operation", operation: mode}]), next);
      expect(result.status).toBe("ARGUMENT_ERROR");
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
    }
    const cancel = {...f.request, originalMessage: "取消排名，只取数值", operationId: "cancel", requestId: "cancel"};
    const plain = await call(followup([{fieldHint: "operation", operation: "clear"}]), cancel);
    expect(plain.status).toBe("READY");
    await runTool(createExecuteBusinessFrameTool(), {frameId: plain.frameId}, cancel);
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    expect((f.backend.basicQueries.mock.calls as unknown[][])[0]![0]).toMatchObject({operation: {kind: "value"}});
  });

  it.each([
    {reply: "当日数排名", expected: "READY", ranking: false},
    {reply: "当日数排名，另外排名", expected: "NEEDS_CLARIFICATION", ranking: false},
    {reply: "当日数排名，另外查看前3名", expected: "READY", ranking: true},
  ])("候选口径词只消除已确认术语，不吞独立目标：$reply", async ({reply, expected, ranking: hasRanking}) => {
    const text = "查询合成甲行2026年7月31日合成余额", metric = "合成余额";
    const f = await fixture(text), start = text.indexOf(metric);
    const initial = {...f.request, backend: {...f.backend, matchMetricQuestion: async () => ({mentions: [{text: metric, start, end: start + metric.length,
      resolution: {status: "needs_confirmation", candidates: [
        {code: "M-RANK", value: "合成余额当日数排名", metadata: {value_basis: "当日数排名"}},
        {code: "M-VALUE", value: "合成余额当日数", metadata: {value_basis: "当日数"}},
      ]}}]})} as unknown as BackendClient};
    const pending = await call({...f.delta, fieldChanges: f.delta.fieldChanges.filter(item => item.fieldHint !== "operation")
      .map(item => item.fieldHint === "metrics" ? {...item, rawValue: {fromQuestion: true}} : item)}, initial);
    expect(pending.status).toBe("NEEDS_CLARIFICATION");
    const next = {...initial, originalMessage: reply, operationId: "confirm", requestId: "confirm",
      backend: {...f.backend, matchMetricQuestion: async () => ({mentions: []})} as unknown as BackendClient};
    const receipt = await call(followup([{fieldHint: "metrics", operation: "set", rawValue: {confirm: true}},
      ...(hasRanking ? [{fieldHint: "operation", operation: "set" as const, rawValue: ranking("top", 3)}] : [])]), next);
    expect(receipt.status).toBe(expected);
    const frame = (await f.store.get(String(receipt.frameId)))!;
    expect(frame.fields.metrics?.resolvedValue).toEqual({codes: ["M-RANK"], names: ["合成余额当日数排名"]});
    if (expected === "NEEDS_CLARIFICATION") {
      expect(frame.fields.operation?.resolutionStatus).toBe("ambiguous");
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
    } else {
      await runTool(createExecuteBusinessFrameTool(), {frameId: frame.frameId}, next);
      expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
      expect((f.backend.basicQueries.mock.calls as unknown[][])[0]![0]).toMatchObject({metric_codes: ["M-RANK"],
        operation: hasRanking ? ranking("top", 3) : {kind: "value"}});
    }
  });
});
