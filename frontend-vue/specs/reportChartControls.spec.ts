import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import { describe, expect, it } from "vitest"
import ChatResultChart from "../src/components/chat/ChatResultChart.vue"
import type { BusinessSeriesChart } from "../src/types/api"

// 隔离组件交互入口；业务验收另用已有真实报告。
const report: BusinessSeriesChart = {
  type: "bar",
  title: "机构规模比较",
  unit: "元",
  dates: ["2026-08-27"],
  source_refs: ["a", "b"],
  points: [
    { name: "甲机构", value: "100", display: "100.00元" },
    { name: "乙机构", value: "200", display: "200.00元" },
  ],
}

describe("报告图表本地交互", () => {
  it("在图表旁提供统一的图形选择和放大入口", async () => {
    const html = await renderToString(createSSRApp(ChatResultChart as Component, { report }))
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-label="图表类型"')
    expect(html).toContain('aria-label="放大图表"')
    expect(html).toContain("机构规模比较")
    expect(html).toContain('role="img"')
  })

  it("趋势标题仅显示起止日期，保留完整指标口径", async () => {
    const dates = ["2026-06-30", "2026-07-31", "2026-08-27"]
    const trend: BusinessSeriesChart = {
      ...report,
      type: "line",
      title: "营业收入金额当日数",
      dates,
      source_refs: ["a", "b", "c"],
      points: dates.map((name) => ({ name, value: "100", display: "100.00元" })),
    }
    const html = await renderToString(createSSRApp(ChatResultChart as Component, { report: trend }))
    expect(html).toContain("营业收入金额当日数")
    expect(html).toContain("2026年6月30日—2026年8月27日")
    expect(html).not.toContain("2026年7月31日")
  })
})
