import {describe, expect, it} from "vitest";
import {buildOverviewPieChart} from "../src/analysis/overviewCharts.js";
import type {OverviewEvidence} from "../src/tools/businessReport.js";

// 合成事实只用于图表来源与边界校验，不进入实际问数。
type Fact = {fact_id: string; value: string; date: string; unit: string; org_code: string; org_name: string};
const date = "2026-08-27";
function fixture() {
  const facts: Record<string, Record<string, Fact>> = {};
  for (const [id, value] of [["total", "100"], ["personal", "75"], ["company", "25"],
    ["personal_current", "15"], ["personal_fixed", "60"]]) {
    facts[id!] = {[date]: {fact_id: `fact:${id}`, value: value!, date, unit: "元", org_code: "O1", org_name: "测试机构"}};
  }
  const labels = {total: "各项存款", personal: "个人存款", company: "对公存款", personal_current: "个人活期", personal_fixed: "个人定期"};
  const calculations = [["personal", "total", "0.75", "75.00"], ["company", "total", "0.25", "25.00"],
    ["personal_current", "personal", "0.2", "20.00"], ["personal_fixed", "personal", "0.8", "80.00"]].map(([metric, parent, value, display]) => ({
    metric: metric!, parent: parent!, comparison: "share", status: "succeeded", scope_policy: "same_org_date",
    inputs: {part: {...facts[metric!]![date]!}, total: {...facts[parent!]![date]!}},
    results: [{name: "share", value: value!, display_value: display!, unit: "%", display: "percent", decimal_places: 2}],
  }));
  const source = {
    kind: "business_overview", status: "succeeded", topic: "deposit", topic_version: "test-v1",
    analysis_date: date, requested_date: date, org_codes: ["O1"], org_name: "测试机构", basis: "测试口径",
    facts, calculations, tasks: [], gaps: [], table_columns: [], table_rows: [],
    evidence_items: [
      ...Object.entries(facts).map(([id, days]) => ({ref: `${id}.current`, label: labels[id as keyof typeof labels],
        display: `${days[date]!.value}元`, ...days[date]!})),
      ...calculations.map(item => ({ref: `${item.metric}.share.share`, label: "分类占比", date, unit: "%",
        value: item.results[0]!.value, display: `${item.results[0]!.display_value}%`})),
    ],
  } satisfies OverviewEvidence & {facts: typeof facts; calculations: typeof calculations};
  const topic = {version: "test-v1", metrics: Object.entries(labels).map(([id, label]) => ({id, label})),
    relationships: [
      {id: "deposit_customers", parent: "total", children: ["personal", "company"], pie_chart: true, pie_tolerance: "1", pie_tolerance_unit: "元"},
      {id: "personal_terms", parent: "personal", children: ["personal_current", "personal_fixed"], pie_chart: true, pie_tolerance: "1", pie_tolerance_unit: "元"},
      {id: "unconfirmed", parent: "total", children: ["personal", "personal_current"]},
    ]};
  return {source, topic};
}

function replaceAmount(source: ReturnType<typeof fixture>["source"], id: string, value: string) {
  source.facts[id]![date]!.value = value;
  const atom = source.evidence_items.find(item => item.ref === `${id}.current`)!;
  atom.value = value;
  atom.display = `${value}元`;
  for (const calculation of source.calculations) {
    if (calculation.metric === id) calculation.inputs.part.value = value;
    if (calculation.parent === id) calculation.inputs.total.value = value;
  }
}

describe("复用正式概览证据生成饼图", () => {
  it("默认只绘制配置中的同级组成，保留金额字符串、正式展示值与已有占比", () => {
    const {source, topic} = fixture();
    const before = JSON.stringify(source);
    const result = buildOverviewPieChart([source], topic);
    expect(result.notice).toBeUndefined();
    expect(result.charts).toEqual([{type: "pie", title: "各项存款结构", date, unit: "元",
      source_refs: ["total.current", "personal.current", "personal.share.share", "company.current", "company.share.share"],
      points: [{name: "个人存款", value: "75", display: "75元", share: "75.00%"},
        {name: "对公存款", value: "25", display: "25元", share: "25.00%"}]}]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("明确指定个人内部结构时，不把总存款与个人父项混进扇区", () => {
    const {source, topic} = fixture();
    const chart = buildOverviewPieChart([source], topic, "personal_terms").charts[0]!;
    expect(chart.title).toBe("个人存款结构");
    expect(chart.points.map(point => point.name)).toEqual(["个人活期", "个人定期"]);
  });

  it("显式指定未知或未确认互斥的分组时拒绝，不偷偷换成默认图", () => {
    const {source, topic} = fixture();
    for (const id of ["unknown", "unconfirmed"]) {
      const result = buildOverviewPieChart([source], topic, id);
      expect(result.charts).toEqual([]);
      expect(result.notice).toMatch(/分组|口径/u);
    }
  });

  it("缺少分项时不补零、不造其他，也不宣称完整组成", () => {
    const {source, topic} = fixture();
    delete source.facts.company;
    const result = buildOverviewPieChart([source], topic, "deposit_customers");
    expect(result.charts).toEqual([]);
    expect(result.notice).toMatch(/数据|缺/u);
  });

  it.each(["date", "unit", "org_code"] as const)("不同%s的来源不能拼成同一个饼图", field => {
    const {source, topic} = fixture();
    source.facts.company![date]![field] = "不一致";
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
  });

  it.each(["NaN", "Infinity", "-1", "1e10000"])("拒绝无效或负值%s", value => {
    const {source, topic} = fixture();
    replaceAmount(source, "company", value);
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
  });

  it("父项为零时拒绝绘图", () => {
    const {source, topic} = fixture();
    for (const id of ["total", "personal", "company"]) replaceAmount(source, id, "0");
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
  });

  it("容差内但所有分项为零时不返回空饼图", () => {
    const {source, topic} = fixture();
    replaceAmount(source, "total", "0.5");
    for (const metric of ["personal", "company"]) {
      replaceAmount(source, metric, "0");
      Object.assign(source.calculations.find(item => item.metric === metric)!.results[0]!, {value: "0", display_value: "0.00"});
      Object.assign(source.evidence_items.find(item => item.ref === `${metric}.share.share`)!, {value: "0", display: "0.00%"});
    }
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
  });

  it("拒绝超出图形数值范围的有限十进制大额", () => {
    const {source, topic} = fixture();
    replaceAmount(source, "total", `1${"0".repeat(169)}e140`);
    replaceAmount(source, "personal", `75${"0".repeat(167)}e140`);
    replaceAmount(source, "company", `25${"0".repeat(167)}e140`);
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
  });

  it("分项为零但已有合法占比时保留零值", () => {
    const {source, topic} = fixture();
    replaceAmount(source, "personal", "100");
    replaceAmount(source, "company", "0");
    for (const [metric, ratio, display] of [["personal", "1", "100.00"], ["company", "0", "0.00"]]) {
      const calculation = source.calculations.find(item => item.metric === metric)!;
      calculation.results[0]!.value = ratio!;
      calculation.results[0]!.display_value = display!;
      Object.assign(source.evidence_items.find(item => item.ref === `${metric}.share.share`)!, {value: ratio, display: `${display}%`});
    }
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts[0]!.points[1]!.value).toBe("0");
  });

  it("校验已有占比的父项和输入事实，不采信被改写的金额或百分比", () => {
    for (const bad of ["parent", "fact", "display"] as const) {
      const {source, topic} = fixture();
      const calculation = source.calculations[0]!;
      if (bad === "parent") calculation.parent = "company";
      if (bad === "fact") calculation.inputs.part.fact_id = "unknown";
      if (bad === "display") calculation.results[0]!.display_value = "95.00";
      expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
    }
  });

  it("占比原值与展示值不一致时拒绝，即使金额合计正确", () => {
    const {source, topic} = fixture();
    source.calculations[0]!.results[0]!.value = "0.95";
    source.evidence_items.find(item => item.ref === "personal.share.share")!.value = "0.95";
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
  });

  it("多个真实回执可复用相同事实；配置版本不一致时不能套用新关系", () => {
    const {source, topic} = fixture();
    expect(buildOverviewPieChart([source, structuredClone(source)], topic, "deposit_customers").charts).toHaveLength(1);
    expect(buildOverviewPieChart([source], {...topic, version: "other"}, "deposit_customers").charts).toEqual([]);
  });

  it("使用十进制精确比较容差边界，不被浮点舍入吞掉超限尾差", () => {
    for (const [value, accepted] of [["9007199254740993.0000000000", true], ["9007199254740993.0000000001", false]] as const) {
      const {source, topic} = fixture();
      replaceAmount(source, "total", "9007199254741092");
      replaceAmount(source, "personal", value);
      replaceAmount(source, "company", "100");
      for (const [id, ratio, display] of [["personal", "0.999999999999989", "100.00"], ["company", "0.000000000000011", "0.00"]]) {
        const calculation = source.calculations.find(item => item.metric === id)!;
        Object.assign(calculation.results[0]!, {value: ratio, display_value: display});
        Object.assign(source.evidence_items.find(item => item.ref === `${id}.share.share`)!, {value: ratio, display: `${display}%`});
      }
      expect(buildOverviewPieChart([source], topic, "deposit_customers").charts.length).toBe(accepted ? 1 : 0);
    }
  });

  it("按正式单位精确换算1元容差", () => {
    for (const [value, accepted] of [["75.0001", true], ["75.00010000001", false]] as const) {
      const {source, topic} = fixture();
      replaceAmount(source, "personal", value);
      for (const days of Object.values(source.facts)) days[date]!.unit = "万元";
      for (const calculation of source.calculations) {
        calculation.inputs.part.unit = "万元";
        calculation.inputs.total.unit = "万元";
      }
      for (const atom of source.evidence_items.filter(item => item.ref.endsWith(".current"))) {
        atom.unit = "万元";
        atom.display = `${atom.value}万元`;
      }
      expect(buildOverviewPieChart([source], topic, "deposit_customers").charts.length).toBe(accepted ? 1 : 0);
    }
  });

  it("重复但冲突的来源不能被最后一条覆盖", () => {
    const {source, topic} = fixture();
    const changed = structuredClone(source);
    replaceAmount(changed, "personal", "74");
    expect(buildOverviewPieChart([source, changed], topic, "deposit_customers").charts).toEqual([]);
  });

  it("跨机构或跨日期回执不能混用", () => {
    const {source, topic} = fixture();
    for (const patch of [{org_codes: ["O2"]}, {analysis_date: "2026-08-26"}]) {
      expect(buildOverviewPieChart([source, {...source, ...patch}], topic).charts).toEqual([]);
    }
  });

  it("配置重复子项或将父项当子项时拒绝", () => {
    for (const children of [["personal", "personal"], ["total", "personal"]]) {
      const {source, topic} = fixture();
      topic.relationships[0]!.children = children;
      expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
    }
  });

  it("原概览路径继续只接受已有金额单位，不随公共组成计算扩大单位范围", () => {
    const {source, topic} = fixture();
    for (const days of Object.values(source.facts)) days[date]!.unit = "户";
    for (const calculation of source.calculations) {
      calculation.inputs.part.unit = "户";
      calculation.inputs.total.unit = "户";
    }
    for (const atom of source.evidence_items.filter(item => item.ref.endsWith(".current"))) {
      atom.unit = "户";
      atom.display = `${atom.value}户`;
    }
    topic.relationships[0]!.pie_tolerance_unit = "户";
    expect(buildOverviewPieChart([source], topic, "deposit_customers").charts).toEqual([]);
  });
});
