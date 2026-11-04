import { expect, it, vi } from "vitest";
import {
  analysisCandidates,
  catalogBindingState,
  restoreAnalysisDiscovery,
} from "../src/analysis/bindings.js";
import type { BackendClient } from "../src/backendClient.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

it.each(["classification", "composition"])(
  "%s 预置关系经过原生目录工具投影仍保留导航边界和可恢复的关联引用",
  async (kind) => {
    const relation = {
      id: "topic:deposit:customers",
      kind,
      status: "draft",
      parent: "total",
      children: ["personal", "company"],
      source: "客户分类仅供观察，完整组成仍待确认。",
      origin: "topic",
      editable: false,
      topic: "deposit",
      usage: "navigation_only",
      notice: "仅供发现，不授权结构计算或完整增减贡献。",
    };
    const backend = {
      analysisCatalog: vi.fn<BackendClient["analysisCatalog"]>().mockResolvedValue({
        keyword: "total",
        total: 1,
        page: 1,
        page_size: 12,
        has_more: false,
        items: [{ code: "total", name: "各项存款", unit: "元", binding_ref: "signed-total" }],
        related_metrics: [
          { code: "personal", name: "个人存款", unit: "元", binding_ref: "signed-personal" },
          { code: "company", name: "对公存款", unit: "元", binding_ref: "signed-company" },
        ],
        relations: [relation],
        has_more_relations: false,
      }),
    } as unknown as BackendClient;
    const context = testRequestContext(backend, new MemoryCommandBridge());
    const tool = createInquiryQueryTools().find((item) => item.name === "metric_search");
    if (!tool) throw new Error("metric_search 未注册");
    const result = (await runTool(tool, { keywords: ["total"] }, context)) as {
      content: [{ type: "text"; text: string }];
      details: Record<string, unknown>;
    };
    const nativeContent: unknown = JSON.parse(result.content[0].text);

    expect(nativeContent).toMatchObject({
      items: [{ code: "total", binding_ref: "k1" }],
      results: [
        {
          relations: [relation],
          related_metrics: [
            { code: "personal", binding_ref: "k2" },
            { code: "company", binding_ref: "k3" },
          ],
          has_more_relations: false,
        },
      ],
    });
    expect(result.content[0].text).not.toContain("signed-");
    expect(result.details).toMatchObject({
      kind: "analysis_catalog",
      status: "succeeded",
      binding_map: { k1: "signed-total", k2: "signed-personal", k3: "signed-company" },
      candidate_map: [
        { code: "total", binding_ref: "k1" },
        { code: "personal", binding_ref: "k2" },
        { code: "company", binding_ref: "k3" },
      ],
    });

    const restored = testRequestContext(backend, new MemoryCommandBridge());
    restoreAnalysisDiscovery(restored, [result.details]);
    expect(analysisCandidates(restored)).toMatchObject([
      { code: "total", binding_ref: "k1" },
      { code: "personal", binding_ref: "k2" },
      { code: "company", binding_ref: "k3" },
    ]);
    expect(catalogBindingState(restored)).toMatchObject({
      "code:personal": "signed-personal",
      "code:company": "signed-company",
      k2: "signed-personal",
      k3: "signed-company",
    });
  },
);
