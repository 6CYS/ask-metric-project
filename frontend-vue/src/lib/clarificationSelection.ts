import type { ClarificationField, ClarificationOption, SemanticPatch } from "@/types/api"

/** 只保存当前编辑的字段，其他待补条件交给原任务继续澄清。 */
export function buildClarificationSelection(field: ClarificationField, selected: ClarificationOption[]): SemanticPatch | null {
  const minimum = field.min_selections ?? 1
  if (selected.length < minimum || (field.max_selections != null && selected.length > field.max_selections)) return null
  const options = [...(field.preserved_options ?? []), ...selected]
  const set: Record<string, unknown> = {}
  if (field.type === "metric") {
    const metrics = new Map<string, { code: string; name: string }>()
    for (const option of options) {
      if (typeof option === "string") return null
      const code = option.metric_code ?? option.code
      const name = option.metric_name ?? option.name
      if (!code || !name) return null
      metrics.set(code, { code, name })
    }
    set.metrics = [...metrics.values()]
  } else if (field.type === "organization") {
    const names = options.map((option) => typeof option === "string" ? option : option.org_name ?? option.name)
    if (names.some((name) => !name)) return null
    set.orgs = [...new Set(names)]
  } else if (field.type === "result") {
    const option = selected[0]
    const code = typeof option === "string" ? option : option?.code
    if (!code) return null
    set.result_id = code
  } else {
    return null
  }
  return { set, add_ops: [], remove_ops: [] }
}

export function mergeClarificationSelections(patches: SemanticPatch[], dateText?: string): SemanticPatch {
  const set: Record<string, unknown> = {}
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch.set)) {
      if (key === "metrics") {
        const metrics = [...(set.metrics as Array<{ code: string; name: string }> ?? []), ...value as Array<{ code: string; name: string }>]
        set.metrics = [...new Map(metrics.map((metric) => [metric.code, metric])).values()]
      } else if (key === "orgs") {
        set.orgs = [...new Set([...(set.orgs as string[] ?? []), ...value as string[]])]
      } else set[key] = value
    }
  }
  // 日期表达交给后端现有日期校验，不在前端猜测或换算日期。
  if (dateText?.trim()) set.time = dateText.trim()
  return { set, add_ops: [], remove_ops: [] }
}
