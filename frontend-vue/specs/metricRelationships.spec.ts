import { describe, expect, it } from "vitest"

import { metricNeighborhood, relationPayload } from "../src/lib/metricRelationships"
import type { MetricRelation } from "../src/types/metricRelationships"

const relation = (fields: Partial<MetricRelation> = {}): MetricRelation => ({
  id: "r1",
  kind: "classification",
  parent: "TOTAL",
  children: ["PERSONAL", "CORP"],
  status: "approved",
  source: "客户分类",
  origin: "managed",
  editable: true,
  ...fields,
})

describe("指标关系图", () => {
  it("区分所属分类和下级分类，合并相同节点但保留全部关系", () => {
    const result = metricNeighborhood("PERSONAL", [
      relation(),
      relation({ id: "r2", parent: "PERSONAL", children: ["CURRENT"] }),
      relation({ id: "r3", parent: "PERSONAL", children: ["CURRENT"] }),
    ])
    expect(result.parents).toEqual([{ code: "TOTAL", labels: ["所属分类"] }])
    expect(result.children).toEqual([{ code: "CURRENT", labels: ["下级分类"] }])
    expect(result.relations.map((item) => item.id)).toEqual(["r1", "r2", "r3"])
  })

  it("占比关系只显示明确分子分母，不当成组成", () => {
    const result = metricNeighborhood("SHARE", [
      relation({ kind: "ratio", parent: "SHARE", children: ["PERSONAL", "TOTAL"] }),
    ])
    expect(result.children).toEqual([
      { code: "PERSONAL", labels: ["分子"] },
      { code: "TOTAL", labels: ["分母"] },
    ])
  })

  it.each([
    { selected: "PERSONAL", role: "分子" },
    { selected: "TOTAL", role: "分母" },
  ])("反向查看占比时明确当前指标作为$role", ({ selected, role }) => {
    const result = metricNeighborhood(selected, [
      relation({ kind: "ratio", parent: "SHARE", children: ["PERSONAL", "TOTAL"] }),
    ])
    expect(result.parents).toEqual([{ code: "SHARE", labels: [`当前指标作${role}`] }])
    expect(result.children).toEqual([])
  })

  it("组成关系区分所属总量和组成分项，混合关系保留每一种角色", () => {
    const result = metricNeighborhood("PERSONAL", [
      relation({ kind: "composition" }),
      relation({ id: "r2", kind: "composition", parent: "PERSONAL", children: ["CURRENT"] }),
      relation({ id: "r3", parent: "PERSONAL", children: ["CURRENT"] }),
    ])
    expect(result.parents).toEqual([{ code: "TOTAL", labels: ["所属总量"] }])
    expect(result.children).toEqual([{ code: "CURRENT", labels: ["组成分项", "下级分类"] }])
  })

  it("隐藏停用关系，但保留未启用关系供维护", () => {
    const result = metricNeighborhood("TOTAL", [
      relation({ status: "draft" }),
      relation({ id: "retired", status: "retired", children: ["HIDDEN"] }),
    ])
    expect(result.children.map((item) => item.code)).toEqual(["PERSONAL", "CORP"])
    expect(
      metricNeighborhood("TOTAL", [relation({ status: "retired" })], true).relations,
    ).toHaveLength(1)
  })
})

describe("关系表单", () => {
  it("关闭已启用关系时保留停用状态，新关系仍保持未启用", () => {
    const form = {
      kind: "classification" as const,
      parent: ["TOTAL"],
      children: ["PART"],
      numerator: [],
      denominator: [],
      source: "分类依据",
      enabled: false,
    }
    expect(relationPayload(form, "v1", "approved").status).toBe("retired")
    expect(relationPayload(form, "v1", "retired").status).toBe("retired")
    expect(relationPayload(form, "v1").status).toBe("draft")
  })

  it("按分子分母顺序提交，不自动排序或去重改变公式", () => {
    expect(
      relationPayload(
        {
          kind: "ratio",
          parent: ["SHARE"],
          children: [],
          numerator: ["PART"],
          denominator: ["TOTAL"],
          source: " 定义依据 ",
          enabled: true,
        },
        "v1",
      ),
    ).toEqual({
      kind: "ratio",
      parent: "SHARE",
      children: ["PART", "TOTAL"],
      status: "approved",
      source: "定义依据",
      revision: "v1",
    })
  })

  it("未选齐公式依赖不能保存", () => {
    expect(() =>
      relationPayload(
        {
          kind: "ratio",
          parent: ["SHARE"],
          children: [],
          numerator: ["PART"],
          denominator: [],
          source: "依据",
          enabled: true,
        },
        "v1",
      ),
    ).toThrow()
  })
})
