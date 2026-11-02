import {describe, expect, it, vi} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";
import {createBusinessReportTool, composePartialBusinessReport, type OverviewEvidence} from "../src/tools/businessReport.js";

const source: OverviewEvidence = {kind: "business_overview", status: "succeeded", topic: "deposit", topic_version: "test-v1",
  analysis_date: "2026-09-30", requested_date: "2026-09-30", org_codes: ["O1"], org_name: "测试机构", basis: "测试口径",
  evidence_items: [
    {ref: "total.current", display: "100元", label: "各项存款", value: "100"},
    {ref: "total.mom.difference", display: "5元", label: "较上月差额", value: "5"},
    {ref: "total.mom.rate", display: "5.26%", label: "较上月增幅", value: "0.0526"},
    {ref: "total.yoy.difference", display: "-2元", label: "较同期差额", value: "-2"},
    {ref: "total.ytd.difference", display: "0元", label: "较年初差额", value: "0"},
    {ref: "judgment.total.direction", display: "各项存款较上月增加，较同期减少，较年初持平。", label: "正式比较判断",
      judgment_kind: "comparison_direction", input_refs: ["total.mom.difference", "total.yoy.difference", "total.ytd.difference"]},
  ], table_rows: [{metric_id: "total", 指标: "各项存款", 当前值: "100元", 较上月: "5元", 较同期: "-2元", 较年初: "0元"}],
  table_columns: [], tasks: [{task_id: "task-1", status: "succeeded"}], gaps: []};

function harness(sources: OverviewEvidence[] = [source], history: AgentMessage[] = []) {
  const tool = createBusinessReportTool();
  const resolveBusinessField = vi.fn(async () => ({status: "resolved", value: {codes: ["O1"]}}));
  const getTask = vi.fn(async () => ({status: "succeeded"}));
  const backend = {resolveBusinessField, getTask} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge(), {originalMessage: "我们行存款怎么少了？",
    turnMessages: async () => history,
    answerEvidence: async () => sources.map((evidence, index) => ({ref: `e${index + 1}`, evidence}))});
  const present = async (body = "各项存款余额为 **999 元**。", metric_ids = ["total"]) => {
    const args = validateToolArguments(tool, {type: "toolCall", id: "report", name: tool.name,
      arguments: {body, metric_ids, evidence_refs: sources.map((_, index) => `e${index + 1}`)}});
    const result = await runTool(tool, args, request);
    history.push({role: "toolResult", toolName: tool.name, toolCallId: `report-${history.length}`,
      content: result.content, details: result.details, isError: false, timestamp: 0});
    return result;
  };
  const recover = async (...args: Parameters<typeof present>) => {await present(...args); return present(...args);};
  return {present, recover, resolveBusinessField, getTask};
}

describe("专项报告的有界文案修正与事实交付", () => {
  it("公共正文不自动拼接口径与内部来源，实际截至日和缺数仍可见", async () => {
    const latest: OverviewEvidence = {...source, date_selection: "latest_snapshot", analysis_date: "2026-08-27",
      basis: "金额使用正式目录的当日余额，组成关系仍需业务审核",
      source_notice: "数值来自项目配置指标查询库，经基础查询接口读取。",
      context_notice: "使用当前主题版本映射。",
      data_freshness: {checked_on: "2026-10-26", as_of: "2026-08-27", lag_days: 60,
        notice: "已按所选指标向前查询，查询日期2026-10-26，相隔60天。"},
      gaps: [{label: "不良贷款", reason: "较同期数据暂不可用。"}]};
    const result = await harness([latest]).present("各项存款余额{{total.current}}。");
    expect(result.details.public_answer).not.toMatch(/业务审核|配置指标查询库|主题版本映射|查询日期2026-10-26|业务动因仍需/u);
    expect(result.details.public_answer).toContain("最新可用数据：2026-08-27");
    expect(result.details.public_answer).toContain("不良贷款较同期数据暂不可用");
    expect(result.details.report.presentation.limitations).toContain(latest.basis);
    expect(result.details.source_notice).toBe(latest.source_notice);
    expect(result.details.partial_analysis).toBe(true);
  });

  it("公共正文保留用户指定日期与实际参考日期的差异", async () => {
    const result = await harness([{...source, analysis_date: "2026-08-31", requested_date: "2026-09-30",
      date_selection: "exact", gaps: [{reason: "所问月份尚无完整数据，当前仅提供参考记录。"}]}])
      .present("各项存款余额{{total.current}}。");
    expect(result.details.public_answer).toContain("查询日期：2026-09-30");
    expect(result.details.public_answer).toContain("实际数据日期：2026-08-31");
    expect(result.details.public_answer).toContain("所问月份尚无完整数据");
  });

  it("整篇修正仍失败时不拼接失去前提的句子和无依据评价", async () => {
    const result = await harness().recover("存款余额999元。存款持续增长{{total.current|cite}}。这一差异说明经营效果突出。\n\n整体表现稳健。");
    expect(result.details.status).toBe("succeeded");
    expect(result.details.report.summary).not.toMatch(/这一差异|效果突出|整体表现稳健/);
    expect(result.details.report.summary).toContain("100元");
    expect(result.details.report.summary).toContain("较上月增加5元");
    expect(result.details.report.summary).toContain("较同期减少2元");
  });

  it("查询期间只有单日记录时默认可见正文和范围都披露实际覆盖", async () => {
    const period = {start: "2026-07-01", end: "2026-09-30", checked_on: "2026-10-26",
      snapshot_dates: ["2026-08-27"], months: [
        {month: "2026-07", as_of: null, date_count: 0},
        {month: "2026-08", as_of: "2026-08-27", date_count: 1},
        {month: "2026-09", as_of: null, date_count: 0}]};
    const result = await harness([{...source, analysis_date: "2026-08-27", period,
      date_selection: "available_in_range", gaps: []}]).present("各项存款余额{{total.current}}。");
    expect(result.details.partial_analysis).toBe(true);
    expect(result.details.report.presentation.scope).toContain("2026-08-27");
    expect(result.details.report.presentation.scope).toContain("2026-07-01至2026-09-30");
    expect(result.details.report.summary).toContain("2026-08-27");
    expect(result.details.report.summary).toContain("2026-07、2026-09");
    expect(result.details.report.summary).toMatch(/不能|不足以/);
    expect(result.details.report.body_evidence).toEqual([{paragraph: 2, evidence_refs: ["total.current"]}]);
  });

  it("全缺数时一次正文重写失败后交付缺口，不继续纠错循环", async () => {
    const missing = {...source, evidence_items: [], table_rows: [],
      gaps: [{label: "各项存款", reason: "所选日期没有可用记录。"}]};
    const result = await harness([missing]).recover("存款为100元。", []);
    expect(result.terminate).toBe(true);
    expect(result.details.status).toBe("succeeded");
    expect(result.details.partial_analysis).toBe(true);
    expect(result.details.report.summary).toContain("未取得可用指标记录");
    expect(result.details.report.summary).toContain("所选日期没有可用记录");
    expect(result.details.rows).toEqual([]);
  });

  it("实际业务缺口必须在默认正文交付且不依赖展开明细", async () => {
    const result = await harness([{...source,
      gaps: [{label: "对公存款", reason: "较同期数据暂不可用，相关比较未纳入本次分析。"}]}])
      .present("各项存款余额{{total.current}}。");
    expect(result.details.report.summary).toContain("对公存款较同期数据暂不可用");
    expect(result.details.report.summary.match(/对公存款较同期数据暂不可用/gu)).toHaveLength(1);
    expect(result.details.public_answer.match(/对公存款较同期数据暂不可用/gu)).toHaveLength(1);
  });
  it("报告顶部已有时点时精简标题的同日日期，正文基期不改写", async () => {
    const {present} = harness();
    const result = await present("**存款情况（截至 2026-09-30）**\n\n各项存款余额{{total.current}}，较上月增加{{total.mom.difference}}。");
    expect(result.details.report.summary).toBe("**存款情况**\n\n各项存款余额100元，较上月增加5元。");
  });
  it("首次纯文案错误保留一次修正机会，合法重写直接交付", async () => {
    const {present} = harness();
    const first = await present();
    expect(first.details).toMatchObject({kind: "business_report", status: "ARGUMENT_ERROR",
      error_code: "ANALYSIS_REPORT_PROSE", retryable: true});
    expect(first.terminate).not.toBe(true);
    expect(first.details.narrative_repaired).toBeUndefined();
    const fixed = await present("各项存款余额{{total.current}}，较上月增加{{total.mom.difference}}。");
    expect(fixed.details.report.summary).toBe("各项存款余额100元，较上月增加5元。");
    expect(fixed.details.narrative_repaired).toBeUndefined();
    expect(fixed.terminate).toBe(true);
  });

  it("上轮文案错误不消耗本轮修正机会", async () => {
    const history: AgentMessage[] = [{role: "toolResult", toolName: "business_report_present", toolCallId: "old",
      content: [], details: {error_code: "ANALYSIS_REPORT_PROSE"}, isError: false, timestamp: 0},
    {role: "user", content: "重新看看存款", timestamp: 1}];
    const result = await harness([source], history).present();
    expect(result.details.error_code).toBe("ANALYSIS_REPORT_PROSE");
    expect(result.terminate).not.toBe(true);
  });

  it("第二次仍有文案错误时按真实事实交付，旧证据无比较计划时保留全部已有比较", async () => {
    const {recover, resolveBusinessField, getTask} = harness();
    const result = await recover();
    expect(result).toMatchObject({terminate: true, details: {status: "succeeded", narrative_repaired: true,
      narrative_repair: {reason_code: "REPORT_PROSE_VALIDATION"}, partial_analysis: false, gaps: []}});
    expect(result.details.report.summary).toContain("各项存款为100元");
    expect(result.details.report.summary).toContain("较上月增加5元（5.26%）");
    expect(result.details.report.summary).toContain("较同期减少2元");
    expect(result.details.report.summary).toContain("较年初变化0元");
    expect(result.details.report.summary).not.toContain("存款并未减少");
    expect(result.details.evidence_items).toEqual(source.evidence_items);
    expect(result.details.rows[0]).toMatchObject({current_value: "100元", mom_change: "5元", yoy_change: "-2元", ytd_change: "0元"});
    expect(result.content[0].text).not.toMatch(/修复|未通过|已省略/);
    expect(resolveBusinessField).toHaveBeenCalledTimes(2);
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it.each([
    {comparisons: ["yoy"], included: ["较同期减少2元"], excluded: ["较上月", "较年初"]},
    {comparisons: ["mom", "ytd"], included: ["较上月增加5元", "较年初变化0元"], excluded: ["较同期"]},
  ])("事实恢复保留计划要求的全部比较$comparisons，不固定截取较上月", async ({comparisons, included, excluded}) => {
    const result = await harness([{...source, plan: {comparisons}}]).recover();
    for (const text of included) expect(result.details.report.summary).toContain(text);
    for (const text of excluded) expect(result.details.report.summary).not.toContain(text);
    expect(result.details.rows[0]).toMatchObject({mom_change: "5元", yoy_change: "-2元", ytd_change: "0元"});
  });

  it("已通过校验的自主正文保持原样，不触发事实重建", async () => {
    const result = await harness().present("各项存款余额为{{total.current}}。");
    expect(result.details).toMatchObject({status: "succeeded", partial_analysis: false});
    expect(result.details.report.summary).toBe("各项存款余额为100元。");
    expect(result.details.narrative_repaired).toBeUndefined();
    expect(result.details.narrative_repair).toBeUndefined();
  });

  it("事实修复只使用选中指标的事实与判断", async () => {
    const other = {...source, evidence_items: [
      {ref: "personal.current", display: "80元", label: "个人存款", value: "80"},
      {ref: "personal.mom.difference", display: "8元", label: "个人较上月差额", value: "8"},
      {ref: "judgment.personal.direction", display: "个人存款较上月增加。", label: "个人正式比较判断",
        judgment_kind: "comparison_direction", input_refs: ["personal.mom.difference"]},
      ...source.evidence_items], table_rows: [{metric_id: "personal", 指标: "个人存款", 当前值: "80元", 较上月: "8元"},
      ...source.table_rows]};
    const result = await harness([other]).recover();
    expect(result.details).toMatchObject({status: "succeeded", narrative_repaired: true, row_count: 1});
    expect(result.details.report.summary).not.toContain("个人");
    expect(result.details.report.body_evidence.flatMap((item: {evidence_refs: string[]}) => item.evidence_refs))
      .not.toContain("judgment.personal.direction");
  });

  it("已有真实数据缺口仍标记部分交付", async () => {
    const incomplete = {...source, gaps: [{label: "分类", reason: "部分分类未取得数据"}]};
    const result = await harness([incomplete]).recover();
    expect(result.details).toMatchObject({status: "succeeded", narrative_repaired: true, partial_analysis: true});
    expect(result.details.gaps).toEqual(["分类部分分类未取得数据"]);
  });

  it("恢复正文先说明总量，再说明分项，表格仍保持请求顺序", async () => {
    const combined = {...source, evidence_items: [
      {ref: "personal.current", display: "80元", label: "个人存款", value: "80"},
      ...source.evidence_items], table_rows: [{metric_id: "personal", 指标: "个人存款", 当前值: "80元"},
      ...source.table_rows]};
    const result = await harness([combined]).recover(undefined, ["personal", "total"]);
    expect(result.details.report.summary.startsWith("各项存款为100元")).toBe(true);
    expect(result.details.report.summary).toContain("个人存款为80元");
    expect(result.details.rows.map((row: {metric_name: string}) => row.metric_name)).toEqual(["个人存款", "各项存款"]);
  });

  it.each([
    {metric_ids: ["total", "personal"], comparisons: ["mom", "yoy"], focused: true},
    {metric_ids: ["total"], comparisons: ["mom", "yoy"], focused: false},
    {metric_ids: ["total", "personal"], comparisons: ["yoy"], focused: false},
  ])("事实恢复不重复附加已经由比较数值说明的方向判断 $metric_ids/$comparisons", async ({metric_ids, comparisons, focused}) => {
    const combined = {...source, plan: {comparisons}, evidence_items: [
      ...source.evidence_items,
      {ref: "personal.current", display: "80元", label: "个人存款", value: "80"},
      {ref: "personal.mom.difference", display: "-3元", label: "个人较上月差额", value: "-3"},
      {ref: "personal.yoy.difference", display: "4元", label: "个人较同期差额", value: "4"},
      {ref: "judgment.personal.divergence", display: "个人存款较上月减少、较同期增加。", label: "比较基期差异",
        judgment_kind: "baseline_divergence", input_refs: ["personal.mom.difference", "personal.yoy.difference"]},
    ], table_rows: [...source.table_rows, {metric_id: "personal", 指标: "个人存款", 当前值: "80元", 较上月: "-3元", 较同期: "4元"}]};
    const result = await harness([combined]).recover(undefined, metric_ids);
    const summary = result.details.report.summary as string;
    expect(summary.startsWith("各项存款为100元")).toBe(true);
    if (focused) {
      expect(summary).toContain("个人存款为80元；较上月减少3元；较同期增加4元");
      expect(summary.match(/个人存款/gu)).toHaveLength(1);
      expect(result.details.report.body_evidence[1].evidence_refs).toEqual([
        "personal.current", "personal.mom.difference", "personal.yoy.difference"]);
    } else {
      expect(summary).not.toContain("个人存款较上月减少、较同期增加。");
    }
  });

  it.each([
    {period: "yoy", value: "-2", display: "-2元", expected: "较同期减少2元"},
    {period: "ytd", value: "0", display: "0元", expected: "较年初变化0元"},
  ])("没有较上月数据时只用已有$period比较，不把缺数当零", async ({period, value, display, expected}) => {
    const available = {...source, evidence_items: [source.evidence_items[0]!,
      {ref: `total.${period}.difference`, value, display, label: "已取得的比较"}]};
    const result = await harness([available]).recover();
    expect(result.details.report.summary).toContain(expected);
    expect(result.details.report.summary).not.toContain("较上月");
    expect(result.details.evidence_items).toEqual(available.evidence_items);
  });

  it("明确的部分交付入口保持未完成语义", () => {
    const report = composePartialBusinessReport([source], {evidence_refs: ["e1"], summary: "", sections: [], metric_ids: ["total"]});
    expect(report.partial_analysis).toBe(true);
    expect(report.report.summary).toContain("各项存款为100元");
    expect(report.report.summary).not.toContain("{{");
  });

  it("合法段落不能掩盖同次查询其他指标的事实丢失", () => {
    const combined = {...source, evidence_items: [...source.evidence_items,
      {ref: "personal.current", display: "80元", label: "个人存款", value: "80"}],
    table_rows: [...source.table_rows, {metric_id: "personal", 指标: "个人存款", 当前值: "80元"}]};
    const report = composePartialBusinessReport([combined], {evidence_refs: ["e1"],
      summary: "各项存款为{{total.current}}。\n\n个人存款已经增长{{personal.current|cite}}。",
      sections: [], metric_ids: ["total", "personal"]});
    expect(report.report.summary).toContain("各项存款为100元");
    expect(report.report.summary).toContain("个人存款为80元");
    expect(report.report.summary).not.toContain("个人存款已经增长");
    expect(report.report.body_evidence.flatMap(item => item.evidence_refs)).toContain("personal.current");
  });

  it("再次校验失败按全部已选指标交付事实，保留完整明细", async () => {
    const combined = {...source, evidence_items: [...source.evidence_items,
      {ref: "personal.current", display: "80元", label: "个人存款", value: "80"},
      {ref: "personal.mom.difference", display: "8元", label: "个人较上月差额", value: "8"}],
    table_rows: [...source.table_rows, {metric_id: "personal", 指标: "个人存款", 当前值: "80元", 较上月: "8元"}]};
    const body = "存款余额999元。各项存款持续增长{{total.current|cite}}。\n\n从个人业务看，存款余额{{personal.current}}，较上月增加{{personal.mom.difference}}。可继续关注其分项表现。";
    const result = await harness([combined]).recover(body, ["total", "personal"]);
    expect(result.details).toMatchObject({status: "succeeded", narrative_repaired: true, row_count: 2});
    expect(result.details.report.summary).toContain("个人存款为80元；较上月增加8元");
    expect(result.details.report.summary).toContain("各项存款为100元");
    expect(result.details.report.summary).not.toContain("持续增长");
    expect(result.details.report.summary.match(/80元/gu)).toHaveLength(1);
    expect(result.details.rows.map((row: {metric_name: string}) => row.metric_name)).toEqual(["各项存款", "个人存款"]);
    expect(result.details.report.body_evidence.flatMap((item: {evidence_refs: string[]}) => item.evidence_refs))
      .toEqual(expect.arrayContaining(["total.current", "personal.current", "personal.mom.difference"]));
  });

  it("事实重建不重复陈述同一指标", async () => {
    const body = "存款余额999元。各项存款持续增长{{total.current|cite}}。\n\n存款余额{{total.current}}，较上月增加{{total.mom.difference}}，较同期减少{{total.yoy.difference}}。不同基期的变化需要分别看。";
    const result = await harness().recover(body);
    expect(result.details.report.summary.match(/100元/gu)).toHaveLength(1);
    expect(result.details.report.summary).toContain("较同期减少2元");
    expect(result.details.rows).toHaveLength(1);
  });

  it("错误草稿被整体替换但不丢失已核验事实和来源限制", async () => {
    const body = "存款余额999元。存款余额{{total.current}}，较上月增加{{total.mom.difference}}（{{total.mom.rate}}）。存款持续增长。\n\n仅凭余额变化，尚不能确认客户流失，需要账户流水进一步核实。";
    const result = await harness().recover(body);
    expect(result.details.report.summary).toContain("100元；较上月增加5元（5.26%）");
    expect(result.details.report.summary).not.toContain("持续增长");
    expect(result.details.report.presentation.limitations.join("；")).toContain("原因仍需流水等证据");
    expect(result.details.rows).toHaveLength(1);
  });

  it("数值错误触发恢复时不保留草稿中的客户原因", async () => {
    const result = await harness().recover("存款余额999元。客户已经流失，存款持续下降。\n\n目前没有账户流水，不能据此认定客户流失。");
    const summary = result.details.report.summary as string;
    expect(summary).not.toContain("客户已经流失");
    expect(summary).toContain("各项存款为100元");
    expect(result.details.report.presentation.limitations.join("；")).toContain("原因仍需流水等证据");
  });

  it.each(["{{total.current|cite}}", "数据见明细{{total.current|cite}}。"])("数值错误恢复时隐藏引用不能代替实际指标回答：%s", async paragraph => {
    const result = await harness().recover(`存款余额999元。各项存款持续增长{{total.current|cite}}。\n\n${paragraph}`);
    expect(result.details.report.summary).toContain("100元");
    expect(result.details.report.summary.trim()).not.toBe("");
  });

  it("其他指标数值包含相同数字片段不能替代当前指标", async () => {
    const combined = {...source, evidence_items: [...source.evidence_items,
      {ref: "personal.current", display: "1100元", label: "个人存款", value: "1100"}],
    table_rows: [...source.table_rows, {metric_id: "personal", 指标: "个人存款", 当前值: "1100元"}]};
    const result = await harness([combined]).recover(
      "存款余额999元。各项存款持续增长{{total.current|cite}}。\n\n个人存款为{{personal.current}}，其他数据见明细{{total.current|cite}}。", ["total", "personal"]);
    expect(result.details.report.summary).toContain("各项存款为100元");
    expect(result.details.report.summary).toContain("个人存款为1100元");
  });

  it.each(["是否因为客户流失导致存款变化？", "是否因为客户流失导致存款下降，需要进一步核实。"])(
    "待核验问题仍能跟随实际结果交付：%s", async question => {
      const result = await harness().present(`存款余额{{total.current}}。${question}`);
      expect(result.details).toMatchObject({status: "succeeded"});
      expect(result.details.report.summary).toContain(question);
    });

  it("整体事实恢复不保留错误日期或无依据因果", async () => {
    const body = "截至2026-08-31，存款余额{{total.current}}。\n\n客户流失导致存款下降{{total.yoy.difference}}。\n\n从已取得的数据看，存款余额{{total.current}}，较上月增加{{total.mom.difference}}。";
    const result = await harness().recover(body);
    expect(result.details.report.summary).toContain("100元；较上月增加5元");
    expect(result.details.report.summary).not.toMatch(/2026-08-31|客户流失/u);
  });

  it("部分交付不能删除未知引用后变成成功", () => {
    expect(() => composePartialBusinessReport([source], {evidence_refs: ["e1"],
      summary: "各项存款为{{total.current}}。\n\n另一个指标为{{unknown.current}}。",
      sections: [], metric_ids: ["total"]})).toThrow(/不存在证据/u);
  });

  it("正式判断依赖缺失时不能借部分交付绕过", () => {
    const broken = {...source, evidence_items: source.evidence_items.map(atom => atom.judgment_kind
      ? {...atom, input_refs: ["missing.comparison"]} : atom)};
    expect(() => composePartialBusinessReport([broken], {evidence_refs: ["e1"],
      summary: "{{judgment.total.direction}}", sections: [], metric_ids: ["total"]})).toThrow(/证据链/u);
  });

  it("展示值相同但原始值冲突的证据不能合并", async () => {
    const conflict = {...source, evidence_items: source.evidence_items.map(atom => atom.ref === "total.current"
      ? {...atom, value: "99"} : atom)};
    const result = await harness([source, conflict]).present("各项存款为{{total.current}}。");
    expect(result.details).toMatchObject({status: "ARGUMENT_ERROR"});
    expect(result.terminate).not.toBe(true);
  });

  it.each(["{{unknown.current}}", "{{unknown.current|cite}}"])("未知引用%s始终拒绝，不能借修复交付", async ref => {
    const {present} = harness();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await present(`各项存款已经增长${ref}。`);
      expect(result.details).toMatchObject({status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_EVIDENCE"});
      expect(result.details.narrative_repaired).toBeUndefined();
      expect(result.terminate).not.toBe(true);
    }
  });

  it("无效指标选择不能因同时存在文案错误而兜底", async () => {
    const result = await harness().present(undefined, ["unqueried"]);
    expect(result.details).toMatchObject({status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_EVIDENCE"});
    expect(result.details.narrative_repaired).toBeUndefined();
  });

  it("未选择指标时不能把失败正文修复为空报告，也不能自行补选指标", async () => {
    const result = await harness().present("各项存款减少了50元。", []);
    expect(result.details).toMatchObject({status: "ARGUMENT_ERROR"});
    expect(result.details.narrative_repaired).toBeUndefined();
    expect(result.terminate).not.toBe(true);
  });

  it.each([
    {analysis_date: "2026-08-31"},
    {requested_date: "2026-08-31"},
    {org_codes: ["O2"]},
  ])("日期或机构范围冲突不能兜底：%j", async change => {
    const result = await harness([source, {...source, ...change}]).present();
    expect(result.details).toMatchObject({status: "ARGUMENT_ERROR"});
    expect(result.details.narrative_repaired).toBeUndefined();
  });

  it("机构权限变化仍拒绝交付", async () => {
    const {present, resolveBusinessField, getTask} = harness();
    resolveBusinessField.mockResolvedValue({status: "not_found", value: {codes: []}});
    expect((await present()).details).toMatchObject({status: "ARGUMENT_ERROR"});
    expect(getTask).not.toHaveBeenCalled();
  });

  it("基础任务鉴权失败直接抛出，不生成修复报告", async () => {
    const {present, getTask} = harness();
    getTask.mockRejectedValue(new BackendApiError(403, "禁止读取任务"));
    await expect(present()).rejects.toMatchObject({status: 403});
  });

  it("证据链缺失不能转成表格数值直出", async () => {
    const broken = {...source, evidence_items: source.evidence_items.filter(item => item.ref !== "total.current")};
    const result = await harness([broken]).present();
    expect(result.details).toMatchObject({status: "ARGUMENT_ERROR"});
    expect(result.details.narrative_repaired).toBeUndefined();
  });
});
