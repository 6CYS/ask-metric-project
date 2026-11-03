import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"

import MetricRelationshipGraph from "../src/components/metrics/MetricRelationshipGraph.vue"
import type { MetricItem } from "../src/types/api"
import type { MetricRelation } from "../src/types/metricRelationships"

// ESLint 的 TypeScript 解析器不生成 SFC 类型；组件实现另由 vue-tsc 检查。
const graph = MetricRelationshipGraph as Component

function metric(code: string): MetricItem {
  return {
    metric_code: code,
    metric_name: `指标${code}`,
    unit: "元",
    metric_explanation: "",
    description: "",
    synonyms: [],
    enabled: true,
  }
}

function relation(
  parent: string,
  children: string[],
  kind: MetricRelation["kind"] = "classification",
): MetricRelation {
  return {
    id: `${parent}-${children.join("-")}`,
    parent,
    children,
    kind,
    status: "approved",
    source: "测试关系",
    origin: "managed",
    editable: true,
  }
}

describe("当前指标的一层关系图谱", () => {
  it("大扇出只渲染一组相邻节点，并提供翻组入口", async () => {
    const children = Array.from({ length: 120 }, (_, index) => `CHILD_${index}`)
    const html = await renderToString(
      createSSRApp(graph, {
        selected: "ROOT",
        metrics: [metric("ROOT"), ...children.map(metric)],
        relations: children.map((code) => relation("ROOT", [code])),
        showRetired: false,
      }),
    )
    expect(html).toContain("指标ROOT")
    expect(html).toContain("指标CHILD_0")
    expect(html).not.toContain("指标CHILD_119")
    expect((html.match(/data-metric-node=/g) ?? []).length).toBeLessThanOrEqual(9)
    expect(html).toContain("下一组下级分类")
    expect(html).toContain("120")
  })

  it("只展示直接关系，比例依赖保留分子分母而不展开孙级", async () => {
    const html = await renderToString(
      createSSRApp(graph, {
        selected: "SHARE",
        metrics: ["SHARE", "PART", "TOTAL", "GRANDCHILD"].map(metric),
        relations: [
          relation("SHARE", ["PART", "TOTAL"], "ratio"),
          relation("PART", ["GRANDCHILD"]),
        ],
        showRetired: false,
      }),
    )
    expect(html).toContain("指标PART")
    expect(html).toContain("指标TOTAL")
    expect(html).toContain("分子")
    expect(html).toContain("分母")
    expect(html).toContain("分子与分母")
    expect(html).not.toContain("上级")
    expect(html).not.toContain("下级")
    expect(html).not.toContain("指标GRANDCHILD")
  })

  it.each([
    { kind: "classification" as const, before: "所属分类", after: "下级分类" },
    { kind: "composition" as const, before: "所属总量", after: "组成分项" },
    { kind: "ratio" as const, before: "参与的占比", after: "分子与分母" },
  ])("$kind 关系用实际业务含义命名两侧", async ({ kind, before, after }) => {
    const html = await renderToString(
      createSSRApp(graph, {
        selected: "ROOT",
        metrics: ["GROUP", "OTHER", "ROOT", "PART", "TOTAL"].map(metric),
        relations: [
          relation("GROUP", ["ROOT", "OTHER"], kind),
          relation("ROOT", ["PART", "TOTAL"], kind),
        ],
        showRetired: false,
      }),
    )
    expect(html).toContain(`aria-label="${before}"`)
    expect(html).toContain(`aria-label="${after}"`)
  })

  it("混合类型仍使用一个图，保留节点的分类和计算角色", async () => {
    const html = await renderToString(
      createSSRApp(graph, {
        selected: "ROOT",
        metrics: ["GROUP", "OTHER", "ROOT", "PART", "TOTAL"].map(metric),
        relations: [
          relation("GROUP", ["OTHER", "ROOT"], "ratio"),
          relation("ROOT", ["PART"], "classification"),
          relation("ROOT", ["PART", "TOTAL"], "ratio"),
        ],
        showRetired: false,
      }),
    )
    expect((html.match(/aria-label="指标关系图谱"/g) ?? []).length).toBe(1)
    expect((html.match(/data-metric-node="PART"/g) ?? []).length).toBe(1)
    expect(html).toContain("当前指标作分母")
    expect(html).toContain("下级分类 · 分子")
    expect(html).toContain('aria-label="下级分类 · 分子与分母"')
    expect(html).not.toContain("下级及公式依赖")
  })
})
