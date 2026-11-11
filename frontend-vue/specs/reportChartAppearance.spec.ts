import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import { init, use } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import ChatResultChart from "../src/components/chat/ChatResultChart.vue"
import { businessChartOption, businessReportDimensions } from "../src/lib/businessReportChart"
import type { BusinessGroupedChart, BusinessSeriesChart } from "../src/types/api"

use(SVGRenderer)

// 数值为隔离契约样例；机构名取已有报告的正式展示名称。
const organizations = ["江苏江南农村商业银行总行", "江苏紫金农村商业银行"]
const comparison: BusinessSeriesChart = {
  type: "bar",
  category_kind: "organization",
  title: "规模对比",
  dates: ["2026-08-27"],
  unit: "元",
  source_refs: ["a", "b"],
  points: organizations.map((name, index) => ({
    name,
    value: String((index + 1) * 100000000),
    display: `${index + 1}.000亿元`,
  })),
}
const grouped: BusinessGroupedChart = {
  type: "grouped_bar",
  title: "经营对比",
  dates: comparison.dates,
  unit: "元",
  source_refs: ["a.x", "a.y", "a.z", "b.x", "b.y", "b.z"],
  categories: ["甲指标", "乙指标", "丙指标"],
  series: organizations.map((name, index) => ({
    name,
    points: [0, 1, 2].map((offset) => ({
      value: String((index + offset + 1) * 100000000),
      display: `${index + offset + 1}.000亿元`,
    })),
  })),
}

type Series = {
  name?: string
  itemStyle?: { color?: string | ((item: { dataIndex: number }) => string) }
  data?: Array<{ name?: string; itemStyle?: { color?: string } }>
}
function seriesOf(option: ReturnType<typeof businessChartOption>): Series[] {
  return option?.series as Series[]
}
function barColor(
  source: BusinessSeriesChart,
  index: number,
  view: "bar" | "horizontal_bar" | "line" | "area" = "bar",
) {
  const color = seriesOf(businessChartOption(source, view))[0]?.itemStyle?.color
  return typeof color === "function" ? color({ dataIndex: index }) : color
}

describe("报告图表机构配色与紧凑高度", () => {
  it("机构名决定颜色，反转顺序或改变指标值不改变颜色及原数据", () => {
    const before = JSON.stringify(comparison)
    const colors = organizations.map((_, index) => barColor(comparison, index))
    expect(colors).toEqual(["#244A73", "#2A665F"])
    expect(
      colors.every((color) => typeof color === "string" && /^#[a-f0-9]{6}$/i.test(color)),
    ).toBe(true)
    expect(colors[0]).not.toBe(colors[1])
    const reversed = {
      ...comparison,
      source_refs: [...comparison.source_refs].reverse(),
      points: [...comparison.points]
        .reverse()
        .map((point) => ({ ...point, value: "999", display: "999.000元" })),
    }
    expect(barColor(reversed, 1)).toBe(colors[0])
    expect(barColor(reversed, 0, "horizontal_bar")).toBe(colors[1])
    expect(JSON.stringify(comparison)).toBe(before)
  })

  it("手动切换连线和机构占比图仍保持机构颜色", () => {
    const colors = ["#244A73", "#2A665F"]
    for (const view of ["line", "area"] as const)
      expect(organizations.map((_, index) => barColor(comparison, index, view))).toEqual(colors)
    for (const view of ["pie", "donut"] as const) {
      const option = businessChartOption(comparison, view)
      expect(seriesOf(option)[0]?.data?.map((point) => point.itemStyle?.color)).toEqual(colors)
    }
  })

  it("分组、雷达与散点沿用同机构颜色，系列重排后仍可对照", () => {
    const colors = organizations.map((_, index) => barColor(comparison, index))
    expect(colors.every((color) => typeof color === "string")).toBe(true)
    for (const source of [grouped, { ...grouped, series: [...grouped.series].reverse() }]) {
      const radar = seriesOf(businessChartOption(source, "radar"))[0]?.data ?? []
      const pairs = {
        ...source,
        categories: source.categories.slice(0, 2),
        source_refs: ["a.x", "a.y", "b.x", "b.y"],
        series: source.series.map((series) => ({ ...series, points: series.points.slice(0, 2) })),
      }
      const scatter = seriesOf(businessChartOption(pairs, "scatter"))
      for (const [index, name] of organizations.entries()) {
        for (const view of ["bar", "horizontal_bar", "line", "area"] as const) {
          const bars = seriesOf(businessChartOption(source, view))
          expect(bars.find((series) => series.name === name)?.itemStyle?.color).toBe(colors[index])
        }
        expect(radar.find((series) => series.name === name)?.itemStyle?.color).toBe(colors[index])
        expect(scatter.find((series) => series.name === name)?.itemStyle?.color).toBe(colors[index])
      }
    }
  })

  it("白底灰轴与浅网格统一，数值与类目标签留有间距", () => {
    expect(businessChartOption(comparison, "horizontal_bar")).toMatchObject({
      backgroundColor: "#FFFFFF",
      xAxis: {
        axisLabel: { color: "#64748B", margin: 12 },
        splitLine: { lineStyle: { color: "#E2E8F0" } },
      },
      yAxis: { axisLabel: { color: "#64748B", margin: 12 } },
      series: [{ label: { distance: 10, lineHeight: 18 } }],
    })
  })

  it("指标分类和真实日期不误用机构逐点配色", () => {
    const metric = { ...comparison, category_kind: "metric" as const }
    expect(seriesOf(businessChartOption(metric, "bar"))[0]?.itemStyle?.color).toBeUndefined()
    const trend: BusinessSeriesChart = {
      ...comparison,
      type: "line",
      category_kind: "time",
      dates: ["2026-07-31", "2026-08-27"],
      points: comparison.points.map((point, index) => ({
        ...point,
        name: ["2026-07-31", "2026-08-27"][index]!,
      })),
    }
    expect(seriesOf(businessChartOption(trend, "bar"))[0]?.itemStyle?.color).toBeUndefined()
  })

  it("两三点柱图使用280px，密集柱图与复杂分组保持340px", () => {
    expect(businessReportDimensions(comparison).height).toBe(280)
    const third = { name: "第三机构", value: "3", display: "3元" }
    expect(
      businessReportDimensions({
        ...comparison,
        source_refs: ["a", "b", "c"],
        points: [...comparison.points, third],
      }).height,
    ).toBe(280)
    const dense = {
      ...comparison,
      source_refs: ["a", "b", "c", "d"],
      points: [...comparison.points, third, { ...third, name: "第四机构" }],
    }
    expect(businessReportDimensions(dense).height).toBe(340)
    expect(businessReportDimensions(grouped).height).toBe(340)
  })

  it("280px真实组件与SVG保留长中文机构全名和精确数值", async () => {
    const source = {
      ...comparison,
      points: comparison.points.map((point) => ({
        ...point,
        name: `${point.name}股份有限公司营业部`,
      })),
    }
    const html = await renderToString(
      createSSRApp(ChatResultChart as Component, { report: source }),
    )
    expect(html).toContain("height:280px")
    const option = businessChartOption(source, "bar", { width: 420, height: 280 })
    const label = (option?.xAxis as { axisLabel: { formatter: (name: string) => string } })
      .axisLabel.formatter
    const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 420, height: 280 })
    try {
      chart.setOption({ ...option, animation: false })
      const svg = chart.renderToSVGString()
      for (const point of source.points) {
        const wrapped = label(point.name)
        expect(wrapped).toContain("\n")
        expect(wrapped.replace(/\n/g, "")).toBe(point.name)
        for (const line of wrapped.split("\n")) expect(svg).toContain(line)
        expect(svg).toContain(point.display)
      }
    } finally {
      chart.dispose()
    }
  })
})
