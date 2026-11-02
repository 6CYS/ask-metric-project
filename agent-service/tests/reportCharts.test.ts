import {describe, expect, it} from "vitest";
import {buildReportChart, reportChartHasNarrativeEvidence} from "../src/analysis/reportCharts.js";
import {createInquiryReportTool} from "../src/inquiry/reportTool.js";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

// 隔离的图表契约夹具，不用于业务验收或运行时数据。
function source() {
  return {ref: "e1", evidence: {kind: "analysis_evidence", status: "succeeded",
    metric_descriptors: [{code: "M1", name: "测试存款", unit: "元", value_basis: "当日数"}],
    evidence_items: ["甲行", "乙行", "丙行"].map((name, index) => ({ref: `r.f${index + 1}`, type: "fact",
      metric_code: "M1", metric_name: "测试存款", org_code: `O${index}`, org_name: name,
      date: "2026-08-27", value: String(index * 10 - 5), unit: "元", display: `${index * 10 - 5}元`}))}};
}

function mixedSource() {
  const input = source();
  input.evidence.metric_descriptors = Array.from({length: 6}, (_, metric) => ({
    code: `M${metric + 1}`, name: `测试指标${metric + 1}`, unit: "元", value_basis: "当日数",
  }));
  input.evidence.evidence_items = input.evidence.metric_descriptors.flatMap((metric, group) =>
    Array.from({length: 60}, (_, org) => ({ref: `r.m${group}.f${org}`, type: "fact", metric_code: metric.code,
      metric_name: metric.name, org_code: `O${org}`, org_name: `测试机构${org}`, date: "2026-08-27",
      value: `${org - 10}.123400`, unit: "元", display: `${org - 10}.123400元`})));
  return input;
}

describe("报告图表从已核验原子取数", () => {
  it("多指标图的每个指标都须有正文依据，而非匹配其中一个就通过", () => {
    const original = source();
    const input = {...original, evidence: {...original.evidence,
      metric_descriptors: ["M1", "M2"].map(code => ({code, name: code, unit: "元", value_basis: "当日数",
        analysis_hint: {topic: "deposit"}})),
      evidence_items: [original.evidence.evidence_items[0]!, {...original.evidence.evidence_items[0]!,
        ref: "r.f2", metric_code: "M2", metric_name: "测试个人存款"}],
    }};
    const selection = {type: "bar" as const, evidence_refs: ["e1.v1", "e1.v2"]};
    expect(buildReportChart([input], selection).charts).toHaveLength(1);
    expect(reportChartHasNarrativeEvidence([input], selection, ["r.f1"])).toBe(false);
    expect(reportChartHasNarrativeEvidence([input], selection, ["r.f1", "r.f2"])).toBe(true);
  });

  it("同指标趋势只需正文涉及该机构及趋势中的真实统计日，无需逐点列值", () => {
    const input = source();
    input.evidence.evidence_items = input.evidence.evidence_items.map((atom, index) => ({...atom,
      org_code: "O0", org_name: "甲行", date: ["2026-06-27", "2026-07-27", "2026-08-27"][index]!}));
    expect(reportChartHasNarrativeEvidence([input], {type: "line", evidence_refs: ["e1.v1", "e1.v2", "e1.v3"]}, ["r.f3"])).toBe(true);
  });
  it("同指标同日跨机构自动柱图保留负值与精确展示值", () => {
    const result = buildReportChart([source()]);
    expect(result.charts[0]).toMatchObject({type: "bar", title: "测试存款", unit: "元", dates: ["2026-08-27"],
      points: [{name: "甲行", value: "-5", display: "-5元"}, {name: "乙行", value: "5", display: "5元"}, {name: "丙行", value: "15", display: "15元"}]});
  });
  it("360条混合事实只按正文顺序选择首组足够的同类引用，不截取全部来源", () => {
    const input = mixedSource();
    const result = buildReportChart([input], undefined, "分析业务表现", ["e1.v61", "e1.v3", "e1.v1", "e1.v5", "e1.v121"]);
    expect(result.charts).toHaveLength(1);
    expect(result.charts[0]).toMatchObject({type: "bar", title: "测试指标1（文中机构）", unit: "元",
      source_refs: ["r.m0.f2", "r.m0.f0", "r.m0.f4"], points: [
        {name: "测试机构2", value: "-8.123400"}, {name: "测试机构0", value: "-10.123400"}, {name: "测试机构4", value: "-6.123400"},
      ]});
  });
  it("正文多组均可成图时按首个引用顺序选组，显式选图仍优先", () => {
    const input = mixedSource(), refs = ["e1.v61", "e1.v1", "e1.v2", "e1.v3", "e1.v63", "e1.v65"];
    expect(buildReportChart([input], undefined, "", refs).charts[0]?.source_refs).toEqual(["r.m1.f0", "r.m1.f2", "r.m1.f4"]);
    expect(buildReportChart([input], {type: "bar", evidence_refs: ["e1.v1", "e1.v2"]}, "", refs)
      .charts[0]?.source_refs).toEqual(["r.m0.f0", "r.m0.f1"]);
  });
  it.each([1, 25])("正文自动选点为%s个时不画图，也不擅自截取到上限", count => {
    expect(buildReportChart([mixedSource()], undefined, "", Array.from({length: count}, (_, i) => `e1.v${i + 1}`)).charts).toEqual([]);
  });
  it("提供空正文引用时不回退使用全文数据；未提供仍兼容同质小结果", () => {
    expect(buildReportChart([source()], undefined, "", []).charts).toEqual([]);
    expect(buildReportChart([source()]).charts).toHaveLength(1);
  });
  it("正文中的非法引用不能忽略后用其余正确点配图", () => {
    expect(buildReportChart([source()], undefined, "", ["e1.v1", "e1.v2", "e1.v3", "e9.v1"]).charts).toEqual([]);
  });
  it("已存在的非数值判断不作图点，但显式选点不能用判断替代数值", () => {
    const input = source(), evidence = {...input.evidence, evidence_items: [...input.evidence.evidence_items,
      {ref: "r.j1", type: "observation", judgment_kind: "ranking", display: "甲行金额较低", input_refs: ["r.f1"]}]};
    const refs = ["e1.j1", "e1.v1", "e1.v2", "e1.v3"];
    expect(buildReportChart([{...input, evidence}], undefined, "", refs).charts[0]?.source_refs).toEqual(["r.f1", "r.f2", "r.f3"]);
    expect(buildReportChart([{...input, evidence}], {type: "bar", evidence_refs: refs}).charts).toEqual([]);
    input.evidence.evidence_items[1]!.value = "";
    expect(buildReportChart([{...input, evidence}], undefined, "", refs).charts).toEqual([]);
  });
  it("正文重复引用同一事实或相同坐标同值时只保留第一次的精度", () => {
    const input = source();
    input.evidence.evidence_items.push({...input.evidence.evidence_items[0]!, ref: "r.repeated", value: "-5.00", display: "-5.00元"});
    expect(buildReportChart([input], undefined, "", ["e1.v1", "r.f1", "e1.v4", "e1.v2", "e1.v3"])
      .charts[0]).toMatchObject({source_refs: ["r.f1", "r.f2", "r.f3"], points: [{value: "-5"}, {value: "5"}, {value: "15"}]});
  });
  it("同一指标机构日期和基期出现冲突值时不画图", () => {
    const input = source();
    input.evidence.evidence_items.push({...input.evidence.evidence_items[0]!, ref: "r.conflicting", value: "-6", display: "-6元"});
    expect(buildReportChart([input], undefined, "", ["e1.v1", "e1.v2", "e1.v3", "e1.v4"]).charts).toEqual([]);
  });
  it("任何来源失败时显式或正文引用不能绕过失败来源", () => {
    const failed = source(); failed.ref = "e2"; failed.evidence.status = "failed";
    const refs = ["e1.v1", "e1.v2", "e1.v3"];
    expect(buildReportChart([source(), failed], undefined, "", refs).charts).toEqual([]);
    expect(buildReportChart([source(), failed], {type: "bar", evidence_refs: refs}).charts).toEqual([]);
  });
  it("重复来源的同一引用值冲突后，旧短引用也不能保留原值绘图", () => {
    const conflicting = source(); conflicting.ref = "e2"; conflicting.evidence.evidence_items[0]!.value = "-6";
    const refs = ["e1.v1", "e1.v2", "e1.v3"];
    expect(buildReportChart([source(), conflicting], undefined, "", refs).charts).toEqual([]);
    expect(buildReportChart([source(), conflicting], {type: "bar", evidence_refs: refs}).charts).toEqual([]);
  });
  it("同一引用跨来源数值写法不同但等值时仍复用首份事实", () => {
    const repeated = source(); repeated.ref = "e2"; repeated.evidence.evidence_items[0]!.value = "-5.00";
    expect(buildReportChart([source(), repeated], undefined, "", ["e2.v1", "e1.v2", "e1.v3"]).charts[0])
      .toMatchObject({source_refs: ["r.f1", "r.f2", "r.f3"], points: [{value: "-5"}, {value: "5"}, {value: "15"}]});
  });
  it("正文引用只在同一基期内分组，不把同比环比拼成一组", () => {
    const input = source();
    const evidence = {...input.evidence, evidence_items: input.evidence.evidence_items.map((atom, i) => ({...atom,
      comparison: ["mom", "yoy", "ytd"][i]}))};
    expect(buildReportChart([{...input, evidence}], undefined, "", ["e1.v1", "e1.v2", "e1.v3"]).charts).toEqual([]);
  });
  it("正文引用同机构真实时序可生成折线，多机构多日期混合不生成", () => {
    const input = mixedSource();
    input.evidence.evidence_items.slice(0, 3).forEach((atom, i) => {
      atom.org_code = "O0"; atom.org_name = "测试机构0"; atom.date = ["2026-08-27", "2026-06-27", "2026-07-27"][i]!;
    });
    const refs = ["e1.v1", "e1.v2", "e1.v3"];
    expect(buildReportChart([input], undefined, "", refs).charts[0]).toMatchObject({type: "line", title: "测试指标1",
      dates: ["2026-06-27", "2026-07-27", "2026-08-27"], source_refs: ["r.m0.f1", "r.m0.f2", "r.m0.f0"]});
    input.evidence.evidence_items[1]!.org_code = "O1";
    expect(buildReportChart([input], undefined, "", refs).charts).toEqual([]);
  });
  it("跨回执的同机构同指标实际日期仍可形成趋势", () => {
    const sources = ["2026-08-27", "2026-06-27", "2026-07-27"].map((date, i) => {
      const input = source(); input.ref = `e${i + 1}`;
      input.evidence.evidence_items = [{...input.evidence.evidence_items[0]!, ref: `r${i}.f1`, date}];
      return input;
    });
    expect(buildReportChart(sources, undefined, "", ["e1.v1", "e2.v1", "e3.v1"]).charts[0])
      .toMatchObject({type: "line", dates: ["2026-06-27", "2026-07-27", "2026-08-27"], source_refs: ["r1.f1", "r2.f1", "r0.f1"]});
  });
  it("只要文字也优先于正文自动选点", () => {
    expect(buildReportChart([source()], undefined, "只要文字", ["e1.v1", "e1.v2", "e1.v3"]).charts).toEqual([]);
  });
  it.each([
    "请用表格和柱状图对比两家银行的存款余额", "用列表列出数据并配上图表",
    "用表格对比两家银行的存款余额", "不要表格，请用柱状图对比两家银行",
    "只要表格和柱状图", "不要图表标题",
  ])("提及表格、列表或其他不展示项不能否决可交付图表：%s", question => {
    const input = source(), refs = ["e1.v1", "e1.v2"];
    expect(buildReportChart([input], {type: "bar", evidence_refs: refs}, question).charts).toHaveLength(1);
    expect(buildReportChart([input], undefined, question, refs).charts).toHaveLength(1);
  });
  it.each(["只要表格", "对比两家银行的存款余额，仅用列表。", "不要画图。", "不用图表", "只用文字，不要图表"])(
    "明确排他输出或禁图时不主动配图：%s", question => {
      const input = source(), refs = ["e1.v1", "e1.v2"];
      expect(buildReportChart([input], undefined, question, refs).charts).toEqual([]);
      expect(buildReportChart([input], {type: "bar", evidence_refs: refs}, question).charts).toEqual([]);
    });
  it("同指标同日两机构可自动配柱图，显式选择仍保留原引用", () => {
    const input = source(); input.evidence.evidence_items.pop();
    expect(buildReportChart([input], undefined, "对比另一机构", ["e1.v1", "e1.v2"]).charts[0])
      .toMatchObject({type: "bar", dates: ["2026-08-27"], source_refs: ["r.f1", "r.f2"],
        points: [{name: "甲行", value: "-5", display: "-5元"}, {name: "乙行", value: "5", display: "5元"}]});
    expect(buildReportChart([input], {type: "bar", evidence_refs: ["e1.v1", "e1.v2"]}).charts).toHaveLength(1);
  });
  it("两机构的多指标正文自动选一个可比组，不混画全部指标或替换无效显式选择", () => {
    const input = mixedSource(), refs = ["e1.v121", "e1.v122", "e1.v61", "e1.v62", "e1.v1", "e1.v2"];
    expect(buildReportChart([input], undefined, "对比经营情况", refs).charts[0])
      .toMatchObject({type: "bar", source_refs: ["r.m2.f0", "r.m2.f1"]});
    expect(buildReportChart([input], {type: "bar", evidence_refs: refs}, "对比经营情况", refs))
      .toMatchObject({charts: [], notice: expect.any(String)});
  });
  it("多机构多指标选点只提示可比指标名称，不暴露内部引用或参数", () => {
    const input = mixedSource(), refs = ["e1.v1", "e1.v61", "e1.v2", "e1.v62"];
    const result = buildReportChart([input], {type: "bar", evidence_refs: refs});
    expect(result.charts).toEqual([]);
    expect(result.notice).toBe("不同机构可以比较；当前同时选择了多个指标和多个机构，跨机构柱图每次只选一个指标。可选择：测试指标1、测试指标2。");
    for (const [name, evidence_refs] of [["测试指标1", ["r.m0.f0", "r.m0.f1"]],
      ["测试指标2", ["r.m1.f0", "r.m1.f1"]]] as const) {
      expect(result.notice).toContain(name);
      expect(buildReportChart([input], {type: "bar", evidence_refs: [...evidence_refs]}).charts).toHaveLength(1);
    }
  });
  it.each(["date", "unit", "period", "missing", "unknown", "incomplete_group"])(
    "多机构多指标的%s错误不能被误报为可重选的单系列限制", mode => {
      const input = mixedSource(), refs = ["e1.v1", "e1.v61", "e1.v2", "e1.v62"];
      if (mode === "date") input.evidence.evidence_items[60]!.date = "2026-07-31";
      if (mode === "unit") input.evidence.evidence_items[60]!.unit = "万元";
      if (mode === "period") input.evidence.metric_descriptors[1]!.value_basis = "较同期";
      if (mode === "missing") input.evidence.evidence_items[60]!.value = "";
      if (mode === "unknown") refs[1] = "e9.v1";
      if (mode === "incomplete_group") refs.pop();
      const result = buildReportChart([input], {type: "bar", evidence_refs: refs});
      expect(result.charts).toEqual([]);
      expect(result.notice).not.toContain("跨机构柱图每次只选一个指标");
    });
  it("两期趋势仍需显式选图，不因双机构自动柱图放开而默认配线图", () => {
    const input = source(); input.evidence.evidence_items.pop();
    input.evidence.evidence_items[1] = {...input.evidence.evidence_items[1]!, org_code: "O0", org_name: "甲行", date: "2026-07-31"};
    const refs = ["e1.v1", "e1.v2"];
    expect(buildReportChart([input], undefined, "查看变化", refs).charts).toEqual([]);
    expect(buildReportChart([input], {type: "line", evidence_refs: refs}).charts[0])
      .toMatchObject({type: "line", dates: ["2026-07-31", "2026-08-27"]});
  });
  it("模型只选择引用，不能通过未知引用或重复引用构造数据", () => {
    for (const refs of [["e1.v1", "e9.v2"], ["e1.v1", "e1.v1"]]) {
      expect(buildReportChart([source()], {type: "bar", evidence_refs: refs})).toMatchObject({charts: [], notice: expect.any(String)});
    }
  });
  it("同指标同机构跨真实日期排序生成折线，不把不同基期拼成趋势", () => {
    const input = source();
    input.evidence.evidence_items = input.evidence.evidence_items.map((atom, i) => ({...atom,
      org_code: "O1", org_name: "甲行", date: ["2026-08-27", "2026-06-27", "2026-07-27"][i]!}));
    const chart = buildReportChart([input]).charts[0];
    expect(chart).toMatchObject({type: "line", dates: ["2026-06-27", "2026-07-27", "2026-08-27"]});
    expect(chart?.points.map(point => point.value)).toEqual(["5", "15", "-5"]);
  });
  it.each(["mixed_date", "mixed_unit", "missing", "unknown_ratio", "duplicate", "failed"])("%s 不生成误导图表", mode => {
    const input = source();
    if (mode === "mixed_date") input.evidence.evidence_items[1]!.date = "2026-07-27";
    if (mode === "mixed_unit") input.evidence.evidence_items[1]!.unit = "万元";
    if (mode === "missing") input.evidence.evidence_items[1]!.value = "";
    if (mode === "unknown_ratio") input.evidence.evidence_items.forEach(atom => {atom.unit = "%";});
    if (mode === "duplicate") input.evidence.evidence_items[1]!.org_code = "O0";
    if (mode === "failed") input.evidence.status = "failed";
    expect(buildReportChart([input]).charts).toEqual([]);
    expect(buildReportChart([input], {type: "bar", evidence_refs: ["e1.v1", "e1.v2", "e1.v3"]}).charts).toEqual([]);
  });
  it("专项可选个人/对公同基期差额，不把余额或不同基期混入比较", () => {
    const input = {ref: "e1", evidence: {kind: "business_overview", status: "succeeded", topic: "deposit",
      org_codes: ["O1"], org_name: "甲行", evidence_items: [
        {ref: "personal.mom.difference", label: "个人存款较上月", value: "12.3400", display: "12.34元", unit: "元", date: "2026-08-27"},
        {ref: "company.mom.difference", label: "对公存款较上月", value: "-8.2300", display: "-8.23元", unit: "元", date: "2026-08-27"},
        {ref: "company.current", label: "对公存款", value: "120", display: "120元", unit: "元", date: "2026-08-27"},
      ]}};
    expect(buildReportChart([input]).charts).toEqual([]);
    expect(buildReportChart([input], {type: "bar", evidence_refs: ["personal.mom.difference", "company.mom.difference"]}).charts[0])
      .toMatchObject({type: "bar", points: [{value: "12.3400"}, {value: "-8.2300"}]});
    expect(buildReportChart([input], {type: "bar", evidence_refs: ["personal.mom.difference", "company.current"]}).charts).toEqual([]);
    expect(buildReportChart([input], {type: "line", evidence_refs: ["personal.mom.difference", "company.mom.difference"]}).charts).toEqual([]);
  });
  it("只用文字的偏好优先于模型选图", () => {
    expect(buildReportChart([source()], {type: "bar", evidence_refs: ["e1.v1", "e1.v2"]}, "只用文字，不要图表").charts).toEqual([]);
  });
  it("只有明确比例编码才按百分数绘图，提示保留服务端精确值", () => {
    const input = source();
    input.evidence.evidence_items = input.evidence.evidence_items.map(atom => ({...atom, unit: "%", value: "0.123400", display: "12.34%"}));
    expect(buildReportChart([input]).charts).toEqual([]);
    const encoded = {...input, evidence: {...input.evidence,
      metric_descriptors: input.evidence.metric_descriptors.map(metric => ({...metric, value_encoding: "ratio"}))}};
    expect(buildReportChart([encoded]).charts[0]?.points).toEqual([
      {name: "甲行", value: "12.3400", display: "12.34%"},
      {name: "乙行", value: "12.3400", display: "12.34%"},
      {name: "丙行", value: "12.3400", display: "12.34%"},
    ]);
  });

  it("通用报告授权成功后携带图表，权限错误时不以本地原子兜底", async () => {
    const input = source();
    const evidence = {...input.evidence, kind: "analysis_evidence" as const, run_ref: "run-1", execution_turn_id: "op-1"};
    let denied = false;
    const backend = {analysisReport: async () => {
      if (denied) throw new BackendApiError(403, "无权限");
      return {kind: "business_report", status: "succeeded", public_answer: "机构间存在差异。",
        gaps: [], report: {summary: "机构间存在差异。", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["r.f1"]}]}};
    }} as unknown as BackendClient;
    const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence}]});
    const tool = createInquiryReportTool();
    const args = {body: "机构间存在差异{{e1.v1|cite}}。", chart: {type: "bar" as const, evidence_refs: ["e1.v1", "e1.v2"]}};
    const result = await runTool(tool, args, request);
    expect(result).toMatchObject({terminate: true, details: {report: {charts: [{type: "bar", points: [{name: "甲行"}, {name: "乙行"}]}]}}});
    denied = true;
    await expect(runTool(tool, args, request)).rejects.toThrow(BackendApiError);
  });
});
