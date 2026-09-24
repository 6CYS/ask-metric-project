import { expect, it, vi } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { BackendApiError, type BackendClient } from "../backendClient.js";
import { businessEvidence } from "../answerEvidence.js";
import { unconfirmedToolCodes } from "../queryContext.js";
import { createBusinessSkillReadTool } from "../businessSkills.js";
import { createAskMetricTools } from "./index.js";
import { createCatalogTool } from "./catalog.js";
import { MemoryCommandBridge, receiptJson, runTool, testRequestContext } from "./testUtils.js";

const queries = [{entity: "metric", keyword: "完整指标"}, {entity: "organization", keyword: "测试行"}];
const request = (backend: unknown) => testRequestContext(backend as BackendClient, new MemoryCommandBridge());

it("同批独立检索并发开始，返回顺序和各项匹配、截断信息保持稳定", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  const started: string[] = [];
  const backend = {
    searchMetrics: vi.fn(async () => {
      started.push("metric"); await pending;
      return {total: 3, items: [{metric_code: "M", match_type: "exact"}, {metric_code: "OTHER", match_type: "contains"}],
        semantic_suggestions: [{metric_code: "APPROX", match_type: "semantic"}]};
    }),
    searchOrganizations: vi.fn(async () => {started.push("organization"); return {total: 1, items: [{org_code: "O", match_type: "exact"}]};}),
  };
  const execution = runTool(createCatalogTool(), {action: "search", queries}, request(backend));
  expect(started).toEqual(["metric", "organization"]);
  release();
  const result = await execution;
  const payload = receiptJson(result) as {results: Array<Record<string, unknown>>};
  expect(payload.results[0]).toMatchObject({entity: "metric", keyword: "完整指标", total: 3, has_more: true});
  expect(payload.results[1]).toMatchObject({entity: "organization", total: 1, has_more: false});
  expect(businessEvidence(result.details)).toBeUndefined();
  const messages = [{role: "toolResult", toolName: "catalog", ...result}];
  expect(unconfirmedToolCodes(messages, {metric_codes: ["M"], org_codes: ["O"]})).toEqual([]);
  expect(unconfirmedToolCodes(messages, {metric_codes: ["OTHER", "APPROX"]})).toEqual(["metric_codes"]);
});

it("单项失败明确标记为 partial，成功项仍可确认，不能把失败伪装成空结果", async () => {
  const result = await runTool(createCatalogTool(), {action: "search", queries}, request({
    searchMetrics: async () => {throw new BackendApiError(503, "internal secret", "UNAVAILABLE");},
    searchOrganizations: async () => ({total: 1, items: [{org_code: "O", match_type: "exact"}]}),
  }));
  expect(receiptJson(result)).toMatchObject({status: "partial", results: [
    {entity: "metric", status: "error", error_code: "UNAVAILABLE"}, {entity: "organization", status: "succeeded"},
  ]});
  expect(JSON.stringify(result)).not.toContain("internal secret");
  expect(unconfirmedToolCodes([{role: "toolResult", toolName: "catalog", ...result}], {org_codes: ["O"], metric_codes: ["M"]})).toEqual(["metric_codes"]);
});

it.each([401, 403])("鉴权失败 %s 整体传播，不作为普通检索失败继续", async status => {
  const error = new BackendApiError(status, "denied", "FORBIDDEN");
  await expect(runTool(createCatalogTool(), {action: "search", queries: [queries[0]]}, request({
    searchMetrics: async () => {throw error;},
  }))).rejects.toBe(error);
});

it("新入口有八个公开工具，概览仍生成可交付回执", async () => {
  const tools = [...createAskMetricTools(), createBusinessSkillReadTool([])];
  expect(tools.map(tool => tool.name)).toEqual([
    "business_capability_explain", "resolve_business_turn", "business_context_read", "execute_business_frame",
    "read_business_result", "read", "catalog", "business_skill_read",
  ]);
  const result = await runTool(tools.find(tool => tool.name === "catalog")!, {action: "overview"}, request({
    metricCatalogOverview: async () => ({total: 2, groups: []}),
  }));
  expect(businessEvidence(result.details)).toMatchObject({kind: "metric_catalog_overview", status: "catalog", delivery: "business_evidence_v1"});
});

it.each([
  {action: "search", queries: []},
  {action: "search", queries: Array(5).fill(queries[0])},
  {action: "search", queries: [{entity: "unknown", keyword: "a"}]},
  {action: "overview", queries},
])("拒绝空批次、过大批次、未知类型与混用参数 %j", args => {
  expect(() => validateToolArguments(createCatalogTool(), {type: "toolCall", id: "test", name: "catalog", arguments: args})).toThrow();
});
