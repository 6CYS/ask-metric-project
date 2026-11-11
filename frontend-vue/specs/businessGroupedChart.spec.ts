import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import { init, use } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"

import ChatResultChart from "../src/components/chat/ChatResultChart.vue"
import ChatResultContent from "../src/components/chat/ChatResultContent.vue"
import {
  businessChartOption,
  businessGroupedOption,
  isBusinessReportChart,
} from "../src/lib/businessReportChart"
import { businessReportPresentation } from "../src/lib/businessReportPresentation"
import type { MetricAskDetails } from "../src/lib/agentApi"
import type { BusinessGroupedChart } from "../src/types/api"

// 图表能力由真实组件注册；测试只补充无需浏览器画布的 SVG 渲染器。
use(SVGRenderer)

// 隔离完整矩形与展示契约，不作为真实问数或业务金额验收。
const grouped: BusinessGroupedChart = {
  type: "grouped_bar",
  title: "同日规模对比",
  dates: ["2026-08-27"],
  unit: "元",
  categories: ["存款余额", "贷款余额"],
  source_refs: ["a.deposit", "a.loan", "b.deposit", "b.loan"],
  series: [
    {
      name: "江苏甲农村商业银行",
      points: [
        { value: "1234000000.0001", display: "12.340000000001亿元" },
        { value: "-823000000.0002", display: "-8.230000000002亿元" },
      ],
    },
    {
      name: "江苏乙农村商业银行",
      points: [
        { value: "2234000000.0001", display: "+22.340000000001亿元" },
        { value: "723000000.0002", display: "7.230000000002亿元" },
      ],
    },
  ],
  placement: { after_paragraph: 1 },
}

describe("报告分组柱图", () => {
  it("相邻长精度标签自动避让，完整数值仍可从同类别提示读取", async () => {
    const closeValues: BusinessGroupedChart = {
      ...grouped,
      series: grouped.series.map((series, index) => ({
        name: series.name,
        points: [0, 1].map(() => ({
          value: String(1118000000 + index * 1000000),
          display: index === 0 ? "11.180000000001亿元" : "11.190000000002亿元",
        })),
      })),
    }
    const option = businessGroupedOption(closeValues)
    await renderToString(createSSRApp(ChatResultChart as Component, { report: closeValues }))
    const instance = init(null, undefined, { renderer: "svg", ssr: true, width: 860, height: 340 })
    try {
      instance.setOption({ ...option, animation: false })
      const svg = instance.renderToSVGString()
      expect(svg.match(/11\.(?:180000000001|190000000002)亿元/g)).toHaveLength(2)
      const tooltip = option?.tooltip as { formatter: (items: unknown) => string }
      const content = tooltip.formatter([
        { seriesIndex: 0, dataIndex: 0 },
        { seriesIndex: 1, dataIndex: 0 },
      ])
      expect(content).toContain("11.180000000001亿元")
      expect(content).toContain("11.190000000002亿元")
    } finally {
      instance.dispose()
    }
  })

  it("常见两机构短值在相近柱顶仍能同时显示", async () => {
    const closeValues: BusinessGroupedChart = {
      ...grouped,
      categories: ["营业收入", "净利润", "利润总额"],
      source_refs: ["a.revenue", "a.profit", "a.total", "b.revenue", "b.profit", "b.total"],
      series: [
        {
          name: "甲机构",
          points: [
            { value: "4881000000", display: "48.81亿元" },
            { value: "996000000", display: "9.96亿元" },
            { value: "1118000000", display: "11.18亿元" },
          ],
        },
        {
          name: "乙机构",
          points: [
            { value: "10579000000", display: "105.79亿元" },
            { value: "355000000", display: "3.55亿元" },
            { value: "899000000", display: "8.99亿元" },
          ],
        },
      ],
    }
    await renderToString(createSSRApp(ChatResultChart as Component, { report: closeValues }))
    const instance = init(null, undefined, { renderer: "svg", ssr: true, width: 860, height: 340 })
    try {
      instance.setOption({ ...businessGroupedOption(closeValues), animation: false })
      const svg = instance.renderToSVGString()
      expect(svg).toContain("11.18亿元")
      expect(svg).toContain("8.99亿元")
    } finally {
      instance.dispose()
    }
  })

  it("接受同单位同日的完整机构×指标矩形，保留来源和段落位置", () => {
    expect(isBusinessReportChart(grouped)).toBe(true)
    const details: MetricAskDetails = {
      kind: "business_report",
      status: "succeeded",
      report: {
        summary: "比较说明。\n\n后续结论。",
        sections: [],
        plans: [],
        charts: [grouped],
        presentation: {
          version: 1,
          body_mode: "narrative",
          scope: "隔离样例",
          source_notices: [],
          limitations: [],
        },
      },
    }
    expect(businessReportPresentation(details)?.charts).toEqual([grouped])
  })

  it.each([
    [
      "缺组合",
      {
        ...grouped,
        series: [
          grouped.series[0],
          { ...grouped.series[1], points: grouped.series[1]!.points.slice(0, 1) },
        ],
      },
    ],
    ["缺来源", { ...grouped, source_refs: grouped.source_refs.slice(1) }],
    ["重复来源", { ...grouped, source_refs: ["a", "a", "b", "c"] }],
    ["多日", { ...grouped, dates: ["2026-08-27", "2026-08-28"] }],
    ["重复类别", { ...grouped, categories: ["存款", "存款"] }],
    ["重复机构", { ...grouped, series: [grouped.series[0], grouped.series[0]] }],
    [
      "无有效数值",
      {
        ...grouped,
        series: [
          {
            ...grouped.series[0],
            points: [{ value: "NaN", display: "不应出现" }, grouped.series[0]!.points[1]],
          },
          grouped.series[1],
        ],
      },
    ],
  ])("%s拒绝展示，不填零补全矩形", (_name, invalid) =>
    expect(isBusinessReportChart(invalid)).toBe(false),
  )

  it("各机构共享同一金额轴，图例和数值标签保留机构顺序、符号与精度", () => {
    const option = businessGroupedOption(grouped)
    expect(option).toMatchObject({
      xAxis: { name: "亿元" },
      yAxis: { type: "category", data: ["存款余额", "贷款余额"] },
      legend: { data: ["江苏甲农村商业银行", "江苏乙农村商业银行"] },
      series: [{ name: "江苏甲农村商业银行" }, { name: "江苏乙农村商业银行" }],
    })
    const series = option?.series as Array<{
      data: number[]
      label: { show: boolean; formatter: (input: { dataIndex: number }) => string }
    }>
    const expected = [
      [12.340000000001, -8.230000000002],
      [22.340000000001, 7.230000000002],
    ]
    expected.forEach((values, index) =>
      values.forEach((value, point) => expect(series[index]?.data[point]).toBeCloseTo(value, 12)),
    )
    expect(series[0]?.label.show).toBe(true)
    expect(series[0]?.label.formatter({ dataIndex: 1 })).toBe("-8.230000000002亿元")
    expect(series[1]?.label.formatter({ dataIndex: 0 })).toBe("+22.340000000001亿元")
  })

  it("同类别提示完整显示各机构且转义不可信名称和显示值", () => {
    const unsafe = structuredClone(grouped)
    unsafe.categories[0] = "<script>类别</script>"
    unsafe.series[0]!.name = "<img src=x>机构"
    unsafe.series[0]!.points[0]!.display = "<b>12.34亿元</b>"
    const tooltip = businessGroupedOption(unsafe)?.tooltip as {
      formatter: (items: unknown) => string
    }
    const html = tooltip.formatter([
      { seriesIndex: 0, dataIndex: 0 },
      { seriesIndex: 1, dataIndex: 0 },
    ])
    expect(html).toContain("&lt;script&gt;类别&lt;/script&gt;")
    expect(html).toContain("&lt;img src=x&gt;机构")
    expect(html).toContain("&lt;b&gt;12.34亿元&lt;/b&gt;")
    expect(html).toContain("江苏乙农村商业银行")
    expect(html).toContain("+22.340000000001亿元")
    expect(html).not.toMatch(/<(?:script|img)>/)
    expect(tooltip.formatter([null, { seriesIndex: 99, dataIndex: 0 }])).toBe("")
  })

  it("24个完整事实允许，超出单图已有预算拒绝", () => {
    const matrix = (count: number): BusinessGroupedChart => ({
      ...grouped,
      categories: Array.from({ length: count }, (_, index) => `指标${index}`),
      source_refs: Array.from({ length: count * 2 }, (_, index) => `fact${index}`),
      series: grouped.series.map((series) => ({
        name: series.name,
        points: Array.from({ length: count }, (_, index) => ({
          value: String(index),
          display: `${index}元`,
        })),
      })),
    })
    expect(isBusinessReportChart(matrix(12))).toBe(true)
    expect(businessChartOption(matrix(12), "horizontal_bar")).toMatchObject({
      yAxis: { type: "category", inverse: true },
    })
    expect(isBusinessReportChart(matrix(13))).toBe(false)
    expect(businessGroupedOption(matrix(13))).toBeNull()
  })

  it("真实组件可渲染分组图且在历史报告的指定段落后展示", async () => {
    const direct = await renderToString(
      createSSRApp(ChatResultChart as Component, { report: grouped }),
    )
    expect(direct).toContain('role="img"')
    expect(direct).toContain("同日规模对比")
    expect(direct).toContain("max-width:860px")
    const html = await renderToString(
      createSSRApp(ChatResultContent as Component, {
        response: {
          message_id: "grouped-chart",
          intent: "business_report",
          answer: "完整正文。",
          analysis_report: {
            summary: "图前说明。\n\n图后结论。",
            sections: [],
            charts: [grouped],
            scope: "隔离样例",
            source_notices: [],
            limitations: [],
            gaps: [],
            partial: false,
            body_mode: "narrative",
          },
        },
      }),
    )
    expect(html.indexOf("同日规模对比")).toBeGreaterThan(html.indexOf("图前说明。"))
    expect(html.indexOf("图后结论。")).toBeGreaterThan(html.indexOf("同日规模对比"))
  })
})
