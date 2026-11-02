import {describe, expect, it} from "vitest";
import {composeBusinessReport, composePartialBusinessReport, type OverviewEvidence} from "../src/tools/businessReport.js";

const source: OverviewEvidence = {kind: "business_overview", status: "succeeded", topic: "deposit", topic_version: "test-v1",
  analysis_date: "2026-09-30", requested_date: "2026-09-30", org_codes: ["O1"], org_name: "测试机构", basis: "测试口径",
  evidence_items: [
    {ref: "total.current", display: "100元", label: "存款余额", value: "100"},
    {ref: "total.mom.difference", display: "5元", label: "较上月差额", value: "5"},
    {ref: "total.yoy.difference", display: "-2元", label: "较同期差额", value: "-2"},
    {ref: "total.ytd.difference", display: "0元", label: "较年初差额", value: "0"},
    {ref: "judgment.total.mom.direction", display: "各项存款较上月增长。", label: "已核验方向", judgment_kind: "direction",
      input_refs: ["total.mom.difference"]},
  ], table_rows: [{metric_id: "total", 指标: "各项存款", 当前值: "100元", 较上月: "5元", 较同期: "-2元", 较年初: "0元"}],
  table_columns: [], tasks: [], gaps: []};
const input = (summary: string) => ({evidence_refs: ["e1"], summary, sections: [], metric_ids: ["total"]});

describe("专项报告比较判断的证据边界", () => {
  it.each([
    "存款呈现不同基期的分化：较上月多{{total.mom.difference}}，较同期少{{total.yoy.difference}}。",
    "存款较上月保持增长{{total.mom.difference|cite}}，较同期有所回落{{total.yoy.difference|cite}}。",
    "较上月的增长与较同期的下降方向不同{{total.mom.difference|cite}}{{total.yoy.difference|cite}}，需要结合更长时间序列理解。",
  ])("自然业务改述不受固定句式限制：%s", body => {
    const result = composeBusinessReport([source], input(body));
    expect(result.status).toBe("succeeded");
    expect(result.report.summary).toContain(body.split("{{")[0]);
  });
  it("余额分析可以提出需要流水核验的资金迁移问题", () => {
    const text = "存款余额{{total.current}}。资金是否从活期转入定期，需要账户流水核实。";
    expect(composeBusinessReport([source], input(text)).report.summary).toContain("资金是否从活期转入定期");
  });

  it.each(["100 元", "**100 元**", "__100 元__", "**100** 元", "100 **元**", "**100** **元**"])(
    "唯一正式数值的单位空格与加粗不改变引用：%s", value => {
      const report = composeBusinessReport([source], input(`各项存款余额为${value}。`));
      expect(report.report.summary.replaceAll("**", "").replaceAll("__", "")).toBe("各项存款余额为100元。");
      expect(report.report.body_evidence).toEqual([{paragraph: 1, evidence_refs: ["total.current"]}]);
    });

  it.each(["101 元", "100 万元", "-100 元", "-**100 元**", "-__100 元__", "-**100** 元", "-100 **元**"])("不将错误值、单位或符号绑定为正式引用：%s", value => {
    expect(() => composeBusinessReport([source], input(`各项存款余额为${value}。`))).toThrow(/业务数字/u);
  });

  it.each(["-2 元", "**-2 元**", "__-2 元__", "**-2** 元", "-2 **元**", "**-2** **元**"])(
    "正式负数的符号与加粗格式保持一致：%s", value => {
      const report = composeBusinessReport([source], input(`较同期变动${value}。`));
      expect(report.report.summary.replaceAll("**", "").replaceAll("__", "")).toBe("较同期变动-2元。");
      expect(report.report.body_evidence).toEqual([{paragraph: 1, evidence_refs: ["total.yoy.difference"]}]);
    });

  it.each(["-**-2 元**", "-__-2 元__", "+**-2 元**"])("强调符外重复符号不能被忽略：%s", value => {
    expect(() => composeBusinessReport([source], input(`较同期变动${value}。`))).toThrow(/业务数字/u);
  });

  it("同值歧义不能通过单位空格自动选定指标", () => {
    const ambiguous = {...source, evidence_items: [...source.evidence_items,
      {ref: "personal.current", display: "100元", label: "个人存款余额", value: "100"}]};
    expect(() => composeBusinessReport([ambiguous], input("存款余额为 **100 元**。"))).toThrow(/业务数字/u);
  });

  it.each(["{{missing}}", "{{missing|cite}}"])("未知引用仍拒绝交付：%s", value => {
    expect(() => composeBusinessReport([source], input(`存款较上月有所增长${value}。`))).toThrow(/不存在证据/u);
  });

  it.each([
    "{{judgment.total.mom.direction}}",
    "各项存款较上月增加{{total.mom.difference}}。",
    "各项存款较上月增加 **{{total.mom.difference}}**。",
    "各项存款较上月**增加** {{total.mom.difference}}。",
    "尚不能确认各类存款是否均增长{{total.current|cite}}。",
    "各类都增长了吗？",
    "个人存款增长与否尚未确认。",
    "## 增长情况\n\n{{judgment.total.mom.direction}}",
    "存款较年初持平{{total.ytd.difference}}。",
  ])("允许已核验引用、明确疑问和中性标题：%s", text => {
    expect(composeBusinessReport([source], input(text)).status).toBe("succeeded");
  });

  it("不良贷款指标名中的不字不是方向否定", () => {
    const loan: OverviewEvidence = {...source, topic: "loan", evidence_items: [
      {ref: "npl_balance.current", display: "100元", label: "不良贷款余额", value: "100"},
      {ref: "npl_balance.mom.difference", display: "5元", label: "不良贷款余额较上月差额", value: "5"},
    ], table_rows: [{metric_id: "npl_balance", 指标: "不良贷款余额", 当前值: "100元", 较上月: "5元"}]};
    expect(composeBusinessReport([loan], {...input("不良贷款余额增加{{npl_balance.mom.difference}}。"),
      metric_ids: ["npl_balance"]}).status).toBe("succeeded");
  });

  it.each(["存款减少{{total.yoy.difference}}。", "存款减少2元{{total.yoy.difference|cite}}。"])(
    "负比较量用正幅度描述减少：%s", text => {
      expect(composeBusinessReport([source], input(text)).report.summary).toBe("存款减少2元。");
    });

  it("负比较量加粗仍按减少的正幅度展示", () => {
    expect(composeBusinessReport([source], input("存款减少 **{{total.yoy.difference}}**。"))
      .report.summary).toBe("存款减少 **2元**。");
  });

  it("排版归一化不能删除负余额自身的符号", () => {
    const negative = {...source, evidence_items: source.evidence_items.map(atom =>
      atom.ref === "total.current" ? {...atom, value: "-100", display: "-100元"} : atom)};
    const result = composeBusinessReport([negative], input("余额下降到{{total.current}}，当前余额下降{{total.current}}。"));
    expect(result.report.summary).toBe("余额下降到-100元，当前余额下降-100元。");
  });

  it.each([
    ["存款减少约2元。", "存款减少约2元。"],
    ["存款减少约 **{{total.yoy.difference}}**。", "存款减少约 **2元**。"],
    ["存款减少约为2元。", "存款减少约为2元。"],
    ["存款减少约为 **{{total.yoy.difference}}**。", "存款减少约为 **2元**。"],
    ["存款减少为2元。", "存款减少为2元。"],
    ["存款减少为 **{{total.yoy.difference}}**。", "存款减少为 **2元**。"],
  ])("负比较量带连接词仍展示正幅度：%s", (summary, expected) => {
    expect(composeBusinessReport([source], input(summary)).report.summary).toBe(expected);
  });

  it("自然概括不能隐藏未覆盖分类的客观缺口", () => {
    const partial = {...source, gaps: [{label: "分类", reason: "部分分类未取得数据"}]};
    const result = composeBusinessReport([partial], input("总量较上月有所增长{{total.mom.difference|cite}}。"));
    expect(result.partial_analysis).toBe(true);
    expect(result.public_answer).toContain("部分分类未取得数据");
  });

  it("标题与正文同样拒绝未经证据支持的数字", () => {
    expect(() => composeBusinessReport([source], {...input("存款余额{{total.current}}。"),
      sections: [{title: "存款999元", text: "当前值为{{total.current}}。", evidence_refs: ["total.current"]}]})).toThrow(/业务数字/u);
  });

  it("部分交付重建可靠事实，比较明细与原始判断仍可追溯", () => {
    const report = composePartialBusinessReport([source], input(
      "各类存款均增长{{judgment.total.mom.direction|cite}}。\n\n各项存款余额为{{total.current}}。"));
    expect(report.partial_analysis).toBe(true);
    expect(report.report.summary).toContain("各项存款为100元");
    expect(report.report.summary).toContain("较上月增加5元");
    expect(report.report.summary).toContain("较同期减少2元");
    expect(report.report.summary.match(/100元/gu)).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({current_value: "100元", mom_change: "5元", yoy_change: "-2元", ytd_change: "0元"});
    expect(report.public_answer).not.toContain("各类存款均增长");
    expect(report.report.body_evidence).toContainEqual(expect.objectContaining({
      evidence_refs: expect.arrayContaining(["total.current", "total.mom.difference", "total.yoy.difference"]),
    }));
    expect(report.evidence_items).toEqual(source.evidence_items);
  });
});
