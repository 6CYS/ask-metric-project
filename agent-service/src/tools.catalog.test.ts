/**
 * metric_catalog_search / org_catalog_search 工具测试：
 * 检索委托后端受治理接口，透传 keyword/limit，原样返回 total 与分层命中。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetricCatalogSearchTool } from "./tools/metricCatalogSearch.js";
import { createOrgCatalogSearchTool } from "./tools/orgCatalogSearch.js";
import { BackendClient } from "./backendClient.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "./tools/testUtils.js";

const metricSearchPayload = {
  total: 13,
  items: [
    {
      metric_code: "LOAN_BAL_PROV_AVG",
      metric_name: "个人经营性贷款余额全省均值",
      unit: "万元",
      synonyms: [],
      score: 1.0,
      match_type: "exact",
    },
    {
      metric_code: "LOAN_BAL_DAILY",
      metric_name: "个人经营性贷款余额当日数",
      unit: "万元",
      synonyms: [],
      score: 0.692,
      match_type: "contains",
    },
  ],
  semantic_suggestions: [
    {
      metric_code: "LOAN_BAL_CMP_AVG",
      metric_name: "个人经营性贷款余额较全省均值",
      unit: "万元",
      synonyms: [],
      score: 0.81,
      match_type: "semantic",
    },
  ],
};

const orgSearchPayload = {
  total: 1,
  items: [
    {
      org_code: "321322000",
      org_name: "沭阳农商行",
      aliases: [],
      score: 1.0,
      match_type: "exact",
    },
  ],
};

function stubFetch(payload: unknown, calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("metric_catalog_search 工具", () => {
  const calls: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  it("透传 keyword 与 limit 到后端检索接口，原样返回分层结果", async () => {
    stubFetch(metricSearchPayload, calls);
    const tool = createMetricCatalogSearchTool();
    const result = await runTool(tool, { keyword: "个人经营性贷款余额全省均值", limit: 10 }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(calls[0]).toBe(
      "http://backend.test/api/v1/catalog/metrics/search?"
      + new URLSearchParams({ keyword: "个人经营性贷款余额全省均值", limit: "10" }),
    );
    const content = JSON.parse((result.content[0] as { text: string }).text);
    // total 是后端切片前的全量命中数，不得被截断覆盖
    expect(content.total).toBe(13);
    expect(content.has_more).toBe(true);
    expect(content.items).toHaveLength(2);
    expect(content.items[0].match_type).toBe("exact");
    expect(content.semantic_suggestions[0].match_type).toBe("semantic");
    expect(content.usage_hint).toContain("不得据此锁定编码");
    expect(result.details?.kind).toBe("metric_catalog_search");
    expect(result.details?.total).toBe(13);
  });

  it("limit 缺省为 10，未命中时 has_more 为 false", async () => {
    stubFetch({ total: 0, items: [], semantic_suggestions: [] }, calls);
    const tool = createMetricCatalogSearchTool();
    const result = await runTool(tool, { keyword: "不存在的指标" }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(calls[0]).toContain("limit=10");
    const content = JSON.parse((result.content[0] as { text: string }).text);
    expect(content.total).toBe(0);
    expect(content.has_more).toBe(false);
    expect(content.usage_hint).toContain("不要断定指标不存在");
  });
});

describe("org_catalog_search 工具", () => {
  const calls: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  it("透传 keyword 到后端机构检索接口并返回确定性命中", async () => {
    stubFetch(orgSearchPayload, calls);
    const tool = createOrgCatalogSearchTool();
    const result = await runTool(tool, { keyword: "沭阳农商行", limit: 5 }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    expect(calls[0]).toBe(
      "http://backend.test/api/v1/catalog/organizations/search?"
      + new URLSearchParams({ keyword: "沭阳农商行", limit: "5" }),
    );
    const content = JSON.parse((result.content[0] as { text: string }).text);
    expect(content.total).toBe(1);
    expect(content.has_more).toBe(false);
    expect(content.items[0].org_code).toBe("321322000");
    expect(content.usage_hint).toContain("不得猜测编码");
    expect(result.details?.kind).toBe("org_catalog_search");
  });

  it("空结果如实返回，提示改用 metric_ask 传原句", async () => {
    stubFetch({ total: 0, items: [] }, calls);
    const tool = createOrgCatalogSearchTool();
    const result = await runTool(tool, { keyword: "泗阳" }, testRequestContext(new BackendClient("http://backend.test", "user-token", 5000), new MemoryCommandBridge()));
    const content = JSON.parse((result.content[0] as { text: string }).text);
    expect(content.total).toBe(0);
    expect(content.items).toHaveLength(0);
    expect(content.usage_hint).toContain("metric_ask");
  });
});
