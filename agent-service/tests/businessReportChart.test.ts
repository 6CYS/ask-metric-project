import {describe, expect, it, vi} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {createBusinessReportTool, type OverviewEvidence} from "../src/tools/businessReport.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

// 隔离事实仅验证报告与绘图的交付边界，不进入实际问数。
function fixture() {
  const date = "2026-08-27";
  const entries = [{id: "total", label: "各项存款", value: "100"},
    {id: "personal", label: "个人存款", value: "75"}, {id: "company", label: "对公存款", value: "25"}];
  const facts = Object.fromEntries(entries.map(item => [item.id, {[date]: {fact_id: `fact:${item.id}`,
    value: item.value, date, unit: "元", org_code: "O1", org_name: "测试机构"}}]));
  const calculations = entries.slice(1).map(item => ({metric: item.id, parent: "total", comparison: "share",
    status: "succeeded", scope_policy: "same_org_date", inputs: {part: facts[item.id]![date]!, total: facts.total![date]!},
    results: [{name: "share", value: `0.${item.value}`, display_value: `${item.value}.00`, unit: "%", display: "percent", decimal_places: 2}]}));
  const source = {kind: "business_overview", status: "succeeded", topic: "deposit", topic_version: "test-v1",
    analysis_date: date, requested_date: date, org_codes: ["O1"], org_name: "测试机构", basis: "测试口径",
    facts, calculations, tasks: [{task_id: "task-1", status: "succeeded"}], gaps: [], table_columns: [],
    table_rows: entries.map(item => ({metric_id: item.id, 指标: item.label, 当前值: `${item.value}元`})),
    evidence_items: [...entries.map(item => ({ref: `${item.id}.current`, label: item.label,
      display: `${item.value}元`, ...facts[item.id]![date]!})),
    ...calculations.map(item => ({ref: `${item.metric}.share.share`, label: "分类占比", date, unit: "%",
      value: item.results[0]!.value, display: `${item.results[0]!.display_value}%`}))],
  } satisfies OverviewEvidence & {facts: typeof facts; calculations: typeof calculations};
  const topic = {version: "test-v1", metrics: entries.map(({id, label}) => ({id, label})),
    relationships: [{id: "customers", parent: "total", children: ["personal", "company"], pie_chart: true,
      pie_tolerance: "0", pie_tolerance_unit: "元"}]};
  return {source, topic};
}

function harness(question = "帮我绘制饼图") {
  const {source, topic} = fixture(), tool = createBusinessReportTool(), history: AgentMessage[] = [];
  const backend = {resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: ["O1"]}})),
    getTask: vi.fn(async () => ({status: "succeeded"})), businessTopic: vi.fn(async () => topic),
    businessOverview: vi.fn(), queryMetric: vi.fn()};
  const request = testRequestContext(backend as unknown as BackendClient, new MemoryCommandBridge(), {
    originalMessage: question, turnMessages: async () => history,
    answerEvidence: async () => [{ref: "e1", evidence: source}]});
  const args = (extra: Record<string, unknown> = {}) => validateToolArguments(tool, {type: "toolCall", id: "report", name: tool.name,
    arguments: Object.fromEntries(Object.entries({evidence_refs: ["e1"], metric_ids: ["total", "personal", "company"],
      chart: {type: "pie"}, ...extra}).filter(([, value]) => value !== undefined))});
  const present = async (extra?: Record<string, unknown>) => {
    const result = await runTool(tool, args(extra), request);
    history.push({role: "toolResult", toolName: tool.name, toolCallId: `report-${history.length}`,
      content: result.content, details: result.details, isError: false, timestamp: 0});
    return result;
  };
  return {source, topic, tool, backend, args, present};
}

describe("概览报告复用已有证据绘图", () => {
  it("仅绘图可省略正文，正常报告仍必须提交正文", () => {
    const {args} = harness();
    expect(() => args()).not.toThrow();
    expect(() => args({chart: undefined})).toThrow();
    expect(() => args({chart: undefined, body: ""})).toThrow();
    expect(() => args({chart: {type: "bar"}})).toThrow();
  });

  it("无正文绘图返回简短图注和独立图表，只读主题定义而不重新取数", async () => {
    const {present, backend} = harness();
    const result = await present();
    expect(result).toMatchObject({terminate: true, details: {status: "succeeded", partial_analysis: false}});
    expect(result.details.report.summary).toBe("结构分布见下方饼图。");
    expect(result.details.report.charts).toHaveLength(1);
    expect(result.details.report.charts[0].points.map((point: {value: string}) => point.value)).toEqual(["75", "25"]);
    expect(backend.businessTopic).toHaveBeenCalledWith("deposit", false, expect.any(Object));
    expect(backend.resolveBusinessField).toHaveBeenCalledOnce();
    expect(backend.getTask).toHaveBeenCalledWith("task-1", expect.any(Object));
    expect(backend.businessOverview).not.toHaveBeenCalled();
    expect(backend.queryMetric).not.toHaveBeenCalled();
  });

  it("总量和分项不因现值数量足够就默认强配结构饼图", async () => {
    const {present, backend} = harness("我行存款情况如何");
    const result = await present({chart: undefined, body: "各项存款余额{{total.current}}。"});
    expect(result.details.report.summary).toBe("各项存款余额100元。");
    expect(result.details.report.charts ?? []).toEqual([]);
    expect(backend.businessTopic).not.toHaveBeenCalled();
  });

  it.each(["只用文字介绍存款情况，不要图", "存款结构用表格展示", "存款情况，不画图"])("尊重展示偏好：%s", async question => {
    const {present, backend} = harness(question);
    const result = await present({chart: undefined, body: "各项存款余额{{total.current}}。"});
    expect(result.details.report.charts).toBeUndefined();
    expect(backend.businessTopic).not.toHaveBeenCalled();
  });

  it("自动配图数据不足时仍交付原正文，不额外报告未请求的绘图缺口", async () => {
    const {present, source} = harness("我行存款情况如何");
    delete source.facts.company;
    const result = await present({chart: undefined, body: "各项存款余额{{total.current}}。"});
    expect(result.details.report.summary).toBe("各项存款余额100元。");
    expect(result.details.partial_analysis).toBe(false);
    expect(result.details.report.charts ?? []).toEqual([]);
    expect(result.details.gaps).toEqual([]);
  });

  it.each([new TypeError("fetch failed"), Object.assign(new Error("timeout"), {name: "AbortError"})])(
    "未选结构饼图时不依赖主题服务可用性：%s", async error => {
      const {present, backend} = harness("我行存款情况如何");
      backend.businessTopic.mockRejectedValue(error);
      const result = await present({chart: undefined, body: "各项存款余额{{total.current}}。"});
      expect(result).toMatchObject({terminate: true, details: {status: "succeeded"}});
      expect(result.details.report.summary).toBe("各项存款余额100元。");
      expect(result.details.partial_analysis).toBe(false);
      expect(backend.businessTopic).not.toHaveBeenCalled();
    });

  it("权限或任务授权失败仍中止，不通过绘图绕过", async () => {
    const permission = harness();
    permission.backend.resolveBusinessField.mockResolvedValue({status: "denied", value: {codes: []}});
    expect((await permission.present()).details.status).toBe("ARGUMENT_ERROR");
    expect(permission.backend.businessTopic).not.toHaveBeenCalled();
    const task = harness();
    task.backend.getTask.mockRejectedValue(new BackendApiError(403, "无权限"));
    await expect(task.present()).rejects.toThrow(BackendApiError);
    expect(task.backend.businessTopic).not.toHaveBeenCalled();
  });

  it("未知原子引用是硬错误，不因请求图表而被恢复", async () => {
    const {present, backend} = harness();
    const result = await present({body: "各项存款{{unknown.current}}。"});
    expect(result.details.status).toBe("ARGUMENT_ERROR");
    expect(result.details.error_code).toBe("ANALYSIS_REPORT_EVIDENCE");
    expect(result.terminate).not.toBe(true);
    expect(backend.businessTopic).not.toHaveBeenCalled();
  });

  it("有正文时先修正文案，再次失败恢复事实后仍交付图表", async () => {
    const {present, backend} = harness(), body = "各项存款为999元。";
    const first = await present({body});
    expect(first.details.error_code).toBe("ANALYSIS_REPORT_PROSE");
    expect(backend.businessTopic).not.toHaveBeenCalled();
    const result = await present({body});
    expect(result.details.narrative_repaired).toBe(true);
    expect(result.details.report.charts).toHaveLength(1);
    expect(result.details.report.summary).toContain("各项存款为100元");
    expect(result.details.report.summary).not.toContain("999元");
  });

  it("缺少分项时只说明绘图缺口，不补零或声称已画好", async () => {
    const {source, present} = harness();
    delete source.facts.company;
    const result = await present();
    expect(result.details.report.charts).toEqual([]);
    expect(result.details.partial_analysis).toBe(true);
    expect(result.details.report.summary).toMatch(/暂不能绘制/u);
    expect(result.details.public_answer).toContain(result.details.report.summary);
    expect(result.details.report.summary).not.toContain("下方饼图");
  });

  it("不支持的分组提示不被事实恢复吞掉，最终文字和状态保持一致", async () => {
    const {present} = harness(), extra = {body: "各项存款为999元。", chart: {type: "pie", relationship_id: "unknown"}};
    await present(extra);
    const result = await present(extra);
    expect(result.details.narrative_repaired).toBe(true);
    expect(result.details.report.charts).toEqual([]);
    expect(result.details.partial_analysis).toBe(true);
    expect(result.details.report.summary).toContain("当前没有符合所选分组口径的结构饼图数据。");
    expect(result.details.public_answer).toContain("当前没有符合所选分组口径的结构饼图数据。");
    expect(result.content[0].text).toBe(result.details.public_answer);
  });
});
