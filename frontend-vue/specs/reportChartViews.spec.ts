import { describe, expect, it } from "vitest"
import { init, use } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import ChatResultChart from "../src/components/chat/ChatResultChart.vue"
import {
  businessChartOption,
  businessReportDimensions,
  defaultReportChartView,
  reportChartViews,
} from "../src/lib/businessReportChart"
import type { BusinessGroupedChart, BusinessPieChart, BusinessSeriesChart } from "../src/types/api"

use(SVGRenderer)

const bar: BusinessSeriesChart = {
  type: "bar",
  title: "机构规模",
  unit: "元",
  dates: ["2026-08-27"],
  source_refs: ["a", "b"],
  points: [
    { name: "甲机构", value: "1234000000.0001", display: "12.340000000001亿元" },
    { name: "乙机构", value: "823000000.0002", display: "8.230000000002亿元" },
  ],
}
const organization: BusinessSeriesChart = { ...bar, category_kind: "organization" }
const line: BusinessSeriesChart = {
  ...bar,
  type: "line",
  dates: ["2026-07-31", "2026-08-27"],
  points: bar.points.map((point, index) => ({
    ...point,
    name: ["2026-07-31", "2026-08-27"][index]!,
  })),
}
const pie: BusinessPieChart = {
  type: "pie",
  title: "完整组成",
  unit: "元",
  date: "2026-08-27",
  source_refs: ["total", "a", "b"],
  points: [
    { ...bar.points[0]!, share: "60%" },
    { ...bar.points[1]!, share: "40%" },
  ],
}
const grouped: BusinessGroupedChart = {
  type: "grouped_bar",
  title: "机构指标比较",
  unit: "元",
  dates: ["2026-08-27"],
  categories: ["营业收入", "净利润", "利润总额"],
  source_refs: ["a.r", "a.n", "a.t", "b.r", "b.n", "b.t"],
  series: [
    { name: "甲机构", points: [bar.points[0]!, bar.points[1]!, bar.points[0]!] },
    { name: "乙机构", points: [bar.points[1]!, bar.points[0]!, bar.points[1]!] },
  ],
}

describe("正式图表的本地展示切换", () => {
  it("默认绘图区不按事实数无限增高，密集类别交给容器窗口", () => {
    const source = {
      ...bar,
      source_refs: Array.from({ length: 24 }, (_, index) => `r${index}`),
      points: Array.from({ length: 24 }, (_, index) => ({
        name: `机构${index}`,
        value: String(index),
        display: `${index}元`,
      })),
    }
    expect(businessReportDimensions(source).height).toBe(340)
    expect(businessReportDimensions(bar).height).toBe(280)
    expect(businessReportDimensions(source).height).toBeLessThanOrEqual(340)
  })
  it.each([
    [bar, ["bar", "horizontal_bar", "line", "area"], "bar"],
    [organization, ["bar", "horizontal_bar", "line", "area", "pie", "donut"], "bar"],
    [line, ["bar", "horizontal_bar", "line", "area"], "line"],
    [pie, ["bar", "horizontal_bar", "line", "area", "pie", "donut"], "donut"],
    [grouped, ["bar", "horizontal_bar", "line", "area", "radar"], "bar"],
  ] as const)("按正式数据结构决定适用视图", (chart, allowed, initial) => {
    expect(
      reportChartViews(chart)
        .filter((item) => !item.disabled)
        .map((item) => item.value)
        .sort(),
    ).toEqual([...allowed].sort())
    expect(defaultReportChartView(chart)).toBe(initial)
    expect(reportChartViews(chart).find((item) => item.value === initial)?.status).toBe(
      "recommended",
    )
    expect(
      reportChartViews(chart)
        .filter((item) => item.disabled)
        .every((item) => Boolean(item.reason)),
    ).toBe(true)
  })

  it.each([
    ["甲".repeat(10), "bar"],
    ["甲".repeat(11), "horizontal_bar"],
    ["A".repeat(16), "bar"],
    ["A".repeat(17), "horizontal_bar"],
  ] as const)("机构标签按现有宽度估算选择默认方向：%s", (name, expected) => {
    const source = {
      ...organization,
      points: organization.points.map((point, index) => ({
        ...point,
        name: index === 0 ? name : point.name,
      })),
    }
    expect(defaultReportChartView(source)).toBe(expected)
    expect(defaultReportChartView({ ...source, category_kind: "metric" })).toBe("bar")
  })

  it("含负值的单图与分组图默认横向，仍可手动选择纵向", () => {
    const negativeBar: BusinessSeriesChart = {
      ...organization,
      points: organization.points.map((point, index) =>
        index === 0 ? { ...point, value: "-1.25", display: "-1.25元" } : point,
      ),
    }
    const negativeGrouped: BusinessGroupedChart = {
      ...grouped,
      series: grouped.series.map((series, index) => ({
        ...series,
        points: series.points.map((point, pointIndex) =>
          index === 0 && pointIndex === 0
            ? { ...point, value: "-1.25", display: "-1.25元" }
            : point,
        ),
      })),
    }
    for (const source of [negativeBar, negativeGrouped]) {
      expect(defaultReportChartView(source)).toBe("horizontal_bar")
      expect(reportChartViews(source).find((item) => item.value === "horizontal_bar")?.status).toBe(
        "recommended",
      )
      expect(businessChartOption(source, "bar")).toMatchObject({ xAxis: { type: "category" } })
      expect(businessChartOption(source, "horizontal_bar")).toMatchObject({
        xAxis: { type: "value" },
      })
    }
    expect(
      defaultReportChartView({
        ...line,
        points: line.points.map((point) => ({ ...point, value: "-1.25" })),
      }),
    ).toBe("line")
  })

  it("分类连线允许切换但明确不代表时间趋势，横条也可展示时间序列", () => {
    for (const source of [bar, pie, grouped]) {
      for (const view of ["line", "area"] as const) {
        expect(reportChartViews(source).find((item) => item.value === view)).toMatchObject({
          status: "caution",
          reason: "分类连线不代表时间趋势",
        })
        expect(businessChartOption(source, view)).not.toBeNull()
      }
    }
    expect(reportChartViews(line).find((item) => item.value === "horizontal_bar")).toMatchObject({
      status: "available",
    })
    expect(businessChartOption(line, "horizontal_bar")).toMatchObject({
      yAxis: { data: line.dates },
    })
  })

  it("旧柱图缺少分类依据不能自动视为机构组成，多指标也不改饼图", () => {
    expect(businessChartOption(bar, "pie")).toBeNull()
    expect(reportChartViews(bar).find((item) => item.value === "pie")).toMatchObject({
      status: "disabled",
      disabled: true,
      reason: expect.stringContaining("分类依据") as unknown,
    })
    expect(businessChartOption(grouped, "pie")).toBeNull()
  })

  it.each(["元", "万元", "亿元", "户", "万户", "人", "个", "笔"])(
    "机构%s饼图明确只占所选合计，不伪造服务端share",
    (unit) => {
      const source = { ...organization, unit }
      const before = JSON.stringify(source)
      for (const view of ["pie", "donut"] as const) {
        expect(reportChartViews(source).find((item) => item.value === view)).toMatchObject({
          status: "caution",
          reason: "占所选机构合计，不代表全行业占比",
        })
        const option = businessChartOption(source, view)
        expect(option?.series).toMatchObject([
          {
            type: "pie",
            data: source.points.map((point) => ({ name: point.name, value: Number(point.value) })),
          },
        ])
        const formatter = (option?.tooltip as { formatter: (item: unknown) => string }).formatter
        expect(formatter({ dataIndex: 0, percent: 60.12 })).toContain("12.340000000001亿元")
        expect(formatter({ dataIndex: 0, percent: 60.12 })).toContain("占所选机构合计：60.12%")
        expect(formatter({ dataIndex: 0 })).not.toContain("undefined")
      }
      expect(JSON.stringify(source)).toBe(before)
      expect(source.points.every((point) => !("share" in point))).toBe(true)
    },
  )

  it.each(["%", "％", "百分点", "百分比", "倍", "天"])("机构%s指标不相加为饼图", (unit) => {
    const source = { ...organization, unit }
    expect(reportChartViews(source).find((item) => item.value === "pie")).toMatchObject({
      status: "disabled",
      disabled: true,
    })
    expect(businessChartOption(source, "pie")).toBeNull()
    expect(businessChartOption(source, "bar")).not.toBeNull()
  })

  it.each([
    ["负值", ["-1", "2"]],
    ["全零", ["0", "0"]],
    ["合计溢出", ["1e308", "1e308"]],
  ])("%s机构数值不能画selected-values饼图", (_name, values) => {
    const source = {
      ...organization,
      points: organization.points.map((point, index) => ({ ...point, value: values[index]! })),
    }
    expect(businessChartOption(source, "pie")).toBeNull()
  })

  it("机构饼图的HTML提示转义原值，多类别只提示谨慎而不禁用", () => {
    const source = {
      ...organization,
      source_refs: Array.from({ length: 9 }, (_, index) => `r${index}`),
      points: Array.from({ length: 9 }, (_, index) => ({
        name: `<b>机构${index}</b>`,
        value: String(index),
        display: `<em>${index}.000元</em>`,
      })),
    }
    const choice = reportChartViews(source).find((item) => item.value === "pie")
    expect(choice?.disabled).not.toBe(true)
    expect(choice?.status).toBe("caution")
    expect(choice?.reason).toContain("类别较多，建议使用柱状图")
    const option = businessChartOption(source, "pie")
    const formatter = (option?.tooltip as { formatter: (item: unknown) => string }).formatter
    expect(formatter({ dataIndex: 1, percent: 2.78 })).toContain("&lt;b&gt;机构1&lt;/b&gt;")
    expect(formatter({ dataIndex: 1, percent: 2.78 })).toContain("&lt;em&gt;1.000元&lt;/em&gt;")
    expect(formatter({ dataIndex: 1, percent: 2.78 })).not.toContain("<em>")
  })

  it("雷达拒绝负值；散点只接受两个完整指标并保留两个来源的精确显示", () => {
    const negative = {
      ...grouped,
      series: [
        {
          ...grouped.series[0]!,
          points: [{ value: "-1", display: "-1元" }, ...grouped.series[0]!.points.slice(1)],
        },
        grouped.series[1]!,
      ],
    }
    expect(businessChartOption(negative, "radar")).toBeNull()
    expect(businessChartOption(grouped, "scatter")).toBeNull()
    const pairs: BusinessGroupedChart = {
      ...grouped,
      categories: grouped.categories.slice(0, 2),
      source_refs: ["a.r", "a.n", "b.r", "b.n"],
      series: grouped.series.map((series) => ({ ...series, points: series.points.slice(0, 2) })),
    }
    const option = businessChartOption(pairs, "scatter")
    expect(option).toMatchObject({
      xAxis: { name: expect.stringContaining("营业收入") as unknown },
      yAxis: { name: expect.stringContaining("净利润") as unknown },
      series: [{ type: "scatter" }, { type: "scatter" }],
    })
    const formatter = (option?.tooltip as { formatter: (item: unknown) => string }).formatter
    expect(formatter({ seriesIndex: 0, dataIndex: 0 })).toContain("12.340000000001亿元")
    expect(formatter({ seriesIndex: 0, dataIndex: 0 })).toContain("8.230000000002亿元")
  })

  it("面积和柱形切换保留原日期与数值，组成转柱不要求伪造来源", () => {
    expect(businessChartOption(line, "area")).toMatchObject({
      xAxis: { data: line.dates },
      series: [{ type: "line", areaStyle: expect.any(Object) as unknown }],
    })
    expect(businessChartOption(line, "bar")).toMatchObject({
      xAxis: { data: line.dates },
      series: [{ type: "bar" }],
    })
    const option = businessChartOption(pie, "horizontal_bar")
    expect(option).toMatchObject({
      xAxis: { type: "value" },
      yAxis: { type: "category" },
      series: [{ type: "bar" }],
    })
    const formatter = (option?.tooltip as { formatter: (item: unknown) => string }).formatter
    expect(formatter([{ dataIndex: 0 }])).toContain("12.340000000001亿元")
  })

  it("容器宽度决定类别窗口，保留全部数据且没有额外按点数分配大面积留白", () => {
    const input = {
      ...bar,
      source_refs: Array.from({ length: 12 }, (_, index) => `r${index}`),
      points: Array.from({ length: 12 }, (_, index) => ({
        name: `江苏样例${index}农村商业银行总行`,
        value: String(index),
        display: `${index}元`,
      })),
    }
    const narrow = businessChartOption(input, "bar", { width: 420, height: 340 })
    const wide = businessChartOption(input, "bar", { width: 1200, height: 340 })
    const firstWindow = (option: typeof narrow) =>
      (option?.dataZoom as Array<{ endValue: number }>)[0]!.endValue
    expect(firstWindow(wide)).toBeGreaterThan(firstWindow(narrow))
    expect(narrow).toMatchObject({
      dataZoom: [{ filterMode: "none" }, { type: "slider", filterMode: "none" }],
      series: [{ data: expect.any(Array) as unknown, labelLayout: { hideOverlap: true } }],
    })
    expect((narrow?.series as Array<{ data: unknown[] }>)[0]?.data).toHaveLength(12)
  })

  it("雷达与散点提示转义名称并保留display，不改写输入图表", () => {
    const source = structuredClone(grouped)
    source.series[0]!.name = "<img src=x>机构"
    source.categories[0] = "<script>收入</script>"
    source.series[0]!.points[0]!.display = "<b>12.340000000001亿元</b>"
    const before = JSON.stringify(source)
    const option = businessChartOption(source, "radar")
    const formatter = (option?.tooltip as { formatter: (item: unknown) => string }).formatter
    const content = formatter({ dataIndex: 0 })
    expect(content).toContain("&lt;img src=x&gt;机构")
    expect(content).toContain("&lt;script&gt;收入&lt;/script&gt;")
    expect(content).toContain("&lt;b&gt;12.340000000001亿元&lt;/b&gt;")
    expect(content).not.toContain("<img")
    const pairs = {
      ...source,
      categories: source.categories.slice(0, 2),
      source_refs: ["a.r", "a.n", "b.r", "b.n"],
      series: source.series.map((series) => ({ ...series, points: series.points.slice(0, 2) })),
    }
    const scatter = businessChartOption(pairs, "scatter")
    const scatterFormatter = (scatter?.tooltip as { formatter: (item: unknown) => string })
      .formatter
    const pairedContent = scatterFormatter({ seriesIndex: 0, dataIndex: 0 })
    expect(pairedContent).toContain("&lt;script&gt;收入&lt;/script&gt;")
    expect(pairedContent).toContain("&lt;b&gt;12.340000000001亿元&lt;/b&gt;")
    expect(pairedContent).toContain("8.230000000002亿元")
    expect(pairedContent).not.toContain("<img")
    for (const view of reportChartViews(source).filter((item) => !item.disabled))
      businessChartOption(source, view.value)
    expect(JSON.stringify(source)).toBe(before)
  })

  it("真实图表模块可渲染全部适用视图，复用主题且不改变来源", async () => {
    await renderToString(createSSRApp(ChatResultChart as Component, { report: bar }))
    const pairs = {
      ...grouped,
      categories: grouped.categories.slice(0, 2),
      source_refs: ["a.r", "a.n", "b.r", "b.n"],
      series: grouped.series.map((series) => ({ ...series, points: series.points.slice(0, 2) })),
    }
    for (const source of [bar, organization, line, pie, grouped, pairs]) {
      const before = JSON.stringify(source)
      for (const view of reportChartViews(source).filter((item) => !item.disabled)) {
        const option = businessChartOption(source, view.value, { width: 860, height: 340 })
        expect(option?.color).toEqual(expect.arrayContaining(["#244A73", "#2A665F"]))
        expect(option?.backgroundColor).toBe("#FFFFFF")
        const chart = init(null, "light", { renderer: "svg", ssr: true, width: 860, height: 340 })
        try {
          chart.setOption({ ...option, animation: false })
          const svg = chart.renderToSVGString()
          expect(svg).toContain("<path")
          expect(svg).not.toContain("NaN")
        } finally {
          chart.dispose()
        }
      }
      expect(JSON.stringify(source)).toBe(before)
    }
  })
})
