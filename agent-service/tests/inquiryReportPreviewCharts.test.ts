import { describe, expect, it, vi } from "vitest";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { createInquiryReportPreview } from "../src/inquiry/reportTool.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";

function fixture() {
  const evidence = {
    kind: "analysis_evidence",
    status: "succeeded",
    run_ref: "run",
    execution_turn_id: "op-1",
    metric_descriptors: ["M1", "M2"].map((code) => ({
      code,
      name: code,
      unit: "元",
      value_basis: "current",
    })),
    evidence_items: ["M1", "M2"].flatMap((metric) =>
      ["A", "B"].map((org) => ({
        ref: `${metric}.${org}`,
        type: "fact",
        metric_code: metric,
        metric_name: metric,
        org_code: org,
        org_name: org,
        date: "2026-08-31",
        unit: "元",
        value: "1.2500",
        display: "1.2500元",
      })),
    ),
  };
  const analysisReport = vi.fn<BackendClient["analysisReport"]>();
  const request = testRequestContext(
    { analysisReport } as unknown as BackendClient,
    new MemoryCommandBridge(),
    {
      answerEvidence: () => Promise.resolve([{ ref: "e1", evidence }]),
      answerStream: { callSeq: 1, mode: "text" },
    },
  );
  return { request, analysisReport, preview: createInquiryReportPreview() };
}
const first = "## 规模\n\n甲{{M1.A}}，乙{{M1.B}}。";
const second = "## 盈利\n\n甲{{M2.A}}，乙{{M2.B}}。";
const response = (metric: string, title: string) => ({
  kind: "analysis_report_preview",
  status: "succeeded",
  preview_text: `## ${title}\n\n甲1.2500元，乙1.2500元。`,
  body_evidence: [
    { paragraph: 1, evidence_refs: [] },
    { paragraph: 2, evidence_refs: [`${metric}.A`, `${metric}.B`] },
  ],
});

describe("已核验预览图表", () => {
  it("首个章节核验后即可配图，未进入正文的指标不提前展示", async () => {
    const test = fixture();
    test.analysisReport.mockResolvedValue(response("M1", "规模"));
    const result = await test.preview(first, test.request);
    expect(result).toMatchObject({
      text: "## 规模\n\n甲1.2500元，乙1.2500元。",
      charts: [
        {
          type: "bar",
          source_refs: ["M1.A", "M1.B"],
          placement: { after_paragraph: 2 },
          points: [
            { name: "A", value: "1.2500" },
            { name: "B", value: "1.2500" },
          ],
        },
      ],
    });
    expect(result).toHaveProperty("charts.length", 1);
  });

  it("缓存章节的引用与新增段号正确合并，旧图来源和位置稳定", async () => {
    const test = fixture();
    test.analysisReport
      .mockResolvedValueOnce(response("M1", "规模"))
      .mockResolvedValueOnce(response("M2", "盈利"));
    const initial = await test.preview(first, test.request);
    const next = await test.preview(first + "\n\n" + second, test.request);
    expect(test.analysisReport.mock.calls[1]?.[0].summary).toBe(second);
    expect(next).toHaveProperty("charts.length", 2);
    expect(next).toMatchObject({
      charts: [
        { source_refs: ["M1.A", "M1.B"], placement: { after_paragraph: 2 } },
        { source_refs: ["M2.A", "M2.B"], placement: { after_paragraph: 4 } },
      ],
    });
    if (typeof initial !== "object" || !initial || typeof next !== "object" || !next)
      throw new Error("缺少图表预览");
    expect(next.charts?.[0]).toEqual(initial.charts?.[0]);
  });

  it("无引用的已核验正文明确发送空图集，不能从草稿引用构图", async () => {
    const test = fixture();
    test.analysisReport.mockResolvedValue({
      ...response("M1", "规模"),
      body_evidence: [
        { paragraph: 1, evidence_refs: [] },
        { paragraph: 2, evidence_refs: [] },
      ],
    });
    expect(await test.preview(first, test.request)).toMatchObject({ charts: [] });
  });

  it("权限失败不产出图文预览", async () => {
    const test = fixture();
    const error = new BackendApiError(403, "禁止访问", "FORBIDDEN");
    test.analysisReport.mockRejectedValue(error);
    await expect(test.preview(first, test.request)).rejects.toBe(error);
  });

  it.each([undefined, [{ paragraph: 4, evidence_refs: ["M1.A", "M1.B"] }]])(
    "旧后端或无效段号只交付文字",
    async (mapping) => {
      const test = fixture();
      test.analysisReport.mockResolvedValue({ ...response("M1", "规模"), body_evidence: mapping });
      expect(await test.preview(first, test.request)).toBe("## 规模\n\n甲1.2500元，乙1.2500元。");
    },
  );

  it("后端映射中途缺失时明确清除已发布图集", async () => {
    const test = fixture();
    test.analysisReport
      .mockResolvedValueOnce(response("M1", "规模"))
      .mockResolvedValueOnce({ ...response("M2", "盈利"), body_evidence: undefined });
    await test.preview(first, test.request);
    expect(await test.preview(first + "\n\n" + second, test.request)).toMatchObject({ charts: [] });
  });

  it("前文无映射时新增段映射不能补认前文草稿", async () => {
    const test = fixture();
    test.analysisReport
      .mockResolvedValueOnce({ ...response("M1", "规模"), body_evidence: undefined })
      .mockResolvedValueOnce(response("M2", "盈利"));
    await test.preview(first, test.request);
    expect(await test.preview(first + "\n\n" + second, test.request)).toBe(
      "## 规模\n\n甲1.2500元，乙1.2500元。\n\n## 盈利\n\n甲1.2500元，乙1.2500元。",
    );
  });

  it("预览被撤回后晚到的核验响应不生成图，也不写入下次缓存", async () => {
    const test = fixture();
    let complete!: (value: Record<string, unknown>) => void;
    test.analysisReport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = test.preview(first, test.request, controller.signal);
    await vi.waitFor(() => expect(test.analysisReport).toHaveBeenCalledOnce());
    controller.abort();
    complete(response("M1", "规模"));
    await expect(pending).rejects.toThrow();
    test.analysisReport.mockResolvedValue(response("M2", "盈利"));
    await test.preview(first + "\n\n" + second, test.request);
    expect(test.analysisReport.mock.calls[1]?.[0].summary).toBe(first + "\n\n" + second);
  });
});
