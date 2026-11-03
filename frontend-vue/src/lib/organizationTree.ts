import type { OrgItem } from "@/types/api"

export type OrganizationTreeRow = {
  org: OrgItem
  depth: number
  hasChildren: boolean
  expanded: boolean
  isContext: boolean
  issue?: string
}

type TreeOptions = {
  keyword?: string
  showDisabled?: boolean
  expanded?: ReadonlyMap<string, boolean>
}

export function organizationTreeRows(
  items: OrgItem[],
  options: TreeOptions = {},
): {
  rows: OrganizationTreeRow[]
  matchedCount: number
} {
  const byCode = new Map(items.map((org) => [org.org_code, org]))
  const parents = new Map<string, string>()
  const issues = new Map<string, string>()
  for (const org of items) {
    const parent = org.parent_org_code?.trim()
    if (parent && byCode.has(parent)) parents.set(org.org_code, parent)
    else if (parent) issues.set(org.org_code, "上级未收录")
    else if (!org.hierarchy_level) issues.set(org.org_code, "未关联层级")
  }

  // 异常父链只影响展示，不修写源关系；环中机构平铺保留，避免隐藏记录或无限遍历。
  const checked = new Set<string>()
  for (const org of items) {
    const path: string[] = []
    const positions = new Map<string, number>()
    let current: string | undefined = org.org_code
    while (current && !checked.has(current)) {
      const cycleStart = positions.get(current)
      if (cycleStart !== undefined) {
        for (const code of path.slice(cycleStart)) {
          parents.delete(code)
          issues.set(code, "层级关系异常")
        }
        break
      }
      positions.set(current, path.length)
      path.push(current)
      current = parents.get(current)
    }
    path.forEach((code) => checked.add(code))
  }

  const keyword = options.keyword?.trim().toLowerCase() ?? ""
  const matches = new Set(
    items
      .filter(
        (org) =>
          (options.showDisabled || org.enabled) &&
          (!keyword ||
            [org.org_code, org.org_name, ...org.aliases].join(" ").toLowerCase().includes(keyword)),
      )
      .map((org) => org.org_code),
  )
  const retained = new Set(matches)
  for (const code of matches) {
    let parent = parents.get(code)
    while (parent) {
      retained.add(parent)
      parent = parents.get(parent)
    }
  }

  const roots: OrgItem[] = []
  const children = new Map<string, OrgItem[]>()
  for (const org of items) {
    if (!retained.has(org.org_code)) continue
    const parent = parents.get(org.org_code)
    if (!parent) roots.push(org)
    else {
      const siblings = children.get(parent) ?? []
      siblings.push(org)
      children.set(parent, siblings)
    }
  }

  const rows: OrganizationTreeRow[] = []
  const pending = roots.map((org) => ({ org, depth: 0 })).reverse()
  while (pending.length) {
    const next = pending.pop()
    if (!next) break
    const { org, depth } = next
    const descendants = children.get(org.org_code) ?? []
    // 搜索保留并展开祖先路径，不覆盖用户原来的展开选择。
    const expanded = Boolean(keyword) || (options.expanded?.get(org.org_code) ?? depth === 0)
    rows.push({
      org,
      depth,
      hasChildren: descendants.length > 0,
      expanded,
      isContext: !matches.has(org.org_code),
      issue: issues.get(org.org_code),
    })
    if (expanded) pending.push(...descendants.map((org) => ({ org, depth: depth + 1 })).reverse())
  }
  return { rows, matchedCount: matches.size }
}
