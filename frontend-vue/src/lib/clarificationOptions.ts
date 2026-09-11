import type { ClarificationField, ClarificationOption } from "@/types/api"

/** Older pending tasks may have saved options before display labels were introduced. */
export function clarificationDisplayField(field: ClarificationField): ClarificationField {
  if (field.type !== "metric") return field
  const names = new Map<string, Set<string>>()
  for (const option of field.options) {
    if (typeof option === "string") continue
    const name = option.metric_name ?? option.name
    const code = option.metric_code ?? option.code
    if (!name || !code) continue
    if (!names.has(name)) names.set(name, new Set())
    names.get(name)!.add(code)
  }
  let changed = false
  const addedLabels: string[] = []
  const options = field.options.map(option => {
    if (typeof option === "string" || option.display_label) return option
    const name = option.metric_name ?? option.name
    if (!name || (names.get(name)?.size ?? 0) < 2) return option
    const identity = [option.metric_code ?? option.code, option.unit].filter(Boolean).join(" · ")
    const display_label = `${name}（${identity}）`
    changed = true
    addedLabels.push(display_label)
    return { ...option, display_label }
  })
  if (!changed) return field
  const oldList = field.options.map(option => formatClarificationOption(option)).join("、")
  const newList = options.map(option => formatClarificationOption(option)).join("、")
  const message = field.message.includes(oldList)
    ? field.message.replace(oldList, newList)
    : `${field.message}\n可选项：${[...new Set(addedLabels)].join("、")}。`
  return { ...field, options, message }
}

export const VISIBLE_METRIC_CLARIFICATION_COUNT = 3

/** 指标澄清默认只展示前三项，剩余候选通过“更多”弹窗集中选择。 */
export function getVisibleMetricOptions(options: ClarificationOption[]) {
  return options.slice(0, VISIBLE_METRIC_CLARIFICATION_COUNT)
}

/** 搜索范围与 Next.js 一致：指标名称、指标编号、同义词均可命中。 */
export function filterClarificationOptions(options: ClarificationOption[], query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return options
  return options.filter((option) => getOptionSearchText(option).includes(normalizedQuery))
}

export function formatClarificationOption(option: ClarificationOption, showMetricIdentity = false) {
  if (typeof option === "string") return option
  if (clean(option.display_label)) return option.display_label!.trim()
  const metricName = clean(option.metric_name)
  const synonym = clean(option.synonym)
  const orgName = clean(option.org_name)
  const genericName = clean(option.name)
  const metricCode = clean(option.metric_code) ?? (option.kind === "metric" ? clean(option.code) : null)
  const identity = showMetricIdentity ? [metricCode, clean(option.unit)].filter(Boolean).join(" · ") : ""
  if (metricName && synonym && metricName !== synonym) return `${metricName}（同义词：${synonym}）${identity ? ` · ${identity}` : ""}`
  if (metricName || synonym || metricCode) return `${metricName ?? synonym ?? genericName ?? "未登记指标"}${identity ? ` · ${identity}` : ""}`
  if (orgName || option.org_code) return orgName ?? "未登记机构"
  return genericName ?? "候选项"
}

export function getClarificationOptionValue(option: ClarificationOption) {
  if (typeof option === "string") return option
  return clean(option.metric_code) ?? clean(option.org_code) ?? clean(option.code) ?? formatClarificationOption(option)
}

export function getClarificationOptionKey(option: ClarificationOption, index: number) {
  return `${getClarificationOptionValue(option)}-${typeof option === "string" ? option : option.synonym ?? ""}-${index}`
}

function getOptionSearchText(option: ClarificationOption) {
  if (typeof option === "string") return option.toLowerCase()
  return [option.metric_code, option.metric_name, option.synonym, option.org_code, option.org_name, option.code, option.name]
    .map(clean)
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function clean(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
