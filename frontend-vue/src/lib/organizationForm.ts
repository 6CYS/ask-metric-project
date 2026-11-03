import type { OrgItem, OrgPayload } from "@/types/api"
import { organizationTreeRows, type OrganizationTreeRow } from "./organizationTree"

export function organizationParentOptions(
  items: OrgItem[],
  editingCode?: string,
  currentParent?: string,
): OrganizationTreeRow[] {
  const excluded = new Set(editingCode ? [editingCode] : [])
  const children = new Map<string, string[]>()
  for (const org of items) {
    if (!org.parent_org_code) continue
    const siblings = children.get(org.parent_org_code) ?? []
    siblings.push(org.org_code)
    children.set(org.parent_org_code, siblings)
  }
  for (const code of excluded) {
    for (const child of children.get(code) ?? []) excluded.add(child)
  }
  return organizationTreeRows(items, {
    showDisabled: true,
    expanded: new Map(items.map((org) => [org.org_code, true])),
  }).rows.filter(
    (row) =>
      !excluded.has(row.org.org_code) && (row.org.enabled || row.org.org_code === currentParent),
  )
}

export function organizationConflicts(
  items: OrgItem[],
  payload: OrgPayload,
  editingCode?: string,
): {
  duplicateCode: OrgItem | undefined
  nameConflicts: OrgItem[]
  aliasConflicts: { org: OrgItem; terms: string[] }[]
} {
  const others = items.filter((org) => org.org_code !== editingCode)
  const normalize = (value: string) => value.trim().toLowerCase()
  const name = normalize(payload.org_name)
  const aliases = [...new Set(payload.aliases.map((value) => value.trim()).filter(Boolean))]
  const enabled = others.filter((org) => org.enabled)
  return {
    duplicateCode: others.find((org) => normalize(org.org_code) === normalize(payload.org_code)),
    nameConflicts: name ? enabled.filter((org) => normalize(org.org_name) === name) : [],
    aliasConflicts: enabled.flatMap((org) => {
      const existingAliases = new Set(org.aliases.map(normalize))
      const existingTerms = new Set([normalize(org.org_name), ...existingAliases])
      const terms = aliases.filter((alias) => existingTerms.has(normalize(alias)))
      if (name && existingAliases.has(name)) terms.push(payload.org_name.trim())
      return terms.length ? [{ org, terms: [...new Set(terms)] }] : []
    }),
  }
}
