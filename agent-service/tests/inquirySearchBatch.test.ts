import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { analysisCandidates } from "../src/analysis/bindings.js";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

interface SearchResult {
  content: [{ text: string }];
  details: { binding_map: Record<string, string> };
}

function fixture() {
  const analysisCatalog = vi.fn<BackendClient["analysisCatalog"]>((keyword, page, pageSize) =>
    Promise.resolve({
      items: [{ code: keyword, name: keyword, unit: "元", binding_ref: `signed:${keyword}` }],
      total: 1,
      page,
      page_size: pageSize,
      has_more: false,
    }),
  );
  const request = testRequestContext(
    { analysisCatalog } as unknown as BackendClient,
    new MemoryCommandBridge(),
  );
  const tool = createInquiryQueryTools().find((item) => item.name === "metric_search");
  if (!tool) throw new Error("metric_search 未注册");
  const validate = (input: Record<string, unknown>): void => {
    validateToolArguments(tool, {
      type: "toolCall",
      id: "batch-search",
      name: tool.name,
      arguments: input,
    });
  };
  return { analysisCatalog, request, tool, validate };
}

// 先走原生参数校验，再执行真实检索与引用绑定；仅隔离目录HTTP边界。
describe("业务检索批容量与后端并发分别约束", () => {
  it.each([5, 32])("%d项检索通过原生schema，完整绑定且最多4项并发", async (count) => {
    const f = fixture();
    const keywords = Array.from({ length: count }, (_, index) => `M${index + 1}`);
    const input = { keywords, page: 1, page_size: 12 };
    expect(() => f.validate(input)).not.toThrow();
    const catalog = f.analysisCatalog.getMockImplementation()!;
    let active = 0,
      maximum = 0;
    f.analysisCatalog.mockImplementation(async (...args) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await catalog(...args);
      } finally {
        active--;
      }
    });
    const result = (await runTool(f.tool, input, f.request)) as SearchResult;
    expect(maximum).toBeLessThanOrEqual(4);
    expect(f.analysisCatalog.mock.calls.map(([keyword]) => keyword)).toEqual(keywords);
    const view = JSON.parse(result.content[0].text) as {
      items: Array<{ code: string; binding_ref: string }>;
    };
    expect(view.items.map((item) => item.code)).toEqual(keywords);
    expect(view.items.map((item) => item.binding_ref)).toEqual(
      keywords.map((_, index) => `k${index + 1}`),
    );
    expect(result.content[0].text).not.toContain("signed:");
    expect(result.details.binding_map).toEqual(
      Object.fromEntries(
        keywords.flatMap((keyword, index) => [
          [`k${index + 1}`, `signed:${keyword}`],
          [`code:${keyword}`, `signed:${keyword}`],
        ]),
      ),
    );
    expect(analysisCandidates(f.request).map((item) => item.code)).toEqual(keywords);
  });

  it("33项仍被原生schema拒绝，不访问目录", () => {
    const f = fixture();
    expect(() =>
      f.validate({ keywords: Array.from({ length: 33 }, (_, index) => `M${index}`) }),
    ).toThrow();
    expect(f.analysisCatalog).not.toHaveBeenCalled();
  });

  it.each([
    { keywords: ["字".repeat(201)] },
    { keywords: ["余额"], page: 0 },
    { keywords: ["余额"], page_size: 31 },
  ])("保留关键词长度和分页校验：%j", (input) => {
    const f = fixture();
    expect(() => f.validate(input)).toThrow();
  });

  it("trim去重后不重复访问或注册同一关键词", async () => {
    const f = fixture();
    const input = { keywords: [" M1 ", "M2", "M3", "M4", "M1", "M5"] };
    f.validate(input);
    const result = (await runTool(f.tool, input, f.request)) as SearchResult;
    expect(f.analysisCatalog.mock.calls.map(([keyword]) => keyword)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
      "M5",
    ]);
    expect(Object.keys(result.details.binding_map)).toHaveLength(10);
    expect(analysisCandidates(f.request)).toHaveLength(5);
  });

  it("取消后不启动后续批，也不登记不完整来源", async () => {
    const f = fixture(),
      controller = new AbortController();
    const input = { keywords: ["M1", "M2", "M3", "M4", "M5"] };
    f.validate(input);
    const catalog = f.analysisCatalog.getMockImplementation()!;
    const reason = new Error("ISOLATED_SEARCH_CANCELLED");
    f.analysisCatalog.mockImplementation(async (...args) => {
      if (args[0] === "M4") controller.abort(reason);
      return catalog(...args);
    });
    await expect(
      runTool(f.tool, input, f.request, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
    ).rejects.toBe(reason);
    expect(f.analysisCatalog.mock.calls.map(([keyword]) => keyword)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
    ]);
    expect(
      f.analysisCatalog.mock.calls.every((call) => call[3]?.signal === controller.signal),
    ).toBe(true);
    expect(analysisCandidates(f.request)).toEqual([]);
  });

  it.each([403, 503])("目录%s保持失败语义，不启动后续批或交付部分成功", async (status) => {
    const f = fixture();
    const input = { keywords: ["M1", "M2", "M3", "M4", "M5"] };
    f.validate(input);
    const catalog = f.analysisCatalog.getMockImplementation()!;
    const failure = new BackendApiError(status, "隔离目录失败", "ISOLATED_CATALOG_FAILURE");
    f.analysisCatalog.mockImplementation(async (...args) => {
      if (args[0] === "M3") throw failure;
      return catalog(...args);
    });
    await expect(runTool(f.tool, input, f.request)).rejects.toBe(failure);
    expect(f.analysisCatalog.mock.calls.map(([keyword]) => keyword)).toEqual([
      "M1",
      "M2",
      "M3",
      "M4",
    ]);
    expect(analysisCandidates(f.request)).toEqual([]);
  });
});
