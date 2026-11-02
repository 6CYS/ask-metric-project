import { describe, expect, it } from "vitest"

import { businessPieOption } from "../src/lib/businessPieChart"
import type { BusinessPieChart } from "../src/types/api"

const chart: BusinessPieChart = {
  type: "pie", title: "存款结构", date: "2026-08-27", unit: "元", source_refs: ["a", "b"],
  points: [
    { name: "个人存款", value: "6000000000.12", display: "60.0000000012亿元", share: "60.00%" },
    { name: "对公存款", value: "4000000000.08", display: "40.0000000008亿元", share: "40.00%" },
  ],
}

describe("饼图展示配置", () => {
  it("面积采用原始值，标签和提示保留服务端显示金额与占比", () => {
    const option = businessPieOption(chart)
    expect(option?.series).toMatchObject([{ type: "pie", data: [
      { name: "个人存款", value: 6000000000.12 },
      { name: "对公存款", value: 4000000000.08 },
    ] }])
    const tooltip = option?.tooltip as { formatter: (item: { dataIndex: number }) => string }
    const content = tooltip.formatter({ dataIndex: 0 })
    expect(content).toContain("60.0000000012亿元")
    expect(content).toContain("60.00%")
    expect(content).not.toContain("亿元元")
    expect(content).not.toContain("6000000000.12")
  })

  it("提示内容转义不可信分类名称和显示文字", () => {
    const unsafe = structuredClone(chart)
    unsafe.points[0]!.name = "<img src=x onerror=alert(1)>"
    unsafe.points[0]!.display = "<b>60亿元</b>"
    const tooltip = businessPieOption(unsafe)?.tooltip as { formatter: (item: { dataIndex: number }) => string }
    expect(tooltip.formatter({ dataIndex: 0 })).toContain("&lt;img")
    expect(tooltip.formatter({ dataIndex: 0 })).not.toContain("<img")
    expect(tooltip.formatter({ dataIndex: 0 })).toContain("&lt;b&gt;60亿元&lt;/b&gt;")
  })

  it("户数图沿用原始展示值和占比，不将数值误标为余额", () => {
    const option = businessPieOption({
      ...chart, title: "客户户数分布", unit: "户",
      points: [
        { name: "甲行", value: "1234", display: "1,234户", share: "61.70%" },
        { name: "乙行", value: "766", display: "766户", share: "38.30%" },
      ],
    })
    expect(option?.series).toMatchObject([{ type: "pie", data: [
      { name: "甲行", value: 1234 },
      { name: "乙行", value: 766 },
    ] }])
    const tooltip = option?.tooltip as { formatter: (item: { dataIndex: number }) => string }
    const content = tooltip.formatter({ dataIndex: 0 })
    expect(content).toContain("甲行")
    expect(content).toContain("1,234户")
    expect(content).toContain("61.70%")
    expect(content).not.toContain("余额")
  })

  it("异常数据不能绕过投影直接画成图", () => {
    expect(businessPieOption({ ...chart, points: [] })).toBeNull()
    expect(businessPieOption({ ...chart, points: chart.points.map(point => ({ ...point, value: "0" })) })).toBeNull()
  })
})
