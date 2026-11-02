import { describe, expect, it } from "vitest"
import { businessSeriesOption, isBusinessSeriesChart } from "../src/lib/businessReportChart"
import type { BusinessSeriesChart } from "../src/types/api"

const chart: BusinessSeriesChart = { type: "bar", title: "测试比较", dates: ["2026-08-27"], unit: "元",
  source_refs: ["a", "b"], points: [
    { name: "甲", value: "1234000000.0001", display: "12.340000000001亿元" },
    { name: "乙<script>", value: "-823000000.0002", display: "-8.230000000002亿元" },
  ] }

describe("报告柱图与折线图", () => {
  it("金额轴按相同比例缩放，负值与精确提示不丢失", () => {
    const options = businessSeriesOption(chart)
    expect(options).toMatchObject({ xAxis: { type: "value", name: "亿元" }, series: [{ data: [12.340000000001, -8.230000000002] }] })
    const formatter = (options?.tooltip as { formatter: (input: unknown) => string }).formatter
    expect(formatter([{ dataIndex: 1 }])).toBe("乙&lt;script&gt;<br/><strong>-8.230000000002亿元</strong>")
  })
  it("长机构名称横向展示，第一项在上且保留原顺序和正负数值", () => {
    const comparison = { ...chart, points: [
      { ...chart.points[1]!, name: "江苏测试甲农村商业银行" },
      { ...chart.points[0]!, name: "江苏测试乙农村商业银行" },
    ] }
    expect(businessSeriesOption(comparison)).toMatchObject({
      xAxis: { type: "value", name: "亿元" },
      yAxis: { type: "category", inverse: true, data: comparison.points.map(point => point.name),
        axisLabel: { interval: 0, width: 210, overflow: "truncate" } },
      series: [{ type: "bar", data: [-8.230000000002, 12.340000000001] }],
    })
  })
  it("折线图只接受按真实日期顺序排列且一日一个值的点", () => {
    const trend = { ...chart, type: "line" as const, dates: ["2026-07-27", "2026-08-27"],
      points: chart.points.map((point, index) => ({ ...point, name: ["2026-07-27", "2026-08-27"][index]! })) }
    expect(isBusinessSeriesChart(trend)).toBe(true)
    expect(isBusinessSeriesChart({ ...trend, dates: [...trend.dates].reverse() })).toBe(false)
    expect(isBusinessSeriesChart({ ...trend, points: [...trend.points].reverse() })).toBe(false)
    expect(businessSeriesOption(trend)).toMatchObject({ xAxis: { type: "category", data: trend.dates },
      yAxis: { type: "value", name: "亿元" }, series: [{ type: "line", smooth: false }] })
  })
})
