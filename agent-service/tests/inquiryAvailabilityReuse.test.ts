import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AvailabilityRequest,
  AvailabilityResult,
  BackendClient,
} from "../src/backendClient.js";
import { catalogBindingView } from "../src/analysis/bindings.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { availabilityScopeKey, reusableAvailability } from "../src/inquiry/availabilityReuse.js";
import type { ResolvedOrganizations } from "../src/business-context/types.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

const allDates = ["2026-08-27", "2026-07-31", "2026-06-30", "2026-05-31"];

function coverage(spec: AvailabilityRequest): AvailabilityResult {
  const dates = allDates.filter(
    (date) => (!spec.start || date >= spec.start) && (!spec.end || date <= spec.end),
  );
  const page = spec.page ?? 1,
    size = spec.page_size ?? 12;
  return {
    status: "succeeded",
    request: spec,
    mode: "overview",
    metric_count: spec.metric_codes?.length ?? 0,
    org_count: spec.org_codes.length,
    org_names: ["隔离测试机构"],
    metric_names: ["测试余额", "测试收入"],
    groups: [
      {
        date_count: dates.length,
        earliest: dates.at(-1) ?? null,
        latest: dates[0] ?? null,
        dates: dates.slice((page - 1) * size, page * size),
        has_more: page * size < dates.length,
      },
    ],
    page,
    page_size: size,
    notice: "有记录不代表数值有效。",
  };
}

function fixture() {
  const messages: AgentMessage[] = [];
  const backend = {
    dataAvailability: vi.fn<BackendClient["dataAvailability"]>((spec) =>
      Promise.resolve(coverage(spec)),
    ),
    resolveBusinessField: vi.fn<BackendClient["resolveBusinessField"]>((_entity, values) =>
      Promise.resolve({
        status: "resolved",
        value: { codes: values, names: values },
      }),
    ),
  };
  const request = testRequestContext(
    backend as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      turnMessages: () => Promise.resolve(messages),
      answerEvidence: () => Promise.resolve([]),
    },
  );
  catalogBindingView(request, {
    items: [
      { code: "M1", name: "测试余额", binding_ref: "signed:M1" },
      { code: "M2", name: "测试收入", binding_ref: "signed:M2" },
    ],
  });
  const tool = createInquiryQueryTools().find((item) => item.name === "metric_availability")!;
  async function call(input: Record<string, unknown> = {}) {
    const result = (await runTool(
      tool,
      {
        metric_refs: ["k1", "k2"],
        scope: "named",
        org_names: ["3200"],
        ...input,
      },
      request,
    )) as {
      content: [{ type: "text"; text: string }];
      details: Record<string, unknown>;
      isError?: boolean;
    };
    messages.push({
      role: "toolResult",
      toolName: tool.name,
      toolCallId: `call-${messages.length}`,
      content: result.content,
      details: result.details,
      isError: result.isError ?? false,
      timestamp: 0,
    });
    return result;
  }
  return { messages, backend, request, call };
}

describe("完整日期覆盖证据的同轮复用", () => {
  it("完整全范围回执过滤子区间并重新分页，连续复用始终保留原来源", async () => {
    const f = fixture();
    const first = await f.call();
    const subset = await f.call({ start: "2026-06-01", end: "2026-07-31", page_size: 1 });
    const second = await f.call({ start: "2026-06-01", end: "2026-07-31", page_size: 1, page: 2 });
    const empty = await f.call({ start: "2026-09-01", end: "2026-10-31" });
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(1);
    expect(subset.details).toMatchObject({
      no_new_evidence: true,
      reused: true,
      availability_source_key: first.details.availability_key,
      execution_turn_id: f.request.operationId,
      request: { start: "2026-06-01", end: "2026-07-31", page_size: 1, page: 1 },
      groups: [
        {
          date_count: 2,
          earliest: "2026-06-30",
          latest: "2026-07-31",
          dates: ["2026-07-31"],
          has_more: true,
        },
      ],
    });
    expect(second.details).toMatchObject({
      availability_source_key: first.details.availability_key,
      page: 2,
      groups: [{ date_count: 2, dates: ["2026-06-30"], has_more: false }],
    });
    expect(empty.details).toMatchObject({
      availability_source_key: first.details.availability_key,
      groups: [{ date_count: 0, earliest: null, latest: null, dates: [], has_more: false }],
    });
    expect(JSON.parse(empty.content[0].text)).toMatchObject({
      no_new_evidence: true,
      groups: [{ date_count: 0 }],
    });
    expect(f.backend.resolveBusinessField).toHaveBeenCalledTimes(4);
  });

  it("有界完整覆盖只允许范围内复用，扩大范围仍访问后端", async () => {
    const f = fixture();
    await f.call({ start: "2026-06-01", end: "2026-07-31" });
    const subset = await f.call({ start: "2026-06-30", end: "2026-06-30" });
    expect(subset.details).toMatchObject({
      no_new_evidence: true,
      groups: [{ dates: ["2026-06-30"] }],
    });
    await f.call({ start: "2026-05-01", end: "2026-07-31" });
    await f.call({ start: "2026-06-01", end: "2026-08-31" });
    await f.call();
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(4);
  });

  it("全范围完整空回执证明子区间为空，越过末页仍保留完整总数", async () => {
    const f = fixture();
    await f.call();
    const pastEnd = await f.call({ page: 9, page_size: 2 });
    expect(pastEnd.details).toMatchObject({
      no_new_evidence: true,
      groups: [
        { date_count: 4, earliest: "2026-05-31", latest: "2026-08-27", dates: [], has_more: false },
      ],
    });
    const empty = fixture();
    empty.backend.dataAvailability.mockImplementation((spec) =>
      Promise.resolve({
        ...coverage(spec),
        groups: [{ date_count: 0, earliest: null, latest: null, dates: [], has_more: false }],
      }),
    );
    await empty.call();
    expect((await empty.call({ start: "2026-01-01", end: "2026-12-31" })).details).toMatchObject({
      no_new_evidence: true,
      groups: [{ date_count: 0, dates: [] }],
    });
    expect(empty.backend.dataAvailability).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["分页尚未结束", { page_size: 1 }],
    ["非首页即使已结束", { page: 2, page_size: 2 }],
  ])("%s时允许真实子区间补查", async (_name, initial) => {
    const f = fixture();
    await f.call(initial);
    await f.call({ start: "2026-08-01", end: "2026-08-31" });
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(2);
  });

  it("新指标集合、新机构和新绑定版本继续真实查询", async () => {
    const f = fixture();
    await f.call();
    await f.call({ metric_refs: ["k1"] });
    await f.call({ org_names: ["3201"] });
    catalogBindingView(f.request, {
      items: [{ code: "M1", name: "修订余额", binding_ref: "signed:M1:v2" }],
    });
    await f.call({ metric_refs: ["k3", "k2"] });
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(4);
  });

  it("保留旧回执的精确复用，但未知完整性不能推导子区间", async () => {
    const f = fixture();
    const original = await f.call();
    delete original.details.availability_scope_key;
    expect((await f.call()).details.no_new_evidence).toBe(true);
    expect(
      (await f.call({ start: "2026-08-01", end: "2026-08-31" })).details.no_new_evidence,
    ).toBeUndefined();
    expect(f.backend.dataAvailability).toHaveBeenCalledTimes(2);
  });
});

describe("日期覆盖完整性与授权身份", () => {
  const spec: AvailabilityRequest = {
    dimension: "dates",
    org_codes: ["3200"],
    metric_codes: ["M1", "M2"],
    match: "any",
    page: 1,
    page_size: 12,
  };
  const child = { ...spec, start: "2026-06-01", end: "2026-07-31" };
  function source(overrides: Record<string, unknown> = {}): AgentMessage {
    return {
      role: "toolResult",
      toolName: "metric_availability",
      toolCallId: "coverage-1",
      isError: false,
      content: [],
      timestamp: 0,
      details: {
        ...coverage(spec),
        kind: "data_availability",
        availability_key: "original",
        availability_scope_key: "scope",
        ...overrides,
      },
    };
  }

  it.each([
    ["未知授权范围", { availability_scope_key: undefined }],
    ["失败状态", { status: "failed" }],
    ["无完整组", { groups: [] }],
    ["回执非首页", { page: 2 }],
    ["请求非首页", { request: { ...spec, page: 2 } }],
    ["顶层还有后页", { has_more: true }],
    [
      "有未返回的日期",
      {
        groups: [
          {
            date_count: 9,
            earliest: "2026-05-31",
            latest: "2026-08-27",
            dates: allDates,
            has_more: false,
          },
        ],
      },
    ],
    [
      "旧组未声明分页结束",
      { groups: [{ date_count: 0, earliest: null, latest: null, dates: [] }] },
    ],
    [
      "非法日期",
      {
        groups: [
          {
            date_count: 1,
            earliest: "2026-02-30",
            latest: "2026-02-30",
            dates: ["2026-02-30"],
            has_more: false,
          },
        ],
      },
    ],
    [
      "重复日期",
      {
        groups: [
          {
            date_count: 2,
            earliest: "2026-08-27",
            latest: "2026-08-27",
            dates: ["2026-08-27", "2026-08-27"],
            has_more: false,
          },
        ],
      },
    ],
    ["来自派生子页", { reused: true, availability_source_key: "earlier" }],
    [
      "任何一组未完",
      {
        groups: [
          ...coverage(spec).groups,
          { date_count: 1, earliest: null, latest: null, dates: [], has_more: true },
        ],
      },
    ],
  ])("%s不能成为完整覆盖证明", (_name, details) => {
    expect(reusableAvailability([source(details)], "scope", child)).toBeUndefined();
  });

  it("按match和完整指标/机构集合区分证据，顺序变化不影响集合", () => {
    expect(
      reusableAvailability([source()], "scope", { ...child, metric_codes: ["M2", "M1"] })
        ?.sourceKey,
    ).toBe("original");
    for (const change of [
      { match: "all" as const },
      { metric_codes: ["M1"] },
      { org_codes: ["3201"] },
    ])
      expect(reusableAvailability([source()], "scope", { ...child, ...change })).toBeUndefined();
  });

  it("仅使用当前轮首次完整原始来源，不把派生页提升为来源", () => {
    const derived = source({
      reused: true,
      availability_key: "derived",
      availability_source_key: "original",
    });
    expect(
      reusableAvailability(
        [source(), derived, source({ availability_key: "later" })],
        "scope",
        child,
      )?.sourceKey,
    ).toBe("original");
    expect(
      reusableAvailability(
        [source(), { role: "user", content: "下一轮", timestamp: 1 }, derived],
        "scope",
        child,
      ),
    ).toBeUndefined();
  });

  it("授权身份包含绑定版本、目标、实际机构和范围指纹，不依赖显示名称或排列", () => {
    const { request } = fixture();
    const orgs: ResolvedOrganizations = {
      codes: ["3200", "3201"],
      names: ["甲", "乙"],
      scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
      scope_fingerprint: "version-1",
    };
    const key = availabilityScopeKey(request, ["s1", "s2"], orgs);
    expect(
      availabilityScopeKey(request, ["s2", "s1"], {
        ...orgs,
        codes: ["3201", "3200"],
        names: ["其他名称"],
      }),
    ).toBe(key);
    for (const change of [
      { operationId: "other-op" },
      { sessionId: "other-session" },
      { actor: { ...request.actor, id: "other-user" } },
    ])
      expect(availabilityScopeKey({ ...request, ...change }, ["s1", "s2"], orgs)).not.toBe(key);
    for (const change of [
      { scope_fingerprint: "version-2" },
      { codes: ["3200"] },
      { scope: { kind: "children_of" as const, parent_code: "3200" } },
    ])
      expect(availabilityScopeKey(request, ["s1", "s2"], { ...orgs, ...change })).not.toBe(key);
    expect(availabilityScopeKey(request, ["s1-v2", "s2"], orgs)).not.toBe(key);
    expect(availabilityScopeKey(request, ["s1", "s2"], orgs, "target:new")).not.toBe(key);
  });
});
