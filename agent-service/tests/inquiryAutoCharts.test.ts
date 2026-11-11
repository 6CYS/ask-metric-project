import { describe, expect, it, vi } from "vitest";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { buildInquiryChart } from "../src/inquiry/chartTool.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";

// 隔离已有事实及正式关系，实际业务数据不由此夹具提供。
function fixture(organizations = ["A"]) {
  const ids = ["total", "personal", "company"];
  const values = ["100.0000", "60.0000", "40.0000"];
  const evidence = {
    kind: "analysis_evidence",
    status: "succeeded",
    metric_descriptors: ids.map((id) => ({
      code: id.toUpperCase(),
      name: id,
      value_basis: "current",
      analysis_hint: { topic: "deposit", metric_id: id },
    })),
    evidence_items: organizations.flatMap((org) =>
      ids.map((id, index) => ({
        ref: `${org}.${id}`,
        type: "fact",
        metric_code: id.toUpperCase(),
        metric_name: id,
        org_code: org,
        org_name: org,
        date: "2026-08-31",
        unit: "元",
        value: values[index]!,
        display: `${values[index]}元`,
      })),
    ),
  };
  const topic = {
    metrics: ids.map((id) => ({ id, code: id.toUpperCase(), label: id, value_basis: "current" })),
    relationships: [{ parent: "total", children: ["personal", "company"], pie_chart: true }],
  };
  const businessTopic = vi.fn<BackendClient["businessTopic"]>().mockResolvedValue(topic);
  const request = testRequestContext(
    { businessTopic } as unknown as BackendClient,
    new MemoryCommandBridge(),
  );
  const sources = [{ ref: "e1", evidence }];
  const refs = evidence.evidence_items.map((atom) => atom.ref);
  return { evidence, topic, businessTopic, request, sources, refs };
}

describe("按已有事实和正式关系自动选图", () => {
  it("单机构完整组成自动配结构图，保留原精度且总量不作为扇区", async () => {
    const test = fixture();
    const result = await buildInquiryChart(test.sources, undefined, test.request, test.refs);
    expect(result.charts).toEqual([
      {
        type: "pie",
        title: "A · total结构",
        date: "2026-08-31",
        unit: "元",
        source_refs: test.refs,
        points: [
          { name: "personal", value: "60.0000", display: "60.0000元", share: "60.00%" },
          { name: "company", value: "40.0000", display: "40.0000元", share: "40.00%" },
        ],
      },
    ]);
    expect(test.businessTopic).toHaveBeenCalledOnce();
  });

  it("无组成候选的普通比较不读取或检查组成关系", async () => {
    const test = fixture(["A", "B"]);
    const refs = ["A.total", "B.total"];
    test.businessTopic.mockRejectedValue(new Error("比较不应访问关系服务"));
    const result = await buildInquiryChart(test.sources, undefined, test.request, refs);
    expect(result.charts).toMatchObject([{ type: "bar", source_refs: refs }]);
    expect(test.businessTopic).not.toHaveBeenCalled();
  });

  it("只引用总额时不为凑组成图扩大正文数据范围", async () => {
    const test = fixture();
    expect(
      (await buildInquiryChart(test.sources, undefined, test.request, ["A.total"])).charts,
    ).toEqual([]);
    expect(test.businessTopic).not.toHaveBeenCalled();
  });

  it("关系服务失败保留普通比较，同一主题只读取一次", async () => {
    const test = fixture(["A", "B"]);
    test.businessTopic.mockRejectedValue(new BackendApiError(503, "暂时不可用"));
    const result = await buildInquiryChart(test.sources, undefined, test.request, test.refs);
    expect(result.charts.map((chart) => chart.type)).toEqual(["bar", "bar", "bar"]);
    expect(result.notice).toBeUndefined();
    expect(test.businessTopic).toHaveBeenCalledOnce();
  });

  it("组成不成立只取消结构图，仍允许真实金额的普通比较", async () => {
    const test = fixture(["A", "B"]);
    test.topic.relationships[0]!.pie_chart = false;
    const result = await buildInquiryChart(test.sources, undefined, test.request, test.refs);
    expect(result.charts.map((chart) => chart.type)).toEqual(["bar", "bar", "bar"]);
  });

  it.each([401, 403])("关系读取权限失败%d继续向调用方传播", async (status) => {
    const test = fixture();
    const error = new BackendApiError(status, "没有权限");
    test.businessTopic.mockRejectedValue(error);
    await expect(buildInquiryChart(test.sources, undefined, test.request, test.refs)).rejects.toBe(
      error,
    );
  });

  it("显式普通比较不因存在组成元数据而检查组成关系", async () => {
    const test = fixture(["A", "B"]);
    const refs = ["A.total", "B.total"];
    const result = await buildInquiryChart(
      test.sources,
      { type: "bar", evidence_refs: refs },
      test.request,
    );
    expect(result.charts).toMatchObject([{ type: "bar", source_refs: refs }]);
    expect(test.businessTopic).not.toHaveBeenCalled();
  });
});
