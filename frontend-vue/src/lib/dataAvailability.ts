export interface AvailabilityInput {
  dimension?: "dates" | "metrics"
  metric_codes?: string[]
  org_codes?: string[]
  match?: "any" | "all"
  start?: string | null
  end?: string | null
  page?: number
  page_size?: number
}
export interface AvailabilityGroup {
  scope: "any" | "common" | "pair"
  org_name?: string | null
  metric_name?: string | null
  date_count: number
  earliest: string | null
  latest: string | null
  dates: string[]
  has_more: boolean
}
export interface AvailabilityDetails {
  kind?: "data_availability"
  status: "succeeded"
  request: AvailabilityInput
  mode: "overview" | "combinations" | "common" | "metrics"
  items?: { metric_code: string; metric_name: string }[]
  metric_count: number
  org_count: number
  org_names?: string[]
  metric_names?: string[]
  page: number
  page_size: number
  groups: AvailabilityGroup[]
  notice: string
}
export function availabilityReply(data: AvailabilityDetails): string {
  const common = data.request.match === "all" || data.mode === "common"
  const group = data.groups.find(item => item.scope === (common ? "common" : "any"))
  const names = data.groups.filter(item => item.scope === "pair")
  const orgs = data.org_names ?? [...new Set(names.map(item => item.org_name).filter(Boolean))]
  const scope = (orgs.length ? orgs.join("、") : `当前 ${data.org_count} 家授权机构的查询范围`)
    + (data.metric_names?.length ? `的${data.metric_names.join('、')}` : "")
  const period = data.request.start || data.request.end
    ? `（${data.request.start ?? '不限起始日期'}至${data.request.end ?? '不限结束日期'}）` : ""
  if (data.mode === "metrics") {
    if (!data.metric_count) return `${scope}${period}内未查到有数据记录的正式指标。`
    const items = data.items ?? []
    return `${scope}${period}内，共有 ${data.metric_count} 个正式指标有数据记录。`
      + (items.length ? `\n${data.metric_count > items.length ? '本页展示部分指标' : '指标包括'}：${items.map(item => item.metric_name).join('、')}。` : "\n本页没有更多指标，请指定其他页码查询。")
      + (data.metric_count > items.length ? "可指定页码继续查看。" : "")
      + "\n有记录不代表所选范围内每个机构、每天都有有效数值，具体数值需进一步查询。"
  }
  if (!group?.date_count) return `${scope}${period}内${common ? '没有所有所选机构和指标均有记录的共同业务日期' : '未查到有数据记录的业务日期'}。`
  const label = common ? "所有所选机构和指标均有记录的共同业务日期" : "有数据记录的业务日期"
  const dates = group.dates.join("、")
  const partial = group.date_count > group.dates.length
  return `${scope}${period}内，共有 ${group.date_count} 个${label}，最早为 ${group.earliest}，最新为 ${group.latest}。`
    + (dates ? `\n${partial ? (data.page > 1 ? '本页列出' : '最近') : '可用日期为'} ${group.dates.length} 个日期：${dates}。` : "\n本页没有更多日期，请指定其他页码查询。")
    + (partial ? "以上仅展示部分日期，可指定时间范围或页码继续查询。" : "")
    + (common ? "\n有记录不代表每条指标值均有效，实际数值需查询确认。" : "\n日期不一定连续；有记录不代表每个机构、指标均有有效数值，具体情况需查询确认。")
}
