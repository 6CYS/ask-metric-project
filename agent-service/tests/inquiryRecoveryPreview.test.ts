import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AnalysisPlan } from "../src/analysis/contracts.js";
import { catalogBindingView } from "../src/analysis/bindings.js";
import { currentTurnEvidence } from "../src/answerEvidence.js";
import type { AvailabilityRequest, BackendClient } from "../src/backendClient.js";
import { createInquiryQueryTools, inquiryRepeatedInvestigation } from "../src/inquiry/queryTools.js";
import { currentInquiryTarget } from "../src/inquiry/target.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

const metrics = [
  {code: "M1", name: "贷款市场份额", unit: "%", binding_ref: "signed:M1"},
  {code: "M2", name: "存款余额", unit: "元", binding_ref: "signed:M2"},
];
const names = ["测试甲行", "测试乙行"];
const codes = ["3200", "3201"];
const query = {purpose: "查询贷款市场份额", metric_refs: ["k1"], method: "observe"};

async function fixture(options: {latest?: boolean; ordinary?: boolean; calendar?: boolean} = {}) {
  const selectedMetrics = options.ordinary ? metrics.map(metric => ({...metric, unit: "元"})) : metrics;
  const messages: AgentMessage[] = [];
  const backend = {
    analysisCatalog: vi.fn().mockResolvedValue({items: selectedMetrics}),
    analysisMethods: vi.fn().mockResolvedValue({methods: []}),
    createAgentQueryContext: vi.fn().mockResolvedValue({conversation_id: "conv-1"}),
    resolveBusinessField: vi.fn<BackendClient["resolveBusinessField"]>((entity, values, _options, _referenceYear, _source, calendar) => Promise.resolve(entity === "organization"
      ? {status: "resolved", value: {codes: values.map(value => codes[names.indexOf(value)] ?? value),
          names: values.map(value => names[codes.indexOf(value)] ?? value)}}
      : values[0] === "这半年" ? calendar ? {status: "resolved", value: calendar}
          : {status: "invalid", metadata: {reason: "unsupported_expression"}}
      : {status: "resolved", value: values[0] === "latest"
          ? {preset: "latest"} : {start: values[0], end: values[0]}})),
    analysisExecute: vi.fn((payload: Record<string, unknown>, key: string) => {
      const plan = payload.plan as AnalysisPlan;
      const requested = selectedMetrics.filter(metric => plan.steps.some(step => step.metric_refs.includes(metric.binding_ref)));
      return Promise.resolve({kind: "analysis_evidence", status: "succeeded", run_ref: `analysis:${key}`, scope_id: "op-1",
        conversation_id: "conv-1", complete: true, plan, org_codes: codes, analysis_date: "2026-07-31", rows: [],
        metric_descriptors: requested, facts: [], observations: [], gaps: [],
        evidence_items: requested.flatMap(metric => codes.map(org_code => ({ref: `${metric.code}:${org_code}`,
          type: "fact", metric_code: metric.code, org_code, date: "2026-07-31", unit: metric.unit,
          value: "0.1", display: "口径待确认"})))});
    }),
    dataAvailability: vi.fn((spec: AvailabilityRequest) => Promise.resolve({status: "succeeded", request: spec,
      mode: "overview", metric_count: spec.metric_codes?.length ?? 0, org_count: spec.org_codes.length,
      org_names: names, metric_names: selectedMetrics.map(metric => metric.name), page: spec.page ?? 1,
      page_size: spec.page_size ?? 12, notice: "日期记录不证明数值有效。",
      groups: [{date_count: 1, earliest: "2026-07-31", latest: "2026-07-31", dates: ["2026-07-31"], has_more: false}]})),
  };
  const request = testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    originalMessage: "比较两行贷款市场份额与存款余额", inquiryTargetContext: {version: 1, time_contract: 2},
    turnMessages: () => Promise.resolve(messages), answerEvidence: () => Promise.resolve(currentTurnEvidence(messages)),
  });
  const tools = createInquiryQueryTools();
  const call = async (tool: string, args: unknown) => {
    const result = await runTool(tools.find(item => item.name === tool)!, args, request) as {
      content: [{type: "text"; text: string}]; details: Record<string, unknown>; isError?: boolean;
    };
    messages.push({role: "toolResult", toolName: tool, toolCallId: `call-${messages.length}`, timestamp: 0,
      content: result.content, details: result.details, isError: result.isError ?? false});
    return result;
  };
  await call("metric_search", {keywords: ["贷款市场份额", "存款余额"]});
  await call("metric_query", {...query, metric_refs: ["k1", "k2"], target_change: {mode: "new", topic: "市占率",
    organizations: {mode: "replace", scope: "named", names}, time: options.calendar
      ? {expression: "这半年", calendar: {start: "2026-05-04", end: "2026-11-04"}}
      : {expression: options.latest ? "latest" : "2026-07-31"}}});
  const preview = (args: unknown = query, tool = "metric_query") => inquiryRepeatedInvestigation(tool, args, request, messages);
  return {request, messages, backend, call, preview};
}

describe("下一步重复调查只依据真实完整回执", () => {
  it("首次口径受阻允许一次恢复，已有重复回执后改说明、编码别名和方法不再取同一证据", async () => {
    const f = await fixture();
    expect(f.preview()).toBe(false);
    const repeated = await f.call("metric_query", query);
    expect(repeated.details).toMatchObject({no_new_evidence: true, metadata_blockers: [{metric_code: "M1", reason: "unknown_percentage_encoding"}]});
    expect(f.preview()).toBe(true);
    expect(f.preview({...query, purpose: "另一种说明", metric_refs: ["M1"], method: "trend"})).toBe(true);
  });

  it("已解析最新日期的同来源可识别显式日期及独立补查，预览不执行请求或改变目录状态", async () => {
    const f = await fixture({latest: true});
    await f.call("metric_query", query);
    const before = structuredClone(f.messages);
    const count = f.backend.analysisExecute.mock.calls.length + f.backend.resolveBusinessField.mock.calls.length;
    expect(f.preview({...query, date: "2026-07-31", scope: "named", org_names: names, independent: true})).toBe(true);
    expect(f.messages).toEqual(before);
    expect(f.backend.analysisExecute.mock.calls.length + f.backend.resolveBusinessField.mock.calls.length).toBe(count);
  });

  it("日历换算目标可省略日期继承，显式重传自然日期须重新解析", async () => {
    const f = await fixture({calendar: true});
    expect(currentInquiryTarget(f.messages, f.request.operationId)?.time)
      .toMatchObject({start: "2026-05-04", end: "2026-11-04"});
    await f.call("metric_query", query);
    expect(f.preview()).toBe(true);
    expect(f.preview({...query, date: "这半年"})).toBe(false);
    const unresolved = await f.call("metric_query", {...query, date: "这半年"});
    expect(unresolved.isError).toBe(true);
    expect(unresolved.details).toMatchObject({code: "ANALYSIS_DATE_UNRESOLVED", validation_stage: "query_date"});
  });

  it.each([
    {label: "新指标", change: {metric_refs: ["k2"]}},
    {label: "混合指标", change: {metric_refs: ["k1", "k2"]}},
    {label: "未知指标", change: {metric_refs: ["unknown"]}},
    {label: "重复正式绑定", change: {metric_refs: ["k1", "M1"]}},
    {label: "新日期", change: {date: "2026-06-30"}},
    {label: "未知日期表达", change: {date: "去年这个时候"}},
    {label: "日历纠正", change: {date: "这半年", date_calendar: {start: "2026-05-04", end: "2026-11-04"}}},
    {label: "机构子集", change: {scope: "named", org_names: [names[0]]}},
    {label: "未知机构别名", change: {scope: "named", org_names: ["甲行", "乙行"]}},
    {label: "新范围", change: {scope: "all_banks"}},
    {label: "不完整机构参数", change: {org_names: names}},
    {label: "新目标", change: {target_change: {mode: "new", topic: "贷款", organizations: {mode: "replace", scope: "named", names}, time: null, selection: "latest"}}},
    {label: "变更目标", change: {target_change: {mode: "update", base_ref: "target:op-1", time: {expression: "2026-06-30"}}}},
    {label: "不完整比较参数", change: {method: "compare"}},
    {label: "未知结构关系", change: {method: "structure"}},
    {label: "额外参数", change: {invented: true}},
  ])("$label仍由正式执行器处理", async ({change}) => {
    const f = await fixture();
    await f.call("metric_query", query);
    expect(f.preview({...query, ...change})).toBe(false);
  });

  it("同目标continue、完整机构编码和有效比较参数仍识别同口径阻塞", async () => {
    const f = await fixture();
    await f.call("metric_query", query);
    const target = currentInquiryTarget(f.messages, f.request.operationId)!;
    expect(f.preview({...query, scope: "named", org_names: codes, target_change: {mode: "continue", base_ref: target.ref},
      method: "compare", comparisons: ["mom"]})).toBe(true);
    expect(f.preview({...query, target_change: {mode: "continue", base_ref: "different"}})).toBe(false);
  });

  it("普通已成功结果及其复用不能阻止新的分析方法", async () => {
    const f = await fixture({ordinary: true});
    await f.call("metric_query", query);
    expect(f.preview()).toBe(false);
    expect(f.preview({...query, method: "trend"})).toBe(false);
  });

  it("正式绑定版本变化后旧口径阻塞不关闭重查", async () => {
    const f = await fixture();
    await f.call("metric_query", query);
    catalogBindingView(f.request, {items: [{...metrics[0], binding_ref: "signed:M1:v2"}]});
    expect(f.preview({...query, metric_refs: ["M1"]})).toBe(false);
    expect(f.preview()).toBe(false);
  });

  it("上一轮、不同身份、可信接纳和旧无目标请求不能借用重复状态", async () => {
    const f = await fixture();
    await f.call("metric_query", query);
    const context = f.request.inquiryTargetContext;
    delete f.request.inquiryTargetContext;
    expect(f.preview()).toBe(false);
    f.request.inquiryTargetContext = context!;
    f.request.inquiryAdmission = {targets: [], answerReceipts: []};
    expect(f.preview()).toBe(false);
    delete f.request.inquiryAdmission;
    f.request.timeOverride = {start: "2026-07-31", end: "2026-07-31"};
    expect(f.preview()).toBe(false);
    delete f.request.timeOverride;
    const operation = f.request.operationId;
    f.request.operationId = "another-operation";
    expect(f.preview()).toBe(false);
    f.request.operationId = operation;
    f.request.actor = {...f.request.actor, id: "another"};
    expect(f.preview()).toBe(false);
    f.messages.push({role: "user", content: "新的问题", timestamp: 1});
    expect(f.preview()).toBe(false);
  });

  it("失败或非工具回执不能证明此前已尝试相同调查", async () => {
    const f = await fixture();
    await f.call("metric_query", query);
    const last = f.messages.at(-1)!;
    if (last.role !== "toolResult") throw new Error("缺少回执");
    last.isError = true;
    expect(f.preview()).toBe(false);
    expect(f.preview(query, "analysis_read")).toBe(false);
    expect(f.preview(null)).toBe(false);
  });

  it("全量日期覆盖只在已有一次包含复用后收敛后续子区间", async () => {
    const f = await fixture();
    const availability = {metric_refs: ["k1", "k2"]};
    await f.call("metric_availability", availability);
    const firstRange = {...availability, start: "2025-01-01", end: "2026-11-04"};
    expect(f.preview(firstRange, "metric_availability")).toBe(false);
    await f.call("metric_availability", firstRange);
    for (const [start, end] of [["2020-01-01", "2026-11-04"], ["2015-01-01", "2026-11-04"],
      ["2000-01-01", "2026-11-04"], ["1900-01-01", "2026-11-04"], ["2026-01-01", "2026-12-31"],
      ["2026-07-01", "2026-07-31"], ["2026-07-30", "2026-08-01"], ["2026-07-01", "2026-07-30"],
      ["2026-07-31", "2026-12-31"]]) {
      expect(f.preview({...availability, start, end}, "metric_availability")).toBe(true);
    }
    expect(f.preview({...availability, metric_refs: ["k1"]}, "metric_availability")).toBe(false);
    expect(f.preview({...availability, scope: "named", org_names: [names[0]]}, "metric_availability")).toBe(false);
    expect(f.preview({...availability, start: "2026-02-30", end: "2026-11-04"}, "metric_availability")).toBe(false);
    expect(f.preview({...availability, start: "2026-01-01"}, "metric_availability")).toBe(false);
    expect(f.preview({...availability, page: 0}, "metric_availability")).toBe(false);
  });

  it("分页未完和未覆盖区间保留必要日期调查", async () => {
    const f = await fixture();
    const input = {metric_refs: ["k1", "k2"], start: "2026-01-01", end: "2026-08-31"};
    await f.call("metric_availability", input);
    await f.call("metric_availability", input);
    expect(f.preview({...input, end: "2026-12-31"}, "metric_availability")).toBe(false);
    for (const message of f.messages) {
      if (message.role !== "toolResult" || message.toolName !== "metric_availability") continue;
      const details = message.details as {groups: Array<{has_more: boolean}>};
      details.groups[0]!.has_more = true;
    }
    expect(f.preview({...input, page: 2}, "metric_availability")).toBe(false);
  });
});
