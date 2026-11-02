import { describe, expect, it } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"

import ChatResultContent from "../src/components/chat/ChatResultContent.vue"
import ChatResultChart from "../src/components/chat/ChatResultChart.vue"
import { businessReportPresentation } from "../src/lib/businessReportPresentation"
import type { MetricAskDetails } from "../src/lib/agentApi"
import type { ChatResponse } from "../src/types/api"

// 隔离展示契约，不作为业务数据或真实问数验收。
const chart = {
  type: "pie", title: "存款客户结构", date: "2026-08-27", unit: "元",
  source_refs: ["total.current", "personal.current", "company.current"],
  points: [
    { name: "个人存款", value: "6000000000.12", display: "60.0000000012亿元", share: "60.00%" },
    { name: "对公存款", value: "4000000000.08", display: "40.0000000008亿元", share: "40.00%" },
  ],
}

const comparison = { type: "bar", title: "个人与对公存款变化", dates: ["2026-08-27"], unit: "元",
  source_refs: ["personal.mom.difference", "company.mom.difference"],
  points: [{ name: "个人存款较上月", value: "12.3400", display: "12.34元" },
    { name: "对公存款较上月", value: "-8.2300", display: "-8.23元" }] }

function details(charts: unknown): MetricAskDetails {
  return {
    kind: "business_report", status: "succeeded", public_answer: "存款结构如下。",
    report: {
      summary: "存款结构如下。", sections: [], plans: [], charts,
      presentation: { version: 1, body_mode: "narrative", scope: "测试机构 · 2026-08-27", source_notices: [], limitations: [] },
    },
  } as MetricAskDetails
}

describe("报告中的已核验图表", () => {
  it("八个机构的报告条形图按点数增高，折线图和饼图高度保持原样", async () => {
    const points = Array.from({ length: 8 }, (_, index) => ({ name: `江苏测试${index + 1}农村商业银行`,
      value: String(index - 3), display: `${index - 3}元` }))
    const bar = { ...comparison, type: "bar" as const, points, source_refs: points.map((_, index) => `fact-${index}`) }
    const html = await renderToString(createSSRApp(ChatResultChart, { series: bar }))
    expect(html).toContain("height:376px")
    const dates = points.map((_, index) => `2026-08-${20 + index}`)
    const line = { ...bar, type: "line" as const, dates, points: points.map((point, index) => ({ ...point, name: dates[index]! })) }
    expect(await renderToString(createSSRApp(ChatResultChart, { series: line }))).toContain("height:288px")
    expect(await renderToString(createSSRApp(ChatResultChart, { pie: { ...chart, type: "pie" as const } }))).toContain("height:340px")
  })
  it("柱图与折线图在实时和历史回放中保留真实数值与标题", async () => {
    const report = businessReportPresentation(JSON.parse(JSON.stringify(details([comparison]))))
    expect(report?.charts).toEqual([comparison])
    const response = { message_id: "series", intent: "business_report", answer: "变化存在差异。", analysis_report: report } as ChatResponse
    const html = await renderToString(createSSRApp(ChatResultContent, { response }))
    expect(html).toContain("个人与对公存款变化")
    expect(html).toContain("role=\"img\"")
  })
  it("日期或点值不完整的系列不进入图表，正文继续保留", () => {
    for (const invalid of [{ ...comparison, dates: [] }, { ...comparison, points: [{...comparison.points[0], value: "NaN"}, comparison.points[1]] }]) {
      expect(businessReportPresentation(details([invalid]))?.charts).toBeUndefined()
    }
  })
  it("实时回执和历史JSON重放都保留原始金额、显示精度与占比", () => {
    for (const input of [details([chart]), JSON.parse(JSON.stringify(details([chart])))]) {
      const report = businessReportPresentation(input)
      expect(report).toMatchObject({ summary: "存款结构如下。", charts: [chart] })
    }
  })

  it.each([
    ["缺失来源", { ...chart, source_refs: [] }],
    ["负值", { ...chart, points: [chart.points[0], { ...chart.points[1], value: "-10" }] }],
    ["非有限值", { ...chart, points: [chart.points[0], { ...chart.points[1], value: "Infinity" }] }],
    ["全零", { ...chart, points: chart.points.map(point => ({ ...point, value: "0" })) }],
    ["只有一项", { ...chart, points: chart.points.slice(0, 1) }],
    ["重复分类", { ...chart, points: [chart.points[0], chart.points[0]] }],
    ["占比越界", { ...chart, points: [chart.points[0], { ...chart.points[1], share: "140%" }] }],
  ])("%s图表不渲染，合法正文及其他图表继续保留", (_reason, invalid) => {
    const report = businessReportPresentation(details([invalid, chart]))
    expect(report?.summary).toBe("存款结构如下。")
    expect(report).toHaveProperty("charts", [chart])
  })

  it("旧消息没有图表字段时仍正常展示", () => {
    expect(businessReportPresentation(details(undefined))?.summary).toBe("存款结构如下。")
  })

  it("显式图表直接展示，不依赖数据明细展开或表格存在", async () => {
    const response = {
      message_id: "message", intent: "business_report", answer: "存款结构如下。",
      analysis_report: businessReportPresentation(details([chart])),
    } as ChatResponse
    const html = await renderToString(createSSRApp(ChatResultContent, { response }))
    expect(html).toContain("存款客户结构")
    expect(html).toContain("role=\"img\"")
    expect(html).toContain("2026-08-27")
  })
})
