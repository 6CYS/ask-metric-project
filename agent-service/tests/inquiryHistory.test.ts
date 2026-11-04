import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { prepareInquiryHistory } from "../src/inquiry/history.js";
import { catalogBindingState, restoreAnalysisDiscovery } from "../src/analysis/bindings.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "isolated",
  model: "isolated",
  timestamp: 0,
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const tool = (toolName: string, details: unknown, text = "已取得结果"): AgentMessage => ({
  role: "toolResult",
  toolCallId: toolName,
  toolName,
  content: [{ type: "text", text }],
  details,
  isError: false,
  timestamp: 0,
});
const source = {
  kind: "analysis_evidence",
  status: "succeeded",
  run_ref: "analysis:previous",
  tasks: [],
  org_codes: ["320000000"],
  org_names: ["测试银行"],
  date_selection: "latest_snapshot",
  actual_dates: ["2026-07-31", "2026-08-27"],
  metric_descriptors: [
    { code: "CORP", name: "对公活期存款余额当日数", unit: "元" },
    { code: "PERSONAL", name: "个人活期存款余额当日数", unit: "元" },
  ],
  evidence_items: [
    { type: "fact", ref: "raw.f1", metric_code: "CORP", date: "2026-07-31", value: "111111" },
    { type: "fact", ref: "raw.f2", metric_code: "PERSONAL", date: "2026-08-27", value: "222222" },
  ],
};
const prior = (): AgentMessage[] => [
  user("我行活期存款情况"),
  assistant([
    {
      type: "toolCall",
      id: "metric_search",
      name: "metric_search",
      arguments: { keywords: ["活期"] },
    },
  ]),
  tool("metric_search", { kind: "analysis_catalog", status: "succeeded" }, "目录详情".repeat(7000)),
  assistant([
    {
      type: "toolCall",
      id: "metric_query",
      name: "metric_query",
      arguments: { metric_refs: ["k1", "k2"] },
    },
  ]),
  tool("metric_query", source, "旧引用 {{e1.v1}} {{e1.v2}}"),
  assistant([
    {
      type: "toolCall",
      id: "analysis_answer",
      name: "analysis_answer",
      arguments: { body: "草稿不保留" },
    },
  ]),
  tool("analysis_answer", {
    kind: "business_report",
    status: "succeeded",
    org_codes: source.org_codes,
    tasks: [],
    public_answer: "本行个人活期与对公活期存款已分别查询，统计日期不同。",
  }),
];
function request(allowed = true) {
  const backend = {
    getTask: vi.fn((taskId: string) =>
      Promise.resolve({
        task_id: taskId,
        status: "SUCCEEDED",
        result: { result_id: "old-result" },
      }),
    ),
    resolveBusinessField: vi.fn(() => {
      if (!allowed) return Promise.reject(new BackendApiError(403, "权限变化", "FORBIDDEN"));
      return Promise.resolve({ status: "resolved", value: { codes: source.org_codes } });
    }),
  };
  return testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge());
}

describe("inquiry 历史问答投影", () => {
  it("同一指标不同机构的实际日期保留对应关系，相同日期合并机构", async () => {
    const details = {
      ...source,
      org_codes: ["A", "B", "C"],
      org_names: ["甲行", "乙行", "丙行"],
      metric_descriptors: [{ code: "M1", name: "余额", unit: "元" }],
      evidence_items: [
        {
          type: "fact",
          ref: "a",
          metric_code: "M1",
          org_code: "A",
          date: "2026-08-27",
          value: "123456",
        },
        {
          type: "fact",
          ref: "b",
          metric_code: "M1",
          org_code: "B",
          date: "2026-07-31",
          value: "234567",
        },
        {
          type: "fact",
          ref: "c",
          metric_code: "M1",
          org_code: "C",
          date: "2026-08-27",
          value: "345678",
        },
      ],
    };
    const messages = prior().map((message) =>
      message.role === "toolResult" && message.toolName === "metric_query"
        ? { ...message, details }
        : message,
    );
    const context = request();
    vi.spyOn(context.backend, "resolveBusinessField").mockImplementation((_field, codes) =>
      Promise.resolve({
        status: "resolved",
        value: { codes },
      }),
    );
    const result = await prepareInquiryHistory(context, [...messages, user("甲行同比呢")]);
    expect(result.referenceContext[0]).toMatchObject({
      sources: [
        {
          observed_periods: [
            { metric_code: "M1", org_codes: ["A", "C"], dates: ["2026-08-27"] },
            { metric_code: "M1", org_codes: ["B"], dates: ["2026-07-31"] },
          ],
        },
      ],
    });
    expect(JSON.stringify(result.referenceContext)).not.toMatch(/123456|234567|345678/);
  });

  it.each([false, true])("旧查询仅完整事实恢复机构与日期对应关系（截断=%s）", async (truncated) => {
    const payload = {
      task_id: "old-task",
      fact_count: truncated ? 5 : 2,
      facts_truncated: truncated,
      query_evidence: { logical_dsl: { metrics: ["M1"], orgs: ["A", "B"] } },
      facts: [
        { metric_code: "M1", org_code: "A", date: "2026-08-27", value: "12345" },
        { metric_code: "M1", org_code: "B", date: "2026-07-31", value: "23456" },
      ],
    };
    const messages = [
      user("查余额"),
      assistant([{ type: "toolCall", id: "old", name: "metric_query_structured", arguments: {} }]),
      tool(
        "metric_query_structured",
        { kind: "metric_query_structured", status: "succeeded", task_id: "old-task" },
        JSON.stringify(payload),
      ),
      user("甲行同比呢"),
    ];
    const result = await prepareInquiryHistory(request(), messages);
    expect(result.referenceContext[0]).toMatchObject({
      sources: [
        {
          observed_periods: truncated
            ? []
            : [
                { metric_code: "M1", org_codes: ["A"], dates: ["2026-08-27"] },
                { metric_code: "M1", org_codes: ["B"], dates: ["2026-07-31"] },
              ],
        },
      ],
    });
  });

  it("机构日期对应过多时受摘要预算限制并明确标注截断", async () => {
    const details = {
      ...source,
      metric_descriptors: [],
      evidence_items: Array.from({ length: 129 }, (_, index) => ({
        type: "fact",
        ref: `v${index}`,
        metric_code: `M${index}`,
        org_code: source.org_codes[0],
        date: "2026-08-27",
      })),
    };
    const messages = prior().map((message) =>
      message.role === "toolResult" && message.toolName === "metric_query"
        ? { ...message, details }
        : message,
    );
    const result = await prepareInquiryHistory(request(), [...messages, user("继续看看")]);
    const sources = result.referenceContext[0]?.sources as Array<Record<string, unknown>>;
    expect(sources[0]?.observed_periods).toHaveLength(128);
    expect(sources[0]?.observed_periods_truncated).toBe(true);
  });

  it.each([false, true])(
    "旧查询无DSL时仅从完整事实提供机构与日期（截断=%s）",
    async (truncated) => {
      const payload = {
        task_id: "old-task",
        status: "succeeded",
        fact_count: truncated ? 20 : 1,
        facts_truncated: truncated,
        facts: [{ metric_code: "M1", org_code: "3215", date: "2026-05-31", value: "98765" }],
      };
      const messages = [
        user("查一下余额"),
        assistant([
          { type: "toolCall", id: "old", name: "metric_query_structured", arguments: {} },
        ]),
        tool(
          "metric_query_structured",
          {
            kind: "metric_query_structured",
            status: "succeeded",
            task_id: "old-task",
            result_id: "old-result",
          },
          JSON.stringify(payload),
        ),
        user("去年呢"),
      ];
      const result = await prepareInquiryHistory(request(), messages);
      const sources = (result.referenceContext[0]?.sources as Array<Record<string, unknown>>) ?? [];
      expect(sources).toHaveLength(1);
      if (truncated) {
        expect(sources[0]).toMatchObject({ conditions_unconfirmed: true });
        expect(sources[0]).not.toHaveProperty("organizations");
      } else
        expect(sources[0]).toMatchObject({
          organizations: [{ code: "3215" }],
          metrics: [{ code: "M1", dates: ["2026-05-31"] }],
        });
      expect(JSON.stringify(result.referenceContext)).not.toContain("98765");
    },
  );

  it("历史保留授权集合的语义，追问可继续选择集合而不是截取一批机构", async () => {
    const scope = { kind: "authorized_cohort", cohort: "rural_commercial_banks" };
    const messages = prior().map((message) =>
      message.role === "toolResult" && message.toolName === "metric_query"
        ? {
            ...message,
            details: {
              ...source,
              inquiry_scope: {
                codes: source.org_codes,
                names: source.org_names,
                scope,
                scope_fingerprint: "old-scope-fingerprint",
              },
            },
          }
        : message,
    );
    const result = await prepareInquiryHistory(request(), [...messages, user("去年呢")]);
    expect(result.referenceContext[0]).toMatchObject({ sources: [{ organization_scope: scope }] });
    expect(JSON.stringify(result.referenceContext)).not.toContain("old-scope-fingerprint");
  });
  it("历史助手正文不混入内部来源条件，避免被追问回答照抄", async () => {
    const result = await prepareInquiryHistory(request(), [...prior(), user("实话实说哪个好一点")]);
    const answers = result.messages.filter((message) => message.role === "assistant");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.content).toEqual([
      { type: "text", text: "本行个人活期与对公活期存款已分别查询，统计日期不同。" },
    ]);
    expect(result.referenceContext).toEqual([
      expect.objectContaining({
        question: "我行活期存款情况",
        sources: [expect.objectContaining({ run_ref: "analysis:previous" })],
      }),
    ]);
  });
  it("大目录不挤掉上一轮问题、最终回答及每个指标的实际日期", async () => {
    const messages = [...prior(), user("江南的呢？")],
      before = structuredClone(messages);
    const result = await prepareInquiryHistory(request(), messages);
    expect(result.messages.map((item) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(result.messages[0]).toBe(messages[0]);
    const text = JSON.stringify(result.messages);
    expect(text).toContain("我行活期存款情况");
    expect(text).toContain("本行个人活期与对公活期存款已分别查询");
    const references = JSON.stringify(result.referenceContext);
    expect(references).toContain("analysis:previous");
    expect(references).toContain("CORP");
    expect(references).toContain("2026-07-31");
    expect(references).toContain("PERSONAL");
    expect(references).toContain("2026-08-27");
    expect(text + references).not.toMatch(/目录详情|草稿不保留|e1\.v|111111|222222/);
    expect(result.authorizedMessages).toEqual(messages);
    expect(messages).toEqual(before);
  });
  it("当前轮原样保留全部工具调用和回执，不产生额外用户消息", async () => {
    const current = [
      user("江南的呢？"),
      assistant([{ type: "toolCall", id: "query", name: "metric_query", arguments: {} }]),
      { ...tool("metric_query", source), toolCallId: "query" },
    ];
    const result = await prepareInquiryHistory(request(), [...prior(), ...current]);
    expect(result.messages.slice(-current.length)).toEqual(current);
    current.forEach((message, index) =>
      expect(result.messages.at(-current.length + index)).toBe(message),
    );
    expect(result.messages.filter((item) => item.role === "user")).toHaveLength(2);
  });
  it("撤权后不传旧回答、来源、指标或日期，保留历史不可用说明", async () => {
    const result = await prepareInquiryHistory(request(false), [...prior(), user("江南的呢？")]);
    const text = JSON.stringify(result.messages);
    expect(text).toContain("历史证据当前不可访问");
    expect(text).not.toMatch(/本行个人活期|analysis:previous|CORP|PERSONAL|2026-07-31|2026-08-27/);
    expect(result.referenceContext).toEqual([]);
    expect(
      result.authorizedMessages
        .filter((item) => item.role === "toolResult")
        .every((item) => item.details === undefined),
    ).toBe(true);
  });
  it("只发送最近三个历史回合，完整保留当前回合", async () => {
    const messages = Array.from({ length: 5 }, (_, index) => [
      user(`旧问题${index}`),
      assistant([{ type: "text", text: `回答${index}` }]),
    ]).flat();
    const result = await prepareInquiryHistory(request(), [...messages, user("当前问题")]);
    expect(
      result.messages.filter((item) => item.role === "user").map((item) => item.content),
    ).toEqual(["旧问题2", "旧问题3", "旧问题4", "当前问题"]);
  });
  it("重新鉴权服务失败时不回退到未经核验的历史", async () => {
    const context = request();
    vi.spyOn(context.backend, "resolveBusinessField").mockRejectedValue(
      new BackendApiError(503, "不可用", "UNAVAILABLE"),
    );
    await expect(
      prepareInquiryHistory(context, [...prior(), user("江南的呢？")]),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("未经交付校验的助手草稿即使机构仍有权限也不进入历史正文", async () => {
    const messages = [
      user("查余额"),
      assistant([{ type: "text", text: "未经核验的数值99999亿元" }]),
      user("江南的呢？"),
    ];
    const result = await prepareInquiryHistory(request(), messages);
    expect(JSON.stringify(result.messages)).not.toContain("99999");
    expect(JSON.stringify(result.messages)).toContain("上一轮未完成可交付的回答");
  });
  it("同一指标比较基期不混入追问的实际分析日期", async () => {
    const compared = {
      ...source,
      actual_dates: ["2026-08-27"],
      metric_descriptors: [source.metric_descriptors[1]],
      rows: [
        {
          metric_name: "个人活期存款余额当日数",
          org_name: "测试银行",
          stat_date: "2026-08-27",
          value_role: "分析时点",
        },
        {
          metric_name: "个人活期存款余额当日数",
          org_name: "测试银行",
          stat_date: "2026-07-31",
          value_role: "比较基期",
        },
      ],
      evidence_items: ["2026-08-27", "2026-07-31"].map((date) => ({
        type: "fact",
        metric_code: "PERSONAL",
        metric_name: "个人活期存款余额当日数",
        org_name: "测试银行",
        date,
      })),
      plan: { steps: [{ method: "compare", comparisons: ["mom"] }] },
    };
    const messages = prior().map((message) =>
      message.role === "toolResult" && message.toolName === "metric_query"
        ? { ...message, details: compared }
        : message,
    );
    const result = await prepareInquiryHistory(request(), [...messages, user("江南的呢？")]);
    const text = JSON.stringify(result.referenceContext);
    expect(text).toContain("2026-08-27");
    expect(text).not.toContain("2026-07-31");
    expect(text).toContain("mom");
    expect(result.referenceContext[0]).toMatchObject({
      sources: [
        {
          observed_periods: [
            { metric_code: "PERSONAL", org_codes: source.org_codes, dates: ["2026-08-27"] },
          ],
        },
      ],
    });
  });
  it.each([false, true])(
    "旧查询按实际 DSL 保留全部指标和机构，不从截断样例恢复范围（截断=%s）",
    async (truncated) => {
      const old = {
        kind: "metric_query_structured",
        status: "succeeded",
        task_id: "old-task",
        result_id: "old-result",
        public_answer: "此前已查询活期存款。",
        rows: [{ metric_code: "CORP", org_code: "320000000", metric_value: "99999" }],
      };
      const payload = {
        task_id: "old-task",
        result_id: "old-result",
        query_evidence: {
          logical_dsl: {
            metrics: ["CORP", "PERSONAL"],
            orgs: ["320000000", "320100000"],
            time: { preset: "latest" },
          },
          query_dates: { complete: false, actual_dates: ["2026-07-31", "2026-08-27"] },
        },
        facts: source.evidence_items.map((item, index) => ({
          metric_code: item.metric_code,
          org_code: ["320000000", "320100000"][index],
          date: item.date,
          value: "99999",
        })),
        fact_count: 2,
        facts_truncated: truncated,
      };
      const messages = [
        user("我行活期存款情况"),
        assistant([
          { type: "toolCall", id: "old", name: "metric_query_structured", arguments: {} },
        ]),
        tool("metric_query_structured", old, JSON.stringify(payload)),
        user("江南的呢？"),
      ];
      const result = await prepareInquiryHistory(request(), messages),
        text = JSON.stringify(result.referenceContext);
      expect(text).toContain("CORP");
      expect(text).toContain("PERSONAL");
      expect(text).toContain("320100000");
      expect(text).not.toContain("99999");
      if (truncated) {
        expect(text).not.toContain("2026-07-31");
        expect(text).toContain("actual_dates_unconfirmed");
      } else {
        expect(text).toContain("2026-07-31");
        expect(text).toContain("2026-08-27");
      }
    },
  );
  it("截断旧回执的全局日期不能冒充每个机构的已确认日期", async () => {
    const payload = {
      task_id: "old-task",
      fact_count: 20,
      facts_truncated: true,
      facts: [],
      query_evidence: {
        logical_dsl: { metrics: ["M1"], orgs: ["A", "B"] },
        query_dates: { complete: true, actual_dates: ["2026-08-27"] },
      },
    };
    const messages = [
      user("查余额"),
      assistant([{ type: "text", text: "旧回答" }]),
      tool(
        "metric_query_structured",
        { kind: "metric_query_structured", status: "succeeded", task_id: "old-task" },
        JSON.stringify(payload),
      ),
      user("继续对比"),
    ];
    const result = await prepareInquiryHistory(request(), messages);
    expect(result.referenceContext[0]).toMatchObject({
      sources: [
        {
          metrics: [{ code: "M1", dates: [] }],
          actual_dates_unconfirmed: true,
        },
      ],
    });
  });
});

describe("历史压缩保留已查询指标的一跳关系导航", () => {
  const relation = {
    id: "topic:deposit:customers",
    kind: "classification",
    status: "draft",
    parent: "TOTAL",
    children: ["PERSONAL", "CORP"],
    source: "客户分类观察，不代表完整组成。",
    origin: "topic",
    usage: "navigation_only",
    notice: "仅用于发现；不授权完整增减贡献。",
  };
  const descriptors = [
    { code: "TOTAL", name: "总存款", unit: "元", binding_ref: "k1" },
    { code: "PERSONAL", name: "个人存款", unit: "元", binding_ref: "k2" },
    { code: "CORP", name: "对公存款", unit: "元", binding_ref: "k3" },
    { code: "OTHER", name: "无关指标", unit: "元", binding_ref: "k4" },
  ];
  const binding_map = {
    "code:TOTAL": "signed-total",
    k1: "signed-total",
    "code:PERSONAL": "signed-personal",
    k2: "signed-personal",
    "code:CORP": "signed-corp",
    k3: "signed-corp",
    "code:OTHER": "signed-other",
    k4: "signed-other",
  };
  function history() {
    const queried = {
      ...source,
      metric_descriptors: [descriptors[0]],
      evidence_items: [
        {
          type: "fact",
          ref: "raw.total",
          metric_code: "TOTAL",
          org_code: source.org_codes[0],
          date: "2026-08-27",
          value: "100",
        },
      ],
    };
    return [
      user("查询总存款"),
      assistant([{ type: "toolCall", id: "search", name: "metric_search", arguments: {} }]),
      tool(
        "metric_search",
        {
          kind: "analysis_catalog",
          status: "succeeded",
          candidate_map: descriptors.map((item) => ({
            ...item,
            query_recovery: { original_message: "内部恢复字段" },
          })),
          binding_map,
        },
        JSON.stringify({
          items: [descriptors[0], descriptors[3]],
          results: [
            {
              matches: [{ binding_ref: "k1" }, { binding_ref: "k4" }],
              related_metrics: [descriptors[1], descriptors[2]],
              relations: [
                relation,
                {
                  ...relation,
                  id: "deeper",
                  parent: "PERSONAL",
                  children: ["OTHER"],
                },
              ],
            },
          ],
        }),
      ),
      assistant([{ type: "toolCall", id: "query", name: "metric_query", arguments: {} }]),
      tool("metric_query", queried),
      assistant([{ type: "text", text: "已查总存款" }]),
      tool("analysis_answer", {
        kind: "business_report",
        status: "succeeded",
        org_codes: source.org_codes,
        public_answer: "已查总存款",
        tasks: [],
      }),
    ];
  }

  it("保留完整一跳关系与原引用，丢弃无关候选和二跳，不混入已查询事实", async () => {
    const messages = [...history(), user("个人和对公分别多少？")];
    const before = structuredClone(messages);
    const result = await prepareInquiryHistory(request(), messages);

    expect(result.referenceContext[0]).toMatchObject({
      sources: [{ metrics: [{ code: "TOTAL" }] }],
      related_catalog: {
        items: descriptors.slice(0, 3),
        results: [{ relations: [relation] }],
      },
    });
    const references = JSON.stringify(result.referenceContext);
    expect(references).not.toMatch(/OTHER|signed-|deeper|raw.total|query_recovery|内部恢复字段/);
    expect(JSON.stringify(result.messages)).not.toMatch(/k2|k3|PERSONAL|CORP/);
    expect(messages).toEqual(before);

    // 执行仍从授权原生回执恢复，投影不重新登记短引用或构造签名。
    const restored = request();
    restoreAnalysisDiscovery(
      restored,
      result.authorizedMessages.flatMap((message): unknown[] =>
        message.role === "toolResult" ? [message.details] : [],
      ),
    );
    expect(catalogBindingState(restored)).toMatchObject({
      k2: "signed-personal",
      k3: "signed-corp",
    });
  });

  it.each(["query_failed", "catalog_failed", "incomplete", "unsigned", "denied"])(
    "%s 不携带无法完整追溯的历史关系导航",
    async (failure) => {
      const messages = history().map((message) => {
        if (message.role !== "toolResult") return message;
        if (failure === "query_failed" && message.toolName === "metric_query")
          return { ...message, isError: true };
        if (message.toolName !== "metric_search") return message;
        if (failure === "catalog_failed") return { ...message, isError: true };
        if (failure === "incomplete")
          return {
            ...message,
            details: {
              kind: "analysis_catalog",
              status: "succeeded",
              binding_map,
              candidate_map: descriptors.filter((item) => item.code !== "CORP"),
            },
          };
        if (failure === "unsigned")
          return {
            ...message,
            details: {
              kind: "analysis_catalog",
              status: "succeeded",
              candidate_map: descriptors,
              binding_map: { ...binding_map, k3: "" },
            },
          };
        return message;
      });
      const result = await prepareInquiryHistory(request(failure !== "denied"), [
        ...messages,
        user("个人和对公分别多少？"),
      ]);

      expect(result.referenceContext.every((item) => item.related_catalog === undefined)).toBe(
        true,
      );
    },
  );

  it.each([false, true])("原目录页已截断时保留关系未穷尽标记（重复=%s）", async (duplicate) => {
    const messages = history().map((message) =>
      message.role === "toolResult" && message.toolName === "metric_search"
        ? tool(
            "metric_search",
            message.details,
            JSON.stringify({
              items: descriptors,
              results: [
                ...(duplicate ? [{ relations: [relation] }] : []),
                { relations: [relation], has_more_relations: true },
              ],
            }),
          )
        : message,
    );
    const result = await prepareInquiryHistory(request(), [...messages, user("分项呢？")]);

    expect(result.referenceContext[0]?.related_catalog).toMatchObject({
      results: [{ relations: [relation], has_more_relations: true }],
    });
  });

  it.each([1, 4])("多页目录关系仍有界并保留完整成员（每组%s项）", async (size) => {
    const related = Array.from({ length: 30 }, (_, index) => ({
      ...relation,
      id: `group-${index}`,
      children: Array.from({ length: size }, (_, member) => `part-${index}-${member}`),
    }));
    const members = [
      descriptors[0]!,
      ...related
        .flatMap((item) => item.children)
        .map((code, index) => ({
          code,
          name: code,
          unit: "元",
          binding_ref: `k${index + 2}`,
        })),
    ];
    const bindings = Object.fromEntries(
      members.flatMap((item) => [
        [`code:${item.code}`, `signed-${item.code}`],
        [item.binding_ref, `signed-${item.code}`],
      ]),
    );
    const messages = history().map((message) =>
      message.role === "toolResult" && message.toolName === "metric_search"
        ? tool(
            "metric_search",
            {
              kind: "analysis_catalog",
              status: "succeeded",
              candidate_map: members,
              binding_map: bindings,
            },
            JSON.stringify({ items: members, relations: related }),
          )
        : message,
    );
    const result = await prepareInquiryHistory(request(), [...messages, user("分项呢？")]);
    const catalog = result.referenceContext[0]?.related_catalog as {
      items: Array<{ code: string }>;
      results: Array<{
        relations: Array<{ parent: string; children: string[] }>;
        has_more_relations: boolean;
      }>;
    };
    expect(catalog.items.length).toBeLessThanOrEqual(24);
    expect(catalog.results[0]?.relations.length).toBeGreaterThan(0);
    expect(catalog.results[0]?.relations.length).toBeLessThanOrEqual(8);
    expect(catalog.results[0]?.has_more_relations).toBe(true);
    const visible = new Set(catalog.items.map((item) => item.code));
    for (const item of catalog.results[0]?.relations ?? [])
      expect([item.parent, ...item.children].every((code) => visible.has(code))).toBe(true);
  });

  it("不从另一个未查询目标的历史回合借用目录关系", async () => {
    const discoveryOnly = history().filter(
      (message) => message.role !== "toolResult" || message.toolName !== "metric_query",
    );
    const queryOnly = history().filter(
      (message) => message.role !== "toolResult" || message.toolName !== "metric_search",
    );
    const result = await prepareInquiryHistory(request(), [
      ...discoveryOnly,
      ...queryOnly,
      user("个人和对公分别多少？"),
    ]);
    expect(result.referenceContext.every((item) => item.related_catalog === undefined)).toBe(true);
  });
});
