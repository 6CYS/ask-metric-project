import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import { init, use } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import ChatResultChart from "../src/components/chat/ChatResultChart.vue"
import {
  businessChartOption,
  businessSeriesOption,
  isBusinessSeriesChart,
} from "../src/lib/businessReportChart"
import type { BusinessSeriesChart } from "../src/types/api"

use(SVGRenderer)

const chart: BusinessSeriesChart = {
  type: "bar",
  title: "测试比较",
  dates: ["2026-08-27"],
  unit: "元",
  source_refs: ["a", "b"],
  points: [
    { name: "甲", value: "1234000000.0001", display: "12.340000000001亿元" },
    { name: "乙<script>", value: "-823000000.0002", display: "-8.230000000002亿元" },
  ],
}

describe("报告柱图与折线图", () => {
  it.each([
    ["存款", ["498373000000", "238179000000"], ["4983.73亿元", "2381.79亿元"]],
    ["贷款", ["409490000000", "204323000000"], ["4094.90亿元", "2043.23亿元"]],
    ["正负变化", ["-498373000000", "238179000000"], ["-4983.73亿元", "2381.79亿元"]],
    ["全负变化", ["-409490000000", "-204323000000"], ["-4094.90亿元", "-2043.23亿元"]],
  ])("%s金额轴采用整齐刻度并保留零基线，精确点标签不变", async (_title, values, displays) => {
    const input: BusinessSeriesChart = {
      ...chart,
      points: values.map((value, index) => ({
        name: `机构${index}`,
        value,
        display: displays[index]!,
      })),
    }
    await renderToString(createSSRApp(ChatResultChart as Component, { report: input }))
    const instance = init(null, undefined, { renderer: "svg", ssr: true, width: 620, height: 320 })
    try {
      instance.setOption({ ...businessSeriesOption(input), animation: false })
      const svg = instance.renderToSVGString()
      const ticks = [...svg.matchAll(/>(-?[\d,.]+)<\/text>/g)].map((match) => match[1]!)
      expect(ticks).toContain("0")
      expect(ticks.length).toBeGreaterThan(2)
      expect(ticks.some((tick) => /\.\d{4,}/.test(tick))).toBe(false)
      for (const display of displays) expect(svg).toContain(display)
    } finally {
      instance.dispose()
    }
  })

  it("金额轴按相同比例缩放，负值与精确提示不丢失", () => {
    const options = businessSeriesOption(chart)
    expect(options).toMatchObject({
      yAxis: { type: "value", name: "亿元" },
      series: [{ data: [12.340000000001, -8.230000000002] }],
    })
    const formatter = (options?.tooltip as { formatter: (input: unknown) => string }).formatter
    expect(formatter([{ dataIndex: 1 }])).toBe(
      "乙&lt;script&gt;<br/><strong>-8.230000000002亿元</strong>",
    )
  })
  it("少量机构竖向比较，长机构名换行但不截短，标签保持精度与正负号", () => {
    const comparison = {
      ...chart,
      points: [
        { ...chart.points[1]!, name: "江苏测试甲农村商业银行总行营业部" },
        { ...chart.points[0]!, name: "江苏测试乙农村商业银行总行营业部" },
      ],
    }
    const option = businessChartOption(comparison, "bar", { width: 420, height: 340 })
    expect(option).toMatchObject({
      yAxis: { type: "value", name: "亿元" },
      xAxis: { type: "category", data: comparison.points.map((point) => point.name) },
      series: [{ type: "bar", data: [-8.230000000002, 12.340000000001] }],
    })
    const axis = option?.xAxis as { axisLabel: { formatter: (name: string) => string } }
    const wrapped = axis.axisLabel.formatter(comparison.points[0]!.name)
    expect(wrapped).toContain("\n")
    expect(wrapped.replace(/\n/g, "")).toBe(comparison.points[0]!.name)
    const series = option?.series as Array<{
      label: { show: boolean; formatter: (input: { dataIndex: number }) => string }
    }>
    expect(series[0]?.label.show).toBe(true)
    expect(series[0]?.label.formatter({ dataIndex: 0 })).toBe("-8.230000000002亿元")
    expect(series[0]?.label.formatter({ dataIndex: 1 })).toBe("12.340000000001亿元")
  })
  it("横条视图保留原类别顺序，默认竖柱不根据类别数擅自改变方向", () => {
    for (const count of [6, 7]) {
      const points = Array.from({ length: count }, (_, index) => ({
        name: `江苏测试${index}农村商业银行`,
        value: String(index - 2),
        display: `${index - 2}元`,
      }))
      const source = { ...chart, points, source_refs: points.map((_, index) => `source-${index}`) }
      expect(businessSeriesOption(source)).toMatchObject({
        xAxis: { type: "category", data: points.map((point) => point.name) },
      })
      expect(businessChartOption(source, "horizontal_bar")).toMatchObject({
        yAxis: { type: "category", inverse: true, data: points.map((point) => point.name) },
      })
    }
  })
  it("折线图只接受按真实日期顺序排列且一日一个值的点", () => {
    const trend = {
      ...chart,
      type: "line" as const,
      dates: ["2026-07-27", "2026-08-27"],
      points: chart.points.map((point, index) => ({
        ...point,
        name: ["2026-07-27", "2026-08-27"][index]!,
      })),
    }
    expect(isBusinessSeriesChart(trend)).toBe(true)
    expect(isBusinessSeriesChart({ ...trend, dates: [...trend.dates].reverse() })).toBe(false)
    expect(isBusinessSeriesChart({ ...trend, points: [...trend.points].reverse() })).toBe(false)
    expect(businessSeriesOption(trend)).toMatchObject({
      xAxis: { type: "category", data: trend.dates },
      yAxis: { type: "value", name: "亿元" },
      series: [{ type: "line", smooth: false }],
    })
  })
})
