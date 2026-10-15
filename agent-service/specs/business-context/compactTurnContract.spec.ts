/**
 * 旧参数内部兼容回归：独立手写两种历史入参，经过实际 prepare / 原生 Schema 校验 / 工具执行。
 * 文件末尾另外核验实际注册的唯一模型入口及真实适配器序列化。
 * 桩只提供明确的合成目录事实，不理解模型提示，也不把范围字符串猜成范围对象。
 */
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {validateToolArguments, type Model} from "@earendil-works/pi-ai";
import {openAICompletionsApi} from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {BackendClient, BasicQuerySpec} from "../../src/backendClient.js";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import type {AskMetricRequestContext} from "../../src/requestContext.js";
import {withToolExecutionAudit} from "../../src/toolAudit.js";
import {createAskMetricTools} from "../../src/tools/index.js";
import {createResolveBusinessTurnTool} from "../../src/tools/businessContext.js";
import {MemoryCommandBridge, receiptJson, runTool, testRequestContext} from "../../src/tools/testUtils.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {NativeBusinessResultStore, NativeFrameStore} from "../../src/business-context/store.js";
import {toContextDelta} from "../../src/business-context/turnArgs.js";
import type {FieldResolution, FieldTurnIntent, OrganizationScopeInput} from "../../src/business-context/types.js";

type InputPair = {legacy: Record<string, unknown>; compact: Record<string, unknown>};
type Format = keyof InputPair;
const formats: Format[] = ["legacy", "compact"];
const metricNames = ["信贷客户数量当日数", "合成贷款余额当日数", "合成贷款余额排名"];
const orgNames = ["合成甲农商行", "合成乙农商行"];
const dateText = "2026年4月末";
const ranking = {kind: "ranking", position: "top", top_n: 3};
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {vi.spyOn(console, "info").mockImplementation(() => {});});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

// 两棵参数树各自声明；不能用生产转换器生成另一种输入或“期望值”。
function initialInputs(organizations: unknown, operation: unknown = ranking): InputPair {
  return {
    legacy: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
      {fieldHint: "metrics", operation: "set", rawValue: {fromQuestion: true}},
      {fieldHint: "organizations", operation: "set", rawValue: organizations},
      {fieldHint: "time", operation: "set", rawValue: dateText},
      {fieldHint: "selection", operation: "set", rawValue: "exact"},
      {fieldHint: "operation", operation: "set", rawValue: operation},
    ]},
    compact: {capability: "metric_query", base: null, mode: "execute", set: {
      metrics: {fromQuestion: true}, organizations, time: dateText, selection: "exact", operation,
    }},
  };
}

async function fixture(compactTurnArgs: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "compact-turn-contract-"));
  const sessions = new NativeSessionStore(dir);
  const session = await sessions.create("synthetic-contract-user");
  cleanup.push(async () => {await sessions.close(); rmSync(dir, {recursive: true, force: true});});
  const frames = new NativeFrameStore(session);
  const results = new NativeBusinessResultStore(session);
  const backend = {
    matchMetricQuestion: vi.fn(async (question: string) => ({mentions: metricNames.flatMap((text, index) => {
      const start = question.indexOf(text);
      return start < 0 ? [] : [{text, start, end: start + text.length,
        resolution: {status: "resolved" as const, value: {codes: [`M${index + 1}`], names: [text]}}}];
    }).sort((a, b) => a.start - b.start)})),
    resolveBusinessField: vi.fn(async (entity: string, raw: string[]): Promise<FieldResolution> => {
      if (entity === "date") {
        const date = raw[0]?.includes("5月") ? "2026-05-31" : "2026-04-30";
        return {status: "resolved", value: {start: date, end: date}};
      }
      if (entity === "organization" && raw.every(name => orgNames.includes(name))) {
        return {status: "resolved", value: {codes: raw.map(name => `O${orgNames.indexOf(name) + 1}`), names: raw}};
      }
      return {status: "not_found"};
    }),
    resolveOrganizationScope: vi.fn(async (input: OrganizationScopeInput): Promise<FieldResolution> => ({
      status: "resolved", value: input.kind === "authorized_cohort"
        ? {codes: ["O1", "O2"], names: orgNames, scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}, scope_fingerprint: "a".repeat(64)}
        : {codes: ["C1", "C2"], names: ["合成甲支行", "合成乙支行"], scope: {kind: "children_of", parent_code: "O1"}, scope_fingerprint: "b".repeat(64)},
    })),
    createAgentQueryContext: vi.fn(async () => ({conversation_id: "synthetic-conversation"})),
    basicQueries: vi.fn(async (_spec: BasicQuerySpec) => ({result: {
      status: "succeeded", task_id: "synthetic-task", columns: [], rows: [], row_count: 0,
    }})),
    getTask: vi.fn(async () => ({version: 1, result: {result_id: "synthetic-result"}})),
  };
  const tools = createAskMetricTools({compactTurnArgs}).map(tool => tool.name === "resolve_business_turn"
    ? createResolveBusinessTurnTool({compactTurnArgs}) : tool).map(withToolExecutionAudit);
  const tool = (name: string) => tools.find(candidate => candidate.name === name)!;
  let turnSeq = 0;
  const turn = (message: string) => testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    sessionId: session.metadata.id, frames, businessResults: results, originalMessage: message,
    requestId: `request-${++turnSeq}`, operationId: `turn-${turnSeq}`,
  });
  return {frames, backend, tool, turn};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function validatedArguments(tool: AgentHarnessTool<AskMetricRequestContext>, args: Record<string, unknown>) {
  const prepared = tool.prepareArguments?.(args) ?? args;
  return validateToolArguments(tool, {type: "toolCall", id: "contract-call", name: tool.name, arguments: prepared as Record<string, unknown>});
}
/** 仅夹具声明既定机构意图；两种手写方言仍独立经过准备与校验，不在生产入口补参。 */
function fixtureFieldIntents(args: Record<string, unknown>, request: AskMetricRequestContext): Record<string, FieldTurnIntent> {
  if (args.fieldIntents) return args.fieldIntents as Record<string, FieldTurnIntent>;
  let mode: FieldTurnIntent["mode"] = "inherit";
  let raw: unknown;
  if (Array.isArray(args.fieldChanges)) {
    const change = (args.fieldChanges as Array<{fieldHint: string; operation: FieldTurnIntent["mode"] | "retain"; rawValue?: unknown}>)
      .find(item => item.fieldHint === "organizations");
    if (change && change.operation !== "retain") { mode = change.operation; raw = change.rawValue; }
  } else {
    const set = args.set as Record<string, unknown> | undefined;
    const remove = args.remove as Record<string, unknown> | undefined;
    if (set && Object.hasOwn(set, "organizations")) { mode = "set"; raw = set.organizations; }
    else if (remove && Object.hasOwn(remove, "organizations")) { mode = "remove"; raw = remove.organizations; }
    else if (Array.isArray(args.clear) && args.clear.includes("organizations")) mode = "clear";
  }
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (mode === "set" && value && ("confirm" in value || "candidateIndex" in value)) mode = "confirm";
  const expectedCount = mode === "set" && value?.fromHistory === true && typeof value.expectedCount === "number"
    && Number.isInteger(value.expectedCount) && value.expectedCount > 0 ? value.expectedCount : null;
  return {organizations: {mode, sourceText: mode === "inherit" ? null : request.originalMessage, expectedCount}};
}
async function resolve(f: Fixture, args: Record<string, unknown>, request: AskMetricRequestContext) {
  const tool = f.tool("resolve_business_turn");
  const validated = validatedArguments(tool, {...args, fieldIntents: fixtureFieldIntents(args, request)});
  return {validated, receipt: receiptJson(await runTool(tool, validated, request))};
}
async function execute(f: Fixture, frameId: unknown, request: AskMetricRequestContext) {
  const tool = f.tool("execute_business_frame");
  const receipt = receiptJson(await runTool(tool, validatedArguments(tool, {frameId}), request));
  expect(receipt.status).toBe("succeeded");
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  return f.backend.basicQueries.mock.calls[0]![0];
}

const targets = [
  {name: "授权农商行集合", text: "各家农商行", raw: {kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "各家农商行"},
    expected: {organization_scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}, scope_fingerprint: "a".repeat(64)}},
  {name: "下辖集合", text: "合成甲农商行下属支行", raw: {kind: "children_of", parentName: "合成甲农商行", sourceText: "合成甲农商行下属支行"},
    expected: {organization_scope: {kind: "children_of", parent_code: "O1"}, scope_fingerprint: "b".repeat(64)}},
  {name: "明确本级机构", text: "合成甲农商行", raw: "合成甲农商行", expected: {org_codes: ["O1"]}},
  {name: "两家明确机构", text: "合成甲农商行和合成乙农商行", raw: ["合成甲农商行", "合成乙农商行"], expected: {org_codes: ["O1", "O2"]}},
];

describe.each([false, true])("旧参数内部兼容与业务契约 compactTurnArgs=%s", compactTurnArgs => {
  describe.each(formats)("独立手写%s输入", format => {
    it.each(targets)("$name经过prepare/validate后执行相同正式查询", async target => {
      const f = await fixture(compactTurnArgs);
      const input = initialInputs(target.raw);
      const before = structuredClone(input[format]);
      const request = f.turn(`查询${target.text}${dateText}${metricNames[0]}前3名`);
      const resolved = await resolve(f, input[format], request);
      expect(toContextDelta(resolved.validated)).toEqual({...input.legacy, fieldIntents: fixtureFieldIntents(input.legacy, request)});
      expect(input[format]).toEqual(before);
      expect(resolved.receipt.status).toBe("READY");
      const query = await execute(f, resolved.receipt.frameId, request);
      expect(query).toMatchObject({...target.expected, metric_codes: ["M1"],
        time: {start: "2026-04-30", end: "2026-04-30"}, selection: "exact", operation: ranking});
      expect(query).not.toHaveProperty(target.expected.org_codes ? "organization_scope" : "org_codes");
      expect(f.backend.resolveOrganizationScope).toHaveBeenCalledTimes(target.expected.org_codes ? 0 : 1);
    });

    it.each(["各家农商行", "合成甲农商行下属支行"])("真实失败的范围字符串%s仍合法，不自动猜测或扩大范围", async raw => {
      const f = await fixture(compactTurnArgs);
      const request = f.turn(`查询${raw}${dateText}${metricNames[0]}前3名`);
      const resolved = await resolve(f, initialInputs(raw)[format], request);
      expect(toContextDelta(resolved.validated).fieldChanges).toContainEqual({fieldHint: "organizations", operation: "set", rawValue: raw});
      expect(resolved.receipt).toMatchObject({status: "NEEDS_CLARIFICATION", issues: [{field: "organizations", reason: "not_found"}]});
      const frame = await f.frames.get(String(resolved.receipt.frameId));
      expect(frame?.fields.organizations?.rawValue).toBe(raw);
      expect(f.backend.resolveOrganizationScope).not.toHaveBeenCalled();
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
    });

    it.each([
      {name: "名称中的排名不自动产生排序", operation: {kind: "value"}},
      {name: "真实错加排名参数不能凭合法形状执行", operation: {kind: "ranking", position: "top", top_n: 1}},
    ])("$name", async ({operation}) => {
      const f = await fixture(compactTurnArgs);
      const request = f.turn(`查询合成甲农商行${dateText}的指标“${metricNames[2]}”`);
      const resolved = await resolve(f, initialInputs("合成甲农商行", operation)[format], request);
      if (operation.kind === "ranking") {
        expect(resolved.receipt.status).toBe("NEEDS_CLARIFICATION");
        expect((await f.frames.get(String(resolved.receipt.frameId)))?.fields.operation?.resolutionStatus).toBe("ambiguous");
        expect(f.backend.basicQueries).not.toHaveBeenCalled();
      } else {
        expect(resolved.receipt.status).toBe("READY");
        expect(await execute(f, resolved.receipt.frameId, request)).toMatchObject({metric_codes: ["M3"], org_codes: ["O1"], operation});
      }
    });

    it("未知字段与非法字段值仍走原业务参数错误，不写Frame或查询", async () => {
      const f = await fixture(compactTurnArgs);
      const request = f.turn(`查询合成甲农商行${dateText}${metricNames[0]}前3名`);
      const unknown: InputPair = {
        legacy: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [{fieldHint: "invented", operation: "set", rawValue: "x"}]},
        compact: {capability: "metric_query", base: null, mode: "execute", set: {invented: "x"}},
      };
      const before = await f.frames.state();
      const unexpected = await resolve(f, unknown[format], request);
      expect(unexpected.receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_CHANGES_INVALID", focus_preserved: true});
      const badValue = await resolve(f, initialInputs("合成甲农商行", {kind: "ranking", position: "top", top_n: 0})[format], request);
      expect(badValue.receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INPUT_SCHEMA_INVALID", field: "operation", focus_preserved: true});
      expect(await f.frames.state()).toEqual(before);
      expect(await f.frames.list()).toEqual([]);
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
    });

    it("缺少或非法来源在原生校验前后均不能被补成当前焦点", async () => {
      const f = await fixture(compactTurnArgs);
      const tool = f.tool("resolve_business_turn");
      const input = initialInputs("合成甲农商行")[format];
      const args: Record<string, unknown> = {...input, fieldIntents: fixtureFieldIntents(input, f.turn("查询合成甲农商行"))};
      const baseKey = format === "legacy" ? "baseReference" : "base";
      const omitted = {...args}; delete omitted[baseKey];
      const before = await f.frames.state();
      expect(() => validatedArguments(tool, omitted)).toThrow();
      expect(() => validatedArguments(tool, {...args, [baseKey]: {ordinal: 0}})).toThrow();
      expect(await f.frames.state()).toEqual(before);
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
    });

    it("重复修改不能在准备阶段丢失：同方言报业务错误，跨方言仍由原生Schema拒绝", async () => {
      const f = await fixture(compactTurnArgs);
      const input: InputPair = {
        legacy: {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [
          {fieldHint: "time", operation: "set", rawValue: dateText}, {fieldHint: "time", operation: "retain"},
        ]},
        compact: {capability: "metric_query", base: null, mode: "execute", set: {time: dateText}, retain: ["time"]},
      };
      const before = await f.frames.state();
      if (format === (compactTurnArgs ? "compact" : "legacy")) {
        const result = await resolve(f, input[format], f.turn(`查询${dateText}`));
        expect(result.receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_CHANGES_INVALID", focus_preserved: true});
      } else {
        // 错误输入无法无损转换，原生校验拒绝原参数；不能直接execute伪造纠错回执。
        expect(() => validatedArguments(f.tool("resolve_business_turn"), {...input[format],
          fieldIntents: fixtureFieldIntents(input[format], f.turn(`查询${dateText}`))})).toThrow();
      }
      expect(await f.frames.state()).toEqual(before);
      expect(await f.frames.list()).toEqual([]);
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
    });

    it("set/remove/clear/retain合并一轮变化，清除机构阻止查询，下一轮补齐后执行剩余指标", async () => {
      const f = await fixture(compactTurnArgs);
      const seed = await resolve(f, initialInputs("合成甲农商行")[format],
        f.turn(`查询合成甲农商行${dateText}${metricNames[0]}、${metricNames[1]}前3名`));
      expect(seed.receipt.status).toBe("READY");
      const request = f.turn(`不要${metricNames[1]}了，日期改成2026年5月末，取消排名，清除机构，取数方式不变`);
      const changes: InputPair = {
        legacy: {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldChanges: [
          {fieldHint: "time", operation: "set", rawValue: "2026年5月末"},
          {fieldHint: "operation", operation: "set", rawValue: {kind: "value"}},
          {fieldHint: "metrics", operation: "remove", rawValue: {mentionIndexes: [2]}},
          {fieldHint: "organizations", operation: "clear"}, {fieldHint: "selection", operation: "retain"},
        ]},
        compact: {capability: "metric_query", base: "current", mode: "execute", set: {time: "2026年5月末", operation: {kind: "value"}},
          remove: {metrics: {mentionIndexes: [2]}}, clear: ["organizations"], retain: ["selection"]},
      };
      const changed = await resolve(f, changes[format], request);
      expect(toContextDelta(changed.validated)).toEqual({...changes.legacy, fieldIntents: fixtureFieldIntents(changes.legacy, request)});
      expect(changed.receipt).toMatchObject({status: "NEEDS_CLARIFICATION", issues: [{field: "organizations", reason: "missing"}]});
      const frame = await f.frames.get(String(changed.receipt.frameId));
      expect(frame).toMatchObject({parentFrameId: seed.receipt.frameId, fields: {
        metrics: {resolvedValue: {codes: ["M1"]}}, organizations: {resolutionStatus: "missing"},
        time: {resolvedValue: {start: "2026-05-31", end: "2026-05-31"}}, operation: {resolvedValue: {kind: "value"}},
        selection: {resolvedValue: "exact", sourceFrameId: seed.receipt.frameId},
      }});
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
      const next = f.turn("机构是合成乙农商行");
      const supplement: InputPair = {
        legacy: {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldChanges: [{fieldHint: "organizations", operation: "set", rawValue: "合成乙农商行"}]},
        compact: {capability: "metric_query", base: "current", mode: "execute", set: {organizations: "合成乙农商行"}},
      };
      const completed = await resolve(f, supplement[format], next);
      expect(completed.receipt.status).toBe("READY");
      expect(await execute(f, completed.receipt.frameId, next)).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"],
        time: {start: "2026-05-31", end: "2026-05-31"}, operation: {kind: "value"}, selection: "exact"});
    });

    it("错误后重交整轮有效变化，保留所选历史来源、机构与排名，不退回当前焦点", async () => {
      const f = await fixture(compactTurnArgs);
      const first = await resolve(f, initialInputs("合成甲农商行")[format], f.turn(`查询合成甲农商行${dateText}${metricNames[0]}前3名`));
      const second = await resolve(f, initialInputs("合成乙农商行")[format], f.turn(`查询合成乙农商行${dateText}${metricNames[1]}前3名`));
      const before = await f.frames.state(); const beforeFrames = await f.frames.list();
      expect(before.focusFrameId).toBe(second.receipt.frameId);
      const request = f.turn("沿用第一笔，机构改合成乙农商行，日期换2026年5月末，排名后2名");
      const bad: InputPair = {
        legacy: {capabilityHint: "metric_query", baseReference: {ordinal: 1}, executionMode: "execute", fieldChanges: [
          {fieldHint: "time", operation: "set", rawValue: "2026年5月末"},
          {fieldHint: "organizations", operation: "set", rawValue: "合成乙农商行"},
          {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "lowest", top_n: 2}},
        ]},
        compact: {capability: "metric_query", base: {ordinal: 1}, mode: "execute", set: {time: "2026年5月末", organizations: "合成乙农商行",
          operation: {kind: "ranking", position: "lowest", top_n: 2}}},
      };
      const wrong = await resolve(f, bad[format], request);
      expect(wrong.receipt).toMatchObject({status: "ARGUMENT_ERROR", error_code: "FIELD_INPUT_SCHEMA_INVALID", field: "operation", focus_preserved: true,
        retry_reference: {frameId: first.receipt.frameId}});
      expect(await f.frames.state()).toEqual(before); expect(await f.frames.list()).toEqual(beforeFrames);
      expect(f.backend.basicQueries).not.toHaveBeenCalled();
      const corrected: InputPair = {
        legacy: {capabilityHint: "metric_query", baseReference: wrong.receipt.retry_reference, executionMode: "execute", fieldChanges: [
          {fieldHint: "time", operation: "set", rawValue: "2026年5月末"}, {fieldHint: "organizations", operation: "set", rawValue: "合成乙农商行"},
          {fieldHint: "operation", operation: "set", rawValue: {kind: "ranking", position: "bottom", top_n: 2}},
          {fieldHint: "selection", operation: "set", rawValue: "exact"},
        ]},
        compact: {capability: "metric_query", base: wrong.receipt.retry_reference, mode: "execute", set: {time: "2026年5月末",
          organizations: "合成乙农商行", operation: {kind: "ranking", position: "bottom", top_n: 2}, selection: "exact"}},
      };
      const fixed = await resolve(f, corrected[format], request);
      expect(fixed.receipt.status).toBe("READY");
      expect((await f.frames.get(String(fixed.receipt.frameId)))?.parentFrameId).toBe(first.receipt.frameId);
      expect(await execute(f, fixed.receipt.frameId, request)).toMatchObject({metric_codes: ["M1"], org_codes: ["O2"],
        time: {start: "2026-05-31", end: "2026-05-31"}, selection: "exact", operation: {kind: "ranking", position: "bottom", top_n: 2}});
      for (const frame of beforeFrames) expect(await f.frames.get(frame.frameId)).toEqual(frame);
    });
  });
});

it("唯一模型入口Schema给出固定字段并在入口拒绝未知字段与错形值", () => {
  const tool = createAskMetricTools({compactTurnArgs: true}).find(candidate => candidate.name === "resolve_business_turn")!;
  const schema = JSON.parse(JSON.stringify(tool.parameters)) as {required: string[]; oneOf: Array<{
    additionalProperties: boolean; properties: {capability: {const: string}; changes: {
      properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean;
    }};
  }>};
  const declared = [...new Set(createCapabilities().list().flatMap(capability => Object.keys(capability.fields)))].sort();
  expect(schema.required).toEqual(["protocol_version", "capability", "base", "mode", "changes"]);
  expect(schema.oneOf).toHaveLength(3);
  expect([...new Set(schema.oneOf.flatMap(branch => Object.keys(branch.properties.changes.properties)))].sort()).toEqual(declared);
  for (const branch of schema.oneOf) {
    const capability = createCapabilities().get(branch.properties.capability.const);
    expect(Object.keys(branch.properties.changes.properties).sort()).toEqual(Object.keys(capability.fields).sort());
    expect(branch.properties.changes.required ?? []).toEqual(capability.fields.organizations ? ["organizations"] : []);
    expect(branch.additionalProperties).toBe(false);
    expect(branch.properties.changes.additionalProperties).toBe(false);
  }
  const base = {protocol_version: 1, capability: "metric_query", base: null, mode: "execute"};
  for (const wrong of [
    {organizations: {action: "inherit"}, invented: {action: "set", value: {arbitrary: true}}},
    {organizations: {action: "inherit"}, metrics: {action: "set", value: {unexpected: true}}},
    {organizations: {action: "inherit"}, operation: {action: "set", value: {kind: "ranking", position: "top", top_n: null}}},
    {organizations: {action: "inherit"}, dimension: {action: "set", value: "metrics"}},
  ]) expect(() => validatedArguments(tool, {...base, changes: wrong})).toThrow();
  expect(() => validatedArguments(tool, {fieldIntents: {}, capabilityHint: "metric_query", baseReference: null,
    executionMode: "execute", fieldChanges: []})).toThrow();
});

it("真实OpenAI适配器在onPayload后发送具名字段Schema，传输仅到桩fetch", async () => {
  const tool = createAskMetricTools({compactTurnArgs: true}).find(candidate => candidate.name === "resolve_business_turn")!;
  const payloads: Array<Record<string, unknown>> = [];
  const fetchStub = vi.fn<typeof fetch>(async (input, init) => {
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    payloads.push(JSON.parse(String(body)) as Record<string, unknown>);
    const chunk = {id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{index: 0, delta: {role: "assistant", content: "合成回答"}, finish_reason: "stop"}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {status: 200, headers: {"content-type": "text/event-stream"}});
  });
  const model: Model<"openai-completions"> = {id: "synthetic", name: "synthetic", api: "openai-completions", provider: "openai", baseUrl: "http://synthetic.invalid/v1",
    reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 1024};
  const stream = openAICompletionsApi().streamSimple(model, {systemPrompt: "合成测试", messages: [{role: "user", content: "测试", timestamp: 1}], tools: [tool]}, {
    apiKey: "synthetic-only", fetch: fetchStub, onPayload: payload => ({...payload as object, tool_choice: "required"}),
  });
  expect((await stream.result()).stopReason).toBe("stop");
  expect(fetchStub).toHaveBeenCalledTimes(1);
  expect(payloads[0]?.tool_choice).toBe("required");
  const sentTools = payloads[0]?.tools as Array<{function: {name: string; parameters: Record<string, unknown>}}>;
  expect(sentTools[0]?.function.name).toBe("resolve_business_turn");
  expect(sentTools[0]?.function.parameters).toEqual(JSON.parse(JSON.stringify(tool.parameters)));
});
