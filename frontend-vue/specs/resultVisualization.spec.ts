import { describe, expect, it } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"

import ChatResultContent from "../src/components/chat/ChatResultContent.vue"
import { resolveResultVisualization } from "../src/lib/resultVisualization"
import type { ChatResponse } from "../src/types/api"

// 隔离展示决策，不作为业务数据或真实问数验收。
const rows = ["甲行", "乙行", "丙行"].map((org_name, index) => ({
  org_name, metric_name: "存款余额", stat_date: "2026-08-27", metric_value: String(100000000 * (index + 1)), unit: "元",
}))

function response(tableRows = rows, type = "metric_ranking"): ChatResponse {
  return {
    message_id: "chart-message", answer: "机构余额如下。", intent: type,
    result: { type, table: { columns: ["org_name", "metric_name", "stat_date", "metric_value"], rows: tableRows } },
    metric_definition: null, clarification: null, debug: null,
  }
}

describe("按真实结果选择图表", () => {
  it("机构排名和三个时间点分别默认柱图、折线图", () => {
    expect(resolveResultVisualization(response()).defaultView).toBe("horizontal_bar")
    const trend = rows.map((row, index) => ({ ...row, org_name: "甲行", stat_date: `2026-0${index + 6}-27` }))
    expect(resolveResultVisualization(response(trend, "metric_trend")).defaultView).toBe("line")
    expect(resolveResultVisualization(response(trend, "business_report")).defaultView).toBe("line")
  })

  it("单值与两个数字不自动画图，显式请求两个机构柱图时可以展示", () => {
    expect(resolveResultVisualization(response(rows.slice(0, 1))).defaultView).toBe("table")
    expect(resolveResultVisualization(response(rows.slice(0, 2))).defaultView).toBe("table")
    expect(resolveResultVisualization(response(rows.slice(0, 2)), "画柱状图").defaultView).toBe("horizontal_bar")
  })

  it.each(["用表格展示", "只用文字回答", "只要文字", "只看文字", "仅需文字", "不要图表", "不用画图", "不画图"])("遵循用户偏好：%s", (question) => {
    expect(resolveResultVisualization(response(), question).defaultView).toBe("table")
  })

  it("报告行使用原始数值字段，不从带单位的文案猜数值", () => {
    const reportRows = rows.map((row, index) => ({ ...row, metric_value: `${index + 1}.00亿元`, raw_value: row.metric_value }))
    expect(resolveResultVisualization(response(reportRows, "business_report")).points.map(point => point.value)).toEqual([1, 2, 3])
    expect(resolveResultVisualization(response(reportRows, "business_report")).unit).toBe("亿元")
    expect(resolveResultVisualization(response(reportRows.map(({ raw_value: _raw, ...row }) => row), "business_report")).defaultView).toBe("table")
  })

  it.each([
    ["混合单位", rows.map((row, index) => ({ ...row, unit: index ? "元" : "万元" }))],
    ["未知单位", rows.map(row => ({ ...row, unit: "" }))],
    ["不同统计日期", rows.map((row, index) => ({ ...row, stat_date: index ? "2026-08-27" : "2026-07-27" }))],
    ["不同指标", rows.map((row, index) => ({ ...row, metric_name: index ? "存款余额" : "贷款余额" }))],
    ["缺少统计日期", rows.map((row, index) => ({ ...row, stat_date: index ? row.stat_date : "" }))],
    ["缺少指标名称", rows.map((row, index) => ({ ...row, metric_name: index ? row.metric_name : "" }))],
    ["重复机构", rows.map(row => ({ ...row, org_name: "甲行" }))],
    ["部分缺数", rows.map((row, index) => ({ ...row, metric_value: index ? row.metric_value : "" }))],
  ])("%s不生成误导性机构排名图", (_reason, invalidRows) => {
    expect(resolveResultVisualization(response(invalidRows)).defaultView).toBe("table")
  })

  it("原始金额按同一单位缩放，表格数值不变", () => {
    const input = response()
    const decision = resolveResultVisualization(input)
    expect(decision.unit).toBe("亿元")
    expect(decision.points.map(point => point.value)).toEqual([1, 2, 3])
    expect(input.result?.table?.rows[0]?.metric_value).toBe("100000000")
  })

  it.each(["%", "比例"])("未明确编码的%s原值不作为图表百分数", (unit) => {
    const percentageRows = rows.map(row => ({ ...row, unit, metric_value: "0.025" }))
    const decision = resolveResultVisualization(response(percentageRows), "画柱状图")
    expect(decision.defaultView).toBe("table")
    expect(decision.allowedViews).toEqual(["table"])
    expect(decision.points).toEqual([])
  })
})

describe("图表默认交付", () => {
  it("普通排名结果直接呈现图表，原始表格仍可展开", async () => {
    const html = await renderToString(createSSRApp(ChatResultContent, { response: response() }))
    expect(html).toContain("role=\"img\"")
    expect(html).toContain("查看 3 条数据明细")
    expect(html).not.toContain("<table")
  })

  it("分析正文的明细收起时也呈现图表", async () => {
    const input = response()
    input.analysis_report = { summary: "机构比较如下。", sections: [], scope: "2026-08-27", source_notices: [], limitations: [], gaps: [], partial: false, body_mode: "narrative" }
    const html = await renderToString(createSSRApp(ChatResultContent, { response: input }))
    expect(html).toContain("role=\"img\"")
    expect(html).toContain("查看 3 条数据明细")
  })

  it("已经交付结构饼图时不再自动追加柱图", async () => {
    const input = response()
    input.analysis_report = {
      summary: "结构如下。", sections: [], scope: "2026-08-27", source_notices: [], limitations: [], gaps: [], partial: false, body_mode: "narrative",
      charts: [{ type: "pie", title: "结构", unit: "元", date: "2026-08-27", source_refs: ["a", "b"], points: [{ name: "甲", value: "6", share: "60%", display: "6元" }, { name: "乙", value: "4", share: "40%", display: "4元" }] }],
    }
    const html = await renderToString(createSSRApp(ChatResultContent, { response: input }))
    expect(html.match(/role="img"/g)).toHaveLength(1)
  })
})
