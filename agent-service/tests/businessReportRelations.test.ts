import {describe, expect, it} from "vitest";
import {composeBusinessReport, type OverviewEvidence} from "../src/tools/businessReport.js";

const source: OverviewEvidence = {kind: "business_overview", status: "succeeded", topic: "loan", topic_version: "test-v1",
  analysis_date: "2026-09-30", requested_date: "2026-09-30", org_codes: ["O1"], org_name: "测试机构", basis: "测试口径",
  evidence_items: [
    {ref: "a.current", display: "50元", label: "指标甲", value: "50"},
    {ref: "b.current", display: "30元", label: "指标乙", value: "30"},
    {ref: "a.mom.difference", display: "-2元", label: "指标甲较上月", value: "-2"},
    {ref: "b.mom.difference", display: "-1元", label: "指标乙较上月", value: "-1"},
    {ref: "a.yoy.difference", display: "4元", label: "指标甲较同期", value: "4"},
    {ref: "b.yoy.difference", display: "3元", label: "指标乙较同期", value: "3"},
    {ref: "finding.a", display: "指标甲较上月减少、较同期增加。", label: "已核验判断",
      judgment_kind: "baseline_divergence", input_refs: ["a.mom.difference", "a.yoy.difference"]},
    {ref: "finding.b", display: "指标乙较上月减少、较同期增加。", label: "已核验判断",
      judgment_kind: "baseline_divergence", input_refs: ["b.mom.difference", "b.yoy.difference"]},
  ], table_rows: [{metric_id: "a", 指标: "指标甲", 当前值: "50元", 较上月: "-2元", 较同期: "4元"},
    {metric_id: "b", 指标: "指标乙", 当前值: "30元", 较上月: "-1元", 较同期: "3元"}],
  table_columns: [], tasks: [], gaps: []};
const report = (summary: string) => composeBusinessReport([source], {
  evidence_refs: ["e1"], summary, sections: [], metric_ids: ["a", "b"],
});

describe("自然业务正文与证据关系", () => {
  it.each([
    "两项指标较上月同向回落{{a.mom.difference|cite}}{{b.mom.difference|cite}}，较同期均有增长{{a.yoy.difference|cite}}{{b.yoy.difference|cite}}。",
    "指标甲和指标乙的月度比较方向一致，分别减少{{a.mom.difference}}和{{b.mom.difference}}。",
    "指标甲较上月减少{{a.mom.difference}}，但同比仍有增长{{a.yoy.difference|cite}}，需要区分比较基期。",
  ])("保留模型基于事实组织的业务关系解释：%s", body => {
    const result = report(body);
    expect(result.status).toBe("succeeded");
    expect(result.report.summary).toContain(body.split("{{")[0]);
    expect(result.report.body_evidence.flatMap(item => item.evidence_refs)).toContain("a.mom.difference");
  });

  it("程序判断可作为引用依据，无需复制固定句子", () => {
    const result = report("指标甲在不同比较基期呈现分化{{finding.a|cite}}，当前为{{a.current}}。" );
    expect(result.report.summary).toBe("指标甲在不同比较基期呈现分化，当前为50元。");
    expect(result.report.body_evidence[0]?.evidence_refs).toEqual(
      expect.arrayContaining(["finding.a", "a.mom.difference", "a.yoy.difference", "a.current"]));
  });

  it("保留有边界的业务解释与核实建议", () => {
    const body = "指标甲为{{a.current}}，较上月下降{{a.mom.difference|cite}}。是否主动压降，需要结合实际管理措施核实。";
    expect(report(body).report.summary).toContain("是否主动压降，需要结合实际管理措施核实。");
  });

  it.each(["{{unknown}}", "{{unknown|cite}}"])("自然关系解释仍须使用有效依据：%s", reference => {
    expect(() => report(`指标甲有所回落${reference}。`)).toThrow(/不存在证据/u);
  });

  it("拒绝脱离证据的数值，不能靠自然措辞放行", () => {
    expect(() => report("两项指标有所回落，指标甲减少999元。" )).toThrow(/业务数字/u);
  });
});
