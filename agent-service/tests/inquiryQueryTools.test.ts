import { describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  BackendApiError,
  type AvailabilityRequest,
  type BackendClient,
} from "../src/backendClient.js";
import { businessEvidences, currentTurnEvidence } from "../src/answerEvidence.js";
import { loadTurnBusinessKnowledge } from "../src/businessKnowledgeContext.js";
import { createInquiryKnowledgeTool } from "../src/inquiry/knowledgeTool.js";
import type { FieldResolution } from "../src/business-context/types.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { createTopicQueryTool } from "../src/inquiry/topics/tool.js";
import { loadTopicRegistry } from "../src/inquiry/topics/registry.js";
import { inquiryPayload, inquiryToolAdmission } from "../src/inquiry/runtime.js";
import { projectInquiryMessages } from "../src/inquiry/view.js";
import type { InquiryAcceptedTarget } from "../src/inquiry/admission.js";
import { readInquiryTargetSnapshot } from "../src/inquiry/target.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

const descriptor = { code: "M1", name: "测试余额", unit: "元", binding_ref: "signed:M1" };
interface InquiryToolTestResult {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}
function evidence(overrides: Record<string, unknown> = {}) {
  return {
    kind: "analysis_evidence",
    status: "succeeded",
    run_ref: "analysis:one",
    scope_id: "op-1",
    conversation_id: "conv-1",
    analysis_date: "2026-08-27",
    org_codes: ["3200"],
    rows: [],
    metric_descriptors: [descriptor],
    evidence_items: [
      {
        ref: "fact-1",
        type: "fact",
        metric_code: "M1",
        org_code: "3200",
        date: "2026-08-27",
        unit: "元",
        value: "100",
        display: "100元",
      },
    ],
    facts: [],
    observations: [],
    gaps: [],
    plan: { objective: "查值", requirements: [], steps: [], scope_notice: "本机构" },
    ...overrides,
  };
}
function fixture(initial: AgentMessage[] = []) {
  const resolveDate = vi.fn((): Promise<FieldResolution> =>
    Promise.resolve({ status: "resolved", value: { start: "2026-07-31", end: "2026-07-31" } }),
  );
  const resolveOrganizations = vi.fn((values: string[]): Promise<FieldResolution> =>
    Promise.resolve({
      status: "resolved",
      value: {
        codes: values.map((value) => (value === "测试分行" ? "3201" : value)),
        names: values,
      },
    }),
  );
  const backend = {
    searchBusinessKnowledge: vi.fn<BackendClient["searchBusinessKnowledge"]>().mockResolvedValue({
      revision: "a".repeat(64), entries: [],
    }),
    analysisCatalog: vi
      .fn<BackendClient["analysisCatalog"]>()
      .mockResolvedValue({ items: [descriptor], total: 1, page: 1, page_size: 12 }),
    analysisMethods: vi.fn(() => Promise.resolve({ methods: [] })),
    analysisExecute: vi
      .fn<
        (
          payload: Record<string, unknown>,
          key: string,
          options?: unknown,
        ) => Promise<ReturnType<typeof evidence>>
      >()
      .mockResolvedValue(evidence()),
    analysisEvidence: vi
      .fn<
        (
          runRef: string,
          conversationId: string,
          options?: unknown,
        ) => Promise<ReturnType<typeof evidence>>
      >()
      .mockResolvedValue(evidence()),
    dataAvailability: vi.fn((spec: AvailabilityRequest) =>
      Promise.resolve({
        status: "succeeded",
        request: spec,
        mode: "dates",
        metric_count: 1,
        org_count: spec.org_codes.length,
        org_names: ["测试机构"],
        metric_names: ["测试余额"],
        groups: [
          {
            date_count: 2,
            earliest: "2026-04-28",
            latest: "2026-04-29",
            dates: ["2026-04-29"],
            has_more: true,
          },
        ],
        page: spec.page ?? 1,
        page_size: spec.page_size ?? 12,
        has_more: true,
        notice: "有记录不代表数值有效。",
      }),
    ),
    createAgentQueryContext: vi.fn(() => Promise.resolve({ conversation_id: "conv-1" })),
    resolveBusinessField: vi.fn<BackendClient["resolveBusinessField"]>((entity, values): Promise<FieldResolution> =>
      entity === "organization" ? resolveOrganizations(values) : resolveDate(),
    ),
    resolveOrganizationScope: vi.fn(() =>
      Promise.resolve({
        status: "resolved",
        value: {
          codes: ["3200", "3201"],
          names: ["测试机构", "测试分行"],
          scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
          scope_fingerprint: "scope-token",
        },
      }),
    ),
  };
  const messages = [...initial];
  const bridge = new MemoryCommandBridge();
  const request = testRequestContext(backend as unknown as BackendClient, bridge, {
    originalMessage: "查询测试余额和测试利润",
    turnMessages: () => Promise.resolve(messages),
    answerEvidence: () => Promise.resolve(currentTurnEvidence(messages)),
  });
  const tools = createInquiryQueryTools();
  const call = async (name: string, input: unknown) => {
    const result = (await runTool(
      tools.find((tool) => tool.name === name)!,
      input,
      request,
    )) as InquiryToolTestResult;
    messages.push({
      role: "toolResult",
      toolName: name,
      toolCallId: `call-${messages.length}`,
      content: result.content,
      details: result.details,
      isError: result.isError ?? false,
      timestamp: 0,
    });
    return result;
  };
  return { backend, request, bridge, messages, call, resolveDate, resolveOrganizations };
}
const query = {
  purpose: "读取余额",
  metric_refs: ["k1"],
  scope: "named",
  org_names: ["3200"],
  method: "observe",
};
const secondDescriptor = { ...descriptor, code: "M2", name: "测试收入", binding_ref: "signed:M2" };

describe("失败回执按实际纠正条件保留调查", () => {
  async function attempt(f: ReturnType<typeof fixture>, args: Record<string, unknown>, name = "metric_query") {
    f.messages.push({
      role: "assistant", content: [{type: "toolCall", id: `call-${f.messages.length + 1}`, name, arguments: args}],
      api: "openai-completions", provider: "isolated", model: "isolated", stopReason: "toolUse", timestamp: 0,
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    });
    return f.call(name, args);
  }

  it.each(["metric_query", "metric_availability"])("逐项消除正式指标别名重复后继续，别名互换仍停止：%s", async name => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValue({items: [descriptor, secondDescriptor], total: 2});
    await f.call("metric_search", {keywords: ["余额"]});
    await attempt(f, {...query, metric_refs: ["k1", "M1", "k2", "M2"]}, name);
    await attempt(f, {...query, metric_refs: ["k1", "k2", "M2"]}, name);
    expect(inquiryToolAdmission(f.messages, name, {...query, metric_refs: ["k1", "k2"]})).toBeUndefined();
    const corrected = [...f.messages];
    await attempt(f, {...query, metric_refs: ["M1", "M2", "k2"]}, name);
    expect(inquiryToolAdmission(f.messages, name, {...query, metric_refs: ["k1", "k2", "M2"]})).toHaveProperty("block");
    expect(inquiryToolAdmission(f.messages, name, {...query, metric_refs: ["k1", "k2"]})).toBeUndefined();
    f.messages.splice(0, f.messages.length, ...corrected);
    const result = await attempt(f, {...query, metric_refs: ["k1", "k2"]}, name);
    expect(result.isError).not.toBe(true);
    if (name === "metric_query") expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      plan: {steps: [expect.objectContaining({metric_refs: ["signed:M1", "signed:M2"]})]},
    });
    else expect(f.backend.dataAvailability.mock.calls[0]?.[0]).toMatchObject({metric_codes: ["M1", "M2"]});
  });

  it("新目标参数变更仍重新校验，相同错误请求重复后只阻止该请求", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = {version: 1};
    await f.call("metric_search", {keywords: ["余额"]});
    const organizations = {mode: "replace", scope: "all_banks", names: ["3200"]};
    await attempt(f, {...query, target_change: {mode: "new", organizations}});
    await attempt(f, {...query, target_change: {mode: "new", organizations, topic: "存款"}});
    expect(inquiryToolAdmission(f.messages, "metric_query", {...query,
      target_change: {mode: "new", organizations, topic: "存款", date: "2026-08-27"}})).toBeUndefined();
    await attempt(f, {...query, target_change: {mode: "new", organizations, topic: "存款", date: "2026-08-27"}});
    expect(inquiryToolAdmission(f.messages, "metric_query", {...query, target_change: {mode: "new", topic: "存款", date: "2026-08-27",
      organizations: {mode: "replace", scope: "all_banks"}}})).toBeUndefined();
    const corrected = [...f.messages];
    const unchanged = {...query, target_change: {mode: "new", organizations, topic: "存款分析", date: "2026-07-31"}};
    await attempt(f, unchanged);
    expect(inquiryToolAdmission(f.messages, "metric_query", unchanged)).toBeUndefined();
    await attempt(f, unchanged);
    expect(inquiryToolAdmission(f.messages, "metric_query", unchanged)).toHaveProperty("block");
    f.messages.splice(0, f.messages.length, ...corrected);
    const result = await attempt(f, {...query, target_change: {mode: "new", topic: "存款", date: "2026-08-27",
      organizations: {mode: "replace", scope: "all_banks"}}});
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({inquiry_target_snapshot: {topic: "存款",
      organizations: {codes: ["3200", "3201"]}}});
  });

  it.each(["metric_query", "metric_availability"])("接纳目标重绑定失败不阻断新参数和目标，相同请求重复后局部停止：%s", async name => {
    const f = fixture();
    f.request.inquiryAdmission = {targets: [acceptedTarget(), acceptedTarget({targetRef: "target-two",
      metrics: {codes: ["M1"], names: ["测试余额"]}})], answerReceipts: []};
    f.backend.analysisCatalog.mockResolvedValue({items: [], total: 0});
    await attempt(f, {...query, target_ref: "target-one", date: "2026-08-27"}, name);
    const first = [...f.messages];
    const unchanged = {...query, target_ref: "target-one", metric_refs: ["made-up"], org_names: ["其他机构"], date: "2026-07-31"};
    await attempt(f, unchanged, name);
    expect(f.backend.analysisCatalog.mock.calls.map(call => call.slice(0, 3)))
      .toEqual([["M2", 1, 30], ["M2", 1, 30]]);
    expect(inquiryToolAdmission(f.messages, name, unchanged)).toBeUndefined();
    await attempt(f, unchanged, name);
    expect(inquiryToolAdmission(f.messages, name, unchanged)).toHaveProperty("block");
    expect(inquiryToolAdmission(f.messages, name, {...query, target_ref: "target-two"})).toBeUndefined();
    f.messages.splice(0, f.messages.length, ...first);
    await attempt(f, {...query, target_ref: "target-two"}, name);
    expect(f.backend.analysisCatalog.mock.calls.at(-1)?.[0]).toBe("M1");
    expect(inquiryToolAdmission(f.messages, name, {...query, target_ref: "target-two"})).toBeUndefined();
  });

  it("单个接纳目标显式补齐后重新校验，仅重复显式请求才局部停止", async () => {
    const f = fixture();
    f.request.inquiryAdmission = {targets: [acceptedTarget()], answerReceipts: []};
    f.backend.analysisCatalog.mockResolvedValue({items: [], total: 0});
    await attempt(f, query);
    await attempt(f, {...query, target_ref: "target-one"});
    expect(inquiryToolAdmission(f.messages, "metric_query", {...query, target_ref: "target-one"})).toBeUndefined();
    await attempt(f, {...query, target_ref: "target-one"});
    expect(inquiryToolAdmission(f.messages, "metric_query", {...query, target_ref: "target-one"})).toHaveProperty("block");
  });
});

describe("关联知识在取数前提供正式候选", () => {
  const knowledge = (items = [descriptor, secondDescriptor]) => ({
    revision: "a".repeat(64),
    entries: [{ id: "deposit", title: "存款分析", text: "按本次问题选择需要的指标。", role: "方法参考", metric_codes: ["M1", "M2"] }],
    linked_catalog: { items, total: 2, has_more: false, unavailable_codes: [] },
  });

  it("自动前置的正式候选可直接取数，只执行模型选择的指标", async () => {
    const f = fixture();
    f.backend.searchBusinessKnowledge.mockResolvedValue(knowledge());
    const result = await loadTurnBusinessKnowledge(f.request, []);
    expect(result).toMatchObject({ linked_catalog: { items: [
      { code: "M1", binding_ref: "M1" }, { code: "M2", binding_ref: "M2" },
    ] } });
    await f.call("metric_query", { ...query, metric_refs: ["M2"] });
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      org_codes: ["3200"], plan: { steps: [expect.objectContaining({ metric_refs: ["signed:M2"] })] },
    });
    expect(f.backend.analysisCatalog).not.toHaveBeenCalled();
  });

  it("重建请求后先恢复知识回执，再注册新候选，不改写已有短引用", async () => {
    const first = fixture();
    first.backend.searchBusinessKnowledge.mockResolvedValue(knowledge());
    const receipt = await runTool(createInquiryKnowledgeTool(), { query: "存款分析" }, first.request) as InquiryToolTestResult;
    const restored = fixture([{ role: "toolResult", toolName: "business_knowledge_search", toolCallId: "knowledge",
      content: receipt.content, details: receipt.details, isError: false, timestamp: 0 }]);
    restored.backend.searchBusinessKnowledge.mockResolvedValue(knowledge([secondDescriptor, descriptor]));
    const result = await loadTurnBusinessKnowledge(restored.request, []);
    expect(result).toMatchObject({ linked_catalog: { items: [
      { code: "M2", binding_ref: "M2" }, { code: "M1", binding_ref: "M1" },
    ] } });
    await restored.call("metric_query", query);
    expect(restored.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      plan: { steps: [expect.objectContaining({ metric_refs: ["signed:M1"] })] },
    });
  });

  it.each(["metric_query", "metric_availability"])("自动候选的失败回执保留正式绑定：%s", async (tool) => {
    const f = fixture();
    f.backend.searchBusinessKnowledge.mockResolvedValue(knowledge());
    await loadTurnBusinessKnowledge(f.request, []);
    const failed = await f.call(tool, { ...query, metric_refs: ["M1", "INVALID"] });
    expect(failed.details).toMatchObject({
      kind: "inquiry_query_error", status: "error", code: "ANALYSIS_BINDING_INVALID", correction_fields: ["metric_refs"],
      binding_map: { "code:M1": "signed:M1", "code:M2": "signed:M2" },
    });
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });
});

describe("指标检索的分页边界与候选取数", () => {
  it("同轮重复目录页复用原候选、关系和分页，仍允许直接取数", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValue({
      items: [{ ...descriptor, match_type: "exact", description: "期末余额" }],
      total: 13, page: 1, page_size: 12, has_more: true,
      semantic_suggestions: [{ code: "S1", name: "相关建议", match_type: "semantic" }],
      relations: [{ id: "relation-1", parent: "M1", children: ["M2"], usage: "navigation_only" }],
      related_metrics: [secondDescriptor],
    });
    const first = await f.call("metric_search", { keywords: ["余额"] });
    const repeated = await f.call("metric_search", { keywords: [" 余额 "], page: 1, page_size: 12 });
    const firstView = JSON.parse(first.content[0].text) as { results: Record<string, unknown>[] };
    const repeatedView = JSON.parse(repeated.content[0].text) as { results: Record<string, unknown>[] };
    expect(repeatedView).toMatchObject({
      reused: true, no_new_evidence: true,
      items: [{ code: "M1", binding_ref: "k1", description: "期末余额" }],
      results: [{ keyword: "余额", page: 1, has_more: true, next_page: 2,
        matches: [{ binding_ref: "k1", match_type: "exact" }] }],
    });
    expect(repeatedView.results[0]?.relations).toEqual(firstView.results[0]?.relations);
    expect(repeatedView.results[0]?.related_metrics).toEqual(firstView.results[0]?.related_metrics);
    expect(repeatedView.results[0]?.semantic_suggestions).toEqual(firstView.results[0]?.semantic_suggestions);
    const again = await f.call("metric_search", { keywords: ["余额"] });
    expect(JSON.parse(again.content[0].text)).toMatchObject({
      reused: true, items: [{ code: "M1", binding_ref: "k1", description: "期末余额" }],
      results: [{ matches: [{ binding_ref: "k1" }] }],
    });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(1);
    expect(repeated.isError).not.toBe(true);
    expect(inquiryToolAdmission(f.messages, "metric_query", query)).toBeUndefined();
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { steps: [{ metric_refs: ["signed:M1"] }] },
    });
  });

  it("混合检索只访问尚未读取的词或页面，恢复回合仍保留原短引用", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockImplementation((keyword, page, pageSize) => Promise.resolve({
      items: [keyword === "余额" ? descriptor : secondDescriptor],
      total: 30, page, page_size: pageSize, has_more: true,
    }));
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_search", { keywords: ["余额", "收入"] });
    await f.call("metric_search", { keywords: ["余额"], page: 2 });
    await f.call("metric_search", { keywords: ["余额"], page_size: 6 });
    expect(f.backend.analysisCatalog.mock.calls.map(([word, page, size]) => [word, page, size])).toEqual([
      ["余额", 1, 12], ["收入", 1, 12], ["余额", 2, 12], ["余额", 1, 6],
    ]);
    const restored = fixture(f.messages);
    const repeated = await restored.call("metric_search", { keywords: ["余额"], page: 2 });
    expect(JSON.parse(repeated.content[0].text)).toMatchObject({
      reused: true, items: [{ code: "M1", binding_ref: "k1" }], results: [{ page: 2 }],
    });
    expect(restored.backend.analysisCatalog).not.toHaveBeenCalled();
    await restored.call("metric_query", query);
    expect(restored.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { steps: [{ metric_refs: ["signed:M1"] }] },
    });
  });

  it("新发现的正式定义版本变化时不复用旧目录页", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValueOnce({
      items: [descriptor], total: 1, page: 1, page_size: 12, has_more: false,
    });
    await f.call("metric_search", { keywords: ["余额"] });
    f.backend.analysisCatalog.mockResolvedValue({
      items: [{ ...descriptor, binding_ref: "signed:M1-new", description: "已修正口径" }],
      total: 1, page: 1, page_size: 12, has_more: false,
    });
    await f.call("metric_search", { keywords: ["存款余额"] });
    const refreshed = await f.call("metric_search", { keywords: ["余额"] });
    expect(JSON.parse(refreshed.content[0].text)).toMatchObject({
      items: [{ binding_ref: "k2", description: "已修正口径" }],
    });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(3);
  });

  it("失败的目录请求允许原条件重试，不作为成功页面复用", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockRejectedValueOnce(new BackendApiError(503, "暂不可用", "UNAVAILABLE"));
    await expect(f.call("metric_search", { keywords: ["余额"] })).rejects.toMatchObject({ status: 503 });
    const retried = await f.call("metric_search", { keywords: ["余额"] });
    expect(JSON.parse(retried.content[0].text)).toMatchObject({ items: [{ code: "M1", binding_ref: "k1" }] });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(2);
  });

  it("同批新关键词发现口径更新后，旧关键词页重新检索并统一正式引用", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValueOnce({
      items: [descriptor], total: 1, page: 1, page_size: 12, has_more: false,
    });
    await f.call("metric_search", { keywords: ["余额"] });
    f.backend.analysisCatalog.mockResolvedValue({
      items: [{ ...descriptor, binding_ref: "signed:M1-new", description: "新版口径" }],
      total: 1, page: 1, page_size: 12, has_more: false,
    });
    const refreshed = await f.call("metric_search", { keywords: ["余额", "存款余额"] });
    expect(JSON.parse(refreshed.content[0].text)).toMatchObject({
      items: [{ code: "M1", binding_ref: "k2", description: "新版口径" }],
      results: [
        { keyword: "余额", matches: [{ binding_ref: "k2" }] },
        { keyword: "存款余额", matches: [{ binding_ref: "k2" }] },
      ],
    });
    const repeated = await f.call("metric_search", { keywords: ["余额"] });
    expect(JSON.parse(repeated.content[0].text)).toMatchObject({
      reused: true, items: [{ code: "M1", binding_ref: "k2", description: "新版口径" }],
    });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(3);
  });

  it("已到末页不再访问空页，保留已有候选和取数能力", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValue({
      items: [{ ...descriptor, match_type: "exact", methods: ["observe", "ranking"] }],
      total: 46,
      page: 4,
      page_size: 12,
      has_more: false,
    });
    await f.call("metric_search", { keywords: ["余额"], page: 4 });
    for (const page of [5, 12]) {
      f.messages.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${f.messages.length + 1}`,
            name: "metric_search",
            arguments: { keywords: ["余额"], page },
          },
        ],
        api: "openai-completions",
        provider: "isolated",
        model: "isolated",
        stopReason: "toolUse",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      const result = await f.call("metric_search", { keywords: ["余额"], page });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        results: [
          {
            keyword: "余额",
            page,
            has_more: false,
            pagination_status: "exhausted",
            next_page: null,
          },
        ],
        existing_candidates: [
          expect.objectContaining({
            binding_ref: "k1",
            code: "M1",
            methods: ["observe", "ranking"],
          }),
        ],
      });
    }
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(1);
    expect(inquiryToolAdmission(f.messages, "metric_query")).toBeUndefined();
    expect(
      inquiryPayload({ tools: [{ name: "metric_search" }, { name: "metric_query" }] }, f.messages)
        .tools,
    ).toEqual([{ name: "metric_search" }, { name: "metric_query" }]);
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3200"],
      plan: { steps: [expect.objectContaining({ metric_refs: ["signed:M1"] })] },
    });
  });

  it("正常翻页和混合关键词不受另一关键词末页影响", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockImplementation((keyword, page, pageSize) =>
      Promise.resolve({
        items: [descriptor],
        total: keyword === "余额" ? 1 : 25,
        page,
        page_size: pageSize,
        has_more: keyword !== "余额" && (page ?? 1) < 3,
      }),
    );
    await f.call("metric_search", { keywords: ["余额", "利润"], page: 1 });
    await f.call("metric_search", { keywords: ["余额", "利润", "收入"], page: 2 });
    expect(f.backend.analysisCatalog.mock.calls.map(([keyword, page]) => [keyword, page])).toEqual([
      ["余额", 1],
      ["利润", 1],
      ["利润", 2],
      ["收入", 2],
    ]);
  });

  it("改变每页数量按已知总量判断，允许仍有数据的页面及新一轮检索", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockImplementation((_keyword, page, pageSize) =>
      Promise.resolve({
        items: [descriptor],
        total: 20,
        page,
        page_size: pageSize,
        has_more: (page ?? 1) * (pageSize ?? 12) < 20,
      }),
    );
    await f.call("metric_search", { keywords: ["余额"], page: 2, page_size: 12 });
    await f.call("metric_search", { keywords: ["余额"], page: 3, page_size: 6 });
    await f.call("metric_search", { keywords: ["余额"], page: 3, page_size: 12 });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(2);
    f.messages.push({ role: "user", content: "换个问题", timestamp: 1 });
    await f.call("metric_search", { keywords: ["余额"], page: 3, page_size: 12 });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(3);
  });

  it("零命中终止后续页，缺分页元数据不能推定检索结束", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      page_size: 12,
      has_more: false,
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_search", { keywords: ["余额"], page: 2 });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(1);
    await f.call("metric_search", { keywords: ["利润"] });
    await f.call("metric_search", { keywords: ["利润"], page: 2 });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(3);
  });

  it("精确候选口径完整时可在目录未翻完前查询和排名，不另搜排名指标", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValue({
      items: [
        {
          ...descriptor,
          match_type: "exact",
          description: "期末余额",
          methods: ["observe", "ranking"],
        },
      ],
      total: 46,
      page: 1,
      page_size: 12,
      has_more: true,
    });
    const result = await f.call("metric_search", { keywords: ["余额"] });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      results: [{ next_page: 2, has_more: true }],
    });
    await f.call("metric_query", {
      ...query,
      method: "ranking",
      scope: "all_banks",
      org_names: undefined,
    });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(1);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      organization_scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
      scope_fingerprint: "scope-token",
      org_codes: [],
      plan: { steps: [expect.objectContaining({ method: "ranking", metric_refs: ["signed:M1"] })] },
    });
  });

  it("正常翻页保留该词先前精确候选及口径，恢复请求仍使用正式签名", async () => {
    const f = fixture();
    const candidate = {
      ...descriptor,
      match_type: "exact",
      description: "期末余额",
      limitations: ["非日均"],
    };
    f.backend.analysisCatalog.mockResolvedValue({
      items: [candidate],
      total: 13,
      page: 1,
      page_size: 12,
      has_more: true,
    });
    await f.call("metric_search", { keywords: ["余额"] });
    const restored = fixture(f.messages);
    restored.backend.analysisCatalog.mockResolvedValue({
      items: [secondDescriptor],
      total: 13,
      page: 2,
      page_size: 12,
      has_more: false,
    });
    const result = await restored.call("metric_search", { keywords: ["余额"], page: 2 });
    const view = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(view.existing_candidates).toEqual([
      expect.objectContaining({
        code: "M1",
        binding_ref: "k1",
        description: "期末余额",
        limitations: ["非日均"],
      }),
    ]);
    expect(restored.backend.analysisExecute).not.toHaveBeenCalled();
    const blocked = fixture(restored.messages);
    await blocked.call("metric_search", { keywords: ["余额"], page: 3 });
    expect(blocked.backend.analysisCatalog).not.toHaveBeenCalled();
    await blocked.call("metric_query", query);
    expect(blocked.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { steps: [expect.objectContaining({ metric_refs: ["signed:M1"] })] },
    });
  });

  it("新一轮重新检索第一页后使用新的总量，不沿用旧末页拦截", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValueOnce({
      items: [descriptor],
      total: 1,
      page: 1,
      page_size: 12,
      has_more: false,
    });
    await f.call("metric_search", { keywords: ["余额"] });
    f.messages.push({ role: "user", content: "重新查余额", timestamp: 1 });
    f.backend.analysisCatalog.mockResolvedValue({
      items: [descriptor],
      total: 25,
      page: 1,
      page_size: 12,
      has_more: true,
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_search", { keywords: ["余额"], page: 2 });
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(3);
  });
});

describe("同轮完整 observe 来源的指标子集复用", () => {
  async function queried(
    options: { latest?: boolean; complete?: boolean; cohort?: boolean; unknownEncoding?: boolean } = {},
  ) {
    const f = fixture();
    const descriptors = [
      descriptor,
      secondDescriptor,
      {
        ...descriptor,
        code: "M3",
        name: "测试费用率",
        binding_ref: "signed:M3",
        unit: options.unknownEncoding ? "%" : "元",
      },
    ];
    f.backend.analysisCatalog.mockResolvedValue({ items: descriptors });
    if (options.latest)
      f.resolveDate.mockResolvedValue({ status: "resolved", value: { preset: "latest" } });
    f.backend.analysisExecute.mockImplementation((payload, key) => {
      const plan = payload.plan as { steps: Array<{ metric_refs: string[] }> };
      const refs = plan.steps.flatMap((step) => step.metric_refs);
      const metrics = descriptors.filter((item) => refs.includes(item.binding_ref));
      return Promise.resolve(
        evidence({
          plan,
          run_ref: `analysis:${key}`,
          complete: options.complete ?? true,
          metric_descriptors: metrics,
          evidence_items: metrics.map((item) => ({
            ref: `fact:${item.code}`,
            type: "fact",
            metric_code: item.code,
            org_code: "3200",
            date: "2026-07-31",
            unit: item.unit,
            value: "100",
            display: `100${item.unit}`,
          })),
        }),
      );
    });
    await f.call("metric_search", { keywords: ["费用"] });
    const input = {
      ...query,
      metric_refs: ["k1", "k2", "k3"],
      date: options.latest ? "latest" : "2026-07-31",
      ...(options.cohort ? { scope: "all_banks", org_names: undefined } : {}),
    };
    const first = await f.call("metric_query", input);
    return { ...f, first, input };
  }

  it.each([false, true])("完整批次后只查其中一个指标复用原来源，latest=%s", async (latest) => {
    const f = await queried({ latest });
    const original = structuredClone(currentTurnEvidence(f.messages));
    const repeated = await f.call("metric_query", { ...f.input, metric_refs: ["k3"] });
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
    expect(repeated.details).toMatchObject({
      kind: "inquiry_query_reuse",
      reused: true,
      no_new_evidence: true,
      evidence_ref: "e1",
      run_ref: f.first.details.run_ref,
      requested_metric_codes: ["M3"],
      source_metric_codes: ["M1", "M2", "M3"],
    });
    const view: unknown = JSON.parse(repeated.content[0].text);
    expect(view).toMatchObject({
      kind: "inquiry_query_reuse",
      evidence_ref: "e1",
      no_new_evidence: true,
      requested_metric_codes: ["M3"],
      source_metric_codes: ["M1", "M2", "M3"],
    });
    expect(view).toHaveProperty("tables.2.metric_code", "M3");
    expect(view).toHaveProperty("tables.2.rows.0", ["e1.v3", "3200", "100元"]);
    expect(view).not.toHaveProperty("notice", expect.stringMatching(/profiles|focus/u));
    expect(currentTurnEvidence(f.messages)).toEqual(original);
    const originalView: unknown = JSON.parse(f.first.content[0].text);
    expect(originalView).toHaveProperty("tables.2.metric_code", "M3");
    expect(originalView).toHaveProperty("tables.2.rows.0", ["e1.v3", "3200", "100元"]);
  });

  it("普通子集复用保留未知比例编码的限制，不把已得数值当作缺数", async () => {
    const f = await queried({ unknownEncoding: true });
    const result = await f.call("metric_query", { ...f.input, metric_refs: ["k3"] });
    const view: unknown = JSON.parse(result.content[0].text);
    expect(view).toMatchObject({
      kind: "inquiry_query_reuse",
      evidence_ref: "e1",
      run_ref: f.first.details.run_ref,
      no_new_evidence: true,
      requested_metric_codes: ["M3"],
      source_metric_codes: ["M1", "M2", "M3"],
      unavailable_metrics: [
        {
          metric_code: "M3",
          reason: "unknown_percentage_encoding",
          data_status: "present",
          org_codes: ["3200"],
          date: "2026-07-31",
        },
      ],
    });
    expect(view).toHaveProperty(
      "tables",
      expect.arrayContaining([
        expect.objectContaining({ metric_code: "M2", rows: [["e1.v2", "3200", "100元"]] }),
      ]),
    );
    expect(view).not.toHaveProperty(
      "tables",
      expect.arrayContaining([expect.objectContaining({ metric_code: "M3" })]),
    );
    expect(view).not.toHaveProperty("notice", expect.stringMatching(/profiles|focus/u));
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
    expect(currentTurnEvidence(f.messages)).toHaveLength(1);
  });

  it("主题来源的子集复用仍使用已有概览及按需读取明细", async () => {
    const f = await queried();
    f.first.details.topic_execution = {
      completed: true,
      completed_metric_codes: ["M1", "M2", "M3"],
    };
    const result = await f.call("metric_query", { ...f.input, metric_refs: ["k3"] });
    const view: unknown = JSON.parse(result.content[0].text);
    expect(view).toMatchObject({
      kind: "inquiry_query_reuse",
      evidence_ref: "e1",
      run_ref: f.first.details.run_ref,
      no_new_evidence: true,
      requested_metric_codes: ["M3"],
      source_metric_codes: ["M1", "M2", "M3"],
      topic_execution: { completed: true },
    });
    expect(view).toHaveProperty("notice", expect.stringContaining("focus"));
    expect(view).not.toHaveProperty("tables");
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
    expect(currentTurnEvidence(f.messages)).toHaveLength(1);
  });

  it.each(["method", "organization", "date", "operation", "actor", "session"])(
    "%s 改变后不能借用原完整批次",
    async (change) => {
      const f = await queried();
      const input = { ...f.input, metric_refs: ["k3"] };
      if (change === "method") Object.assign(input, { method: "compare", comparisons: ["mom"] });
      if (change === "organization") input.org_names = ["3201"];
      if (change === "date") {
        input.date = "2026-06-30";
        f.resolveDate.mockResolvedValue({
          status: "resolved",
          value: { start: "2026-06-30", end: "2026-06-30" },
        });
      }
      if (change === "operation") f.request.operationId = "op-2";
      if (change === "actor") f.request.actor = { ...f.request.actor, id: "user-2" };
      if (change === "session") f.request.sessionId = "session-2";
      const result = await f.call("metric_query", input);
      expect(result.details.kind).toBe("analysis_evidence");
      expect(result.details).not.toHaveProperty("reused");
      expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
    },
  );

  it("授权机构集合指纹改变后仍需重新查询", async () => {
    const f = await queried({ cohort: true });
    f.backend.resolveOrganizationScope.mockResolvedValue({
      status: "resolved",
      value: {
        codes: ["3200", "3201"],
        names: ["测试机构", "测试分行"],
        scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
        scope_fingerprint: "changed-token",
      },
    });
    const result = await f.call("metric_query", { ...f.input, metric_refs: ["k3"] });
    expect(result.details.kind).toBe("analysis_evidence");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });

  it("未完成来源不能当作已完成的子集查询", async () => {
    const f = await queried({ complete: false });
    const result = await f.call("metric_query", { ...f.input, metric_refs: ["k3"] });
    expect(result.details.kind).toBe("analysis_evidence");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });
});

describe("同轮已知元数据阻塞跨方法复用", () => {
  async function blocked(unit = "%", value: unknown = "0.125") {
    const f = fixture();
    const metrics = [{...descriptor, unit}, secondDescriptor];
    f.backend.analysisCatalog.mockResolvedValue({items: metrics});
    f.backend.analysisExecute.mockImplementation((payload, key) => {
      const plan = payload.plan as {steps: Array<{metric_refs: string[]}>};
      const selected = metrics.filter(metric => plan.steps.some(step => step.metric_refs.includes(metric.binding_ref)));
      return Promise.resolve(evidence({plan, run_ref: `analysis:${key}`, complete: true,
        metric_descriptors: selected,
        evidence_items: selected.map(metric => ({ref: `fact:${metric.code}`, type: "fact", metric_code: metric.code,
          org_code: "3200", date: "2026-07-31", unit: metric.unit, value, display: "口径待确认"}))}));
    });
    await f.call("metric_search", {keywords: ["余额"]});
    const input = {...query, date: "2026-07-31"};
    const first = await f.call("metric_query", input);
    return {...f, input, first};
  }

  it.each(["trend", "ranking", "compare"])("%s 不能修复已确认缺失的百分比编码，沿用原来源和原因", async method => {
    const f = await blocked();
    const original = structuredClone(currentTurnEvidence(f.messages));
    const result = await f.call("metric_query", {...f.input, method, ...(method === "compare" ? {comparisons: ["mom"]} : {})});
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({kind: "inquiry_query_reuse", evidence_ref: "e1", no_new_evidence: true,
      metadata_blockers: [{metric_code: "M1", reason: "unknown_percentage_encoding"}]});
    expect(JSON.parse(result.content[0].text)).toMatchObject({unavailable_metrics: [{data_status: "present"}],
      metadata_blockers: [{metric_code: "M1", reason: "unknown_percentage_encoding"}]});
    expect(result.content[0].text).not.toContain("0.125");
    expect(currentTurnEvidence(f.messages)).toEqual(original);
    expect(f.resolveOrganizations).toHaveBeenCalledTimes(2);
    expect(f.resolveDate).toHaveBeenCalledTimes(2);
  });

  it("缺少单位的零值也沿用 typed 原因", async () => {
    const f = await blocked("", "0");
    const result = await f.call("metric_query", {...f.input, method: "ranking"});
    expect(result.details).toHaveProperty("metadata_blockers", [{metric_code: "M1", reason: "unknown_unit"}]);
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
  });

  it("混合批只跳过已知受阻指标，新的指标仍真实执行", async () => {
    const f = await blocked();
    const result = await f.call("metric_query", {...f.input, metric_refs: ["k1", "k2"], method: "ranking"});
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
    expect(f.backend.analysisExecute.mock.calls[1]?.[0]).toMatchObject({plan: {steps: [{metric_refs: ["signed:M2"]}]}});
    expect(result.details).toMatchObject({kind: "semantic_results", query_progress: {completed_metric_codes: ["M1", "M2"]}});
    expect(JSON.parse(result.content[0].text)).toMatchObject({results: [{kind: "inquiry_query_reuse", evidence_ref: "e1",
      metadata_blockers: [{metric_code: "M1", reason: "unknown_percentage_encoding"}]}, {evidence_ref: "e2"}]});
    expect(currentTurnEvidence(f.messages)).toHaveLength(2);
  });

  it.each([null, "", "not-a-number"])("原始值 %s 不构成元数据阻塞证据", async value => {
    const f = await blocked("%", value);
    const result = await f.call("metric_query", {...f.input, method: "trend"});
    expect(result.details.kind).toBe("analysis_evidence");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });

  it("同一指标有可用事实时不能把整个指标跳过", async () => {
    const f = await blocked();
    const atoms = f.first.details.evidence_items as Array<Record<string, unknown>>;
    atoms.push({...atoms[0], ref: "fact:valid", value_encoding: "ratio"});
    await f.call("metric_query", {...f.input, method: "trend"});
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });

  it.each(["organization", "date", "operation", "actor", "session", "binding"])("%s 改变后不沿用旧阻塞", async change => {
    const f = await blocked();
    const input = {...f.input, method: "trend"};
    if (change === "organization") input.org_names = ["3201"];
    if (change === "date") {
      input.date = "2026-06-30";
      f.resolveDate.mockResolvedValue({status: "resolved", value: {start: "2026-06-30", end: "2026-06-30"}});
    }
    if (change === "operation") f.request.operationId = "op-2";
    if (change === "actor") f.request.actor = {...f.request.actor, id: "user-2"};
    if (change === "session") f.request.sessionId = "session-2";
    if (change === "binding") {
      f.backend.analysisCatalog.mockResolvedValue({items: [{...descriptor, binding_ref: "signed:M1-new"}]});
      await f.call("metric_search", {keywords: ["新版余额"]});
      input.metric_refs = ["k3"];
    }
    const result = await f.call("metric_query", input);
    expect(result.isError, JSON.stringify(result.details)).not.toBe(true);
    expect(result.details).not.toHaveProperty("metadata_blockers");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });

  it("本次授权解析失败仍停止访问，不能用旧阻塞绕过", async () => {
    const f = await blocked();
    f.resolveOrganizations.mockRejectedValue(new BackendApiError(403, "无权访问", "FORBIDDEN"));
    await expect(f.call("metric_query", {...f.input, method: "trend"})).rejects.toMatchObject({status: 403});
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
  });

  it("混合批新指标失败时保留原阻塞证据和未完成指标", async () => {
    const f = await blocked();
    f.backend.analysisExecute.mockRejectedValue(new BackendApiError(503, "服务异常", "UNAVAILABLE"));
    const result = await f.call("metric_query", {...f.input, metric_refs: ["k1", "k2"], method: "trend"});
    expect(result.details).toMatchObject({status: "partial", query_progress: {completed_metric_codes: ["M1"], pending_metric_codes: ["M2"]}});
    expect(JSON.parse(result.content[0].text)).toMatchObject({results: [{evidence_ref: "e1",
      metadata_blockers: [{metric_code: "M1", reason: "unknown_percentage_encoding"}]}, {status: "failed", error_code: "UNAVAILABLE"}]});
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });

  it("集合范围指纹改变后同机构编码也不能沿用旧阻塞", async () => {
    const f = await blocked();
    const cohort = {...f.input, scope: "all_banks", org_names: undefined};
    await f.call("metric_query", cohort);
    f.backend.resolveOrganizationScope.mockResolvedValue({status: "resolved", value: {codes: ["3200", "3201"],
      names: ["测试机构", "测试分行"], scope: {kind: "authorized_cohort", cohort: "rural_commercial_banks"}, scope_fingerprint: "changed-token"}});
    await f.call("metric_query", {...cohort, method: "trend"});
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(3);
  });
});

describe("查询结果中的正式后续指标", () => {
  it.each(["metric_query", "analysis_read"])(
    "%s 保留后续入口，下一次取数直接复用绑定",
    async (tool) => {
      const f = fixture();
      const followup = { ...secondDescriptor, name: "测试余额较同期", value_basis: "较同期" };
      const result = evidence({ followup_metrics: [followup] });
      const original = structuredClone(result);
      f.backend.analysisExecute.mockResolvedValue(result);
      f.backend.analysisEvidence.mockResolvedValue(result);
      await f.call("metric_search", { keywords: ["余额"] });
      let received: InquiryToolTestResult;
      if (tool === "analysis_read") {
        await f.bridge.setConversationId("conv-1");
        f.request.history = {
          ...f.request.history,
          analysisSource: () => Promise.resolve({ run_ref: "analysis:one", scope_id: "old-op" }),
        };
        received = await f.call(tool, { run_ref: "analysis:one" });
      } else {
        received = await f.call(tool, query);
      }
      expect(JSON.parse(received.content[0].text)).toMatchObject({
        followup_metrics: [
          { code: "M2", name: followup.name, binding_ref: "k2", value_basis: "较同期" },
        ],
      });
      expect(received.content[0].text).not.toContain("signed:");
      expect(result).toEqual(original);
      // 新请求对象从持久回执恢复绑定，覆盖刷新后的取数。
      const resumed = fixture(f.messages);
      await resumed.bridge.setConversationId("conv-1");
      const next = await resumed.call("metric_query", {
        ...query,
        metric_refs: ["k2"],
        date: "2026-07-31",
      });
      expect(next.isError, JSON.stringify(next.details)).not.toBe(true);
      expect(resumed.backend.analysisCatalog).not.toHaveBeenCalled();
      expect(resumed.backend.analysisExecute).toHaveBeenCalledTimes(1);
      expect(resumed.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
        plan: { steps: [{ metric_refs: ["signed:M2"] }] },
      });
    },
  );
});

describe("普通追问的执行目标绑定", () => {
  const goalQuery = { purpose: "读取余额", metric_refs: ["k1"], method: "observe" };
  async function declared() {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    const baseline = readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)!;
    return { ...f, baseline };
  }
  it("新期间契约执行原范围，局部比较期不改主目标", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1, time_contract: 2 };
    await f.call("metric_search", { keywords: ["余额"] });
    const calendar = { start: "2026-01-01", end: "2026-06-30" };
    f.backend.resolveBusinessField.mockImplementation((entity, values, _options, _year, _source, modelValue) =>
      Promise.resolve(entity === "organization"
        ? { status: "resolved", value: { codes: values, names: values } }
        : { status: "resolved", value: modelValue ?? { start: values[0], end: values[0] } }));
    const result = await f.call("metric_query", {
      ...goalQuery,
      target_change: { mode: "new", topic: "存款余额", time: { expression: "上半年", calendar },
        selection: "latest_in_range", organizations: { mode: "replace", scope: "named", names: ["3200"] } },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({ ...calendar, date_selection: "latest_in_range" });
    expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time_request)
      .toEqual({ expression: "上半年", calendar });
    const compared = await f.call("metric_query", { ...goalQuery, date: "2025-12-31" });
    expect(compared.isError, JSON.stringify(compared.content)).not.toBe(true);
    expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({ start: "2025-12-31", end: "2025-12-31" });
    expect(readInquiryTargetSnapshot(compared.details.inquiry_target_snapshot)?.time).toMatchObject(calendar);
  });
  it("新运行不能通过旧date入口跳过原期间声明", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1, time_contract: 2 };
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", { ...goalQuery, target_change: {
      mode: "new", topic: "存款余额", date: "latest",
      organizations: { mode: "replace", scope: "named", names: ["3200"] },
    } });
    expect(result.details).toMatchObject({ code: "INQUIRY_TARGET_INVALID", validation_stage: "target_time_contract" });
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });
  it.each(["target", "local", "legacy"])(
    "日期换算通过服务端解析后执行原期间，不回退最新：%s",
    async (mode) => {
      const f = mode === "local" ? await declared() : fixture();
      if (mode === "target") f.request.inquiryTargetContext = { version: 1 };
      if (mode !== "local") await f.call("metric_search", { keywords: ["余额"] });
      const calendar = { start: "2026-01-01", end: "2026-10-31" };
      f.backend.resolveBusinessField.mockImplementation(
        (entity, values, _options, _year, _source, modelValue) => {
          if (entity === "organization")
            return Promise.resolve({ status: "resolved", value: { codes: values, names: values } });
          return Promise.resolve(
            modelValue
              ? { status: "resolved", value: modelValue, metadata: { resolution_source: "model" } }
              : { status: "invalid", metadata: { reason: "unsupported_expression" } },
          );
        },
      );
      const dateInput = { date: "今年以来", date_calendar: calendar };
      const result = await f.call("metric_query", {
        ...query,
        ...(mode === "target"
          ? {
              target_change: {
                mode: "new",
                topic: "存款余额",
                organizations: { mode: "replace", scope: "named", names: ["3200"] },
                ...dateInput,
              },
            }
          : dateInput),
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
        ...calendar,
        org_codes: ["3200"],
      });
      expect(result.details.inquiry_date).toMatchObject(calendar);
      if (mode === "target")
        expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time).toMatchObject(
          calendar,
        );
      if (mode === "local")
        expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time).toMatchObject(
          { start: "2026-07-31", end: "2026-07-31" },
        );
    },
  );
  it.each(["unsupported_expression", "invalid_calendar", "incomplete_range"])(
    "主目标日期失败保留原因和修正字段，不执行或锁定错误目标：%s",
    async (reason) => {
      const f = fixture();
      f.request.inquiryTargetContext = { version: 1 };
      await f.call("metric_search", { keywords: ["余额"] });
      f.resolveDate.mockResolvedValue({ status: "invalid", metadata: { reason } });
      const result = await f.call("metric_query", {
        ...query,
        target_change: {
          mode: "new",
          topic: "存款余额",
          date: "原期间",
          date_calendar: { start: "2026-01-01", end: "2026-10-31" },
          organizations: { mode: "replace", scope: "named", names: ["3200"] },
        },
      });
      expect(result).toMatchObject({
        isError: true,
        details: {
          code: "ANALYSIS_DATE_UNRESOLVED",
          validation_stage: "target_date",
          correction_fields: ["target_change"],
        },
      });
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        resolution: { expression: "原期间", metadata: { reason } },
      });
      expect(result.details.inquiry_target_snapshot).toBeUndefined();
      expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    },
  );
  it("局部日期失败保留原目标并明确只修正本次日期", async () => {
    const f = await declared();
    f.resolveDate.mockResolvedValue({
      status: "invalid",
      metadata: { reason: "unsupported_expression" },
    });
    const result = await f.call("metric_query", { ...goalQuery, date: "原期间" });
    expect(result.details).toMatchObject({
      code: "ANALYSIS_DATE_UNRESOLVED",
      correction_fields: ["date", "date_calendar"],
      validation_stage: "query_date",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      resolution: { expression: "原期间", metadata: { reason: "unsupported_expression" } },
    });
    expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time).toEqual(
      f.baseline.time,
    );
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
  });
  it.each(["local", "legacy"])("日期换算不能脱离原表达独立改变取数：%s", async (mode) => {
    const f = mode === "local" ? await declared() : fixture();
    if (mode === "legacy") await f.call("metric_search", { keywords: ["余额"] });
    const before = f.backend.analysisExecute.mock.calls.length;
    const result = await f.call("metric_query", {
      ...query,
      date_calendar: { start: "2026-01-01", end: "2026-10-31" },
    });
    expect(result).toMatchObject({
      isError: true,
      details: { code: "ANALYSIS_DATE_UNRESOLVED", correction_fields: ["date", "date_calendar"] },
    });
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(before);
  });
  it("显式日期的确定性解析结果优先于模型换算", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    await f.call("metric_search", { keywords: ["余额"] });
    const args = {
      ...query,
      target_change: {
        mode: "new",
        topic: "余额",
        date: "2026-07-31",
        date_calendar: { start: "2026-01-01", end: "2026-10-31" },
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    };
    const tool = createInquiryQueryTools().find((item) => item.name === "metric_query")!;
    expect(() => {
      validateToolArguments(tool, { type: "toolCall", id: "date", name: tool.name, arguments: args });
    }).not.toThrow();
    const result = await f.call("metric_query", args);
    expect(result.isError).not.toBe(true);
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
    expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
  });
  it.each([undefined, 2] as const)("主题批量查询转发同一日期换算并按规范期间执行：%s", async (timeContract) => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    if (timeContract) f.request.inquiryTargetContext.time_contract = timeContract;
    const registry = loadTopicRegistry();
    const definition = registry.topics[0]!;
    const items = Object.values(registry.metrics).map((metric) => ({
      ...metric,
      binding_ref: `signed:${metric.code}`,
    }));
    Object.assign(f.backend, {
      analysisBindMetrics: vi
        .fn<BackendClient["analysisBindMetrics"]>()
        .mockResolvedValue({ items, missing_codes: [] }),
    });
    f.backend.analysisExecute.mockResolvedValue(
      evidence({ metric_descriptors: items, evidence_items: [] }),
    );
    f.backend.resolveBusinessField.mockImplementation(
      (entity, values, _options, _year, _source, calendar) =>
        Promise.resolve(
          entity === "organization"
            ? { status: "resolved", value: { codes: values, names: values } }
            : calendar
              ? { status: "resolved", value: calendar, metadata: { resolution_source: "model" } }
              : { status: "invalid", metadata: { reason: "unsupported_expression" } },
        ),
    );
    const queryTool = createInquiryQueryTools().find((tool) => tool.name === "metric_query")!;
    const topic = createTopicQueryTool(queryTool, registry);
    const calendar = { start: "2026-01-01", end: "2026-10-31" };
    const args = {
      topic_id: definition.id,
      scope: "named",
      org_names: ["3200"],
      date: "今年以来",
      date_calendar: calendar,
    };
    const result = (await runTool(topic, args, f.request)) as InquiryToolTestResult;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject(calendar);
    expect(
      readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time,
    ).toMatchObject(calendar);
    expect(() => {
      validateToolArguments(topic, {
        type: "toolCall",
        id: "date",
        name: topic.name,
        arguments: args,
      });
    }).not.toThrow();
  });
  it("新协议不能直接执行未声明的自由机构参数", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", query);
    expect(result.details.code).toBe("INQUIRY_TARGET_REQUIRED");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });
  it.each([true, false])("本次取数日期生效且不改写主目标（显式声明=%s）", async (explicit) => {
    const f = await declared();
    f.resolveDate.mockResolvedValueOnce({
      status: "resolved",
      value: { start: "2026-01-01", end: "2026-01-01" },
    });
    const result = await f.call("metric_query", {
      ...goalQuery,
      date: "2026-01-01",
      ...(explicit ? { target_change: { mode: "continue", base_ref: f.baseline.ref } } : {}),
    });
    expect(result.isError).not.toBe(true);
    expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
      org_codes: ["3200"],
      start: "2026-01-01",
      end: "2026-01-01",
    });
    expect(result.details.inquiry_date).toMatchObject({ start: "2026-01-01", end: "2026-01-01" });
    expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
    await f.call("metric_query", goalQuery);
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });
  it("局部取数日期无法解析时保留主目标，不回退到主目标日期执行", async () => {
    const f = await declared();
    f.resolveDate.mockResolvedValueOnce({ status: "invalid" });
    const result = await f.call("metric_query", { ...goalQuery, date: "未确定期间" });
    expect(result).toMatchObject({ isError: true, details: { code: "ANALYSIS_DATE_UNRESOLVED" } });
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
    expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.time).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
  });
  it("切换机构后只改日期，执行对象始终是最新声明机构", async () => {
    const f = await declared();
    f.request.operationId = "op-2";
    f.request.inquiryTargetContext = { version: 1, baseline: f.baseline };
    const switched = await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "update",
        base_ref: f.baseline.ref,
        organizations: { mode: "replace", scope: "named", names: ["3201"] },
      },
    });
    const baseline = readInquiryTargetSnapshot(switched.details.inquiry_target_snapshot)!;
    f.request.operationId = "op-3";
    f.request.inquiryTargetContext = { version: 1, baseline };
    f.resolveDate.mockResolvedValueOnce({
      status: "resolved",
      value: { start: "2026-06-30", end: "2026-06-30" },
    });
    await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "update",
        base_ref: baseline.ref,
        date: "2026-06-30",
      },
    });
    expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
      org_codes: ["3201"],
      start: "2026-06-30",
      end: "2026-06-30",
    });
  });
  it.each(["metric_query", "metric_availability"])(
    "%s在全体目标中按单行取数，之后仍继承全体目标",
    async (toolName) => {
      const f = fixture();
      f.request.inquiryTargetContext = { version: 1 };
      await f.call("metric_search", { keywords: ["余额"] });
      const first = await f.call("metric_query", {
        ...goalQuery,
        method: "ranking",
        target_change: {
          mode: "new",
          topic: "收益排名",
          date: "2026-07-31",
          organizations: { mode: "replace", scope: "all_banks" },
        },
      });
      const baseline = readInquiryTargetSnapshot(first.details.inquiry_target_snapshot)!;
      const result = await f.call(toolName, {
        ...(toolName === "metric_query" ? goalQuery : { metric_refs: ["k1"] }),
        target_change: { mode: "continue", base_ref: baseline.ref },
        scope: "named",
        org_names: ["测试分行"],
      });
      expect(result.isError).not.toBe(true);
      const actual =
        toolName === "metric_query"
          ? f.backend.analysisExecute.mock.calls.at(-1)?.[0]
          : f.backend.dataAvailability.mock.calls.at(-1)?.[0];
      expect(actual).toMatchObject({ org_codes: ["3201"] });
      expect(actual).not.toHaveProperty("organization_scope");
      if (toolName === "metric_query")
        expect(result.details.inquiry_scope).toMatchObject({ codes: ["3201"] });
      expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)).toMatchObject({
        organizations: { codes: ["3200", "3201"], scope: { kind: "authorized_cohort" } },
      });
      await f.call("metric_query", goalQuery);
      expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
        org_codes: [],
        organization_scope: { kind: "authorized_cohort" },
      });
    },
  );
  it.each(["metric_query", "metric_availability"])(
    "%s不把局部选择扩成主目标之外的机构",
    async (toolName) => {
      const f = await declared();
      const result = await f.call(toolName, {
        ...(toolName === "metric_query" ? goalQuery : { metric_refs: ["k1"] }),
        scope: "named",
        org_names: ["3209"],
      });
      expect(result).toMatchObject({
        isError: true,
        details: { code: "INQUIRY_TARGET_SCOPE_CHANGED" },
      });
      expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
      expect(f.backend.dataAvailability).not.toHaveBeenCalled();
      expect(
        readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.organizations.codes,
      ).toEqual(["3200"]);
    },
  );
  it("新目标保留同次日期解析的有效备选口径", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2023-08-28", end: "2026-08-27" },
      alternative: { label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "近三年",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    expect(result.details.time_variants).toEqual([
      { label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" },
    ]);
  });
  it.each([
    { label: "无效日", start: "2026-02-30", end: "2026-03-01" },
    { label: "倒序区间", start: "2026-03-01", end: "2026-02-28" },
    { label: " ", start: "2026-01-01", end: "2026-01-31" },
  ])("新目标不保留无效日期备选：$label", async (alternative) => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2023-08-28", end: "2026-08-27" },
      alternative,
    });
    f.backend.analysisExecute.mockResolvedValue(evidence({ time_variants: [alternative] }));
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "近三年",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    expect(result.details).not.toHaveProperty("time_variants");
  });
  it("继承目标不从旧查询回执补造日期备选", async () => {
    const f = await declared();
    f.request.operationId = "op-inherit";
    f.request.inquiryTargetContext = { version: 1, baseline: f.baseline };
    f.backend.analysisExecute.mockResolvedValue(
      evidence({
        time_variants: [{ label: "旧备选", start: "2023-01-01", end: "2025-12-31" }],
      }),
    );
    const result = await f.call("metric_query", {
      ...goalQuery,
      target_change: { mode: "continue", base_ref: f.baseline.ref },
    });
    expect(result.details).not.toHaveProperty("time_variants");
  });
  it("显式时间覆盖不展示目标日期解析产生的旧备选", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.request.timeOverride = { start: "2023-01-01", end: "2025-12-31" };
    const alternative = { label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" };
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2023-08-28", end: "2026-08-27" },
      alternative,
    });
    f.backend.analysisExecute.mockResolvedValue(evidence({ time_variants: [alternative] }));
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "近三年",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    expect(result.details).not.toHaveProperty("time_variants");
  });
  it("独立补查不发布新目标，下一次主查询仍使用原目标", async () => {
    const f = await declared();
    f.resolveDate.mockResolvedValueOnce({
      status: "resolved",
      value: { start: "2026-01-01", end: "2026-01-01" },
    });
    const independent = await f.call("metric_query", {
      ...goalQuery,
      independent: true,
      scope: "named",
      org_names: ["3209"],
      date: "2026-01-01",
    });
    expect(independent.details.inquiry_target_snapshot).toBeUndefined();
    expect(independent.details).toHaveProperty("inquiry_scope_role", "reference");
    expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
      org_codes: ["3209"],
      start: "2026-01-01",
      end: "2026-01-01",
    });
    await f.call("metric_availability", {
      metric_refs: ["k1"],
      start: "2026-01-01",
      end: "2026-01-31",
    });
    expect(f.backend.dataAvailability.mock.calls.at(-1)?.[0]).toMatchObject({
      org_codes: ["3200"],
      start: "2026-01-01",
      end: "2026-01-31",
    });
    const continued = await f.call("metric_query", goalQuery);
    expect(readInquiryTargetSnapshot(continued.details.inquiry_target_snapshot)).toMatchObject({
      organizations: { codes: ["3200"] },
      time: { start: "2026-07-31", end: "2026-07-31" },
    });
  });
  it("主查询复用参考结果时更新用途，保持引用及已持久化回执不变", async () => {
    const f = await declared();
    f.resolveDate.mockResolvedValue({status: "resolved", value: {start: "2026-01-01", end: "2026-01-01"}});
    f.backend.analysisExecute.mockResolvedValue(evidence({run_ref: "analysis:reference"}));
    const independent = await f.call("metric_query", {
      ...goalQuery, independent: true, scope: "named", org_names: ["3200"], date: "2026-01-01",
    });
    const calls = f.backend.analysisExecute.mock.calls.length;
    await f.call("metric_query", {...goalQuery, date: "2026-01-01"});
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(calls);
    const sources = currentTurnEvidence(f.messages);
    expect(sources).toHaveLength(2);
    expect(sources[1]?.ref).toBe("e2");
    expect(sources[1]?.evidence).not.toHaveProperty("inquiry_scope_role", "reference");
    expect(independent.details.inquiry_scope_role).toBe("reference");
    await f.call("metric_query", {
      ...goalQuery, independent: true, scope: "named", org_names: ["3200"], date: "2026-01-01",
    });
    expect(currentTurnEvidence(f.messages)[1]?.evidence).not.toHaveProperty("inquiry_scope_role", "reference");
  });
  it("查询服务失败仍交付明确声明的条件，不恢复历史日期", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.backend.analysisExecute.mockRejectedValueOnce(
      new BackendApiError(503, "unavailable", "MODEL_UNAVAILABLE"),
    );
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3201"] },
      },
    });
    expect(result.isError).toBe(true);
    expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)).toMatchObject({
      organizations: { codes: ["3201"] },
      time: { start: "2026-07-31" },
    });
  });
  it("独立补查不能夹带目标变更", async () => {
    const f = await declared();
    const result = await f.call("metric_query", {
      ...goalQuery,
      independent: true,
      target_change: { mode: "update", base_ref: f.baseline.ref, date: "2026-06-30" },
    });
    expect(result.details.code).toBe("INQUIRY_TARGET_INVALID");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403])("%s 保留原有权限终态，不能转为普通可恢复错误", async (status) => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    await f.call("metric_search", { keywords: ["余额"] });
    const failure = new BackendApiError(status, "denied", "PERMISSION_DENIED");
    f.backend.analysisExecute.mockRejectedValueOnce(failure);
    await expect(
      f.call("metric_query", {
        ...goalQuery,
        target_change: {
          mode: "new",
          topic: "存款余额",
          date: "2026-07-31",
          organizations: { mode: "replace", scope: "named", names: ["3201"] },
        },
      }),
    ).rejects.toBe(failure);
  });
  it("页面切换区间保留原目标的区间取末期方式", async () => {
    const f = await declared();
    f.request.operationId = "op-range";
    f.request.inquiryTargetContext = {
      version: 1,
      baseline: {
        ...f.baseline,
        time: { date_selection: "latest_in_range", start: "2025-01-01", end: "2025-12-31" },
      },
    };
    f.request.timeOverride = { start: "2026-01-01", end: "2026-06-30" };
    await f.call("metric_query", {
      ...goalQuery,
      date: "2026-01-01",
      target_change: { mode: "continue", base_ref: f.baseline.ref },
    });
    expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
      date_selection: "latest_in_range",
      start: "2026-01-01",
      end: "2026-06-30",
    });
  });
  it("只有日期覆盖或失败回执时不能绕过本轮核心查询去补查", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_availability", {
      metric_refs: ["k1"],
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    const result = await f.call("metric_query", {
      ...goalQuery,
      independent: true,
      scope: "named",
      org_names: ["3209"],
    });
    expect(result.details.code).toBe("INQUIRY_TARGET_INCOMPLETE");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });
  it.each(["部分机构", "其他期间"])("首笔仅查询%s时不视为主目标已查齐", async (selection) => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.resolveDate
      .mockResolvedValueOnce({
        status: "resolved",
        value: { start: "2026-07-31", end: "2026-07-31" },
      })
      .mockResolvedValueOnce({
        status: "resolved",
        value: { start: "2026-06-30", end: "2026-06-30" },
      });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", {
      ...goalQuery,
      ...(selection === "部分机构"
        ? { scope: "named", org_names: ["3200"] }
        : { date: "2026-06-30" }),
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200", "3201"] },
      },
    });
    const result = await f.call("metric_query", {
      ...query,
      independent: true,
      org_names: ["3209"],
      date: "2026-07-31",
    });
    expect(result.details.code).toBe("INQUIRY_TARGET_INCOMPLETE");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
  });
  it("同期间分批查询全部主目标机构后允许独立补查", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.backend.analysisExecute
      .mockResolvedValueOnce(evidence({ run_ref: "analysis:first" }))
      .mockResolvedValueOnce(evidence({ run_ref: "analysis:second", org_codes: ["3201"] }));
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", {
      ...query,
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200", "3201"] },
      },
    });
    await f.call("metric_query", { ...query, org_names: ["3201"] });
    const result = await f.call("metric_query", {
      ...query,
      independent: true,
      org_names: ["3209"],
      date: "2026-07-31",
    });
    expect(result.isError).not.toBe(true);
    expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({ org_codes: ["3209"] });
  });
  it("主目标请求正常缺数也计入执行覆盖，允许独立查询参考数据", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.backend.analysisExecute.mockResolvedValueOnce(
      evidence({
        run_ref: "analysis:empty",
        analysis_date: null,
        actual_dates: [],
        evidence_items: [],
        rows: [],
      }),
    );
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", {
      ...goalQuery,
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200", "3201"] },
      },
    });
    const result = await f.call("metric_query", {
      ...query,
      independent: true,
      org_names: ["3209"],
      date: "2026-07-31",
    });
    expect(result.isError).not.toBe(true);
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });
  it.each([
    { name: "本轮全部成功", second: {}, allowed: true },
    { name: "其中一个查询失败", second: { status: "failed" }, allowed: false },
    { name: "其中一个属于旧轮", second: { execution_turn_id: "old-operation" }, allowed: false },
    { name: "其中一个日期选择不同", second: { date_selection: "latest_in_range" }, allowed: false },
  ])("复合回执按实际查询条件累计主目标覆盖：$name", async ({ second, allowed }) => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    await f.call("metric_search", { keywords: ["余额"] });
    const declared = await f.call("metric_availability", {
      metric_refs: ["k1"],
      target_change: {
        mode: "new",
        topic: "存款余额",
        date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200", "3201"] },
      },
    });
    const receipt = (org: string, overrides: Record<string, unknown> = {}) =>
      evidence({
        run_ref: `analysis:${org}`,
        org_codes: [org],
        execution_turn_id: f.request.operationId,
        date_selection: "exact",
        requested_start: "2026-07-31",
        requested_end: "2026-07-31",
        analysis_date: null,
        evidence_items: [],
        ...overrides,
      });
    f.messages.push({
      role: "toolResult",
      toolName: "metric_query",
      toolCallId: "batch-results",
      timestamp: 0,
      content: [],
      isError: false,
      details: {
        kind: "semantic_results",
        status: "partial",
        inquiry_target_snapshot: declared.details.inquiry_target_snapshot,
        results: [receipt("3200"), receipt("3201", second)],
      },
    });
    const result = await f.call("metric_query", {
      ...query,
      independent: true,
      org_names: ["3209"],
      date: "2026-07-31",
    });
    if (allowed) {
      expect(result.isError).not.toBe(true);
      expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
        org_codes: ["3209"],
      });
    } else {
      expect(result.details.code).toBe("INQUIRY_TARGET_INCOMPLETE");
      expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    }
  });
});
function acceptedTarget(overrides: Partial<InquiryAcceptedTarget> = {}): InquiryAcceptedTarget {
  return {
    targetRef: "target-one",
    source: { kind: "semantic", taskRef: "task-one" },
    sourceQuestion: "六月末测试机构收入",
    metrics: { codes: ["M2"], names: ["测试收入"] },
    organizations: { codes: ["3212"], names: ["测试机构"] },
    time: { start: "2026-06-30", end: "2026-06-30" },
    pending: [],
    ...overrides,
  };
}
function priorBatch(code: "M1" | "M2", date: string, org = "3209"): AgentMessage {
  return {
    role: "toolResult",
    toolName: "metric_query",
    toolCallId: `old-${code}`,
    content: [],
    isError: false,
    timestamp: 0,
    details: evidence({
      run_ref: `run-${code}`,
      execution_turn_id: "previous-op",
      analysis_date: date,
      org_codes: [org],
      metric_descriptors: [code === "M1" ? descriptor : secondDescriptor],
      evidence_items: [
        {
          ref: `fact-${code}`,
          type: "fact",
          metric_code: code,
          org_code: org,
          date,
          unit: "元",
          value: "100",
          display: "100元",
        },
      ],
    }),
  };
}
function mixedPrior() {
  return fixture([
    { role: "user", content: "分别看余额和收入", timestamp: 0 },
    priorBatch("M1", "2026-08-27"),
    priorBatch("M2", "2026-07-31"),
    { role: "user", content: "换到另一机构看看", timestamp: 1 },
  ]);
}
async function discoverBoth(f: ReturnType<typeof fixture>) {
  f.backend.analysisCatalog.mockResolvedValueOnce({
    items: [descriptor, secondDescriptor],
    total: 2,
    page: 1,
    page_size: 12,
  });
  await f.call("metric_search", { keywords: ["余额和收入"] });
}
function legacyQuery(extra: Record<string, unknown> = {}): AgentMessage {
  const receipt = {
    status: "succeeded",
    task_id: "legacy-task",
    result_id: "legacy-result",
    version: 1,
    query_evidence: {
      logical_dsl: { metrics: ["M1"], orgs: ["3212"], time: { preset: "latest" } },
      query_dates: { complete: true, actual_dates: ["2026-06-30"], uniform_date: "2026-06-30" },
    },
    ...extra,
  };
  return {
    role: "toolResult",
    toolName: "metric_query_structured",
    toolCallId: "legacy",
    isError: false,
    timestamp: 0,
    content: [{ type: "text", text: JSON.stringify(receipt) }],
    details: {
      kind: "metric_query_structured",
      status: "succeeded",
      task_id: "legacy-task",
      result_id: "legacy-result",
    },
  };
}

describe("inquiry direct query tools", () => {
  function largeTarget(count: number) {
    const f = fixture();
    const codes = Array.from(
      { length: count },
      (_, index) => `M${String(index + 1).padStart(3, "0")}`,
    );
    f.request.inquiryAdmission = {
      targets: [acceptedTarget({ metrics: { codes, names: codes }, operation: { kind: "value" } })],
      answerReceipts: [],
    };
    f.backend.analysisCatalog.mockImplementation((code) =>
      Promise.resolve({ items: [{ ...descriptor, code, binding_ref: `signed:${code}` }] }),
    );
    f.backend.analysisExecute.mockImplementation((payload, key) => {
      const plan = payload.plan as { steps: Array<{ metric_refs: string[] }> };
      if (
        plan.steps.some((step) => step.metric_refs.length > 12) ||
        new Set(plan.steps.flatMap((step) => step.metric_refs)).size > 32
      )
        return Promise.reject(new BackendApiError(422, "超过后端单批上限", "INVALID_PLAN"));
      return Promise.resolve(
        evidence({
          run_ref: `analysis:${key}`,
          plan,
          metric_descriptors: plan.steps.flatMap((step) =>
            step.metric_refs.map((ref) => ({
              ...descriptor,
              code: ref.slice(7),
              binding_ref: ref,
            })),
          ),
        }),
      );
    });
    return { ...f, codes };
  }

  async function ordinaryBatch(count: number) {
    const f = largeTarget(count);
    delete f.request.inquiryAdmission;
    for (let offset = 0; offset < f.codes.length; offset += 8)
      await f.call("metric_search", { keywords: f.codes.slice(offset, offset + 8) });
    const input = {
      ...query,
      date: "2026-07-31",
      metric_refs: f.codes.map((_, index) => `k${index + 1}`),
    };
    const tool = createInquiryQueryTools().find((item) => item.name === "metric_query")!;
    const invoke = () => {
      validateToolArguments(tool, {
        type: "toolCall",
        name: tool.name,
        id: "batch",
        arguments: input,
      });
      return f.call("metric_query", input);
    };
    return { ...f, input, invoke };
  }

  it.each([9, 33])("普通%d指标通过原生schema后按单步12/单批32完整取数", async (count) => {
    const f = await ordinaryBatch(count);
    const result = await f.invoke();
    expect(result.isError).not.toBe(true);
    const plans = f.backend.analysisExecute.mock.calls.map(
      ([payload]) => payload.plan as { steps: Array<{ metric_refs: string[] }> },
    );
    expect(plans).toHaveLength(Math.ceil(count / 32));
    expect(plans.flatMap((plan) => plan.steps).every((step) => step.metric_refs.length <= 12)).toBe(
      true,
    );
    expect(plans.flatMap((plan) => plan.steps.flatMap((step) => step.metric_refs)).sort()).toEqual(
      f.codes.map((code) => `signed:${code}`).sort(),
    );
    if (count > 32)
      expect(result.details.query_progress).toMatchObject({
        requested_metric_codes: f.codes,
        completed_metric_codes: f.codes,
        pending_metric_codes: [],
      });
  });

  it("重复多批查询说明仅复用已有引用，不签发新的证据别名", async () => {
    const f = await ordinaryBatch(33);
    await f.invoke();
    const repeated = await f.invoke();
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
    expect(repeated.details).toMatchObject({
      reused: true,
      no_new_evidence: true,
      evidence_refs: ["e1", "e2"],
      results: [],
    });
    expect(JSON.parse(repeated.content[0].text)).toMatchObject({
      reused: true,
      no_new_evidence: true,
      evidence_refs: ["e1", "e2"],
    });
    expect(currentTurnEvidence(f.messages)).toHaveLength(2);
  });
  it("普通101指标在原生schema边界拒绝，不进入查询执行器", async () => {
    const f = await ordinaryBatch(101);
    expect(() => f.invoke()).toThrow();
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });
  it("普通多批查询部分失败时准确列出已完成指标，恢复只补失败批次", async () => {
    const f = await ordinaryBatch(33);
    const execute = f.backend.analysisExecute.getMockImplementation()!;
    f.backend.analysisExecute
      .mockImplementationOnce(execute)
      .mockRejectedValueOnce(new BackendApiError(503, "unavailable", "SERVICE_UNAVAILABLE"));
    const partial = await f.invoke();
    expect(partial.details).toMatchObject({
      status: "partial",
      query_progress: {
        completed_metric_codes: f.codes.slice(0, 32),
        pending_metric_codes: f.codes.slice(32),
      },
    });
    const resumed = await f.invoke();
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(3);
    expect(resumed.details).toMatchObject({
      status: "succeeded",
      query_progress: { completed_metric_codes: f.codes, pending_metric_codes: [] },
    });
  });

  it.each([13, 100])(
    "已确认%d指标在既有单步12/单批32边界内完整执行，不允许模型缩减",
    async (count) => {
      const f = largeTarget(count);
      const result = await f.call("metric_query", {
        ...query,
        metric_refs: ["forged"],
        method: "structure",
        relation_id: "forged",
      });
      expect(f.backend.analysisExecute).toHaveBeenCalledTimes(Math.ceil(count / 32));
      const plans = f.backend.analysisExecute.mock.calls.map(
        ([payload]) => payload.plan as { steps: Array<{ method: string; metric_refs: string[] }> },
      );
      expect(
        plans
          .flatMap((plan) => plan.steps)
          .every((step) => step.method === "observe" && step.metric_refs.length <= 12),
      ).toBe(true);
      expect(
        plans.flatMap((plan) => plan.steps.flatMap((step) => step.metric_refs)).sort(),
      ).toEqual(f.codes.map((code) => `signed:${code}`).sort());
      expect(businessEvidences(result.details)).toHaveLength(Math.ceil(count / 32));
      expect(
        new Set(
          businessEvidences(result.details).map((item) => (item as { run_ref?: string }).run_ref),
        ).size,
      ).toBe(Math.ceil(count / 32));
      expect(result.details.status).toBe("succeeded");
      if (count === 100) {
        const body = JSON.parse(result.content[0].text) as {
          results: Array<{ run_ref: string; evidence_ref: string }>;
          query_progress: unknown;
        };
        expect(body.results.map((item) => item.evidence_ref)).toEqual(["e1", "e2", "e3", "e4"]);
        const projected = projectInquiryMessages(f.messages).at(-1)!;
        expect(projected.role).toBe("toolResult");
        if (projected.role === "toolResult")
          expect(
            JSON.parse(
              projected.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
            ),
          ).toMatchObject(body);
        f.backend.analysisEvidence.mockImplementation((runRef) =>
          Promise.resolve(evidence({ run_ref: runRef })),
        );
        for (const item of [body.results[0]!, body.results[3]!]) {
          expect((await f.call("analysis_read", { run_ref: item.run_ref })).details.kind).toBe(
            "inquiry_query_reuse",
          );
        }
      }
      await f.call("metric_query", {
        ...query,
        independent: true,
        metric_refs: ["k1"],
        date: "2026-06-30",
      });
      expect(f.backend.analysisExecute).toHaveBeenCalledTimes(Math.ceil(count / 32) + 1);
    },
  );

  it("纯点击使用冻结来源问题满足计划与计算上下文非空契约", async () => {
    const f = largeTarget(1);
    f.request.originalMessage = "";
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { requirements: [{ question: "六月末测试机构收入" }] },
      calculation_context: { user_question: "六月末测试机构收入" },
    });
    expect(f.request.originalMessage).toBe("");
  });

  it("仍保留旧目标100指标上限，超限先拒绝而不批量访问目录", async () => {
    const f = largeTarget(101);
    expect((await f.call("metric_query", query)).details.code).toBe("INQUIRY_TARGET_METRIC_LIMIT");
    expect(f.backend.analysisCatalog).not.toHaveBeenCalled();
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("100指标目录重绑定最多同时发出8个读取请求", async () => {
    const f = largeTarget(100);
    const catalog = f.backend.analysisCatalog.getMockImplementation()!;
    let active = 0,
      maximum = 0;
    f.backend.analysisCatalog.mockImplementation(async (...args) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await catalog(...args);
      } finally {
        active--;
      }
    });
    await f.call("metric_query", query);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(f.backend.analysisCatalog).toHaveBeenCalledTimes(100);
  });

  it.each([401, 403, "abort"] as const)("多批期间%s保持原鉴权或取消出口", async (reason) => {
    const f = largeTarget(100),
      controller = new AbortController();
    const execute = f.backend.analysisExecute.getMockImplementation()!;
    const failure =
      reason === "abort"
        ? new DOMException("已取消", "AbortError")
        : new BackendApiError(reason, "内部权限信息");
    let calls = 0;
    f.backend.analysisExecute.mockImplementation((...args) => {
      if (++calls !== 2) return execute(...args);
      if (reason === "abort") controller.abort();
      return Promise.reject(failure);
    });
    await expect(
      runTool(
        createInquiryQueryTools().find((tool) => tool.name === "metric_query")!,
        query,
        f.request,
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toBe(failure);
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(2);
  });

  it("多批未知异常保留已有证据及受控诊断，不公开内部错误文本", async () => {
    const f = largeTarget(100),
      execute = f.backend.analysisExecute.getMockImplementation()!;
    let calls = 0;
    f.backend.analysisExecute.mockImplementation((...args) =>
      ++calls === 2 ? Promise.reject(new TypeError("内部请求 secret-org")) : execute(...args),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await f.call("metric_query", query);
      expect(result.details.status).toBe("partial");
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toContain("TypeError");
      expect(JSON.stringify([result, log.mock.calls])).not.toContain("secret-org");
    } finally {
      log.mockRestore();
    }
  });

  it("多批部分失败保留成功证据，恢复只补未完成批次且目标完成前禁止独立补查", async () => {
    const f = largeTarget(100);
    const execute = f.backend.analysisExecute.getMockImplementation()!;
    let attempts = 0;
    f.backend.analysisExecute.mockImplementation((...args) =>
      ++attempts === 2
        ? Promise.reject(new BackendApiError(503, "暂时不可用", "TEMPORARY_FAILURE"))
        : execute(...args),
    );
    const partial = await f.call("metric_query", query);
    expect(partial.details.status).toBe("partial");
    expect(partial.isError).not.toBe(true);
    expect(businessEvidences(partial.details).map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
    ]);
    expect((await f.call("metric_query", { ...query, independent: true })).details.code).toBe(
      "INQUIRY_TARGET_INCOMPLETE",
    );
    const failedKey = f.backend.analysisExecute.mock.calls[1]![1];
    const resumed = largeTarget(100);
    resumed.messages.push(...f.messages);
    const complete = await resumed.call("metric_query", query);
    expect(complete.details.status).toBe("succeeded");
    expect(resumed.backend.analysisExecute).toHaveBeenCalledTimes(3);
    expect(resumed.backend.analysisExecute.mock.calls[0]![1]).toBe(failedKey);
    expect(
      currentTurnEvidence(resumed.messages).filter((item) => item.evidence.status === "succeeded"),
    ).toHaveLength(4);
    await resumed.call("metric_query", query);
    expect(resumed.backend.analysisExecute).toHaveBeenCalledTimes(3);
    await resumed.call("metric_query", { ...query, independent: true, date: "2026-06-30" });
    expect(resumed.backend.analysisExecute).toHaveBeenCalledTimes(4);
  });

  it.each([
    [{ kind: "value" } as const, { method: "observe" }],
    [
      { kind: "ranking", position: "bottom", top_n: 5 } as const,
      { method: "ranking", position: "bottom", top_n: 5 },
    ],
    [{ kind: "rank_position" } as const, { method: "ranking", position: "top", top_n: 2 }],
  ])("旧已确认操作%s覆盖模型方法和排名参数", async (operation, expected) => {
    const f = largeTarget(1);
    f.request.inquiryAdmission!.targets[0]!.operation = operation;
    if (operation.kind === "rank_position") {
      f.request.inquiryAdmission!.targets[0]!.comparisonOrganizations = {
        codes: ["3212", "3213"],
        names: ["甲", "乙"],
      };
    }
    await f.call("metric_query", {
      ...query,
      method: "structure",
      relation_id: "forged",
      comparisons: ["yoy"],
      position: "top",
      top_n: 1,
    });
    const plan = f.backend.analysisExecute.mock.calls[0]![0].plan as {
      steps: Record<string, unknown>[];
    };
    expect(plan.steps[0]).toMatchObject(expected);
    expect(plan.steps[0]).not.toHaveProperty("relation_id");
    expect(plan.steps[0]).not.toHaveProperty("comparisons");
  });

  it("未绑定旧操作的大型结构分析不能拆开完整关系", async () => {
    const f = largeTarget(13);
    delete f.request.inquiryAdmission!.targets[0]!.operation;
    const result = await f.call("metric_query", {
      ...query,
      method: "structure",
      relation_id: "relation",
    });
    expect(result.details.code).toBe("ANALYSIS_METHOD_BATCH_UNSUPPORTED");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("单个已接纳目标优先于模型改写，正式指标重新取得当前绑定并保存真实执行条件", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = { targets: [acceptedTarget()], answerReceipts: [] };
    f.backend.analysisCatalog.mockResolvedValue({
      items: [{ ...secondDescriptor, binding_ref: "signed:M2:fresh" }],
      total: 1,
      page: 1,
      page_size: 12,
    });
    const result = await f.call("metric_query", { ...query, date: "latest" });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3212"],
      date_selection: "exact",
      start: "2026-06-30",
      end: "2026-06-30",
      plan: { steps: [{ metric_refs: ["signed:M2:fresh"] }] },
    });
    expect(result.details.inquiry_target).toMatchObject({
      target_ref: "target-one",
      source: { kind: "semantic", taskRef: "task-one" },
      metric_codes: ["M2"],
      metric_refs: ["signed:M2:fresh"],
      organizations: { codes: ["3212"] },
      time: { date_selection: "exact", start: "2026-06-30", end: "2026-06-30" },
    });
    expect(f.resolveDate).not.toHaveBeenCalled();
  });

  it("点击时间覆盖优先于已接纳目标旧时间，同时保留旧区间选择", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [
        acceptedTarget({
          metrics: { codes: ["M1"], names: ["测试余额"] },
          time: { start: "2024-01-01", end: "2026-08-31", record_selection: "all_in_range" },
        }),
      ],
      answerReceipts: [],
    };
    f.request.timeOverride = { start: "2023-01-01", end: "2025-12-31" };
    await f.call("metric_query", { ...query, date: "latest" });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      date_selection: "all_in_range",
      start: "2023-01-01",
      end: "2025-12-31",
    });
  });

  it("宿主明确时间覆盖可补齐目标待定期间，但不能补齐其他未决字段", async () => {
    const f = fixture();
    await discoverBoth(f);
    const target = acceptedTarget({
      metrics: { codes: ["M1"], names: ["测试余额"] },
      pending: [{ field: "time", reason: "unresolved" }],
    });
    f.request.inquiryAdmission = { targets: [target], answerReceipts: [] };
    f.request.timeOverride = { start: "2026-05-31", end: "2026-05-31" };
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      start: "2026-05-31",
      end: "2026-05-31",
    });
    target.pending.push({ field: "metrics", reason: "declined" });
    expect((await f.call("metric_query", query)).details.code).toBe("INQUIRY_TARGET_UNRESOLVED");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
  });

  it.each(["metrics", "organizations", "comparison_organizations", "time"] as const)(
    "已接纳目标的%s被拒绝或未决时不按模型值执行",
    async (field) => {
      const f = fixture();
      await discoverBoth(f);
      f.request.inquiryAdmission = {
        targets: [acceptedTarget({ pending: [{ field, reason: "declined" }] })],
        answerReceipts: [],
      };
      const result = await f.call("metric_query", { ...query, date: "latest" });
      expect(result).toMatchObject({
        isError: true,
        details: { code: "INQUIRY_TARGET_UNRESOLVED" },
      });
      expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    },
  );

  it("多目标必须明确target_ref且不能把目录中其他指标用于已选目标", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [
        acceptedTarget(),
        acceptedTarget({
          targetRef: "target-two",
          metrics: { codes: ["M1"], names: ["测试余额"] },
        }),
      ],
      answerReceipts: [],
    };
    expect((await f.call("metric_query", query)).details.code).toBe("INQUIRY_TARGET_REQUIRED");
    expect((await f.call("metric_query", { ...query, target_ref: "forged" })).details.code).toBe(
      "INQUIRY_TARGET_INVALID",
    );
    f.backend.analysisCatalog.mockResolvedValue({
      items: [descriptor],
      total: 1,
      page: 1,
      page_size: 12,
    });
    expect(
      (await f.call("metric_query", { ...query, target_ref: "target-one" })).details.code,
    ).toBe("INQUIRY_TARGET_METRIC_UNAVAILABLE");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    await f.call("metric_query", { ...query, target_ref: "target-two" });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { steps: [{ metric_refs: ["signed:M1"] }] },
    });
  });

  it("已确认机构重新解析失权或换成其他机构时停止，不能回到账号机构", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [acceptedTarget({ metrics: { codes: ["M1"], names: ["测试余额"] } })],
      answerReceipts: [],
    };
    f.resolveOrganizations.mockResolvedValue({
      status: "resolved",
      value: { codes: ["3200"], names: ["账号机构"] },
    });
    expect((await f.call("metric_query", query)).details.code).toBe("INQUIRY_TARGET_SCOPE_CHANGED");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    f.resolveOrganizations.mockRejectedValue(
      new BackendApiError(403, "无权", "ORG_SCOPE_FORBIDDEN"),
    );
    await expect(f.call("metric_query", query)).rejects.toMatchObject({ status: 403 });
  });

  it("独立补查须先完成所有已接纳目标，成功回执恢复后可显式离开原目标", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [acceptedTarget({ metrics: { codes: ["M1"], names: ["测试余额"] } })],
      answerReceipts: [],
    };
    expect((await f.call("metric_query", { ...query, independent: true })).details.code).toBe(
      "INQUIRY_TARGET_INCOMPLETE",
    );
    await f.call("metric_query", query);
    const resumed = fixture([...f.messages]);
    resumed.request.inquiryAdmission = f.request.inquiryAdmission;
    await resumed.call("metric_query", { ...query, independent: true, date: "2026-07-31" });
    expect(resumed.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3200"],
      start: "2026-07-31",
    });
  });

  it("相同查询条件的不同接纳目标分别记录完成，不能因查询复用漏掉目标", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [
        acceptedTarget({ metrics: { codes: ["M1"], names: ["测试余额"] } }),
        acceptedTarget({
          targetRef: "target-two",
          metrics: { codes: ["M1"], names: ["测试余额"] },
        }),
      ],
      answerReceipts: [],
    };
    await f.call("metric_query", { ...query, target_ref: "target-one" });
    expect((await f.call("metric_query", { ...query, independent: true })).details.code).toBe(
      "INQUIRY_TARGET_INCOMPLETE",
    );
    const second = await f.call("metric_query", { ...query, target_ref: "target-two" });
    expect(second.details.inquiry_target).toMatchObject({ target_ref: "target-two" });
    expect(
      (await f.call("metric_query", { ...query, independent: true, date: "2026-07-31" })).isError,
    ).not.toBe(true);
  });

  it("日期覆盖绑定已接纳指标机构但可查看全部日期，不能当作目标取数完成", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [acceptedTarget({ metrics: { codes: ["M1"], names: ["测试余额"] } })],
      answerReceipts: [],
    };
    const result = await f.call("metric_availability", {
      metric_refs: ["k2"],
      scope: "named",
      org_names: ["3200"],
    });
    expect(f.backend.dataAvailability.mock.calls[0]![0]).toMatchObject({
      metric_codes: ["M1"],
      org_codes: ["3212"],
    });
    expect(f.backend.dataAvailability.mock.calls[0]![0]).not.toHaveProperty("start");
    expect(result.details.inquiry_target).toMatchObject({
      target_ref: "target-one",
      time: { start: "2026-06-30", end: "2026-06-30" },
    });
    expect((await f.call("metric_query", { ...query, independent: true })).details.code).toBe(
      "INQUIRY_TARGET_INCOMPLETE",
    );
    expect(
      (
        await f.call("metric_availability", {
          metric_refs: ["k2"],
          scope: "named",
          org_names: ["3200"],
          independent: true,
        })
      ).details.code,
    ).toBe("INQUIRY_TARGET_INCOMPLETE");
  });

  it("目标日期尚未确定时可查看已确认指标机构的日期覆盖，但不能直接取数", async () => {
    const f = fixture();
    await discoverBoth(f);
    const target = acceptedTarget({
      metrics: { codes: ["M1"], names: ["测试余额"] },
      pending: [{ field: "time", reason: "unresolved" }],
    });
    delete target.time;
    f.request.inquiryAdmission = { targets: [target], answerReceipts: [] };
    const coverage = await f.call("metric_availability", {
      metric_refs: ["k2"],
      scope: "named",
      org_names: ["3200"],
    });
    expect(coverage.isError).not.toBe(true);
    expect(f.backend.dataAvailability.mock.calls[0]?.[0]).toMatchObject({
      metric_codes: ["M1"],
      org_codes: ["3212"],
    });
    expect((await f.call("metric_query", query)).details.code).toBe("INQUIRY_TARGET_UNRESOLVED");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    target.pending.push({ field: "organizations", reason: "declined" });
    expect(
      (
        await f.call("metric_availability", {
          metric_refs: ["k1"],
          scope: "named",
          org_names: ["3200"],
        })
      ).details.code,
    ).toBe("INQUIRY_TARGET_UNRESOLVED");
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(1);
  });

  it("已接纳动态机构集合重新取得当前成员和权限签名，不复用旧成员快照", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [
        acceptedTarget({
          metrics: { codes: ["M1"], names: ["测试余额"] },
          organizations: {
            codes: ["old-member"],
            names: ["历史成员"],
            scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
          },
        }),
      ],
      answerReceipts: [],
    };
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: [],
      organization_scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
      scope_fingerprint: "scope-token",
    });
    expect(f.resolveOrganizations).not.toHaveBeenCalled();
  });

  it("已确认排名目标保留主机构与比较范围，其他方法不能提前标记完成", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.request.inquiryAdmission = {
      targets: [
        acceptedTarget({
          metrics: { codes: ["M1"], names: ["测试余额"] },
          organizations: { codes: ["3200"], names: ["测试机构"] },
          comparisonOrganizations: {
            codes: ["3200", "3201"],
            names: ["测试机构", "测试分行"],
            scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
          },
        }),
      ],
      answerReceipts: [],
    };
    expect((await f.call("metric_query", query)).details.code).toBe(
      "INQUIRY_TARGET_METHOD_REQUIRED",
    );
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    const result = await f.call("metric_query", {
      ...query,
      method: "ranking",
      top_n: 1,
      position: "bottom",
    });
    expect(result.details.inquiry_target).toMatchObject({
      target_organizations: { codes: ["3200"] },
      organizations: { codes: ["3200", "3201"] },
      comparison_organizations: { codes: ["3200", "3201"] },
    });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { steps: [{ method: "ranking", top_n: 2 }] },
      organization_scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
    });
  });

  it("旧回合的已接纳目标回执不能开放本轮独立补查", async () => {
    const f = fixture([
      {
        ...priorBatch("M1", "2026-08-27"),
        details: evidence({
          execution_turn_id: "old-operation",
          inquiry_target: { target_ref: "target-one" },
        }),
      } as AgentMessage,
    ]);
    f.request.inquiryAdmission = { targets: [acceptedTarget()], answerReceipts: [] };
    expect((await f.call("metric_query", { ...query, independent: true })).details.code).toBe(
      "INQUIRY_TARGET_INCOMPLETE",
    );
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("同次查询只读取一次授权历史，后续调用仍能看到新增回执", async () => {
    const f = fixture();
    await f.call("metric_search", { keywords: ["余额"] });
    const messages = vi.fn(() => Promise.resolve([...f.messages]));
    f.request.turnMessages = messages;
    await f.call("metric_query", { ...query, date: "2026-07-31" });
    expect(messages).toHaveBeenCalledTimes(1);
    const repeated = await f.call("metric_query", { ...query, date: "2026-07-31" });
    expect(messages).toHaveBeenCalledTimes(2);
    expect(repeated.details).toMatchObject({ reused: true, evidence_ref: "e1" });
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
  });

  it("近期上下文之外的当前分支历史运行可重新授权读取，不重新查询", async () => {
    const f = fixture();
    await f.bridge.setConversationId("conv-1");
    const analysisSource = vi.fn(() =>
      Promise.resolve({ run_ref: "analysis:old", scope_id: "old-op" }),
    );
    f.request.history = { ...f.request.history, analysisSource };
    f.backend.analysisEvidence.mockResolvedValue(
      evidence({ run_ref: "analysis:old", scope_id: "old-op" }),
    );
    const result = await f.call("analysis_read", { run_ref: "analysis:old" });
    expect(analysisSource).toHaveBeenCalledWith("analysis:old");
    expect(f.backend.analysisEvidence).toHaveBeenCalledWith(
      "analysis:old",
      "conv-1",
      expect.any(Object),
    );
    expect(result.details).toMatchObject({
      run_ref: "analysis:old",
      result_reused: true,
      execution_turn_id: "old-op",
    });
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("历史接口未找到当前分支来源时不能读取猜测的运行", async () => {
    const f = fixture();
    await f.bridge.setConversationId("conv-1");
    f.request.history = {
      ...f.request.history,
      analysisSource: vi.fn(() => Promise.resolve(null)),
    };
    const result = await f.call("analysis_read", { run_ref: "other-branch" });
    expect(result).toMatchObject({ isError: true, details: { code: "ANALYSIS_RUN_NOT_FOUND" } });
    expect(f.backend.analysisEvidence).not.toHaveBeenCalled();
  });

  it("较早历史权限失效时停止读取，不从账号条件重新查询", async () => {
    const f = fixture();
    await f.bridge.setConversationId("conv-1");
    const forbidden = new BackendApiError(403, "历史来源已撤权", "FORBIDDEN");
    f.request.history = {
      ...f.request.history,
      analysisSource: vi.fn(() => Promise.reject(forbidden)),
    };
    await expect(f.call("analysis_read", { run_ref: "analysis:old" })).rejects.toBe(forbidden);
    expect(f.backend.analysisEvidence).not.toHaveBeenCalled();
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it.each(["catalog_only", "approved"])(
    "检索结果保留正式口径审核状态与限制（%s）",
    async (status) => {
      const f = fixture();
      const candidate = {
        ...descriptor,
        semantic_status: status,
        semantic_source: "已维护目录",
        limitations: ["统计频率未审核，不能把取值差异当作单月发生额。"],
        description: "期末余额",
        value_basis: "当日数",
        metadata_version: "internal-version",
      };
      f.backend.analysisCatalog.mockResolvedValue({
        items: [candidate],
        total: 1,
        page: 1,
        page_size: 12,
      });
      const result = await f.call("metric_search", { keywords: ["余额", "规模"] });
      const view = JSON.parse(result.content[0].text) as { items: unknown[]; results: unknown };
      expect(view.items).toEqual([
        expect.objectContaining({
          binding_ref: "k1",
          code: "M1",
          semantic_status: status,
          semantic_source: candidate.semantic_source,
          limitations: candidate.limitations,
          description: candidate.description,
          value_basis: candidate.value_basis,
        }),
      ]);
      expect(view.items[0]).not.toHaveProperty("metadata_version");
      expect(JSON.stringify(view)).not.toContain("signed:M1");
      expect(view.results).toHaveLength(2);
      await f.call("metric_query", query);
      expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
        plan: { steps: [expect.objectContaining({ metric_refs: ["signed:M1"] })] },
      });
    },
  );

  it.each([false, true])(
    "同一指标按本次机构恢复日期，不受其他机构最后查询影响（顺序反转=%s）",
    async (reverse) => {
      const history = [
        priorBatch("M1", "2026-08-27", "3208"),
        priorBatch("M1", "2026-07-31", "3209"),
      ];
      const f = fixture([
        ...(reverse ? history.reverse() : history),
        { role: "user", content: "甲行同比呢", timestamp: 1 },
      ]);
      await discoverBoth(f);
      await f.call("metric_query", { ...query, org_names: ["3208"] });
      expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
        org_codes: ["3208"],
        start: "2026-08-27",
        end: "2026-08-27",
      });
    },
  );

  it.each([false, true])(
    "多机构不同期间按机构与指标分组，不制造交叉条件（同回执=%s）",
    async (combined) => {
      const left = priorBatch("M1", "2026-08-27", "3208"),
        right = priorBatch("M1", "2026-07-31", "3209");
      if (left.role !== "toolResult" || right.role !== "toolResult")
        throw new Error("invalid fixture");
      const history = combined
        ? [
            {
              ...left,
              details: evidence({
                org_codes: ["3208", "3209"],
                analysis_date: null,
                actual_dates: ["2026-08-27", "2026-07-31"],
                evidence_items: [
                  {
                    ref: "a",
                    type: "fact",
                    metric_code: "M1",
                    org_code: "3208",
                    date: "2026-08-27",
                  },
                  {
                    ref: "b",
                    type: "fact",
                    metric_code: "M1",
                    org_code: "3209",
                    date: "2026-07-31",
                  },
                ],
              }),
            },
          ]
        : [left, right];
      const f = fixture([...history, { role: "user", content: "两家同比呢", timestamp: 1 }]);
      await discoverBoth(f);
      const result = await f.call("metric_query", { ...query, org_names: ["3208", "3209"] });
      expect(result.details.code).toBe("ANALYSIS_DATE_GROUPS_REQUIRED");
      expect(
        (JSON.parse(result.content[0].text) as { resolution: { date_groups: unknown } }).resolution
          .date_groups,
      ).toEqual([
        { metric_refs: ["k1"], org_codes: ["3208"], date: "2026-08-27" },
        { metric_refs: ["k1"], org_codes: ["3209"], date: "2026-07-31" },
      ]);
      expect(f.backend.analysisExecute).not.toHaveBeenCalled();
      await f.call("metric_query", { ...query, org_names: ["3208", "3209"], date: "7月末" });
      expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
        org_codes: ["3208", "3209"],
        start: "2026-07-31",
      });
    },
  );

  it("切换未查过的机构时不能从同指标多个期间任取最后一个", async () => {
    const f = fixture([
      priorBatch("M1", "2026-08-27", "3208"),
      priorBatch("M1", "2026-07-31", "3209"),
      { role: "user", content: "丙行的呢", timestamp: 1 },
    ]);
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, org_names: ["3210"] });
    expect(result.details.code).toBe("ANALYSIS_CONTEXT_UNAVAILABLE");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("本轮补查其他机构后仍按所选机构的最近期间恢复", async () => {
    const f = fixture([
      priorBatch("M1", "2026-08-27", "3208"),
      { role: "user", content: "分别看看", timestamp: 1 },
      priorBatch("M1", "2026-07-31", "3209"),
    ]);
    await discoverBoth(f);
    await f.call("metric_query", { ...query, org_names: ["3208"] });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3208"],
      start: "2026-08-27",
    });
  });

  it.each([
    ["3209", "3208"],
    ["3208", "3209"],
  ])("本轮原文共同日期优先于各机构旧日期，批次顺序%j", async (...orgs) => {
    const f = fixture([
      priorBatch("M1", "2026-08-27", "3208"),
      { role: "user", content: "甲乙都看7月末", timestamp: 1 },
    ]);
    f.request.originalMessage = "甲乙两行都看2026年7月末的余额";
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2026-07-31", end: "2026-07-31" },
      metadata: {
        source_calendar: { ranges: [{ start: "2026-07-31", end: "2026-07-31" }], unresolved: [] },
      },
    });
    f.backend.analysisExecute.mockImplementation((spec) =>
      Promise.resolve(
        evidence({
          org_codes: spec.org_codes,
          analysis_date: "2026-07-31",
          evidence_items: [
            {
              ref: "value",
              type: "fact",
              metric_code: "M1",
              org_code: (spec.org_codes as string[])[0],
              date: "2026-07-31",
            },
          ],
        }),
      ),
    );
    await discoverBoth(f);
    for (const org of orgs) await f.call("metric_query", { ...query, org_names: [org] });
    expect(f.backend.analysisExecute.mock.calls).toHaveLength(2);
    expect(f.backend.analysisExecute.mock.calls.map((call) => call[0].start)).toEqual([
      "2026-07-31",
      "2026-07-31",
    ]);
  });

  it.each(["institution", "metric"])(
    "旧完整回执缺少目标%s时，不能使用其他目标的全局日期",
    async (missing) => {
      const f = fixture([
        legacyQuery({
          query_evidence: {
            logical_dsl: {
              metrics: ["M1", "M2"],
              orgs: ["3208", "3209"],
              time: { preset: "latest" },
            },
            query_dates: { complete: true, actual_dates: ["2026-08-27"] },
          },
          facts: [{ metric_code: "M1", org_code: "3208", date: "2026-08-27" }],
          fact_count: 1,
          facts_truncated: false,
        }),
        { role: "user", content: "继续看", timestamp: 1 },
      ]);
      await discoverBoth(f);
      const result = await f.call("metric_query", {
        ...query,
        metric_refs: [missing === "metric" ? "k2" : "k1"],
        org_names: [missing === "institution" ? "3209" : "3208"],
      });
      expect(result.details.code).toBe("ANALYSIS_CONTEXT_UNAVAILABLE");
      expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    },
  );

  it("旧完整事实同指标跨机构也保留日期对应，截断事实不推断", async () => {
    const facts = [
      { metric_code: "M1", org_code: "3208", date: "2026-08-27" },
      { metric_code: "M1", org_code: "3209", date: "2026-07-31" },
    ];
    for (const truncated of [false, true]) {
      const f = fixture([
        legacyQuery({
          query_evidence: { logical_dsl: { metrics: ["M1"], orgs: ["3208", "3209"] } },
          facts,
          fact_count: truncated ? 20 : 2,
          facts_truncated: truncated,
        }),
        { role: "user", content: "甲行同比呢", timestamp: 1 },
      ]);
      await discoverBoth(f);
      const result = await f.call("metric_query", { ...query, org_names: ["3208"] });
      if (truncated) {
        expect(result.details.code).toBe("ANALYSIS_CONTEXT_UNAVAILABLE");
        expect(f.backend.analysisExecute).not.toHaveBeenCalled();
      } else
        expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
          org_codes: ["3208"],
          start: "2026-08-27",
        });
    }
  });

  it("多机构同比回执的比较基期不覆盖本次观测日", async () => {
    const facts = [
      {
        metric_name: "余额",
        org_name: "甲行",
        org_code: "3208",
        date: "2026-08-27",
        value_role: "分析时点",
      },
      {
        metric_name: "余额",
        org_name: "甲行",
        org_code: "3208",
        date: "2025-08-27",
        value_role: "比较基期",
      },
      {
        metric_name: "余额",
        org_name: "乙行",
        org_code: "3209",
        date: "2026-07-31",
        value_role: "分析时点",
      },
    ];
    const previous = priorBatch("M1", "2026-08-27", "3208");
    if (previous.role !== "toolResult") throw new Error("invalid fixture");
    previous.details = evidence({
      org_codes: ["3208", "3209"],
      actual_dates: ["2026-08-27", "2026-07-31"],
      rows: facts.map((fact) => ({ ...fact, stat_date: fact.date })),
      evidence_items: facts.map((fact, index) => ({
        ...fact,
        metric_code: "M1",
        type: "fact",
        ref: `v${index}`,
      })),
    });
    const f = fixture([previous, { role: "user", content: "甲行环比呢", timestamp: 1 }]);
    await discoverBoth(f);
    await f.call("metric_query", { ...query, org_names: ["3208"] });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      start: "2026-08-27",
      end: "2026-08-27",
    });
  });

  it("换主题的新指标不自动继承旧主题日期，模型可明确指定日期继续", async () => {
    const f = fixture([
      priorBatch("M1", "2026-08-27", "3208"),
      { role: "user", content: "现在看收入", timestamp: 1 },
    ]);
    await discoverBoth(f);
    expect(
      (await f.call("metric_query", { ...query, metric_refs: ["k2"], org_names: ["3208"] })).details
        .code,
    ).toBe("ANALYSIS_CONTEXT_UNAVAILABLE");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    await f.call("metric_query", {
      ...query,
      metric_refs: ["k2"],
      org_names: ["3208"],
      date: "7月末",
    });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({ start: "2026-07-31" });
  });

  it.each(["metric_query", "metric_availability"])(
    "%s 不再把 current 隐式解释为账号或历史机构",
    async (name) => {
      for (const initial of [
        [],
        [
          priorBatch("M1", "2026-08-27"),
          {
            role: "user",
            content: "改看另一家银行的贷款质量",
            timestamp: 1,
          } satisfies AgentMessage,
        ],
      ]) {
        const f = fixture(initial);
        f.request.originalMessage = "改看另一家银行的贷款质量";
        await f.call("metric_search", { keywords: ["余额"] });
        const result = await f.call(
          name,
          name === "metric_query"
            ? { ...query, scope: "current", org_names: undefined }
            : { metric_refs: ["k1"], scope: "current" },
        );
        expect(result.isError).toBe(true);
        expect(result.details.code).toBe("ANALYSIS_SCOPE_INVALID");
        expect(f.backend.analysisExecute).not.toHaveBeenCalled();
        expect(f.backend.dataAvailability).not.toHaveBeenCalled();
        expect(f.backend.resolveOrganizationScope).not.toHaveBeenCalled();
      }
    },
  );

  it("新工具协议只提供明确机构或授权农商行集合，避免继续建议 current", () => {
    for (const tool of createInquiryQueryTools().filter((tool) =>
      ["metric_query", "metric_availability"].includes(tool.name),
    )) {
      expect(JSON.stringify(tool.parameters)).not.toContain('"const":"current"');
    }
  });

  it.each(["metric_query", "metric_availability"])(
    "%s 修正旧 current 参数后工具可继续执行",
    async (name) => {
      const f = fixture();
      await discoverBoth(f);
      const input = name === "metric_query" ? query : { metric_refs: ["k1"] };
      expect(
        (await f.call(name, { ...input, scope: "current", org_names: undefined })).isError,
      ).toBe(true);
      const result = await f.call(name, { ...input, scope: "named", org_names: ["测试分行"] });
      expect(result.isError).not.toBe(true);
      const execute =
        name === "metric_query" ? f.backend.analysisExecute : f.backend.dataAvailability;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]![0]).toMatchObject({ org_codes: ["3201"] });
    },
  );

  it.each(["metric_query", "metric_availability"])(
    "%s 严格使用模型明确选择的机构，不受历史查询顺序影响",
    async (name) => {
      for (const orgs of [["3200"], ["3208"], ["3209"], ["3208", "3209"]]) {
        const f = fixture([
          priorBatch("M1", "2026-08-27", "3208"),
          priorBatch("M2", "2026-07-31", "3209"),
          { role: "user", content: "继续看余额", timestamp: 1 },
        ]);
        await discoverBoth(f);
        const input = name === "metric_query" ? query : { metric_refs: ["k1"] };
        expect(
          (await f.call(name, { ...input, scope: "named", org_names: orgs })).isError,
        ).not.toBe(true);
        const execute =
          name === "metric_query" ? f.backend.analysisExecute : f.backend.dataAvailability;
        expect(execute.mock.calls[0]![0]).toMatchObject({ org_codes: orgs });
        expect(f.resolveOrganizations).toHaveBeenCalledWith(orgs);
        if (name === "metric_query")
          expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
            start: "2026-08-27",
            end: "2026-08-27",
          });
      }
    },
  );

  it("同轮纠正或切换机构后，后续查询不被第一批机构覆盖", async () => {
    const f = fixture();
    await discoverBoth(f);
    await f.call("metric_query", query);
    await f.call("metric_query", { ...query, org_names: ["3201"] });
    await f.call("metric_query", {
      ...query,
      org_names: ["3201"],
      metric_refs: ["k2"],
      date: "7月末",
    });
    expect(f.backend.analysisExecute.mock.calls.map((call) => call[0].org_codes)).toEqual([
      ["3200"],
      ["3201"],
      ["3201"],
    ]);
  });

  it.each(["metric_query", "metric_availability"])(
    "%s 机构未决或失权时不替换成账号机构",
    async (name) => {
      const f = fixture();
      await discoverBoth(f);
      const input = { ...query, org_names: ["不可用机构"] };
      f.resolveOrganizations.mockResolvedValueOnce({ status: "not_found" });
      expect((await f.call(name, input)).details.code).toBe("ANALYSIS_SCOPE_UNRESOLVED");
      f.resolveOrganizations.mockRejectedValueOnce(new BackendApiError(403, "无权", "FORBIDDEN"));
      await expect(f.call(name, input)).rejects.toMatchObject({ status: 403 });
      expect(f.backend.analysisExecute).not.toHaveBeenCalled();
      expect(f.backend.dataAvailability).not.toHaveBeenCalled();
    },
  );

  it.each(["latest", "最新一期"])("最新数据策略%s直接查询，不绕路探测可用日期", async (date) => {
    const f = fixture();
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { preset: "latest" },
      metadata: { source_calendar: { ranges: [], unresolved: [] } },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", { ...query, date });
    expect(result.details).toMatchObject({ kind: "analysis_evidence", status: "succeeded" });
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      date_selection: "latest_snapshot",
    });
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).not.toHaveProperty("start");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
    expect(f.backend.dataAvailability).not.toHaveBeenCalled();
  });

  it("同轮最新主目标重复取数复用原请求，不因实际统计日生成新证据", async () => {
    const f = fixture();
    f.request.inquiryTargetContext = { version: 1 };
    f.resolveDate.mockResolvedValue({ status: "resolved", value: { preset: "latest" } });
    await f.call("metric_search", { keywords: ["余额"] });
    const first = await f.call("metric_query", {
      ...query,
      target_change: {
        mode: "new",
        topic: "余额",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
        date: "latest",
      },
    });
    const repeated = await f.call("metric_query", { ...query, purpose: "确认同一个余额" });
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
    expect(repeated.details).toMatchObject({
      kind: "inquiry_query_reuse",
      reused: true,
      no_new_evidence: true,
      evidence_ref: "e1",
      run_ref: first.details.run_ref,
    });
    expect(JSON.parse(repeated.content[0].text)).toMatchObject({
      reused: true,
      no_new_evidence: true,
      evidence_ref: "e1",
    });
    expect(currentTurnEvidence(f.messages)).toHaveLength(1);
  });

  it("旧协议省略日期沿用已查实际日时仍复用最新查询结果", async () => {
    const f = fixture();
    f.resolveDate.mockResolvedValue({ status: "resolved", value: { preset: "latest" } });
    await f.call("metric_search", { keywords: ["余额"] });
    const first = await f.call("metric_query", { ...query, date: "latest" });
    const repeated = await f.call("metric_query", query);
    expect(f.backend.analysisExecute).toHaveBeenCalledOnce();
    expect(first.details).toHaveProperty("resolved_query_key");
    expect(first.details.query_key).not.toBe(first.details.resolved_query_key);
    expect(repeated.details).toMatchObject({
      kind: "inquiry_query_reuse",
      evidence_ref: "e1",
      no_new_evidence: true,
    });
    expect(currentTurnEvidence(f.messages)).toHaveLength(1);
  });

  it("追问明确查询最新时不沿用历史统计日", async () => {
    const f = fixture([
      { role: "user", content: "看七月余额", timestamp: 0 },
      priorBatch("M1", "2026-07-31", "3200"),
      { role: "user", content: "现在最新的呢", timestamp: 1 },
    ]);
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { preset: "latest" },
      metadata: { source_calendar: { ranges: [], unresolved: [] } },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", { ...query, date: "latest" });
    expect(result.details).toMatchObject({ kind: "analysis_evidence", status: "succeeded" });
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      date_selection: "latest_snapshot",
    });
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).not.toHaveProperty("start");
  });

  it("最新数据策略不能覆盖原文明示的月末目标", async () => {
    const f = fixture();
    f.request.originalMessage = "2026年8月末的余额";
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { preset: "latest" },
      metadata: {
        source_calendar: { ranges: [{ start: "2026-08-31", end: "2026-08-31" }], unresolved: [] },
      },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", { ...query, date: "latest" });
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      date_selection: "exact",
      start: "2026-08-31",
      end: "2026-08-31",
    });
  });

  it("点击时间覆盖优先于模型日期、原文和历史，且同轮分批保持一致", async () => {
    const f = mixedPrior();
    f.request.originalMessage = "切换口径：2026年6月末";
    f.request.timeOverride = { start: "2026-06-30", end: "2026-06-30" };
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { preset: "latest" },
      metadata: {
        source_calendar: { ranges: [{ start: "2026-08-31", end: "2026-08-31" }], unresolved: [] },
      },
    });
    await discoverBoth(f);
    await f.call("metric_query", { ...query, org_names: ["3209"], date: "latest" });
    await f.call("metric_query", {
      ...query,
      org_names: ["3209"],
      metric_refs: ["k2"],
      date: "2026-07-31",
    });
    expect(
      f.backend.analysisExecute.mock.calls.map((call) => ({
        date_selection: call[0].date_selection,
        start: call[0].start,
        end: call[0].end,
      })),
    ).toEqual([
      { date_selection: "exact", start: "2026-06-30", end: "2026-06-30" },
      { date_selection: "exact", start: "2026-06-30", end: "2026-06-30" },
    ]);
    expect(f.resolveDate).not.toHaveBeenCalled();
  });

  it.each([
    { trend: false, selection: "latest_in_range" },
    { trend: true, selection: "all_in_range" },
  ])("点击旧区间口径保留可信查询的记录选择：$selection", async ({ trend, selection }) => {
    const f = fixture([
      legacyQuery({
        query_evidence: {
          logical_dsl: {
            metrics: ["M1"],
            orgs: ["3212"],
            time: { start: "2024-01-01", end: "2026-08-31" },
            ops: trend ? [{ type: "trend" }] : [],
          },
          query_dates: { complete: true, actual_dates: ["2026-06-30"], uniform_date: "2026-06-30" },
        },
      }),
      { role: "user", content: "切换口径：最近三个完整年度", timestamp: 1 },
    ]);
    f.request.timeOverride = { start: "2023-01-01", end: "2025-12-31" };
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, org_names: ["3212"], date: "latest" });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      date_selection: selection,
      start: "2023-01-01",
      end: "2025-12-31",
    });
    expect(result.details.inquiry_date).toEqual({
      date_selection: selection,
      start: "2023-01-01",
      end: "2025-12-31",
    });
    expect(f.resolveDate).not.toHaveBeenCalled();
  });

  it("同批历史区间记录选择不同则分组，不把全部日期悄悄改成区间最新", async () => {
    const history = [false, true].map((trend, index) =>
      legacyQuery({
        query_evidence: {
          logical_dsl: {
            metrics: [index ? "M2" : "M1"],
            orgs: ["3212"],
            time: { start: "2024-01-01", end: "2026-08-31" },
            ops: trend ? [{ type: "trend" }] : [],
          },
          query_dates: { complete: true, actual_dates: ["2026-06-30"], uniform_date: "2026-06-30" },
        },
      }),
    );
    const f = fixture([...history, { role: "user", content: "切换口径", timestamp: 1 }]);
    f.request.timeOverride = { start: "2023-01-01", end: "2025-12-31" };
    await discoverBoth(f);
    const result = await f.call("metric_query", {
      ...query,
      metric_refs: ["k1", "k2"],
      org_names: ["3212"],
    });
    expect(result).toMatchObject({
      isError: true,
      details: { code: "ANALYSIS_DATE_GROUPS_REQUIRED" },
    });
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    await f.call("metric_query", { ...query, org_names: ["3212"] });
    await f.call("metric_query", { ...query, metric_refs: ["k2"], org_names: ["3212"] });
    expect(f.backend.analysisExecute.mock.calls.map((call) => call[0].date_selection)).toEqual([
      "latest_in_range",
      "all_in_range",
    ]);
  });

  it("日期解析器的有效备选口径随查询回执保留", async () => {
    const f = fixture();
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2023-08-28", end: "2026-08-27" },
      alternative: { label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" },
    });
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, date: "近三年" });
    expect(result.details.time_variants).toEqual([
      { label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" },
    ]);
  });

  it.each([
    { label: "无效日", start: "2026-02-30", end: "2026-03-01" },
    { label: "倒序区间", start: "2026-03-01", end: "2026-02-28" },
    { label: " ", start: "2026-01-01", end: "2026-01-31" },
  ])("无效备选口径不进入查询回执：$label", async (alternative) => {
    const f = fixture();
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2023-08-28", end: "2026-08-27" },
      alternative,
    });
    f.backend.analysisExecute.mockResolvedValue(evidence({ time_variants: [alternative] }));
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, date: "近三年" });
    expect(result.details).not.toHaveProperty("time_variants");
  });

  it("原文绑定改变了解析目标时不透传模型日期对应的备选", async () => {
    const f = fixture();
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2023-08-28", end: "2026-08-27" },
      alternative: { label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" },
      metadata: {
        source_calendar: { ranges: [{ start: "2026-08-31", end: "2026-08-31" }], unresolved: [] },
      },
    });
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, date: "近三年" });
    expect(result.details).not.toHaveProperty("time_variants");
  });

  it("点击时间覆盖后不再次展示旧备选口径", async () => {
    const f = fixture();
    f.request.timeOverride = { start: "2023-01-01", end: "2025-12-31" };
    f.backend.analysisExecute.mockResolvedValue(
      evidence({
        time_variants: [{ label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" }],
      }),
    );
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, date: "近三年" });
    expect(result.details).not.toHaveProperty("time_variants");
  });

  it.each(["2026-08-27", "2026年8月末", undefined])(
    "首批取数按原文唯一明确月末绑定，不使用模型改写的%s",
    async (date) => {
      const f = fixture();
      f.request.originalMessage = "2026年8月末全行不良贷款余额";
      f.resolveDate.mockResolvedValue({
        status: "resolved",
        value: { start: "2026-08-27", end: "2026-08-27" },
        metadata: {
          source_calendar: {
            ranges: [{ start: "2026-08-31", end: "2026-08-31" }],
            unresolved: [],
          },
        },
      });
      await f.call("metric_search", { keywords: ["余额"] });
      await f.call("metric_query", { ...query, ...(date ? { date } : {}) });
      expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
        date_selection: "exact",
        start: "2026-08-31",
        end: "2026-08-31",
      });
      expect(f.resolveDate).toHaveBeenCalledTimes(1);
      expect(f.backend.resolveBusinessField).toHaveBeenCalledWith(
        "date",
        [date ?? "latest"],
        expect.anything(),
        undefined,
        expect.objectContaining({ source_question: f.request.originalMessage }),
      );
    },
  );

  it.each([undefined, "2026-08-27"])(
    "重复提及同一原文日期仍是唯一目标（模型date=%s）",
    async (date) => {
      const f = fixture();
      f.request.originalMessage = "2026年8月末的贷款余额和2026年8月末的不良率分别是多少";
      f.resolveDate.mockResolvedValue({
        status: "resolved",
        value: { start: "2026-08-27", end: "2026-08-27" },
        metadata: {
          source_calendar: {
            ranges: [
              { start: "2026-08-31", end: "2026-08-31" },
              { end: "2026-08-31", start: "2026-08-31" },
            ],
            unresolved: [],
          },
        },
      });
      await f.call("metric_search", { keywords: ["余额"] });
      await f.call("metric_query", { ...query, ...(date ? { date } : {}) });
      expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
        start: "2026-08-31",
        end: "2026-08-31",
      });
    },
  );

  it("长问题只放入source_question，不占用单个日期表达字段", async () => {
    const f = fixture();
    f.request.originalMessage = "请提供相关说明。".repeat(600) + "2026年8月末余额";
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2026-08-27", end: "2026-08-27" },
      metadata: {
        source_calendar: {
          ranges: [{ start: "2026-08-31", end: "2026-08-31" }],
          unresolved: [],
        },
      },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", query);
    expect(f.request.originalMessage.length).toBeGreaterThan(4000);
    expect(f.backend.resolveBusinessField).toHaveBeenCalledWith(
      "date",
      ["latest"],
      expect.anything(),
      undefined,
      expect.objectContaining({ source_question: f.request.originalMessage }),
    );
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      start: "2026-08-31",
      end: "2026-08-31",
    });
  });

  it("目标日已执行为空后，可补查另一期参考值并保留原目标回执", async () => {
    const f = fixture();
    f.request.originalMessage = "2026年8月末全行不良贷款余额";
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2026-08-27", end: "2026-08-27" },
      metadata: {
        source_calendar: {
          ranges: [{ start: "2026-08-31", end: "2026-08-31" }],
          unresolved: [],
        },
      },
    });
    f.backend.analysisExecute.mockResolvedValueOnce(
      evidence({
        run_ref: "analysis:empty",
        date_selection: "exact",
        requested_start: "2026-08-31",
        requested_end: "2026-08-31",
        actual_dates: [],
        analysis_date: null,
        evidence_items: [],
        complete: false,
      }),
    );
    await f.call("metric_search", { keywords: ["余额"] });
    const target = await f.call("metric_query", { ...query, date: "2026-08-27" });
    await f.call("metric_availability", {
      metric_refs: ["k1"],
      scope: "named",
      org_names: ["3200"],
    });
    await f.call("metric_query", { ...query, purpose: "补查其他日期供参考", date: "2026-08-27" });
    expect(f.backend.analysisExecute.mock.calls.map((call) => call[0].start)).toEqual([
      "2026-08-31",
      "2026-08-27",
    ]);
    expect(target.details.requested_start).toBe("2026-08-31");
    expect(target.details.evidence_items).toEqual([]);
  });

  it("历史重读不是本轮目标取数，不能绕过首次查询的原文日期", async () => {
    const f = fixture([
      priorBatch("M1", "2026-08-27"),
      { role: "user", content: "2026年8月末余额", timestamp: 1 },
    ]);
    f.request.originalMessage = "2026年8月末余额";
    f.bridge.conversationId = "conv-1";
    f.backend.analysisEvidence.mockResolvedValue(evidence({ run_ref: "run-M1" }));
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2026-08-27", end: "2026-08-27" },
      metadata: {
        source_calendar: {
          ranges: [{ start: "2026-08-31", end: "2026-08-31" }],
          unresolved: [],
        },
      },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("analysis_read", { run_ref: "run-M1" });
    await f.call("metric_query", { ...query, date: "2026-08-27" });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      start: "2026-08-31",
      end: "2026-08-31",
    });
  });

  it("原文没有日期时继续继承已有期间，不把整句解析失败变成日期澄清", async () => {
    const f = fixture([
      priorBatch("M1", "2026-08-27"),
      { role: "user", content: "那另一家呢", timestamp: 1 },
    ]);
    f.resolveDate.mockResolvedValue({
      status: "invalid",
      metadata: {
        source_calendar: { ranges: [], unresolved: [] },
      },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      start: "2026-08-27",
      end: "2026-08-27",
    });
  });

  it.each([
    { ranges: [], unresolved: ["日期表达未完整解析"] },
    {
      ranges: [
        { start: "2026-07-31", end: "2026-07-31" },
        { start: "2026-08-31", end: "2026-08-31" },
      ],
      unresolved: [],
    },
  ])("省略日期时不从未决或多个原文期间猜一个日期", async (source_calendar) => {
    const f = fixture();
    f.resolveDate.mockResolvedValue({ status: "invalid", metadata: { source_calendar } });
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", query);
    expect(result.isError).toBe(true);
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("多个原文期间保留本批明确选择，不能一律改成其中第一个", async () => {
    const f = fixture();
    f.resolveDate.mockResolvedValue({
      status: "resolved",
      value: { start: "2026-07-31", end: "2026-07-31" },
      metadata: {
        source_calendar: {
          ranges: [
            { start: "2026-08-31", end: "2026-08-31" },
            { start: "2026-07-31", end: "2026-07-31" },
          ],
          unresolved: [],
        },
      },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", { ...query, date: "2026年7月末" });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
  });

  it.each([3, 60, 120])("未指定排名数量时覆盖本次授权%d家机构，沿用100上限", async (count) => {
    const f = fixture();
    f.backend.resolveOrganizationScope.mockResolvedValue({
      status: "resolved",
      value: {
        codes: Array.from({ length: count }, (_, index) => `O${index}`),
        names: Array.from({ length: count }, (_, index) => `测试机构${index}`),
        scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
        scope_fingerprint: "scope-token",
      },
    });
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", {
      ...query,
      org_names: undefined,
      scope: "all_banks",
      method: "ranking",
    });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { steps: [{ top_n: Math.min(count, 100), position: "top" }] },
    });
    const repeated = await f.call("metric_query", {
      ...query,
      org_names: undefined,
      scope: "all_banks",
      method: "ranking",
      top_n: Math.min(count, 100),
    });
    expect(repeated.details.reused).toBe(true);
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
  });

  it("显式排名数量保持不变，与省略数量的完整范围查询使用不同身份", async () => {
    const f = fixture();
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", {
      ...query,
      org_names: undefined,
      scope: "all_banks",
      method: "ranking",
      top_n: 1,
      position: "bottom",
    });
    await f.call("metric_query", {
      ...query,
      org_names: undefined,
      scope: "all_banks",
      method: "ranking",
      position: "bottom",
    });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      plan: { steps: [{ top_n: 1, position: "bottom" }] },
    });
    expect(f.backend.analysisExecute.mock.calls[1]![0]).toMatchObject({
      plan: { steps: [{ top_n: 2, position: "bottom" }] },
    });
  });

  it("明确单日查无事实也继承原统计日，不认为条件丢失或重查最新", async () => {
    const prior = priorBatch("M1", "2026-08-31");
    if (prior.role === "toolResult")
      prior.details = evidence({
        execution_turn_id: "previous-op",
        analysis_date: undefined,
        date_selection: "exact",
        requested_start: "2026-08-31",
        requested_end: "2026-08-31",
        actual_dates: [],
        evidence_items: [],
      });
    const f = fixture([prior, { role: "user", content: "那同比呢", timestamp: 1 }]);
    await discoverBoth(f);
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      date_selection: "exact",
      start: "2026-08-31",
      end: "2026-08-31",
    });
  });

  it("日期覆盖工具用正式指标和受控机构查询明确区间，保留分页和权限所需机构范围", async () => {
    const f = fixture();
    await discoverBoth(f);
    const result = await f.call("metric_availability", {
      metric_refs: ["k1"],
      scope: "named",
      org_names: ["测试分行"],
      start: "2026-04-01",
      end: "2026-04-30",
      page: 2,
      page_size: 10,
    });
    expect(f.backend.dataAvailability).toHaveBeenCalledWith(
      {
        dimension: "dates",
        metric_codes: ["M1"],
        org_codes: ["3201"],
        start: "2026-04-01",
        end: "2026-04-30",
        match: "any",
        page: 2,
        page_size: 10,
      },
      expect.anything(),
    );
    expect(result.details).toMatchObject({
      kind: "data_availability",
      status: "succeeded",
      request: { org_codes: ["3201"] },
      groups: [{ latest: "2026-04-29", has_more: true }],
      page: 2,
    });
    expect(result.details).not.toHaveProperty("public_answer");
    expect(result.terminate).not.toBe(true);
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("同轮相同覆盖条件复用日期证据，机构别名仍先解析", async () => {
    const f = fixture();
    await discoverBoth(f);
    const input = { metric_refs: ["k1"], scope: "named", org_names: ["测试分行"] };
    const first = await f.call("metric_availability", input);
    const repeated = await f.call("metric_availability", { ...input, org_names: ["3201"] });
    expect(JSON.parse(repeated.content[0].text)).toMatchObject({
      reused: true, no_new_evidence: true, groups: [{ dates: ["2026-04-29"], has_more: true }],
    });
    expect(repeated.details.groups).toEqual(first.details.groups);
    expect(repeated.isError).not.toBe(true);
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(1);
    expect(f.resolveOrganizations).toHaveBeenCalledTimes(2);
    expect(inquiryToolAdmission(f.messages, "metric_query", query)).toBeUndefined();
  });

  it("覆盖条件改变或进入新回合继续查询，不推导子区间和单指标是否有数", async () => {
    const f = fixture();
    await discoverBoth(f);
    const input = { metric_refs: ["k1", "k2"], scope: "named", org_names: ["3200"] };
    await f.call("metric_availability", input);
    for (const change of [
      { metric_refs: ["k1"] }, { org_names: ["3201"] }, { page: 2 }, { page_size: 6 },
      { start: "2026-04-29", end: "2026-04-29" },
    ]) await f.call("metric_availability", { ...input, ...change });
    f.messages.push({ role: "user", content: "再查一次", timestamp: 1 });
    await f.call("metric_availability", input);
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(7);
    expect(f.backend.dataAvailability.mock.calls.map(([spec]) => spec.match)).toEqual(Array(7).fill("any"));
  });

  it("覆盖复用仍执行机构核验，失败和取消不回放旧结果", async () => {
    const f = fixture();
    await discoverBoth(f);
    const input = { metric_refs: ["k1"], scope: "named", org_names: ["3200"] };
    f.backend.dataAvailability.mockRejectedValueOnce(new BackendApiError(503, "暂不可用", "UNAVAILABLE"));
    await expect(f.call("metric_availability", input)).rejects.toMatchObject({ status: 503 });
    await f.call("metric_availability", input);
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(2);
    f.resolveOrganizations.mockRejectedValueOnce(new BackendApiError(403, "无权", "FORBIDDEN"));
    await expect(f.call("metric_availability", input)).rejects.toMatchObject({ status: 403 });
    const controller = new AbortController();
    controller.abort();
    await expect(runTool(createInquiryQueryTools().find(tool => tool.name === "metric_availability")!,
      input, f.request, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow();
  });

  it("日期覆盖省略范围时发现全部实际日期，但不改变后续问数的原统计日", async () => {
    const prior = priorBatch("M1", "2026-08-31");
    if (prior.role === "toolResult")
      prior.details = evidence({
        execution_turn_id: "previous-op",
        analysis_date: undefined,
        org_codes: ["3209"],
        date_selection: "exact",
        requested_start: "2026-08-31",
        requested_end: "2026-08-31",
        actual_dates: [],
        evidence_items: [],
      });
    const f = fixture([prior, { role: "user", content: "这天有数据吗", timestamp: 1 }]);
    await discoverBoth(f);
    await f.call("metric_availability", {
      metric_refs: ["k1"],
      scope: "named",
      org_names: ["3209"],
    });
    const spec = f.backend.dataAvailability.mock.calls[0]![0];
    expect(spec.org_codes).toEqual(["3209"]);
    expect(spec).not.toHaveProperty("start");
    expect(spec).not.toHaveProperty("end");
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      date_selection: "exact",
      start: "2026-08-31",
      end: "2026-08-31",
    });
  });

  it("首次覆盖发现无需猜日期；模型视图保留日期证据而不重复机构清单", async () => {
    const f = fixture();
    await discoverBoth(f);
    const orgNames = Array.from({ length: 60 }, (_, index) => `完整机构${index}`);
    f.backend.dataAvailability.mockImplementationOnce((spec) =>
      Promise.resolve({
        status: "succeeded",
        request: spec,
        mode: "dates",
        metric_count: 1,
        org_count: 60,
        org_names: orgNames,
        metric_names: ["测试余额"],
        groups: [
          {
            date_count: 2,
            earliest: "2026-04-28",
            latest: "2026-04-29",
            dates: ["2026-04-29"],
            has_more: true,
          },
        ],
        page: 1,
        page_size: 12,
        has_more: true,
        notice: "有记录不代表数值有效。",
      }),
    );
    const result = await f.call("metric_availability", { metric_refs: ["k1"], scope: "all_banks" });
    const view: unknown = JSON.parse(result.content[0].text);
    expect(view).toMatchObject({
      status: "succeeded",
      metric_names: ["测试余额"],
      org_count: 60,
      request: { start: null, end: null },
      groups: [{ date_count: 2, latest: "2026-04-29", has_more: true }],
      page: 1,
    });
    expect(JSON.stringify(view)).not.toContain("完整机构");
    expect(JSON.stringify(view)).not.toContain("org_codes");
    expect(result.details.org_names).toEqual(orgNames);
    expect(result.details.request).toMatchObject({ org_codes: ["3200", "3201"] });
  });

  it.each([
    {
      metric_refs: ["unbound"],
      scope: "named",
      org_names: ["3200"],
      start: "2026-04-01",
      end: "2026-04-30",
    },
    { metric_refs: ["k1"], scope: "named", org_names: ["3200"], start: "2026-04-01" },
    {
      metric_refs: ["k1"],
      scope: "named",
      org_names: ["3200"],
      start: "2026-04-31",
      end: "2026-05-01",
    },
  ])("日期覆盖拒绝未知指标或不完整范围：%j", async (input) => {
    const f = fixture();
    await discoverBoth(f);
    expect((await f.call("metric_availability", input)).isError).toBe(true);
    expect(f.backend.dataAvailability).not.toHaveBeenCalled();
  });

  it("覆盖查询继承授权集合的实际机构编码，撤权仍由后端拒绝", async () => {
    const f = fixture();
    await discoverBoth(f);
    f.backend.dataAvailability.mockRejectedValueOnce(
      new BackendApiError(403, "无权", "AVAILABILITY_FORBIDDEN"),
    );
    await expect(
      f.call("metric_availability", {
        metric_refs: ["k1"],
        scope: "all_banks",
        start: "2026-04-01",
        end: "2026-04-30",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.backend.dataAvailability.mock.calls[0]![0].org_codes).toEqual(["3200", "3201"]);
  });
  it.each([
    ["k1", "2026-08-27"],
    ["k2", "2026-07-31"],
  ])("按所选%s继承上一回合对应批次的实际日期", async (ref, day) => {
    const f = mixedPrior();
    await discoverBoth(f);
    await f.call("metric_query", { ...query, org_names: ["3209"], metric_refs: [ref] });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3209"],
      date_selection: "exact",
      start: day,
      end: day,
    });
  });

  it("变更机构仍沿用所选指标日期；明确日期可覆盖原来的不同期间", async () => {
    const f = mixedPrior();
    await discoverBoth(f);
    await f.call("metric_query", {
      ...query,
      scope: "named",
      org_names: ["测试分行"],
      metric_refs: ["k1"],
    });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3201"],
      start: "2026-08-27",
      end: "2026-08-27",
    });
    await f.call("metric_query", { ...query, metric_refs: ["k1", "k2"], date: "7月末" });
    expect(f.backend.analysisExecute.mock.calls[1]![0]).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
  });

  it("多指标期间不同返回可执行的按日期分组，不替用户合并成最新日", async () => {
    const f = mixedPrior();
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, metric_refs: ["k1", "k2"] });
    expect(result.details.code).toBe("ANALYSIS_DATE_GROUPS_REQUIRED");
    const content = JSON.parse(result.content[0].text) as { resolution: { date_groups: unknown } };
    expect(content.resolution.date_groups).toEqual([
      { metric_refs: ["k1"], org_codes: ["3200"], date: "2026-08-27" },
      { metric_refs: ["k2"], org_codes: ["3200"], date: "2026-07-31" },
    ]);
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    await f.call("metric_query", { ...query, metric_refs: ["k1"] });
    await f.call("metric_query", { ...query, metric_refs: ["k2"] });
    expect(f.backend.analysisExecute.mock.calls[1]![0]).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
  });

  it("显式沿用旧查询机构时，仍按真实DSL恢复实际日期", async () => {
    const f = fixture([
      priorBatch("M1", "2026-08-27"),
      { role: "user", content: "普通查值", timestamp: 0 },
      legacyQuery(),
      { role: "user", content: "同比呢", timestamp: 1 },
    ]);
    await discoverBoth(f);
    await f.call("metric_query", { ...query, org_names: ["3212"] });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3212"],
      date_selection: "exact",
      start: "2026-06-30",
      end: "2026-06-30",
    });
  });

  it("旧普通查询条件证据不足时阻断继承，但明确机构和日期仍可查询", async () => {
    const f = fixture([
      priorBatch("M1", "2026-08-27"),
      { role: "user", content: "普通查值", timestamp: 0 },
      legacyQuery({ query_evidence: undefined }),
      { role: "user", content: "同比呢", timestamp: 1 },
    ]);
    await discoverBoth(f);
    const result = await f.call("metric_query", query);
    expect(result.details.code).toBe("ANALYSIS_CONTEXT_UNAVAILABLE");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
    await f.call("metric_query", {
      ...query,
      scope: "named",
      org_names: ["测试分行"],
      date: "7月末",
    });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3201"],
      start: "2026-07-31",
    });
  });

  it("旧普通查询可从完整事实按指标恢复日期，截断事实不能用于日期继承", async () => {
    const facts = ["M1", "M2"].map((metric_code, index) => ({
      metric_code,
      org_code: "3215",
      date: ["2026-05-31", "2026-06-30"][index],
      value: "100",
      fact_id: `legacy-fact-${index}`,
    }));
    const receipt = legacyQuery({
      query_evidence: undefined,
      facts,
      fact_count: 2,
      facts_truncated: false,
    });
    const f = fixture([receipt, { role: "user", content: "余额同比呢", timestamp: 1 }]);
    await discoverBoth(f);
    await f.call("metric_query", { ...query, org_names: ["3215"] });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      org_codes: ["3215"],
      start: "2026-05-31",
      end: "2026-05-31",
    });
    const partial = fixture([
      legacyQuery({ query_evidence: undefined, facts, fact_count: 20, facts_truncated: true }),
      { role: "user", content: "同比呢", timestamp: 1 },
    ]);
    await discoverBoth(partial);
    expect((await partial.call("metric_query", query)).details.code).toBe(
      "ANALYSIS_CONTEXT_UNAVAILABLE",
    );
    expect(partial.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("旧查询正文回执与真实任务身份不一致时不继承其中条件", async () => {
    const f = fixture([
      legacyQuery({ task_id: "different-task" }),
      { role: "user", content: "同比呢", timestamp: 1 },
    ]);
    await discoverBoth(f);
    expect((await f.call("metric_query", query)).details.code).toBe("ANALYSIS_CONTEXT_UNAVAILABLE");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("旧查询用宽范围寻找最新值时继承已确认实际日，真实趋势仍保留区间", async () => {
    for (const trend of [false, true]) {
      const f = fixture([
        legacyQuery({
          query_evidence: {
            logical_dsl: {
              metrics: ["M1"],
              orgs: ["3212"],
              time: { start: "2026-01-01", end: "2026-08-31" },
              ops: trend ? [{ type: "trend" }] : [],
            },
            query_dates: {
              complete: true,
              actual_dates: ["2026-06-30"],
              uniform_date: "2026-06-30",
            },
          },
        }),
        { role: "user", content: "同比呢", timestamp: 1 },
      ]);
      await discoverBoth(f);
      await f.call("metric_query", query);
      expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject(
        trend
          ? { date_selection: "all_in_range", start: "2026-01-01", end: "2026-08-31" }
          : { date_selection: "exact", start: "2026-06-30", end: "2026-06-30" },
      );
    }
  });
  it.each(["普通目标", "旧协议", "已接纳目标"])(
    "%s计划保持原问题，局部目的只说明本次步骤",
    async (protocol) => {
      const f = fixture();
      f.request.originalMessage = "各家农商行近期哪个机构的收益不好？为什么？";
      const purpose = "读取本机构净利润当日值";
      if (protocol === "普通目标") f.request.inquiryTargetContext = { version: 1 };
      if (protocol === "已接纳目标")
        f.request.inquiryAdmission = {
          targets: [
            acceptedTarget({
              sourceQuestion: "读取已确认机构的净利润",
              metrics: { codes: ["M1"], names: ["测试余额"] },
            }),
          ],
          answerReceipts: [],
        };
      await f.call("metric_search", { keywords: ["余额"] });
      await f.call("metric_query", {
        ...query,
        purpose,
        ...(protocol === "普通目标"
          ? {
              target_change: {
                mode: "new",
                topic: "收益对比及原因",
                organizations: { mode: "replace", scope: "all_banks" },
                date: "2026-07-31",
              },
            }
          : {}),
      });
      const expectedQuestion = protocol === "已接纳目标"
        ? "读取已确认机构的净利润"
        : "各家农商行近期哪个机构的收益不好？为什么？";
      expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
        plan: {
          objective: expectedQuestion,
          requirements: [{ id: "q1", question: expectedQuestion }],
          steps: [{ rationale: purpose }],
        },
        calculation_context: {
          scope_id: f.request.operationId,
          user_question: f.request.originalMessage,
        },
      });
    },
  );

  it("同一普通原问的不同指标和方法共用要求，不被后续purpose缩小", async () => {
    const f = fixture();
    f.request.originalMessage = "查看测试余额和测试收入的半年变化";
    f.request.inquiryTargetContext = { version: 1 };
    await discoverBoth(f);
    await f.call("metric_query", {
      ...query,
      purpose: "先读取余额",
      target_change: {
        mode: "new", topic: "余额和收入变化", date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    await f.call("metric_query", {
      ...query, purpose: "补查收入同比", metric_refs: ["k2"],
      method: "compare", comparisons: ["yoy"],
    });
    expect(f.backend.analysisExecute.mock.calls.map(([payload]) => payload.plan)).toEqual([
      expect.objectContaining({
        objective: "查看测试余额和测试收入的半年变化",
        requirements: [{ id: "q1", question: "查看测试余额和测试收入的半年变化" }],
        steps: [expect.objectContaining({
          method: "observe", metric_refs: ["signed:M1"], rationale: "先读取余额",
        })],
      }),
      expect.objectContaining({
        objective: "查看测试余额和测试收入的半年变化",
        requirements: [{ id: "q1", question: "查看测试余额和测试收入的半年变化" }],
        steps: [expect.objectContaining({
          method: "compare", metric_refs: ["signed:M2"], comparisons: ["yoy"], rationale: "补查收入同比",
        })],
      }),
    ]);
  });

  it("新回合沿用目标条件时，要求使用新原问而不是旧目标问题", async () => {
    const first = fixture();
    first.request.originalMessage = "查看测试余额";
    first.request.inquiryTargetContext = { version: 1 };
    await first.call("metric_search", { keywords: ["余额"] });
    const result = await first.call("metric_query", {
      ...query,
      target_change: {
        mode: "new", topic: "余额", date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    const baseline = readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)!;
    const next = fixture([...first.messages, { role: "user", content: "再看看同比变化", timestamp: 1 }]);
    next.request.originalMessage = "再看看同比变化";
    next.request.operationId = "op-2";
    next.request.inquiryTargetContext = { version: 1, baseline };
    await next.call("metric_query", {
      ...query, purpose: "读取上年同期", method: "compare", comparisons: ["yoy"],
      target_change: { mode: "continue", base_ref: baseline.ref },
    });
    expect(next.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      plan: {
        objective: "再看看同比变化",
        requirements: [{ id: "q1", question: "再看看同比变化" }],
        steps: [{ rationale: "读取上年同期", method: "compare" }],
      },
      calculation_context: { scope_id: "op-2", user_question: "再看看同比变化" },
    });
  });

  it("恢复同轮时原问为空则连续沿用当前目标问题", async () => {
    const f = fixture();
    f.request.originalMessage = "查看测试余额的变化";
    f.request.inquiryTargetContext = { version: 1 };
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", {
      ...query,
      target_change: {
        mode: "new", topic: "余额变化", date: "2026-07-31",
        organizations: { mode: "replace", scope: "named", names: ["3200"] },
      },
    });
    f.request.originalMessage = "";
    await f.call("metric_query", { ...query, purpose: "读取变化明细", method: "trend" });
    await f.call("metric_query", {
      ...query, purpose: "读取比较依据", method: "compare", comparisons: ["yoy"],
    });
    expect(f.backend.analysisExecute.mock.calls.at(-1)?.[0]).toMatchObject({
      plan: {
        objective: "查看测试余额的变化",
        requirements: [{ id: "q1", question: "查看测试余额的变化" }],
        steps: [{ rationale: "读取比较依据" }],
      },
      calculation_context: { user_question: "查看测试余额的变化" },
    });
  });

  it("新独立问题缺少原文时不沿用上一轮目标问题", async () => {
    const f = fixture();
    f.request.originalMessage = "";
    f.request.operationId = "op-new";
    f.request.inquiryTargetContext = { version: 1, time_contract: 2, baseline: {
      version: 1, ref: "target:prior", operationId: "op-prior", sourceQuestion: "上一轮贷款质量问题",
      topic: "贷款质量", organizations: { codes: ["3200"], names: ["测试机构"] },
      time: { date_selection: "exact", start: "2026-07-31", end: "2026-07-31" },
    } };
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", { ...query, target_change: {
      mode: "new", topic: "余额", time: { expression: "2026-07-31" },
      organizations: { mode: "replace", scope: "named", names: ["3200"] },
    } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(readInquiryTargetSnapshot(result.details.inquiry_target_snapshot)?.sourceQuestion).toBe("");
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({ plan: {
      objective: "读取余额", requirements: [{ id: "q1", question: "读取余额" }],
    } });
  });

  it("旧协议没有原问或目标来源时仍用局部目的", async () => {
    const legacy = fixture();
    legacy.request.originalMessage = "";
    await legacy.call("metric_search", { keywords: ["余额"] });
    await legacy.call("metric_query", query);
    expect(legacy.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      plan: {
        objective: "读取余额",
        requirements: [{ id: "q1", question: "读取余额" }],
      },
    });
  });

  it("长原问保留完整要求，只有计划标题按后端上限缩短", async () => {
    const f = fixture();
    const original = `${"查看测试余额和测试收入的变化及其对应期间。".repeat(30)}最后比较两项变化。`;
    f.request.originalMessage = original;
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      plan: {
        objective: original.slice(0, 500),
        requirements: [{ id: "q1", question: original }],
        steps: [{ rationale: "读取余额" }],
      },
    });
  });

  it("uses catalog signatures and governed execution without frame or semantic plan services", async () => {
    const f = fixture();
    await f.call("metric_search", { keywords: ["余额"] });
    const result = await f.call("metric_query", query);
    const payload = f.backend.analysisExecute.mock.calls[0]![0] as {
      execution_mode: string;
      plan: { steps: unknown[]; requirements: unknown[] };
      org_codes: string[];
      date_selection: string;
      calculation_context: unknown;
    };
    expect(payload.execution_mode).toBe("inquiry");
    expect(payload.plan.steps).toEqual([
      expect.objectContaining({ method: "observe", metric_refs: ["signed:M1"] }),
    ]);
    expect(payload.plan.requirements).toEqual([{ id: "q1", question: "查询测试余额和测试利润" }]);
    expect(payload.org_codes).toEqual(["3200"]);
    expect(payload.date_selection).toBe("latest_snapshot");
    expect(payload.calculation_context).toEqual({
      scope_id: "op-1",
      user_question: f.request.originalMessage,
    });
    expect(result.details).toMatchObject({
      kind: "analysis_evidence",
      execution_turn_id: "op-1",
      run_ref: "analysis:one",
    });
    expect(f.request.frames).toBeUndefined();
  });

  it.each([
    {method: "compare", fields: ["method", "comparisons"]},
    {method: "structure", fields: ["method", "relation_id"]},
  ])("方法参数拒绝声明负责纠错的字段：$method", async ({method, fields}) => {
    const f = fixture();
    await f.call("metric_search", {keywords: ["余额"]});
    const result = await f.call("metric_query", {...query, method});
    expect(result.details).toMatchObject({code: "ANALYSIS_METHOD_INVALID", correction_fields: fields});
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("覆盖区间拒绝只要求修正日期条件", async () => {
    const f = fixture();
    await f.call("metric_search", {keywords: ["余额"]});
    const result = await f.call("metric_availability", {metric_refs: ["k1"], scope: "named",
      org_names: ["3200"], start: "2026-08-01"});
    expect(result.details).toMatchObject({code: "AVAILABILITY_DATE_REQUIRED", correction_fields: ["start", "end"]});
    expect(f.backend.dataAvailability).not.toHaveBeenCalled();
  });

  it("rejects unbound references before backend execution", async () => {
    const f = fixture();
    const result = await f.call("metric_query", { ...query, metric_refs: ["guessed-signature"] });
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("ANALYSIS_BINDING_INVALID");
    expect(f.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("preserves backend permission and authentication failures", async () => {
    const f = fixture();
    await f.call("metric_search", { keywords: ["余额"] });
    f.backend.analysisExecute.mockRejectedValueOnce(
      new BackendApiError(403, "无权", "ANALYSIS_FORBIDDEN"),
    );
    await expect(f.call("metric_query", query)).rejects.toMatchObject({ status: 403 });
  });

  it("reuses repeated execution and does not register another evidence source", async () => {
    const f = fixture();
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", query);
    const result = await f.call("metric_query", { ...query, purpose: "再次确认余额" });
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      reused: true,
      evidence_ref: "e1",
      source_metric_codes: ["M1"],
      requested_metric_codes: ["M1"],
    });
    expect(businessEvidences(result.details)).toHaveLength(0);
    expect(await f.request.answerEvidence!()).toHaveLength(1);
  });

  it("restores bindings and query identity from real native receipts after restart", async () => {
    const f = fixture();
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", query);
    const restarted = fixture(f.messages);
    restarted.bridge.conversationId = "conv-1";
    const result = await restarted.call("metric_query", query);
    expect(result.details.reused).toBe(true);
    expect(restarted.backend.analysisExecute).not.toHaveBeenCalled();
  });

  it("inherits the actual prior date but resolves an explicit changed date", async () => {
    const old = {
      role: "toolResult",
      toolName: "metric_query",
      toolCallId: "old",
      content: [],
      isError: false,
      timestamp: 0,
      details: evidence({ execution_turn_id: "old-op" }),
    } as AgentMessage;
    const f = fixture([old, { role: "user", content: "换一个指标", timestamp: 1 }]);
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", query);
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
      date_selection: "exact",
      start: "2026-08-27",
      end: "2026-08-27",
    });
    await f.call("metric_query", { ...query, date: "7月末" });
    expect(f.backend.resolveBusinessField).toHaveBeenCalledWith(
      "date",
      ["7月末"],
      expect.anything(),
      undefined,
      expect.objectContaining({ source_question: f.request.originalMessage }),
    );
    expect(f.backend.analysisExecute.mock.calls[1]![0]).toMatchObject({
      start: "2026-07-31",
      end: "2026-07-31",
    });
  });

  it("补查新指标由模型明确选择已有期间，不由执行层决定跨指标继承", async () => {
    const f = fixture();
    f.backend.analysisCatalog.mockResolvedValueOnce({
      items: [
        descriptor,
        { ...descriptor, code: "M2", name: "测试收入", binding_ref: "signed:M2" },
      ],
      total: 2,
      page: 1,
      page_size: 12,
    });
    f.backend.analysisExecute.mockResolvedValueOnce(
      evidence({
        analysis_date: "2026-07-31",
        actual_dates: ["2026-07-31"],
        evidence_items: [
          {
            ref: "first",
            type: "fact",
            metric_code: "M1",
            org_code: "3200",
            date: "2026-07-31",
            value: "100",
            unit: "元",
            display: "100元",
          },
        ],
      }),
    );
    await f.call("metric_search", { keywords: ["余额", "收入"] });
    await f.call("metric_query", query);
    expect(
      (await f.call("metric_query", { ...query, metric_refs: ["k2"], purpose: "补查收入" })).details
        .code,
    ).toBe("ANALYSIS_CONTEXT_UNAVAILABLE");
    expect(f.backend.analysisExecute).toHaveBeenCalledTimes(1);
    await f.call("metric_query", {
      ...query,
      metric_refs: ["k2"],
      purpose: "补查同期间收入",
      date: "2026-07-31",
    });
    expect(f.backend.analysisExecute.mock.calls[1]![0]).toMatchObject({
      date_selection: "exact",
      start: "2026-07-31",
      end: "2026-07-31",
    });
  });

  it("resolves named subsets and passes the authoritative cohort fingerprint", async () => {
    const f = fixture();
    await f.call("metric_search", { keywords: ["余额"] });
    await f.call("metric_query", { ...query, scope: "named", org_names: ["测试分行"] });
    expect(f.backend.analysisExecute.mock.calls[0]![0]).toMatchObject({ org_codes: ["3201"] });
    await f.call("metric_query", { ...query, org_names: undefined, scope: "all_banks" });
    expect(f.backend.analysisExecute.mock.calls[1]![0]).toMatchObject({
      org_codes: [],
      organization_scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
      scope_fingerprint: "scope-token",
    });
  });

  it("reads only a real run in this lane, reauthorizes it, and preserves its execution identity", async () => {
    const f = fixture([
      {
        role: "toolResult",
        toolName: "general_analysis",
        toolCallId: "old",
        content: [],
        isError: false,
        timestamp: 0,
        details: evidence({ scope_id: "old-scope", execution_turn_id: "old-op" }),
      },
      { role: "user", content: "解释刚才的结果", timestamp: 1 },
    ]);
    f.bridge.conversationId = "conv-1";
    f.backend.analysisEvidence.mockResolvedValueOnce(evidence({ scope_id: "old-scope" }));
    const rejected = await f.call("analysis_read", { run_ref: "analysis:another-lane" });
    expect(rejected.isError).toBe(true);
    expect(f.backend.analysisEvidence).not.toHaveBeenCalled();
    const result = await f.call("analysis_read", { run_ref: "analysis:one" });
    expect(f.backend.analysisEvidence).toHaveBeenCalledWith(
      "analysis:one",
      "conv-1",
      expect.anything(),
    );
    expect(result.details).toMatchObject({
      scope_id: "old-scope",
      execution_turn_id: "old-op",
      result_reused: true,
    });
  });
  it("历史投影接受的嵌套旧查询回执在执行层使用同一期间", async () => {
    const original = legacyQuery();
    if (original.role !== "toolResult") throw new Error("isolated receipt missing");
    const payload: unknown = JSON.parse(
      original.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
    );
    const nested = {
      ...original,
      content: [{ type: "text" as const, text: JSON.stringify({ payloads: [payload] }) }],
    };
    const f = fixture([nested, { role: "user", content: "继续对比", timestamp: 1 }]);
    await discoverBoth(f);
    const result = await f.call("metric_query", { ...query, org_names: ["3212"] });
    expect(result.isError).not.toBe(true);
    expect(f.backend.analysisExecute.mock.calls[0]?.[0]).toMatchObject({
      org_codes: ["3212"],
      date_selection: "exact",
      start: "2026-06-30",
      end: "2026-06-30",
    });
  });
});
