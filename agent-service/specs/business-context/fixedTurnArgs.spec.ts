import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import {fixedFieldChangeSchema, fixedTurnParameters, fromFixedTurnArgs, isFixedTurnArgs, toFixedTurnArgs} from "../../src/business-context/fixedTurnArgs.js";
import type {ContextDelta} from "../../src/business-context/types.js";
import {NativeSessionStore} from "../../src/nativeSessions.js";
import {NativeFrameStore} from "../../src/business-context/store.js";
import {BusinessContextService} from "../../src/business-context/service.js";
import {createCapabilities} from "../../src/business-context/capabilities.js";
import {createFieldResolvers} from "../../src/business-context/resolvers.js";
import type {BusinessFrame} from "../../src/business-context/types.js";

const inherit = {action: "inherit"};
const query = (changes: Record<string, unknown>, base: unknown = null) => ({protocol_version: 1, capability: "metric_query", base,
  mode: "execute", changes: {organizations: inherit, ...changes}});
const org = {action: "set", source_text: "机构甲", expected_count: null, value: {kind: "names", names: ["机构甲"]}};

describe("唯一固定业务入口", () => {
  it("实际工具Schema公开全部字段形状而非Unknown或开放对象", () => {
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {value.forEach(walk); return;}
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.type === "object" && node.properties) expect(node.additionalProperties).toBe(false);
      else if (node.type === "object") expect(node.oneOf).toBeInstanceOf(Array);
      expect(node).not.toHaveProperty("patternProperties");
      if (node.properties) Object.values(node.properties as object).forEach(item => expect(item).not.toEqual({}));
      Object.values(node).forEach(walk);
    };
    walk(fixedTurnParameters);
    expect((fixedTurnParameters as unknown as Record<string, unknown>).required).toEqual(["protocol_version", "capability", "base", "mode", "changes"]);
    expect(() => validateToolArguments({name: "fixed", description: "fixed", parameters: fixedTurnParameters},
      {type: "toolCall", id: "local", name: "fixed", arguments: query({organizations: org, metrics: {action: "set", value: {fromQuestion: true}}})})).not.toThrow();
    // 预算含 orgSuggestion 自主匹配变体（固定协议新增约1.6KB）；膨胀仍需控制在网关可接受范围。
    expect(Buffer.byteLength(JSON.stringify(fixedTurnParameters), "utf8")).toBeLessThan(32000);
  });

  it("共享字段去重后能力仍限制字段名及机构范围形状", () => {
    const scope = {action: "set", source_text: "各家农商行", expected_count: null,
      value: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}};
    expect(isFixedTurnArgs(query({organizations: scope}))).toBe(true);
    expect(isFixedTurnArgs({...query({organizations: scope}), capability: "data_availability"})).toBe(false);
    for (const [capability, changes] of [
      ["metric_query", {organizations: inherit, dimension: {action: "set", value: "dates"}}],
      ["data_availability", {organizations: inherit, selection: {action: "set", value: "exact"}}],
      ["metric_calculate", {organizations: inherit}],
      ["metric_query", {organizations: inherit, constants: {action: "set", value: [{name: "a", value: "1", source_text: "1"}]}}],
    ] as const) expect(() => fromFixedTurnArgs({...query({}), capability, changes})).toThrow();
    expect(isFixedTurnArgs({...query({organizations: org}), capability: "data_availability"})).toBe(true);
  });

  it.each([null, "current", {frameId: "saved"}, {ordinal: 2, relativePosition: -1, capability: "metric_query", resultRequired: false}])(
    "显式来源%j保持原意与输入不可变", base => {
      const args = query({organizations: org, metrics: {action: "set", value: {fromQuestion: true}},
        time: {action: "set", value: "2026年7月末"}, selection: {action: "set", value: "exact"}}, base);
      const original = structuredClone(args);
      const delta = fromFixedTurnArgs(args);
      expect(delta.baseReference).toEqual(base);
      expect(delta.fieldIntents?.organizations).toEqual({mode: "set", sourceText: "机构甲", expectedCount: null});
      expect(toFixedTurnArgs(delta)).toEqual(args);
      expect(args).toEqual(original);
    });

  it("inherit仅声明未变，不生成无来源retain，缺项交原业务链处理", () => {
    expect(fromFixedTurnArgs(query({}, null))).toEqual({capabilityHint: "metric_query", baseReference: null, executionMode: "execute",
      fieldChanges: [], fieldIntents: {organizations: {mode: "inherit", sourceText: null, expectedCount: null}}});
  });

  it.each([true, false])("非require字段的显式inherit保留恢复决定，mayRetain=%s", async mayRetain => {
    const path = mkdtempSync(join(tmpdir(), "fixed-recovery-")), sessions = new NativeSessionStore(path);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const session = await sessions.create("synthetic-fixed-recovery"), store = new NativeFrameStore(session);
      const resolved = (rawValue: unknown, resolvedValue: unknown) => ({source: "explicit" as const, resolutionStatus: "resolved" as const, rawValue, resolvedValue});
      const seed: BusinessFrame = {frameId: "saved-confirmation", sessionId: session.metadata.id, turnId: "earlier", requestId: "earlier", capability: "metric_query",
        operationFrameId: "saved-confirmation", status: "draft", errorCode: "TURN_ARGUMENTS_PENDING", createdAt: new Date().toISOString(), issues: [],
        delta: {capabilityHint: "metric_query", baseReference: null, executionMode: "resolve_more", fieldChanges: []},
        fields: {metrics: resolved({fromQuestion: true}, {codes: ["M"], names: ["合成余额当日数"]}),
          organizations: resolved("机构甲", {codes: ["O"], names: ["机构甲"]}),
          time: resolved("2026年7月31日", {start: "2026-07-31", end: "2026-07-31"}), selection: resolved("exact", "exact")},
        recovery: {turnId: "repair", pendingFields: ["selection"], selectionFrameId: "saved-confirmation", optionIds: [],
          pendingChanges: [{field: "selection", operation: "set", mayRetain}]}};
      await store.save(seed, 0, "seed");
      const before = await store.state();
      const service = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
      const resolveCatalog = vi.fn(async () => {throw new Error("继承不应查询目录");});
      const identity = {sessionId: session.metadata.id, turnId: "repair", requestId: "repair"};
      const context = {originalMessage: "继续原条件", currentDate: "2026-10-14", turnId: "repair", requireFieldIntents: true, resolveCatalog};
      await expect(service.resolve(fromFixedTurnArgs(query({}, "current")), identity, context)).rejects.toMatchObject({code: "TURN_CHANGES_PENDING"});
      const delta = fromFixedTurnArgs(query({selection: inherit}, "current"));
      expect(delta.fieldChanges).toEqual([]);
      expect(delta.fieldIntents?.selection).toEqual({mode: "inherit", sourceText: null, expectedCount: null});
      if (mayRetain) {
        const ready = await service.resolve(delta, identity, context);
        expect(ready.status).toBe("ready");
        expect(ready.fields.selection?.resolvedValue).toBe("exact");
      } else {
        await expect(service.resolve(delta, identity, context)).rejects.toMatchObject({code: "TURN_CHANGES_PENDING"});
        expect(await store.state()).toEqual(before);
      }
      expect(resolveCatalog).not.toHaveBeenCalled();
    } finally {await sessions.close(); rmSync(path, {recursive: true, force: true}); log.mockRestore();}
  });

  it("明确旧retain可规范表达，但不能掩盖旧数量或原文冲突", () => {
    const delta: ContextDelta = {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute",
      fieldChanges: [{fieldHint: "organizations", operation: "retain"}], fieldIntents: {organizations: {mode: "inherit", sourceText: null, expectedCount: null}}};
    expect(toFixedTurnArgs(delta)).toEqual(query({}, "current"));
    expect(() => toFixedTurnArgs({...delta, fieldIntents: {organizations: {mode: "inherit", sourceText: "上述三家", expectedCount: 3}}})).toThrow();
  });

  it("覆盖能力保留精确筛选、分页及来源，不能混入计算字段", () => {
    const args = {protocol_version: 1, capability: "data_availability", base: "current", mode: "execute", changes: {
      organizations: inherit, metrics: {action: "set", value: {fromQuestion: true, mentionIndexes: [1, 2]}},
      dimension: {action: "set", value: "dates"}, match: {action: "set", value: "all"}, page: {action: "set", value: 2}, page_size: {action: "set", value: 20},
    }};
    expect(toFixedTurnArgs(fromFixedTurnArgs(args))).toEqual(args);
    expect(() => fromFixedTurnArgs({...args, changes: {...args.changes, bindings: {action: "set", value: []}}})).toThrow();
  });

  it.each(["select", "accept"])("%s确认将完整原文和数量传给旧门禁", decision => {
    const args = query({organizations: {action: "confirm", decision, source_text: "这三家都正确", expected_count: 3}}, "current");
    const delta = fromFixedTurnArgs(args);
    expect(delta.fieldIntents?.organizations).toEqual({mode: "confirm", sourceText: "这三家都正确", expectedCount: 3});
    expect(delta.fieldChanges[0]?.rawValue).toEqual(decision === "accept"
      ? {confirm: true, evidence: {decision: "accept", sourceText: "这三家都正确"}} : {confirm: true});
    expect(toFixedTurnArgs(delta)).toEqual(args);
  });

  it("scope和history原文数量仅声明一次并无损恢复", () => {
    const scope = query({organizations: {action: "set", source_text: "这三家农商行", expected_count: 3,
      value: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}}});
    expect(fromFixedTurnArgs(scope).fieldChanges[0]?.rawValue).toEqual({kind: "authorized_cohort", cohort: "rural_commercial_banks", sourceText: "这三家农商行"});
    expect(toFixedTurnArgs(fromFixedTurnArgs(scope))).toEqual(scope);
    const history = query({organizations: {action: "set", source_text: "上述三家和机构乙", expected_count: 4, value: {kind: "history", combine: "union",
      sources: [{frame: {ordinal: 1}, field: "organizations"}, {frame: {frameId: "second"}, field: "organizations"}],
      add: ["机构乙"], retainResolvedAdditions: true, replaceAdditions: [{index: 0, value: "机构丙"}]}}}, "current");
    expect(fromFixedTurnArgs(history).fieldChanges[0]?.rawValue).toMatchObject({fromHistory: true, sourceText: "上述三家和机构乙", expectedCount: 4,
      retainResolvedAdditions: true, replaceAdditions: [{index: 0, value: "机构丙"}]});
    expect(toFixedTurnArgs(fromFixedTurnArgs(history))).toEqual(history);
    expect(() => fromFixedTurnArgs({...scope, changes: {organizations: {...scope.changes.organizations, source_text: "x".repeat(201)}}})).toThrow();
    expect(() => fromFixedTurnArgs({...history, changes: {organizations: {...history.changes.organizations,
      value: {...(history.changes.organizations as unknown as {value: object}).value, replaceAdditions: [{index: 0, value: "甲"}, {index: 0, value: "乙"}]}}}})).toThrow();
  });

  it("删除、清除和业务澄清保留原操作语义", () => {
    const args = query({organizations: {action: "clear", source_text: "不要原机构", expected_count: null},
      metrics: {action: "remove", value: {mentionIndexes: [2]}}, operation: {action: "clarify", source_text: "排名"}}, "current");
    expect(fromFixedTurnArgs(args).fieldChanges).toEqual([{fieldHint: "organizations", operation: "clear"},
      {fieldHint: "metrics", operation: "remove", rawValue: {mentionIndexes: [2]}},
      {fieldHint: "operation", operation: "set", rawValue: {clarify: true, sourceText: "排名"}}]);
    expect(toFixedTurnArgs(fromFixedTurnArgs(args))).toEqual(args);
  });

  it("计算变量名是typed数组数据，转换旧map且保留字符串精度", () => {
    const args = {protocol_version: 1, capability: "metric_calculate", base: "current", mode: "execute", changes: {
      expressions: {action: "set", value: [{name: "sum", label: "合计", expression: "a+b+c"}]},
      bindings: {action: "set", value: [{name: "a", fact_id: "fact:T:0:a"}, {name: "b", fact_id: "fact:T:0:b"}]},
      constants: {action: "set", value: [{name: "c", value: "9007199254740993.01", source_text: "加9007199254740993.01"}]},
      scope_policy: {action: "set", value: "cross_org"},
    }};
    const delta = fromFixedTurnArgs(args);
    expect(delta.fieldChanges.find(item => item.fieldHint === "constants")?.rawValue).toEqual({c: {value: "9007199254740993.01", source_text: "加9007199254740993.01"}});
    expect(toFixedTurnArgs(delta)).toEqual(args);
    expect(() => fromFixedTurnArgs({...args, changes: {...args.changes, bindings: {action: "set", value: [args.changes.bindings.value[0], args.changes.bindings.value[0]]}}})).toThrow();
    expect(() => fromFixedTurnArgs({...args, changes: {...args.changes, constants: {action: "set", value: [{name: "a", value: "1", source_text: "加1"}]}}})).toThrow();
    const constants = Array.from({length: 21}, (_, index) => ({name: `v${index}`, value: "1", source_text: "1"}));
    expect(() => fromFixedTurnArgs({...args, changes: {...args.changes, constants: {action: "set", value: constants}}})).toThrow();
    expect(() => fromFixedTurnArgs({...args, changes: {...args.changes, bindings: {action: "set", value: [{name: "a", fact_id: "x".repeat(181)}]}}})).toThrow();
    const empty = {...args, changes: {...args.changes, constants: {action: "set", value: []}}};
    expect(toFixedTurnArgs(fromFixedTurnArgs(empty))).toEqual(empty);
  });

  it("恢复纠错复用同一字段动作Schema且不泄漏共享可变对象", () => {
    const a = fixedFieldChangeSchema("metric_query", "operation"), b = fixedFieldChangeSchema("metric_query", "operation");
    expect(a).toEqual(b);
    a.oneOf = [];
    expect(fixedFieldChangeSchema("metric_query", "operation")).toEqual(b);
    expect(() => fixedFieldChangeSchema("metric_query", "invented")).toThrow();
  });

  it("参数诊断保留实际路径，缺根键与错型不再都报五键说明，不回显参数正文", () => {
    const capture = (args: unknown): {correction: string} => {
      try {fromFixedTurnArgs(args);} catch (error) {return error as {correction: string};}
      throw new Error("应拒绝非法输入");
    };
    const wrong = query({operation: {action: "set", value: {kind: "ranking", position: "top", top_n: "3"}}});
    expect(capture(wrong).correction).toContain("changes.operation.value.top_n");
    expect(capture(wrong).correction).toContain("不自动转换");
    const missing = {...query({})} as Record<string, unknown>;
    delete missing.capability;
    const failure = capture(missing);
    expect(failure.correction).toContain("capability");
    expect(failure.correction).not.toContain("Received arguments");
    const nullCount = capture(query({operation: {action: "set", value: {kind: "ranking", position: "top", top_n: null}}}));
    expect(nullCount.correction).toContain("changes.operation.value.top_n");
    expect(nullCount.correction).not.toContain('"organizations"');
  });

  it("reuse_result只复用既有结果，不同时应用字段变化", () => {
    expect(fromFixedTurnArgs({...query({}, "current"), mode: "reuse_result"}).fieldChanges).toEqual([]);
    expect(() => fromFixedTurnArgs({...query({time: {action: "set", value: "5月末"}}, "current"), mode: "reuse_result"})).toThrow();
  });

  it.each([
    query({operation: {action: "set", value: {kind: "ranking", position: "top", top_n: null}}}),
    query({operation: {action: "set", value: {kind: "value", top_n: 3}}}),
    query({operation: {action: "clarify", source_text: "排名", value: {kind: "ranking"}}}),
    query({metrics: {action: "set", value: "模型改写指标"}}),
    query({metrics: {action: "remove", value: {mentionIndexes: [0]}}}),
    query({invented: {action: "set", value: 1}}),
    {...query({}), changes: {}},
    {...query({}), fieldIntents: {}},
    {...query({}), base: {businessConstraints: {anything: {unbounded: true}}}},
    {...query({}), capability: "data_availability", changes: {organizations: inherit, operation: {action: "set", value: {kind: "value"}}}},
    query({organizations: {action: "set", source_text: "机构甲", expected_count: 0, value: org.value}}),
    query({organizations: {action: "set", source_text: "机构甲", expected_count: false, value: org.value}}),
    query({operation: {action: "set", value: {kind: "ranking", position: "top", top_n: "3"}}}),
    {...query({}), protocol_version: "1"},
    query({organizations: {action: "inherit", source_text: "上述三家"}}),
    query({organizations: {action: "confirm", source_text: "是的", decision: "accept", expected_count: null, value: {confirm: true}}}),
  ])("错形在入口拒绝且不转换：%j", args => {
    const original = structuredClone(args);
    expect(() => fromFixedTurnArgs(args)).toThrow();
    expect(isFixedTurnArgs(args)).toBe(false);
    expect(args).toEqual(original);
  });

  it.each([
    {executionMode: "execute", fieldChanges: []},
    {capabilityHint: "metric_query", baseReference: null, executionMode: "execute", fieldChanges: [], fieldIntents: {}},
    {capabilityHint: "metric_query", baseReference: "current", executionMode: "execute", fieldChanges: [{fieldHint: "time", operation: "retain", rawValue: "旧日期"}]},
  ] as ContextDelta[])("不能投影的旧输入不得补字段或丢值修成合法参数", delta => expect(() => toFixedTurnArgs(delta)).toThrow());
});
