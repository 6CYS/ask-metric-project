import type {
  MetricRelation,
  MetricRelationKind,
  MetricRelationWrite,
} from "@/types/metricRelationships"

export const relationLabels: Record<MetricRelationKind, string> = {
  classification: "分类",
  composition: "组成",
  ratio: "占比依赖",
}

export interface RelationForm {
  kind: MetricRelationKind
  parent: string[]
  children: string[]
  numerator: string[]
  denominator: string[]
  source: string
  enabled: boolean
}

export function relationPayload(
  form: RelationForm,
  revision: string,
  currentStatus: MetricRelation["status"] = "draft",
): MetricRelationWrite {
  const parent = form.parent[0]
  if (!parent) throw new Error("请选择主指标。")
  const children = form.kind === "ratio" ? [form.numerator[0], form.denominator[0]] : form.children
  if (!children.length || children.some((code) => !code)) throw new Error("请选择完整的关联指标。")
  if (!form.source.trim()) throw new Error("请填写关系说明。")
  if (form.source.length > 2000) throw new Error("关系说明不能超过 2000 字。")
  if (children.includes(parent) || new Set(children).size !== children.length)
    throw new Error("主指标与关联指标不能重复。")
  if (!revision) throw new Error("请先刷新关系。")
  return {
    kind: form.kind,
    parent,
    children: children.filter((code): code is string => Boolean(code)),
    source: form.source.trim(),
    status: form.enabled ? "approved" : currentStatus === "draft" ? "draft" : "retired",
    revision,
  }
}

interface Neighbor {
  code: string
  labels: string[]
}

export function metricNeighborhood(code: string, items: MetricRelation[], showRetired = false) {
  const relations = items.filter(
    (item) =>
      (showRetired || item.status !== "retired") &&
      (item.parent === code || item.children.includes(code)),
  )
  const parents = new Map<string, Neighbor>()
  const children = new Map<string, Neighbor>()
  function add(target: Map<string, Neighbor>, key: string, label: string) {
    const item = target.get(key) ?? { code: key, labels: [] }
    if (!item.labels.includes(label)) item.labels.push(label)
    target.set(key, item)
  }
  for (const relation of relations) {
    if (relation.parent === code) {
      relation.children.forEach((child, index) =>
        add(
          children,
          child,
          relation.kind === "ratio"
            ? index === 0
              ? "分子"
              : "分母"
            : relation.kind === "composition"
              ? "组成分项"
              : "下级分类",
        ),
      )
    } else {
      add(
        parents,
        relation.parent,
        relation.kind === "ratio"
          ? relation.children[0] === code
            ? "当前指标作分子"
            : "当前指标作分母"
          : relation.kind === "composition"
            ? "所属总量"
            : "所属分类",
      )
    }
  }
  return { relations, parents: [...parents.values()], children: [...children.values()] }
}
