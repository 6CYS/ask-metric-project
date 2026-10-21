import {expect, it, vi} from "vitest";
import {composeBusinessReport, composePartialBusinessReport, createBusinessReportTool, pendingOverviewFollowup, type OverviewEvidence, type ReportInput} from "./businessReport.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "./testUtils.js";
import type {BackendClient} from "../backendClient.js";
import type {FrameStore} from "../business-context/types.js";

const source = (): OverviewEvidence => ({kind: "business_overview", status: "succeeded",
  analysis_date: "2026-08-27", requested_date: "2026-08-27", org_codes: ["O1"], org_name: "隔离合成机构", basis: "合成口径",
  tasks: [{task_id: "t1", status: "succeeded"}], gaps: [], table_columns: [],
  table_rows: [{metric_id: "total", 指标: "各项贷款", 当前值: "120亿元"}],
  evidence_items: [{ref: "total.current", display: "120亿元", label: "各项贷款"}],
  plan: {questions: ["贷款规模如何？"]}});
const input = (): ReportInput => ({evidence_refs: ["e1"], summary: "当前贷款为{{total.current}}。", metric_ids: ["total"],
  sections: [{title: "规模观察", text: "贷款余额为{{total.current}}，动因需要进一步验证。", evidence_refs: ["total.current"]}]});

it("依据引用不展示次要数字，仍追溯原子并拒绝伪造引用及数字", () => {
  const data = source();
  const report = composeBusinessReport([data], {...input(), summary: "已核对当前贷款规模{{total.current|cite}}。", sections: []});
  expect(report.report.summary).toBe("已核对当前贷款规模。");
  expect(report.report.body_evidence).toEqual([{paragraph: 1, evidence_refs: ["total.current"]}]);
  expect(report.rows[0]?.current_value).toBe("120亿元");
  expect(() => composeBusinessReport([data], {...input(), summary: "已核对{{missing|cite}}。"})).toThrow("不存在证据");
  expect(() => composeBusinessReport([data], {...input(), summary: "余额999亿元{{total.current|cite}}。"})).toThrow("业务数字只能");
});

it("专项正文也不能把合法金额引用误称为增幅，历史内部报告格式仍可渲染", () => {
  for (const value of ["{{total.current}}", "120亿元"])
    expect(() => composeBusinessReport([source()], {...input(), sections: [], summary: `贷款同比增幅（${value}）`})).toThrow("金额证据不能称为增幅");
  expect(composeBusinessReport([source()], input()).status).toBe("succeeded");
});

it("专项正文引用预先核验判断时展开原始依据，文字失败仍交付已有判断", () => {
  const data = source();
  data.evidence_items.push({ref: "finding.test", label: "已核验判断", type: "observation",
    display: "正式比较结果为增加。", judgment_kind: "comparison_direction", input_refs: ["total.current"]});
  const report = composeBusinessReport([data], {...input(), summary: "{{finding.test}}", sections: []});
  expect(report.report.summary).toBe("正式比较结果为增加。");
  expect(report.report.body_evidence[0]?.evidence_refs).toEqual(["finding.test", "total.current"]);
  expect(composePartialBusinessReport([data], {...input(), summary: "编造999亿元", sections: []}).report.summary)
    .toContain("正式比较结果为增加");
  data.evidence_items.at(-1)!.input_refs = ["missing"];
  expect(() => composeBusinessReport([data], {...input(), summary: "{{finding.test}}", sections: []})).toThrow("证据链不完整");
});

it("补查的日期选择说明可变化，同一结构化新鲜度不误报快照冲突，业务值冲突仍拒绝", () => {
  const data = source();
  data.data_freshness = {checked_on: "2026-10-21", as_of: "2026-08-27", lag_days: 55, notice: "以总量定位日期"};
  data.evidence_items.push({ref: "scope.freshness", type: "observation", display: "以总量定位日期", label: "日期说明"});
  const followup = structuredClone(data);
  followup.data_freshness!.notice = "沿用首轮日期补查分项";
  followup.evidence_items.at(-1)!.display = followup.data_freshness!.notice;
  expect(composeBusinessReport([data, followup], input()).status).toBe("succeeded");
  expect(composeBusinessReport([data], {...input(), summary: "数据滞后约55天，不能代表今天。", sections: []}).status).toBe("succeeded");
  expect(() => composeBusinessReport([data], {...input(), summary: "数据滞后约54天。", sections: []})).toThrow("业务数字只能");
  followup.data_freshness!.lag_days = 54;
  expect(() => composeBusinessReport([data, followup], input())).toThrow("日期覆盖证据发生变化");
  followup.data_freshness!.lag_days = 55;
  followup.evidence_items[0]!.display = "121亿元";
  expect(() => composeBusinessReport([data, followup], input())).toThrow("两轮证据值发生变化");
});

it.each(["op-1", "another-turn"])("补查报告仅恢复本轮焦点，保留其他轮的焦点：%s", async currentTurn => {
  const setFocus = vi.fn(async () => undefined);
  const frames = {state: async () => ({version: 3, focusFrameId: "supplement"}),
    get: async (frameId: string) => ({frameId, turnId: frameId === "root" ? "op-1" : currentTurn,
      capability: "business_overview", status: "success"}), setFocus} as unknown as FrameStore;
  const backend = {resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O1"]}}),
    getTask: async () => ({})} as unknown as BackendClient;
  const references = [{ref: "e1", evidence: {...source(), frame_id: "root"}},
    {ref: "e2", evidence: {...source(), frame_id: "supplement"}}];
  const request = testRequestContext(backend, new MemoryCommandBridge(), {frames, answerEvidence: async () => references});
  const result = await runTool(createBusinessReportTool(), {...input(), evidence_refs: ["e1", "e2"]}, request);
  expect(result.terminate).toBe(true);
  if (currentTurn === "op-1") expect(setFocus).toHaveBeenCalledWith("root", 3);
  else expect(setFocus).not.toHaveBeenCalled();
});

it("补查候选是线索而非必查清单，仍保留可用入口与执行上限", () => {
  const first = {...source(), plan: {metric_ids: ["total", "personal"]}, followup_candidates: [
    {parent: "personal", metric_ids: ["consumer"], comparisons: ["mom"], reason: "实际下降"}]};
  expect(pendingOverviewFollowup([first])).toHaveLength(1);
  expect(() => composeBusinessReport([first], input())).not.toThrow();
  const attempted = {...source(), plan: {metric_ids: ["total", "consumer"]}};
  expect(pendingOverviewFollowup([first, attempted])).toEqual([]);
  expect(() => composeBusinessReport([first, attempted], input())).not.toThrow();
  expect(pendingOverviewFollowup([first, source(), source()])).toEqual([]);
});

it("模型分析与程序表格同时交付，保留任务授权和分析计划", () => {
  const report = composeBusinessReport([source()], input());
  expect(report.public_answer).toContain("当前贷款为120亿元");
  expect(report.rows[0]).toMatchObject({metric_name: "各项贷款", current_value: "120亿元"});
  expect(report.tasks).toEqual([{task_id: "t1", status: "succeeded"}]);
  expect(report.report.plans[0]?.questions).toEqual(["贷款规模如何？"]);
});
it("自然正文仍拒绝编造数字，核验后的表格完整保留", async () => {
  const backend = {resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O1"]}}),
    getTask: async () => ({})} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence: source()}]});
  const valid = await runTool(createBusinessReportTool(), {evidence_refs: ["e1"], metric_ids: ["total"],
    body: "当前贷款为{{total.current}}。\n\n具体动因仍待核验。"}, request);
  expect(valid.terminate).toBe(true);
  expect(valid.details.rows).toHaveLength(1);
  expect(valid.details.report.presentation.body_mode).toBe("narrative");
  expect(valid.details.report.sections).toEqual([]);
  const invalid = await runTool(createBusinessReportTool(), {evidence_refs: ["e1"], metric_ids: ["total"], body: "贷款为999亿元。"}, request);
  expect(invalid.details.status).toBe("ARGUMENT_ERROR");
});
it("专项报告段落换行修复后正常验证引用，并保存分段证据", async () => {
  const backend = {resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O1"]}}),
    getTask: async () => ({})} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence: source()}]});
  const result = await runTool(createBusinessReportTool(), {evidence_refs: ["e1"], metric_ids: ["total"],
    body: String.raw`## 规模观察\n\n贷款为{{total.current}}。\n\n仍需核查动因。`}, request);
  expect(result.terminate).toBe(true);
  expect(result.details.report.summary).toBe("## 规模观察\n\n贷款为120亿元。\n\n仍需核查动因。");
  expect(result.details.report.body_evidence).toEqual([{paragraph: 2, evidence_refs: ["total.current"]}]);
  const invalid = await runTool(createBusinessReportTool(), {evidence_refs: ["e1"], metric_ids: ["total"],
    body: String.raw`## 规模观察\n\n贷款为{{missing.current}}。`}, request);
  expect(invalid.details.status).toBe("ARGUMENT_ERROR");
});
it("最近报告始终披露实际截至日和间隔，即使模型没有主动引用新鲜度", () => {
  const data_freshness = {checked_on: "2026-10-13", as_of: "2026-08-27", lag_days: 47,
    notice: "数据截至2026-08-27；与查询日2026-10-13相隔47天，不代表今天或完整月份。"};
  const recent: OverviewEvidence = {...source(), requested_date: "2026-10-13", date_selection: "latest_snapshot", data_freshness};
  const report = composeBusinessReport([recent], input());
  expect(report.public_answer).toContain(data_freshness.notice);
  expect(report.data_freshness).toEqual(data_freshness);
  expect(report.date_selection).toBe("latest_snapshot");
  expect(() => composeBusinessReport([recent, {...recent, date_selection: "exact"}], input())).toThrow("同一机构");
  const withNotice = {...recent, evidence_items: [...recent.evidence_items,
    {ref: "scope.freshness", display: data_freshness.notice, label: "新鲜度", type: "observation"}]};
  expect(() => composeBusinessReport([withNotice], {...input(), summary: "与查询日相隔{{scope.freshness}}。"})).toThrow("统一披露");
});
it.each(["余额为999亿元。", "余额翻倍后为240亿元。", "占比为50%。", "贡献约六成。", "增长百分之八。", "占比约四分之一。"])("拒绝模型自行给出数字：%s", summary => {
  expect(() => composeBusinessReport([source()], {...input(), summary})).toThrow("业务数字只能");
});
it("拒绝不存在的引用和未取得的表格指标，自动补齐有效数值引用", () => {
  expect(() => composeBusinessReport([source()], {...input(), summary: "{{missing.current}}"})).toThrow("不存在证据");
  expect(() => composeBusinessReport([source()], {...input(), metric_ids: ["npl_ratio"]})).toThrow("实际取得");
  expect(composeBusinessReport([source()], {...input(), sections: [{title: "规模", text: "{{total.current}}", evidence_refs: []}]}).report.sections[0]?.evidence_refs).toEqual(["total.current"]);
  expect(() => composeBusinessReport([source()], {...input(), sections: [{title: "规模", text: "缺少分析依据。", evidence_refs: []}]})).toThrow("有效的分析证据");
});
it("补查不同机构、日期或变化的快照不能混入报告", () => {
  expect(() => composeBusinessReport([source(), {...source(), org_codes: ["O2"]}], input())).toThrow("同一机构");
  expect(() => composeBusinessReport([source(), {...source(), analysis_date: "2026-07-31"}], input())).toThrow("同一机构");
  expect(() => composeBusinessReport([source(), {...source(), evidence_items: [{ref: "total.current", display: "130亿元", label: "各项贷款"}]}], input())).toThrow("证据值发生变化");
});
it("无数据仍交付文字和缺口，表格为空而非填零", () => {
  const empty = {...source(), analysis_date: null, table_rows: [], evidence_items: [], tasks: [], gaps: [{reason: "目标日期无数据"}]};
  const report = composeBusinessReport([empty], {evidence_refs: ["e1"], summary: "该日期无可用贷款记录。", sections: [], metric_ids: []});
  expect(report.rows).toEqual([]);
  expect(report.public_answer).toContain("目标日期无数据");
});

it("空结果文案校验失败后仍明确无记录，不声称取得指标或完成经营判断", () => {
  const empty = {...source(), analysis_date: null, table_rows: [], evidence_items: [], tasks: [], gaps: [{reason: "目标日期无数据"}]};
  const report = composePartialBusinessReport([empty], {...input(), summary: "贷款为999亿元。", metric_ids: [], sections: []});
  expect(report.report.summary).toContain("未取得可用指标记录");
  expect(report.report.summary).not.toContain("已取得的指标");
  expect(report.partial_analysis).toBe(true);
  expect(report.gaps.join("；")).toContain("部分分析文字未通过证据校验");
});

it("中文日期与规范日期等价，不放行与日期数字相同的业务数值", () => {
  expect(composeBusinessReport([source()], {...input(), summary: "截至2026年8月27日，余额为{{total.current}}。"}).report.summary).toContain("120亿元");
  expect(() => composeBusinessReport([source()], {...input(), summary: "截至2026年8月27日，增长8%。"})).toThrow("直接数值：8");
  expect(() => composeBusinessReport([source()], {...input(), summary: "截至8月27日余额为{{total.current}}，不代表8月全月。"})).not.toThrow();
  expect(() => composeBusinessReport([source()], {...input(), summary: "不代表9月全月。"})).toThrow("直接数值：9");
  expect(() => composeBusinessReport([source()], {...input(), summary: "8月余额增长8%。"})).toThrow("直接数值：8");
});
it("一次反馈所有数字、单位和段落引用问题，便于模型原地纠正", () => {
  expect(() => composeBusinessReport([source()], {...input(), summary: "当前贷款{{total.current}}亿元，同比增长8%。",
    sections: [{title: "观察", text: "{{total.current}}", evidence_refs: ["e1"]}]}))
    .toThrow(/summary.*直接数值：8[\s\S]*原子 ref/);
});
it("拦截负号反向表达和跨周期增速推论，不替模型撰写报告", () => {
  const negative = {...source(), evidence_items: [...source().evidence_items, {ref: "personal.mom.difference", display: "-2亿元", label: "变动"}]};
  expect(composeBusinessReport([negative], {...input(), summary: "个人贷款减少{{personal.mom.difference}}。"}).report.summary).toBe("个人贷款减少2亿元。");
  expect(composeBusinessReport([negative], {...input(), summary: "较上月变动-{{personal.mom.difference}}。"}).report.summary).toBe("较上月变动-2亿元。");
  expect(() => composeBusinessReport([source()], {...input(), summary: "同比高于较上月，说明增长放缓。"})).toThrow("周期不同");
  expect(() => composeBusinessReport([source()], {...input(), summary: "较同期增速高于较年初，说明增长集中在上半年。"})).toThrow("连续月度余额");
  expect(() => composeBusinessReport([source()], {...input(), summary: "同比增幅高于年初至今增幅，显示年度内增长主要集中在年初至今的阶段，需要连续月度数据才能判断节奏。"})).toThrow("连续月度余额");
  expect(() => composeBusinessReport([source()], {...input(), summary: "较同期和较年初增长集中在对公贷款。"})).not.toThrow();
  expect(() => composeBusinessReport([source()], {...input(), summary: "单月增长温和。"})).toThrow("截至日");
  expect(() => composeBusinessReport([source()], {...input(), summary: "个人贷款持续收缩。"})).toThrow("截至日");
  expect(() => composeBusinessReport([source()], {...input(), summary: "较上月变化不大，月度动能明显趋缓。"})).toThrow("截至日");
  expect(() => composeBusinessReport([source()], {...input(), summary: "无法判断月度动能是否趋缓。"})).not.toThrow();
  expect(() => composeBusinessReport([source()], {...input(), summary: "只有截至日记录，不能判断贷款持续增长。"})).not.toThrow();
  expect(() => composeBusinessReport([source()], {...input(), summary: "贷款持续增长，不能判断投放原因。"})).toThrow("截至日");
  expect(() => composeBusinessReport([source()], {...input(), summary: "从较昨日看贷款有所下降。"})).toThrow("没有逐日比较");
  expect(() => composeBusinessReport([source()], {...input(), summary: "没有较昨日证据，无法判断每日变化。"})).not.toThrow();
  expect(() => composeBusinessReport([source()], {...input(), summary: "不良率保持低位，风险可控。"})).toThrow("阈值或同业对照");
  expect(() => composeBusinessReport([source()], {...input(), summary: "贷款规模增长摊薄不良率。"})).toThrow("分母口径");
});
it("增长来源排序不同不能称各期间增量最大，主要贡献不等于最大增量", () => {
  const ranked = {...source(), evidence_items: [...source().evidence_items,
    {ref: "growth_sources.mom", label: "较上月排序", display: "贴现、对公", ranked_increases: ["discount", "company"]},
    {ref: "growth_sources.yoy", label: "较同期排序", display: "对公", ranked_increases: ["company"]}]};
  expect(() => composeBusinessReport([ranked], {...input(), summary: "对公是各比较期间增量最大的分项。"})).toThrow("最大增加分项不同");
  expect(() => composeBusinessReport([ranked], {...input(), summary: "总量增长主要由对公拉动。"})).not.toThrow();
  expect(() => composeBusinessReport([ranked], {...input(), summary: "对公是各比较期间增长的主要贡献来源。"})).not.toThrow();
  expect(() => composeBusinessReport([ranked], {...input(), summary: "较同期增长主要由对公拉动。"})).not.toThrow();
  expect(() => composeBusinessReport([ranked], {...input(), summary: "对公是同比主要拉动项；贴现较上月增加。"})).not.toThrow();
  expect(() => composeBusinessReport([ranked], {...input(), summary: "各比较期间主要增长来源不同，需分别观察。"})).not.toThrow();
});
it("质量复合判断必须与余额和比例各自的比较方向一致", () => {
  const quality = {...source(), evidence_items: [...source().evidence_items,
    {ref: "npl_balance.mom.difference", display: "-3亿元", value: "-3", label: "不良余额较上月"},
    {ref: "npl_ratio.mom.difference", display: "-0.01个百分点", value: "-0.0001", label: "不良率较上月"},
    {ref: "npl_balance.yoy.difference", display: "22亿元", value: "22", label: "不良余额较同期"},
    {ref: "npl_ratio.yoy.difference", display: "-0.02个百分点", value: "-0.0002", label: "不良率较同期"}]};
  expect(() => composeBusinessReport([quality], {...input(), summary: "不良贷款余额与不良率较上月与较同期均改善。"})).toThrow("并非均改善");
  expect(() => composeBusinessReport([quality], {...input(), summary: "不良贷款余额与不良率较年初均上升。"})).toThrow("缺少有效比较证据");
  expect(() => composeBusinessReport([quality], {...input(), summary: "不良贷款余额与不良率较上月均改善。"})).not.toThrow();
  expect(() => composeBusinessReport([quality], {...input(), summary: "不良余额较上月回落但较同期上升，不良率较上月和较同期均回落。"})).not.toThrow();
  expect(() => composeBusinessReport([quality], {...input(), summary: "不良率应单独看待。分母扩张对比率的摊薄作用大于余额增长。"})).toThrow("分母口径");
});
it("补查保留初查已取得的其他比较列", () => {
  const first = {...source(), table_rows: [{...source().table_rows[0]!, 较同期: "10亿元", 较年初: "8亿元"}]};
  const next = {...source(), table_rows: [{...source().table_rows[0]!, 较上月: "5亿元", 较同期: "—", 较年初: "—"}]};
  const report = composeBusinessReport([first, next], {...input(), evidence_refs: ["e1", "e2"]});
  expect(report.rows[0]).toMatchObject({mom_change: "5亿元", yoy_change: "10亿元", ytd_change: "8亿元"});
});
it("允许已查询月份和证据内基期日期，不放行未知日期", () => {
  const withGap = {...source(), evidence_items: [...source().evidence_items, {ref: "gap.base", display: "2026-07-31缺组成记录", label: "缺口"}]};
  expect(() => composeBusinessReport([withGap], {...input(), summary: "2026年8月截至日余额为{{total.current}}，2026年7月31日缺组成记录。"})).not.toThrow();
  expect(() => composeBusinessReport([withGap], {...input(), summary: "2025年7月31日贷款增长。"})).toThrow("业务数字只能");
});

it("报告格式自动整理，精确数字仍来自唯一证据", () => {
  const report = composeBusinessReport([source()], {...input(), summary: "余额为120亿元。",
    sections: [{title: "规模", text: "余额为{{total.current}}亿元。", evidence_refs: []}]});
  expect(report.report.summary).toBe("余额为120亿元。");
  expect(report.report.sections[0]?.text).toBe("余额为120亿元。");
  expect(report.report.sections[0]?.evidence_refs).toEqual(["total.current"]);
  const ambiguous = {...source(), evidence_items: [...source().evidence_items,
    {ref: "personal.current", display: "120亿元", label: "个人贷款"}]};
  expect(() => composeBusinessReport([ambiguous], {...input(), summary: "余额120亿元。"})).toThrow("业务数字只能");
  expect(() => composeBusinessReport([source()], {...input(), summary: "余额{{total.current}}万元。"})).toThrow("已包含单位");
  expect(() => composeBusinessReport([source()], {...input(), summary: "余额-120亿元。"})).toThrow("业务数字只能");
});

it("期间报告展开每月实际记录、允许缺口月份，禁止混入不同期间", () => {
  const period = {start: "2026-05-01", end: "2026-10-31", checked_on: "2026-10-13",
    snapshot_dates: ["2026-06-30", "2026-08-27"],
    months: [{month: "2026-05", as_of: null, date_count: 0},
      {month: "2026-06", as_of: "2026-06-30", date_count: 1}, {month: "2026-08", as_of: "2026-08-27", date_count: 1}]};
  const ranged: OverviewEvidence = {...source(), date_selection: "available_in_range", period,
    requested_date: period.end, table_rows: [
      {...source().table_rows[0]!, data_date: "2026-06-30", 当前值: "100亿元"},
      {...source().table_rows[0]!, data_date: "2026-08-27"}],
    evidence_items: [...source().evidence_items, {ref: "d20260630.total.current", display: "100亿元", label: "六月贷款"}]};
  const report = composeBusinessReport([ranged], {...input(), summary: "5月没有记录，最新余额{{total.current}}。"});
  expect(report.rows.map(row => row.metric_name)).toEqual(["各项贷款", "各项贷款"]);
  expect(report.rows.map(row => row.stat_date)).toEqual(["2026-06-30", "2026-08-27"]);
  expect(report.columns).toContain("stat_date");
  expect(report.public_answer).toContain("2026-05-01至2026-10-31");
  expect(() => composeBusinessReport([ranged, {...ranged, period: {...period, start: "2026-04-01"}}], input())).toThrow("同一机构");
});

it("部分报告保留真实表格与通过校验的分析，不放行错误结论和机构混用", () => {
  const report = composePartialBusinessReport([source()], {...input(), summary: "余额999亿元。",
    sections: [...input().sections, {title: "错误结论", text: "不良率偏高，风险可控。", evidence_refs: ["total.current"]}]});
  expect(report.partial_analysis).toBe(true);
  expect(report.rows[0]?.current_value).toBe("120亿元");
  expect(report.report.sections).toHaveLength(1);
  expect(report.public_answer).not.toContain("999");
  expect(report.public_answer).not.toContain("风险可控");
  expect(report.public_answer).toContain("部分解释尚缺少充分依据");
  expect(() => composePartialBusinessReport([source(), {...source(), org_codes: ["O2"]}], input())).toThrow("同一机构");
});

it("自由正文局部数值失败只剔除问题段落，不把整篇正文变为一条提示", async () => {
  const data: OverviewEvidence = {...source(), topic: "deposit", evidence_items: [...source().evidence_items,
    {ref: "total.mom.difference", display: "2亿元", label: "较上月"},
    {ref: "total.mom.rate", display: "1.69%", label: "较上月增幅"}]};
  const backend = {resolveBusinessField: async () => ({status: "resolved", value: {codes: ["O1"]}}),
    getTask: async () => ({})} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence: data}]});
  const proposal = {evidence_refs: ["e1"], metric_ids: ["total"], body: "**规模观察**\n\n截至2026年8月27日，存款为120亿元，较上月增加2亿元（+1.69%）。\n\n**结构推测**\n\n另一类存款的增幅高出约8.4个百分点。"};
  const first = await runTool(createBusinessReportTool(), proposal, request);
  expect(first.details.status).toBe("ARGUMENT_ERROR");
  expect(first.content[0].text).toContain("8.4");
  expect(first.content[0].text).not.toContain("1.69");
  const result = await runTool(createBusinessReportTool(), proposal, request);
  expect(result.terminate).toBe(true);
  expect(result.details.partial_analysis).toBe(true);
  expect(result.details.report.summary).toContain("存款为120亿元，较上月增加2亿元（1.69%）");
  expect(result.details.report.summary).toContain("规模观察");
  expect(result.details.report.summary).not.toContain("结构推测");
  expect(result.details.report.summary).not.toContain("8.4");
  expect(result.details.report.body_evidence).toEqual([{paragraph: 2,
    evidence_refs: ["total.current", "total.mom.difference", "total.mom.rate"]}]);
  expect(result.details.rows).toHaveLength(1);
});

it("所有模型段落均失败时，从已校验回执生成可见事实及比较，不发明数字或因果", () => {
  const data: OverviewEvidence = {...source(), topic: "deposit", table_rows: [{...source().table_rows[0]!, 指标: "1104类合成存款"}],
    evidence_items: [...source().evidence_items,
      {ref: "total.mom.difference", display: "-2亿元", label: "较上月"},
      {ref: "total.mom.rate", display: "-1.64%", label: "较上月增幅"}],
    gaps: [{reason: "该期间缺少连续月度记录"}]};
  const report = composePartialBusinessReport([data], {...input(), summary: "**错误推断**\n\n存款999亿元，说明客户流失。", sections: []});
  expect(report.report.summary).toContain("截至2026-08-27，1104类合成存款为120亿元；较上月变动-2亿元（-1.64%）");
  expect(report.report.summary).toContain("该期间缺少连续月度记录");
  expect(report.report.summary).not.toMatch(/999|客户流失|错误推断/);
  expect(report.report.body_evidence).toEqual([{paragraph: 1,
    evidence_refs: ["total.current", "total.mom.difference", "total.mom.rate"]}]);
  expect(report.public_answer).toContain(report.report.summary);
  expect(report.rows[0]?.current_value).toBe("120亿元");
});

it("正文降级不只保留无引用标题或结论，也不放宽错误机构日期与指标选择", () => {
  const report = composePartialBusinessReport([source()], {...input(), summary: "**仅有标题**\n\n余额999亿元。", sections: []});
  expect(report.report.summary).toContain("各项贷款为120亿元");
  expect(report.report.summary).not.toContain("仅有标题");
  expect(() => composePartialBusinessReport([source()], {...input(), metric_ids: ["unknown"]})).toThrow("实际取得");
  expect(() => composePartialBusinessReport([source(), {...source(), analysis_date: "2026-07-31"}], input())).toThrow("同一机构");
});

it("文字降级仍重新检查权限，不因此前报告错误泄露已无权查看的数据", async () => {
  const {BackendApiError} = await import("../backendClient.js");
  const getTask = vi.fn(async () => ({}));
  const backend = {resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: ["O1"]}})), getTask} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {answerEvidence: async () => [{ref: "e1", evidence: source()}]});
  const proposal = {evidence_refs: ["e1"], metric_ids: ["total"], body: "余额999亿元。"};
  expect((await runTool(createBusinessReportTool(), proposal, request)).details.status).toBe("ARGUMENT_ERROR");
  getTask.mockRejectedValueOnce(new BackendApiError(403, "无权读取", "FORBIDDEN"));
  await expect(runTool(createBusinessReportTool(), proposal, request)).rejects.toThrow("无权读取");
});

it("精确正值可绑定正号展示，反向负号、重复正号、歧义值仍拒绝", () => {
  const valid = composeBusinessReport([source()], {...input(), summary: "余额+120亿元。", sections: []});
  expect(valid.report.summary).toBe("余额120亿元。");
  expect(valid.report.body_evidence).toEqual([{paragraph: 1, evidence_refs: ["total.current"]}]);
  for (const summary of ["余额-120亿元。", "余额++120亿元。", "余额+119亿元。"]) {
    expect(() => composeBusinessReport([source()], {...input(), summary})).toThrow("业务数字只能");
  }
  const ambiguous = {...source(), evidence_items: [...source().evidence_items,
    {ref: "other.current", display: "120亿元", label: "其他"}]};
  expect(() => composeBusinessReport([ambiguous], {...input(), summary: "余额+120亿元。"})).toThrow("业务数字只能");
});

it("事实降级保留真实零值及期间各自日期，不将缺失值填成零", () => {
  const data: OverviewEvidence = {...source(), period: {start: "2026-07-01", end: "2026-08-31", checked_on: "2026-10-20",
    snapshot_dates: ["2026-07-31", "2026-08-27"], months: []}, table_rows: [
      {metric_id: "total", 指标: "合成余额", data_date: "2026-07-31", 当前值: "0亿元"},
      {metric_id: "total", 指标: "合成余额", data_date: "2026-08-27", 当前值: "120亿元"},
      {metric_id: "missing", 指标: "合成缺失项", data_date: "2026-08-27", 当前值: "—"}],
    evidence_items: [{ref: "d20260731.total.current", display: "0亿元", label: "合成余额"},
      {ref: "d20260827.total.current", display: "120亿元", label: "合成余额"}]};
  const report = composePartialBusinessReport([data], {...input(), summary: "余额999亿元。", sections: []});
  expect(report.report.summary).toContain("截至2026-07-31，合成余额为0亿元");
  expect(report.report.summary).toContain("截至2026-08-27，合成余额为120亿元");
  expect(report.report.summary).not.toContain("合成缺失项为0");
  expect(report.report.body_evidence).toEqual([{paragraph: 1, evidence_refs: ["d20260731.total.current"]},
    {paragraph: 2, evidence_refs: ["d20260827.total.current"]}]);
});

it("期间月份列表与实际快照数量可从覆盖元数据校验", () => {
  const ranged: OverviewEvidence = {...source(), period: {start: "2026-05-01", end: "2026-10-31", checked_on: "2026-10-13",
    snapshot_dates: ["2026-08-27"], months: [5,6,7,8,9,10].map(month => ({month: `2026-${String(month).padStart(2,"0")}`, as_of: month === 8 ? "2026-08-27" : null, date_count: month === 8 ? 1 : 0}))}};
  expect(() => composeBusinessReport([ranged], {...input(), summary: "5、6、7、9月缺数，仅有1个月快照。"})).not.toThrow();
  expect(() => composeBusinessReport([ranged], {...input(), summary: "有3个月快照。"})).toThrow("业务数字只能");
  expect(() => composeBusinessReport([ranged], {...input(), summary: "5-10月期间取得1条记录，5、6、7、9、10月缺数。"})).not.toThrow();
  expect(() => composeBusinessReport([ranged], {...input(), summary: "5至7月和9至10月缺数，仅有1条记录。"})).not.toThrow();
  expect(() => composeBusinessReport([ranged], {...input(), summary: "4-10月期间取得2条记录。"})).toThrow("业务数字只能");
});

it("存款报告披露来源并拒绝混合贷款或其他主题版本", () => {
  const deposit: OverviewEvidence = {...source(), topic: "deposit", topic_version: "deposit-pilot-v1",
    source_notice: "数值来自实际指标查询库，Excel仅作映射。", context_notice: "使用账户所属机构。"};
  const report = composeBusinessReport([deposit], {...input(), summary: "存款为{{total.current}}。", sections: []});
  expect(report.public_answer).toContain("存款分析");
  expect(report.public_answer).toContain(deposit.source_notice);
  expect(report.public_answer).not.toContain("核销");
  expect(() => composeBusinessReport([deposit, source()], input())).toThrow("主题版本");
  expect(() => composeBusinessReport([deposit, {...deposit, topic_version: "other"}], input())).toThrow("主题版本");
});

it.each(["余额增加，说明没有客户流失。", "活期转定期，与成本下降方向相反。"])("存款不能用结构或余额证明客户流失或成本方向：%s", summary => {
  expect(() => composeBusinessReport([{...source(), topic: "deposit"}], {...input(), summary})).toThrow("当前没有");
});

it("来源与占比变化不能由模型另行推断", () => {
  const deposit: OverviewEvidence = {...source(), topic: "deposit", metric_sources: {
    company_current: "1104", company_fixed: "1104"}};
  expect(() => composeBusinessReport([deposit], {...input(), summary: "对公活期与定期来自不同数据来源。"})).toThrow("同一业务来源");
  expect(() => composeBusinessReport([deposit], {...input(), summary: "对公定期在存款中的相对比重明显上升。"})).toThrow("占比变化证据");
});

it("活期占比下降不能代替定期占比上升，也不能反写方向", () => {
  const deposit: OverviewEvidence = {...source(), topic: "deposit", evidence_items: [...source().evidence_items,
    {ref: "company_current_share.mom.difference", display: "-2个百分点", value: "-0.02", label: "对公活期占比较上月"}]};
  expect(() => composeBusinessReport([deposit], {...input(), summary: "对公活期占比较上月下降，定期在对公存款中的相对比重上升。"})).toThrow("定期占比变化证据");
  expect(() => composeBusinessReport([deposit], {...input(), summary: "活期占比呈收缩、定期占比扩张。"})).toThrow("定期占比变化证据");
  expect(() => composeBusinessReport([deposit], {...input(), summary: "对公活期占比较上月上升。"})).toThrow("支持所述方向");
  expect(() => composeBusinessReport([deposit], {...input(), summary: "对公活期占比较上月回落，定期余额增加。"})).not.toThrow();
});

it("月中快照不能称月末，月末单快照也不证明连续增长", () => {
  expect(() => composeBusinessReport([source()], {...input(), summary: "实际取得8月末数据。"})).toThrow("月中截至日");
  expect(() => composeBusinessReport([source()], {...input(), summary: "8月末数据尚未齐全，现有数据为截至日记录。"})).not.toThrow();
  const monthEnd = {...source(), analysis_date: "2026-07-31", requested_date: "2026-07-31"};
  expect(() => composeBusinessReport([monthEnd], {...input(), summary: "取得7月末数据。"})).not.toThrow();
  expect(() => composeBusinessReport([monthEnd], {...input(), summary: "定期存款持续增长。"})).toThrow("连续趋势");
});
